import {
  ModelSession,
  type CopilotStream,
  type ModelSessionOptions,
  createLogger,
  trunc,
  getToneForModel,
  requestUsesAgent,
  modelRequiresAgent,
  noteAgentRouteDead,
  noteAgentRouteAlive,
  isAgentRouteAlive,
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
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  looksLikeRemoteArtifactCompletion,
  truncateAtFabricatedToolResponse,
  textAfterFirstToolCall,
  isProseDocument,
  getMessageContent,
  noteRequestOutcome,
  noteUpstreamThrottle,
  getDegradationRetryAfterSeconds,
  awaitDegradationBackoff,
} from "@m365-copilot/core";
import type { ChatCompletionRequest } from "./schemas.js";
import { estimatePromptTokens, estimateTokens, openAIError } from "./openai.js";
import type { z } from "zod/v4";

const log = createLogger("handler");

// Forcing follow-up sent (in the same conversation) when M365 confabulates an
// inability to act instead of calling a tool. See the confab-retry loop below.
const CONFAB_FORCE_PROMPT =
  "The working directory and the files named in the task ARE present on a real filesystem right now. Do NOT ask me to paste anything, and do NOT say commands return no output — you have not run any command yet. Emit ONE ```bash block this turn: run `ls -la` and `cat` the relevant files. Output only the ```bash block, nothing else.";

// Forcing follow-up when the model CLAIMS it did a file change but ran no tool.
const HALLUCINATION_FORCE_PROMPT =
  "You have NOT actually done that — no tool ran this turn, so nothing changed on disk. Do not claim a file was created, replaced, or updated until a <tool_response> confirms it. Emit ONE ```bash block now that performs the change for real (write the file with a `cat > path <<'EOF' … EOF` heredoc), and nothing else.";

// A Teams artifact belongs to M365's remote runtime and cannot be applied by a
// local agent using only its basename. Force the intended mutation through the
// harness tools instead of letting the remote patch leak into the conversation.
const REMOTE_ARTIFACT_FORCE_PROMPT =
  "The patch or download link you produced exists only in M365's remote environment and is NOT a file in the caller's working directory. Do NOT create, download, or apply a patch, and do NOT use a Teams artifact link. Use the provided local edit/write tool directly; if needed, emit ONE ```bash block that modifies the named local file in place. Output only that single local tool call, nothing else.";

// M365 soft-caps output around ~3k tokens (~12k chars) and — critically —
// CONCLUDES EARLY rather than truncating mid-stream, so a too-long answer comes
// back clean-looking but incomplete with no error to detect (docs/hypotheses.md
// F9). We can't see token counts, so we heuristically flag responses at/over the
// observed ceiling with finish_reason:"length" — the standard signal a harness
// uses to ask for a continuation. Tune/disable via env (0 disables).
const OUTPUT_CHAR_CEILING =
  getEnvironmentVariable("M365_OUTPUT_CHAR_CEILING") !== undefined
    ? Number(getEnvironmentVariable("M365_OUTPUT_CHAR_CEILING"))
    : 12_000;

const SYSTEM_EXACT_REPLY_GUARD_ENABLED =
  getEnvironmentVariable("M365_SYSTEM_EXACT_REPLY_GUARD") !== "0";

/** "length" when the answer is at/over the empirical output ceiling, else "stop". */
function outputFinishReason(text: string): "stop" | "length" {
  if (OUTPUT_CHAR_CEILING > 0 && text.length >= OUTPUT_CHAR_CEILING) {
    log.info(
      `Output at ceiling (${text.length} ≥ ${OUTPUT_CHAR_CEILING} chars) — finish_reason=length (likely truncated; harness should continue)`,
    );
    return "length";
  }
  return "stop";
}

type ChatBody = z.infer<typeof ChatCompletionRequest>;
type ParsedMessage = ChatBody["messages"][number];

export interface SessionUsageSnapshot {
  updatedAt: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  conversationMessages: number | null;
  conversationMax: number | null;
  conversationRemaining: number | null;
  modelLatencyMs: number | null;
  messageType: string | null;
}

export interface ActiveConversationSnapshot {
  fingerprint: string;
  sessionId: string;
  conversationId: string;
  turnCount: number;
  sentMessageCount: number;
  lastAccessedAt: number;
  model: string;
  usage: SessionUsageSnapshot | null;
}

// --- Per-conversation state ---

interface ConversationState {
  fingerprint: string;
  session: ModelSession;
  sentMessageCount: number;
  lastAccessedAt: number;
  lastModel: string;
  lastUsage: SessionUsageSnapshot | null;
  /** Sent ahead of the next tool result when the proxy executed less than the
   *  model wrote last turn (see executedOnlyFirstNote). */
  pendingNote: string | null;
  /** The model that last answered in this conversation. A different one (the
   *  Opus fallback, #18) can't continue the M365 conversation — it may need
   *  another scenario — so it starts a fresh one with the full history. */
  servedModel?: string;
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
export function executedOnlyFirstNote(
  fabricated: boolean,
  droppedCalls: number,
  trailingChars = 0,
): string | null {
  if (fabricated) {
    return "(Note: only the first tool call in your previous reply was actually run. Everything you wrote after it, including the <tool_response> you wrote yourself, did not happen. Here is the real output of that first call:)";
  }
  const speculated = trailingChars >= TRAILING_NOTE_CHARS;
  if (droppedCalls > 0) {
    const rest =
      droppedCalls === 1 ? "the other one was not" : `the other ${droppedCalls} were not`;
    const tail = speculated
      ? " Anything you wrote after it was written before its result existed."
      : "";
    return `(Note: only the first of the ${droppedCalls + 1} tool calls in your previous reply was run; ${rest}.${tail} Here is the real output of the first one:)`;
  }
  if (speculated) {
    return "(Note: only the tool call in your previous reply was acted on; anything you wrote after it was written before its result existed. Here is the real output of that call:)";
  }
  return null;
}

// --- Session pool: maps conversation fingerprint → M365 session ---

const MAX_IDLE_MS = 30 * 60 * 1000; // evict after 30 min idle

export class SessionPool {
  private conversations = new Map<string, ConversationState>();
  private sessionOptions: ModelSessionOptions;

