import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchImageBytes } from "./image.js";

const url = "https://designerapp.officeapps.live.com/designerapp/document.ashx?path=%2Fa%252Fb&sig=opaque+signature%2B";
const token = "synthetic-image-bearer";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function streamResponse(chunks: number[], headers: Record<string, string> = {}) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { for (const size of chunks) controller.enqueue(new Uint8Array(size)); },
    cancel,
  });
  return { response: new Response(body, { headers }), cancel };
}

describe("image artifact credential boundary", () => {
  it.each([
    "https://evil.example/a", "http://designerapp.officeapps.live.com/a",
    "https://designerapp.officeapps.live.com.evil.example/a",
    "https://other.officeapps.live.com/a", "https://designerappservice.officeapps.live.com/a",
    "https://user:password@designerapp.officeapps.live.com/a",
    "https://@designerapp.officeapps.live.com/a",
    "https://designerapp.officeapps.live.com:444/a",
    "https://designerapp.officeapps.live.com./a",
    " https://designerapp.officeapps.live.com/a",
    "https://designerapp.officeapps.live.com/a\n?sig=secret",
    "https://designerapp.officeapps.live.com\\@evil.example/a",
    "https:////designerapp.officeapps.live.com/a", "not a URL",
  ])("rejects untrusted or normalized input without fetch: %s", async (input) => {
    const fetcher = vi.fn(async () => new Response("unexpected"));
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchImageBytes(input, token)).rejects.toThrow("Untrusted image artifact URL");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "/a/../signed", "/a/./signed", "/a/.", "/a/..",
    "/a/%2e/signed", "/a/%2E%2e/signed", "/a/.%2E/signed",
    "/a/%2e./signed", "/%2E%2E/signed", "/a/../signed?sig=%2F",
    "/a/é?sig=x", '/a/"signed', "/a/<signed", "/a/`signed",
    "/a?sig='signed", '/a?sig="signed', "/a#signed", "?sig=x", "",
  ])("rejects transport-normalizing signed locators before dispatch: %s", async (target) => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchImageBytes(`https://designerapp.officeapps.live.com${target}`, token))
      .rejects.toThrow(/^Untrusted image artifact URL$/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves opaque signed URL bytes and sends bearer only with redirects disabled", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } }));
    vi.stubGlobal("fetch", fetcher);
    const result = await fetchImageBytes(url, token);
    expect(result).toEqual({ data: Buffer.from([1, 2, 3]), contentType: "image/webp" });
    expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal), headers: { Authorization: `Bearer ${token}` } }));
  });

  it("cancels non-OK bodies and excludes status text, signed URLs and tokens from errors", async () => {
    const { response, cancel } = streamResponse([1]);
    const failure = new Response(response.body, { status: 302, statusText: `${token} ${url}`, headers: { location: "https://evil.example/" } });
    const fetcher = vi.fn(async () => failure);
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchImageBytes(url, token)).rejects.toThrow(/^Image artifact fetch failed: HTTP 302$/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("sanitizes transport errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`${url} ${token}`); }));
    await expect(fetchImageBytes(url, token)).rejects.toThrow(/^Image artifact fetch failed$/);
  });

  it.each<Record<string, string>>([{}, { "content-length": "1" }, { "content-length": "5" }])("cancels oversized bodies with headers %j", async (headers) => {
    vi.stubEnv("M365_MAX_IMAGE_BYTES", "4");
    const { response, cancel } = streamResponse([3, 2], headers);
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(fetchImageBytes(url, token)).rejects.toThrow("Image artifact exceeds the configured size limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects pre-aborted requests before dispatch without reflecting abort reasons", async () => {
    const controller = new AbortController(); controller.abort(new Error(token));
    const fetcher = vi.fn(async () => new Response("unused")); vi.stubGlobal("fetch", fetcher);
    await expect(fetchImageBytes(url, token, controller.signal)).rejects.toThrow(/^Image artifact fetch aborted$/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds the entire operation including headers", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init) => { signal = init.signal; return new Promise(() => {}); }));
    const pending = expect(fetchImageBytes(url, token)).rejects.toThrow("Image artifact fetch timed out");
    await vi.advanceTimersByTimeAsync(60_001);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["deadline", "caller"])("retires a pending body read on %s cancellation", async (mode) => {
    vi.useFakeTimers();
    const { response, cancel } = streamResponse([1]);
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const pending = expect(fetchImageBytes(url, token, controller.signal)).rejects.toThrow(mode === "deadline" ? "timed out" : "aborted");
    await vi.advanceTimersByTimeAsync(30_000);
    if (mode === "caller") controller.abort(new Error(`${url} ${token}`));
    else await vi.advanceTimersByTimeAsync(30_001);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
