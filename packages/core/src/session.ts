import WebSocket from "ws";
import type { ImageAnnotation } from "./image-input.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  SignalRHandshakeResponse,
  DeltaUpdate,
  MessageUpdate,
  ThrottlingUpdate,
  CompletionFrame,
  CloseFrame,
  StreamHubDelta,
  StreamHubRequestEnd,
  StreamHubError,
} from "./schemas.js";
import {
  decodeJwt,
  getScenarioForModel,
  getStreamHubScenario,
  getToneForModel,
  getTransport,
  toneUsesWebSearch,
  type CopilotStream,
  type CapturedImage,
} from "./copilot.js";
import {
  parseActionConfirmation,
  buildResumeInvokeAction,
  shouldAutoConfirm,
  ACTION_ALLOWED_MESSAGE_TYPES,
} from "./native-actions.js";
import { createLogger, trunc, FRAME_DIR } from "./log.js";
import { recordThrottle, recordTurn } from "./turn-budget.js";
import { parseMetering, meteredAllowance, METERED_BUDGETS, type MeteredBudget } from "./priority-access.js";

const RS = "\x1E";
const log = createLogger("session");

// The exact frame the real m365.cloud.microsoft "Stop generating" button sends
// (captured June 2026, scripts/cancel-frame-capture.mjs). It's a normal type:1
// invocation with target "stop" and invocationId "1" (distinct from chat's "0"),
// sent on the same socket; the server acks with a type:3 completion and discards
// the partial answer. See docs/m365-copilot-api.md §6 and hypotheses.md F11.
const STOP_FRAME = JSON.stringify({ arguments: [{}], invocationId: "1", target: "stop", type: 1 }) + RS;

// Enabling these optionsSets unlocks M365's real server-side Python sandbox:
// the model writes and EXECUTES Python and returns true results (verified with a
// SHA-256 oracle — docs/hypotheses.md §8.9 / scripts/code-interpreter-probe.mjs).
// Applied only on the agent-less (plain-chat) path: the tool-calling agent wants
// the model to emit tool JSON, not run its own Python, so we leave that path
// untouched. Disable with M365_NO_CODE_INTERPRETER=1.
const CODE_INTERPRETER_OPTIONS_SETS = [
  "cwc_code_interpreter",
  "cwc_code_interpreter_amsfix",
  "cwc_code_interpreter_citation_fix",
  "code_interpreter_interactive_charts",
  "code_interpreter_matplotlib_patching",
];

// The image-generation optionsSets, lifted verbatim from the official web client
// capture (§14). `flux_v3` is BizChat's orchestration codename, NOT the model —
// artifacts come back DallE-named. The GUI sends this WHOLE set on every turn and
// lets the model pick the type from the prompt (standard / icon / story / designer
// dimensions), which is why "draw me X" works with no UI toggle — so we match it:
// send everything the GUI enables. Excludes only the GPT-V/upload family, which is
// image *input* (a separate capability), not generation. `…non_watermarked_storage`
// keeps the artifact unwatermarked.
const IMAGE_GEN_OPTIONS_SETS = [
  "cwc_flux_image",
  "cwc_flux_v3",
  "enable_gg_gpt",
  "flux_v3_progress_messages",
  "flux_v3_image_gen_enable_dimensions",
  "flux_v3_image_gen_enable_icon_dimensions",
  "flux_v3_image_gen_enable_story",
  "flux_v3_image_gen_enable_designer_dimensions_meta_prompting_in_system_prompts",
  "flux_v3_image_gen_enable_system_text_with_params",
  "flux_v3_image_gen_enable_non_watermarked_storage",
];

// --- Optional per-request frame dumping for reverse engineering ---
// Enabled by M365_DUMP_FRAMES=1. Every SignalR frame received is appended to a
// per-request NDJSON file under FRAME_DIR (~/.config/opencode-m365/frames/, or
// M365_FRAME_DIR). Cheap to run in production; gives us forensic data when M365
// starts emitting new fields.
const DUMP_FRAMES = !!process.env.M365_DUMP_FRAMES;
function dumpFrame(requestId: string, parsed: unknown, direction: "recv" | "send") {
  if (!DUMP_FRAMES) return;
  try {
    mkdirSync(FRAME_DIR, { recursive: true });
    appendFileSync(
      join(FRAME_DIR, `${requestId}.ndjson`),
      JSON.stringify({ t: Date.now(), dir: direction, frame: parsed }) + "\n",
    );
  } catch {
    // best effort
  }
}

const VARIANTS = [
  "EnableMcpServerWidgets",
  "feature.EnableMcpServerWidgets",
  "feature.EnableLuForChatCIQ",
  "feature.enableChatCIQPlugin",
  "EnableRequestPlugins",
  "feature.EnableSensitivityLabels",
  "EnableUnsupportedUrlDetector",
  "feature.IsCustomEngineCopilotEnabled",
  "feature.bizchatfluxv3",
  "feature.enablechatpages",
  "feature.enableCodeCanvas",
  "feature.turnOnWorkTabRecommendation",
  "turnOffWorkTabUpsellFromClient",
  "feature.turnOnDARecommendation",
  "feature.IsStreamingModeInChatRequestEnabled",
  "IncludeSourceAttributionsConcise",
  "SkipPublishEmptyMessage",
  "feature.EnableDeduplicatingSourceAttributions",
  "Enable3PActionProgressMessages",
  "feature.enableClientWebRtc",
  "feature.EnableMeetingRecapOfSeriesMeetingWithCiq",
  "feature.EnableReferencesListCompleteSignal",
  "feature.StorageMessageSplitDisabled",
  "feature.EnableCuaTakeControlApi",
  "feature.cwcallowedos",
  "feature.disabledisallowedmsgs",
  "feature.enableCitationsForSynthesisData",
  "feature.enableGenerateGraphicArtOptionsSet",
  "cdximagen",
  "feature.EnableUpdatedUXForConfirmationDialog",
  "feature.EnableClientFileURLSupportForOfficeWebPaidCopilot",
  "feature.EnableDesignEditorImageGrounding",
  "feature.EnableDesignerEditor",
  "feature.OfficeWebToHelix",
  "feature.OfficeDesktopToHelix",
  "feature.M365TeamsHubToHelix",
  "feature.OwaHubToHelix",
  "feature.MonarchHubToHelix",
  "feature.Win32OutlookHubToHelix",
  "feature.MacOutlookHubToHelix",
  "Agt_bizchat_enableGpt5ForHelix",
].join(",");

