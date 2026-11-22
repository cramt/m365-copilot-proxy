import { randomUUID } from "node:crypto";
import { getTokenForScope } from "./auth.js";
import { runtimeModelFor } from "./backends.js";
import type { CopilotStream, CapturedImage } from "./copilot.js";
import { createLogger, trunc } from "./log.js";
import type { TurnOptions, TurnSession } from "./model.js";
import { DEFAULT_LEDGER_DIR, RuntimeLedger } from "./runtime-ledger.js";

const log = createLogger("aether");

// --- The Copilot agent runtime: Cowork and Code -------------------------------
//
// The web app's Cowork and Code tabs run on an agent runtime ("Aether", a Copilot
// Studio island) with a REST + SSE API (docs/m365-copilot-api.md §14): a message
// goes up as `POST /v1/messages` (202), and the run's events come back on
// `GET /v1/subscribe`. The conversation lives on the server, which keeps its
// history, so a follow-up sends only what's new, as on Chat. Every turn is
// charged to the account's Copilot credits (`cq` events).
//
// Code is the same runtime under another container type (`copilot`) and
// conversation key (`code-<uuid>`). Both list their conversations in the
// user's Cowork / Code sidebar; there's no temporary mode.

/** The runtime's API, an Entra app whose `access_as_user` scope the proxy's MSAL client gets silently. */
export const AETHER_SCOPE = "6ab48b67-cd74-4ad4-81af-5932984589be/access_as_user";
/** Returns the user's runtime endpoint (`{endpoint, geo}`). */
const ROUTING_URL = "https://cowork.us-ia888.gateway.prod.island.powerapps.com/v1/routing";
/** The runtime caps a message's text item at 1,000,000 characters; longer text goes up as several. */
const MAX_TEXT_ITEM_CHARS = 999_000;
/** A refusal (`engine.v2_refusal`) of a prompt at least this long reads as "too long": Sonnet 5.5
 *  refused ~806k tokens that way, and answered ~645k (docs/hypotheses.md §48). */
const LONG_PROMPT_CHARS = 400_000;
/** The stream sends a keep-alive every 30 s, so this long without a byte means it's gone. */
const IDLE_MS = 120_000;
/** After `session_stop` the run's `rl` follows at once; wait this long for it. */
const STOP_GRACE_MS = 5_000;
/** The run's own charge (`cq`) can land just after its `rl`; wait this long for it. */
const COST_GRACE_MS = 1_500;
/** The longest a turn may run. */
const TURN_MS = 30 * 60_000;
/** Re-subscriptions in a row, each bringing nothing new, before a stream counts as gone. */
const MAX_RESUBSCRIBES = 3;
/** How long a conversation the proxy left is kept before it's deleted: a request still reading a run
 *  in it (the pool moved on under it) finishes first. */
const DISCARD_DELAY_MS = 5 * 60_000;
/** Reasoning efforts the runtime's models take (`supported_effort_levels`). */
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export type RuntimeMode = "cowork" | "code";

export interface AetherSessionOptions {
  mode: RuntimeMode;
  /** A token for AETHER_SCOPE. Defaults to getTokenForScope. */
  getToken?: () => Promise<string>;
  /** How long a conversation the proxy left waits before it's deleted (default 5 min). */
  discardDelayMs?: number;
}

interface TokenIds {
  tid: string;
  oid: string;
}

function tokenIds(token: string): TokenIds {
  const part = token.split(".")[1] ?? "";
  const claims = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  if (typeof claims.tid !== "string" || typeof claims.oid !== "string") {
    throw new Error("The agent runtime's token carries no tenant or user ID");
  }
  return { tid: claims.tid, oid: claims.oid };
}

async function defaultToken(): Promise<string> {
  const token = await getTokenForScope([AETHER_SCOPE]);
  if (!token) throw new Error("No token for the Copilot agent runtime (Cowork/Code). Sign in again, or take cowork and code out of M365_BACKENDS.");
  return token;
}

