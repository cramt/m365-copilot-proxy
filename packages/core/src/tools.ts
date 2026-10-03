import { createLogger } from "./log.js";
import {
  buildSpecMap,
  currentFramingVariant,
  deriveFencedSpec,
  findFirstToolFence,
  formatFencedToolDefinitions,
  parseFencedToolCalls,
  renderFencedCall,
  transcriptStyleForVariant,
} from "./fenced.js";

const log = createLogger("tools");

// Tool calls use the **fenced** Markdown format exclusively (see fenced.ts and
// docs/hypotheses.md §9). The old `{"tool":...,"arguments":{}}` JSON format was
// removed — it produced 0/5 on real agentic tasks; fenced + shell-routing produces
// genuine multi-turn loops. We still *parse* a stray JSON tool call as a tolerance
// fallback (M365 occasionally emits one), but we never instruct the model to use it.

// --- Types (standalone, no zod dependency) ---

export interface ToolFunction {
  name: string;
  description?: string;
  parameters?: {
    properties?: Record<string, { type?: string; [k: string]: unknown }>;
    required?: string[];
    [k: string]: unknown;
  };
}

export interface ToolDef {
  type?: string;
  function: ToolFunction;
}

export interface Message {
  role: string;
  content?: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }
  | undefined;

// --- Tool call format ---

// Fenced Markdown is the format we instruct and primarily parse (see fenced.ts).
// The two regexes below are tolerance-only FALLBACKS: M365 occasionally ignores the
// fenced contract and emits a stray `{"tool":...,"arguments":{...}}` object, or wraps
// it in a legacy ```tool_call fence. We parse those if they show up but never teach
// the model to produce them — the JSON format scored 0/5 and was removed (§9).
const TOOL_CALL_REGEX = /\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;
const FENCED_TOOL_CALL_REGEX = /```tool_call\s*\n(\{[\s\S]*?\})\s*\n\s*```/g;

// M365 invents bookkeeping objects ({"confidence": 0.5}) and wraps its answer in
// {"final": "..."} — neither is a real tool call. Strip confidence everywhere;
// drop final when it rides alongside tool calls (it's usually a premature
// success claim), and unwrap it when it stands alone as the response.
const CONFIDENCE_REGEX = /\{\s*"confidence"\s*:\s*-?[0-9.]+\s*\}/g;
const FINAL_OBJECT_REGEX = /\{\s*"final"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g;

/** Strip invented confidence/final objects from a no-tool-call response and
 *  unwrap a lone {"final": "..."} answer into bare text. Returns null if empty. */
function cleanLooseText(text: string): string | null {
  let out = text;
  for (const m of out.match(FINAL_OBJECT_REGEX) ?? []) {
    try {
      const value = JSON.parse(m).final;
      if (typeof value === "string") out = out.replace(m, value);
    } catch {
      // leave the literal text in place if it isn't valid JSON
    }
  }
  out = out.replace(CONFIDENCE_REGEX, "").trim();
  return out.length ? out : null;
}

// --- Formatting ---

export function formatToolDefinitions(tools: ToolDef[], variantOverride?: string): string {
  return formatFencedToolDefinitions(tools, variantOverride);
}

export function formatToolChoiceInstruction(toolChoice: ToolChoice): string {
  if (!toolChoice || toolChoice === "auto") return "";
  if (toolChoice === "none") return "\nDo NOT call tools. Text only.";
  if (toolChoice === "required") return "\nYou MUST call at least one tool.";
  if (typeof toolChoice === "object" && toolChoice.function) {
    return `\nYou MUST call "${toolChoice.function.name}".`;
  }
  return "";
}

export function getMessageContent(msg: Message): string {
  if (msg.content === null || msg.content === undefined) return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content.map((p) => p.text || "").join("");
}

/** A short one-line description of what a tool call did, for labelling its result
 *  (e.g. the shell command, or the file path). Newlines collapsed, truncated. */
function toolCallSummary(rawArgs: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
  } catch {
    return "";
  }
  const primary =
    args.command ?? args.cmd ?? args.script ?? args.path ?? args.file ??
    args.filename ?? args.query ?? Object.values(args).find((v) => typeof v === "string");
  if (typeof primary !== "string") return "";
  return primary.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, 100);
}

