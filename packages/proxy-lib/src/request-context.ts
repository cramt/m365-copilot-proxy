import type { z } from "zod/v4";
import type { ChatCompletionRequest } from "./schemas.js";
export interface RequestContext { signal?: AbortSignal; sessionHint?: string; idempotencyKey?: string; trustedPrincipal?: string }
export class RequestContextError extends Error { constructor(message: string, public status = 400, public code = "invalid_request_context") { super(message); } }
function hint(value: string | undefined | null): string | undefined {
  if (value == null) return undefined;
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw new RequestContextError("Invalid or oversized session/idempotency identifier");
  return value;
}
export function requestContext(body: z.infer<typeof ChatCompletionRequest>, headers = new Headers()): RequestContext {
  const claude = body.metadata?.user_id?.match(/^user_[A-Za-z0-9_-]+_account_[A-Za-z0-9_-]*_session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
  const values = [headers.get("x-claude-code-session-id"), headers.get("x-opencode-session"), body.session_id, claude].map(hint).filter((v): v is string => v !== undefined);
  if (new Set(values).size > 1) throw new RequestContextError("Conflicting session identifiers");
  return { sessionHint: values[0], idempotencyKey: hint(headers.get("idempotency-key")) };
}