// StreamHub's own flags, from the new web client's 261. `streamhub11` turns on
// the items that bracket a turn (`request_start` … `answer_complete`,
// `request_end`): without it the answer streams but nothing ends the turn, and
// the socket idles on pings (2026-11-11). `feature.enablestreamhubstop` is the
// client's switch for its `stop` item.
const STREAMHUB_VARIANTS = `${VARIANTS},streamhub11,feature.enablestreamhubstop`;

// How long a StreamHub turn waits for `request_end` after its `EndOfRequest`
// message (it follows within milliseconds), before closing the socket anyway.
const STREAMHUB_END_GRACE_MS = 5_000;

/**
 * Fold one incoming piece of streamed text — a token DeltaUpdate (passed as
 * `answer + writeAtCursor`) or a full-text MessageUpdate snapshot — into the
 * running answer, returning the new answer and the suffix to stream (if any).
 *
 * M365 mixes token deltas with full-text snapshots, and the first token often
 * arrives ONLY as a snapshot, so naive delta concatenation drops the head. The
 * rules:
 *  - `next` no longer than the current answer → no growth, emit nothing.
 *  - `next` extends the current answer → advance and emit the appended suffix.
 *  - `next` is longer but DIVERGES (doesn't start with the current answer, e.g. a
 *    snapshot carrying a head the deltas never sent) → adopt it as authoritative
 *    for the buffered result but emit nothing: already-streamed bytes can't be
 *    retracted, so we never stream a non-prefix (which would dup/corrupt).
 * This keeps every emitted suffix a true prefix of the final answer.
 */
export function foldStreamText(
  answer: string,
  next: string,
): { answer: string; emit: string | null } {
  if (next.length <= answer.length) return { answer, emit: null };
  if (next.startsWith(answer)) return { answer: next, emit: next.slice(answer.length) };
  return { answer: next, emit: null };
}

/** The messageId a streaming `cursor` points at: `$['<id>'].adaptiveCards[0]…`. */
export function cursorMessageId(j: string | undefined): string | null {
  const m = j?.match(/^\$\['([^']+)'\]/);
  return m ? m[1] : null;
}

/** A request id as StreamHub may echo it: GUIDs compare without dashes or case. */
function normalizeRequestId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

// What M365's post-processing deletes from a reply: a bracketed word, a colon,
// and the whitespace after it.
const STRIPPED_TOKEN = /\[\w+\]:\s*/y;

/**
 * Undo M365's bracket stripping from the model's own text.
 *
 * A message's final text (its last snapshot) is M365's post-processed copy, and
 * that deletes `[word]:` plus the whitespace after it — inside code blocks too,
 * and not every time: `[regex]::Replace(` arrives as `:Replace(`, `if row[col]:`
 * plus the next line's indent as `if row` glued to that line, `{[key]: 1}` as
 * `{1}` (docs/hypotheses.md §40 F111). On Windows that turned an in-place
 * PowerShell edit into `$updated = :Replace(…)`, a `$null` that `Set-Content`
 * then wrote over the file. The token deltas carry what the model wrote.
 *
 * Given `raw`, the longest text the deltas built for a message (a prefix of
 * what the model wrote), and `final`, its final text: when the two differ only
 * by such deletions, returns `raw` plus whatever of `final` the deltas never
 * reached. Otherwise null.
 */
export function restoreStrippedBrackets(raw: string, final: string): string | null {
  let i = 0;
  let j = 0;
  while (i < raw.length && j < final.length) {
    if (raw[i] === final[j]) {
      i++;
      j++;
      continue;
    }
    STRIPPED_TOKEN.lastIndex = i;
    const m = STRIPPED_TOKEN.exec(raw);
    if (!m) return null;
    i += m[0].length;
  }
  for (STRIPPED_TOKEN.lastIndex = i; i < raw.length; STRIPPED_TOKEN.lastIndex = i) {
    const m = STRIPPED_TOKEN.exec(raw);
    if (!m) return null;
    i += m[0].length;
  }
  return raw + final.slice(j);
}

/**
 * Reassemble one turn's text from M365's PER-MESSAGE stream.
 *
 * A turn can carry several bot messages (distinct messageIds): Claude narrates
 * in one and writes its tool fence in the next, and Sonnet 5 interleaves text
 * with its own tool calls. Each message streams the same way — its first token
 * usually arrives only as a snapshot that carries a `cursor` naming the message,
 * then `writeAtCursor` deltas that carry NO messageId and extend whatever the
 * cursor last named, then a final snapshot.
 *
 * Folding all of that into ONE string (what foldStreamText alone did) loses the
 * head of every message after the first: the new message's head snapshot is
 * shorter than the accumulated answer, so it is dropped, and its deltas get
 * glued onto the previous message — `…the SECRET_CODE.bash\ngrep…`, a fence
 * with no opening backticks, so the tool call never parses (#29). Every
 * multi-message turn in the Sep 28 dumps was corrupted this way.
 *
 * Messages are kept separately and composed in order of first appearance,
 * separated by a blank line (they are separate bubbles in the real client).
 */
export class TurnTextComposer {
  private texts = new Map<string, string>();
  private target: string | null = null;
  // Per message: the run of deltas in progress (the text it started from, and
  // the deltas since), and the longest text a finished run built. The deltas
  // are the model's own text; see restoreStrippedBrackets.
  private runs = new Map<string, { base: string; deltas: string }>();
  private longestRun = new Map<string, string>();

  private endRun(key: string): void {
    const run = this.runs.get(key);
    this.runs.delete(key);
    if (!run?.deltas) return;
    const built = run.base + run.deltas;
    if (built.length > (this.longestRun.get(key)?.length ?? 0)) this.longestRun.set(key, built);
  }

  /** A cursor frame: subsequent deltas extend message `id`. */
  cursor(id: string): void {
    this.target = id;
  }

  /** A full-text snapshot of one message. Before any cursor has been seen, the
   *  snapshot's message also becomes the delta target (older frame shapes). */
  snapshot(id: string | undefined, text: string): void {
    const key = id ?? this.target ?? "";
    if (this.target === null) this.target = key;
    this.endRun(key);
    this.texts.set(key, foldStreamText(this.texts.get(key) ?? "", text).answer);
  }

  /** A token delta for the message the cursor last named. */
  delta(text: string): void {
    const key = this.target ?? "";
    const current = this.texts.get(key) ?? "";
    const run = this.runs.get(key) ?? { base: current, deltas: "" };
    run.deltas += text;
    this.runs.set(key, run);
    this.texts.set(key, current + text);
  }

