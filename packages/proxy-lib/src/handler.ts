import {
  ModelSession,
  AetherSession,
  type ModelSessionOptions,
  type TurnSession,
  type CopilotStream,
  type Backend,
  resolveModelRoute,
  createLogger,
  trunc,
  getToneForModel,
  requestUsesAgent,
  isPremiumOnlyModel,
  noteAgentRouteDead,
  noteAgentRouteAlive,
  isAgentRouteAlive,
  noteWebSearchOverflow,
  toneUsesWebSearch,
  PREMIUM_ONLY_AGENT_TONES,
  defaultFramingForModel,
  currentFramingVariant,
  transcriptStyleForVariant,
  priorityAccessExhaustionOf,
  notePriorityAccessExhausted,
  activePriorityAccessExhaustion,
  meteredAllowance,
  METERED_BUDGETS,
  type MeteredBudget,
  meteredBudgetOf,
  priorityAccessFallbackModel,
  PRIORITY_ACCESS_FALLBACK_ENV,
  couldBePriorityAccessPrefix,
  secondsUntilReset,
  type PriorityAccessExhaustion,
  formatMessages,
  attachmentUrls,
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  looksLikeRemoteArtifactCompletion,
  truncateAtFabricatedToolResponse,
  fabricatedToolResponseAt,
  textAfterFirstToolCall,
  unreadableToolCall,
  longHeredocAsWrite,
  strippedTypeMember,
  findRecognizedShellTool,
  toolsBlock,
  formatToolResponse,
  isProseDocument,
  getMessageContent,
  noteRequestOutcome,
  awaitDegradationBackoff,
  awaitTurnBudget,
  TurnBudgetHold,
  getImageArtifactToken,
  fetchImageBytes,
  type CapturedImage,
  type ParseResult,
} from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { maxTurnParts, planFullPrompt, planText, turnChunkBytes } from "./replay.js";
import { estimateTokens, reportsUsage } from "./usage.js";
import {
  cleanHarnessMessages,
  harnessPromptMode,
  leanHarnessTools,
  millisecondArgsFixed,
  streamErrorsAsText,
  streamErrorText,
  stripGatewayToolTipsFromMessages,
} from "./harness.js";
import type { z } from "zod/v4";

const log = createLogger("handler");

// Render generated images (§14) as markdown so any OpenAI-compatible client shows
// them inline. The artifact URL 401s without the designerappservice token, so we
// fetch the bytes ourselves and embed a self-contained data URI — a bare URL would
// be useless to the client. On fetch failure we fall back to the raw URL so the
// response is never silently empty.
async function renderImagesMarkdown(images: CapturedImage[]): Promise<string> {
  if (images.length === 0) return "";
  let artifactToken: string | null = null;
  try { artifactToken = await getImageArtifactToken(); } catch (e: any) { log.info(`image token failed: ${e.message}`); }
  const parts: string[] = [];
  for (const img of images) {
    const url = img.referenceUrls[0];
    if (!url) continue;
    if (artifactToken) {
      try {
        const { data, contentType } = await fetchImageBytes(url, artifactToken);
        parts.push(`![generated image](data:${contentType};base64,${data.toString("base64")})`);
        continue;
      } catch (e: any) { log.info(`image fetch failed: ${e.message}`); }
    }
    parts.push(`![generated image](${url})`);
  }
  return parts.join("\n\n");
}

// Forcing follow-up sent (in the same conversation) when M365 confabulates an
// inability to act instead of calling a tool. See the confab-retry loop below.
const CONFAB_FORCE_PROMPT =
  "The working directory and the files named in the task ARE present on a real filesystem right now. Do NOT ask me to paste anything, and do NOT say commands return no output — you have not run any command yet. Emit ONE ```bash block this turn: run `ls -la` and `cat` the relevant files. Output only the ```bash block, nothing else.";

// The same give-up AFTER the model has already run tools. CONFAB_FORCE_PROMPT
// says "you have not run any command yet" — false at that point, and the model
// treats a prompt that contradicts its own transcript as untrustworthy: live
// (Windows / pi / gpt-5.6-think-deeper) it answered "so I can't run `ls -la` or
// `cat`", refusing the prompt's own instruction. The give-ups that reach here
// follow an obstacle — no PDF tool or Word library installed — so say what is
// true: the tools work, and a missing program is something to install.
const MIDTASK_FORCE_PROMPT =
  "Your tools are working: your previous command really ran on this machine, and its real output is in the last <tool_response>. Continue the task from there with ONE tool block for the next step. A missing program or library is not a missing tool — install it with the package manager (pip, npm, …) or do the job with what is already installed. Output only the tool block, nothing else.";

// Sent (in the same conversation) when the reply tried to call a tool but the
// call couldn't be read (unreadableToolCall): a fence never closed, an edit
// without its markers. Passed on as prose instead, it ends the harness's turn,
// and the model reads the silence as having no tools.
function unreadableCallPrompt(bad: { name: string; reason: string }): string {
  return `(Note: your last reply had a \`\`\`${bad.name} block that couldn't be read as a tool call — ${bad.reason} — so nothing ran. If you meant to run it, send it again as one block: \`\`\`${bad.name} on its own line, then its content, then \`\`\` on a line of its own. If you didn't mean to, reply without it.)`;
}

// Forcing follow-up when the model CLAIMS it did a file change but ran no tool.
const HALLUCINATION_FORCE_PROMPT =
  "You have NOT actually done that — no tool ran this turn, so nothing changed on disk. Do not claim a file was created, replaced, or updated until a <tool_response> confirms it. Emit ONE ```bash block now that performs the change for real (write the file with a `cat > path <<'EOF' … EOF` heredoc), and nothing else.";

// A Teams artifact belongs to M365's remote runtime and cannot be applied by a
// local agent using only its basename. Force the intended mutation through the
// harness tools instead of letting the remote patch leak into the conversation.
const REMOTE_ARTIFACT_FORCE_PROMPT =
  "The patch or download link you produced exists only in M365's remote environment and is NOT a file in the caller's working directory. Do NOT create, download, or apply a patch, and do NOT use a Teams artifact link. Use the provided local edit/write tool directly; if needed, emit ONE ```bash block that modifies the named local file in place. Output only that single local tool call, nothing else.";

/** The re-prompt for a PowerShell command that lost a `[Type]:` to M365's
 *  post-processing (strippedTypeMember): `member` is what arrived, e.g. `:Replace`. */
function strippedTypeMemberPrompt(member: string): string {
  return `(Note: I didn't run your last command, because it reached my terminal damaged. This chat deletes a one-word type name in square brackets when a colon follows it, even inside code, so [Type]::${member.slice(1)} arrived as \`${member}\`, which would have run as nothing. Please send the same command again with full dotted .NET type names, such as [System.Text.RegularExpressions.Regex]::Replace(...), [System.String]::IsNullOrWhiteSpace(...) or [System.Math]::Max(...), or with operators like -replace and -match.)`;
}

// M365 soft-caps output around ~3k tokens (~12k chars) and — critically —
// CONCLUDES EARLY rather than truncating mid-stream, so a too-long answer comes
// back clean-looking but incomplete with no error to detect (docs/hypotheses.md
// F9). We can't see token counts, so we heuristically flag responses at/over the
// observed ceiling with finish_reason:"length" — the standard signal a harness
// uses to ask for a continuation. Tune/disable via env (0 disables).
const OUTPUT_CHAR_CEILING = process.env.M365_OUTPUT_CHAR_CEILING !== undefined
  ? Number(process.env.M365_OUTPUT_CHAR_CEILING)
  : 12_000;

/** "length" when the answer is at/over the empirical output ceiling, else "stop".
 *  Chat's ceiling: the agent runtime's answers run longer. */
function outputFinishReason(text: string, chat = true): "stop" | "length" {
  if (chat && OUTPUT_CHAR_CEILING > 0 && text.length >= OUTPUT_CHAR_CEILING) {
    log.info(`Output at ceiling (${text.length} ≥ ${OUTPUT_CHAR_CEILING} chars) — finish_reason=length (likely truncated; harness should continue)`);
    return "length";
  }
  return "stop";
}

/** How many chars of a model-written <tool_response> tail a tool turn may run
 *  before the proxy stops it (runBuffered). 0 stops at the tag itself. With the
 *  default, pi takes as many turns as when the turn runs to its end (+2%,
 *  p = 0.74), and no runaway gets far; stopping at the tag cost 10% more turns
 *  (hypotheses §35 F89). */
const DEFAULT_EARLY_STOP_AFTER = 2_000;
function earlyStopAfter(): number {
  const v = Number(process.env.M365_EARLY_STOP_AFTER);
  return process.env.M365_EARLY_STOP_AFTER !== undefined && Number.isFinite(v) && v >= 0 ? v : DEFAULT_EARLY_STOP_AFTER;
}

/** The longest M365_AVOID_THROTTLING holds a request that isn't streamed: it
 *  sends nothing until the answer, and its clients give up on headers after
 *  5 min (pi's SDK, the bench), of which a turn itself can take ~3. A streamed
 *  request has its keepalive chunks and waits up to M365_BUDGET_MAX_WAIT_MIN. */
const UNSTREAMED_BUDGET_WAIT_LIMIT_MS = 2 * 60_000;

type ChatBody = z.infer<typeof ChatCompletionRequest>;
type ParsedMessage = ChatBody["messages"][number];

/** Adapt only existing recovery triggers, never infer a trigger from a tool name. */
function recoveryPrompt(body: ChatBody, reason: "confab" | "remote" | "halluc", everActed: boolean): string {
  const choice = body.tool_choice;
  const tools = typeof choice === "object"
    ? (body.tools ?? []).filter(t => t.function.name === choice.function.name)
    : (body.tools ?? []);
  // Preserve the measured shell prompts byte-for-byte when shell routing is permitted.
  if (findRecognizedShellTool(tools)) {
    return reason === "remote" ? REMOTE_ARTIFACT_FORCE_PROMPT
      : reason === "confab" ? (everActed ? MIDTASK_FORCE_PROMPT : CONFAB_FORCE_PROMPT)
      : HALLUCINATION_FORCE_PROMPT;
  }
  if (!tools.length) return "The requested tool is not provided. Explain that limitation without claiming the action completed.";
  const correction = reason === "remote"
    ? "A remote artifact or download link is not evidence that the requested change was applied. Do not offer a remote patch or artifact as a completed change; use only a provided tool whose definition supports the requested action."
    : reason === "confab"
      ? "Continue using only the capabilities declared by the provided tools; do not assume filesystem or shell access beyond their definitions."
      : "No tool ran this turn. Do not claim the requested action completed without a confirming <tool_response>.";
  // Reuse the canonical fenced templates, not a second argument-format renderer.
  // Only the definitions are needed: framing variants can assert shell/file access.
  const definitions = toolsBlock(tools);
  return `${correction}\n\nUse ONE fenced tool call with an exact tool name and the argument format below, then wait for its <tool_response>. Output only that single tool block, nothing else.\n\n${definitions}`;
}


// --- Per-conversation state ---

interface ConversationState {
  session: TurnSession;
  sentMessageCount: number;
  lastAccessedAt: number;
  /** Sent ahead of the next tool result when the proxy executed less than the
   *  model wrote last turn (see executedOnlyFirstNote). */
  pendingNote: string | null;
  /** The model that last answered in this conversation. A different one (the
   *  Opus fallback, #18) can't continue the M365 conversation — it may need
   *  another scenario — so it starts a fresh one with the full history. */
  servedModel?: string;
  /** replyKey of the last reply this conversation gave the client. */
  lastReply: string | null;
  /** Characters in the turn that last sent this M365 conversation the whole
   *  history (its opening, or a replay into it; the first part, when the
   *  history went in parts). */
  openingChars: number;
  /** That prompt was answered. Only an answered one can show that M365 didn't
   *  keep a history that long; one it never processed shows nothing. */
  openingAnswered: boolean;
  /** M365 lost this conversation's history after a reply had already streamed:
   *  the next request replays the whole history in a fresh conversation. */
  replayNext: boolean;
  /** On the agent runtime (Cowork or Code), whose conversations show in the user's sidebar. */
  runtime: boolean;
  /** Requests running in it now: the pool doesn't drop it for idleness meanwhile. */
  activeRequests: number;
}

/** What a client echoes back of a reply in its next request: the tool-call ids
 *  (they pair the results, so they come back verbatim), else the text. */
function replyKey(m: ParsedMessage | undefined): string | null {
  if (m?.role !== "assistant") return null;
  return m.tool_calls?.length ? m.tool_calls.map((c) => c.id).join(" ") : getMessageContent(m).trim();
}

/**
 * The note that corrects the model's view of what actually ran.
 *
 * When the proxy executes only part of a reply — the head before a self-written
 * `<tool_response>` (the stop sequence), the first of several batched calls, or
 * the call at the head of a reply that kept going (#33) — M365's
 * server-side history still holds the WHOLE reply. The model then believes its
 * invented results happened, often including an invented "done", and reads the
 * real result as stale: "It looks like this tool response came in out of
 * context" (Sonnet 4.6: 9 of 56 bench runs ended that way without this note,
 * 0 of 70 with it; #31).
 */
