import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wire } from "./native-test-transport.js";
import { SessionPool, handleChatCompletion } from "../src/handler.js";
import { ChatCompletionRequest } from "../src/schemas.js";
import { resetPriorityAccessState, resetModelLicenceState } from "@m365-copilot/core";

const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222";
let oid = A, directory: string;
const options = { useAgent: false, getToken: async () => `e30.${Buffer.from(JSON.stringify({ tid: A, oid, aud: "synthetic", iss: "synthetic", exp: 9999999999 })).toString("base64url")}.sig` };
const REASONING = { value: "OutOfCredits", errorCode: "ReasoningTurnExhausted", message: "Reasoning turns used up." };
const NOT_LICENSED = { value: "ForbiddenRequest", errorCode: "PremiumModelUnavailableForLicense", message: "denied" };
const CLAUDE_DENIED = { value: "ForbiddenRequest", errorCode: "ClaudeUnavailableForLicense", message: "denied" };
const OPUS_DAILY = { value: "OutOfCredits", message: "You've used your available priority access to the Opus model for today. You can choose another available model or wait until tomorrow to use the Opus model again." };

beforeEach(() => {
  oid = A; directory = mkdtempSync(join(tmpdir(), "refusal-native-"));
  process.env.M365_ACCOUNT_POLICY_PATH = join(directory, "policy.sqlite");
  process.env.M365_NO_CONFAB_RETRY = "1";
  resetPriorityAccessState(); resetModelLicenceState();
  wire.sockets = []; wire.texts = []; wire.hold = false; wire.replies = []; wire.onChat = undefined; wire.result = undefined; wire.answer = "visible answer";
});
afterEach(() => { for (const socket of wire.sockets) socket.close(); rmSync(directory, { recursive: true, force: true }); delete process.env.M365_ACCOUNT_POLICY_PATH; delete process.env.M365_NO_CONFAB_RETRY; });

async function ask(model: string, stream: boolean, pool = new SessionPool(options)) {
  const response = await handleChatCompletion(ChatCompletionRequest.parse({ model, stream, messages: [{ role: "user", content: `hi ${model} ${Math.random()}` }] }), pool);
  const raw = await response.text();
  let body: any = null, retryAfter: number | null = null;
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    // A refusal that arrives after the stream opened is an SSE error frame.
    const frame = raw.split("\n").filter(l => l.startsWith("data: {")).map(l => JSON.parse(l.slice(6))).find(f => f.error);
    body = frame?.error ?? null; retryAfter = body?.retry_after ?? null;
  } else if (response.status !== 200) {
    body = JSON.parse(raw).error; retryAfter = Number(response.headers.get("retry-after"));
  }
  return { response, body, retryAfter, served: body === null };
}
// A stream may refuse before it opens (a remembered wall: real 429) or inside it (an error frame).
const expectRefusedWith = (r: Awaited<ReturnType<typeof ask>>, status: number) => {
  expect(r.served).toBe(false);
  if (r.response.status !== 200) expect(r.response.status).toBe(status);
};

