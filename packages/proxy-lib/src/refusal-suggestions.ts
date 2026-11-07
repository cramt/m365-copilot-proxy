import {
  activePriorityAccessExhaustion,
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

/** The key a model's wall is recorded under (see handler: budget, shared reasoning cap, else the model). */
export const wallKeyOf = (model: string) => meteredBudgetOf(model) ?? reasoningWallKey(model) ?? model;

const sameRoute = (a: string, b: string) =>
  getToneForModel(a) === getToneForModel(b) && getScenarioForModel(a).scenario === getScenarioForModel(b).scenario;

function walled(model: string): boolean {
  try { return activePriorityAccessExhaustion(wallKeyOf(model)) !== null; }
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
