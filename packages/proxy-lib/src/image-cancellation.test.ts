import { expect, it, vi } from "vitest";
const download = vi.hoisted(() => vi.fn(async (_url: string, _token: string, _signal?: AbortSignal) => ({ data: Buffer.from([1]), contentType: "image/png" })));
vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  return { ...actual, getImageArtifactToken: async () => "synthetic-artifact", fetchImageBytes: download, awaitTurnBudget: async () => ({ waitedMs: 0 }), ModelSession: class {
    turnCount = 0; conversationId = "synthetic";
    async run() { return { fullText: "", images: [{ referenceUrls: ["https://designerapp.officeapps.live.com/a?sig=synthetic"] }], result: { value: "Success" }, async *[Symbol.asyncIterator]() {} }; }
  } };
});
import { handleChatCompletion, SessionPool, ChatCompletionRequest } from "./index.js";
it("chat image rendering forwards the caller's cancellation signal", async () => {
  const controller = new AbortController();
  const response = await handleChatCompletion(ChatCompletionRequest.parse({ model: "m365-copilot", messages: [{ role: "user", content: "draw" }] }), new SessionPool(), { signal: controller.signal });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("data:image/png;base64,AQ==");
  expect(download).toHaveBeenCalledWith("https://designerapp.officeapps.live.com/a?sig=synthetic", "synthetic-artifact", controller.signal);
});