/** One tool result as the model is meant to read it: named for the call that
 *  produced it, with that call's command. Without this the result is labelled
 *  "unknown" and the model misreads it — observed: it ran `ls`, saw `README.md`,
 *  and concluded the *file* was empty (docs §9 F15-adjacent). Shared by the
 *  first turn (formatMessages) and every follow-up turn (the handler's delta
 *  path), which kept the old `name="unknown"` label — and a pi session is
 *  delta turns from turn 2 on, so nearly every result went out unattributed. */
export function formatToolResponse(m: Message, history: Message[]): string {
  let meta: { name: string; summary: string } | undefined;
  if (m.tool_call_id) {
    for (const a of history) {
      const tc = a.role === "assistant" ? a.tool_calls?.find((c) => c.id === m.tool_call_id) : undefined;
      if (tc) {
        meta = { name: tc.function.name, summary: toolCallSummary(tc.function.arguments) };
        break;
      }
    }
  }
  const name = m.name || meta?.name || "tool";
  // Show the command/args that produced this output so the model reads it in
  // context (a directory listing vs file contents vs a command's stdout).
  const cmdAttr = meta?.summary ? ` command="${meta.summary}"` : "";
  return `<tool_response tool="${name}"${cmdAttr}>\n${getMessageContent(m)}\n</tool_response>`;
}

/**
 * Inject a synthetic `reply(text)` tool that the model calls instead of
 * answering in prose. Wired by the handler (which converts `reply` back to a
 * plain assistant message), so it's invisible to the client. Off by default —
 * set `M365_INJECT_REPLY_TOOL=1` to enable.
 *
 * Why this matters: M365 mostly disobeys "only emit JSON" when the right
 * answer is text. Routing text through a `reply()` call makes EVERY turn a
 * tool call, which is a much cleaner contract for the model to follow.
 *
 * Tradeoff: adds 1 tool to the prompt, which nudges the Disengaged-filter
 * threshold a tiny bit. Safe with lean toolsets (<= ~10 tools).
 */
function maybeInjectReplyTool(tools: ToolDef[]): ToolDef[] {
  const enabled = process.env.M365_INJECT_REPLY_TOOL || currentFramingVariant() === "reply_tool";
  if (!enabled) return tools;
  if (tools.some((t) => t.function.name === "reply")) return tools;
  const replyTool: ToolDef = {
    type: "function",
    function: {
      name: "reply",
      description:
        "Send a plain-text answer to the user. Use this whenever you would otherwise reply in prose.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "The text to send" } },
        required: ["text"],
      },
    },
  };
  return [replyTool, ...tools];
}

export function formatMessages(
  messages: Message[],
  tools?: ToolDef[],
  toolChoice?: ToolChoice,
  conversationId?: string,
  framingVariant?: string,
): string {
  const parts: string[] = [];

  if (conversationId) {
    parts.push(`<conversation_id>${conversationId}</conversation_id>`);
  }

  const effectiveTools = tools ? maybeInjectReplyTool(tools) : tools;
  const specMap = effectiveTools ? buildSpecMap(effectiveTools) : null;
  // The wrapper tags follow the framing variant: most keep the historical
  // `<system>` tags, but Claude Sonnet reads a `<system>` block inside a user
  // turn as a forged system prompt, so some variants label text by its real
  // source.
  const style = transcriptStyleForVariant(framingVariant ?? currentFramingVariant());
  if (effectiveTools && effectiveTools.length > 0 && toolChoice !== "none") {
    const framing = `${formatToolDefinitions(effectiveTools, framingVariant)}${formatToolChoiceInstruction(toolChoice)}`;
    parts.push(style.framingTag ? `<${style.framingTag}>\n${framing}\n</${style.framingTag}>` : framing);
  }

  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const calls = m.tool_calls.map((tc) => {
        const rawArgs = tc.function.arguments;
        let argsObj: Record<string, unknown> = {};
        try {
          argsObj = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
        } catch {
          // fall through with empty args; better than crashing the transcript
        }
        // Prefer the request's tool schema; otherwise synthesize one from the
        // recorded argument keys so a tool no longer in scope still renders.
        const spec = specMap?.get(tc.function.name) ?? deriveFencedSpec({
          type: "function",
          function: {
            name: tc.function.name,
            parameters: {
              properties: Object.fromEntries(
                Object.keys(argsObj).map((k) => [k, { type: "string" }]),
              ),
            },
          },
        });
        return renderFencedCall(spec, argsObj);
      }).join("\n");
      const content = getMessageContent(m);
      parts.push(`<assistant>${content ? "\n" + content : ""}\n${calls}\n</assistant>`);
    } else if (m.role === "tool") {
      parts.push(formatToolResponse(m, messages));
    } else if (m.role === "system") {
      parts.push(`<${style.systemTag}>\n${getMessageContent(m)}\n</${style.systemTag}>`);
    } else {
      parts.push(`<${m.role}>\n${getMessageContent(m)}\n</${m.role}>`);
    }
  }

  return parts.join("\n\n");
}

