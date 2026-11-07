import {
  activePriorityAccessExhaustion,
  type PriorityAccessExhaustion,
  AccountPolicyError,
  getScenarioForModel,
  getToneForModel,
  isModelNotLicensed,
  meteredBudgetOf,
  reasoningWallKey,
} from "@m365-copilot/core";

/**
 * Where a refused client could go instead, best first. Quick tones lead for the
 * reasoning cap (they kept serving while Think deeper was walled); a model
 * priority-access wall leads with Sonnet. A hint list, not a promise: every
 * entry is filtered against what this process knows about the account.
 */
const POOLS = {
  "reasoning-turns": ["gpt-5.5", "gpt-5.6"],
  "priority-access": ["claude-sonnet", "gpt-5.5-think-deeper", "gpt-5.5", "gpt-5.6"],
} as const;

/**
 * The wall a refusal on `model` is recorded under. One writer, one reader: a
 * metered model uses its budget; the reasoning cap, when the refusal carries it
 * and the model is on a reasoning tone, uses the key every such model shares;
 * anything else walls only its own model ID.
 */
export function wallKeyFor(model: string, reasoningCap: boolean): string {
  return meteredBudgetOf(model) ?? (reasoningCap ? reasoningWallKey(model) : null) ?? model;
}

/** Is a recorded refusal the reasoning cap *for this model*? Only a reasoning-tone, unmetered model can be. */
export const isReasoningCapFor = (model: string, exhaustion: { kind?: string }) =>
  exhaustion.kind === "reasoning-turns" && meteredBudgetOf(model) === null && reasoningWallKey(model) !== null;

/** The active wall for `model`: the shared reasoning wall first, then the model's own. Null when none. */
export function activeWallFor(model: string): PriorityAccessExhaustion | null {
  const budget = meteredBudgetOf(model);
  if (budget) return activePriorityAccessExhaustion(budget);
  const shared = reasoningWallKey(model);
  const reasoning = shared ? activePriorityAccessExhaustion(shared) : null;
  if (reasoning) return { ...reasoning, kind: "reasoning-turns" };
  return activePriorityAccessExhaustion(model);
}

const sameRoute = (a: string, b: string) =>
  getToneForModel(a) === getToneForModel(b) && getScenarioForModel(a).scenario === getScenarioForModel(b).scenario;

function walled(model: string): boolean {
  try { return activeWallFor(model) !== null; }
  catch (error) {
    // An unreadable store must not hide the refusal being explained; it only
    // costs the hint one exclusion.
    if (error instanceof AccountPolicyError) return false;
    throw error;
  }
}

/** Models worth suggesting after `refused` was refused: not itself, not walled, not known unlicensed. */
export function suggestModels(refused: string, kind: keyof typeof POOLS): string[] {
  return POOLS[kind].filter((candidate) =>
    !sameRoute(candidate, refused) &&
    !walled(candidate) && !isModelNotLicensed(candidate));
}

export function suggestionSentence(models: string[]): string {
  return models.length
    ? `Switch to ${models.join(" or ")}, or wait.`
    : "No other model is available to this account right now; wait.";
}