  constructor(sessionOptions: ModelSessionOptions = {}) {
    this.sessionOptions = sessionOptions;
  }

  /**
   * Resolve the conversation state for an incoming request.
   * Fingerprint includes the model and first user message.
   */
  resolve(messages: ParsedMessage[], model: string = "m365-copilot"): ConversationState {
    this.evictStale();

    const fingerprint = this.fingerprint(messages, model);
    const existing = this.conversations.get(fingerprint);

    if (existing) {
      // Messages shrunk means client restarted this conversation — reset M365 session
      if (messages.length < existing.sentMessageCount) {
        log.info(
          `Conversation ${fingerprint}: messages shrunk (${messages.length} < ${existing.sentMessageCount}), resetting`,
        );
        existing.session.reset();
        existing.sentMessageCount = 0;
        existing.pendingNote = null;
        existing.lastUsage = null;
      }
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    // New conversation
    log.info(`New conversation ${fingerprint}, ${this.conversations.size} active`);
    const state: ConversationState = {
      fingerprint,
      session: new ModelSession(this.sessionOptions),
      sentMessageCount: 0,
      pendingNote: null,
      lastAccessedAt: Date.now(),
      lastModel: model,
      lastUsage: null,
    };
    this.conversations.set(fingerprint, state);
    return state;
  }

  private fingerprint(messages: ParsedMessage[], model: string): string {
    const firstUser = messages.find((m) => m.role === "user");
    const text = firstUser ? getMessageContent(firstUser) : "";
    return simpleHash(`${model}\n${text}`);
  }

  private evictStale() {
    const now = Date.now();
    for (const [key, state] of this.conversations) {
      if (now - state.lastAccessedAt > MAX_IDLE_MS) {
        log.info(`Evicting idle conversation ${key}`);
        this.conversations.delete(key);
      }
    }
  }

  get size(): number {
    return this.conversations.size;
  }

  getActiveConversations(): ActiveConversationSnapshot[] {
    this.evictStale();
    return [...this.conversations.values()]
      .map((state) => ({
        fingerprint: state.fingerprint,
        sessionId: state.session.sessionId,
        conversationId: state.session.conversationId,
        turnCount: state.session.turnCount,
        sentMessageCount: state.sentMessageCount,
        lastAccessedAt: state.lastAccessedAt,
        model: state.lastModel,
        usage: state.lastUsage,
      }))
      .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function getErrorMessage(error: unknown, fallback?: string): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error;
    if (typeof message === "string") return message;
  }
  if (typeof error === "string") return error;
  return fallback ?? String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getEnvironmentVariable(name: string): string | undefined {
  const runtimeProcess: unknown = Reflect.get(globalThis, "process");
  if (!isRecord(runtimeProcess)) return undefined;
  const environment = runtimeProcess.env;
  if (!isRecord(environment)) return undefined;
  const value = environment[name];
  return typeof value === "string" ? value : undefined;
}

// --- Delta message formatting ---

/** Format new messages, recovering tool names from the complete request history. */
export function formatDeltaMessages(
  messages: ParsedMessage[],
  history: ParsedMessage[] = messages,
  framingVariant = "baseline",
): string {
  const callNames = new Map<string, string>();
  for (const m of history) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) if (tc.id) callNames.set(tc.id, tc.function.name);
    }
  }
  const parts: string[] = [];
  const style = transcriptStyleForVariant(framingVariant);
  for (const m of messages) {
    if (m.role === "assistant") {
      // Skip assistant messages — M365 already has them server-side.
      // Echoing them back as a user message confuses M365.
    } else if (m.role === "tool") {
      const name = m.name || (m.tool_call_id && callNames.get(m.tool_call_id)) || "unknown";
      const callId = m.tool_call_id || "?";
      parts.push(
        `<tool_response name="${name}" call_id="${callId}">\n${getMessageContent(m)}\n</tool_response>`,
      );
    } else if (m.role === "system") {
      parts.push(`<${style.systemTag}>\n${getMessageContent(m)}\n</${style.systemTag}>`);
    } else {
      parts.push(`<${m.role}>\n${getMessageContent(m)}\n</${m.role}>`);
    }
  }
  return parts.join("\n\n");
}

function parseExactReplyDirective(systemText: string): string | null {
  const patterns = [
    /^only\s+reply(?:\s+with)?\s+(.+?)(?:\s+and\s+do\s+not\s+answer\b.*)?[.!]?$/i,
    /^(?:reply|respond|answer)\s+with\s+exactly\s+(.+?)(?:\s+and\s+nothing\s+else\b.*)?[.!]?$/i,
    /^output\s+only\s+(.+?)(?:\s+and\s+nothing\s+else\b.*)?[.!]?$/i,
  ];
  for (const pattern of patterns) {
    const match = systemText.match(pattern);
    if (!match) continue;
    let output = match[1]
      .trim()
      .replace(/^exactly\s+/i, "")
      .trim();
    const quoted =
      (output.startsWith('"') && output.endsWith('"')) ||
      (output.startsWith("'") && output.endsWith("'")) ||
      (output.startsWith("`") && output.endsWith("`"));
    output = quoted ? output.slice(1, -1).trim() : output.replace(/[.?!]\s*$/, "").trim();
    if (output && output.length <= 120 && !output.includes("\n")) return output;
  }
  return null;
}