for (const stream of [false, true]) {
  it(`reasoning cap: own code, wording, Quick tones first, refused model excluded, stream=${stream}`, async () => {
    wire.result = REASONING;
    const r = await ask("gpt-5.5-think-deeper", stream);
    expectRefusedWith(r, 429);
    expect(r.body.code).toBe("reasoning_turns_exhausted");
    expect(r.body.message).toContain("reasoning (Think deeper) turns are used up for today");
    expect(r.body.message).not.toMatch(/priority access/i);
    expect(r.body.suggested_models).toEqual(["gpt-5.5", "gpt-5.6"]);
    expect(r.body.message).not.toContain("claude");
    expect(r.retryAfter).toBeGreaterThan(0);
    expect(r.retryAfter).toBeLessThanOrEqual(86400);
    expect(r.body.retryable).toBe(false);
    expect(r.body.message).toMatch(/resets \d{4}-\d{2}-\d{2}T00:00:00\.000Z/);
  });
  it(`reasoning cap walls the sibling reasoning model without contacting M365, Quick still serves, stream=${stream}`, async () => {
    wire.result = REASONING;
    await ask("gpt-5.5-think-deeper", stream);
    const turns = wire.texts.length;
    const sibling = await ask("gpt-5.6-think-deeper", stream);
    expectRefusedWith(sibling, 429);
    expect(sibling.body.code).toBe("reasoning_turns_exhausted");
    expect(sibling.body.suggested_models).toEqual(["gpt-5.5", "gpt-5.6"]);
    expect(wire.texts).toHaveLength(turns);
    wire.result = undefined;
    const quick = await ask("gpt-5.5", stream);
    expect(quick.served).toBe(true);
    expect(wire.texts.length).toBe(turns + 1);
  });
  it(`suggestions drop models refused as not licensed, per account, stream=${stream}`, async () => {
    wire.result = NOT_LICENSED;
    expectRefusedWith(await ask("gpt-5.5", stream), 403);
    wire.result = REASONING;
    expect((await ask("gpt-5.5-think-deeper", stream)).body.suggested_models).toEqual(["gpt-5.6"]);
    oid = B; resetPriorityAccessState();
    expect((await ask("gpt-5.5-think-deeper", stream)).body.suggested_models).toEqual(["gpt-5.5", "gpt-5.6"]);
  });
  it(`nothing left to suggest: wait only, stream=${stream}`, async () => {
    wire.result = NOT_LICENSED;
    await ask("gpt-5.5", stream); await ask("gpt-5.6", stream);
    wire.result = REASONING;
    const r = await ask("gpt-5.5-think-deeper", stream);
    expect(r.body.suggested_models).toEqual([]);
    expect(r.body.message).not.toMatch(/switch/i);
    expect(r.body.message).toMatch(/wait/i);
  });
  it(`priority-access refusal keeps its code and wording but never suggests the refused, walled or unlicensed models, stream=${stream}`, async () => {
    wire.result = CLAUDE_DENIED;
    await ask("claude-sonnet", stream);
    wire.result = REASONING;
    await ask("gpt-5.5-think-deeper", stream);
    wire.result = OPUS_DAILY;
    const r = await ask("claude-opus", stream);
    expectRefusedWith(r, 429);
    expect(r.body.code).toBe("priority_access_exhausted");
    expect(r.body.message).toContain("priority access to Opus");
    expect(r.body.suggested_models).toEqual(["gpt-5.5", "gpt-5.6"]);
    expect(r.body.suggested_models).not.toContain("claude-opus");
    expect(r.body.message).not.toContain("gpt-5.5-think-deeper");
  });
  it(`an OutOfCredits with another code is not called a reasoning cap, stream=${stream}`, async () => {
    wire.result = { value: "OutOfCredits", errorCode: "SomethingElse", message: "No credits." };
    const r = await ask("gpt-5.5", stream);
    expect(r.body.code).toBe("priority_access_exhausted");
    expect(r.body.suggested_models).toEqual(["claude-sonnet", "gpt-5.5-think-deeper", "gpt-5.6"]);
    expect(r.body.message).toContain("Switch to claude-sonnet or gpt-5.5-think-deeper or gpt-5.6, or wait.");
  });
}

for (const stream of [false, true]) {
  it(`a plain OutOfCredits on a Think deeper model walls only that model, and is never suggested after, stream=${stream}`, async () => {
    wire.result = { value: "OutOfCredits", message: "No credits." };
    expectRefusedWith(await ask("gpt-5.5-think-deeper", stream), 429);
    const turns = wire.texts.length;
    expectRefusedWith(await ask("gpt-5.5-think-deeper", stream), 429);
    expect(wire.texts).toHaveLength(turns); // remembered: no second upstream turn
    wire.result = OPUS_DAILY;
    const opus = await ask("claude-opus", stream);
    expect(opus.body.suggested_models).not.toContain("gpt-5.5-think-deeper");
    wire.result = undefined;
    expect((await ask("gpt-5.6-think-deeper", stream)).served).toBe(true); // not the shared cap
  });
  it(`the reasoning code on a Quick tone is the same ordinary refusal the first time and on re-read, stream=${stream}`, async () => {
    wire.result = REASONING;
    const first = await ask("gpt-5.5", stream);
    const turns = wire.texts.length;
    const again = await ask("gpt-5.5", stream);
    expect(wire.texts).toHaveLength(turns);
    expect(first.body.code).toBe("priority_access_exhausted");
    expect(again.body.code).toBe(first.body.code);
  });
  it(`the reasoning code on a metered model walls its budget, so the next request makes no upstream turn, stream=${stream}`, async () => {
    wire.result = REASONING;
    const first = await ask("claude-opus", stream);
    expect(first.body.code).toBe("priority_access_exhausted");
    const turns = wire.texts.length;
    expectRefusedWith(await ask("claude-opus", stream), 429);
    expect(wire.texts).toHaveLength(turns);
  });
  it(`a licence refusal on an alias excludes every alias of the route, stream=${stream}`, async () => {
    wire.result = NOT_LICENSED;
    expectRefusedWith(await ask("gpt-5.5-quick", stream), 403);
    wire.result = REASONING;
    expect((await ask("gpt-5.5-think-deeper", stream)).body.suggested_models).toEqual(["gpt-5.6"]);
  });
}