  /** A StreamHub cursor frame: message `id` now reads exactly `text`, and the
   *  following deltas extend it. StreamHub restates a message at each cursor,
   *  usually empty, and then re-sends its whole text as deltas, so folding the
   *  restatement in (as `snapshot` does) would duplicate the message. */
  restart(id: string, text: string): void {
    this.target = id;
    this.endRun(id);
    this.texts.set(id, text);
  }

  get text(): string {
    return [...this.texts.values()].filter((t) => t.length > 0).join("\n\n");
  }

  /** The turn's text once it has ended: `text`, with what M365's
   *  post-processing stripped from a message put back from its deltas
   *  (restoreStrippedBrackets) wherever they line up. */
  get finalText(): string {
    return [...this.texts.entries()]
      .map(([key, text]) => {
        const run = this.runs.get(key);
        const open = run?.deltas ? run.base + run.deltas : "";
        const kept = this.longestRun.get(key) ?? "";
        const raw = open.length > kept.length ? open : kept;
        return raw ? (restoreStrippedBrackets(raw, text) ?? text) : text;
      })
      .filter((t) => t.length > 0)
      .join("\n\n");
  }
}

/**
 * Attach a native custom action/plugin to a conversation and drive the confirm→invoke
 * round-trip over the WS (docs/hypotheses.md §12.6, H-NATIVE-6/7). All fields are
 * best-effort passthroughs modelled on the decompiled client; the exact inline-def
 * schema still wants a live `SEND_MSG=1` capture, so run with M365_DUMP_FRAMES=1 to
 * see what the server actually does and refine.
 */
export interface NativeActionConfig {
  /** Inline agent definitions (`gptDefinitions[]`) — the no-sideload agent attach. */
  gptDefinitions?: unknown[];
  /** `clientOverrides.capabilities[]` entries (e.g. {name:"RegisteredPlugins", plugins:[…]}). */
  capabilities?: unknown[];
  /** `plugins[]` entries ({Id, Source, Data?}). Merged even when an agent is attached. */
  plugins?: unknown[];
  /** Approve consequential (state-mutating) actions too. Default: only read-only ones. */
  autoConfirmAll?: boolean;
}

/** Per-turn chat options. */
export interface ChatTurnOptions {
  /** Request server-side image generation for this turn (§14). Adds the flux
   *  optionsSets + the GenerateGraphicArt allowedMessageType; the generated
   *  images surface on `stream.images`. Agent-less only. */
  generateImages?: boolean;
  /** Uploaded images this turn's message points at (image-input.ts). */
  images?: ImageAnnotation[];
}

export interface CopilotSessionOptions {
  agentId?: string;
  /** Reuse an existing session ID across reconnections. */
  sessionId?: string;
  /** Reuse an existing conversation ID so M365 finds the same server-side conversation. */
  conversationId?: string;
  /**
   * Ask M365 for a temporary chat by adding `disableMemory=1` to the Chathub URL.
   * Temporary chats retain context for their live ConversationId but are not
   * added to the Copilot history sidebar. Default: true.
   */
  temporaryChat?: boolean;
  /** Enable native custom-action support (H-NATIVE-6/7). Off = unchanged behaviour. */
  nativeActions?: NativeActionConfig;
}

/**
 * Build the authenticated Chathub URL. Kept as a pure helper so privacy-critical
 * query flags can be verified without opening a network connection.
 */
export function buildCopilotWebSocketUrl(
  objectId: string,
  tenantId: string,
  params: URLSearchParams,
): string {
  return `wss://substrate.office.com/m365Copilot/Chathub/${objectId}@${tenantId}?${params}`;
}

/**
 * Headers for the Chathub WebSocket upgrade.
 *
 * `X-RoutingParameter-SessionKey` pins every turn of a conversation to one
 * backend. Each turn is a new connection, and without the key the Substrate
 * front end spreads them over pods in two regions (`x-calculatedbetarget`:
 * 4–6 distinct in 6 handshakes on one ConversationId, Switzerland North and
 * Sweden Central), which keep separate copies of the conversation. The model
 * then answers from whichever copy the turn landed on: in real pi runs 53% of
 * turns ran on an older copy, missing the model's own earlier calls and their
 * results (docs/hypotheses.md F85). With the key: 1 backend in 6. The query-string form
 * doesn't pin. M365_NO_SESSION_ROUTING=1 leaves it out.
 */
export function buildCopilotWebSocketHeaders(conversationId: string): Record<string, string> {
  return {
    "Origin": "https://m365.cloud.microsoft",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    ...(process.env.M365_NO_SESSION_ROUTING ? {} : { "X-RoutingParameter-SessionKey": conversationId }),
  };
}

/**
 * The StreamHub URL: the chat transport of the new web client
 * (copilot.cloud.microsoft). Same SignalR JSON protocol as Chathub, but the chat
 * goes up as a `chat_request` stream item and the answer comes back as
 * `message_part` items on a server stream (docs/m365-copilot-api.md §13).
 */
export function buildStreamHubUrl(
  objectId: string,
  tenantId: string,
  params: URLSearchParams,
): string {
  return `wss://substrate.svc.cloud.microsoft/m365Copilot/StreamHub/${objectId}@${tenantId}?${params}`;
}

/**
 * The StreamHub query string, in the new web client's order and with its values.
 * A browser can't put headers on a WebSocket, so the routing key travels here,
 * and the client keys it on the user (`oid`), not the conversation.
 * `disableMemory=1` makes it a temporary chat, as on Chathub.
 */
export function buildStreamHubParams(o: {
  requestId: string;
  objectId: string;
  sessionId: string;
  token: string;
  temporaryChat: boolean;
  scenario: string;
  licenseType: string;
}): URLSearchParams {
  const params = new URLSearchParams({
    chatsessionid: o.requestId,
    XRoutingParameterSessionKey: o.objectId,
    clientrequestid: o.requestId,
    "X-SessionId": o.sessionId,
  });
  if (o.temporaryChat) params.set("disableMemory", "1");
  params.set("access_token", o.token);
  params.set("variants", STREAMHUB_VARIANTS);
  params.set("source", "officeweb");
  params.set("product", "Office");
  params.set("agentHost", "Bizchat.FullScreen");
  params.set("licenseType", o.licenseType);
  params.set("isEdu", "false");
  params.set("agent", "work");
  params.set("scenario", o.scenario);
  return params;
}

/** Headers for the StreamHub upgrade: the new web client's origin and browser. */
export function buildStreamHubHeaders(): Record<string, string> {
  return {
    "Origin": "https://copilot.cloud.microsoft",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
  };
}