// --- Parsing ---

export interface ParsedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ParseResult {
  hasToolCalls: boolean;
  toolCalls: ParsedToolCall[];
  textContent: string | null;
}

// Patterns of M365's stochastic turn-1 "give-up" confabulation: it claims it can't
// see/run anything and asks the user to paste files, WITHOUT ever calling a tool —
// even though the environment is real. Used to trigger a forcing retry (handler).
const CONFABULATION_PATTERNS: RegExp[] = [
  /return(?:ing|s|ed)?\s+no\s+(?:output|results?|content)/i,
  /no\s+(?:output|results?|content|data)\s+(?:was\s+|were\s+)?(?:return|provid|present)/i, // "no content was returned"
  // The `to` is optional — matches both "unable TO access" and "can't access" (the
  // old `to?` made the *t* mandatory, so "can't inspect"/"can't access" slipped
  // through). `execute`/`retrieve`/`fetch` added: the give-up reflex phrases them
  // ("unable to execute or retrieve any output") and they were absent from the list.
  /(?:unable|not able|can.?t|cannot)\s+(?:to\s+)?(?:access|inspect|list|read|run|execute|retrieve|fetch|locate|see|open)/i,
  /don.?t\s+have\s+access/i,
  /no\s+(?:longer\s+have|access\s+to)/i,   // "no access to" + "no longer have access/the tools"
  /lost\s+(?:access|my\s+access|the\s+ability)/i,
  // Mid-conversation give-up (F12.11, magic model): after a real tool call it claims
  // it "no longer has the tools" and asks to move to another session, e.g. "restart the
  // task in a coding-enabled session". A genuine completion never asks to start over.
  /(?:restart|start\s+over|begin\s+again|re-?run)\s+(?:the\s+|this\s+)?(?:task|session|conversation|work)\s+in\s+(?:a\s+)?/i,
  /(?:in|use|switch\s+to|need)\s+(?:a\s+)?(?:different|another|proper|coding-?enabled|tool-?enabled|shell-?enabled)\s+(?:session|environment|conversation|mode)/i,
  // "the live file-editing tools ... are not available to me here" (magic model, F12.11):
  // it claims its own tools are gone, then delegates the edit back to the user.
  /(?:tool|editor|shell|command|file-?editing)s?[^.\n]{0,40}\b(?:not\s+available|unavailable|aren.?t\s+available|isn.?t\s+available|are\s+not\s+accessible)/i,
  /(?:can.?t|cannot|not\s+able\s+to|unable\s+to)\s+(?:directly\s+)?(?:edit|modify|write\s+to|change|save|create|open)\s+(?:the\s+|any\s+|to\s+)?files?/i,
  /paste\s+(?:the\s+)?(?:contents?|files?|code|them)/i,
  /provide\s+(?:the\s+)?(?:contents?|files?)/i,
  /(?:environment|shell|tool)\s+(?:isn.?t|is not|aren.?t|are not|appears? to be)\s+(?:return|provid|respond|work|access)/i,
  // Wrong-machine tells (§12.13). These turns are not lies — the model really did
  // run something, in M365's own code-interpreter sandbox, and is reporting it
  // honestly. The user's disk was never touched, so it still needs forcing.
  // `/mnt/data` is that sandbox's cwd; `container.*` is its tool namespace. Only
  // the *prose* form lands here — a fenced ```container.exec block is salvaged by
  // the shell-alias routing in fenced.ts and never reaches this check.
  /(?:current\s+working\s+directory|working\s+directory|cwd)[\s\S]{0,120}\/mnt\/data/i,
  /(?:\bpwd\b|\bcd\b)[\s\S]{0,60}\/mnt\/data/i,
  /(?:ran|used|executed|called)[\s\S]{0,80}container\.(?:exec|open_image|download)/i,
  /container\.(?:exec|open_image|download)[\s\S]{0,120}(?:returned|output|shows?|result)/i,
  /no\s+files?\s+(?:in|found|present|visible)/i,
  /(?:file|directory|folder|it)\s+(?:appears?|seems?|looks?)\s+(?:to\s+be\s+)?empty/i, // "the file appears to be empty"
  /nothing\s+to\s+(?:simplify|fix|do|change|show|read)/i,                               // "nothing to simplify"
  /(?:tool|command|it)\s+returned\s+(?:no|empty|nothing)/i,
  // GPT-5.6 can truthfully describe M365's remote runtime as if it were the
  // caller's environment. This wording slipped past the older can't-access
  // patterns because it says the session "does not expose" the filesystem.
  /(?:session|environment|runtime)\s+(?:does\s+not|doesn.?t|cannot)\s+(?:expose|mount|provide)\s+(?:the\s+)?(?:local\s+)?(?:repository\s+)?filesystem/i,
  /(?:my|the)\s+filesystem\s+(?:only\s+)?(?:contained|contains|has)[\s\S]{0,80}\/mnt\/data/i,
  // Turkish. The model answers in the user's language, so every pattern above was
  // blind to a Turkish-speaking user's give-ups: "Bu oturumda ... dosya yazma aracı
  // etkin değil", "dosya oluşturma özelliğim devre dışı ... kaydedemiyorum" both
  // went straight to the user with no forcing retry (measured, Windows/pi/GPT-5.6).
  // Kept FIRST-PERSON or session-scoped on purpose: this repo's own docs say things
  // like "retry devre dışı bırakılır" and "oturum yönetimi", and a project summary
  // in Turkish must not read as a give-up. Verb forms are 1sg only (-amıyorum,
  // -amam, -amadım), so third-person "okuyamıyorsa"/"çalıştıramaz" don't match.
  // Spans allow a dot not followed by whitespace — `ozet.md` is a filename, not a
  // sentence end — and avoid \w, which is ASCII-only and stops at ı/ş/ğ.
  /bu\s+oturumda(?:[^.\n]|\.(?=\S)){0,80}(?:devre\s*dışı|etkin\s+değil|kullanılamıyor|mevcut\s+değil)/i,
  /(?:özelliğim|yeteneğim|aracım|araçlarım|erişimim|yetkim|iznim)(?:[^.\n]|\.(?=\S)){0,30}(?:devre\s*dışı|etkin\s+değil|yok|bulunmuyor)/i,
  /(?:oluştur|üret|hazırla|dönüştür|tamamla|kur|güncelle|kayded|eriş|çalıştır|oku|yaz|düzenle|incele|listele|aç)y?[ae]m(?:ıyorum|iyorum|am|em|adım|edim|adığım|ediğim)/i,
  /araç\s+çağrısı\s+yapama/i,
  /(?:dosya|araç)\s+erişimi\s+(?:olan|etkin)(?:[^.\n]|\.(?=\S)){0,40}oturum/i,                      // "dosya erişimi etkin bir kodlama oturumunda yeniden çalıştırın"
  /kopyala(?:[^.\n]|\.(?=\S)){0,80}kayde[dt]/i,                                                   // "kopyalayıp ozet.md olarak kaydedebilirsin" — hands the write back (kaydet → kayded- before a vowel) (kaydet/kayded-: consonant softening)
];

