import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestBodyError, readRequestJson } from "./request-body.js";

const enc = (s: string) => new TextEncoder().encode(s);
async function* chunks(...parts: Uint8Array[]) { for (const p of parts) yield p; }
const stalled = async function* () { yield enc("{"); await new Promise(() => {}); };
const fails = (p: Promise<unknown>, status: number) =>
  p.then(() => { throw new Error("resolved"); }, (e) => {
    expect(e).toBeInstanceOf(RequestBodyError);
    expect(e.status).toBe(status);
  });

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.M365_MAX_REQUEST_BYTES;
  delete process.env.M365_REQUEST_BODY_TIMEOUT_MS;
});

describe("readRequestJson", () => {
  it("parses a JSON body split across chunks", async () => {
    expect(await readRequestJson(chunks(enc('{"a":'), enc("1}")))).toEqual({ a: 1 });
  });

  it("treats an empty body as undefined, so the schema reports it", async () => {
    expect(await readRequestJson(chunks())).toBeUndefined();
  });

  it("rejects by Content-Length before reading", async () => {
    process.env.M365_MAX_REQUEST_BYTES = "10";
    await fails(readRequestJson(stalled(), "11"), 413);
  });

  it("counts the bytes that arrive, whatever Content-Length claims", async () => {
    process.env.M365_MAX_REQUEST_BYTES = "10";
    await fails(readRequestJson(chunks(enc('{"a":"123'), enc('456"}')), "5"), 413);
    await fails(readRequestJson(chunks(enc('{"a":"123'), enc('456"}'))), 413);
    // Five characters, twelve bytes.
    await fails(readRequestJson(chunks(enc('"ééééé"'))), 413);
  });

  it("gives up on a body that stops arriving", async () => {
    process.env.M365_REQUEST_BODY_TIMEOUT_MS = "50";
    await fails(readRequestJson(stalled()), 408);
  });

  it("replay_e903b53 rejects ready native stream reads and EOF past the absolute deadline", async () => {
    process.env.M365_REQUEST_BODY_TIMEOUT_MS = "5";
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        now += 3;
        if (now <= 6) controller.enqueue(enc(now === 3 ? "{" : "}"));
        else controller.close();
      },
    });
    await fails(readRequestJson(stream), 408);
  });

  it("rejects EOF after the deadline and accepts EOF before it", async () => {
    process.env.M365_REQUEST_BODY_TIMEOUT_MS = "5";
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stream = (late: boolean) => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(enc("{}")); },
      pull(controller) { now = late ? 6 : 4; controller.close(); },
    });
    await fails(readRequestJson(stream(true)), 408);
    now = 0;
    expect(await readRequestJson(stream(false))).toEqual({});
  });

  it("enforces real elapsed time even while ready native reads starve timers", async () => {
    process.env.M365_REQUEST_BODY_TIMEOUT_MS = "5";
    const start = performance.now();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (performance.now() - start < 30) controller.enqueue(enc(" "));
        else { controller.enqueue(enc("{}")); controller.close(); }
      },
    });
    await fails(readRequestJson(stream), 408);
    expect(await readRequestJson(chunks(enc("{}")))).toEqual({});
  });

  it("rejects invalid UTF-8 and invalid JSON with a 400", async () => {
    await fails(readRequestJson(chunks(new Uint8Array([0x22, 0xff, 0x22]))), 400);
    await fails(readRequestJson(chunks(enc("{nope"))), 400);
  });
});