/**
 * A persistent conversation session with M365 Copilot.
 * Reuses the same sessionId/conversationId across turns,
 * reconnecting the WebSocket for each message.
 */
export class CopilotSession {
  private sessionId: string;
  private conversationId: string;
  private _turnCount = 0;
  private agentId?: string;
  private nativeActions?: NativeActionConfig;
  private temporaryChat: boolean;

  constructor(options?: CopilotSessionOptions) {
    this.sessionId = options?.sessionId ?? crypto.randomUUID();
    this.conversationId = options?.conversationId ?? crypto.randomUUID();
    this.agentId = options?.agentId;
    this.nativeActions = options?.nativeActions;
    this.temporaryChat = options?.temporaryChat ?? true;
    log.info(`New session: sid=${this.sessionId}, cid=${this.conversationId}, agent=${this.agentId ?? "none"}, nativeActions=${!!this.nativeActions}, temporaryChat=${this.temporaryChat}`);
  }

  /** Number of turns completed in this session */
  get turnCount(): number {
    return this._turnCount;
  }

  /**
   * Send a message in this conversation and stream the response.
   * Each turn opens a fresh WebSocket with invocationId "0" (per SignalR protocol).
   * Session/conversation IDs are reused so M365 maintains server-side context.
   */
  chat(token: string, text: string, model: string = "m365-copilot", signal?: AbortSignal, opts?: ChatTurnOptions): Promise<CopilotStream> {
    const isFirst = this._turnCount === 0;
    this._turnCount++;
    const wantImages = opts?.generateImages ?? false;
    const images = opts?.images ?? [];

    log.info(`Chat turn ${this._turnCount - 1}: model=${model}, isFirst=${isFirst}, text=${JSON.stringify(trunc(text, 200))}`);
    recordTurn(); // the throttle-avoidance bucket counts what that line counts (turn-budget.ts)

    const claims = decodeJwt(token);
    const requestId = crypto.randomUUID();

    // Resolve the tone ONCE and derive the connection's entitlement from the
    // MODEL (not the tone alone). `scenario` is not cosmetic: the same
    // `Claude_Sonnet` tone is Sonnet 4.6 on the default `OfficeWebIncludedCopilot`
    // and Sonnet 5.5 on `OfficeWebPaidCopilot`, the same `Claude_Opus` tone Opus
    // 4.8 (premium only) and Opus 5.5, and some tones (`Gpt_6_Reasoning`) serve on
    // the paid one only.
    // See getScenarioForModel / docs §5.
    const tone = getToneForModel(model);
    const transport = getTransport();
    const streamHub = transport === "streamhub";
    const { scenario, licenseType } = streamHub ? getStreamHubScenario() : getScenarioForModel(model);
    log.info(`Routing: tone=${tone}, scenario=${scenario}, licenseType=${licenseType}, transport=${transport}`);

    const params = streamHub
      ? buildStreamHubParams({
          requestId,
          objectId: claims.oid,
          sessionId: this.sessionId,
          token,
          temporaryChat: this.temporaryChat,
          scenario,
          licenseType,
        })
      : new URLSearchParams({
          chatsessionid: requestId,
          clientrequestid: requestId,
          "X-SessionId": this.sessionId,
          ConversationId: this.conversationId,
          access_token: token,
          variants: VARIANTS,
          source: '"officeweb"',
          product: "Office",
          agentHost: "Bizchat.FullScreen",
          licenseType,
          agent: "web",
          scenario,
        });

    if (this.temporaryChat && !streamHub) params.set("disableMemory", "1");

    const wsUrl = streamHub
      ? buildStreamHubUrl(claims.oid, claims.tid, params)
      : buildCopilotWebSocketUrl(claims.oid, claims.tid, params);
    const agentId = streamHub ? undefined : this.agentId;
    const sessionId = this.sessionId;
    const conversationId = this.conversationId;
    const nativeActions = streamHub ? undefined : this.nativeActions;
    if (streamHub && (this.agentId || this.nativeActions)) {
      log.info("StreamHub carries no declarative agent or native actions: sending this turn agent-less");
    }

    return new Promise((resolve, reject) => {
      // The authoritative reconstructed answer. M365 streams a MIX of token-level
      // DeltaUpdates and full-text MessageUpdate snapshots (empirically the FIRST
      // token often arrives only as a snapshot, not a delta), across one or more
      // bot MESSAGES per turn — so text is assembled per message (`composer`) and
      // the composed whole folded into this string. See `advance`.
      let answer = "";
      const composer = new TurnTextComposer();
      let receivedContent = false;
      let throttleInfo: { current: number; max: number } | null = null;
      let contentOrigin: string | null = null;
      let sawApology = false;
      let messageType: string | null = null;
      let messageId: string | null = null;
      // Highest per-component score across all messages this turn. The most
      // recent score isn't necessarily the most informative — the worst one is.
      const maxScores: Record<string, number> = {};
      let turnCountServer: number | null = null;
      let turnState: string | null = null;
      // The final type:2 item's `result` — `{value: "Success"}` normally, and
      // `{value: "Throttled", errorCode: "PerUserThrottled", message}` when the
      // account is rate-limited: the turn then carries NO content frames, only a
      // BotConnection apology inside that item (#35).
      let serverResult: { value: string; errorCode?: string; message?: string } | null = null;
      // The final item's `throttling.metering` (priority-access allowances, §24 F55).
      let metering: Record<string, number> | null = null;
      // Generated images captured this turn (§14). Keyed by fileToken so the
      // repeated progress snapshots for one image collapse to a single entry.
      const imagesByToken = new Map<string, CapturedImage>();
      // Native-action round-trip state (H-NATIVE-6). `baseArgs` is the sent chat
      // envelope's arguments[0], reused verbatim (minus `message`) to resume an
      // action. `sawAction` records that the model triggered a custom action this
      // turn; `actionResumed` guards against double-resuming the same trigger.
      let baseArgs: Record<string, unknown> | null = null;
      let sawAction = false;
      let actionResumed = false;

      // Delta pump. The queue/state live at Promise scope (NOT inside the
      // asyncIterator factory) so deltas that arrive between `resolve(stream)` and
      // the consumer starting to iterate are buffered instead of dropped — the
      // early-token loss that made true incremental streaming lossy. onDelta/onDone/
      // onError are wired once here, so they never depend on iteration having begun.
      const queue: string[] = [];
      let streamDone = false;
      let streamError: Error | null = null;
      let waiting: {
        resolve: (result: IteratorResult<string>) => void;
        reject: (err: Error) => void;
      } | null = null;

      const onDelta = (text: string) => {
        if (waiting) {
          const w = waiting;
          waiting = null;
          w.resolve({ value: text, done: false });
        } else {
          queue.push(text);
        }
      };
      const onDone = () => {
        streamDone = true;
        if (waiting) {
          const w = waiting;
          waiting = null;
          w.resolve({ value: undefined as any, done: true });
        }
      };
      const onError = (err: Error) => {
        streamError = err;
        streamDone = true;
        if (waiting) {
          const w = waiting;
          waiting = null;
          w.reject(err);
        }
      };

      // Pull any generated images off a bot message. The GraphicArt frame arrives
      // repeatedly as a Progress snapshot (status climbs to 2 = ready) and again in
      // the final type:2 item, so we upsert by fileToken and keep the readiest copy.
      const captureImages = (m: any) => {
        const list = m?.contentGenerationProgressList;
        if (!Array.isArray(list)) return;
        for (const entry of list) {
          const urls = entry?.ImageReferenceUrls;
          if (!Array.isArray(urls) || urls.length === 0) continue;
          const key = entry.fileToken ?? urls[0];
          const prev = imagesByToken.get(key);
          if (prev && (prev.status ?? 0) >= (entry.status ?? 0)) continue;
          imagesByToken.set(key, {
            referenceUrls: urls,
            fileToken: entry.fileToken,
            pollUrl: entry.pollUrl,
            size: entry.size,
            orientation: entry.orientation,
            status: entry.status,
          });
        }
      };

      // Fold a token delta OR a full-text snapshot into `answer` and stream the
      // newly-appended suffix (see foldStreamText for the prefix-safe rules).
      // `streamed` is everything handed to the stream so far.
      let streamed = "";
      const advance = (next: string) => {
        const r = foldStreamText(answer, next);
        if (r.answer !== answer) {
          answer = r.answer;
          receivedContent = true;
        }
        if (r.emit) {
          streamed += r.emit;
          onDelta(r.emit);
        }
      };

      const stream: CopilotStream = {
        get fullText() {
          return answer;
        },
        get hasContent() {
          return receivedContent;
        },
        get throttle() {
          return throttleInfo;
        },
        get contentOrigin() {
          return contentOrigin;
        },
        get apology() {
          return sawApology;
        },
        get messageType() {
          return messageType;
        },
        get messageId() {
          return messageId;
        },
        get scores() {
          return Object.keys(maxScores).length ? { ...maxScores } : null;
        },
        get turnCount() {
          return turnCountServer;
        },
        get turnState() {
          return turnState;
        },
        get result() {
          return serverResult;
        },
        get metering() {
          return metering;
        },
        get images() {
          return [...imagesByToken.values()];
        },
        get sawAction() {
          return sawAction;
        },

        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<string>> {
              // Drain buffered deltas BEFORE surfacing done/error, so a fast turn
              // that finished before iteration began still yields all its text.
              if (queue.length > 0) {
                return Promise.resolve({ value: queue.shift()!, done: false });
              }
              if (streamError) return Promise.reject(streamError);
              if (streamDone) {
                return Promise.resolve({ value: undefined as any, done: true });
              }
              return new Promise((res, rej) => {
                waiting = { resolve: res, reject: rej };
              });
            },
          };
        },
      };

      const ws = new WebSocket(wsUrl, {
        headers: streamHub ? buildStreamHubHeaders() : buildCopilotWebSocketHeaders(conversationId),
      });

      let handshakeDone = false;
      let stopped = false;

      // StreamHub frames go up as stream items of the client stream ("0").
      const sendItem = (item: Record<string, unknown>) => {
        const frame = { invocationId: "0", item: { ...item, noteId: crypto.randomUUID() }, type: 2 };
        dumpFrame(requestId, frame, "send");
        ws.send(JSON.stringify(frame) + RS);
      };

      // Once the turn ends the composer is authoritative: StreamHub restates a
      // message and re-sends its text (TurnTextComposer.restart), so its final
      // text can differ from what the streaming fold kept, and on either
      // transport the deltas restore what M365's post-processing stripped from
      // the final snapshot (restoreStrippedBrackets). The part of it the stream
      // hasn't carried yet goes out as one last delta, when it extends what did.
      const settleAnswer = () => {
        const final = composer.finalText;
        if (final !== composer.text) log.info("Restored text M365 stripped from the final snapshot ([word]: tokens) from the deltas");
        if (!final || final === answer) return;
        answer = final;
        receivedContent = true;
        if (final.length > streamed.length && final.startsWith(streamed)) {
          const rest = final.slice(streamed.length);
          streamed = final;
          onDelta(rest);
        }
      };

      // Safety net for a StreamHub turn whose `request_end` never comes (see
      // STREAMHUB_VARIANTS): close shortly after its `EndOfRequest` message.
      let endGrace: ReturnType<typeof setTimeout> | null = null;
      const armEndGrace = () => {
        if (endGrace) return;
        endGrace = setTimeout(() => {
          log.info(`StreamHub: no request_end ${STREAMHUB_END_GRACE_MS} ms after EndOfRequest — closing`);
          try { ws.close(); } catch {}
        }, STREAMHUB_END_GRACE_MS);
      };

      // Cancellation: when the caller's signal aborts (HTTP client disconnected),
      // cancel the in-flight M365 turn the same way the real UI does — send the
      // Stop frame, then let the server's type:3 ack close the socket (with a
      // hard-close fallback). Before the handshake completes there's nothing to
      // stop, so just close. StreamHub's stop is a `stop` item naming the turn.
      const onAbort = () => {
        if (stopped) return;
        stopped = true;
        try {
          if (ws.readyState === WebSocket.OPEN && handshakeDone) {
            log.info("Aborted — sending Stop frame to cancel the turn");
            if (streamHub) {
              sendItem({
                type: "stop",
                topicId: `/conversations/${conversationId}`,
                turnId: requestId,
                requestId,
                reason: "ClientRequested",
              });
            } else {
              dumpFrame(requestId, { target: "stop", type: 1 }, "send");
              ws.send(STOP_FRAME);
            }
            setTimeout(() => { try { ws.close(); } catch {} }, 2_000);
          } else {
            try { ws.close(); } catch {}
          }
        } catch {
          try { ws.close(); } catch {}
        }
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      const clearAbort = () => signal?.removeEventListener("abort", onAbort);

      ws.on("open", () => {
        log.debug("WS connected, sending handshake");
        ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
      });

      ws.on("message", (data: WebSocket.RawData) => {
        const raw = data.toString();
        log.debug("WS recv:", trunc(raw, 500));
        const frames = raw.split(RS).filter((f) => f.length > 0);

        for (const frame of frames) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(frame);
          } catch {
            if (!handshakeDone) {
              handshakeDone = true;
              sendChat();
            }
            continue;
          }
          dumpFrame(requestId, parsed, "recv");

          if (!handshakeDone) {
            handshakeDone = true;
            const hs = SignalRHandshakeResponse.safeParse(parsed);
            if (hs.success && hs.data.error) {
              ws.close();
              reject(new Error(`Handshake error: ${hs.data.error}`));
              return;
            }
            sendChat();
            continue;
          }

          handleMsg(parsed);
        }
      });

