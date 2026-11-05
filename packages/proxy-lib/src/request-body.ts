/** Body limits are local ingress policy, independent of upstream response limits. */
export function requestBodyLimits() {
  const positive = (value: string | undefined, fallback: number, max: number) => {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
  };
  return {
    bytes: positive(process.env.M365_MAX_REQUEST_BYTES, 32 * 1024 * 1024, Number.MAX_SAFE_INTEGER),
    timeoutMs: positive(process.env.M365_REQUEST_BODY_TIMEOUT_MS, 30_000, 2_147_483_647),
  };
}

export class RequestBodyError extends Error {
  constructor(public readonly status: 400 | 408 | 413, public readonly code: string, message: string) {
    super(message);
  }
}

export function requestBodyErrorResponse(error: unknown): Response {
  const failure = error instanceof RequestBodyError ? error
    : new RequestBodyError(400, "invalid_request_body", "Malformed JSON or invalid request body");
  return Response.json({ error: { message: failure.message, type: "invalid_request_error", code: failure.code } }, {
    status: failure.status,
    headers: { "x-should-retry": "false" },
  });
}

/** Count actual bytes; Content-Length is only an early rejection optimization. */
export async function readRequestJson(body: ReadableStream<Uint8Array> | null, length?: string | null, signal?: AbortSignal): Promise<unknown> {
  const limits = requestBodyLimits();
  const deadline = performance.now() + limits.timeoutMs;
  const timeout = () => new RequestBodyError(408, "request_body_timeout", "Request body deadline exceeded");
  const tooLarge = () => new RequestBodyError(413, "request_too_large", "Request body exceeds the configured size limit");
  const reader = body?.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    if (length && /^\d+$/.test(length) && Number(length) > limits.bytes) throw tooLarge();
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new RequestBodyError(400, "request_aborted", "Request body aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(timeout()), limits.timeoutMs);
    });
    if (signal?.aborted) abort();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) {
      const { value, done } = await Promise.race([reader.read(), stopped]);
      // Ready reads can starve timer callbacks; enforce monotonic elapsed time too.
      if (performance.now() >= deadline) throw timeout();
      if (signal?.aborted) await stopped;
      if (done) break;
      size += value.byteLength;
      if (size > limits.bytes) throw tooLarge();
      chunks.push(value);
    }
    // Also observe pre-abort for an empty body without a reader.
    if (signal?.aborted) await stopped;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new RequestBodyError(400, "invalid_request_body", "Malformed JSON or invalid UTF-8 request body"); }
  } catch (error) {
    // Never wait on an uncooperative producer's cancellation promise.
    if (reader) void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    reader?.releaseLock();
  }
}