// M365 sometimes creates a real patch in its Teams-hosted remote artifact
// store instead of calling the harness's local edit/write/bash tools. The link
// is valid in M365 but the referenced file is not present in the caller's
// working directory, so a later `git apply <basename>` inevitably fails.
// Every pattern must be ANCHORED to something only M365's remote runtime emits:
// a Teams artifact URL, a `sandbox:/mnt/data` path, or a citation marker. Talking
// about a "patch" or "diff" is normal for a coding agent, so an unanchored verb +
// noun pattern (e.g. /generated .{0,100} patch/) fires on "I generated a patch for
// review" and — because this detector fails closed below — turns an ordinary answer
// into a 502. Anchors are what separate a remote artifact from a local one.
const REMOTE_ARTIFACT_COMPLETION_PATTERNS: RegExp[] = [
  /sandbox:\/mnt\/data\/[^\s)\]]+/i,
  /https?:\/\/[^\s)\]]*asyncgw\.teams\.microsoft\.com\/[^\s)\]]+\.(?:patch|diff)(?:[?#][^\s)\]]*)?/i,
  // The remote artifact may be the whole updated source file rather than a
  // patch. Require a mutation claim near the Teams "views/original" URL so a
  // normal shared link is not mistaken for a failed local edit.
  /\b(?:updated|modified|replaced|rewrote|saved|applied|prepared|created)\b[\s\S]{0,600}https?:\/\/[^\s)\]]*asyncgw\.teams\.microsoft\.com\/[^\s)\]]*\/views\/original\//i,
  /https?:\/\/[^\s)\]]*asyncgw\.teams\.microsoft\.com\/[^\s)\]]*\/views\/original\/[\s\S]{0,600}\b(?:updated|modified|replaced|rewrote|saved|applied|prepared|created)\b/i,
  // Live GPT-5.6 variant: "Updated [plan.md](<turn1file1 citation>) locally".
  // The private-use citation resolves to an M365 artifact, not the harness disk.
  /\b(?:updated|modified|replaced|rewrote|saved|applied)\b[\s\S]{0,180}\uE200cite\uE202turn\d+file\d+\uE201/i,
  /\uE200cite\uE202turn\d+file\d+\uE201[\s\S]{0,180}\b(?:updated|modified|replaced|rewrote|saved|applied)\b/i,
];

