import { getToken } from "./auth.js";
import { getOrCreateAgent } from "./agent.js";
import { CopilotSession } from "./session.js";
import { createLogger, trunc } from "./log.js";
import type { CopilotStream } from "./copilot.js";

const log = createLogger("model");

export interface ModelSessionOptions {
  /** Pre-resolved auth token. If not provided, getToken() is called. */
  getToken?: () => Promise<string>;
  /** Whether to attempt agent resolution. Default: true. */
  useAgent?: boolean;
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
  private copilotSession: CopilotSession | null = null;
  private cachedAgentId: string | null | undefined = undefined;

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
    this._conversationId = crypto.randomUUID();
    this.reset();
  }

  constructor(options: ModelSessionOptions = {}) {
    this.resolveToken = options.getToken ?? getToken;
    this.useAgent = options.useAgent !== false;
  }

  /** Number of turns completed in this session */
  get turnCount(): number {
    return this.copilotSession?.turnCount ?? 0;
  }

  /** Agent id baked into the current copilotSession (undefined = no agent). */
  private currentAgentId: string | undefined = undefined;

  private createCopilotSession(agentId: string | undefined): CopilotSession {
    return new CopilotSession({
      agentId,
      sessionId: this.sessionId,
      conversationId: this.conversationId,
    });
  }

  /**
   * Send text to M365 Copilot and stream back the response.
   *
   * `useAgent` decides whether THIS turn attaches the tool-calling Copilot Studio
   * agent (`threadLevelGptId`). The handler passes `false` for tool-less requests
   * — the agent is only needed to coerce tool-call output, and crucially it
   * **overrides the `tone` and forces GPT-5** (docs/hypotheses.md H8.6): with the
   * agent attached a `Claude_*` tone silently routes to GPT, and heavy tool
   * prompts can Disengage. So plain chat skips the agent and gets the real model
   * the tone selects (e.g. Claude Sonnet 4.5).
   *
   * If `signal` aborts (the HTTP client disconnects) the in-flight turn is
   * cancelled by sending M365's Stop frame, mirroring the real UI's Stop button.
   */
  async run(text: string, model: string = "m365-copilot", signal?: AbortSignal, useAgent: boolean = true): Promise<CopilotStream> {
    const token = await this.resolveToken();
    const wantAgent = this.useAgent && useAgent;

    // Resolve agent ID lazily (persists across resets), only when wanted.
    if (wantAgent && this.cachedAgentId === undefined) {
      try {
        this.cachedAgentId = await getOrCreateAgent();
        if (this.cachedAgentId) log.info(`Using agent: ${this.cachedAgentId}`);
        else log.info("No agent available");
      } catch {
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
    const turnOpts = { generateImages: !agentForTurn && !process.env.M365_NO_IMAGE_GEN };

    try {
      return await this.copilotSession.chat(token, text, model, signal, turnOpts);
    } catch (err: any) {
      // Session might be stale — reconnect with same IDs
      log.info("Session error, reconnecting:", err.message);
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
    try {
      const fresh = await getOrCreateAgent({ forceRefresh: true });
      if (fresh !== this.cachedAgentId) {
        log.info(`Agent refreshed: ${this.cachedAgentId ?? "none"} -> ${fresh ?? "none"}`);
        this.cachedAgentId = fresh;
        this.copilotSession = null; // reconnect so the new agent id takes effect
        this.currentAgentId = undefined;
        return true;
      }
    } catch (err: any) {
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
    this.copilotSession = null;
    this.cachedAgentId = undefined;
    this.currentAgentId = undefined;
  }
}