const TRAILING_NOTE_CHARS = 120;
export function executedOnlyFirstNote(fabricated: boolean, droppedCalls: number, trailingChars = 0): string | null {
  if (fabricated) {
    return "(Note: only the first tool call in your previous reply was actually run. Everything you wrote after it, including the <tool_response> you wrote yourself, did not happen. Here is the real output of that first call:)";
  }
  const speculated = trailingChars >= TRAILING_NOTE_CHARS;
  if (droppedCalls > 0) {
    const rest = droppedCalls === 1 ? "the other one was not" : `the other ${droppedCalls} were not`;
    const tail = speculated ? " Anything you wrote after it was written before its result existed." : "";
    return `(Note: only the first of the ${droppedCalls + 1} tool calls in your previous reply was run; ${rest}.${tail} Here is the real output of the first one:)`;
  }
  if (speculated) {
    return "(Note: only the tool call in your previous reply was acted on; anything you wrote after it was written before its result existed. Here is the real output of that call:)";
  }
  return null;
}

// --- Session pool: maps conversation fingerprint → M365 session ---

/** How long an idle conversation stays in the pool, in hours
 *  (M365_CONVERSATION_TTL_HOURS). M365 keeps a conversation much longer: one
 *  idle for 21 h still recalled its earlier turns (docs/hypotheses.md §46 F126).
 *  An evicted conversation's next request replays the whole history into a
 *  fresh M365 conversation, and a long history can be too big for M365 to keep
 *  (F125). It was 30 minutes. */
const DEFAULT_CONVERSATION_TTL_HOURS = 24;
export function conversationTtlMs(): number {
  const hours = Number(process.env.M365_CONVERSATION_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_CONVERSATION_TTL_HOURS) * 3_600_000;
}
/** How long an idle Cowork or Code conversation stays, in minutes
 *  (M365_RUNTIME_CONVERSATION_TTL_MINUTES). Chat's are temporary chats, out of
 *  the user's sight; the runtime has no such mode, and lists each conversation
 *  in the user's Copilot sidebar until it's deleted (§48 F140). So these go
 *  half an hour after their last request, without waiting for another one, and
 *  the session deletes them (AetherSession.discard). A later request replays the
 *  whole history into a fresh one. Under M365_SAVE_HISTORY=1, which keeps them,
 *  Chat's TTL applies. */
const DEFAULT_RUNTIME_CONVERSATION_TTL_MINUTES = 30;
export function runtimeConversationTtlMs(): number {
  const minutes = Number(process.env.M365_RUNTIME_CONVERSATION_TTL_MINUTES);
  if (Number.isFinite(minutes) && minutes > 0) return minutes * 60_000;
  return process.env.M365_SAVE_HISTORY === "1" ? conversationTtlMs() : DEFAULT_RUNTIME_CONVERSATION_TTL_MINUTES * 60_000;
}
/** How often the pool looks for idle runtime conversations while it holds any. */
const RUNTIME_SWEEP_MS = 60_000;
/** Most conversations the pool keeps; past it the least recently used go first. */
const MAX_CONVERSATIONS = 1000;
/** Openings at least this long that M365 turned out not to keep teach the pool
 *  a size limit; a shorter one that went missing is treated as a one-off.
 *  M365 kept a 420k-character opening and dropped a 540k one (§46 F125). */
const UNKEPT_OPENING_MIN_CHARS = 200_000;

export class SessionPool {
  /** Keyed by fingerprint (first user message + tool names, scoped to
   *  sessionKey when given). Several can share one: two pi sessions opened with
   *  "merhaba", parallel subagents given one prompt, a session resumed after
   *  another started the same way. */
  private conversations = new Map<string, ConversationState[]>();
  private sessionOptions: ModelSessionOptions;
  /** Runs evictStale while the pool holds runtime conversations (RUNTIME_SWEEP_MS). */
  private runtimeSweep: ReturnType<typeof setInterval> | null = null;
  /** Per model: the shortest answered opening (chars, at least
   *  UNKEPT_OPENING_MIN_CHARS) whose history M365 was later found not to have
   *  kept, and when that was last seen. */
  private unkeptOpenings = new Map<string, { chars: number; at: number }>();

  constructor(sessionOptions: ModelSessionOptions = {}) {
    this.sessionOptions = sessionOptions;
  }

  /** The longest turn M365 has been seen not to keep for `model` (§46 F125).
   *  Turns are then cut under it (turnLimit, replay.ts), and a conversation that
   *  opened with a turn this long is replayed (in parts) instead of continued: a
   *  delta would land in an empty conversation. Whole replays on every request
   *  are left only under M365_TURN_CHUNK_BYTES=0. The lesson lasts as long as an
   *  idle conversation does (conversationTtlMs), so one loss can't shape every
   *  long conversation for the life of the process. */
  unkeptOpeningChars(model: string): number {
    const lesson = this.unkeptOpenings.get(model);
    if (!lesson) return Infinity;
    if (Date.now() - lesson.at > conversationTtlMs()) {
      this.unkeptOpenings.delete(model);
      return Infinity;
    }
    return lesson.chars;
  }

  /** M365 lost the history of a conversation with `model` that an answered
   *  `chars`-long prompt had opened. A shorter one than UNKEPT_OPENING_MIN_CHARS
   *  is treated as a one-off. */
  noteUnkeptOpening(model: string, chars: number): void {
    if (chars < UNKEPT_OPENING_MIN_CHARS) return;
    this.unkeptOpenings.set(model, { chars: Math.min(chars, this.unkeptOpeningChars(model)), at: Date.now() });
  }

  /**
   * Resolve the conversation state for an incoming request.
   * Fingerprint is the hash of the first user message and the request's tool
   * names — same opener and same tool set = same conversation family — scoped
   * to the client's session key when it sends one (prompt_cache_key / user),
   * and to the backend: a conversation on Chat can't continue on the agent
   * runtime.
   *
   * A harness re-sends the whole history and only ever appends, so a
   * continuation carries more messages than its conversation has sent, and at
   * that position it echoes the conversation's last reply (replyKey). The echo
   * tells apart conversations that share a fingerprint. Without a match it
   * falls back only when the fingerprint has a single conversation, so a client
   * that rewrites old replies still continues; with several, guessing would put
   * one session's turn into another's thread.
   */
  resolve(messages: ParsedMessage[], tools?: ChatBody["tools"], sessionKey?: string, backend: Backend = "chat"): ConversationState {
    this.evictStale();

    const fingerprint = this.fingerprint(messages, tools, sessionKey, backend);
    const bucket = this.conversations.get(fingerprint) ?? [];
    const candidates = bucket.filter((s) => s.activeRequests === 0 && messages.length > s.sentMessageCount);
    const own = candidates.find((s) => s.lastReply !== null && s.lastReply === replyKey(messages[s.sentMessageCount]))
      ?? (bucket.length === 1 ? candidates[0] : undefined);
    if (own) {
      own.lastAccessedAt = Date.now();
      return own;
    }

    // Not a continuation of any of them: a new session that shares the first
    // user message — two pi sessions opened with the same prompt, even in
    // different directories — or a re-sent request. Either way it needs a FRESH
    // M365 conversation, and the others stay as they are, because their sessions
    // may still be running. Measured (Windows / pi, 30 runs of 2 prompts): joined
    // to an earlier session's thread, later sessions answered from it —
    // "notlar.docx was already created and verified" in an empty directory — and
    // the pass rate fell 7/10 → 4/10 → 3/10 over the sweep. Resetting that thread
    // instead (F84) broke the earlier session when it was still alive: two
    // measurement jobs that ran at once threw each other's conversations away
    // every turn (§52 F153). The full prompt re-sends the whole history, so nothing
    // the harness holds is lost.
    this.evictOverflow();
    const current = this.conversations.get(fingerprint) ?? [];
    if (current.length) log.info(`Conversation ${fingerprint}: not a continuation of the ${current.length} on this first message, starting a fresh M365 conversation`);
    else log.info(`New conversation ${fingerprint}, ${this.size} active`);
    const runtime = backend !== "chat";
    const state: ConversationState = {
      session: runtime ? new AetherSession({ mode: backend }) : new ModelSession(this.sessionOptions),
      sentMessageCount: 0,
      pendingNote: null,
      lastReply: null,
      lastAccessedAt: Date.now(),
      openingChars: 0,
      openingAnswered: false,
      replayNext: false,
      runtime,
      activeRequests: 0,
    };
    current.push(state);
    this.conversations.set(fingerprint, current);
    this.scheduleRuntimeSweep();
    return state;
  }

  // The tool names are in the key because a harness's side requests can share
  // the session's first user message. opencode sends a title request ("You are
  // a title generator…", no tools) 4 ms before the task (12 tools): keyed on the
  // opener alone both went into one M365 conversation, as turns 0 and 1 run at
  // the same time (#83). pi's and opencode's tool sets don't change within a
  // session; one that does starts a fresh conversation with the full history,
  // which costs a thread, not the answer. Names, not definitions: descriptions
  // can carry per-turn text. The system prompt would separate the title request
  // too, but it is the likelier place for a date, a time or a git status.
  //
  // The client's session key, when it sends one, scopes all of that: Codex starts
  // every session in a repo with the same environment message (and the same
  // tools), and two Claude Code sessions can open with the same prompt, so
  // without it they'd share one M365 conversation. Subagents share the parent's
  // session key, so the first message and the tool names still have to be part
  // of the key.
  private fingerprint(messages: ParsedMessage[], tools?: ChatBody["tools"], sessionKey?: string, backend: Backend = "chat"): string {
    const firstUser = messages.find(m => m.role === "user");
    const text = firstUser ? getMessageContent(firstUser) : "";
    const toolNames = [...new Set((tools ?? []).map(t => t.function.name))].sort().join(",");
    const key = `${toolNames}\n${text}`;
    const scoped = sessionKey ? `${sessionKey}\u0000${key}` : key;
    return simpleHash(backend === "chat" ? scoped : `${backend}\u0001${scoped}`);
  }

  private evictStale() {
    const now = Date.now();
    const ttl = conversationTtlMs();
    const runtimeTtl = runtimeConversationTtlMs();
    for (const [key, bucket] of this.conversations) {
      const live: ConversationState[] = [];
      for (const s of bucket) {
        if (s.activeRequests > 0 || now - s.lastAccessedAt <= (s.runtime ? runtimeTtl : ttl)) {
          live.push(s);
        } else {
          s.session.close?.();
        }
      }
      if (live.length < bucket.length) log.info(`Evicting ${bucket.length - live.length} idle conversation(s) ${key}`);
      if (live.length) this.conversations.set(key, live);
      else this.conversations.delete(key);
    }
    this.scheduleRuntimeSweep();
  }

  /** Sweeps for idle runtime conversations while there are any, so they're
   *  deleted on time even when no request comes (runtimeConversationTtlMs). */
  private scheduleRuntimeSweep() {
    const any = [...this.conversations.values()].some((bucket) => bucket.some((s) => s.runtime));
    if (any && !this.runtimeSweep) {
      this.runtimeSweep = setInterval(() => this.evictStale(), RUNTIME_SWEEP_MS);
      this.runtimeSweep.unref?.();
    } else if (!any && this.runtimeSweep) {
      clearInterval(this.runtimeSweep);
      this.runtimeSweep = null;
    }
  }

  /** Makes room for a new conversation; a request for a pooled one never evicts. */
  private evictOverflow() {
    const total = this.size;
    if (total < MAX_CONVERSATIONS) return;
    const all: Array<{ key: string; state: ConversationState }> = [];
    for (const [key, bucket] of this.conversations) {
      for (const state of bucket) {
        if (state.activeRequests === 0) all.push({ key, state });
      }
    }
    all.sort((a, b) => a.state.lastAccessedAt - b.state.lastAccessedAt);
    for (const { key, state } of all.slice(0, total - MAX_CONVERSATIONS + 1)) {
      log.info(`Evicting conversation ${key} (pool full)`);
      const bucket = this.conversations.get(key);
      if (!bucket) continue;
      const next = bucket.filter((s) => s !== state);
      if (next.length) this.conversations.set(key, next);
      else this.conversations.delete(key);
      state.session.close?.();
    }
  }

