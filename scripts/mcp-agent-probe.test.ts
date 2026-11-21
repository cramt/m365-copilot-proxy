import { describe, it, expect, vi } from "vitest";
vi.mock("../packages/core/dist/index.mjs", async (original) => ({
  ...await original<object>(), getToken: async () => "synthetic", decodeJwt: () => ({}),
  getTokenForScope: async () => "synthetic", getEnvironmentUrl: async () => "https://example.invalid",
}));
vi.mock("node:fs", async (original) => ({ ...await original<object>(), readFileSync: () => "sentinel" }));
vi.mock("./_probe-chat.mjs", () => ({ oneTurn: () => { throw new Error("unexpected"); } }));
// @ts-expect-error JavaScript probe
const { main } = await import("./mcp-agent-probe.mjs");

describe("MCP probe owns the agent across the whole post-create lifecycle", () => {
  it.each(["refusal", "sync", "async", "success"]) ("cleans its agent once on %s", async (mode) => {
    const methods: string[] = [];
    const fetcher = async (_url: string, options: {method: string}) => {
      methods.push(options.method);
      if (options.method === "DELETE") return new Response("", { status: 200 });
      if (methods.length === 1) return Response.json({ bot: { schemaName: "owned-bot" } });
      return Response.json({ TitleId: "title" });
    };
    const primary = new Error("dispatch failure");
    const oneTurn = () => {
      if (mode === "sync") throw primary;
      if (mode === "async") return Promise.reject(primary);
      if (mode === "refusal") return { attempted: false, error: "local hold" };
      return { attempted: true, fullText: "sentinel", transport: "chathub", messageTypes: [], elapsedMs: 1, disengaged: false };
    };
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const run = main({ oneTurn, fetcher });
      if (mode === "success") await expect(run).resolves.toBeUndefined();
      else if (mode === "refusal") await expect(run).rejects.toThrow(/not attempted.*local hold/i);
      else await expect(run).rejects.toBe(primary);
      expect(methods).toEqual(["POST", "POST", "DELETE"]);
      if (mode === "success") expect(logs.mock.calls.flat().join(" ")).toMatch(/sentinel value present in reply: true/);
    } finally { logs.mockRestore(); }
  });
});


it("MCP cleanup failure does not mask the original dispatch exception", async () => {
  const methods: string[] = [];
  const primary = new Error("dispatch original");
  const fetcher = async (_: string, opts: { method: string }) => {
    methods.push(opts.method);
    if (opts.method === "DELETE") throw new Error("cleanup failed");
    return Response.json(methods.length === 1 ? { bot: { schemaName: "owned-bot" } } : { TitleId: "title" });
  };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(main({ fetcher, oneTurn: () => { throw primary; } })).rejects.toBe(primary);
    expect(methods).toEqual(["POST", "POST", "DELETE"]);
    expect(log.mock.calls.flat().join(" ")).toMatch(/cleanup err cleanup failed/);
  } finally { log.mockRestore(); }
});

it("MCP does not delete an agent when creation did not return an owned id", async () => {
  const methods: string[] = [];
  const fetcher = async (_: string, opts: { method: string }) => { methods.push(opts.method); return Response.json({ bot: {} }); };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(main({ fetcher })).rejects.toThrow(/no bot ID/);
    expect(methods).toEqual(["POST"]);
  } finally { log.mockRestore(); }
});

it("MCP publish failure after creation still deletes the owned agent", async () => {
  const methods: string[] = [];
  const primary = new Error("publish failed");
  const fetcher = async (_: string, opts: { method: string }) => {
    methods.push(opts.method);
    if (methods.length === 2) throw primary;
    return Response.json(methods.length === 1 ? { bot: { schemaName: "owned-bot" } } : {});
  };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(main({ fetcher })).rejects.toBe(primary);
    expect(methods).toEqual(["POST", "POST", "DELETE"]);
  } finally { log.mockRestore(); }
});
