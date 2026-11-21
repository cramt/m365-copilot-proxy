/** A request body the proxy refuses to read: too large, too slow, or not JSON. */
export class RequestBodyError extends Error {
  constructor(public readonly status: 400 | 408 | 413, message: string) {
    super(message);
  }
}

const positive = (name: string, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

/**
 * Read a request body as JSON, at most `M365_MAX_REQUEST_BYTES` (default 32 MiB)
 * and within `M365_REQUEST_BODY_TIMEOUT_MS` (default 30 s) in total. The bytes
 * that arrive are counted; Content-Length only rejects early. An empty body
 * gives `undefined`, so the caller's schema reports it.
 */
export async function readRequestJson(body: AsyncIterable<Uint8Array>, contentLength?: string | null): Promise<unknown> {
  const maxBytes = positive("M365_MAX_REQUEST_BYTES", 32 * 1024 * 1024);
  const timeoutMs = positive("M365_REQUEST_BODY_TIMEOUT_MS", 30_000, 2_147_483_647);
  const tooLarge = () => new RequestBodyError(413, `Request body exceeds ${maxBytes} bytes`);
  if (Number(contentLength) > maxBytes) throw tooLarge();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestBodyError(408, "Request body not received in time")), timeoutMs);
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const it = body[Symbol.asyncIterator]();
    for (;;) {
      const { value, done } = await Promise.race([it.next(), expired]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new RequestBodyError(400, "Invalid UTF-8 body");
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestBodyError(400, "Invalid JSON body");
  }
}
