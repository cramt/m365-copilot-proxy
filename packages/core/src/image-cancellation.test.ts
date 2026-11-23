import { afterEach, expect, it, vi } from "vitest";
const artifact = "https://designerapp.officeapps.live.com/designerapp/document.ashx?sig=synthetic";
vi.mock("./session.js", () => ({ CopilotSession: class {
  async chat() { return { images: [{ referenceUrls: [artifact] }], async *[Symbol.asyncIterator]() {} }; }
} }));
vi.mock("./turn-budget.js", () => ({ awaitTurnBudget: async () => ({ waitedMs: 0 }) }));
import { generateImage } from "./image.js";
afterEach(() => vi.unstubAllGlobals());
it("generateImage carries caller cancellation into artifact download", async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel });
  vi.stubGlobal("fetch", vi.fn(async () => { queueMicrotask(() => controller.abort()); return new Response(body); }));
  await expect(generateImage("synthetic", { token: "synthetic-chat", artifactToken: "synthetic-artifact", signal: controller.signal })).rejects.toThrow("aborted");
  expect(cancel).toHaveBeenCalledOnce();
});