function extractForcedExactReply(messages: ParsedMessage[]): string | null {
  if (!SYSTEM_EXACT_REPLY_GUARD_ENABLED) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "system") continue;
    const systemText = getMessageContent(message).replace(/\s+/g, " ").trim();
    if (!systemText || systemText.length > 220) continue;
    const forced = parseExactReplyDirective(systemText);
    if (forced) return forced;
  }
  return null;
}

// --- Main handler ---

/**
 * Handle a chat completion request, returning an OpenAI-compatible Response.
 * The SessionPool routes each conversation to its own ModelSession.
 */
export async function handleChatCompletion(
  body: ChatBody,
  pool: SessionPool,
  opts: {
    signal?: AbortSignal;
    onComplete?: (response: Response, error?: { type: string; message: string }) => void;
  } = {},
): Promise<Response> {
  const conv = pool.resolve(body.messages, body.model);
  const { session } = conv;
  const hasTools = body.tools && body.tools.length > 0 && body.tool_choice !== "none";
  const requestedModel = body.model;
  conv.lastModel = requestedModel;
  const promptTokens = estimatePromptTokens(body.messages, body.tools);
  let completionText = "";
  const forcedExactReply = !hasTools ? extractForcedExactReply(body.messages) : null;
  const applyForcedExactReply = (responseText: string): string => {
    if (!forcedExactReply || responseText.trim() === forcedExactReply) return responseText;
    log.info(
      `System exact-reply override applied: expected ${JSON.stringify(forcedExactReply)}, got ${JSON.stringify(trunc(responseText, 80))}`,
    );
    return forcedExactReply;
  };

  // Priority access (§15, §24 F55, §26, issue #18). Once a budget is used up
  // every turn on it is refused until the reset, so don't start one: serve the
  // opt-in fallback model (M365_OPUS_FALLBACK_MODEL, e.g. the unmetered
  // claude-opus-4.5; M365_SONNET_FALLBACK_MODEL for Sonnet 5.5), or answer the
  // 429 here. A refused turn costs no allowance, but it does cost an M365 turn
  // and often a fresh conversation — what the account's thread-rate throttle
  // counts.
  const requestedBudget = meteredBudgetOf(requestedModel);
  const knownExhaustion = activePriorityAccessExhaustion(requestedBudget ?? requestedModel);
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
  }

  // Which requests carry the declarative tool agent. GPT-the-chat-model won't
  // tool-call agent-less (0/4), so it needs the agent. Claude tool-calls reliably
  // AGENT-LESS via shell-routing (F23), and on a non-premium account the agent
  // path doesn't serve Claude at all (§22 F44) — except Claude Opus, whose
  // included-scenario model (Opus 4.5) serves ONLY with the agent (§24), so it
  // carries the agent even on a tool-less request. `Gpt_6_Reasoning` doesn't serve
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
  let useToolAgent = getEnvironmentVariable("M365_DISABLE_AGENT") !== "1" && requestUsesAgent(model, !!hasTools);
  const agentId = useToolAgent ? await session.resolveAgent() : null;
  if (useToolAgent && !agentId) useToolAgent = false;
  let framingVariant = currentFramingVariant(
    defaultFramingForModel(model, { agentLess: !!hasTools && !useToolAgent }),
  );
  const framingContext = { tone };
  log.info(`Tool routing: model=${model}, tone=${tone}, agent=${agentId ?? "none"}, framing=${framingVariant}`);

  // Format message: full prompt on first turn, delta on follow-ups.
  // M365 is stateful — it remembers everything from prior turns,
  // so we only need to send new messages after the first turn.
  const isFirstTurn = session.turnCount === 0;
  const convId = session.conversationId;
  let text: string;
  if (isFirstTurn || conv.sentMessageCount === 0) {
    text = formatMessages(
      body.messages,
      body.tools,
      body.tool_choice,
      convId,
      framingVariant,
      framingContext,
    );
    log.info(
      `Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=full, cid=${convId}`,
    );
  } else {
    const newMessages = body.messages.slice(conv.sentMessageCount);
    const delta = newMessages.length > 0 ? formatDeltaMessages(newMessages, body.messages, framingVariant) : "";
    if (delta.length > 0) {
      text = delta;
      // Only a tool result is the thing the note corrects the model about.
      if (conv.pendingNote && newMessages.some((m) => m.role === "tool")) {
        text = `${conv.pendingNote}\n\n${delta}`;
        log.info("Prepended the only-the-first-call-ran note (last reply was partly executed)");
      }
      log.info(
        `Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, new=${newMessages.length}, turn=${session.turnCount}, mode=delta, cid=${convId}`,
      );
    } else {
      // No meaningful new content to send — nudge M365 to continue.
      text = "Please continue.";
      log.info(
        `Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=retry, cid=${convId}`,
      );
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
  let lastModelLatencyMs: number | null = null;
  let lastMetering: Record<string, number> | null | undefined;

  // `onDelta` (when provided) forwards each text delta to the caller AS IT ARRIVES,
  // for live incremental streaming. It's safe to forward without ever retracting:
  // runBuffered only retries on an EMPTY attempt (Disengaged, dead-agent, throttle),
  // and an empty attempt emits no deltas — so a forwarded delta always belongs to the
  // one attempt that produced content and is never re-sent by a subsequent retry.
  async function runBuffered(
    onDelta?: (delta: string) => void,
  ): Promise<{ fullText: string } | { error: Response }> {
    const runStartedAt = Date.now();
    const finish = <Result extends { fullText: string } | { error: Response }>(
      value: Result,
    ): Result => {
      lastModelLatencyMs = Date.now() - runStartedAt;
      if ("fullText" in value) completionText = value.fullText;
      usageForResponse();
      return value;
    };
    let agentRefreshed = false;
    let disengageRetried = false;
    let agentFallbackDone = false;
    let priorityFallbackDone = false;
    let originalText = text;
    // Self-imposed pacing while the account is degraded (thread-rate throttle). A
    // no-op when healthy; during backoff it sleeps a jittered delay so we stop
    // starting fresh turns into the throttle and let it self-heal (H-R1). This
    // replaced the old auto-reauth, which didn't clear the throttle and raised our
    // detection profile. A single long pi thread never trips the trigger.
    await awaitDegradationBackoff();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let copilotStream: CopilotStream;
      try {
        // Only attach the tool-calling agent when the request actually has tools.
        // The agent overrides `tone` (forces GPT-5), so tool-less requests must
        // skip it to reach the model the tone selects (e.g. Claude). See
        // ModelSession.run / docs H8.6.
        copilotStream = await session.run(text, model, opts.signal, useToolAgent);
      } catch (err: unknown) {
        return finish({
          error: openAIError(502, { message: getErrorMessage(err), type: "upstream_error" }),
        });
      }

      let fullText = "";
      try {
        for await (const delta of copilotStream) {
          fullText += delta;
          onDelta?.(delta);
        }
        if (copilotStream.fullText && copilotStream.fullText.length > fullText.length) {
          fullText = copilotStream.fullText;
        }
      } catch (err: unknown) {
        return finish({
          error: openAIError(502, { message: getErrorMessage(err), type: "upstream_error" }),
        });
      }

      lastThrottle = copilotStream.throttle;
      lastContentOrigin = copilotStream.contentOrigin;
      lastMessageType = copilotStream.messageType;
      lastScores = copilotStream.scores;
      lastTurnCount = copilotStream.turnCount;
      lastMetering = copilotStream.metering;

      // M365 SAYS when it throttles: the final item's result is `Throttled` /
      // `PerUserThrottled` (#35). Checked BEFORE the content check so
      // an apology that ever arrives as content can't pass for an answer. This
      // used to fall through to the empty-reply path below — two "quick retries"
      // straight back into the throttle, then a 502 blaming a content filter.
      // Fail fast with a 429 instead, and count it toward the degradation backoff.
      if (copilotStream.result?.value === "Throttled") {
        noteUpstreamThrottle();
        log.info(
          `Upstream Throttled (${copilotStream.result.errorCode ?? "no errorCode"}) — 429, no retry`,
        );
        return finish({ error: throttledResponse(copilotStream.result) });
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
        useToolAgent &&
        !agentFallbackDone &&
        PREMIUM_ONLY_AGENT_TONES.has(tone) &&
        !isAgentRouteAlive(tone) &&
        getEnvironmentVariable("M365_FORCE_AGENT") !== "1" &&
        copilotStream.result?.value === "InternalError" &&
        !copilotStream.hasContent &&
        fullText.length === 0
      ) {
        agentFallbackDone = true;
        noteAgentRouteDead(tone);
        useToolAgent = false;
        session.newConversation();
        text = formatMessages(
          body.messages,
          body.tools,
          body.tool_choice,
          session.conversationId,
          framingVariant,
          { tone },
        );
        originalText = text;
        log.info(
          `Agent route dead for ${tone} (InternalError) — this account isn't premium; re-sending agent-less with '${framingVariant}' framing in a fresh conversation`,
        );
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
      const exhausted = priorityAccessExhaustionOf(copilotStream.result, fullText);
      if (exhausted) {
        const budget = meteredBudgetOf(model);
        if (budget || copilotStream.result?.value === "OutOfCredits") notePriorityAccessExhausted(budget ?? model, exhausted);
        const fallback = budget && !priorityFallbackDone ? priorityAccessFallbackModel(budget) : null;
        if (fallback) {
          priorityFallbackDone = true;
          log.info(`Priority access exhausted (${exhausted.window}) — re-sending to ${fallback} (${PRIORITY_ACCESS_FALLBACK_ENV[budget!]}) in a fresh conversation`);
          model = fallback;
          tone = getToneForModel(model);
          useToolAgent = getEnvironmentVariable("M365_DISABLE_AGENT") !== "1" && requestUsesAgent(model, !!hasTools);
          if (useToolAgent && !(await session.resolveAgent())) useToolAgent = false;
          framingVariant = currentFramingVariant(
            defaultFramingForModel(model, { agentLess: !!hasTools && !useToolAgent }),
          );
          session.newConversation();
          text = formatMessages(body.messages, body.tools, body.tool_choice, session.conversationId, framingVariant, { tone });
          originalText = text;
          attempt--;
          continue;
        }
        noteRequestOutcome(false, convId); // an answer, not a throttle
        log.info(`Priority access exhausted (${exhausted.window}) — resets ${exhausted.resetsAt.toISOString()}`);
        return { error: priorityAccessResponse(exhausted, model) };
      }

      if (copilotStream.hasContent || fullText.length > 0) {
        noteRequestOutcome(false, convId); // clean response → degradation has lifted
        if (useToolAgent) noteAgentRouteAlive(tone); // the agent route answered on this account
        conv.servedModel = model;
        return finish({ fullText });
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
        if (hasTools && !disengageRetried && !getEnvironmentVariable("M365_NO_DISENGAGE_RETRY")) {
          disengageRetried = true;
          session.newConversation();
          // `softened` is the low-override twin of the `<system>`-tagged framings.
          // A variant that deliberately avoids `<system>` tags (Claude Sonnet's
          // `relay`) keeps itself: swapping to `softened` would reintroduce
          // exactly the tag that model reads as a forged system prompt.
          const retryVariant =
            transcriptStyleForVariant(framingVariant).framingTag === "system"
              ? "softened"
              : framingVariant;
          text = formatMessages(
            body.messages,
            body.tools,
            body.tool_choice,
            session.conversationId,
            retryVariant,
            framingContext,
          );
          log.info(
            `Upstream Disengaged — retrying once with '${retryVariant}' framing in a fresh conversation (F22)`,
          );
          attempt--; // free retry; bounded — disengageRetried flips once
          continue;
        }
        log.info("Upstream Disengaged — failing fast (no retry) to preserve quota");
        return finish({
          error: openAIError(502, {
            message:
              "M365 Copilot disengaged from this request (its safety filter declined to answer). Common causes: too many tools, jailbreak-shaped instructions, or pairing a non-default model with the tool agent. Reduce the toolset or use the default model.",
            type: "disengaged",
          }),
        });
      }

      // Empty response. Only an at-limit throttle warrants treating this as rate
      // limiting; otherwise it's a different failure (content filter, an invalid
      // agent/session, a transient upstream error) where a long escalating
      // backoff is futile and reads as a silent hang. Fail fast after a couple of
      // quick retries instead.
      const t = copilotStream.throttle;
      if (t && t.current >= t.max) {
        return finish({ error: rateLimitResponse(t) });
      }
      if (attempt < MAX_RETRIES) {
        // A dead/deleted agent returns an instant empty reply (throttle: null).
        // Re-resolve the agent once before retrying so a long-lived host
        // self-heals from the deleted-agent trap instead of looping on empties.
        if (useToolAgent && !agentRefreshed) {
          agentRefreshed = true;
          const agentChanged = await session.refreshAgent();
          if (agentChanged) {
            // The cached agent was stale/deleted and has been re-resolved.
            // Resend the original prompt to the fresh agent — a bare "continue"
            // would have no context since the dead agent processed nothing.
            log.info("Agent re-resolved after empty reply, resending original prompt");
            text = originalText;
            await new Promise((r) => setTimeout(r, SHORT_RETRY_DELAY_MS));
            continue;
          }
        }
        log.info(
          `Empty upstream response, quick retry in ${SHORT_RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, SHORT_RETRY_DELAY_MS));
        text = "Please continue."; // M365 already has context
      } else {
        // A model that serves only with the agent, on an account whose agent
        // route doesn't serve it (Opus 4.5 on a non-premium account: BotConnection,
        // `InternalError`, every time — §24). Not a throttle, so it doesn't feed
        // the degradation backoff; say what it is instead of "empty response".
        if (useToolAgent && modelRequiresAgent(model) && copilotStream.result?.value === "InternalError") {
          log.info(`${model}: agent route returned InternalError on every attempt — premium-only model on a non-premium account?`);
          return { error: premiumOnlyModelResponse(model) };
        }
        // Final empty after retries, and not an at-limit (per-conversation) cap:
        // this is the thread-rate throttle signature (F13). Feed the degradation-
        // backoff policy — once empties span enough distinct conversations it paces
        // subsequent turns so the account can self-heal (H-R1). Never blocks this request.
        noteRequestOutcome(true, convId);
        return finish({ error: emptyResponseResponse(t) });
      }
    }
    noteRequestOutcome(true, convId);
    return finish({ error: emptyResponseResponse(null) });
  }

  function usageForResponse(): Record<string, unknown> {
    const tokens = { prompt: promptTokens, completion: estimateTokens(completionText) };
    const usage = buildUsage(
      tokens,
      lastThrottle,
      lastContentOrigin,
      lastMessageType,
      lastScores,
      lastTurnCount,
      lastModelLatencyMs,
      lastMetering,
    );
    conv.lastUsage = usageToSessionSnapshot(model, usage, lastMessageType, lastModelLatencyMs);
    return usage;
  }

  function withProxyHeaders(response: Response, finishReason?: string): Response {
    response.headers.set("x-proxy-model", model);
    response.headers.set("x-proxy-stream", body.stream ? "1" : "0");
    response.headers.set("x-proxy-session-id", session.sessionId);
    response.headers.set("x-proxy-conversation-id", session.conversationId);
    if (lastMessageType) response.headers.set("x-proxy-message-type", lastMessageType);
    if (finishReason) response.headers.set("x-proxy-finish-reason", finishReason);
    if (lastModelLatencyMs !== null)
      response.headers.set("x-proxy-usage", JSON.stringify(usageForResponse()));
    return response;
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
        if (cutFabricated)
          log.info(
            `Model wrote its own <tool_response> — cut ${raw.length - cut.length} fabricated chars (stop sequence)`,
          );
        return cut;
      };
      const result = await runBuffered();
      if ("error" in result) return { kind: "error", resp: result.error };
      conv.sentMessageCount = body.messages.length;
      let fullText = stopAtFabricatedResult(result.fullText);

      log.debug("Raw response (tool mode):", trunc(fullText, 1000));
      let parsed = parseToolCalls(fullText, body.tools);
      log.info(
        `Parse result: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`,
      );

      // Salvage stochastic turn-1 confabulation: M365's chat model sometimes claims it
      // "can't access the files / commands return no output" and asks the user to paste
      // them, WITHOUT calling a tool — even though the environment is real (the bench +
      // pi both reproduce this). Re-prompt forcefully in the SAME conversation (one
      // thread, cheap). Disable with M365_NO_CONFAB_RETRY; tune count with M365_CONFAB_RETRIES.
      const maxConfabRetries = getEnvironmentVariable("M365_NO_CONFAB_RETRY")
        ? 0
        : Number(getEnvironmentVariable("M365_CONFAB_RETRIES") ?? 1);
      // The model never actually acted if no assistant turn in the history carried a
      // tool call. Used to gate the hallucinated-completion retry (a model that did
      // real work called at least one tool), keeping false positives near zero.
      const everActed = (body.messages ?? []).some(
        (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
      );
      for (let attempt = 0; attempt < maxConfabRetries && !parsed.hasToolCalls; attempt++) {
        const confab = looksLikeConfabulation(parsed.textContent);
        const remoteArtifact = looksLikeRemoteArtifactCompletion(parsed.textContent);
        const halluc = !everActed && looksLikeHallucinatedCompletion(parsed.textContent);
        if (!confab && !remoteArtifact && !halluc) break;
        const retryKind = remoteArtifact
          ? "Remote artifact completion"
          : confab
            ? "Confabulation"
            : "Hallucinated completion";
        log.info(
          `${retryKind} detected (no tool call) — forcing retry ${attempt + 1}/${maxConfabRetries}`,
        );
        text = remoteArtifact
          ? REMOTE_ARTIFACT_FORCE_PROMPT
          : confab
            ? CONFAB_FORCE_PROMPT
            : HALLUCINATION_FORCE_PROMPT;
        const retry = await runBuffered();
        if ("error" in retry) return { kind: "error", resp: retry.error };
        conv.sentMessageCount = body.messages.length;
        fullText = stopAtFabricatedResult(retry.fullText);
        parsed = parseToolCalls(fullText, body.tools);
        log.info(
          `After forcing retry: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`,
        );
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
        log.info(
          "Remote-artifact mutation claim persisted without a local tool call after forcing retries — failing closed",
        );
        return {
          kind: "error",
          resp: openAIError(502, {
            message:
              "M365 returned a remote Teams or /mnt/data artifact instead of calling the local editing tools. No local file was changed. Retry with gpt-5.5-think-deeper, the recommended model for tool calling.",
            type: "file_mutation_without_local_tool",
          }),
        };
      }

      // Document guard: the shell-routing parser turns every ```bash block into a
      // tool call, so a model that ANSWERS with a markdown document full of code
      // fences (e.g. "here's a simplified README") would get its own answer executed
      // as shell. Detect that shape (multiple fences + prose) and return the document
      // as plain text instead of running it — unless the reply OPENS with a tool
      // call, which makes it an action with a speculative tail (#33).
      if (isProseDocument(parsed, fullText, body.tools)) {
        log.info(
          `Response is a prose document (${parsed.toolCalls.length} embedded fences), returning as text instead of executing`,
        );
        parsed = { hasToolCalls: false, toolCalls: [], textContent: fullText };
      }

      // Fail-closed: if model mixed text with tool calls, strip text and re-prompt once.
      // This enforces the "output ONLY a tool call" contract.
      if (parsed.hasToolCalls && parsed.textContent) {
        const extraText = parsed.textContent.trim();
        if (extraText.length > 0) {
          log.info(
            `Mixed output detected (${extraText.length} chars of text alongside ${parsed.toolCalls.length} tool calls), stripping text`,
          );
          // Strip the text — the tool calls are what the client needs.
          // Log the stripped text for debugging but don't send it downstream.
          log.debug("Stripped text:", trunc(extraText, 500));
          parsed = { ...parsed, textContent: null };
        }
      }

      // Handle "reply" tool calls — convert to plain text
      if (parsed.hasToolCalls) {
        const replyCall = parsed.toolCalls.find((tc) => tc.function.name === "reply");
        const realToolCalls = parsed.toolCalls.filter((tc) => tc.function.name !== "reply");

        if (replyCall && realToolCalls.length === 0) {
          let replyText: string;
          try {
            const parsedArgs: unknown = JSON.parse(replyCall.function.arguments);
            const args = isRecord(parsedArgs) ? parsedArgs : {};
            const text = typeof args.text === "string" ? args.text : undefined;
            const message = typeof args.message === "string" ? args.message : undefined;
            const content = typeof args.content === "string" ? args.content : undefined;
            replyText = text || message || content || fullText;
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
        if (!getEnvironmentVariable("M365_ALLOW_MULTI_TOOL") && parsed.toolCalls.length > 1) {
          log.info(
            `One-call-per-turn: keeping ${parsed.toolCalls[0].function.name}, dropping ${parsed.toolCalls.length - 1} batched call(s)`,
          );
          droppedCalls = parsed.toolCalls.length - 1;
          parsed.toolCalls = [parsed.toolCalls[0]];
        }
      }

      if (parsed.hasToolCalls && parsed.toolCalls.length > 0) {
        // The model's server-side history holds more than what runs; say so on
        // the turn that carries the real result (executedOnlyFirstNote).
        conv.pendingNote = executedOnlyFirstNote(
          cutFabricated,
          droppedCalls,
          textAfterFirstToolCall(fullText, body.tools).length,
        );
        return { kind: "tools", toolCalls: parsed.toolCalls };
      }
      return { kind: "text", text: fullText };
    } else {
      // No tools — stream deltas live (onDelta) while buffering for the retry logic.
      const result = await runBuffered(onDelta);
      if ("error" in result) return { kind: "error", resp: result.error };
      conv.sentMessageCount = body.messages.length;
      return { kind: "text", text: applyForcedExactReply(result.fullText) };
    }
  } // end produce()

  // --- Render: JSON (non-stream) or an early-flushed SSE stream (stream) ---
  const includeUsage = !!body.stream_options?.include_usage;
  const usage = usageForResponse;
  const legacy = body.legacy_functions;
  const toolFinishReason = legacy ? "function_call" : "tool_calls";
  const noteCompletion = (p: Produced) => {
    if (p.kind === "text") completionText = p.text;
    else if (p.kind === "tools")
      completionText = p.toolCalls.map((tc) => tc.function.name + tc.function.arguments).join("");
  };

  if (!body.stream) {
    const p = await produce();
    noteCompletion(p);
    if (p.kind === "error") return withProxyHeaders(p.resp);
    const head = {
      id: completionId,
      object: "chat.completion",
      created,
      model,
      system_fingerprint: null,
    };
    if (p.kind === "tools") {
      const message = legacy
        ? {
            role: "assistant",
            content: null,
            function_call: {
              name: p.toolCalls[0].function.name,
              arguments: p.toolCalls[0].function.arguments,
            },
          }
        : { role: "assistant", content: null, tool_calls: p.toolCalls };
      return withProxyHeaders(
        jsonResponse(200, {
          ...head,
          choices: [{ index: 0, message, logprobs: null, finish_reason: toolFinishReason }],
          usage: usage(),
        }),
        toolFinishReason,
      );
    }
    return withProxyHeaders(
      jsonResponse(200, {
        ...head,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: p.text },
            logprobs: null,
            finish_reason: outputFinishReason(p.text),
          },
        ],
        usage: usage(),
      }),
      outputFinishReason(p.text),
    );
  }

  // Streaming: send HTTP 200 + a role chunk + keepalive comments from t=0, then run
  // produce() INSIDE the stream so the client never waits out the whole M365 turn
  // (up to ~160s) before the first byte — avoids client read-timeouts.
  //
  // On the non-tool path we forward each text delta AS IT ARRIVES (`liveDelta`), so
  // `stream:true` is genuinely incremental. Tool mode still buffers: the raw text is
  // parsed for tool-call fences and can't be shown verbatim, so its tool_calls (or a
  // prose fallback) are emitted once at the end.
  const streamingResponse = withProxyHeaders(
    sseResponse(
      new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (obj: unknown) =>
            controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
          const base = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            system_fingerprint: null,
          };
          send({
            ...base,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          });
          const hb = setInterval(() => {
            try {
              controller.enqueue(enc.encode(": keepalive\n\n"));
            } catch {}
          }, 15000);

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
          let head = "";
          let gated = true;
          const liveDelta =
            hasTools || forcedExactReply
              ? undefined
              : (delta: string) => {
                  if (!delta) return;
                  if (gated) {
                    head += delta;
                    if (couldBePriorityAccessPrefix(head)) return; // still undecided — keep buffering
                    gated = false;
                    delta = head; // release everything held so far, in order
                  }
                  sent += delta;
                  try {
                    send({
                      ...base,
                      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                    });
                  } catch {}
                };

          let p: Produced;
          try {
            p = await produce(liveDelta);
          } catch (err: unknown) {
            p = {
              kind: "error",
              resp: openAIError(502, {
                message: getErrorMessage(err, "stream error"),
                type: "upstream_error",
              }),
            };
          }
          noteCompletion(p);
          clearInterval(hb);
          let finishReason: string | undefined;
          let streamError: { type: string; message: string } | undefined;
          try {
            if (p.kind === "error") {
              let message = "upstream error";
              let type = "upstream_error";
              let code: string | undefined;
              let param: string | null = null;
              // Carry the structured fields through, not just the prose: a streaming
              // client still has to tell a priority-access wall (back off until the
              // reset) from a transient upstream failure (retry now), and the status
              // code it would have read is gone once HTTP 200 is committed.
              try {
                const responseBody: unknown = JSON.parse(await p.resp.text());
                const parsedError = isRecord(responseBody) ? responseBody.error : undefined;
                if (isRecord(parsedError)) {
                  if (typeof parsedError.message === "string" && parsedError.message)
                    message = parsedError.message;
                  if (typeof parsedError.type === "string" && parsedError.type)
                    type = parsedError.type;
                  if (typeof parsedError.code === "string" && parsedError.code)
                    code = parsedError.code;
                  if (typeof parsedError.param === "string") param = parsedError.param;
                }
              } catch {}
              streamError = { message, type };
              const retryAfter = p.resp.headers.get("Retry-After");
              // HTTP 200 is already committed, so surface the failure as an in-stream error chunk.
              send({
                ...base,
                error: {
                  message,
                  type,
                  param,
                  ...(code ? { code } : {}),
                  ...(retryAfter ? { retry_after: Number(retryAfter) } : {}),
                },
              });
            } else if (p.kind === "tools") {
              finishReason = toolFinishReason;
              if (legacy) {
                const tc = p.toolCalls[0];
                send({
                  ...base,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        function_call: { name: tc.function.name, arguments: tc.function.arguments },
                      },
                      finish_reason: null,
                    },
                  ],
                });
              } else {
                p.toolCalls.forEach((tc, i) => {
                  log.debug(`Tool call: ${tc.function.name} ${trunc(tc.function.arguments, 200)}`);
                  send({
                    ...base,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: i,
                              id: tc.id,
                              type: "function",
                              function: {
                                name: tc.function.name,
                                arguments: tc.function.arguments,
                              },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  });
                });
              }
              send({
                ...base,
                choices: [{ index: 0, delta: {}, finish_reason: toolFinishReason }],
                ...(includeUsage ? { usage: usage() } : {}),
              });
            } else {
              finishReason = outputFinishReason(p.text);
              // Emit only what wasn't already streamed live: the whole text if nothing was
              // (tool-mode prose fallback, or a fully-buffered turn), or just the tail when
              // live deltas already covered a prefix. If `sent` somehow isn't a prefix of
              // the final text (a divergent snapshot upstream chose not to stream), fall
              // back to sending nothing more rather than duplicating already-sent bytes.
              const remainder = p.text.startsWith(sent) ? p.text.slice(sent.length) : "";
              if (!p.text.startsWith(sent))
                log.info(
                  `Streamed prefix diverged from final text (sent ${sent.length}, final ${p.text.length} chars) — not re-sending to avoid duplication`,
                );
              if (remainder)
                send({
                  ...base,
                  choices: [{ index: 0, delta: { content: remainder }, finish_reason: null }],
                });
              send({
                ...base,
                choices: [{ index: 0, delta: {}, finish_reason: outputFinishReason(p.text) }],
                ...(includeUsage ? { usage: usage() } : {}),
              });
            }
          } catch {
            // client likely disconnected mid-emit — nothing more to do
          } finally {
            withProxyHeaders(streamingResponse, finishReason);
            try {
              opts.onComplete?.(streamingResponse, streamError);
            } catch (err: unknown) {
              log.info(`Completion observer failed: ${getErrorMessage(err)}`);
            }
            try {
              controller.enqueue(enc.encode("data: [DONE]\n\n"));
              controller.close();
            } catch {}
          }
        },
      }),
    ),
  );
  return streamingResponse;
}