let endpoint: Promise<string> | null = null;

/** The user's runtime endpoint: M365_AETHER_ENDPOINT, or the routing service's answer, kept for the process. */
function runtimeEndpoint(token: string, ids: TokenIds): Promise<string> {
  const fixed = process.env.M365_AETHER_ENDPOINT?.trim();
  if (fixed) return Promise.resolve(fixed.replace(/\/+$/, ""));
  endpoint ??= (async () => {
    const res = await fetch(ROUTING_URL, {
      headers: { authorization: `Bearer ${token}`, "x-tenant-id": ids.tid, "x-user-id": ids.oid, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`The agent runtime's routing answered HTTP ${res.status}`);
    const body = (await res.json()) as { endpoint?: unknown };
    if (typeof body.endpoint !== "string" || !body.endpoint) throw new Error("The agent runtime's routing returned no endpoint");
    log.info(`Agent runtime endpoint: ${body.endpoint}`);
    return body.endpoint.replace(/\/+$/, "");
  })().catch((err) => {
    endpoint = null;
    throw err;
  });
  return endpoint;
}

/** Forget the cached endpoint (tests). */
export function resetRuntimeEndpoint(): void {
  endpoint = null;
  catalog = null;
}

/** Delete a conversation on the runtime (the web app's `tasks.delete`); true once it's gone. */
async function deleteConversation(session: string, mode: RuntimeMode, token: string): Promise<boolean> {
  const ids = tokenIds(token);
  const base = await runtimeEndpoint(token, ids);
  const res = await fetch(`${base}/v1/conversations/${encodeURIComponent(session)}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      "x-tenant-id": ids.tid,
      "x-user-id": ids.oid,
      "x-cowork-host-type": "officeweb:web",
      "x-request-id": randomUUID(),
      ...(mode === "code" ? { "x-container-type": "copilot" } : {}),
    },
  });
  if (res.ok || res.status === 404) return true;
  log.info(`Deleting agent runtime conversation ${session}: HTTP ${res.status}`);
  return false;
}

/** The conversations this process opens, once trackRuntimeConversations is on. */
let ledger: RuntimeLedger | null = null;
let leftoversSwept: Promise<number> | null = null;
/** Older leftovers aren't tried again. */
const LEFTOVER_MAX_AGE_MS = 7 * 24 * 3_600_000;

/**
 * List the conversations this process opens on the runtime in a file
 * (runtime-ledger.ts), and delete the ones proxies no longer running left: the
 * runtime shows every conversation in the user's Copilot sidebar until it's
 * deleted, and a stopped or restarted proxy used to leave its open ones there
 * for good. A delete that fails is tried again by the next process. Once per
 * process; the standalone proxy calls it at startup. Resolves to how many it
 * deleted. Not under M365_SAVE_HISTORY=1, which keeps them all.
 */
export function trackRuntimeConversations(options: { dir?: string; getToken?: () => Promise<string> } = {}): Promise<number> {
  if (process.env.M365_SAVE_HISTORY === "1") return Promise.resolve(0);
  if (leftoversSwept) return leftoversSwept;
  const own = new RuntimeLedger(options.dir ?? DEFAULT_LEDGER_DIR);
  ledger = own;
  const getToken = options.getToken ?? defaultToken;
  leftoversSwept = (async () => {
    const leftovers = own.takeLeftovers().filter((e) => Date.now() - e.at < LEFTOVER_MAX_AGE_MS);
    if (leftovers.length === 0) return 0;
    let token: string;
    try {
      token = await getToken();
    } catch (err: any) {
      log.info(`Agent runtime conversations that proxies no longer running left weren't deleted: ${err?.message ?? err}`);
      for (const entry of leftovers) own.add(entry);
      return 0;
    }
    let deleted = 0;
    for (const entry of leftovers) {
      const gone = await deleteConversation(entry.session, entry.mode, token).catch((err) => {
        log.info(`Deleting agent runtime conversation ${entry.session} failed: ${err?.message ?? err}`);
        return false;
      });
      if (gone) deleted++;
      else own.add(entry);
    }
    const kept = leftovers.length - deleted;
    log.info(`Deleted ${deleted} agent runtime conversation(s) that proxies no longer running left${kept ? `; ${kept} kept for the next start` : ""}`);
    return deleted;
  })();
  return leftoversSwept;
}