/**
 * Heuristic: does this no-tool-call response look like M365 confabulating an
 * inability to act (rather than a genuine final answer)? The handler uses this to
 * decide whether to force one more turn. Conservative — needs an explicit
 * can't-access / paste-the-files phrasing, which a real completion won't contain.
 */
// Past-tense claims of having performed a file mutation. Paired with a "no tool
// call ran at all this conversation" check, this catches hallucinated completion:
// the model says "I've replaced the README" without ever calling write/bash.
const HALLUCINATED_COMPLETION_PATTERNS: RegExp[] = [
  /\b(?:requested\s+)?(?:local\s+)?(?:edit|update|change|modification)\s+(?:is|was)\s+(?:now\s+)?complete\b/i,
  /\bI(?:'ve|\s+have|\s+just|\s+now)?\s+(?:created|wrote|written|replaced|updated|saved|applied|added|overwrote|modified|generated|implemented|rewrote)\b/i,
  /\b(?:the\s+)?(?:file|readme|script|config|change|version|content)\s+(?:has|have|is|was|were)\s+(?:been\s+)?(?:created|replaced|updated|saved|written|applied|added|modified|overwritten)\b/i,
  /\bhere'?s\s+(?:the\s+)?(?:updated|new|simplified|replaced|final)\s+(?:file|readme|version|content)\b/i,
  // Fakeable create-from-scratch hallucination (docs/hypotheses.md §8.12 / §9
  // remaining gap): the model narrates having MADE and RUN a file with no tool
  // call — e.g. "Created fizzbuzz.py and executed it with python3." The patterns
  // above all need a leading "I" or a file/readme/script noun, so a bare
  // "Created <name>.py" + "executed it" slips through. Catch both shapes:
  //  (a) a bare past-tense create/write verb followed by a filename token
  //      (≥2 chars before the dot, so abbreviations like "e.g."/"i.e." don't match);
  //  (b) an execution claim ("executed it with python3", "ran the script").
  /\b(?:created|wrote|written|generated|saved|added|produced|implemented|overwrote)\b[^.\n]{0,60}\b[\w-]{2,}\.[a-z]{1,4}\b/i,
  /\b(?:executed|ran|invoked|launched|compiled)\b[^.\n]{0,40}\b(?:it|them|this|the\s+(?:script|program|file|code|command|tests?)|python3?|node|\S{2,}\.[a-z]{1,4})\b/i,
];

/**
 * Does this no-tool-call response CLAIM a file mutation it may not have performed?
 * The handler only acts on this when NO tool call ran in the whole conversation —
 * a model that actually did the work called at least one tool — so it's a low
 * false-positive signal for the "I've replaced the README" hallucination.
 */
export function looksLikeHallucinatedCompletion(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 8) return false;
  return HALLUCINATED_COMPLETION_PATTERNS.some((re) => re.test(t));
}

/**
 * Did M365 substitute a remote Teams-hosted patch for a local filesystem edit?
 * Unlike the general hallucinated-completion detector this must fire even after
 * earlier tool calls: reading a file locally does not make a remote patch local.
 */
