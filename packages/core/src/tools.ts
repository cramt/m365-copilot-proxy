import { createLogger } from "./log.js";
import {
  buildSpecMap,
  currentFramingVariant,
  deriveFencedSpec,
  formatFencedToolDefinitions,
  parseFencedToolCalls,
  renderFencedCall,
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
  if (effectiveTools && effectiveTools.length > 0 && toolChoice !== "none") {
    parts.push(`<system>\n${formatToolDefinitions(effectiveTools, framingVariant)}${formatToolChoiceInstruction(toolChoice)}\n</system>`);
  }

  // Correlate each tool result back to the call that produced it, so the model
  // sees WHICH command's output it's reading (e.g. `bash: ls -la`). Without this
  // the result is labelled "unknown" and the model misreads it — observed: it ran
  // `ls`, saw `README.md`, and concluded the *file* was empty (docs §9 F15-adjacent).
  const callMeta = new Map<string, { name: string; summary: string }>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id) callMeta.set(tc.id, { name: tc.function.name, summary: toolCallSummary(tc.function.arguments) });
      }
    }
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
      const meta = m.tool_call_id ? callMeta.get(m.tool_call_id) : undefined;
      const name = m.name || meta?.name || "tool";
      // Show the command/args that produced this output so the model reads it in
      // context (a directory listing vs file contents vs a command's stdout).
      const cmdAttr = meta?.summary ? ` command="${meta.summary}"` : "";
      parts.push(`<tool_response tool="${name}"${cmdAttr}>\n${getMessageContent(m)}\n</tool_response>`);
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
 */
export function isProseDocument(parsed: ParseResult): boolean {
  if (!parsed.hasToolCalls || parsed.toolCalls.length < 2) return false;
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
