import { createHash } from "node:crypto";

/** Scope hint from locally supplied claims, not token authentication. */
export function tokenScope(token: string): string | null {
  try {
    if (token.length > 32768) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]{1,16384}$/.test(parts[1] ?? "")) return null;
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof claims.tid !== "string" || typeof claims.oid !== "string" || !guid.test(claims.tid) || !guid.test(claims.oid)) return null;
    return createHash("sha256").update(`${claims.tid.toLowerCase()}:${claims.oid.toLowerCase()}`).digest("hex");
  } catch { return null; }
}