      ws.on("error", (err: Error) => {
        const msg = err.message || "connection failed";
        log.error("WS error:", msg);
        if (!handshakeDone) {
          reject(new Error(`WebSocket error: ${msg}`));
        } else {
          onError(new Error(`WebSocket error: ${msg}`));
        }
      });

      ws.on("close", () => {
        clearAbort();
        if (endGrace) clearTimeout(endGrace);
        settleAnswer();
        log.info("WS closed, answer length:", answer.length);
        log.debug("Final response:", trunc(answer, 1000));
        onDone();
      });

      const sendChat = () => {
        const args = {
              source: "officeweb",
              clientCorrelationId: requestId,
              sessionId,
              // Code interpreter on the agent-less path only (see const above).
              // M365_EXTRA_OPTIONSSETS (comma-sep) merges in on ANY path — used to
              // test whether matching the official GUI's rich optionsSets stops the
              // agent-path "replace X→Y" Disengage (F17/F21). The GUI sends a rich
              // set + NO agent; we send [] + agent and Disengage.
              optionsSets: [
                ...((!agentId && !process.env.M365_NO_CODE_INTERPRETER) ? CODE_INTERPRETER_OPTIONS_SETS : []),
                ...(wantImages ? IMAGE_GEN_OPTIONS_SETS : []),
                ...(process.env.M365_EXTRA_OPTIONSSETS ? process.env.M365_EXTRA_OPTIONSSETS.split(",").map((s) => s.trim()).filter(Boolean) : []),
              ],
              streamingMode: "ConciseWithPadding",
              spokenTextMode: "None",
              options: {},
              extraExtensionParameters: {},
              allowedMessageTypes: [
                "Chat",
                "Suggestion",
                "InternalSearchQuery",
                "Disengaged",
                "InternalLoaderMessage",
                "Progress",
                "RenderCardRequest",
                "SemanticSerp",
                "GenerateContentQuery",
                "SearchQuery",
                "ConfirmationCard",
                "DeveloperLogs",
                "EndOfRequest",
                "ReferencesListComplete",
                "GeneratedCode",        // code-interpreter execution frames
                // Image generation (§14): the server only SENDS the GraphicArt
                // frame if the client declares it can handle it — same
                // declare-to-receive rule as native actions.
                ...(wantImages ? ["GenerateGraphicArt"] : []),
                // Native custom-action vocabulary (H-NATIVE-6): the server only
                // SENDS these trigger frames if the client says it can handle them.
                ...(nativeActions ? ACTION_ALLOWED_MESSAGE_TYPES : []),
              ],
              sliceIds: [] as string[],
              threadLevelGptId: agentId
                ? { id: agentId, source: "MOS3" }
                : {},
              traceId: requestId,
              isStartOfSession: isFirst,
              clientInfo: {
                clientPlatform: "mcmcopilot-web",
                clientAppName: "Office",
                clientEntrypoint: "mcmcopilot-officeweb",
                clientSessionId: sessionId,
                clientAppType: "Web",
                deviceOS: "Linux",
                deviceType: "Desktop",
              },
              message: {
                author: "user",
                inputMethod: "Keyboard",
                text,
                entityAnnotationTypes: [
                  "People",
                  "File",
                  "Event",
                  "Email",
                  "TeamsMessage",
                ],
                requestId,
                locationInfo: { timeZoneOffset: 1, timeZone: "Europe/Copenhagen" },
                locale: "en-gb",
                messageType: "Chat",
                experienceType: "Default",
                adaptiveCards: [] as any[],
                clientPreferences: {},
                ...(images.length ? { messageAnnotations: images } : {}),
              },
              ...(agentId
                ? {
                    gpts: [{
                      id: agentId,
                      source: "MOS3",
                      version: "1.0.0",
                      clientOverrides: {
                        // The real capability channel (H8.2/H8.3/H8.7) — RegisteredPlugins,
                        // ScenarioModels, CodeInterpreter, … ride here per the decompile.
                        capabilities: nativeActions?.capabilities ?? [],
                        "deepResearchModels@odata.type": "Collection(String)",
                      },
                    }],
                  }
                : {}),
              // Inline agent definition — attach a custom action WITHOUT sideloading
              // through Teams/Graph (H-NATIVE-7). Best-effort schema from the decompile;
              // run with M365_DUMP_FRAMES=1 to see what the server accepts.
              ...(nativeActions?.gptDefinitions ? { gptDefinitions: nativeActions.gptDefinitions } : {}),
              // plugins[]: an explicit native-action list wins; otherwise Bing on the
              // plain (agent-less) path only, exactly as before — unless Bing pushes
              // this tone over its input limit on this account (toneUsesWebSearch).
              ...(nativeActions?.plugins
                ? { plugins: nativeActions.plugins }
                : (!agentId ? { plugins: toneUsesWebSearch(tone) ? [{ Id: "BingWebSearch", Source: "BuiltIn" }] : [] } : {})),
              // Skill flags that gate the action/confirmation flow — the real client
              // sends these in the chat payload (bundle 8af68b68f4a2 destructure at
              // :9373-9378 → payload :11111). Without them the server has no reason to
              // run the confirmation-dialog / auto-invoke skills, so an attached action
              // never triggers. Only sent on the native-action path.
              ...(nativeActions
                ? {
                    enableConfirmationDialogSkill: true,
                    enableAgentAutoInvoke: true,
                    enableMsgExtAuthSkill: true,
                    enablePPCAuthSkill: true,
                  }
                : {}),
              isSbsSupported: true,
              tone,
              renderReferencesBehindEOS: true,
              disconnectBehavior: "continue",
        };
        baseArgs = args;
        if (streamHub) {
          sendStreamHubChat(args);
          resolve(stream);
          return;
        }
        const chatMsg = {
          arguments: [args],
          invocationId: "0",
          target: "chat",
          type: 4,
        };

        const metrics = {
          arguments: [
            {
              Timestamps: {
                ConnectionStart: new Date().toISOString(),
                UserInputStart: new Date().toISOString(),
                ConnectionEstablished: new Date().toISOString(),
                UserInputSubmit: new Date().toISOString(),
              },
            },
          ],
          target: "Metrics",
          type: 1,
        };

        const payload = JSON.stringify(chatMsg) + RS + JSON.stringify(metrics) + RS;
        log.debug("WS send:", trunc(payload, 500));
        dumpFrame(requestId, chatMsg, "send");
        dumpFrame(requestId, metrics, "send");
        ws.send(payload);
        resolve(stream);
      };

