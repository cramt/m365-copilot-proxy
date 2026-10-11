import { createLogger } from "./log.js";

const log = createLogger("backoff");

// Degradation BACKOFF policy (docs/hypotheses.md §11, H-R1). Account degradation is
// thread-rate throttle that surfaces as EMPTY responses across many DISTINCT
// conversations. The old policy fired a background re-login on this signal — but a
// fresh token carries the same `oid`, so it lands in the same identity-keyed throttle
// bucket (API doc §2/§7): re-auth does NOT clear the throttle. The one observation that
// a fresh login "recovered" it (F13) was confounded by the ~15 min the login+restart
// took — it was the idle time, not the token. And the headless re-login is the single
// most detectable thing we do at Microsoft (F25: `webdriver=true`, a `HeadlessChrome`
// UA, a fresh unfamiliar device every time). So we drop the login entirely and do what
// actually works against a time-driven throttle: BACK OFF. On sustained distinct-
// conversation empties we self-impose a paced delay before starting new backend turns,
// giving the account room to self-heal.
//
// A real pi/openclaw session is ONE long thread, so it never trips the distinct-
// conversation trigger — only bursty multi-conversation use (experiments, benches) does,
// which is exactly the traffic that should slow down.
//
// Guards: distinct-conversation gating (repeated empties in ONE conversation are usually
// content-specific — a bad agent, a Disengage-shaped prompt — not throttle), a window so
// stale empties expire, escalation so repeated triggers back off harder, and a clean
// response that lifts the backoff immediately.

export interface BackoffOptions {
  /** Clock injection for tests. Defaults to Date.now. */
  now?: () => number;
  /** Sleep injection for tests. Defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0,1). Defaults to Math.random. */
  rng?: () => number;
  /** Empties older than this fall out of the window. */
  windowMs?: number;
  /** Distinct-conversation empties within the window needed to enter backoff. */
  threshold?: number;
  /** Initial backoff window opened on the first trigger. */
  baseCooldownMs?: number;
  /** Cap on the backoff window after escalation. */
  maxCooldownMs?: number;
  /** Per-gated-request paced delay is drawn uniformly from [min, max]. */
  jitterMinMs?: number;
  jitterMaxMs?: number;
  /** Called when backoff opens/escalates (for logging/telemetry). */
  onTrigger?: (info: { distinctConversations: number; cooldownMs: number; level: number }) => void;
}

export interface BackoffController {
  /** Record one request outcome. `empty` = throttle-shaped empty response. */
  note: (empty: boolean, conversationId: string) => void;
  noteThrottle: () => void;
  retryAfterSeconds: () => number;
  /** Await a paced slot before starting a backend turn. Resolves immediately when
   *  healthy; during backoff it sleeps a jittered delay. Returns ms slept. */
  waitForSlot: () => Promise<number>;
  /** Whether the controller is currently in a backoff window. */
  isBackingOff: () => boolean;
}

export function createBackoffController(opts: BackoffOptions): BackoffController {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = opts.rng ?? Math.random;
  const windowMs = opts.windowMs ?? 120_000;
  const threshold = opts.threshold ?? 3;
  const baseCooldownMs = opts.baseCooldownMs ?? 90_000;
  const maxCooldownMs = opts.maxCooldownMs ?? 600_000;
  const jitterMinMs = opts.jitterMinMs ?? 10_000;
  const jitterMaxMs = opts.jitterMaxMs ?? 25_000;

  let empties: Array<{ t: number; conv: string }> = [];
  let backoffUntil = -Infinity;
  let level = 0; // escalation level; resets on a clean response

  const enterBackoff = (distinctConversations: number) => {
    const timestamp = now();
    if (timestamp < backoffUntil) return;
    level += 1;
    const cooldownMs = Math.min(baseCooldownMs * 2 ** (level - 1), maxCooldownMs);
    backoffUntil = timestamp + cooldownMs;
    empties = [];
    opts.onTrigger?.({ distinctConversations, cooldownMs, level });
  };

  return {
    note(empty, conversationId) {
      const t = now();
      if (!empty) {
        // A clean response means degradation has lifted — reset the streak AND the
        // backoff window so the next request runs at full speed.
        empties = [];
        backoffUntil = -Infinity;
        level = 0;
        return;
      }

      empties.push({ t, conv: conversationId || `anon-${t}` });
      empties = empties.filter((e) => t - e.t < windowMs);

      const distinct = new Set(empties.map((e) => e.conv)).size;
      if (distinct < threshold) return;
      // Already backing off within the current window — don't re-arm/escalate until it
      // elapses, so a burst of empties doesn't stack the delay unboundedly.
      enterBackoff(distinct);
    },

    noteThrottle() {
      enterBackoff(1);
    },

    retryAfterSeconds() {
      return Math.max(0, Math.ceil((backoffUntil - now()) / 1000));
    },

    async waitForSlot() {
      const remaining = backoffUntil - now();
      if (remaining <= 0) return 0;
      const span = Math.max(0, jitterMaxMs - jitterMinMs);
      const delay = Math.min(remaining, jitterMinMs + Math.floor(rng() * (span + 1)));
      if (delay > 0) await sleep(delay);
      return delay;
    },

    isBackingOff() {
      return now() < backoffUntil;
    },
  };
}

const disabled = () => !!(process.env.M365_NO_BACKOFF ?? process.env.M365_NO_AUTO_REAUTH); // legacy alias

const defaultController = createBackoffController({
  windowMs: Number(process.env.M365_BACKOFF_WINDOW_MS ?? 120_000),
  threshold: Number(
    process.env.M365_BACKOFF_THRESHOLD ?? process.env.M365_REAUTH_EMPTY_THRESHOLD ?? 3,
  ),
  baseCooldownMs: Number(process.env.M365_BACKOFF_BASE_MS ?? 90_000),
  maxCooldownMs: Number(process.env.M365_BACKOFF_MAX_MS ?? 600_000),
  onTrigger: ({ distinctConversations, cooldownMs, level }) =>
    log.info(
      `Degradation backoff (level ${level}): throttle-shaped failures in ${distinctConversations} ` +
        `conversation(s) — pacing new turns for ~${Math.round(cooldownMs / 1000)}s to let the account self-heal ` +
        `(H-R1: a re-login would NOT clear this and would raise our detection profile). Disable with M365_NO_BACKOFF=1.`,
    ),
});

/** Record a request outcome for the global degradation-backoff policy. No-op if disabled. */
export function noteRequestOutcome(empty: boolean, conversationId: string): void {
  if (disabled()) return;
  defaultController.note(empty, conversationId);
}

export function noteUpstreamThrottle(): void {
  if (disabled()) return;
  defaultController.noteThrottle();
}

export function getDegradationRetryAfterSeconds(): number {
  return disabled() ? 0 : defaultController.retryAfterSeconds();
}

/** Await a paced slot before a backend turn (self-imposed rate limit while degraded).
 *  Resolves immediately when healthy or when backoff is disabled. */
export async function awaitDegradationBackoff(): Promise<void> {
  if (disabled()) return;
  const slept = await defaultController.waitForSlot();
  if (slept > 0)
    log.info(`Backoff: paced this turn by ${Math.round(slept / 1000)}s (account degraded)`);
}

/** Whether the global policy is currently backing off. */
export function isDegradationBackoff(): boolean {
  return !disabled() && defaultController.isBackingOff();
}