/**
 * Build the OpenAI-style `usage` block from whatever diagnostic info M365 gave
 * us. Token counts are NOT exposed by M365's WebSocket API, so the standard
 * counters are character-based estimates (flagged `x_proxy_tokens_estimated`).
 * What M365 does send is a **conversation quota**: how many user messages out
 * of the 600-per-conversation cap have been spent.
 *
 * That's a different axis from token-window utilisation, but it's the closest
 * thing we have to "remaining budget", so we surface it as extension fields
 * (`x_m365_*`). Real OpenAI clients ignore unknown extension fields; curious
 * users can read them.
 */
function buildUsage(
  tokens: { prompt: number; completion: number },
  throttle: { current: number; max: number } | null,
  contentOrigin?: string | null,
  messageType?: string | null,
  scores?: Record<string, number> | null,
  turnCount?: number | null,
  modelLatencyMs?: number | null,
  metering?: Record<string, number> | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    prompt_tokens: tokens.prompt,
    completion_tokens: tokens.completion,
    total_tokens: tokens.prompt + tokens.completion,
    x_proxy_tokens_estimated: true,
  };
  if (throttle) {
    base.x_m365_conversation_messages = throttle.current;
    base.x_m365_conversation_max = throttle.max;
    base.x_m365_conversation_pct = Math.min(
      100,
      Math.round((throttle.current / throttle.max) * 100),
    );
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
  if (typeof modelLatencyMs === "number") base.x_proxy_model_latency_ms = modelLatencyMs;
  // Priority access left after this turn (paid-scenario turns only, §24 F55,
  // §26): one unit per turn, so a client can see the wall coming (issue #18).
  // `x_m365_opus_*` for Opus 5.5, `x_m365_sonnet55_*` for Sonnet 5.5.
  for (const [budget, { usageKey }] of Object.entries(METERED_BUDGETS)) {
    const left = meteredAllowance(metering, budget as MeteredBudget);
    if (left?.daily !== undefined) base[`x_m365_${usageKey}_daily_remaining`] = left.daily;
    if (left?.weekly !== undefined) base[`x_m365_${usageKey}_weekly_remaining`] = left.weekly;
  }
  return base;
}

