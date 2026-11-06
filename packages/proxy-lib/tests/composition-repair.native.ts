import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wire } from "./native-test-transport.js";
import { SessionPool, handleChatCompletion } from "../src/handler.js";
import { ChatCompletionRequest } from "../src/schemas.js";
const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222";
let oid = A, directory: string;
const options = { useAgent: false, getToken: async () => `e30.${Buffer.from(JSON.stringify({ tid: A, oid, aud: "synthetic", iss: "synthetic", exp: 9999999999 })).toString("base64url")}.sig` };
const tools = [
  { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
  { type: "function", function: { name: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } },
];
beforeEach(() => {
  oid = A; directory = mkdtempSync(join(tmpdir(), "repair-native-"));
  process.env.M365_ACCOUNT_POLICY_PATH = join(directory, "policy.sqlite");
  process.env.M365_NO_CONFAB_RETRY = "1";
  wire.sockets = []; wire.texts = []; wire.hold = false; wire.replies = []; wire.onChat = undefined;
});
afterEach(() => { for (const socket of wire.sockets) socket.close(); rmSync(directory, { recursive: true, force: true }); delete process.env.M365_ACCOUNT_POLICY_PATH; delete process.env.M365_NO_CONFAB_RETRY; });
async function decode(response: Response, stream: boolean) {
  const raw = await response.text();
  if (!stream) return { raw, message: JSON.parse(raw).choices[0].message };
  const frames = raw.split("\n").filter(s => s.startsWith("data: {")).map(s => JSON.parse(s.slice(6)));
  return { raw, message: { role: "assistant", content: frames.map(f => f.choices?.[0]?.delta?.content ?? "").join(""), tool_calls: frames.flatMap(f => f.choices?.[0]?.delta?.tool_calls ?? []).map(({ index, ...call }: any) => call) } };
}
for (const stream of [false, true]) for (const mode of ["success", "failed", "unknown", "none", "specific", "removed", "schema", "account", "model-run", "cancel"]) {
  it(`mediates long-command result ${mode}, stream=${stream}`, async () => {
    const pool = new SessionPool(options), messages: any[] = [{ role: "user", content: `long ${mode}` }];
    wire.answer = "```bash\n" + `py - <<'EOF'\nprint(${"1+".repeat(5000)}1)\nEOF` + "\n```";
    const platform = process.platform;
    let first;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      first = await decode(await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", stream, tools, messages }), pool), stream);
    } finally { Object.defineProperty(process, "platform", { value: platform }); }
    const call = first.message.tool_calls[0]; expect(call.function.name).toBe("write");
    messages.push({ role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: mode === "failed" ? "Error: EACCES; file not written" : mode === "unknown" ? "arbitrary opaque result" : "Successfully wrote script" });
    if (mode === "account") oid = B;
    const scriptPath = JSON.parse(call.function.arguments).path;
    wire.answer = mode === "model-run" ? "```bash\nbash '" + scriptPath + "'\n```" : "ordinary response";
    const before = wire.texts.length;
    const currentTools = mode === "removed" ? tools.slice(1) : mode === "schema" ? tools.map(t => t.function.name === "bash" ? { ...t, function: { ...t.function, parameters: { type: "object", properties: { incompatible: { type: "number" } } } } } : t) : tools;
    const request = ChatCompletionRequest.parse({ model: "claude-sonnet", stream, tools: currentTools, tool_choice: mode === "none" ? "none" : mode === "specific" ? { type: "function", function: { name: "write" } } : "auto", messages });
    if (mode === "cancel") {
      const cancelled = await handleChatCompletion(request, pool, { idempotencyKey: "continuation", signal: AbortSignal.abort() });
      expect(cancelled.status).toBe(499);
      expect(pool.receipts.size).toBe(0);
      expect(wire.texts).toHaveLength(before);
    }
    const response = await handleChatCompletion(request, pool, { idempotencyKey: "continuation" });
    const second = await decode(response, stream);
    if (mode === "model-run") {
      expect(second.message.tool_calls).toHaveLength(1);
      expect(second.message.tool_calls[0].function.name).toBe("bash");
      expect(JSON.parse(second.message.tool_calls[0].function.arguments).command).toBe(`bash '${scriptPath}'`);
    } else {
      expect(second.message.tool_calls ?? []).toHaveLength(0);
      expect(second.message.content).toBe("ordinary response");
    }
    expect(wire.texts.length - before).toBe(1);
    const replay = await handleChatCompletion(request, pool, { idempotencyKey: "continuation" });
    expect(await replay.text()).toBe(second.raw);
    expect(wire.texts.length - before).toBe(1);
    if (["none", "specific", "schema", "removed", "account"].includes(mode)) {
      expect(wire.texts.at(-1)).not.toContain("the intended next call is");
    } else {
      expect(wire.texts.at(-1)).toContain("Only a script write was requested, NOT execution");
    }
    if (mode === "account") expect(wire.sockets.at(-1)!.url).toContain(B);
    else if (!["removed"].includes(mode)) expect(wire.texts.at(-1)).toContain(messages.at(-1).content);
  });
}
for (const code of [
  "~~~~txt\n<document>keep.txt</document>\n~~~~",
  "````markdown\n```js\n<document>keep.txt</document>\n```\n````",
  "`````txt\n<document>keep.txt</document>\n``````",
  "~~~txt\n<document>keep.txt</document>",
  "```txt\n<document>keep.txt</document>",
  "``a ` <document>keep.txt</document>``",
  "`first\n<document>keep.txt</document>`",
  "``unclosed <document>keep.txt</document>",
]) it(`preserves code markup ${JSON.stringify(code)}`, async () => {
  wire.answer = `Prose <File>plain.txt</File>\n\n${code}`;
  const result = await decode(await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", tools, messages: [{ role: "user", content: "describe markup" }] }), new SessionPool(options)), false);
  expect(result.message.content).toBe(`Prose plain.txt\n\n${code}`);
});
it("does not rewrite a specific shell choice into a disallowed write", async () => {
  wire.answer = "```bash\n" + "echo x;".repeat(1500) + "\n```";
  const platform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const result = await decode(await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", tools, tool_choice: { type: "function", function: { name: "bash" } }, messages: [{ role: "user", content: "specific" }] }), new SessionPool(options)), false);
    expect(result.message.tool_calls[0].function.name).toBe("bash");
  } finally { Object.defineProperty(process, "platform", { value: platform }); }
});