export function looksLikeRemoteArtifactCompletion(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 12) return false;
  return REMOTE_ARTIFACT_COMPLETION_PATTERNS.some((re) => re.test(t));
}

export function looksLikeConfabulation(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 12) return false;
  return CONFABULATION_PATTERNS.some((re) => re.test(t));
}

// A tool result the MODEL wrote. The proxy is the only thing that sends
// <tool_response> blocks, so one in the model's own output is invented.
const SELF_WRITTEN_RESULT = /<tool_(?:response|result)\b/i;
const ANY_FENCE = /```[A-Za-z0-9_.-]+[ \t]*\r?\n[\s\S]*?```/;

/**
 * Treat a self-written `<tool_response>` as a STOP SEQUENCE.
 *
 * Real tool-calling APIs stop generating at the call. M365's chat models don't:
 * Claude Sonnet 4.6 routinely writes its fence and then carries on, inventing
 * the `<tool_response>` it expects and acting on that fiction — 38 of 80 turns
 * in the Sep 28 bench dumps (the same tone on the paid scenario: 0 of 154).
 * With 3-4 fences the tail makes the turn look like a prose document, so the
 * document guard returned it as text and the one REAL action at the head was
 * thrown away: at least 7 of the 13 turns that run lost to the guard carried an
 * invented result (#31).
 *
 * Everything from the invented tag onward is fabricated, so cut there and keep
 * the head — but only when the head holds a real call to one of `tools` (any
 * fence, if no tools are given): a tag after prose or a ```python illustration
 * is not a model predicting ITS OWN call's result.
 */
export function truncateAtFabricatedToolResponse(text: string, tools?: ToolDef[]): string {
  const i = text.search(SELF_WRITTEN_RESULT);
  if (i < 0) return text;
  const head = text.slice(0, i);
  const acted = tools && tools.length > 0 ? parseToolCalls(head, tools).hasToolCalls : ANY_FENCE.test(head);
  return acted ? head.trimEnd() : text;
}

/**
 * Did the model write a DOCUMENT (prose with embedded code fences) rather than
 * issue tool calls? The shell-routing parser greedily turns every ```bash block
 * into a tool call, so a model answering "here's a simplified README" — whose
 * markdown is full of ```bash / ```json examples — would get its own answer
 * executed as shell. Catch that: a real agentic turn is ONE action with little
 * prose; a document is multiple fences surrounded by substantial prose.
 *
 * Chosen empirically (scripts guard-experiment, README-about-bash fixture):
 * ≥2 fences AND (≥120 chars of surrounding prose OR ≥4 fences). A SINGLE action
 * is never reclassified regardless of prose, so the coding loop is untouched.
 *
 * With `text` + `tools`, one more rule runs first: a reply that OPENS with a
 * tool call is an action, whatever follows it. A tool-calling model stops at
 * its call; everything M365's models write after it was written before the
 * result existed — invented output, a second guess, an essay (Sonnet 4.6 writes
 * all three). Judged by the whole text, those tails made 34 of 42 guard verdicts
 * across the Sep 28 bench runs, each discarding a correct first action
 * (#33). The documents this guard exists for announce themselves
 * before their first fence (a title, an intro, example code), so the preamble
 * decides.
 */
export function isProseDocument(parsed: ParseResult, text?: string, tools?: ToolDef[]): boolean {
  if (!parsed.hasToolCalls || parsed.toolCalls.length < 2) return false;
  if (text !== undefined && tools && tools.length > 0) {
    const first = findFirstToolFence(text, buildSpecMap(tools));
    if (first && !looksLikeDocumentPreamble(text.slice(0, first.start))) return false;
  }
  const prose = parsed.textContent ? parsed.textContent.trim() : "";
  // Distinguish a coding-agent ACTION turn from a written DOCUMENT.
  //   ACTION  (execute it): a short preamble + a couple command fences, e.g. Claude's
  //           "I'll inspect the files first.\n```bash ls```\n```bash cat```" — common,
  //           must NOT be reclassified or we eat real tool calls (docs §10 F23).
  //   DOCUMENT (return as text): the model ANSWERING with markdown full of fences
  //           (F15: "here's a simplified README") — it carries document signatures:
  //           markdown headers, lots of prose, or many fences.
  // Flag only documents. (Old heuristic was prose≥120, which ate Claude's preambles.)
  const hasMarkdownHeaders = /^#{1,6}\s/m.test(prose);
  return parsed.toolCalls.length >= 4 || hasMarkdownHeaders || prose.length >= 300;
}