/** Stop listing conversations (tests). */
export function resetRuntimeTracking(): void {
  ledger = null;
  leftoversSwept = null;
}

/** How long a fetched catalog is used, and how long a failed fetch waits to be retried. */
const CATALOG_TTL_MS = 10 * 60_000;
const CATALOG_RETRY_MS = 60_000;
let catalog: { at: number; ttl: number; models: Promise<string[] | null> } | null = null;

/**
 * The runtime's model IDs right now (`GET /v1/models`, the same for Cowork and
 * Code), or null when they can't be fetched. The list changes: on Nov 19 2026
 * every GPT model left it within an afternoon, and a message naming a model
 * that isn't in it is refused (`MODEL_NOT_IN_CATALOG`). Kept 10 minutes.
 */
export function runtimeCatalog(getToken: () => Promise<string> = defaultToken): Promise<string[] | null> {
  if (catalog && Date.now() - catalog.at < catalog.ttl) return catalog.models;
  const entry: { at: number; ttl: number; models: Promise<string[] | null> } = { at: Date.now(), ttl: CATALOG_TTL_MS, models: Promise.resolve(null) };
  entry.models = (async () => {
    try {
      const token = await getToken();
      const ids = tokenIds(token);
      const base = await runtimeEndpoint(token, ids);
      const res = await fetch(`${base}/v1/models`, {
        headers: { authorization: `Bearer ${token}`, "x-tenant-id": ids.tid, "x-user-id": ids.oid, "x-cowork-host-type": "officeweb:web", "x-request-id": randomUUID(), accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { models?: { id?: unknown }[] };
      const models = (body.models ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
      log.info(`Agent runtime catalog: ${models.join(", ") || "(empty)"}`);
      return models;
    } catch (err: any) {
      log.info(`Agent runtime catalog unavailable: ${err?.message ?? err}`);
      entry.ttl = CATALOG_RETRY_MS;
      return null;
    }
  })();
  catalog = entry;
  return entry.models;
}

/** Drop the cached catalog, so the next listing asks again. */
function forgetCatalog(): void {
  catalog = null;
}

/** OpenAI's effort names onto the runtime's; null for one it doesn't take. */
export function runtimeEffort(effort: string | undefined): string | null {
  const e = effort?.trim().toLowerCase();
  if (!e) return null;
  if (e === "minimal" || e === "none") return "low";
  return EFFORTS.has(e) ? e : null;
}

/** The `x-container-config` the web app sends for each tab. */
export function containerConfig(mode: RuntimeMode, model: string, effort: string | null): string {
  if (mode === "code") {
    return `appGenerationEnabled=true;appGenerationConnectorsEnabled=true;model=${model};reasoningEffort=${effort ?? "medium"}`;
  }
  const base = `renderUi=true;durableArtifactsEnabled=true;acceptLanguage=en-us;model=${model}:copilot`;
  return effort ? `${base};reasoningEffort=${effort}` : base;
}

/** Text in items the runtime accepts. */
export function textItems(text: string): { text: string; type: "text" }[] {
  const items: { text: string; type: "text" }[] = [];
  for (let i = 0; i < text.length || items.length === 0; i += MAX_TEXT_ITEM_CHARS) {
    items.push({ text: text.slice(i, i + MAX_TEXT_ITEM_CHARS), type: "text" });
  }
  return items;
}

export interface SseEvent {
  id: string | null;
  event: string;
  data: string;
}

/** Server-sent events off a body (CRLF or LF lines); `onBytes` runs on every chunk, keep-alives included. */
export async function* sseEvents(body: AsyncIterable<Uint8Array>, onBytes: () => void = () => {}): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    onBytes();
    buf = (buf + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      let id: string | null = null;
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "id") id = value;
        else if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0) yield { id, event, data: data.join("\n") };
    }
  }
}

