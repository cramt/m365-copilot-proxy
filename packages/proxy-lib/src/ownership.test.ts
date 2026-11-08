import { describe, it, expect, vi } from "vitest";
vi.mock("@m365-copilot/core", async (load) => {
  const actual = await load<typeof import("@m365-copilot/core")>();
  return { ...actual, withAccountContext: async (_: unknown, callback: (key: string) => unknown) => callback("synthetic-account") };
});
import { SessionPool } from "./handler.js";
import { ChatCompletionRequest } from "./schemas.js";
import { requestContext } from "./request-context.js";
const body = (messages: unknown[]) => ChatCompletionRequest.parse({ messages });
const user = (content: string) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });
describe("immutable conversation lineage", () => {
  it("does not reset A when shorter B has the same opener", () => {
    const pool = new SessionPool();
    const a = pool.resolve([user("same"), assistant("A"), user("A2")] as any);
    a.sentMessageCount = 3;
    pool.commit(a, body([user("same"), assistant("A"), user("A2")]), assistant("A3") as any);
    const b = pool.resolve([user("same")] as any);
    expect(b).not.toBe(a);
    expect(a.sentMessageCount).toBe(3);
    expect(pool.resolve([user("same"), assistant("A"), user("A2"), assistant("A3"), user("A4")] as any)).toBe(a);
  });
  it("requires the client-visible assistant, not merely longer history", () => {
    const pool = new SessionPool();
    const a = pool.resolve([user("same")] as any);
    pool.commit(a, body([user("same")]), assistant("visible") as any);
    expect(pool.resolve([user("same"), assistant("invented"), user("next")] as any)).not.toBe(a);
    expect(pool.resolve([user("same"), assistant("visible"), user("next")] as any)).toBe(a);
  });
  it("does not alias an uncommitted request", () => {
    const pool = new SessionPool();
    expect(pool.resolve([user("Aa")] as any)).not.toBe(pool.resolve([user("BB")] as any));
    expect(pool.resolve([user("same")] as any)).not.toBe(pool.resolve([user("same")] as any));
  });
  it("hashes images, tool call IDs and results in the lineage", () => {
    const pool = new SessionPool();
    const messages = [user("same"), { role: "assistant", content: null, tool_calls: [{ id: "one", type: "function", function: { name: "bash", arguments: "{}" } }] }, { role: "tool", tool_call_id: "one", content: "result" }];
    const a = pool.resolve(messages as any);
    pool.commit(a, body(messages), assistant("visible") as any);
    const changed = structuredClone(messages); changed[2] = { role: "tool", tool_call_id: "two", content: "result" };
    expect(pool.resolve([...changed, assistant("visible"), user("next")] as any)).not.toBe(a);
  });
});
describe("bounded lineage edge cases", () => {
  it("refuses ambiguous anonymous prefixes and preserves image identity", () => {
    const pool = new SessionPool();
    const input = body([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,A" } }] }]);
    const a = pool.resolve(input.messages); const b = pool.resolve(input.messages);
    pool.commit(a, input, assistant("visible") as any); pool.commit(b, input, assistant("visible") as any);
    expect(pool.resolve([...input.messages, assistant("visible"), user("next")] as any)).not.toBe(a);
    const changed = structuredClone(input.messages); (changed[0].content as any)[0].image_url.url = "data:image/png;base64,B";
    expect(pool.resolve([...changed, assistant("visible"), user("next")] as any)).not.toBe(a);
  });
  it("keeps logical lineage on account switch but rotates physical placement", () => {
    const pool = new SessionPool(); const input = body([user("same")]);
    const context = { trustedPrincipal: "owner", sessionHint: "session" };
    const a = pool.resolve(input.messages, undefined, context, "account-A");
    pool.commit(a, input, assistant("visible") as any); a.sentMessageCount = 1;
    const oldId = a.session.conversationId;
    const next = pool.resolve([user("same"), assistant("visible"), user("next")] as any, undefined, context, "account-B");
    expect(next).toBe(a); expect(next.session.conversationId).not.toBe(oldId); expect(next.sentMessageCount).toBe(0);
  });
});
describe("validated affinity, never authentication", () => {
  it("preserves body hints and rejects conflicting hints", () => {
    const parsed = ChatCompletionRequest.parse({ messages: [user("x")], session_id: "session-A" });
    expect(parsed.session_id).toBe("session-A");
    expect(() => requestContext(parsed, new Headers({ "x-opencode-session": "session-B" }))).toThrow(/conflict/i);
  });
  it("ignores arbitrary metadata user IDs and accepts Claude session suffixes", () => {
    expect(requestContext(ChatCompletionRequest.parse({ messages: [user("x")], metadata: { user_id: "customer" } })).sessionHint).toBeUndefined();
    expect(requestContext(ChatCompletionRequest.parse({ messages: [user("x")], metadata: { user_id: "user_hash_account__session_123e4567-e89b-12d3-a456-426614174000" } })).sessionHint).toBe("123e4567-e89b-12d3-a456-426614174000");
  });
});