/** Is the text before a reply's first tool call the opening of a written
 *  document (a heading, example code, or a long intro) rather than a one-line
 *  lead-in like "I'll inspect the files first."? */
function looksLikeDocumentPreamble(preamble: string): boolean {
  return /^#{1,6}\s/m.test(preamble) || preamble.includes("```") || preamble.trim().length >= 200;
}

/** The text a reply carries after its first tool call (trimmed), or "" —
 *  used to tell the model its tail was written before the call ran. */
export function textAfterFirstToolCall(text: string, tools?: ToolDef[]): string {
  if (!tools || tools.length === 0) return "";
  const first = findFirstToolFence(text, buildSpecMap(tools));
  return first ? text.slice(first.end).trim() : "";
}

export function parseToolCalls(text: string, tools?: ToolDef[]): ParseResult {
  // Fenced is the format: parse ```toolname blocks first. Needs the tool schemas
  // to map header/body args. The JSON parse below is only a tolerance fallback for
  // when M365 ignores the contract and emits a `{"tool":...}` object anyway.
  const specMap = tools && tools.length > 0 ? buildSpecMap(tools) : null;
  if (specMap) {
    const { calls, leftover } = parseFencedToolCalls(text, specMap);
    if (calls.length > 0) {
      return { hasToolCalls: true, toolCalls: calls, textContent: cleanLooseText(leftover) };
    }
  }

  // The spec map carries the shell aliases too, so a JSON call naming a leaked
  // runtime tool (`container.exec`) resolves to the harness shell tool here.
  const resolveName = (raw: unknown): string | undefined =>
    typeof raw === "string" ? (specMap?.get(raw)?.name ?? raw) : undefined;

  const toolCalls: ParsedToolCall[] = [];

  // Tolerance fallback: a stray JSON tool call {"tool": "...", "arguments": {...}}
  const jsonRegex = new RegExp(TOOL_CALL_REGEX.source, "g");
  let match: RegExpExecArray | null;

  while ((match = jsonRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      const name = resolveName(parsed.tool);
      if (name) {
        toolCalls.push({
          id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
          type: "function",
          function: {
            name,
            arguments: typeof parsed.arguments === "string"
              ? parsed.arguments
              : JSON.stringify(parsed.arguments ?? {}),
          },
        });
      }
    } catch {
      log.error("Failed to parse tool call JSON:", match[0]);
    }
  }

  // Fallback: try legacy fenced format
  if (toolCalls.length === 0) {
    const fencedRegex = new RegExp(FENCED_TOOL_CALL_REGEX.source, "g");
    while ((match = fencedRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        const name = resolveName(parsed.tool || parsed.name);
        if (name) {
          toolCalls.push({
            id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
            type: "function",
            function: {
              name,
              arguments: typeof parsed.arguments === "string"
                ? parsed.arguments
                : JSON.stringify(parsed.arguments ?? {}),
            },
          });
        }
      } catch {
        log.error("Failed to parse fenced tool call JSON:", match[1]);
      }
    }
  }

  if (toolCalls.length === 0) {
    return { hasToolCalls: false, toolCalls: [], textContent: cleanLooseText(text) };
  }

  // Strip matched tool calls from text to get remaining content.
  // M365 is a markdown model and often wraps the JSON in a ```json / ```tool_call
  // fence even when told not to; remove the now-empty fence markers it leaves
  // behind so they aren't mistaken for real assistant prose. Also drop the
  // invented confidence/final objects so a premature "✅ SUCCESS" never reaches
  // the client and a junk-only leftover isn't flagged as mixed output.
  let remaining = text
    .replace(jsonRegex, "")
    .replace(new RegExp(FENCED_TOOL_CALL_REGEX.source, "g"), "")
    .replace(CONFIDENCE_REGEX, "")
    .replace(FINAL_OBJECT_REGEX, "")
    .replace(/```(?:json|tool_call)?\s*```/g, "") // empty fence pair
    .replace(/```(?:json|tool_call)?/g, "") // dangling opening/closing fence
    .trim();

  return {
    hasToolCalls: true,
    toolCalls,
    textContent: remaining || null,
  };
}