function seqOf(id: string | null): number | null {
  const m = id ? /^seq:(\d+)$/.exec(id) : null;
  return m ? Number(m[1]) : null;
}

function parseJson(data: string): any {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

type TurnResult = { value: string; errorCode?: string; message?: string };

/** A failed run as the handler reads Chat's results: a long prompt refused is "too long" (a 400 the
 *  client compacts on), anything else a failed turn (re-sent once in a fresh conversation). */
export function runtimeFailure(code: string | undefined, message: string | undefined, promptChars: number): TurnResult {
  if (code === "engine.v2_refusal" && promptChars >= LONG_PROMPT_CHARS) {
    return { value: "InvalidRequest", errorCode: "InputTokenLimitExceeded", message };
  }
  return { value: "InternalError", errorCode: code || "agent_runtime_failure", message };
}

/** A turn the runtime refused before it ran: no text, only its result. */
function refusedTurn(result: TurnResult): CopilotStream {
  return {
    fullText: "",
    images: [],
    hasContent: false,
    throttle: null,
    contentOrigin: "AgentRuntime",
    apology: false,
    messageType: null,
    messageId: null,
    scores: null,
    turnCount: null,
    turnState: "Failed",
    result,
    metering: null,
    credits: null,
    async *[Symbol.asyncIterator]() {},
  };
}

interface TurnContext {
  subscribe: (lastEventId: string, signal: AbortSignal) => Promise<Response>;
  /** The message's ID: the run's `rl` and `fr` events carry it. */
  messageId: string;
  /** Where the message sits in the conversation's stream: subscribing from it replays only this turn. */
  eventId: string;
  promptChars: number;
  signal?: AbortSignal;
  /** Gets a line for each tool call the runtime's agent starts (`ts`): its thinking, as the client shows it. */
  onReasoning?: (delta: string) => void;
}

/** The longest description of an agent's tool call that goes to the client. */
const STEP_DETAIL_CHARS = 200;

/**
 * A line for one tool call of the runtime's agent (a `ts` event): the tool,
 * without its `mcp__<server>__` prefix, and what the agent said it's for, the
 * query or the URL (`d`). The agent works in its own cloud workspace, so these
 * are all a client can see of a turn that takes minutes (§48 F139, §60).
 */
export function runtimeStepLine(tool: unknown, detail: unknown): string | null {
  if (typeof tool !== "string" || !tool.trim()) return null;
  const name = tool.trim().replace(/^mcp__[^_]+__/, "");
  const text = typeof detail === "string" ? detail.replace(/\s+/g, " ").trim() : "";
  const shown = text.length > STEP_DETAIL_CHARS ? `${text.slice(0, STEP_DETAIL_CHARS - 1)}…` : text;
  return `- ${name}${shown ? `: ${shown}` : ""}\n`;
}

/** One run's events as Chat's CopilotStream. */
class RuntimeTurn implements CopilotStream {
  images: CapturedImage[] = [];
  hasContent = false;
  throttle = null;
  contentOrigin: string | null = "AgentRuntime";
  apology = false;
  messageType: string | null = null;
  messageId: string | null;
  scores = null;
  turnCount: number | null = null;
  turnState: string | null = null;
  result: TurnResult | null = null;
  metering = null;
  credits: number | null = null;
  /** Tool calls the runtime's agent made on its own (`rl.tc`). */
  agentToolCalls = 0;

  private streamed = "";
  private finals: string[] = [];
  private lastError: { code?: string; message?: string } | null = null;
  private done = false;

  constructor(private readonly ctx: TurnContext) {
    this.messageId = ctx.messageId;
  }

  get fullText(): string {
    const finals = this.finals.join("\n\n");
    return finals.length > this.streamed.length ? finals : this.streamed;
  }

  private finish(run: any): void {
    this.done = true;
    if (typeof run?.tc === "number") this.agentToolCalls = run.tc;
    if (run?.st === "ok") {
      this.result = { value: "Success" };
      this.turnState = "Completed";
      return;
    }
    const code = run?.code ?? this.lastError?.code;
    const message = run?.err ?? this.lastError?.message;
    this.result = runtimeFailure(code, message, this.ctx.promptChars);
    this.turnState = "Failed";
    log.info(`Agent runtime run failed: ${code ?? "no code"}${message ? ` (${trunc(message, 160)})` : ""}`);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    const { messageId: mid, signal } = this.ctx;
    const deadline = Date.now() + TURN_MS;
    let started = false;
    let stopSeen = false;
    // A `cq` under the run's own turn ID (not the message's, which the title call
    // uses) is the model's charge; once the run has ended, wait for it until then.
    let runCostSeen = false;
    let costDeadline = 0;
    let lastSeq = -1;
    // Subscriptions in a row that brought nothing new; one that did resets it.
    let fruitless = 0;
    const settled = () => this.done && (runCostSeen || Date.now() >= costDeadline);
    for (let attempt = 0; !settled() && !signal?.aborted; attempt++) {
      if (this.done) break; // the run ended; its charge is the only thing still awaited
      if (fruitless > MAX_RESUBSCRIBES || Date.now() > deadline) {
        this.finish({ st: "fail", code: "stream_closed", err: "The agent runtime's event stream ended before the run did." });
        break;
      }
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1_000));
        if (signal?.aborted) break;
      }
      const seqBefore = lastSeq;
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let idle = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const quiet = () => (this.done ? Math.max(0, costDeadline - Date.now()) : stopSeen ? STOP_GRACE_MS : IDLE_MS);
      const bump = (ms = quiet()) => {
        clearTimeout(timer);
        timer = setTimeout(() => { idle = true; ac.abort(); }, Math.min(ms, Math.max(0, deadline - Date.now())));
      };
      bump();
      try {
        // Always from the message: the events are numbered, so a replay skips what was read.
        const res = await this.ctx.subscribe(this.ctx.eventId, ac.signal);
        if (!res.ok || !res.body) throw new Error(`subscribe answered HTTP ${res.status}`);
        for await (const ev of sseEvents(res.body as unknown as AsyncIterable<Uint8Array>, () => bump())) {
          const seq = seqOf(ev.id);
          if (seq !== null) {
            if (seq <= lastSeq) continue;
            lastSeq = seq;
          }
          const j = parseJson(ev.data);
          if (!j || typeof j !== "object") continue;
          switch (ev.event) {
            case "rl":
              if (j.mid !== mid) break;
              if (j.st === "started") started = true;
              else if (j.st === "ok" || j.st === "fail") {
                this.finish(j);
                costDeadline = Date.now() + COST_GRACE_MS;
                bump();
              }
              break;
            case "dx":
              // Text before this run started belongs to an earlier one still running.
              if (started && typeof j.t === "string" && j.t) {
                this.streamed += j.t;
                this.hasContent = true;
                yield j.t;
              }
              break;
            case "ts": {
              // The agent starting one of its own tools; like text, only this run's.
              const line = started ? runtimeStepLine(j.tn, j.d) : null;
              if (line) this.ctx.onReasoning?.(line);
              break;
            }
            case "fr":
              if (String(j.mid ?? "").startsWith(mid) && typeof j.content === "string") {
                this.finals.push(j.content);
                if (j.content) this.hasContent = true;
              }
              break;
            case "cq":
              if (j.r === mid && typeof j.d === "number" && Number.isFinite(j.d)) {
                this.credits = Math.round(((this.credits ?? 0) + j.d) * 1e6) / 1e6;
                if (j.t !== mid) runCostSeen = true;
              }
              break;
            case "uv":
              if (j.type === "session_stop" && String(j.id ?? "").startsWith(mid)) {
                stopSeen = true;
                bump(STOP_GRACE_MS);
              }
              break;
            case "error":
              if (!j.mid || j.mid === mid) this.lastError = { code: j.code, message: j.err };
              break;
          }
          if (settled()) break;
        }
      } catch (err: any) {
        if (signal?.aborted) break;
        if (!idle) log.info(`Agent runtime stream broke: ${err?.message ?? err}`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        ac.abort();
      }
      if (!this.done && idle) {
        // The run stopped without its closing event, or the stream went quiet.
        if (stopSeen) this.finish({ st: this.hasContent ? "ok" : "fail", code: "no_run_end" });
        else this.finish({ st: "fail", code: "stream_idle", err: `No event from the agent runtime for ${IDLE_MS / 1000} s.` });
      }
      fruitless = lastSeq > seqBefore ? 0 : fruitless + 1;
    }
    if (this.agentToolCalls > 0) log.info(`The runtime's agent made ${this.agentToolCalls} tool call(s) of its own this turn`);
  }
}