function usageToSessionSnapshot(
  model: string,
  usage: Record<string, unknown>,
  messageType?: string | null,
  modelLatencyMs?: number | null,
): SessionUsageSnapshot {
  return {
    updatedAt: Date.now(),
    model,
    promptTokens: asNumber(usage.prompt_tokens),
    completionTokens: asNumber(usage.completion_tokens),
    totalTokens: asNumber(usage.total_tokens),
    conversationMessages: asNumberOrNull(usage.x_m365_conversation_messages),
    conversationMax: asNumberOrNull(usage.x_m365_conversation_max),
    conversationRemaining: asNumberOrNull(usage.x_m365_conversation_remaining),
    modelLatencyMs:
      typeof modelLatencyMs === "number"
        ? modelLatencyMs
        : asNumberOrNull(usage.x_proxy_model_latency_ms),
    messageType:
      typeof usage.x_m365_message_type === "string"
        ? usage.x_m365_message_type
        : (messageType ?? null),
  };
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// --- Helpers ---

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
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
  return openAIError(
    429,
    {
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
  return openAIError(429, { message: rateLimitMessage(throttle), type: "rate_limit_error" });
}

function throttledResponse(result: { errorCode?: string; message?: string }): Response {
  const scope = result.errorCode ? ` (${result.errorCode})` : "";
  const configuredDelay = Number(getEnvironmentVariable("M365_THROTTLE_RETRY_AFTER_S"));
  const retryAfter = Math.max(
    getDegradationRetryAfterSeconds(),
    Number.isFinite(configuredDelay) && configuredDelay > 0 ? Math.ceil(configuredDelay) : 0,
  );
  return openAIError(
    429,
    {
      message:
        `M365 Copilot throttled this account${scope}: ${result.message ?? "too many requests"} ` +
        `Retrying immediately does not help; it is triggered by starting many new conversations in a short time.` +
        (retryAfter > 0
          ? ` The proxy recommends waiting ${retryAfter}s before retrying; M365 provides no reset time.`
          : ""),
      type: "rate_limit_error",
      code: "m365_throttled",
      param: result.errorCode ?? null,
      ...(retryAfter > 0 ? { retry_after: retryAfter } : {}),
    },
    retryAfter > 0 ? { "Retry-After": String(Math.ceil(retryAfter)) } : {},
  );
}

/** Empty upstream reply that is NOT an at-limit throttle — a distinct failure
 *  (content filter, invalid agent/session, transient error) we surface clearly
 *  instead of hanging on a long retry loop. */
function emptyResponseResponse(throttle: { current: number; max: number } | null): Response {
  const detail = throttle ? ` (throttle ${throttle.current}/${throttle.max})` : "";
  return openAIError(502, {
    message: `M365 Copilot returned an empty response${detail} — likely a content filter, an invalid agent/session, or a transient upstream error.`,
    type: "upstream_empty_response",
  });
}

function premiumOnlyModelResponse(model: string): Response {
  return jsonResponse(502, {
    error: {
      message: `M365 Copilot didn't serve ${model}: its only route (with the tool agent attached) returned InternalError on every attempt. ${model} is served only on a premium (paid Microsoft 365 Copilot) account; on any other account use claude-sonnet.`,
      type: "upstream_error",
      code: "model_route_unavailable",
    },
  });
}

// (streaming is emitted inline by the early-flushed SSE renderer in
// handleChatCompletion; the old streamText/streamToolCalls helpers were removed.)
