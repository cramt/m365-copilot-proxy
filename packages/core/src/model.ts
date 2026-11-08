import { withAccountContext, currentAccountContext, assertAccountToken, AccountPolicyError } from "./account-policy.js";
import { TurnBudgetHold } from "./turn-budget.js";
import { getToken } from "./auth.js";
import { CachePersistenceError } from "./storage.js";
import { getOrCreateAgent } from "./agent.js";
import { CopilotSession } from "./session.js";
import { uploadImage, type ImageAnnotation } from "./image-input.js";
import { createLogger, trunc } from "./log.js";
import { awaitTurnBudget } from "./turn-budget.js";
import type { CopilotStream } from "./copilot.js";

const log = createLogger("model");

function reconnectDelay(signal?: AbortSignal): Promise<void> {
  const raw = process.env.M365_RECONNECT_DELAY_MS;
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  const ms = Number.isFinite(value) && value >= 0 && value <= 2_147_483_647 ? value : 5000;
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface ModelSessionOptions {
  /** Pre-resolved auth token. If not provided, getToken() is called. */
  getToken?: () => Promise<string>;
  /** Whether to attempt agent resolution. Default: true. */
  useAgent?: boolean;
  /**
   * Prevent proxy conversations appearing in the M365 Copilot history sidebar.
   * Defaults to true. Set false only when persistent Copilot history is wanted.
   */
  temporaryChat?: boolean;
  /** Stable route protocol/agent/scenario configuration identity (never a credential). */
  accountRouteScope?: string;
}

/**
 * A stateful session for running M365 Copilot.
 * Manages auth, agent resolution, and conversation continuity.
 * String in, stream out.
 *
 * The same sessionId and conversationId are reused across CopilotSession
 * reconnections so M365 finds the existing server-side conversation
 * instead of creating a new one.
 */
export class ModelSession {
  private resolveToken: () => Promise<string>;
  private useAgent: boolean;
  private temporaryChat: boolean;
  private copilotSession: CopilotSession | null = null;
  private cachedAgentId: string | null | undefined = undefined;
  private savedTurnCount = 0;
  private accountKey: string | undefined;
  private options: ModelSessionOptions;

  /** Stable IDs reused across CopilotSession reconnections. */
  readonly sessionId: string = crypto.randomUUID();
  private _conversationId: string = crypto.randomUUID();
  /** Current M365 ConversationId (the throttle/Disengage state keys on this). */
  get conversationId(): string { return this._conversationId; }
  /**
   * Rotate to a FRESH conversation. A conversation that has Disengaged appears to
   * STAY Disengaged (a clean retry in the same conversation kept refusing), so the
   * Disengage-recovery retry needs a new ConversationId, not just a different prompt.
   * See docs §10 F22.
   */
  newConversation(): void {
    this.reset();
    this._conversationId = crypto.randomUUID();
    this.savedTurnCount = 0;
  }

  constructor(options: ModelSessionOptions = {}) {
    this.options = { ...options };
    this.resolveToken = options.getToken ?? getToken;
    this.useAgent = options.useAgent !== false;
    this.temporaryChat =
      options.temporaryChat ?? process.env.M365_SAVE_HISTORY !== "1";
  }

  /** Number of turns completed in this session */
  get turnCount(): number {
    return this.copilotSession?.turnCount ?? this.savedTurnCount;
  }

  /** Agent id baked into the current copilotSession (undefined = no agent). */
  private currentAgentId: string | undefined = undefined;

  private createCopilotSession(agentId: string | undefined): CopilotSession {
    return new CopilotSession({
      agentId,
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      temporaryChat: this.temporaryChat,
      turnCount: this.turnCount,
    });
  }

  /**
   * Send text to M365 Copilot and stream back the response.
   *
   * `useAgent` decides whether THIS turn attaches the tool-calling Copilot Studio
   * agent (`threadLevelGptId`). The handler passes `false` for tool-less requests
   * — the agent is only needed to coerce tool-call output — and for tool requests
   * on tones that don't serve with it (`toneUsesToolAgent`: Claude, GPT-6; with
   * the agent attached those return a dead route or, in June 2026, silently
   * routed to GPT — docs/hypotheses.md H8.6, §22). Plain chat therefore always
   * gets the real model the tone selects.
   *
   * If `signal` aborts (the HTTP client disconnects) the in-flight turn is
   * cancelled by sending M365's Stop frame, mirroring the real UI's Stop button.
   *
   * `waitForBudget` waits until the account's turn budget can afford one more
   * turn (M365_AVOID_THROTTLING; awaitTurnBudget). The caller waits before it
   * calls run(); run() waits again before the reconnect's turn. It throws
   * TurnBudgetHold rather than wait too long.
   */
  async run(
    text: string,
    model: string = "m365-copilot",
    signal?: AbortSignal,
    useAgent: boolean = true,
    images: string[] = [],
    waitForBudget: () => Promise<{ waitedMs: number }> = () => awaitTurnBudget({ signal }),
  ): Promise<CopilotStream> {
    if (!currentAccountContext()) return withAccountContext(this.options, () => this.run(text, model, signal, useAgent, images, waitForBudget));
    const context = currentAccountContext()!;
    if (this.accountKey && this.accountKey !== context.key) throw new AccountPolicyError(409, "account_changed");
    this.accountKey = context.key;
    let token = context.token;
    signal?.throwIfAborted();
    // Image input (#39): upload each image for this conversation; the message points at them.
    // A failed upload is said in the text, so the model doesn't answer about an image it never got.
    const annotations: ImageAnnotation[] = [];
    for (const url of images) {
      try {
        annotations.push(await uploadImage(token, this.conversationId, url));
      } catch (err: any) {
        log.info(`Image upload failed: ${err.message}`);
        text += `

(Note: an attached image could not be passed on — ${err.message.slice(0, 120)}. Don't describe it; say it didn't arrive.)`;
      }
    }
    const wantAgent = this.useAgent && useAgent;

    // Resolve agent ID lazily (persists across resets), only when wanted.
    if (wantAgent) {
      try {
        this.cachedAgentId = await getOrCreateAgent();
        if (this.cachedAgentId) log.info(`Using agent: ${this.cachedAgentId}`);
        else log.info("No agent available");
      } catch (error) {
        if (error instanceof CachePersistenceError || error instanceof AccountPolicyError) throw error;
        this.cachedAgentId = null;
      }
    }
    const agentForTurn = wantAgent ? (this.cachedAgentId ?? undefined) : undefined;

    // Create (or recreate) the session when missing or when this turn's
    // agent-ness differs from the current session's — switching the agent on/off
    // changes routing, so the WS session must carry the right threadLevelGptId.
    if (!this.copilotSession || this.currentAgentId !== agentForTurn) {
      this.copilotSession = this.createCopilotSession(agentForTurn);
      this.currentAgentId = agentForTurn;
    }

    log.info(`run: model=${model}, agent=${agentForTurn ?? "none"}, turn=${this.copilotSession.turnCount}, sid=${this.sessionId}, cid=${this.conversationId}, text=${JSON.stringify(trunc(text, 200))}`);

    // Match the GUI: on the agent-less path, image gen is always available, so a
    // plain "draw me an image" produces one with no special mode (§14). Kept OFF on
    // the tool-calling agent path — image optionsSets are agent-less, and we don't
    // want the image tool competing with fenced tool-call emission. Opt out with
    // M365_NO_IMAGE_GEN for a pure-text agent-less turn.
    const turnOpts = { generateImages: !agentForTurn && !process.env.M365_NO_IMAGE_GEN, images: annotations };

    try {
      assertAccountToken(token);
      return await this.copilotSession.chat(token, text, model, signal, turnOpts);
    } catch (err: any) {
      if (err instanceof AccountPolicyError || err instanceof TurnBudgetHold || err?.name === "AbortError" || err?.name === "ZodError" || err instanceof SyntaxError || err?.status === 401 || err?.status === 403) throw err;
      // Session might be stale — reconnect with same IDs
      log.info("Session error, reconnecting:", err.message);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (/EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/.test(String(err?.message))) {
        await reconnectDelay(signal);
      }
      // The reconnect is one more upstream turn, so it waits on the budget too:
      // otherwise it skips the wait and its recordTurn takes the grant of a turn
      // another request was let through for (#77). A token held through a long
      // wait may be near its end, so fetch it again.
      if ((await waitForBudget()).waitedMs > 0) token = await this.resolveToken();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      assertAccountToken(token);
      this.copilotSession = this.createCopilotSession(agentForTurn);
      this.currentAgentId = agentForTurn;
      return await this.copilotSession.chat(token, text, model, signal, turnOpts);
    }
  }

  /**
   * Force a re-resolution of the tool-calling agent against the tenant and
   * reconnect if it changed. Recovers from the "deleted-agent trap": a
   * long-lived host caches its agent id for the whole process lifetime, so once
   * that agent is deleted from the tenant (e.g. by a newer-build's cleanup) it
   * would otherwise send `threadLevelGptId` at a dead bot forever and get empty
   * replies. Call this on an empty upstream reply before retrying. No-op when
   * the session isn't using an agent. Returns true if the agent id changed (and
   * the session was dropped to reconnect), so the caller can resend the original
   * prompt to the fresh agent.
   */
  async refreshAgent(): Promise<boolean> {
    if (!this.useAgent) return false;
    if (!currentAccountContext()) return withAccountContext(this.options, () => this.refreshAgent());
    if (this.accountKey && this.accountKey !== currentAccountContext()!.key) throw new AccountPolicyError(409, "account_changed");
    try {
      const fresh = await getOrCreateAgent({ forceRefresh: true });
      if (fresh !== this.cachedAgentId) {
        log.info(`Agent refreshed: ${this.cachedAgentId ?? "none"} -> ${fresh ?? "none"}`);
        this.cachedAgentId = fresh;
        this.savedTurnCount = this.turnCount;
        this.copilotSession = null; // reconnect so the new agent id takes effect
        this.currentAgentId = undefined;
        return true;
      }
    } catch (err: any) {
      if (err instanceof CachePersistenceError || err instanceof AccountPolicyError) throw err;
      log.info(`Agent refresh failed: ${err.message}`);
    }
    return false;
  }

  /**
   * Reset the CopilotSession. Next run() reconnects with the same
   * sessionId/conversationId. Also drops the cached agent id so the next run()
   * re-resolves it (cheap cache fast-path in the normal case).
   */
  reset() {
    this.savedTurnCount = this.turnCount;
    this.copilotSession = null;
    this.cachedAgentId = undefined;
    this.currentAgentId = undefined;
  }
}