      // StreamHub, in the new web client's order: a ping, the server stream
      // (invocation "1", fed by client stream "0"), the conversation's topic,
      // then the chat itself. The client subscribes with `action: "create"` on
      // every fresh socket, a resumed conversation included (2026-11-11 capture);
      // without it a follow-up turn got no answer at all. The request is the web
      // client's shape, with this turn's optionsSets, message types, plugins and
      // tone; the agent fields stay off (no agent).
      const sendStreamHubChat = (args: { optionsSets: string[]; allowedMessageTypes: string[]; plugins?: unknown[]; message: Record<string, unknown> }) => {
        const topicId = `/conversations/${conversationId}`;
        const clientInfo = {
          clientPlatform: "ccmcopilot-web",
          clientAppName: "Office",
          clientEntrypoint: "ccmcopilot-officeweb",
          clientSessionId: sessionId,
          ProductCategory: "Chat",
          clientAppType: "Web",
          productEntryPoint: "ChatPanel",
          deviceOS: "Windows",
          deviceType: "Desktop",
          clientPlatformVersion: "10",
        };
        const { entityAnnotationTypes: _e, experienceType: _x, ...message } = args.message;
        const chatStreamRequest = {
          source: "officeweb",
          optionsSets: args.optionsSets,
          streamingMode: "ConciseV2",
          options: {},
          extraExtensionParameters: {},
          allowedMessageTypes: args.allowedMessageTypes,
          sliceIds: [] as string[],
          threadLevelGptId: {},
          conversationId,
          requestId,
          traceId: requestId,
          isStartOfSession: isFirst,
          clientInfo,
          message: { ...message, locale: "en-us", clientInfo },
          gpts: [{ id: "bizchat-as-gpt-scenario", source: "BuiltInAgents" }],
          plugins: args.plugins ?? [],
          tone,
          disconnectBehavior: "continue",
        };
        const ping = { type: 6 };
        const open = { arguments: [], invocationId: "1", streamIds: ["0"], target: "stream", type: 4 };
        dumpFrame(requestId, ping, "send");
        dumpFrame(requestId, open, "send");
        ws.send(JSON.stringify(ping) + RS + JSON.stringify(open) + RS);
        sendItem({ type: "subscribe", topicId, action: "create" });
        sendItem({ type: "chat_request", chatStreamRequest, topicId });
        log.debug("StreamHub chat_request sent:", trunc(JSON.stringify(chatStreamRequest), 500));
      };

