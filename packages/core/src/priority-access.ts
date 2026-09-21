// Priority-access exhaustion (the Opus daily / weekly cap).
//
// Opus is metered separately from everything else on this API. When the budget
// runs out M365 does NOT throttle, disengage, or return empty — it answers the
// turn with a plain-text refusal on an ordinary bot message, verbatim:
//
//   "You've used your available priority access to the Opus model for today.
//    You can choose another available model or wait until tomorrow to use the
//    Opus model again."
//
//   "You've used your available priority access to the Opus model for the week.
//    You can choose another available model or wait until Monday to use the
//    Opus model again."
//
// That shape is the hazard: it arrives as a successful turn with content, so
// every existing guard (empty-retry, Disengaged fail-fast, throttle) waves it
// through and the client gets a refusal dressed as an answer — the same class
// of failure as the image-quota text in §14 H14.4. Detect it and surface a 429
// instead, with the reset time so a client can back off rather than retry into
// a wall.
//
// Resets happen at midnight UTC: the daily budget at the next UTC midnight, the
// weekly one at the next UTC Monday ("wait until Monday").

/** Which budget ran out. */
export type PriorityAccessWindow = "day" | "week";

export interface PriorityAccessExhaustion {
  window: PriorityAccessWindow;
  /** Model named in the refusal, when M365 names one (e.g. "Opus"). */
  model?: string;
  /** When the budget refills (midnight UTC / Monday midnight UTC). */
  resetsAt: Date;
  /** The upstream text, verbatim. */
  message: string;
}

// Anchored on "priority access" + a budget window. Deliberately not matching a
// bare "wait until tomorrow": this must not fire on a model *discussing* usage
// limits, only on M365's own refusal.
const PRIORITY_ACCESS_RE =
  /(?:you.?ve|you have)\s+used\s+(?:up\s+)?(?:all\s+of\s+)?your\s+(?:available\s+)?priority\s+access(?:\s+to\s+the\s+(?<model>[\w.\- ]{1,32}?)\s+model)?\s+for\s+(?:the\s+)?(?<window>today|day|week|this\s+week)\b/i;

/** Next midnight UTC strictly after `from`. */
function nextUtcMidnight(from: Date): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1));
}

/** Next Monday 00:00 UTC strictly after `from`. */
function nextUtcMonday(from: Date): Date {
  const daysUntilMonday = ((8 - from.getUTCDay()) % 7) || 7; // Sun=0 → 1, Mon=1 → 7
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + daysUntilMonday),
  );
}

/**
 * Detect M365's priority-access refusal in a bot reply.
 * Returns null for ordinary content — including prose that merely mentions
 * rate limits — so this is safe to run on every turn.
 */
export function parsePriorityAccessExhaustion(
  text: string | null | undefined,
  now: Date = new Date(),
): PriorityAccessExhaustion | null {
  if (!text) return null;
  const m = text.match(PRIORITY_ACCESS_RE);
  if (!m) return null;
  const raw = (m.groups?.window ?? "").toLowerCase();
  const window: PriorityAccessWindow = raw.includes("week") ? "week" : "day";
  return {
    window,
    model: m.groups?.model?.trim() || undefined,
    resetsAt: window === "week" ? nextUtcMonday(now) : nextUtcMidnight(now),
    message: text.trim(),
  };
}

// The openers the refusal can begin with, normalised. Used to hold back the
// HEAD of a live stream just long enough to tell a refusal from an answer:
// on the streaming path deltas are forwarded as they arrive, so without this
// the refusal text reaches the client before the 429 does — the exact confusion
// the 429 exists to prevent, delivered anyway.
const GATE_PHRASES = [
  "you've used your available priority access",
  "you've used up all of your priority access",
  "you have used your available priority access",
  "you have used up all of your priority access",
];
const GATE_MAX = Math.max(...GATE_PHRASES.map((p) => p.length));

/**
 * Is `text` still a viable prefix of (or already matching) a priority-access
 * refusal? True means "keep buffering, we can't tell yet"; false means "this is
 * ordinary content, stream it". Releases within ~45 chars in the worst case, so
 * the latency cost on a normal turn is one short delta.
 */
export function couldBePriorityAccessPrefix(text: string): boolean {
  const t = text
    .replace(/[\u2018\u2019]/g, "'") // M365 uses curly apostrophes in these strings
    .trimStart()
    .toLowerCase()
    .slice(0, GATE_MAX);
  if (!t) return true; // nothing decisive yet
  return GATE_PHRASES.some((p) => p.startsWith(t) || t.startsWith(p));
}

/** Seconds until the budget refills, for a `Retry-After` header. */
export function secondsUntilReset(
  exhaustion: PriorityAccessExhaustion,
  now: Date = new Date(),
): number {
  return Math.max(1, Math.ceil((exhaustion.resetsAt.getTime() - now.getTime()) / 1000));
}
