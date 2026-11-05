import { createHash } from "node:crypto";

/** Preserve v1 known-budget rows; unknown model identifiers never reach SQLite. */
export function priorityDimension(key: string): string {
  if (typeof key !== "string" || !key.length || key.length > 256) throw new Error("Invalid priority dimension");
  return key === "opus" || key === "sonnet-5.5" ? key : "model-sha256:" + createHash("sha256").update(key).digest("hex");
}
export function validPriorityDimension(value: unknown): boolean {
  return typeof value === "string" && (value === "opus" || value === "sonnet-5.5" || /^model-sha256:[a-f0-9]{64}$/.test(value));
}