  get size(): number {
    let n = 0;
    for (const bucket of this.conversations.values()) n += bucket.length;
    return n;
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return String(hash);
}

/** M365 counts this turn's message as its conversation's first
 *  (`numUserMessagesInConversation` 1). On a follow-up turn that means the
 *  history the proxy sent before is gone (§46 F125). */
function conversationLost(stream: { throttle: { current: number; max: number } | null }): boolean {
  return stream.throttle?.current === 1;
}

/** The longest turn sent whole (replay.ts): M365_TURN_CHUNK_BYTES, or less once
 *  M365 has failed to keep a shorter opening of this model's (`unkeptOpeningChars`).
 *  The agent runtime takes a turn whole: it read 2M characters in one (§48). */
function turnLimit(pool: SessionPool, model: string, chat = true): number {
  if (!chat) return 0;
  const configured = turnChunkBytes();
  const unkept = pool.unkeptOpeningChars(model);
  if (configured <= 0 || !Number.isFinite(unkept)) return configured;
  return Math.min(configured, Math.floor(unkept * 0.75));
}

/** M365 failed the turn: `result: InternalError` and the message's `turnState:
 *  Failed`. Such a turn still carries M365's canned "Sorry, I wasn't able to
 *  respond to that…" as its content, which is no answer: GPT-6.2 Sol answers a
 *  prompt over its ~270k-token input limit so on StreamHub (docs/hypotheses.md
 *  §47 F128; Chathub untested). */
function turnFailed(stream: { result?: { value: string } | null; turnState?: string | null }): boolean {
  return stream.result?.value === "InternalError" && stream.turnState === "Failed";
}

/** Could the head of a live stream still be that canned text? Like
 *  couldBePriorityAccessPrefix: hold it back until it can't. */
const FAILED_TURN_TEXT = "sorry, i wasn't able to respond to that";
function couldBeFailedTurnText(text: string): boolean {
  const t = text.replace(/[\u2018\u2019]/g, "'").trimStart().toLowerCase().slice(0, FAILED_TURN_TEXT.length);
  return !t || FAILED_TURN_TEXT.startsWith(t) || t.startsWith(FAILED_TURN_TEXT);
}

/** What a session's run() streams for one turn. */
type TurnStream = CopilotStream;
/** How sending a long turn's parts went (sendParts in handleChatCompletion). */
type PartsOutcome = null | "lost" | { refused: TurnStream; label: string } | { error: Response };

/** Requests sent in parts can re-send them: the plan, then one re-send. */
const MAX_PARTS_SENDS = 2;

/** Parse a tool-mode reply, with the document guard applied.
 *
 *  The shell-routing parser turns every ```bash block into a tool call, so a
 *  model that ANSWERS with a markdown document full of code fences ("here's a
 *  simplified README") would get its own answer executed as shell. That shape
 *  (multiple fences + prose) comes back as plain text instead — unless the reply
 *  OPENS with a tool call, which makes it an action with a speculative tail (#33).
 *  A single call is never reclassified, unless M365_LONG_ANSWER_GUARD=1 (off by
 *  default): then a long structured answer that ENDS in one example call is text.
 *
 *  This runs BEFORE the give-up checks, because a document runs nothing. It used
 *  to run after them, so a refusal that came with "run these yourself" fences —
 *  measured: "Dosya oluşturma özelliği bu oturumda devre dışı olduğu için
 *  notlar.pdf dosyasını oluşturamıyorum" + two ```bash blocks — counted as tool
 *  calls for the confabulation check (skipped), then as text for the user.
 *
 *  `judged` is the text the give-up checks read. For a document it's only the
 *  opening paragraph: a give-up announces itself there, and everything after
 *  is document content ("if you can't access the API…") that must not trip a
 *  forcing retry. */
function parseReply(text: string, tools: Parameters<typeof parseToolCalls>[1]): { parsed: ParseResult; judged: string | null } {
  const parsed = parseToolCalls(text, tools);
  if (isProseDocument(parsed, text, tools, { longAnswers: process.env.M365_LONG_ANSWER_GUARD === "1" })) {
    log.info(`Response is a prose document (${parsed.toolCalls.length} embedded fences), returning as text instead of executing`);
    const opening = text.split("```")[0].trim().split(/\n\s*\n/)[0];
    return { parsed: { hasToolCalls: false, toolCalls: [], textContent: text }, judged: opening };
  }
  return { parsed, judged: parsed.textContent };
}

/** M365's web client renders `<File>notlar.docx</File>` as a file chip, and its
 *  models write that markup into answers: 58 times in the 245 distinct final
 *  answers of the pi transcripts (Oct 2–5), plus `<document>`, `<Files>`,
 *  `<file>`, `<FILE>` and "< File>". An API client shows the raw tags, so a prose
 *  answer gets the bare name. Code is left as it is: closed and unclosed
 *  backtick/tilde fenced blocks, and inline code (`<file>a.txt</file>` written
 *  as an example of the markup). */
export function plainFileNames(text: string): string {
  const parts = text.split(/(\r?\n)/);
  let fence: { ch: "`" | "~"; len: number } | null = null;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && (open[1][0] === "~" || !open[2].includes("`"))) {
      fence = { ch: open[1][0] as "`" | "~", len: open[1].length };
      continue;
    }
    parts[i] = line.replace(
      /(`+)[^\n]*?\1|<\s*(file|files|document)\s*>([^<>\n]{1,200}?)<\/\s*\2\s*>/gi,
      (m, code, _tag, name) => (code ? m : name),
    );
  }
  return parts.join("");
}

// --- Delta message formatting ---

/** Format the messages new since the last turn. `history` is the whole request:
 *  a tool message names its call only by `tool_call_id` (pi sends no `name`),
 *  so formatToolResponse takes the tool's name and command from the assistant
 *  `tool_calls` that issued it — every result used to be labelled
 *  `name="unknown"` (#50). */
export function formatDeltaMessages(messages: ParsedMessage[], history: ParsedMessage[] = messages): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      // Skip assistant messages — M365 already has them server-side.
      // Echoing them back as a user message confuses M365.
      continue;
    } else if (m.role === "tool") {
      // Same rendering as the first turn: named for the call that produced it.
      parts.push(formatToolResponse(m, history));
    } else if (m.role === "system") {
      // Skip system messages on follow-up turns
    } else {
      parts.push(`<${m.role}>\n${getMessageContent(m)}\n</${m.role}>`);
    }
  }
  return parts.join("\n\n");
}

// --- Main handler ---

/**
 * Handle a chat completion request, returning an OpenAI-compatible Response.
 * The SessionPool routes each conversation to its own ModelSession.
 */
export async function handleChatCompletion(
  request: ChatBody,
  pool: SessionPool,
  opts: { signal?: AbortSignal; userAgent?: string | null } = {},
): Promise<Response> {
  // copilot-api's Codex tool tips contradict the shell routing; Claude Code's and
  // Codex's identity lines and reminders read as injections (M365_HARNESS_PROMPT,
  // see harness.ts).
  const promptMode = harnessPromptMode(opts.userAgent);
  const tipless = stripGatewayToolTipsFromMessages(request.messages);
  const body: ChatBody = {
    ...request,
    messages: promptMode === "off" ? tipless : cleanHarnessMessages(tipless),
    tools: promptMode === "lean" ? leanHarnessTools(request.tools) : request.tools,
  };
  if (promptMode !== "off") log.debug(`Harness prompt: ${promptMode}`);
  // The model ID names a backend: Chat, or the agent runtime's Cowork / Code (core backends.ts).
  const route = resolveModelRoute(request.model);
  if (route.error) {
    log.info(`Model ${request.model}: ${route.error}`);
    return jsonResponse(400, { error: { message: route.error, type: "invalid_request_error", code: "model_backend_not_enabled", param: "model" } });
  }
  // Chat's throttle, priority-access budgets, tool agent and Bing plugin don't apply to the agent runtime.
  const chat = route.backend === "chat";
  const noteOutcome = (throttled: boolean, cid: string) => { if (chat) noteRequestOutcome(throttled, cid); };
  const conv = pool.resolve(body.messages, body.tools, body.prompt_cache_key ?? body.user, route.backend);
  const { session } = conv;
  const hasTools = body.tools && body.tools.length > 0 && body.tool_choice !== "none";
  const requestedModel = route.model;
  const turnOptions = { reasoningEffort: body.reasoning_effort };

  // Priority access (§15, §24 F55, §26, issue #18). Once a budget is used up
  // every turn on it is refused until the reset, so don't start one: serve the
  // opt-in fallback model (M365_OPUS_FALLBACK_MODEL, e.g. the unmetered
  // claude-opus-4.8; M365_SONNET_FALLBACK_MODEL for Sonnet 5.5), or answer the
  // 429 here. A refused turn costs no allowance, but it does cost an M365 turn
  // and often a fresh conversation — what the account's thread-rate throttle
  // counts.
  const requestedBudget = chat ? meteredBudgetOf(requestedModel) : null;
  const knownExhaustion = chat ? activePriorityAccessExhaustion(requestedBudget ?? requestedModel) : null;
  const fallbackModel = knownExhaustion && requestedBudget ? priorityAccessFallbackModel(requestedBudget) : null;
  if (knownExhaustion && !fallbackModel) {
    log.info(`Priority access exhausted (${knownExhaustion.window}) until ${knownExhaustion.resetsAt.toISOString()} — 429 without contacting M365`);
    return priorityAccessResponse(knownExhaustion, requestedModel);
  }
  let model = fallbackModel ?? requestedModel;
  if (fallbackModel) log.info(`Priority access exhausted until ${knownExhaustion!.resetsAt.toISOString()} — serving ${requestedModel} with ${fallbackModel} (${PRIORITY_ACCESS_FALLBACK_ENV[requestedBudget!]})`);
  if (conv.servedModel && conv.servedModel !== model) {
    // The conversation was being served by another model (e.g. Opus 5.5 before
    // the fallback): continue in a fresh M365 conversation with the full history.
    log.info(`Conversation switches model ${conv.servedModel} → ${model}: fresh conversation, full history`);
    session.newConversation();
    conv.sentMessageCount = 0;
    conv.lastReply = null;
  }

  // A follow-up that M365 can't have context for: the reply to the last request
  // streamed before the proxy saw M365 had lost the history (replayNext), or the
  // conversation opened with a history at least as long as one M365 has already
  // failed to keep (§46 F125). A delta would land in an empty conversation, so
  // replay the whole history in a fresh one.
  const unkeptOpeningChars = pool.unkeptOpeningChars(model);
  if (conv.sentMessageCount > 0 && (conv.replayNext || conv.openingChars >= unkeptOpeningChars)) {
    log.info(conv.replayNext
      ? "M365 lost this conversation's history last turn: replaying the whole history in a fresh conversation"
      : `This conversation opened with ${conv.openingChars} chars, too long for M365 to keep (${unkeptOpeningChars} wasn't kept): replaying the whole history in a fresh conversation`);
    session.newConversation();
    conv.sentMessageCount = 0;
    conv.replayNext = false;
    conv.lastReply = null;
  }

  // Which requests carry the declarative tool agent. GPT-the-chat-model won't
  // tool-call agent-less (0/4), so it needs the agent. Claude tool-calls reliably
  // AGENT-LESS via shell-routing (F23), and on a non-premium account the agent
  // path doesn't serve Claude at all (§22 F44) — except Claude Opus, which takes
  // it: agent-less, Opus 4.8 works in its own code interpreter unless the
  // framing steers it out (§36). `Gpt_6_Reasoning` doesn't serve
  // with the agent on any account (§22 F45, #41), and `Gpt_6_Sol_Reasoning` /
  // `Gpt_61_Sol_Reasoning` only on a premium one (learned at runtime, see the
  // dead-route fallback in runBuffered). The rule lives in core (`requestUsesAgent`);
  // M365_FORCE_AGENT=1 / =0 forces the agent on / off for tool requests.
  // Derive it from the RESOLVED tone, not the raw model string: getToneForModel
  // routes any unmapped `claude-*` (e.g. the `claude-opus-5[1m]` a Claude Code
  // client sends) to a Claude tone, so this keeps that request on the working
  // agent-less path. The old `/claude/i.test(model)` + `magic` fallback split a
  // claude-* string into GPT-tone + agent-suppressed — the confab quadrant we
  // observed. One resolved tone drives both.
  let tone = getToneForModel(model);
  // Framing default follows the MODEL (defaultFramingForModel): the Claude,
  // GPT-6 and GPT-6 Sol tones get a user-voice relay (Sonnet reads the
  // `<system>`-tagged baseline as an injected prompt; on Opus it trips the
  // jailbreak classifier). Opus, Sonnet 4.6, GPT-6, GPT-6 Sol and GPT-6.1 Sol get the
  // turn-saving `relay_batch` (§24 F60, §25, §27, §28); Sonnet 5 and Sonnet 5.5 plain `relay`. The
  // rest keep the bench-tuned `baseline`.
  // Keyed on the model, not the tone, because one tone can serve two models.
  // M365_FRAMING_* still wins. Every agent-runtime turn is agent-less, so a model
  // with no default of its own there gets relay_batch, the user-voice framing
  // agent-less GPT models need (not the `<system>`-tagged baseline).
  let framingVariant = currentFramingVariant(defaultFramingForModel(model) ?? (chat ? undefined : "relay_batch"));
  let useToolAgent = chat && requestUsesAgent(model, !!hasTools);

  // A turn too long for M365 to keep goes up in parts (replay.ts): these are
  // sent ahead of `text`, which carries the request.
  let pendingParts: string[] = [];
  // The parts carry the whole history (formatWhole), not a long delta.
  let partsCarryHistory = false;
  const partsNote = () => (pendingParts.length > 0 ? `, parts=${pendingParts.length + 1}` : "");

  // Format message: full prompt on first turn, delta on follow-ups.
  // M365 is stateful — it remembers everything from prior turns,
  // so we only need to send new messages after the first turn.
  const isFirstTurn = session.turnCount === 0;
  const convId = session.conversationId;
  // Every prompt that carries the whole history in one turn (the opening, and
  // each re-send of it). A turn that sends one needs nothing from M365's memory;
  // any other turn, the last of a history sent in parts included, continues the
  // conversation and relies on M365 still holding it.
  const wholePrompts = new Set<string>();
  // The whole history for a fresh conversation, planned in parts when it's too
  // long for one turn (cut shorter once M365 has failed to keep a long opening
  // of this model's), with `then` after it.
  const formatWhole = (variant = framingVariant, then?: string | null): string => {
    const plan = planFullPrompt(body.messages, body.tools, body.tool_choice, session.conversationId, variant, turnLimit(pool, model, chat));
    pendingParts = plan.parts;
    partsCarryHistory = plan.parts.length > 0;
    const prompt = then ? `${plan.final}\n\n${then}` : plan.final;
    if (plan.parts.length === 0) wholePrompts.add(prompt);
    return prompt;
  };
  let text: string;
  // Images and files ride on the message that carries their text (core image-input.ts, file-upload.ts).
  let inputAttachments: string[];
  if (isFirstTurn || conv.sentMessageCount === 0) {
    text = formatWhole();
    inputAttachments = attachmentUrls(body.messages);
    const chars = pendingParts.reduce((n, p) => n + p.length, text.length);
    log.info(`Chat completion: model=${model}${chat ? "" : ` (${route.backend})`}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=full, chars=${chars}${partsNote()}, cid=${convId}`);
  } else {
    const newMessages = body.messages.slice(conv.sentMessageCount);
    inputAttachments = attachmentUrls(newMessages);
    const delta = newMessages.length > 0 ? formatDeltaMessages(newMessages, body.messages) : "";
    if (delta.length > 0) {
      text = delta;
      // Only a tool result is the thing the note corrects the model about.
      if (conv.pendingNote && newMessages.some((m) => m.role === "tool")) {
        text = `${conv.pendingNote}\n\n${delta}`;
        log.info("Prepended the only-the-first-call-ran note (last reply was partly executed)");
      }
      const plan = planText(text, turnLimit(pool, model, chat));
      pendingParts = plan.parts;
      text = plan.final;
      log.info(`Chat completion: model=${model}${chat ? "" : ` (${route.backend})`}, stream=${body.stream}, messages=${body.messages.length}, new=${newMessages.length}, turn=${session.turnCount}, mode=delta${partsNote()}, cid=${convId}`);
    } else {
      // No meaningful new content to send — nudge M365 to continue.
      text = "Please continue.";
      log.info(`Chat completion: model=${model}${chat ? "" : ` (${route.backend})`}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=retry, cid=${convId}`);
    }
  }
  conv.pendingNote = null; // one turn only: consumed above, or stale

  log.debug("Formatted prompt:", trunc(text, 1000));

  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // Buffer the full response, with a couple of quick retries on an empty reply.
  const MAX_RETRIES = 2;
  const SHORT_RETRY_DELAY_MS = 2_000;

  // Captured from the final attempt — surfaced through the OpenAI `usage` block
  // so clients can see M365's conversation-quota % (the closest proxy we have
  // to "context window remaining"). Token counts aren't exposed by M365.
  let lastThrottle: { current: number; max: number } | null = null;
  let lastContentOrigin: string | null | undefined;
  let lastMessageType: string | null | undefined;
  let lastScores: Record<string, number> | null | undefined;
  let lastTurnCount: number | null | undefined;
  let lastMetering: Record<string, number> | null | undefined;
  // What the agent runtime charged for this request's turns, in Copilot credits.
  let requestCredits: number | null = null;
  // The lost-history re-send in runBuffered, at most once per request: produce()'s
  // forcing and repair turns run it again, into the same conversation.
  let historyResent = false;
  // Parts went up in this request that the conversation keeps but the request
  // won't record as sent: a history's, or a refused part (see failedRequest in produce()).
  let partsWentUp = false;
  // How often this request has sent a long turn's parts: each time is n turns.
  let partsSends = 0;
  // The live stream's gate (set by the streaming render): whether any text has
  // reached the client, and a way to drop what it still holds back.
  let liveGate: { released: () => boolean; discard: () => void } | null = null;
  // The model's chain of thought, returned as `reasoning_content`: every turn's
  // in this request, in order, a retry's and a forcing turn's included (a long
  // turn's parts are only acknowledged, so not theirs). The streaming render
  // sets `liveReasoning` to send each piece as it arrives, tool turns included,
  // whose text is held back. M365_NO_REASONING=1 leaves it out.
  let reasoning = "";
  let liveReasoning: ((delta: string) => void) | null = null;
  const reasoningSink = (): ((delta: string) => void) | undefined => {
    if (process.env.M365_NO_REASONING) return undefined;
    let first = true;
    return (delta: string) => {
      if (!delta) return;
      if (first && reasoning) delta = `\n\n${delta}`;
      first = false;
      reasoning += delta;
      liveReasoning?.(delta);
    };
  };
  // M365_AVOID_THROTTLING=1: wait until the account's turn bucket can afford a
  // turn (turn-budget.ts, hypotheses §37). A pi session is one long thread, but
  // every turn in it draws on the same bucket as a bench sweep (F58), so a busy
  // enough session runs it dry and then sits out a throttle of about an hour.
  // Every upstream turn passes here, the forcing retries and a long turn's parts
  // included; run() calls the same wait before its reconnect. An unstreamed
  // request gets one allowance for all of them: its client gives up on headers
  // after 5 minutes.
  let budgetWaitedMs = 0;
  const waitForBudget = async (): Promise<{ waitedMs: number }> => {
    if (!chat) return { waitedMs: 0 }; // the agent runtime isn't under Chat's throttle
    const maxWaitMs = body.stream ? undefined : Math.max(0, UNSTREAMED_BUDGET_WAIT_LIMIT_MS - budgetWaitedMs);
    const waited = await awaitTurnBudget({ signal: opts.signal, maxWaitMs });
    budgetWaitedMs += waited?.waitedMs ?? 0;
    return waited;
  };

  /**
   * Send the parts of a turn too long for M365 to keep (replay.ts), each a turn
   * of its own that the model only acknowledges; nothing of them reaches the
   * client. Null once every part is acknowledged. Otherwise:
   * - "lost": a part found the conversation's history gone (with `checkLost`);
   * - `refused`: M365 didn't acknowledge a part (a failed or refused turn,
   *   Disengaged, an apology, a priority-access refusal), for runBuffered to
   *   judge like any turn: its fallbacks and retries apply to parts too;
   * - `error`: the request ends. The conversation is dropped for a fresh one
   *   when it may hold part of the turn: always for a history's parts, and for a
   *   long delta's once one of them went up.
   */
  async function sendParts(parts: string[], carriesHistory: boolean, checkLost: boolean): Promise<PartsOutcome> {
    for (let i = 0; i < parts.length; i++) {
      const label = `part ${i + 1} of ${parts.length + 1}`;
      // A delta's conversation still holds the whole history until one of its parts goes up.
      const drop = () => { if (carriesHistory || i > 0) session.newConversation(); };
      log.info(`Sending ${label} of a long turn (${parts[i].length} chars), cid=${session.conversationId}`);
      try {
        await waitForBudget();
      } catch (err: any) {
        drop();
        if (err instanceof TurnBudgetHold) return { error: turnBudgetHoldResponse(err) };
        return { error: jsonResponse(502, { error: { message: err.message, type: "upstream_error" } }) };
      }
      let stream: TurnStream;
      try {
        // The final turn's agent-ness: a change of it would open another M365 session (ModelSession.run).
        stream = await session.run(parts[i], model, opts.signal, useToolAgent, [], waitForBudget, turnOptions);
        for await (const _ack of stream) { /* acknowledged, not forwarded */ }
      } catch (err: any) {
        session.newConversation();
        if (err instanceof TurnBudgetHold) return { error: turnBudgetHoldResponse(err) };
        return { error: jsonResponse(502, { error: { message: err.message, type: "upstream_error" } }) };
      }
      if (opts.signal?.aborted) {
        session.newConversation();
        return { error: jsonResponse(499, { error: { message: "client closed the request", type: "client_closed" } }) };
      }
      log.info(`Reply to ${label}: ${JSON.stringify(trunc(stream.fullText ?? "", 120))}`);
      if (stream.result?.value === "Throttled") {
        noteOutcome(true, session.conversationId);
        drop(); // a throttled turn processed nothing
        log.info(`Upstream Throttled on ${label} (${stream.result.errorCode ?? "no errorCode"}) — 429, no retry`);
        return { error: throttledResponse(stream.result) };
      }
      if (
        (stream.result && stream.result.value !== "Success") || turnFailed(stream) ||
        stream.messageType === "Disengaged" || stream.apology || stream.contentOrigin === "Apology" ||
        priorityAccessExhaustionOf(stream.result, stream.fullText)
      ) {
        log.info(`M365 didn't acknowledge ${label} of a long turn (${stream.result?.value ?? "no result"}${stream.messageType ? `, ${stream.messageType}` : ""})`);
        return { refused: stream, label };
      }
      // Each part adds a message: a count of 1 on a long delta's first part, or
      // on any later part, means M365 no longer holds what came before (§46 F125).
      if (checkLost && conversationLost(stream) && (i > 0 || !carriesHistory)) return "lost";
    }
    return null;
  }

  // `onDelta` (when provided) forwards each text delta to the caller AS IT ARRIVES,
  // for live incremental streaming. It's safe to forward without ever retracting:
  // runBuffered only retries on an EMPTY attempt (Disengaged, dead-agent, throttle)
  // or one stopped before any of it was forwarded (a lost conversation), so a
  // forwarded delta always belongs to the one attempt that produced the answer and
  // is never re-sent by a subsequent retry.
  // `forcing` marks produce()'s forcing and repair turns: if M365 turns out to have
  // lost the conversation, their instruction follows the whole history re-sent.
  async function runBuffered(
    onDelta?: (delta: string) => void,
    { forcing = false }: { forcing?: boolean } = {},
  ): Promise<{ fullText: string } | { error: Response }> {
    let agentRefreshed = false;
    let disengageRetried = false;
    let agentFallbackDone = false;
    let webSearchFallbackDone = false;
    let priorityFallbackDone = false;
    let internalErrorFreshRetried = false;
    let originalText = text;
    const forcingPrompt = forcing ? text : null;
    // Self-imposed pacing while the account is degraded (thread-rate throttle). A
    // no-op when healthy; during backoff it sleeps a jittered delay so we stop
    // starting fresh turns into the throttle and let it self-heal (H-R1). This
    // replaced the old auto-reauth, which didn't clear the throttle and raised our
    // detection profile. A single long pi thread never trips the trigger.
    if (chat) await awaitDegradationBackoff();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // A <tool_response> the model writes after a real call is a stop sequence
      // (truncateAtFabricatedToolResponse), but the cut in produce() only runs
      // once M365 has finished the turn, and Sonnet 4.6 sometimes writes the rest
      // of the session after its call: minutes of invented output (45-69k chars),
      // long enough for pi's request timeout to fail the run (hypotheses §34). So
      // stop the turn once the invented tail runs past M365_EARLY_STOP_AFTER
      // chars (2,000 by default), the way a client's Stop does; the cut then keeps the head as
      // before. Not at the tag itself: M365 keeps the whole message in the
      // conversation, the model seems to follow a short tail as its plan, and
      // stopping at the tag cost Sonnet 4.6 (`claude-sonnet`, agent-less) 10%
      // more turns (§35 F89).
      // M365_NO_EARLY_STOP=1 waits for the turn to end instead.
      const earlyStop = hasTools && !process.env.M365_NO_EARLY_STOP ? new AbortController() : null;
      const stopAfter = earlyStopAfter();
      // An attempt that sends the whole history, in this one turn or in parts
      // ahead of it, opens the M365 conversation (or re-opens it). Not
      // `session.turnCount === 0`: a request that failed after its turn leaves a
      // count with nothing recorded as sent, so the next one sends the whole
      // history into that conversation, and refreshAgent() zeroes the count of a
      // conversation that goes on.
      const opening = wholePrompts.has(text) || (pendingParts.length > 0 && partsCarryHistory);
      if (opening) {
        // The longest turn that carries the history: M365 keeps a turn up to a size (§46 F125).
        conv.openingChars = pendingParts.reduce((n, p) => Math.max(n, p.length), text.length);
        conv.openingAnswered = false;
      }
      // A turn too long for M365 to keep: its parts go first, each a turn of its own.
      let refused: { refused: TurnStream; label: string } | null = null;
      if (pendingParts.length > 0) {
        const parts = pendingParts;
        const carriesHistory = partsCarryHistory;
        pendingParts = [];
        partsCarryHistory = false;
        const maxTurns = maxTurnParts();
        if (parts.length + 1 > maxTurns) {
          log.info(`A long turn needs ${parts.length + 1} M365 turns, over M365_MAX_TURN_PARTS (${maxTurns}) — 400`);
          return { error: tooManyPartsResponse(parts.length + 1, maxTurns) };
        }
        if (++partsSends > MAX_PARTS_SENDS) {
          log.info(`Not sending this long turn's ${parts.length} parts a third time — 502`);
          return { error: jsonResponse(502, { error: { message: "M365 Copilot failed this long conversation twice; its parts weren't sent a third time.", type: "upstream_error" } }) };
        }
        const sent = await sendParts(parts, carriesHistory, !historyResent);
        if (carriesHistory && sent !== "lost" && !(sent && "error" in sent)) partsWentUp = true;
        if (sent === "lost") {
          historyResent = true;
          if (opening || conv.openingAnswered) pool.noteUnkeptOpening(model, conv.openingChars);
          log.info(`M365 has lost this conversation's history (its longest turn was ${conv.openingChars} chars): re-sending the whole request in a fresh conversation`);
          session.newConversation();
          text = formatWhole(framingVariant, forcingPrompt);
          inputAttachments = attachmentUrls(body.messages);
          originalText = text;
          attempt--;
          continue;
        }
        if (sent && "error" in sent) return { error: sent.error };
        if (sent) refused = sent;
        else if (opening) conv.openingAnswered = true; // M365 took the history's parts
      }
      // Only a turn that carries the whole history itself needs nothing from
      // M365's memory. Any other turn, the last of a history sent in parts
      // included, relies on M365 still holding the conversation.
      const needsMemory = !refused && !wholePrompts.has(text);
      // Stops such a turn if M365 turns out to have lost the conversation
      // (below). Once the request has re-sent the history, a later turn runs as is.
      const lostStop = needsMemory && !historyResent ? new AbortController() : null;
      const signals = [opts.signal, earlyStop?.signal, lostStop?.signal].filter((s): s is AbortSignal => s !== undefined);
      const signal = signals.length <= 1 ? signals[0] : AbortSignal.any(signals);
      // A part M365 didn't acknowledge stands for this attempt's turn: the final
      // turn isn't sent, and the checks below judge the part instead.
      let copilotStream: TurnStream;
      if (refused) {
        copilotStream = refused.refused;
      } else {
        try {
          await waitForBudget();
          // Only attach the tool-calling agent when the request actually has tools.
          // The agent overrides `tone` (forces GPT-5), so tool-less requests must
          // skip it to reach the model the tone selects (e.g. Claude). See
          // ModelSession.run / docs H8.6.
          copilotStream = await session.run(text, model, signal, useToolAgent, inputAttachments, waitForBudget, { ...turnOptions, onReasoning: reasoningSink() });
        } catch (err: any) {
          if (err instanceof TurnBudgetHold) return { error: turnBudgetHoldResponse(err) };
          return { error: jsonResponse(502, { error: { message: err.message, type: "upstream_error" } }) };
        }
      }

      let fullText = "";
      let tagAt = -1; // where the invented <tool_response> starts, once seen
      let forwarded = false; // some of this attempt's text has reached the client
      if (!refused) try {
        for await (const delta of copilotStream) {
          if (lostStop?.signal.aborted) continue;
          // M365 has lost this conversation (see below). On StreamHub its message
          // count arrives ahead of the reply, so the turn stops before any of a
          // reply written without context reaches the client.
          if (lostStop && !forwarded && conversationLost(copilotStream)) {
            lostStop.abort();
            continue;
          }
          fullText += delta;
          if (onDelta) {
            onDelta(delta);
            forwarded = true;
          }
          if (!earlyStop || earlyStop.signal.aborted) continue;
          // Measured on the stream's composed text, which has the heads that
          // arrive only as snapshots (#29) — a fence's opening line among them.
          const sofar = (copilotStream.fullText?.length ?? 0) > fullText.length ? copilotStream.fullText! : fullText;
          // Look for the tag only when this delta (or its seam with the last one) can hold it.
          if (tagAt < 0 && /<tool_/i.test(fullText.slice(Math.max(0, fullText.length - delta.length - 16)))) {
            tagAt = fabricatedToolResponseAt(sofar, body.tools);
          }
          if (tagAt >= 0 && sofar.length - tagAt >= stopAfter) {
            log.info(`Model is writing its own <tool_response> after its call — stopping the turn ${sofar.length} chars in (tag at ${tagAt})`);
            earlyStop.abort();
          }
        }
        if (copilotStream.fullText && copilotStream.fullText.length > fullText.length) {
          fullText = copilotStream.fullText;
        }
      } catch (err: any) {
        return { error: jsonResponse(502, { error: { message: err.message, type: "upstream_error" } }) };
      }

      // Image gen (§14): the picture arrives on a GraphicArt frame, usually with NO
      // chat text — so an image turn looks empty to the checks below and would burn
      // a retry. Render the image(s) into the response instead, and (for streaming)
      // emit the markdown as a trailing delta so the client isn't left with nothing.
      // A part's images are no answer.
      const images = refused ? [] : copilotStream.images ?? [];
      if (images.length > 0) {
        const imageMd = await renderImagesMarkdown(images);
        if (imageMd) {
          const addition = fullText.length > 0 ? `\n\n${imageMd}` : imageMd;
          fullText += addition;
          onDelta?.(addition);   // stream the appended markdown (text deltas already sent)
        }
      }

      lastThrottle = copilotStream.throttle;
      lastContentOrigin = copilotStream.contentOrigin;
      lastMessageType = copilotStream.messageType;
      lastScores = copilotStream.scores;
      lastTurnCount = copilotStream.turnCount;
      lastMetering = copilotStream.metering;
      if (!refused && typeof copilotStream.credits === "number") {
        requestCredits = Math.round(((requestCredits ?? 0) + copilotStream.credits) * 1e6) / 1e6;
      }
      // The classifier scores reach clients only as `usage` extension fields,
      // which a gateway drops; experiments read them from the debug log instead.
      if (lastScores && Object.keys(lastScores).length > 0) {
        log.info(`Turn scores: ${Object.entries(lastScores).map(([k, v]) => `${k}=${v}`).join(" ")}${lastMessageType ? ` (${lastMessageType})` : ""}, cid=${session.conversationId}`);
      }
      // The chain of thought says why a model refused a framing (API doc §6).
      if (!refused && copilotStream.reasoning) {
        log.info(`Chain of thought (${copilotStream.reasoning.length} chars): ${JSON.stringify(trunc(copilotStream.reasoning, 400))}`);
      }

      // No text at all: the dead agent route's signature (below), unlike a failed
      // turn, which carries M365's canned apology.
      const empty = !copilotStream.hasContent && fullText.length === 0;
      // A failed turn's canned apology is no answer: below it counts as an empty
      // `InternalError`, which is re-sent in a fresh conversation, and isn't
      // returned as the model's reply.
      const failed = turnFailed(copilotStream);
      if (failed) {
        log.info(`Turn failed (InternalError, turnState Failed): ${JSON.stringify(trunc(fullText, 120))} is not an answer`);
        // What already reached the client can't be taken back, and a retry would add to it.
        if (liveGate?.released()) {
          return { error: jsonResponse(502, { error: { message: "M365 Copilot failed this turn after part of its reply had streamed (InternalError, turnState Failed).", type: "upstream_error" } }) };
        }
        liveGate?.discard(); // so the retry's answer streams live
        fullText = "";
      }
      // A part's reply is never the answer.
      const answered = !refused && !failed && !empty;

      // M365 SAYS when it throttles: the final item's result is `Throttled` /
      // `PerUserThrottled` (#35). Checked BEFORE the content check so
      // an apology that ever arrives as content can't pass for an answer. This
      // used to fall through to the empty-reply path below — two "quick retries"
      // straight back into the throttle, then a 502 blaming a content filter.
      // Fail fast with a 429 instead, and count it toward the degradation backoff.
      if (copilotStream.result?.value === "Throttled") {
        noteOutcome(true, convId);
        log.info(`Upstream Throttled (${copilotStream.result.errorCode ?? "no errorCode"}) — 429, no retry`);
        return { error: throttledResponse(copilotStream.result) };
      }

      // An agent-less turn carries the Bing plugin, and on some accounts that
      // alone pushes a tone over its input limit: GPT-6 and GPT-5.5 Think Deeper
      // refuse a one-line prompt with it and serve without it (§40). Remember
      // that for the process, and re-send the WHOLE request without the plugin
      // in a fresh conversation. At most once per request: a prompt that's
      // really too long then fails fast below.
      if (
        chat && !webSearchFallbackDone && !useToolAgent && toneUsesWebSearch(tone) &&
        copilotStream.result?.value === "InvalidRequest" &&
        copilotStream.result.errorCode === "InputTokenLimitExceeded"
      ) {
        webSearchFallbackDone = true;
        noteWebSearchOverflow(tone);
        session.newConversation();
        text = formatWhole();
        inputAttachments = attachmentUrls(body.messages);
        originalText = text;
        log.info(`${tone} refused the prompt with the Bing plugin attached (InputTokenLimitExceeded) — re-sending without it in a fresh conversation`);
        attempt--;
        continue;
      }

      // M365 rejects a prompt over the model's input limit outright: no content,
      // `result: InvalidRequest (InputTokenLimitExceeded)`. GPT-6.1 Sol did on every
      // Codex first turn, whose ~40k-character instructions Sonnet takes (§39).
      // Any retry re-sends the same prompt, so fail fast and say what to cut.
      if (copilotStream.result?.value === "InvalidRequest") {
        noteOutcome(false, convId);
        // The agent runtime keeps a refused message in the conversation, where it
        // would refuse the client's compacted retry too: start afresh.
        if (!chat) {
          session.newConversation();
          conv.sentMessageCount = 0;
          conv.lastReply = null;
        }
        log.info(`Upstream InvalidRequest (${copilotStream.result.errorCode ?? "no errorCode"}), prompt ${text.length} chars — 400, no retry`);
        return { error: invalidRequestResponse(copilotStream.result, model, text.length) };
      }

      // M365 has lost this conversation's history: on a turn that relies on it
      // (a follow-up, or the last of a history sent in parts) it counts the
      // message as the conversation's first. It does that after answering an
      // opening turn too long to keep: it kept a 420k-character opening and
      // dropped a 540k one, and the turn after a dropped opening had no context
      // (§46 F125). This reply was written without context, so re-send the WHOLE
      // request in a fresh conversation, once per request, with a forcing turn's
      // instruction after it. A long answered opening that was lost also teaches
      // the pool a size limit for this model: histories are then sent in parts
      // cut under it (turnLimit), and one that opened past it is replayed.
      // If the reply has already streamed (plain text, the count arriving after
      // it), the next request replays instead.
      if (needsMemory && !historyResent && conversationLost(copilotStream)) {
        historyResent = true;
        if (conv.openingAnswered) pool.noteUnkeptOpening(model, conv.openingChars);
        if (forwarded) {
          conv.replayNext = true;
          log.info(`M365 has lost this conversation's history (it opened with ${conv.openingChars} chars); the reply has already streamed, so the next request replays the whole history`);
        } else {
          log.info(`M365 has lost this conversation's history (it opened with ${conv.openingChars} chars): re-sending the whole request in a fresh conversation`);
          session.newConversation();
          text = formatWhole(framingVariant, forcingPrompt);
          inputAttachments = attachmentUrls(body.messages);
          originalText = text;
          attempt--;
          continue;
        }
      }

      // A tone whose agent route serves only on a premium account came back as
      // the dead route (`InternalError`, no content): this account isn't
      // premium. Remember that for the process, and re-send the WHOLE request
      // agent-less in a fresh conversation — the dead turn processed nothing, and
      // a delta would have no context. Free retry, at most once per request; the
      // next request on this tone goes agent-less from the start. Never under
      // M365_FORCE_AGENT=1, which asked for the agent regardless.
      // A premium account produces the identical wire state as a one-off
      // transient (§23), so once the agent has answered for this tone the
      // InternalError falls through to the ordinary empty-reply handling below
      // instead (isAgentRouteAlive).
      if (
        useToolAgent && !agentFallbackDone &&
        PREMIUM_ONLY_AGENT_TONES.has(tone) &&
        !isAgentRouteAlive(tone) &&
        process.env.M365_FORCE_AGENT !== "1" &&
        copilotStream.result?.value === "InternalError" &&
        empty
      ) {
        agentFallbackDone = true;
        noteAgentRouteDead(tone);
        useToolAgent = false;
        session.newConversation();
        text = formatWhole();
        inputAttachments = attachmentUrls(body.messages);
        originalText = text;
        log.info(`Agent route dead for ${tone} (InternalError) — this account isn't premium; re-sending agent-less with '${framingVariant}' framing in a fresh conversation`);
        attempt--;
        continue;
      }

      // A priority-access cap (Opus 5.5, Sonnet 5.5) arrives as a turn whose
      // text is a refusal ("You've used your available priority access…") and
      // whose final result is `OutOfCredits` (§24 F55). Left alone, the client
      // would receive a refusal dressed as an answer — the same hazard class as
      // the image-quota text (§14 H14.4). Surface it as a 429 with the reset
      // time instead, or, when the budget's fallback model is set
      // (M365_OPUS_FALLBACK_MODEL / M365_SONNET_FALLBACK_MODEL), re-send the
      // whole request to that model in a fresh conversation (issue #18). Either
      // way remember it, so the next requests don't spend M365 turns on
      // refusals until the reset.
      // A part M365 refused carries its refusal text on the part's own stream.
      const exhausted = chat && priorityAccessExhaustionOf(copilotStream.result, refused ? copilotStream.fullText : fullText);
      if (exhausted) {
        const budget = meteredBudgetOf(model);
        if (budget || copilotStream.result?.value === "OutOfCredits") notePriorityAccessExhausted(budget ?? model, exhausted);
        const fallback = budget && !priorityFallbackDone ? priorityAccessFallbackModel(budget) : null;
        if (fallback) {
          priorityFallbackDone = true;
          log.info(`Priority access exhausted (${exhausted.window}) — re-sending to ${fallback} (${PRIORITY_ACCESS_FALLBACK_ENV[budget!]}) in a fresh conversation`);
          model = fallback;
          tone = getToneForModel(model);
          framingVariant = currentFramingVariant(defaultFramingForModel(model));
          useToolAgent = requestUsesAgent(model, !!hasTools);
          session.newConversation();
          text = formatWhole();
          inputAttachments = attachmentUrls(body.messages);
          originalText = text;
          attempt--;
          continue;
        }
        noteOutcome(false, convId); // an answer, not a throttle
        log.info(`Priority access exhausted (${exhausted.window}) — resets ${exhausted.resetsAt.toISOString()}`);
        return { error: priorityAccessResponse(exhausted, model) };
      }

      // M365's prompt filter can answer with a canned apology instead of a
      // Disengaged message: contentOrigin "Apology", "Sorry, it looks like I can't
      // chat about this. Let's try a different topic." GPT-5.6 Think Deeper did on
      // a benign Codex edit task (§39). It is F22's refusal with text, and it
      // reached the client as the model's answer. The final item restates that
      // message under another origin, so read the turn's sticky `apology` flag.
      // Retry it like a Disengage, once, in a fresh conversation; a second apology
      // goes through as before. Tool requests only: they're buffered, so nothing
      // has been streamed yet.
      if (
        (copilotStream.apology || copilotStream.contentOrigin === "Apology") &&
        hasTools && !disengageRetried && !process.env.M365_NO_DISENGAGE_RETRY
      ) {
        disengageRetried = true;
        session.newConversation();
        const retryVariant = transcriptStyleForVariant(framingVariant).framingTag === "system" ? "softened" : framingVariant;
        text = formatWhole(retryVariant);
        inputAttachments = attachmentUrls(body.messages);
        log.info(`Upstream Apology (prompt filter) — retrying once with '${retryVariant}' framing in a fresh conversation (F22)`);
        attempt--; // free retry; bounded — disengageRetried flips once
        continue;
      }

      if (answered) {
        noteOutcome(false, convId); // clean response → degradation has lifted
        if (useToolAgent) noteAgentRouteAlive(tone); // the agent route answered on this account
        if (opening) conv.openingAnswered = true;
        conv.servedModel = model;
        inputAttachments = []; // on the server now: a forcing retry in this conversation needn't resend them
        return { fullText };
      }

      // Disengaged is a deliberate safety refusal, NOT a transient empty. Retrying
      // it with "Please continue." just disengages again and burns the 600-msg
      // quota (observed: 5 wasted messages in one turn). Fail fast with a clear
      // signal instead. Commonly fires when a heavy tool prompt is paired with a
      // non-default model/agent (e.g. a Claude tone + the declarative agent).
      if (copilotStream.messageType === "Disengaged") {
        // F22: the default framing's override-shape language occasionally trips Azure
        // Prompt Shields (jailbreak classifier) on benign requests (e.g. "replace X
        // with Y, leave everything else unchanged"). Retry ONCE with the low-override
        // `softened` framing in a FRESH conversation (a Disengaged conversation stays
        // Disengaged). Drops the worst-case disengage ~100%→~4%. Off via
        // M365_NO_DISENGAGE_RETRY.
        if (hasTools && !disengageRetried && !process.env.M365_NO_DISENGAGE_RETRY) {
          disengageRetried = true;
          session.newConversation();
          // `softened` is the low-override twin of the `<system>`-tagged framings.
          // A variant that deliberately avoids `<system>` tags (Claude Sonnet's
          // `relay`) keeps itself: swapping to `softened` would reintroduce
          // exactly the tag that model reads as a forged system prompt.
          const retryVariant = transcriptStyleForVariant(framingVariant).framingTag === "system" ? "softened" : framingVariant;
          text = formatWhole(retryVariant);
          inputAttachments = attachmentUrls(body.messages);
          log.info(`Upstream Disengaged — retrying once with '${retryVariant}' framing in a fresh conversation (F22)`);
          attempt--; // free retry; bounded — disengageRetried flips once
          continue;
        }
        log.info("Upstream Disengaged — failing fast (no retry) to preserve quota");
        return {
          error: jsonResponse(502, {
            error: {
              message: "M365 Copilot disengaged from this request (its safety filter declined to answer). Common causes: too many tools, jailbreak-shaped instructions, or pairing a non-default model with the tool agent. Reduce the toolset or use the default model.",
              type: "disengaged",
            },
          }),
        };
      }

      // A content-less `InternalError` is a turn M365 dropped, and the
      // conversation it happened in tends to stay dropped: "Please continue."
      // into it came back `InternalError` again in 9 of 18 retries, against
      // 28 of 89 turns overall (Gpt_6_Sol_Reasoning on a non-premium account,
      // T3 Code driving Claude Code, 2026-10-14). The turn processed nothing,
      // so a "continue" has nothing to continue from either: re-send the
      // WHOLE request once in a fresh conversation instead. Not a free retry: it
      // spends an attempt, so a tone that fails every time still ends at the
      // premium-only / empty-response handling below. A premium-only model's
      // InternalError is deterministic (§24), so it skips straight there.
      if (
        !internalErrorFreshRetried &&
        copilotStream.result?.value === "InternalError" &&
        !answered &&
        !(chat && isPremiumOnlyModel(model)) &&
        attempt < MAX_RETRIES
      ) {
        internalErrorFreshRetried = true;
        session.newConversation();
        text = formatWhole();
        inputAttachments = attachmentUrls(body.messages);
        originalText = text;
        log.info(`Upstream InternalError — re-sending the whole request in a fresh conversation (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
        continue;
      }

      // A turn that failed again after its fresh re-send: for GPT-6.x usually a
      // prompt over its input limit (§47 F128), which no "continue" fixes. Not a
      // throttle, so it doesn't feed the degradation backoff.
      if (failed && internalErrorFreshRetried) {
        noteOutcome(false, convId);
        log.info("Turn failed again after a fresh re-send — 502, no more retries");
        const failure = chat
          ? "M365 Copilot failed this turn twice (InternalError, turnState Failed). For GPT-6.x that is usually a prompt over its input limit (about 272k tokens): compact the conversation."
          : `M365 Copilot's agent runtime (${route.backend}) failed this turn twice (${copilotStream.result?.errorCode ?? "no error code"}${copilotStream.result?.message ? `: ${copilotStream.result.message}` : ""}).`;
        return { error: jsonResponse(502, { error: { message: failure, type: "upstream_error" } }) };
      }

      // A part M365 didn't acknowledge, and none of the above recovers it. It
      // can't be continued: the conversation holds part of a turn (failedRequest).
      if (refused) {
        partsWentUp = true;
        const why = `${copilotStream.result?.value ?? "no result"}${copilotStream.messageType ? `, ${copilotStream.messageType}` : ""}`;
        log.info(`M365 didn't acknowledge ${refused.label} of a long turn (${why}) — 502`);
        return { error: jsonResponse(502, { error: { message: `M365 Copilot didn't acknowledge ${refused.label} of this long conversation (${why}).`, type: "upstream_error" } }) };
      }

      // Empty response. Only an at-limit throttle warrants treating this as rate
      // limiting; otherwise it's a different failure (content filter, an invalid
      // agent/session, a transient upstream error) where a long escalating
      // backoff is futile and reads as a silent hang. Fail fast after a couple of
      // quick retries instead.
      const t = copilotStream.throttle;
      if (t && t.current >= t.max) {
        return { error: rateLimitResponse(t) };
      }
      // On the agent runtime an empty reply isn't Chat's transient: its own agent
      // worked in its cloud workspace instead of answering (Code's does, Nov 19),
      // and each "Please continue." re-ran a minutes-long, credit-charged turn
      // that came back empty again. Say so instead.
      if (!chat) {
        log.info(`Agent runtime (${route.backend}) turn had no reply text (${copilotStream.agentToolCalls ?? 0} tool calls of its own) — 502, no retry`);
        return { error: runtimeEmptyResponse(route.backend, copilotStream.agentToolCalls ?? 0) };
      }
      if (attempt < MAX_RETRIES) {
        // A dead/deleted agent returns an instant empty reply (throttle: null).
        // Re-resolve the agent once before retrying so a long-lived host
        // self-heals from the deleted-agent trap instead of looping on empties.
        if (!agentRefreshed) {
          agentRefreshed = true;
          const agentChanged = await session.refreshAgent();
          if (agentChanged) {
            // The cached agent was stale/deleted and has been re-resolved.
            // Resend the original prompt to the fresh agent — a bare "continue"
            // would have no context since the dead agent processed nothing.
            log.info("Agent re-resolved after empty reply, resending original prompt");
            text = originalText;
            await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
            continue;
          }
        }
        log.info(`Empty upstream response, quick retry in ${SHORT_RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
        text = "Please continue."; // M365 already has context
      } else {
        // A model served only on a premium account, on a non-premium one (Opus
        // 4.8: BotConnection, `InternalError`, every time, with the agent and
        // without — §24, §36). Not a throttle, so it doesn't feed the degradation
        // backoff; say what it is instead of "empty response".
        if (chat && isPremiumOnlyModel(model) && copilotStream.result?.value === "InternalError") {
          log.info(`${model}: InternalError on every attempt — premium-only model on a non-premium account?`);
          return { error: premiumOnlyModelResponse(model) };
        }
        // Final empty after retries, and not an at-limit (per-conversation) cap:
        // this is the thread-rate throttle signature (F13). Feed the degradation-
        // backoff policy — once empties span enough distinct conversations it paces
        // subsequent turns so the account can self-heal (H-R1). Never blocks this request.
        noteOutcome(true, convId);
        return { error: emptyResponseResponse(t) };
      }
    }
    noteOutcome(true, convId);
    return { error: emptyResponseResponse(null) };
  }

  // Produce the final turn result as DATA (not a Response), so the same logic
  // renders as either JSON (non-stream) or an early-flushed SSE stream (stream).
  // For streaming we return the SSE stream FIRST and run produce() INSIDE it, so the
  // client gets HTTP 200 + a role chunk + heartbeats immediately instead of waiting
  // out the whole (up to ~160s) M365 turn and risking a read-timeout.
  type Produced =
    | { kind: "error"; resp: Response }
    | { kind: "text"; text: string }
    | { kind: "tools"; toolCalls: ReturnType<typeof parseToolCalls>["toolCalls"] };

  // `onDelta` streams text to the client live (non-tool path only — see produce's
  // caller). Tool mode ignores it: the raw text is parsed for tool-call fences and
  // can't be shown verbatim, so it stays fully buffered.
  async function produce(onDelta?: (delta: string) => void): Promise<Produced> {
  // A request that fails after a history's parts went up leaves M365 holding a
  // history it never recorded as sent; the client's retry would put a second
  // copy into the same conversation. Start the next request afresh instead.
  const failedRequest = (resp: Response): Produced => {
    if (partsWentUp) {
      session.newConversation();
      conv.sentMessageCount = 0;
      conv.lastReply = null;
    }
    return { kind: "error", resp };
  };
  // When tools are present, buffer full response to detect tool calls
  if (hasTools) {
    // A <tool_response> the model wrote itself is a stop sequence: everything
    // after it is an invented result (see truncateAtFabricatedToolResponse).
    // `cutFabricated` reflects the attempt whose text is finally used.
    let cutFabricated = false;
    let droppedCalls = 0;
    const stopAtFabricatedResult = (raw: string): string => {
      const cut = truncateAtFabricatedToolResponse(raw, body.tools);
      cutFabricated = cut !== raw;
      if (cutFabricated) log.info(`Model wrote its own <tool_response> — cut ${raw.length - cut.length} fabricated chars (stop sequence)`);
      return cut;
    };
    const result = await runBuffered();
    if ("error" in result) return failedRequest(result.error);
    conv.sentMessageCount = body.messages.length;
    let fullText = stopAtFabricatedResult(result.fullText);

    log.debug("Raw response (tool mode):", trunc(fullText, 1000));
    let { parsed, judged } = parseReply(fullText, body.tools);
    log.info(`Parse result: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);

    // The reply tried to call a tool, but the call couldn't be read: ask for it
    // once more, saying what was wrong, before any give-up handling (§51 F152).
    // Transport/filter retries (Bing overflow, Apology, Disengaged) already ran
    // inside runBuffered above; the forcing retry below is skipped after this
    // re-ask, while strippedTypeMember still guards any PowerShell call it
    // returns. Off with M365_NO_FENCE_RETRY=1.
    const unreadable = parsed.hasToolCalls || process.env.M365_NO_FENCE_RETRY ? null : unreadableToolCall(fullText, body.tools);
    if (unreadable) {
      log.info(`A \`\`\`${unreadable.name} call couldn't be read (${unreadable.reason}) — asking for it again`);
      text = unreadableCallPrompt(unreadable);
      const retry = await runBuffered(undefined, { forcing: true });
      if ("error" in retry) return failedRequest(retry.error);
      conv.sentMessageCount = body.messages.length;
      fullText = stopAtFabricatedResult(retry.fullText);
      ({ parsed, judged } = parseReply(fullText, body.tools));
      log.info(`After asking again: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);
    }

    // Salvage stochastic turn-1 confabulation: M365's chat model sometimes claims it
    // "can't access the files / commands return no output" and asks the user to paste
    // them, WITHOUT calling a tool — even though the environment is real (the bench +
    // pi both reproduce this). Re-prompt forcefully in the SAME conversation (one
    // thread, cheap). Disable with M365_NO_CONFAB_RETRY; tune count with M365_CONFAB_RETRIES.
    const maxConfabRetries = process.env.M365_NO_CONFAB_RETRY
      ? 0
      : Number(process.env.M365_CONFAB_RETRIES ?? 1);
    // The model never actually acted if no assistant turn in the history carried a
    // tool call. Used to gate the hallucinated-completion retry (a model that did
    // real work called at least one tool), keeping false positives near zero.
    const everActed = (body.messages ?? []).some(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    // Not after asking again: the model was just told it could reply without the
    // call, and a forcing retry would override the answer it gave to that.
    for (let attempt = 0; attempt < (unreadable ? 0 : maxConfabRetries) && !parsed.hasToolCalls; attempt++) {
      const confab = looksLikeConfabulation(judged);
      const remoteArtifact = looksLikeRemoteArtifactCompletion(parsed.textContent);
      const halluc = !everActed && looksLikeHallucinatedCompletion(judged);
      if (!confab && !remoteArtifact && !halluc) break;
      const retryKind = remoteArtifact ? "Remote artifact completion" : confab ? "Confabulation" : "Hallucinated completion";
      log.info(`${retryKind} detected (no tool call) — forcing retry ${attempt + 1}/${maxConfabRetries}`);
      text = recoveryPrompt(body, remoteArtifact ? "remote" : confab ? "confab" : "halluc", everActed);
      const retry = await runBuffered(undefined, { forcing: true });
      if ("error" in retry) return { kind: "error", resp: retry.error };
      conv.sentMessageCount = body.messages.length;
      fullText = stopAtFabricatedResult(retry.fullText);
      ({ parsed, judged } = parseReply(fullText, body.tools));
      log.info(`After forcing retry: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);
    }

    // Never pass a remote M365 artifact off as a successful local edit. A retry
    // may merely transform a Teams URL into `sandbox:/mnt/data/...`; once the
    // configured attempts are exhausted, fail explicitly so the harness/user can
    // switch models instead of applying a nonexistent local file.
    //
    // Judge the FINAL text, not a sticky flag from the first attempt: a retry that
    // replaces the bogus mutation claim with a genuine answer ("I need the file
    // path first") has fixed the problem, and 502-ing it would be a regression.
    if (!parsed.hasToolCalls && looksLikeRemoteArtifactCompletion(parsed.textContent)) {
      log.info("Remote-artifact mutation claim persisted without a local tool call after forcing retries — failing closed");
      return {
        kind: "error",
        resp: jsonResponse(502, {
          error: {
            message: "M365 returned a remote Teams or /mnt/data artifact instead of calling the local editing tools. No local file was changed. Retry with gpt-5.5-think-deeper, the recommended model for tool calling.",
            type: "file_mutation_without_local_tool",
          },
        }),
      };
    }

    // M365's post-processing can strip a `[Type]:` out of a PowerShell command
    // that the deltas couldn't restore (a short reply arrives only as its final
    // snapshot): `$new = :Replace($old, …)` sets `$new` to nothing and the
    // `Set-Content` after it empties the file — Codex's in-place edits lost the
    // file 4 times in 4 that way (§40 F111). Don't run such a command: ask once,
    // in the same conversation, for it with full type names. If it comes back
    // damaged again, fail closed.
    const damaged = parsed.hasToolCalls ? strippedTypeMember(parsed.toolCalls[0], body.tools) : null;
    if (damaged) {
      log.info(`PowerShell command lost a [Type]: before ${damaged} to M365's post-processing — not running it, asking for it again`);
      text = strippedTypeMemberPrompt(damaged);
      const retry = await runBuffered(undefined, { forcing: true });
      if ("error" in retry) return { kind: "error", resp: retry.error };
      conv.sentMessageCount = body.messages.length;
      fullText = stopAtFabricatedResult(retry.fullText);
      ({ parsed, judged } = parseReply(fullText, body.tools));
      const still = parsed.hasToolCalls ? strippedTypeMember(parsed.toolCalls[0], body.tools) : null;
      log.info(`After the damaged-command retry: hasToolCalls=${parsed.hasToolCalls}, damaged=${still ?? "no"}`);
      if (still) {
        return {
          kind: "error",
          resp: jsonResponse(502, {
            error: {
              message: `M365 Copilot stripped a .NET type name from the PowerShell command twice (it arrived as \`${still}\`), so it was not run: run as written it would have done nothing, or emptied a file. Retry; asking for full type names such as [System.Text.RegularExpressions.Regex]::Replace usually avoids it.`,
              type: "damaged_tool_call",
            },
          }),
        };
      }
    }

    // Fail-closed: if model mixed text with tool calls, strip text and re-prompt once.
    // This enforces the "output ONLY a tool call" contract.
    if (parsed.hasToolCalls && parsed.textContent) {
      const extraText = parsed.textContent.trim();
      if (extraText.length > 0) {
        log.info(`Mixed output detected (${extraText.length} chars of text alongside ${parsed.toolCalls.length} tool calls), stripping text`);
        // Strip the text — the tool calls are what the client needs.
        // Log the stripped text for debugging but don't send it downstream.
        log.debug("Stripped text:", trunc(extraText, 500));
        parsed = { ...parsed, textContent: null };
      }
    }

    // Handle "reply" tool calls — convert to plain text
    if (parsed.hasToolCalls) {
      const replyCall = parsed.toolCalls.find(tc => tc.function.name === "reply");
      const realToolCalls = parsed.toolCalls.filter(tc => tc.function.name !== "reply");

      if (replyCall && realToolCalls.length === 0) {
        let replyText: string;
        try {
          const args = JSON.parse(replyCall.function.arguments);
          replyText = args.text || args.message || args.content || fullText;
        } catch {
          replyText = fullText;
        }
        log.info("Reply tool detected, converting to text response");
        return { kind: "text", text: replyText };
      }

      if (realToolCalls.length > 0) {
        parsed.toolCalls = realToolCalls;
      }

      // Enforce one tool call per turn unless explicitly opted out. M365 — the
      // reasoning tones especially — batches its whole plan into a single
      // response. Executing a batch runs later steps on guessed state and lets a
      // premature success claim ride along at the end. Keeping only the first
      // call forces a real step-by-step loop where each call reacts to the
      // previous tool_response. Set M365_ALLOW_MULTI_TOOL to restore batching.
      if (!process.env.M365_ALLOW_MULTI_TOOL && parsed.toolCalls.length > 1) {
        log.info(`One-call-per-turn: keeping ${parsed.toolCalls[0].function.name}, dropping ${parsed.toolCalls.length - 1} batched call(s)`);
        droppedCalls = parsed.toolCalls.length - 1;
        parsed.toolCalls = [parsed.toolCalls[0]];
      }
    }

    if (parsed.hasToolCalls && parsed.toolCalls.length > 0) {
      // A heredoc file write past the Windows command-line cap would reach the
      // shell cut short; run the same write through the harness's write tool.
      const asWrite = longHeredocAsWrite(parsed.toolCalls[0], body.tools);
      let rewriteNote: string | null = null;
      if (asWrite) {
        log.info(`Heredoc write to ${asWrite.path} is over the Windows command-line cap — sent as ${asWrite.call.function.name} instead`);
        parsed.toolCalls = [asWrite.call];
        rewriteNote = `(Note: your heredoc to \`${asWrite.path}\` was longer than the ~8,000-character Windows command-line limit and would have been cut off, so it was written with the \`${asWrite.call.function.name}\` tool instead.${asWrite.skipped ? ` The commands after the heredoc did NOT run: \`${asWrite.skipped.slice(0, 200)}\`.` : ""})`;
      }
      // The model's server-side history holds more than what runs; say so on
      // the turn that carries the real result (executedOnlyFirstNote).
      const notes = [rewriteNote, executedOnlyFirstNote(cutFabricated, droppedCalls, textAfterFirstToolCall(fullText, body.tools).length)].filter(Boolean);
      conv.pendingNote = notes.length ? notes.join("\n") : null;
      const fixed = parsed.toolCalls.map((c) => millisecondArgsFixed(c, body.tools));
      if (fixed.some((c, i) => c !== parsed.toolCalls[i])) log.info("A millisecond argument under 1000 read as seconds (e.g. Bash timeout: 30)");
      return { kind: "tools", toolCalls: fixed };
    }
    return { kind: "text", text: plainFileNames(fullText) };
  } else {
    // No tools — stream deltas live (onDelta) while buffering for the retry logic.
    const result = await runBuffered(onDelta);
    if ("error" in result) return failedRequest(result.error);
    conv.sentMessageCount = body.messages.length;
    return { kind: "text", text: result.fullText };
  }
  } // end produce()

  // The turn holds its conversation until it ends, so a request from another
  // session that opened with the same message can't join it mid-turn (resolve).
  // Both renders below call this synchronously after resolve(): nothing slips in.
  //
  // On the agent runtime a message stays in its conversation once it's posted,
  // answered or not, so the client's retry of a failed request (the same history
  // again) went in on top of it: Codex re-sent one 537,804-character request into
  // one Code conversation seven times (§48 F140). Start the next request in a
  // fresh conversation; the old one is deleted (AetherSession.discard), which
  // also ends a run still going there. Meanwhile the pool keeps the conversation
  // however long the request runs, and its idle time counts from the end.
  async function produceTurn(onDelta?: (delta: string) => void): Promise<Produced> {
    conv.activeRequests++;
    let failed = true;
    try {
      const p = await produce(onDelta);
      failed = p.kind === "error";
      if (p.kind !== "error") conv.lastReply = p.kind === "tools" ? p.toolCalls.map((c) => c.id).join(" ") : p.text.trim();
      return p;
    } finally {
      conv.activeRequests--;
      conv.lastAccessedAt = Date.now();
      if (failed && !chat && session.turnCount > 0) {
        log.info(`Agent runtime (${route.backend}) request failed: the next one starts a fresh conversation`);
        session.newConversation();
        conv.sentMessageCount = 0;
        conv.lastReply = null;
      }
    }
  }

  // --- Render: JSON (non-stream) or an early-flushed SSE stream (stream) ---
  const includeUsage = !!body.stream_options?.include_usage;
  const errorsAsText = streamErrorsAsText(opts.userAgent);
  // Estimated token counts (usage.ts): the whole request as the model reads it,
  // and the reply.
  let promptTokens: number | undefined;
  const usage = (reply: string) => {
    const tokens = reportsUsage()
      ? {
        prompt: (promptTokens ??= estimateTokens(formatMessages(body.messages, body.tools, body.tool_choice, undefined, framingVariant))),
        completion: estimateTokens(reply),
      }
      : undefined;
    return buildUsage(lastThrottle, lastContentOrigin, lastMessageType, lastScores, lastTurnCount, lastMetering, tokens, requestCredits);
  };
  // The ID the client asked for (suffixes and all), unless a fallback model answered.
  const responseModel = () => (model === route.model ? request.model : model);
  const callsText = (calls: { function: { name: string; arguments: string } }[]) =>
    calls.map((c) => `${c.function.name} ${c.function.arguments}`).join("\n");

  if (!body.stream) {
    const p = await produceTurn();
    if (p.kind === "error") return p.resp;
    const thought = reasoning ? { reasoning_content: reasoning } : {};
    if (p.kind === "tools") {
      return jsonResponse(200, {
        id: completionId, object: "chat.completion", created, model: responseModel(),
        choices: [{ index: 0, message: { role: "assistant", content: null, ...thought, tool_calls: p.toolCalls }, finish_reason: "tool_calls" }],
        usage: usage(callsText(p.toolCalls)),
      });
    }
    return jsonResponse(200, {
      id: completionId, object: "chat.completion", created, model: responseModel(),
      choices: [{ index: 0, message: { role: "assistant", content: p.text, ...thought }, finish_reason: outputFinishReason(p.text, chat) }],
      usage: usage(p.text),
    });
  }

  // Streaming: send HTTP 200 + a role chunk + keepalive comments from t=0, then run
  // produce() INSIDE the stream so the client never waits out the whole M365 turn
  // (up to ~160s) before the first byte — avoids client read-timeouts.
  //
  // On the non-tool path we forward each text delta AS IT ARRIVES (`liveDelta`), so
  // `stream:true` is genuinely incremental. Tool mode still buffers: the raw text is
  // parsed for tool-call fences and can't be shown verbatim, so its tool_calls (or a
  // prose fallback) are emitted once at the end.
  return sseResponse(new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const base = { id: completionId, object: "chat.completion.chunk", created, model: responseModel() };
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      // Keepalive: a REAL empty-delta chunk, not an SSE comment. Agents that track
      // stream liveness by data chunks (e.g. Hermes: comments don't reset its
      // `last_chunk_time`, so a silent turn shows "N s without stream output" and can
      // trip its stale watchdog) see this as activity. No content is added — an empty
      // delta contributes nothing to the assembled message.
      const hb = setInterval(() => {
        try { send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: null }] }); } catch {}
      }, 15000);
      // The chain of thought goes out as it arrives (pi and opencode read
      // `reasoning_content` as thinking), on tool turns too.
      liveReasoning = (delta: string) => {
        try { send({ ...base, choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }] }); } catch {}
      };

      // Live token passthrough (non-tool only). Track exactly what we've sent so the
      // final render emits only the not-yet-streamed remainder. session.ts guarantees
      // every forwarded delta extends the answer, so `sent` is always a prefix of the
      // final text — the remainder is a clean tail, never a duplicate.
      let sent = "";
      // Hold the head of the stream until it can't be a priority-access refusal
      // (Opus quota, §15): those arrive as ordinary content, so forwarding them
      // live would put the refusal in front of the client before the 429 that
      // replaces it — delivering exactly the confusion the 429 prevents. The
      // gate releases within ~45 chars, i.e. one short delta on a normal turn.
      // A failed turn's canned apology (turnFailed) is held back the same way.
      let head = "";
      let gated = true;
      const liveDelta = hasTools ? undefined : (delta: string) => {
        if (!delta) return;
        if (gated) {
          head += delta;
          if (couldBePriorityAccessPrefix(head) || couldBeFailedTurnText(head)) return; // still undecided — keep buffering
          gated = false;
          delta = head; // release everything held so far, in order
        }
        sent += delta;
        try { send({ ...base, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] }); } catch {}
      };
      // A failed turn's text is dropped (runBuffered): the gate starts over for the retry.
      if (liveDelta) liveGate = { released: () => sent.length > 0, discard: () => { if (gated) head = ""; } };

      let p: Produced;
      try { p = await produceTurn(liveDelta); }
      catch (err: any) { p = { kind: "error", resp: jsonResponse(502, { error: { message: err?.message ?? "stream error", type: "upstream_error" } }) }; }
      clearInterval(hb);
      try {
        if (p.kind === "error") {
          let message = "upstream error";
          let type = "upstream_error";
          let code: string | undefined;
          // Carry the structured fields through, not just the prose: a streaming
          // client still has to tell a priority-access wall (back off until the
          // reset) from a transient upstream failure (retry now), and the status
          // code it would have read is gone once HTTP 200 is committed.
          try {
            const parsed = JSON.parse(await p.resp.text())?.error;
            if (parsed?.message) message = parsed.message;
            if (parsed?.type) type = parsed.type;
            if (parsed?.code) code = parsed.code;
          } catch {}
          const retryAfter = p.resp.headers.get("Retry-After");
          if (errorsAsText) {
            // An agent harness behind a gateway can't read an error chunk and
            // would retry into fresh conversations: end the turn with the reason.
            const reason = streamErrorText({ message, type, code, retryAfter: retryAfter ? Number(retryAfter) : undefined });
            send({ ...base, choices: [{ index: 0, delta: { content: (sent ? "\n\n" : "") + reason }, finish_reason: null }] });
            send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(includeUsage ? { usage: usage(sent + reason) } : {}) });
          } else {
            // HTTP 200 is already committed, so surface the failure as an in-stream error chunk.
            send({ ...base, error: { message, type, ...(code ? { code } : {}), ...(retryAfter ? { retry_after: Number(retryAfter) } : {}) } });
          }
        } else if (p.kind === "tools") {
          p.toolCalls.forEach((tc, i) => {
            log.debug(`Tool call: ${tc.function.name} ${trunc(tc.function.arguments, 200)}`);
            send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] });
          });
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], ...(includeUsage ? { usage: usage(callsText(p.toolCalls)) } : {}) });
        } else {
          // Emit only what wasn't already streamed live: the whole text if nothing was
          // (tool-mode prose fallback, or a fully-buffered turn), or just the tail when
          // live deltas already covered a prefix. If `sent` somehow isn't a prefix of
          // the final text (a divergent snapshot upstream chose not to stream), fall
          // back to sending nothing more rather than duplicating already-sent bytes.
          const remainder = p.text.startsWith(sent) ? p.text.slice(sent.length) : "";
          if (!p.text.startsWith(sent)) log.info(`Streamed prefix diverged from final text (sent ${sent.length}, final ${p.text.length} chars) — not re-sending to avoid duplication`);
          if (remainder) send({ ...base, choices: [{ index: 0, delta: { content: remainder }, finish_reason: null }] });
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: outputFinishReason(p.text, chat) }], ...(includeUsage ? { usage: usage(p.text) } : {}) });
        }
      } catch {
        // client likely disconnected mid-emit — nothing more to do
      } finally {
        try { controller.enqueue(enc.encode("data: [DONE]\n\n")); controller.close(); } catch {}
      }
    },
  }));
}

/**
 * Build the OpenAI-style `usage` block from whatever diagnostic info M365 gave
 * us. Token counts are NOT exposed by M365's WebSocket API, so the counters
 * carry the proxy's estimates (`tokens`, usage.ts; zeros under
 * M365_REPORT_USAGE=0): without them a client never sees its context fill, and
 * Codex never compacts. What M365 does send is a **conversation quota**:
 * how many user messages out of the 600-per-conversation cap have been spent.
 *
 * That's a different axis from token-window utilisation, so we surface it as
 * extension fields (`x_m365_*`) alongside the standard counters. Real OpenAI
 * clients ignore unknown extension fields; curious users can read them.
 */
function buildUsage(
  throttle: { current: number; max: number } | null,
  contentOrigin?: string | null,
  messageType?: string | null,
  scores?: Record<string, number> | null,
  turnCount?: number | null,
  metering?: Record<string, number> | null,
  tokens?: { prompt: number; completion: number },
  credits?: number | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    prompt_tokens: tokens?.prompt ?? 0,
    completion_tokens: tokens?.completion ?? 0,
    total_tokens: (tokens?.prompt ?? 0) + (tokens?.completion ?? 0),
  };
  if (throttle) {
    base.x_m365_conversation_messages = throttle.current;
    base.x_m365_conversation_max = throttle.max;
    base.x_m365_conversation_pct = Math.min(100, Math.round((throttle.current / throttle.max) * 100));
    base.x_m365_conversation_remaining = Math.max(0, throttle.max - throttle.current);
  }
  if (contentOrigin) base.x_m365_content_origin = contentOrigin;
  if (messageType) base.x_m365_message_type = messageType;
  if (typeof turnCount === "number") base.x_m365_turn_count = turnCount;
  // Disengaged-classifier scores. Empirically: clean tool calls sit at
  // ~1e-13 / ~1e-8, jailbreak-shaped prompts climb to ~1e-3 / ~1e-3. The
  // `dea_violation` component is the one that actually correlates with the
  // Disengaged filter firing — surface that explicitly so clients can monitor
  // their proximity to the threshold.
  if (scores) {
    base.x_m365_classifier_scores = scores;
    if (typeof scores.dea_violation === "number") base.x_m365_dea_score = scores.dea_violation;
    if (typeof scores.BotOffense === "number") base.x_m365_offense_score = scores.BotOffense;
  }
  // Priority access left after this turn (paid-scenario turns only, §24 F55,
  // §26): one unit per turn, so a client can see the wall coming (issue #18).
  // `x_m365_opus_*` for Opus 5.5, `x_m365_sonnet55_*` for Sonnet 5.5.
  for (const [budget, { usageKey }] of Object.entries(METERED_BUDGETS)) {
    const left = meteredAllowance(metering, budget as MeteredBudget);
    if (left?.daily !== undefined) base[`x_m365_${usageKey}_daily_remaining`] = left.daily;
    if (left?.weekly !== undefined) base[`x_m365_${usageKey}_weekly_remaining`] = left.weekly;
  }
  // The agent runtime (Cowork, Code) charges Copilot credits for every turn.
  if (typeof credits === "number") base.x_m365_credits = credits;
  return base;
}

// --- Helpers ---

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A priority-access budget (Opus 5.5, Sonnet 5.5) ran out. A real 429 (with `Retry-After` and
 *  the UTC reset instant) so a client backs off to the refill instead of
 *  retrying into a wall — and so an agent loop doesn't treat the refusal text as
 *  the model's answer. Resets at midnight UTC; the weekly budget on Monday. */
function priorityAccessResponse(exhaustion: PriorityAccessExhaustion, model: string): Response {
  const retryAfter = secondsUntilReset(exhaustion);
  const label = exhaustion.model ?? model;
  const when = exhaustion.window === "week" ? "this week" : "today";
  return jsonResponse(
    429,
    {
      error: {
        message:
          `M365 Copilot's priority access to ${label} is used up for ${when} ` +
          `(resets ${exhaustion.resetsAt.toISOString()}, i.e. midnight UTC` +
          `${exhaustion.window === "week" ? " on Monday" : ""}). ` +
          `Switch to another model (e.g. claude-sonnet or gpt-5.5-think-deeper) or wait. ` +
          `Upstream said: ${exhaustion.message}`,
        type: "rate_limit_error",
        code: "priority_access_exhausted",
        param: exhaustion.window,
      },
    },
    { "Retry-After": String(retryAfter) },
  );
}

function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

function rateLimitMessage(throttle: { current: number; max: number } | null): string {
  return throttle
    ? `M365 Copilot rate limited (${throttle.current}/${throttle.max} messages used). Please wait and try again.`
    : "M365 Copilot returned an empty response. You may be rate limited. Please wait and try again.";
}

function rateLimitResponse(throttle: { current: number; max: number } | null): Response {
  return jsonResponse(429, { error: { message: rateLimitMessage(throttle), type: "rate_limit_error" } });
}

/** M365 explicitly throttled the turn (`result.value: "Throttled"`). It names
 *  the scope (`PerUserThrottled`) but not the duration, so no Retry-After is
 *  invented. */
function throttledResponse(result: { errorCode?: string; message?: string }): Response {
  const scope = result.errorCode ? ` (${result.errorCode})` : "";
  return jsonResponse(429, {
    error: {
      message: `M365 Copilot throttled this account${scope}: ${result.message ?? "too many requests"} ` +
        `Retrying immediately does not help; it is triggered by starting many new conversations in a short time.`,
      type: "rate_limit_error",
      code: "m365_throttled",
      ...(result.errorCode ? { param: result.errorCode } : {}),
    },
  });
}

/** M365_AVOID_THROTTLING would have had to wait longer than this request may
 *  (a throttle hold, usually), so the turn was never sent: sending it would only
 *  keep the throttle alive. Whatever retries the client makes are answered here
 *  the same way, without reaching M365. */
function turnBudgetHoldResponse(hold: TurnBudgetHold): Response {
  const retryAfter = Math.max(1, Math.ceil(hold.waitMs / 1000));
  return jsonResponse(
    429,
    {
      error: {
        message: `Not sent to M365 Copilot (M365_AVOID_THROTTLING): ${hold.message}.`,
        type: "rate_limit_error",
        code: hold.reason === "throttle hold" ? "m365_throttle_hold" : "m365_turn_budget",
      },
    },
    { "Retry-After": String(retryAfter) },
  );
}

/** M365 refused the turn as an invalid request; `InputTokenLimitExceeded` means
 *  the prompt is too big for this model. A 400: re-sending it can't succeed. */
function invalidRequestResponse(result: { errorCode?: string; message?: string }, model: string, promptChars: number): Response {
  const tooLong = result.errorCode === "InputTokenLimitExceeded";
  // The agent runtime refuses a model its catalog doesn't have now (it dropped every GPT model on Nov 19 2026).
  const notInCatalog = result.errorCode === "ModelNotInCatalog";
  const message = tooLong
    ? `M365 Copilot refused the prompt as too long for ${model} (InputTokenLimitExceeded; ${promptChars} characters sent). ` +
      `Shorten the system prompt or the tool definitions (for Codex: model_instructions_file), or use another model.`
    : notInCatalog
    ? `${model} isn't in the agent runtime's model catalog now${result.message ? ` (${result.message})` : ""}. GET /v1/models lists the models it serves.`
    : `M365 Copilot rejected the request (InvalidRequest${result.errorCode ? `: ${result.errorCode}` : ""})${result.message ? `: ${result.message}` : "."}`;
  return jsonResponse(400, {
    error: {
      message,
      type: "invalid_request_error",
      code: tooLong ? "context_length_exceeded" : notInCatalog ? "model_not_found" : "m365_invalid_request",
      ...(result.errorCode ? { param: result.errorCode } : {}),
    },
  });
}

/** A long turn would take more M365 turns than M365_MAX_TURN_PARTS allows. A 400
 *  with `context_length_exceeded`, so the client compacts instead of retrying. */
function tooManyPartsResponse(turns: number, limit: number): Response {
  return jsonResponse(400, {
    error: {
      message: `This conversation would take ${turns} M365 turns to send, more than M365_MAX_TURN_PARTS (${limit}) allows. Compact it, or raise M365_MAX_TURN_PARTS.`,
      type: "invalid_request_error",
      code: "context_length_exceeded",
    },
  });
}

/** The agent runtime answered a turn with no text. */
function runtimeEmptyResponse(backend: string, agentToolCalls: number): Response {
  const why = agentToolCalls > 0
    ? `its own agent made ${agentToolCalls} tool call${agentToolCalls === 1 ? "" : "s"} in its cloud workspace instead of answering`
    : "it returned no text";
  return jsonResponse(502, {
    error: {
      message: `M365 Copilot's agent runtime (${backend}) wrote no reply: ${why}. Code's agent tends to work in its own workspace; Cowork or Chat models answer in text, and a lower reasoning effort makes a turn shorter.`,
      type: "upstream_empty_response",
      code: "runtime_no_reply",
    },
  });
}

/** Empty upstream reply that is NOT an at-limit throttle — a distinct failure
 *  (content filter, invalid agent/session, transient error) we surface clearly
 *  instead of hanging on a long retry loop. */
function emptyResponseResponse(throttle: { current: number; max: number } | null): Response {
  const detail = throttle ? ` (throttle ${throttle.current}/${throttle.max})` : "";
  return jsonResponse(502, {
    error: {
      message: `M365 Copilot returned an empty response${detail} — likely a content filter, an invalid agent/session, or a transient upstream error.`,
      type: "upstream_empty_response",
    },
  });
}

function premiumOnlyModelResponse(model: string): Response {
  return jsonResponse(502, {
    error: {
      message: `M365 Copilot didn't serve ${model}: it returned InternalError on every attempt. ${model} is served only on a premium (paid Microsoft 365 Copilot) account; on any other account use claude-sonnet.`,
      type: "upstream_error",
      code: "model_route_unavailable",
    },
  });
}

// (streaming is emitted inline by the early-flushed SSE renderer in
// handleChatCompletion; the old streamText/streamToolCalls helpers were removed.)