      // When the model triggers a native custom action, the server sends a
      // confirmation TRIGGER (an adaptive card) and waits for us to approve it on
      // THIS socket. We reuse the exact chat envelope (baseArgs) with a
      // ResumeInvokeAction message, so the server-side orchestrator makes the real
      // outbound call (H-NATIVE-6). Returns true if it sent a resume (⇒ keep socket
      // open for the result). No-op unless native actions are enabled.
      const maybeResumeAction = (m: unknown): boolean => {
        if (!nativeActions || actionResumed || !baseArgs) return false;
        const conf = parseActionConfirmation(m as any);
        if (!conf) return false;
        sawAction = true;
        if (!shouldAutoConfirm(conf, { autoConfirmAll: nativeActions.autoConfirmAll })) {
          log.info(`Native action ${conf.actionId} is consequential; autoConfirmAll off — not resuming`);
          return false;
        }
        actionResumed = true;
        const resumeArgs = { ...baseArgs, message: buildResumeInvokeAction(conf) };
        const frame = { arguments: [resumeArgs], invocationId: "0", target: "chat", type: 4 };
        dumpFrame(requestId, frame, "send");
        log.info(`Native action: auto-confirming actionId=${conf.actionId} via ResumeInvokeAction`);
        try { ws.send(JSON.stringify(frame) + RS); } catch (e) { log.error("resume send failed:", (e as Error).message); }
        return true;
      };

      // A `throttling` block (Chathub's final item, a StreamHub message_part): the
      // message cap, and the priority-access allowances in `metering` (§24 F55).
      const noteThrottling = (t: any) => {
        throttleInfo = { current: t.numUserMessagesInConversation, max: t.maxNumUserMessagesInConversation };
        metering = parseMetering(t.metering);
        for (const [budget, { label }] of Object.entries(METERED_BUDGETS)) {
          const left = meteredAllowance(metering, budget as MeteredBudget);
          if (left) log.info(`${label} priority access left: ${left.daily ?? "?"} today, ${left.weekly ?? "?"} this week`);
        }
      };

      const noteResult = (value: string, errorCode?: string, message?: string) => {
        serverResult = {
          value,
          ...(errorCode ? { errorCode } : {}),
          ...(message ? { message } : {}),
        };
        if (value !== "Success") log.info(`Turn result: ${value}${errorCode ? ` (${errorCode})` : ""}`);
        if (value === "Throttled") recordThrottle();
      };

