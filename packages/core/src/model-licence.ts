import { currentAccountContext } from "./account-policy.js";
import { getScenarioForModel, getToneForModel } from "./copilot.js";

// Models M365 refused this account as not licensed (ForbiddenRequest with a model
// licence code). Only used to stop suggesting them: a wrong entry costs a worse
// hint, never a refusal, so it is kept in process and expires — a licence change
// shows up within the hour. Partitioned by account so one account's refusals
// never shape another's hints; nothing is persisted, so no store schema moves.
const TTL_MS = 60 * 60_000;
const MAX_ACCOUNTS = 64;
const MAX_MODELS = 64;
const refused = new Map<string, Map<string, number>>();

const scope = () => currentAccountContext()?.key ?? "";

// M365 licenses a route (tone + scenario), not a label: "gpt-5.5" and "gpt-5.5-quick"
// are one entitlement, so they must be one entry.
// An unrecognised label falls back to the auto-router tone, so it must not share an entry with
// every other unrecognised label (or with the auto-router): it keeps its own.
const routeOf = (model: string) => {
  const tone = getToneForModel(model);
  return tone === getToneForModel("m365-copilot") && model !== "m365-copilot"
    ? `label|${model}`
    : `${tone}|${getScenarioForModel(model).scenario}`;
};

export function noteModelNotLicensed(model: string, now = Date.now()): void {
  if (typeof model !== "string" || !model.length || model.length > 256) return;
  const key = scope();
  let models = refused.get(key);
  if (!models) {
    if (refused.size >= MAX_ACCOUNTS) refused.delete(refused.keys().next().value!);
    models = new Map();
    refused.set(key, models);
  }
  const route = routeOf(model);
  models.delete(route); // re-insert keeps insertion order == recency
  if (models.size >= MAX_MODELS) models.delete(models.keys().next().value!);
  models.set(route, now + TTL_MS);
}

export function isModelNotLicensed(model: string, now = Date.now()): boolean {
  const models = refused.get(scope());
  const route = routeOf(model);
  const until = models?.get(route);
  if (until === undefined) return false;
  if (until <= now) { models!.delete(route); return false; }
  return true;
}

/** Forget everything. For tests. */
export function resetModelLicenceState(): void {
  refused.clear();
}
