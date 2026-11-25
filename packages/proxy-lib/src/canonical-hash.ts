import { createHash } from "node:crypto";
import { RequestContextError } from "./request-context.js";

const MAX_DEPTH = 64;
const MAX_NODES = 100000;
const MAX_BYTES = 4 * 1024 * 1024;

/** Iterative preflight bounds recursion, sorting and serialization before allocating state. */
export function validateCanonicalInput(value: unknown): void {
  const active = new WeakSet<object>();
  const stack: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }];
  let nodes = 0, bytes = 0;
  const limit = () => { throw new RequestContextError("Request structure exceeds canonicalization limits", 413, "request_structure_limit"); };
  const invalid = () => { throw new RequestContextError("Request contains a non-JSON value", 400, "invalid_request_structure"); };
  const countString = (text: string) => {
    if (text.length > MAX_BYTES) limit();
    bytes += Buffer.byteLength(JSON.stringify(text));
  };
  while (stack.length) {
    const item = stack.pop()!;
    const v = item.value;
    if (item.exit) { active.delete(v as object); continue; }
    if (++nodes > MAX_NODES || item.depth > MAX_DEPTH) limit();
    if (v && typeof v === "object") {
      if (active.has(v)) invalid();
      if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) invalid();
      if (Array.isArray(v) && v.length + nodes > MAX_NODES) limit();
      const keys = Object.keys(v);
      if (Array.isArray(v)) {
        const holes = v.length - keys.filter(key => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < v.length).length;
        nodes += holes; bytes += holes * 5;
      }
      if (keys.length + nodes + stack.length > MAX_NODES) limit();
      bytes += 2 + keys.length; // container delimiters and separators
      active.add(v); stack.push({ value: v, depth: item.depth, exit: true });
      for (const key of keys) {
        if (!Array.isArray(v)) { countString(key); bytes++; }
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        if (!descriptor || !("value" in descriptor)) invalid();
        stack.push({ value: descriptor!.value, depth: item.depth + 1 });
      }
    } else if (typeof v === "string") countString(v);
    else if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") bytes += JSON.stringify(v)?.length ?? 4;
    else invalid();
    if (bytes > MAX_BYTES) limit();
  }
}

/** JSON object insertion order is irrelevant; array order remains significant. */
export function canonicalHash(value: unknown): string {
  validateCanonicalInput(value);
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      const record = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().filter(k => record[k] !== undefined).map(k => [k, canonical(record[k])]));
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "null").digest("hex");
}
