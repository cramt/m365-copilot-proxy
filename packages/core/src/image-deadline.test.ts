import { afterEach, expect, it, vi } from "vitest";
import { fetchImageBytes } from "./image.js";

const trusted = "https://designerapp.officeapps.live.com/signed?sig=synthetic%2Bopaque";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Real WHATWG streams and promise continuations, with only the monotonic clock
// advanced deterministically. Timers remain real: ready reads never yield to them.
it("bounds continuously ready native body reads without waiting for the timer", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const cancel = vi.fn();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      now += 15_001;
      if (++pulls <= 6) controller.enqueue(new Uint8Array([1]));
      else controller.close();
    }, cancel,
  });
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    signal = init.signal!;
    return new Response(body);
  });
  await expect(fetchImageBytes(trusted, "synthetic-bearer")).rejects.toThrow(/^Image artifact fetch timed out$/);
  expect(signal?.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  expect(pulls).toBeLessThan(6);
});

it("rejects native EOF arriving exactly at the absolute deadline", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (++pulls === 1) controller.enqueue(new Uint8Array([1]));
    else { now = 60_000; controller.close(); }
  } });
  vi.stubGlobal("fetch", async () => new Response(body));
  await expect(fetchImageBytes(trusted, "synthetic-bearer")).rejects.toThrow(/^Image artifact fetch timed out$/);
});

it("retires a response that resumes after deadline before interpreting headers", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  vi.stubGlobal("fetch", async () => {
    now = 60_001;
    return new Response(body, { status: 403, statusText: "synthetic-private-status" });
  });
  await expect(fetchImageBytes(trusted, "synthetic-bearer")).rejects.toThrow(/^Image artifact fetch timed out$/);
  expect(cancel).toHaveBeenCalledOnce();
});

it("includes final buffer assembly in the absolute deadline", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const concat = Buffer.concat;
  vi.spyOn(Buffer, "concat").mockImplementation((...args) => {
    const result = concat(...args);
    now = 60_001;
    return result;
  });
  vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1])));
  await expect(fetchImageBytes(trusted, "synthetic-bearer")).rejects.toThrow(/^Image artifact fetch timed out$/);
});

it("accepts a ready native body before deadline without changing signed locator or bearer", async () => {
  vi.spyOn(performance, "now").mockReturnValue(42);
  const transport = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal("fetch", transport);
  expect((await fetchImageBytes(trusted, "synthetic-bearer")).data).toEqual(Buffer.from([1, 2, 3]));
  expect(transport).toHaveBeenCalledWith(trusted, expect.objectContaining({
    redirect: "error", headers: { Authorization: "Bearer synthetic-bearer" },
  }));
});
