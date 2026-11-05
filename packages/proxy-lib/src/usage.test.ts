import { describe, expect, it } from "vitest";
import { estimateVisibleUsage } from "./usage.js";

describe("visible character usage estimator", () => {
  it("rounds Unicode code points once per side and does not invent hidden reasoning", () => {
    const usage = estimateVisibleUsage([{ content: "😀😀😀😀😀" }], undefined, { text: "你好世界!" });
    expect(usage).toMatchObject({ prompt_tokens: 2, completion_tokens: 2, total_tokens: 4, x_m365_usage_estimated: true, x_m365_usage_basis: "visible_context_chars_div_4" });
    expect(usage).not.toHaveProperty("completion_tokens_details");
  });
  it("counts complete message history, tool definitions and emitted tool names/arguments", () => {
    const messages = [{ content: "abcd" }, { content: null, tool_calls: [{ function: { name: "bash", arguments: "1234" } }] }, { content: "efgh" }];
    const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }];
    const usage = estimateVisibleUsage(messages, tools, { toolCalls: [{ function: { name: "bash", arguments: "12345" } }] });
    expect(usage.prompt_tokens).toBe(Math.ceil((16 + Array.from(JSON.stringify(tools)).length) / 4));
    expect(usage.completion_tokens).toBe(3);
  });
  it("does not treat image data URLs or unknown modalities as text tokens", () => {
    const usage = estimateVisibleUsage([{ content: [{ type: "text", text: "abcd" }, { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(10000) } }, { type: "input_audio" }] }], undefined, { text: "![generated image](data:image/png;base64," + "A".repeat(10000) + ")" });
    expect(usage.prompt_tokens).toBe(1);
    expect(usage.completion_tokens).toBeLessThan(20);
    expect(usage.x_m365_usage_unestimated_modalities).toEqual(["image", "input_audio"]);
  });
  it("empty visible sides remain zero", () => {
    expect(estimateVisibleUsage([], undefined, { text: "" })).toMatchObject({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});