      // One streaming update: a Chathub `update` invocation's argument, or a
      // StreamHub `message_part` item's.
      const handleUpdateArg = (arg: unknown) => {
        const delta = DeltaUpdate.safeParse(arg);
        if (delta.success) {
          composer.delta(delta.data.writeAtCursor);
          advance(composer.text);
          return;
        }
        if (streamHub) {
          const w = StreamHubDelta.safeParse(arg);
          if (w.success) {
            composer.delta(w.data.w);
            advance(composer.text);
            return;
          }
        }

        const msgUpdate = MessageUpdate.safeParse(arg);
        if (msgUpdate.success) {
          // A cursor names the message that the following deltas extend.
          const cursorId = cursorMessageId(msgUpdate.data.cursor?.j);
          if (cursorId) composer.cursor(cursorId);
          for (const m of msgUpdate.data.messages) {
            // Capture diagnostic meta from every bot message — including the
            // control-typed ones — so callers can tell apart `DeepLeo` from
            // `3PDeclarativeAgent` and surface `Disengaged` cleanly.
            if (m.author === "bot") {
              captureImages(m);
              if (m.contentOrigin) contentOrigin = m.contentOrigin;
              if (m.contentOrigin === "Apology") sawApology = true;
              if (m.messageType) messageType = m.messageType;
              if (m.messageId) messageId = m.messageId;
              if (m.scores) {
                for (const s of m.scores) {
                  if (!(s.component in maxScores) || s.score > maxScores[s.component]) {
                    maxScores[s.component] = s.score;
                  }
                }
              }
              if (typeof m.turnCount === "number") turnCountServer = m.turnCount;
              if (m.turnState) turnState = m.turnState;
              // A confirmation TRIGGER for a native action arrives here as a
              // messageType'd bot frame (which the plain-chat path drops). Detect
              // it and auto-approve on the same socket (H-NATIVE-6).
              maybeResumeAction(m);
            }
            if (m.author !== "bot" || m.messageType || typeof m.text !== "string") continue;
            if (streamHub && cursorId && m.messageId === cursorId) {
              composer.restart(cursorId, m.text);
              advance(composer.text);
            } else if (m.text) {
              composer.snapshot(m.messageId, m.text);
              advance(composer.text);
            }
          }
          return;
        }

        const throttle = ThrottlingUpdate.safeParse(arg);
        if (throttle.success) {
          const t = throttle.data.throttling;
          if (streamHub) noteThrottling((arg as { throttling: unknown }).throttling);
          else throttleInfo = { current: t.numUserMessagesInConversation, max: t.maxNumUserMessagesInConversation };
          log.info(`Throttle: ${t.numUserMessagesInConversation}/${t.maxNumUserMessagesInConversation} messages`);
        }
      };

      // StreamHub server items (invocation "1"). `message_part` carries what a
      // Chathub `update` did; `request_end` ends the turn where Chathub's final
      // type:2 item did; an `error` item is a rejected note, after which the
      // server holds the socket open for two minutes, so close it here.
      // `network_info`, `request_pending`, `request_start` and `answer_complete`
      // carry nothing the proxy uses.
      const handleStreamHubItem = (item: unknown) => {
        const type = (item as { type?: unknown } | undefined)?.type;
        // Subscribing to a conversation's topic replays its earlier turns' items,
        // `request_end` included: keep to this turn's.
        const itemRequestId = (item as { requestId?: unknown } | undefined)?.requestId;
        if (typeof itemRequestId === "string" && normalizeRequestId(itemRequestId) !== normalizeRequestId(requestId)) {
          log.debug(`StreamHub: skipping a replayed ${String(type)} of request ${itemRequestId}`);
          return;
        }
        if (type === "message_part") {
          const arg = (item as { argument?: unknown }).argument;
          if (!arg || typeof arg !== "object") return;
          // `author: null`, so MessageUpdate doesn't parse it: check it raw.
          const messages = (arg as { messages?: unknown }).messages;
          if (Array.isArray(messages) && messages.some((m) => (m as { messageType?: unknown } | null)?.messageType === "EndOfRequest")) {
            armEndGrace();
          }
          handleUpdateArg(arg);
          return;
        }
        if (type === "request_end") {
          const end = StreamHubRequestEnd.safeParse(item);
          const outcome = end.success ? end.data.outcome : undefined;
          if (outcome && !serverResult) noteResult(outcome.category, outcome.errorCode ?? outcome.code, outcome.message);
          ws.close();
          return;
        }
        if (type === "error") {
          const err = StreamHubError.safeParse(item);
          const e: { errorCategory?: string; errorCode?: string; message?: string; detail?: string } = err.success ? err.data : {};
          log.info(`StreamHub error item: ${e.errorCategory ?? "?"} ${e.errorCode ?? ""} ${trunc(e.detail ?? e.message ?? "", 300)}`);
          noteResult(e.errorCategory ?? "InternalError", e.errorCode, e.message);
          ws.close();
        }
      };

      function handleMsg(raw: unknown) {
        const base = raw as { type?: number; target?: string; arguments?: unknown[] };

        if (base.type === 6) {
          ws.send(JSON.stringify({ type: 6 }) + RS);
          return;
        }

        if (streamHub && base.type === 2) {
          handleStreamHubItem((raw as { item?: unknown }).item);
          return;
        }

        if (base.type === 7) {
          const frame = CloseFrame.safeParse(raw);
          if (frame.success && frame.data.error) {
            onError(new Error(`Server close: ${frame.data.error}`));
          }
          ws.close();
          return;
        }

        if (base.type === 3) {
          const frame = CompletionFrame.safeParse(raw);
          if (frame.success && frame.data.error) {
            onError(new Error(`Completion error: ${frame.data.error}`));
          }
          ws.close();
          return;
        }

        if (base.type === 2) {
          // Stream item — the FINAL state of the conversation, with authoritative
          // throttle/turnCount/scores. Mine it before closing.
          const item = (raw as { item?: { messages?: any[]; throttling?: any; turnState?: string; result?: { value?: unknown; errorCode?: unknown; message?: unknown } } }).item;
          if (item) {
            if (typeof item.result?.value === "string") {
              noteResult(
                item.result.value,
                typeof item.result.errorCode === "string" ? item.result.errorCode : undefined,
                typeof item.result.message === "string" ? item.result.message : undefined,
              );
            }
            if (item.turnState) turnState = item.turnState;
            if (item.throttling) noteThrottling(item.throttling);
            let resumedHere = false;
            for (const m of item.messages ?? []) {
              if (m.author !== "bot") continue;
              captureImages(m);
              if (m.contentOrigin) contentOrigin = m.contentOrigin;
              if (m.contentOrigin === "Apology") sawApology = true;
              if (m.messageType) messageType = m.messageType;
              if (m.messageId) messageId = m.messageId;
              if (typeof m.turnCount === "number") turnCountServer = m.turnCount;
              if (Array.isArray(m.scores)) {
                for (const s of m.scores) {
                  if (typeof s?.component !== "string" || typeof s?.score !== "number") continue;
                  if (!(s.component in maxScores) || s.score > maxScores[s.component]) {
                    maxScores[s.component] = s.score;
                  }
                }
              }
              if (maybeResumeAction(m)) resumedHere = true;
            }
            // If the model just triggered a custom action, this "final" item isn't
            // final — we sent a ResumeInvokeAction and must keep the socket open to
            // receive the action's result (H-NATIVE-6).
            if (resumedHere) return;
          }
          ws.close();
          return;
        }

        if (base.type === 1 && base.target === "update" && Array.isArray(base.arguments)) {
          for (const arg of base.arguments) handleUpdateArg(arg);
        }
      }
    });
  }
}
