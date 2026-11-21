import { afterEach, describe, expect, it, vi } from "vitest";

// Only the transport is synthetic: real handler -> ModelSession -> CopilotSession
// sends a SignalR handshake and chat_request, and consumes request_end.
const peer = vi.hoisted(() => {
  const state = { sockets: [] as any[], code: "", transport: "streamhub" };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent: any[] = [];
    handlers: Record<string, ((...args: any[]) => void)[]> = {};
    constructor() { state.sockets.push(this); setTimeout(() => this.emit("open"), 0); }
    on(name: string, fn: (...args: any[]) => void) { (this.handlers[name] ??= []).push(fn); return this; }
    emit(name: string, ...args: any[]) { for (const fn of this.handlers[name] ?? []) fn(...args); }
    send(data: string) {
      for (const raw of data.split("\x1e").filter(Boolean)) {
        const frame = JSON.parse(raw); this.sent.push(frame);
        if (frame.protocol === "json") setTimeout(() => this.emit("message", Buffer.from("{}\x1e")), 0);
        if (frame.item?.type === "chat_request" || frame.target === "chat") {
          const item = state.transport === "streamhub"
            ? { type: "request_end", requestId: frame.item.chatStreamRequest.requestId, outcome: { category: "ForbiddenRequest", code: state.code, message: "synthetic private refusal detail" } }
            : { result: { value: "ForbiddenRequest", errorCode: state.code, message: "synthetic private refusal detail" } };
          setTimeout(() => { this.emit("message", Buffer.from(JSON.stringify({ type: 2, invocationId: "1", item }) + "\x1e")); if (state.transport === "chathub") this.close(); }, 0);
        }
      }
    }
    close() { if (this.readyState !== 3) { this.readyState = 3; this.emit("close"); } }
  }
  return { state, Socket };
});
vi.mock("ws", () => ({ default: peer.Socket }));
vi.mock("@m365-copilot/core", async (importActual) => {
  const core = await importActual<typeof import("@m365-copilot/core")>();
  const source = "./model.ts";
  const { ModelSession } = await import(source);
  return { ...core, ModelSession };
});

const proxySource = "../../proxy-lib/src/index.ts";
const { ChatCompletionRequest, handleChatCompletion, SessionPool } = await import(proxySource);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = `${b64({ alg: "none" })}.${b64({ aud: "https://substrate.office.com/sydney", iss: "test", oid: "oid-1", tid: "tid-1", exp: 9999999999 })}.sig`;

describe("native transport ForbiddenRequest", () => {
  afterEach(() => { delete process.env.M365_TRANSPORT; peer.state.sockets.length = 0; });
  it.each([["streamhub", false], ["streamhub", true], ["chathub", false], ["chathub", true]] as const)("drives %s frames through the real protocol and handler (stream=%s)", async (transport, stream) => {
    process.env.M365_TRANSPORT = transport;
    peer.state.transport = transport;
    peer.state.code = "ClaudeUnavailableForLicense";
    const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream, messages: [{ role: "user", content: "native refusal" }] });
    const response: Response = await handleChatCompletion(body, new SessionPool({ getToken: async () => token, useAgent: false }));
    const text = await response.text();
    expect(peer.state.sockets, text).toHaveLength(1);
    const frames = peer.state.sockets[0].sent;
    expect(frames.some((f: any) => f.protocol === "json")).toBe(true);
    expect(frames.filter((f: any) => transport === "streamhub" ? f.item?.type === "chat_request" : f.target === "chat")).toHaveLength(1);
    expect(text).not.toContain("synthetic private refusal detail");
    if (!stream) {
      expect(response.status).toBe(403);
      expect(JSON.parse(text).error).toMatchObject({ code: "m365_model_not_licensed", m365_error_code: peer.state.code, retryable: false });
    } else {
      expect(response.status).toBe(200);
      const chunks = text.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]").map(l => JSON.parse(l.slice(6)));
      expect(chunks.find(c => c.error)?.error).toMatchObject({ code: "m365_model_not_licensed", m365_error_code: peer.state.code, retryable: false });
      expect(chunks.some(c => c.choices?.[0]?.finish_reason === "stop")).toBe(false);
    }
  });
});
