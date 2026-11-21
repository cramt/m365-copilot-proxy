import { getToneForModel, getScenarioForModel, getTransport, getStreamHubScenario, getAvailableModels } from "@m365-copilot/core";

export function refusalRoute(model: string): string {
  if (!getAvailableModels().includes(model)) return `label:${model}`;
  const scenario = getTransport() === "streamhub" ? getStreamHubScenario().scenario : getScenarioForModel(model).scenario;
  return JSON.stringify([getTransport(), scenario, getToneForModel(model)]);
}

// Consumer report: the two reasoning tones share a cap. The reset is an estimate.
const walls = new Map<string, number>();
const licences = new Map<string, Map<string, number>>();
const modelWalls = new Map<string, Map<string, number>>();
const MAX_SCOPES = 64;
const TTL = 60 * 60_000;
export function sharedReasoning(model: string): boolean {
  // The consumer report describes the two published 5.5/5.6 reasoning tones only.
  return getAvailableModels().includes(model) && ["Gpt_5_5_Reasoning", "Gpt_5_6_Reasoning"].includes(getToneForModel(model));
}
export function capResult(result: { value: string; errorCode?: string } | null | undefined): boolean {
  return result?.value === "OutOfCredits" && result.errorCode === "ReasoningTurnExhausted";
}
export function resetTime(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
export function activeReasoning(scope: string | null, now = Date.now()): number | null {
  if (!scope) return null;
  const end = walls.get(scope);
  if (end === undefined) return null;
  if (end <= now) { walls.delete(scope); return null; }
  return end;
}
export function noteReasoning(scope: string | null, end: number): void {
  if (!scope) return;
  if (!walls.has(scope) && walls.size >= MAX_SCOPES) walls.delete(walls.keys().next().value!);
  walls.set(scope, end);
}
export function noteLicence(scope: string | null, route: string, now = Date.now()): void {
  if (!scope) return;
  if (!licences.has(scope) && licences.size >= MAX_SCOPES) licences.delete(licences.keys().next().value!);
  const entries = licences.get(scope) ?? new Map<string, number>();
  if (entries.size >= 64) entries.delete(entries.keys().next().value!);
  entries.set(route, now + TTL);
  licences.set(scope, entries);
}
export function noteModelWall(scope: string | null, route: string | null, end: number): void {
  if (!scope || !route) return;
  if (!modelWalls.has(scope) && modelWalls.size >= MAX_SCOPES) modelWalls.delete(modelWalls.keys().next().value!);
  const entries = modelWalls.get(scope) ?? new Map<string, number>();
  if (entries.size >= 64) entries.delete(entries.keys().next().value!);
  entries.set(route, end);
  modelWalls.set(scope, entries);
}
export function suggestions(scope: string | null, refused: string, now = Date.now()): string[] {
  const known = scope ? licences.get(scope) : undefined;
  return ["gpt-5.5", "gpt-5.6"].filter((model) => refusalRoute(model) !== refusalRoute(refused) && (known?.get(refusalRoute(model)) ?? 0) <= now && (scope ? (modelWalls.get(scope)?.get(refusalRoute(model)) ?? 0) <= now : true));
}
export function resetRefusalState(): void { walls.clear(); licences.clear(); modelWalls.clear(); }