/**
 * A conversation on the agent runtime (Cowork or Code), driven like Chat's
 * ModelSession: string in, stream out, the history kept on the server.
 */
export class AetherSession implements TurnSession {
  readonly sessionId: string = randomUUID();
  readonly mode: RuntimeMode;
  private readonly resolveToken: () => Promise<string>;
  private session: string;
  private turns = 0;
  private prewarmed = false;
  private readonly discardDelayMs: number;

  constructor(options: AetherSessionOptions) {
    this.mode = options.mode;
    this.resolveToken = options.getToken ?? defaultToken;
    this.discardDelayMs = options.discardDelayMs ?? DISCARD_DELAY_MS;
    this.session = this.freshSession();
  }

  private freshSession(): string {
    return this.mode === "code" ? `code-${randomUUID()}` : randomUUID();
  }

  /** The runtime's session key: a UUID (Cowork) or `code-<uuid>` (Code). */
  get conversationId(): string {
    return this.session;
  }

  /** Messages sent in this conversation. */
  get turnCount(): number {
    return this.turns;
  }

  newConversation(): void {
    const old = this.session;
    const used = this.prewarmed || this.turns > 0;
    this.session = this.freshSession();
    this.turns = 0;
    this.prewarmed = false;
    if (used) this.discard(old);
  }

