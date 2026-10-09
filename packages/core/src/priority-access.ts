// Priority-access exhaustion (the Opus 5.5 and Sonnet 5.5 daily / weekly caps).
//
// Opus 5.5 and Sonnet 5.5 are metered separately from everything else on this
// API. When a budget runs out M365 does NOT throttle, disengage, or return
// empty — it answers the turn with a plain-text refusal on an ordinary bot
// message, verbatim (Opus):
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
  const daysUntilMonday = (8 - from.getUTCDay()) % 7 || 7; // Sun=0 → 1, Mon=1 → 7
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

// --- What the wire says (docs/hypotheses.md §24 F55) -------------------------
//
// Besides the refusal text, M365 states the exhaustion and the allowances
// outright. The refusal turn's final item carries `result: {value:
// "OutOfCredits", message: <the refusal text>, creditScenario: "TotalTurn"}`,
// and every turn on the paid scenario carries `throttling.metering`, a map of
// `{<budget>: {remainingAllowance: n}}`. Each turn of a metered model takes one
// from its daily and its weekly allowance, whatever its size. Included-scenario
// turns carry no `metering` (Opus 4.5 and Sonnet 4.6 aren't metered).

/** A separately metered model's priority-access budget. */
export type MeteredBudget = "opus" | "sonnet-5.5";

/**
 * Where each budget sits in `throttling.metering`, and what to call it.
 * - Opus 5.5: `ClaudeOpusQuery75` is the weekly allowance (75, from the Monday
 *   reset) and `ClaudeOpusQueryDaily` the daily one (40) (§24 F55).
 * - Sonnet 5.5: `ClaudeSonnet55QueryDaily` (80) and `ClaudeSonnet55QueryWeekly`
 *   (150), read 79/149 after the first turn (§26). Sonnet 5 lowers neither.
 */
export const METERED_BUDGETS: Readonly<Record<MeteredBudget, { label: string; usageKey: string; daily: string; weekly: string }>> = {
  opus: { label: "Opus", usageKey: "opus", daily: "ClaudeOpusQueryDaily", weekly: "ClaudeOpusQuery75" },
  "sonnet-5.5": { label: "Sonnet 5.5", usageKey: "sonnet55", daily: "ClaudeSonnet55QueryDaily", weekly: "ClaudeSonnet55QueryWeekly" },
};

/** `throttling.metering` as `{budget: remainingAllowance}`; null when absent or empty. */
export function parseMetering(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = (v as { remainingAllowance?: unknown } | null)?.remainingAllowance;
    if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

/** One budget's allowances in a metering map, when it has them. */
export function meteredAllowance(
  metering: Record<string, number> | null | undefined,
  budget: MeteredBudget,
): { daily?: number; weekly?: number } | null {
  if (!metering) return null;
  const daily = metering[METERED_BUDGETS[budget].daily];
  const weekly = metering[METERED_BUDGETS[budget].weekly];
  if (daily === undefined && weekly === undefined) return null;
  return { ...(daily !== undefined ? { daily } : {}), ...(weekly !== undefined ? { weekly } : {}) };
}

/**
 * The exhaustion a turn reports, from its final `result` and/or its text.
 * `OutOfCredits` is authoritative even if the refusal is ever reworded; the
 * text alone still counts (older builds, and the result is missing on some
 * paths). Null for an ordinary turn.
 */
export function priorityAccessExhaustionOf(
  result: { value: string; message?: string } | null | undefined,
  text: string | null | undefined,
  now: Date = new Date(),
): PriorityAccessExhaustion | null {
  const fromText = parsePriorityAccessExhaustion(result?.message, now) ?? parsePriorityAccessExhaustion(text, now);
  if (fromText) return fromText;
  if (result?.value !== "OutOfCredits") return null;
  const message = (result.message ?? text ?? "").trim() || "OutOfCredits";
  const window: PriorityAccessWindow = /\bweek|monday/i.test(message) ? "week" : "day";
  return { window, resetsAt: window === "week" ? nextUtcMonday(now) : nextUtcMidnight(now), message };
}

// --- Remembering it ----------------------------------------------------------
//
// Once a metered turn has been refused, every further turn on that budget until
// the reset is refused too. Each of those refusals still starts an M365 turn,
// often in a fresh conversation — the thread budget the account throttles on
// (F13) — so the proxy answers them itself until the reset. One process serves
// one account, so this is per-account knowledge. Kept per budget: an Opus wall
// says nothing about Sonnet 5.5's. A model not known to be metered that gets an
// `OutOfCredits` anyway is remembered under its model ID.
const exhaustions = new Map<string, PriorityAccessExhaustion>();

/** Record that the budget under `key` (a MeteredBudget, or a model ID) ran out. */
export function notePriorityAccessExhausted(key: string, e: PriorityAccessExhaustion, now: Date = new Date()): void {
  const known = exhaustions.get(key);
  if (!known || e.resetsAt > known.resetsAt || known.resetsAt <= now) exhaustions.set(key, e);
}

/** The recorded exhaustion under `key`, while it lasts; null once its reset has passed. */
export function activePriorityAccessExhaustion(key: string, now: Date = new Date()): PriorityAccessExhaustion | null {
  const known = exhaustions.get(key);
  if (known && known.resetsAt <= now) exhaustions.delete(key);
  return exhaustions.get(key) ?? null;
}

/** Forget it. For tests. */
export function resetPriorityAccessState(): void {
  exhaustions.clear();
}