  reset(): void {}

  /** The pool is dropping this conversation. */
  close(): void {
    if (this.prewarmed || this.turns > 0) this.discard(this.session);
    this.prewarmed = false;
    this.turns = 0;
  }

  /**
   * Delete a conversation the proxy is done with (the web app's `tasks.delete`),
   * so its tasks don't pile up in the user's Cowork / Code sidebar: the runtime
   * has no temporary mode, as Chat has. M365_SAVE_HISTORY=1 keeps them. Deleting
   * ends a run still going in it, so it waits a while (discardDelayMs): another
   * request may still be reading one. Fire and forget; a process that exits
   * first leaves the conversation to the next one (trackRuntimeConversations).
   */
  private discard(session: string): void {
    if (process.env.M365_SAVE_HISTORY === "1") return;
    const mode = this.mode;
    const remove = () => void (async () => {
      if (await deleteConversation(session, mode, await this.resolveToken())) ledger?.remove(session);
    })().catch((err) => log.info(`Deleting agent runtime conversation ${session} failed: ${err?.message ?? err}`));
    if (this.discardDelayMs <= 0) return remove();
    setTimeout(remove, this.discardDelayMs).unref?.();
  }

  async refreshAgent(): Promise<boolean> {
    return false;
  }

  async run(
    text: string,
    model: string = "gpt-6.2-sol",
    signal?: AbortSignal,
    _useAgent?: boolean,
    images: string[] = [],
    _waitForBudget?: () => Promise<{ waitedMs: number }>,
    turn: TurnOptions = {},
  ): Promise<CopilotStream> {
    if (images.length > 0) {
      text += `\n\n(Note: ${images.length === 1 ? "an attached file" : `${images.length} attached files`} could not be passed on: this backend doesn't take attachments. Don't describe ${images.length === 1 ? "it" : "them"}; say ${images.length === 1 ? "it" : "they"} didn't arrive.)`;
    }
    const token = await this.resolveToken();
    const ids = tokenIds(token);
    const base = await runtimeEndpoint(token, ids);
    const runtimeModel = runtimeModelFor(model);
    const effort = runtimeEffort(turn.reasoningEffort);
    // Cowork keys a conversation on tenant, user and session; Code on its `code-` session.
    const conversationId = this.mode === "code" ? this.session : `${ids.tid}:${ids.oid}:${this.session}`;
    const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
      authorization: `Bearer ${token}`,
      "x-tenant-id": ids.tid,
      "x-user-id": ids.oid,
      "x-cowork-host-type": "officeweb:web",
      "x-copilot-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      "x-container-config": containerConfig(this.mode, runtimeModel, effort),
      "x-conversation-id": conversationId,
      "x-request-id": randomUUID(),
      ...(this.mode === "code" ? { "x-container-type": "copilot" } : {}),
      ...extra,
    });

    if (!this.prewarmed) {
      ledger?.add({ session: this.session, mode: this.mode, at: Date.now() });
      // The web app opens each conversation so; the message is accepted after it.
      try {
        const pre = await fetch(`${base}/v1/prewarm`, { method: "POST", headers: headers({ "content-type": "application/json", accept: "application/json" }), body: "{}", signal });
        if (!pre.ok) log.info(`Agent runtime prewarm answered HTTP ${pre.status}`);
      } catch (err: any) {
        if (signal?.aborted) throw err;
        log.info(`Agent runtime prewarm failed: ${err.message}`);
      }
      this.prewarmed = true;
    }

    const messageId = randomUUID();
    log.info(`run: ${this.mode} model=${runtimeModel}${effort ? ` effort=${effort}` : ""}, turn=${this.turns}, session=${this.session}, text=${JSON.stringify(trunc(text, 200))} (${text.length} chars)`);
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", accept: "application/json" }),
      body: JSON.stringify({ content: textItems(text), conversationId, messageId, queue: true, role: "user" }),
      signal,
    });
    const body = await res.text();
    if (!res.ok) {
      // A model the catalog doesn't have (any more) is the client's to change: a 400, not a 502.
      const detail = parseJson(body)?.detail;
      if (res.status === 400 && detail?.code === "MODEL_NOT_IN_CATALOG") {
        forgetCatalog();
        log.info(`Agent runtime: ${runtimeModel} isn't in its catalog`);
        return refusedTurn({ value: "InvalidRequest", errorCode: "ModelNotInCatalog", message: typeof detail.message === "string" ? detail.message : undefined });
      }
      throw new Error(`The agent runtime refused the message: HTTP ${res.status} ${trunc(body, 300)}`);
    }
    const accepted = parseJson(body);
    if (typeof accepted?.id !== "string") throw new Error(`The agent runtime accepted the message without a stream position: ${trunc(body, 300)}`);
    this.turns++;

    return new RuntimeTurn({
      messageId,
      eventId: accepted.id,
      promptChars: text.length,
      signal,
      onReasoning: turn.onReasoning,
      subscribe: (lastEventId, subscribeSignal) =>
        fetch(`${base}/v1/subscribe`, {
          headers: headers({ accept: "text/event-stream", "last-event-id": lastEventId, "cache-control": "no-cache" }),
          signal: subscribeSignal,
        }),
    });
  }
}
