import { describe, it, expect, vi } from "vitest";
vi.mock("../packages/core/dist/index.mjs", async (original) => ({
  ...await original<object>(), getToken: async () => "synthetic", decodeJwt: () => ({}),
  getTokenForScope: async () => "synthetic", getEnvironmentUrl: async () => "https://example.invalid",
}));
vi.mock("node:fs", async (original) => ({ ...await original<object>(), readFileSync: () => "s3cr3t-value-9182" }));
vi.mock("./_probe-chat.mjs", () => ({ oneTurn: () => { throw new Error("unexpected"); } }));
// @ts-expect-error JavaScript probe
const { main: actualMain } = await import("./mcp-agent-probe.mjs");
const main = ({ fetcher, ...options }: any) => {
  let owner = "";
  let id: unknown;
  const wrapped = async (url: string, opts: any) => {
    if (opts.method === "GET") return Response.json([{ botId: id, shortBotName: owner }]);
    if (opts.method === "POST" && !owner) owner = JSON.parse(opts.body).bot.displayName;
    const result = await fetcher(url, opts);
    if (opts.method === "POST" && id === undefined) {
      const body = await result.clone().json();
      id = body.bot?.schemaName ?? body.bot?.cdsBotId;
    }
    return result;
  };
  return actualMain({ ...options, fetcher: wrapped });
};

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
      return { attempted: true, fullText: "s3cr3t-value-9182", transport: "chathub", messageTypes: [], elapsedMs: 1, disengaged: false };
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
    expect(log.mock.calls.flat().join(" ")).toMatch(/cleanup failed/i);
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


describe("MCP create identity path admission", () => {
  it.each(["../other-bot", "%2e%2e", "a%2fb", "a/b", "a\\b", "a\nb", {}, "", ".", "..", null])( "refuses untrusted id %j without publication or delete", async (id) => {
    const requests: string[] = [];
    const fetcher = async (url: string) => { requests.push(url); return Response.json({ bot: { schemaName: id } }); };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try { await expect(main({ fetcher })).rejects.toThrow(/bot ID/i); expect(requests).toHaveLength(1); } finally { log.mockRestore(); }
  });
  it.each([["schemaName", "synthetic-bot"], ["cdsBotId", "e6e00a20-6c85-4c50-b8f1-e13e9a000002"]])( "binds %s to exact same origin and path for publish and delete", async (key, id) => {
    const urls: string[] = [];
    const fetcher = async (url: string, opts: { method: string }) => {
      urls.push(url);
      if (opts.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(urls.length === 1 ? { bot: { [key]: id } } : { TitleId: "title" });
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main({ fetcher, oneTurn: () => ({ attempted: true, fullText: "s3cr3t-value-9182", transport: "chathub", messageTypes: [] }) });
      const base = "https://example.invalid/copilotstudio/minimalBots/api/" + encodeURIComponent(id);
      expect(urls).toEqual(["https://example.invalid/copilotstudio/minimalBots/api?api-version=2022-03-01-preview", base + "/publish?api-version=2022-03-01-preview", base + "?api-version=2022-03-01-preview"]);
      expect(log.mock.calls.flat().join(" ")).not.toContain("s3cr3t-value-9182");
    } finally { log.mockRestore(); }
  });
  it.each(["http", "throw"])("cleanup %s is a failure without exposing upstream text", async (mode) => {
    let n = 0; const logs: string[] = [];
    const fetcher = async (_url: string, opts: {method: string}) => {
      if (opts.method === "DELETE") { if (mode === "throw") throw new Error("secret-cleanup-detail"); return new Response("secret-cleanup-detail", { status: 500 }); }
      return Response.json(++n === 1 ? { bot: { schemaName: "synthetic-bot" } } : { TitleId: "title" });
    };
    const log = vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
    try {
      await expect(main({ fetcher, oneTurn: () => ({ attempted: true, fullText: "", transport: "chathub", messageTypes: [] }) })).rejects.toThrow(/cleanup/i);
      expect(logs.join(" ")).not.toContain("secret-cleanup-detail");
    } finally { log.mockRestore(); }
  });
});


it("MCP refuses an id when create response cannot attest the requested owner name", async () => {
  const calls: string[] = [];
  const fetcher = async (url: string, opts: { method: string }) => { calls.push(url); return Response.json(opts.method === "GET" ? [{ botId: "other-bot", shortBotName: "unrelated" }] : { bot: { schemaName: "other-bot" } }); };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try { await expect(actualMain({ fetcher })).rejects.toThrow(/ownership/i); expect(calls).toHaveLength(2); } finally { log.mockRestore(); }
});


it.each(["missing", "duplicate", "unavailable"])("MCP requires a unique matching ownership listing: %s", async (kind) => {
  const calls: string[] = []; let name = "";
  const fetcher = async (_url: string, opts: {method: string; body?: string}) => {
    calls.push(opts.method);
    if (opts.method === "POST") { name = JSON.parse(opts.body!).bot.displayName; return Response.json({ bot: { schemaName: "synthetic-bot" } }); }
    if (kind === "unavailable") return new Response(null, { status: 503 });
    const row = { botId: "synthetic-bot", shortBotName: name };
    return Response.json(kind === "duplicate" ? [row, row] : []);
  };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try { await expect(actualMain({ fetcher, ownershipRetryMs: 1 })).rejects.toThrow(/ownership/i); expect(calls).toEqual(kind === "duplicate" ? ["POST", "GET"] : ["POST", "GET", "GET", "GET"]); } finally { log.mockRestore(); }
});

it("MCP publication HTTP failure keeps exact target and cleanup, without response content", async () => {
  const calls: string[] = []; const secret = "private-publish-error";
  const fetcher = async (url: string, opts: {method: string}) => {
    calls.push(`${opts.method} ${url}`);
    if (opts.method === "DELETE") return new Response(null, { status: 204 });
    if (calls.length === 1) return Response.json({ bot: { schemaName: "synthetic-bot" } });
    return new Response(secret, { status: 403 });
  };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(main({ fetcher })).rejects.toThrow(/publish failed.*403/i);
    expect(calls).toEqual(["POST https://example.invalid/copilotstudio/minimalBots/api?api-version=2022-03-01-preview", "POST https://example.invalid/copilotstudio/minimalBots/api/synthetic-bot/publish?api-version=2022-03-01-preview", "DELETE https://example.invalid/copilotstudio/minimalBots/api/synthetic-bot?api-version=2022-03-01-preview"]);
    expect(log.mock.calls.flat().join(" ")).not.toContain(secret);
  } finally { log.mockRestore(); }
});


describe("bounded ownership verification", () => {
  it.each(["503", "missing"])("retries %s then verifies and cleans the exact agent", async (kind) => {
    let owner = "", gets = 0; const calls: string[] = [];
    const fetcher = async (url: string, opts: {method: string; body?: string}) => {
      calls.push(`${opts.method} ${url}`);
      if (opts.method === "GET") {
        gets++; if (gets === 1) return kind === "503" ? new Response(null, { status: 503 }) : Response.json([]);
        return Response.json([{ botId: "synthetic-bot", shortBotName: owner }]);
      }
      if (opts.method === "DELETE") return new Response(null, { status: 204 });
      if (!owner) { owner = JSON.parse(opts.body!).bot.displayName; return Response.json({ bot: { schemaName: "synthetic-bot" } }); }
      return Response.json({ TitleId: "title" });
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await actualMain({ fetcher, ownershipTimeoutMs: 100, ownershipRetryMs: 1, oneTurn: () => ({ attempted: true, fullText: "", transport: "chathub", messageTypes: [] }) });
      expect(gets).toBe(2);
      expect(calls.filter(x => x.startsWith("DELETE "))).toEqual(["DELETE https://example.invalid/copilotstudio/minimalBots/api/synthetic-bot?api-version=2022-03-01-preview"]);
      expect(log.mock.calls.flat().join(" ")).not.toMatch(/may remain/i);
    } finally { log.mockRestore(); }
  });
  it.each(["missing", "duplicate", "malformed", "throw", "hang", "body-hang"])("fails bounded and warns without DELETE for %s listing", async (kind) => {
    let owner = "", gets = 0; const methods: string[] = []; let signal: AbortSignal | undefined;
    const fetcher = async (_url: string, opts: {method: string; body?: string; signal?: AbortSignal}) => {
      methods.push(opts.method);
      if (opts.method === "POST") { owner = JSON.parse(opts.body!).bot.displayName; return Response.json({ bot: { schemaName: "synthetic-bot" } }); }
      gets++; signal = opts.signal;
      if (kind === "hang") return new Promise(() => {});
      if (kind === "body-hang") return { ok: true, json: () => new Promise(() => {}) };
      if (kind === "throw") throw new Error("credential-secret-9384");
      if (kind === "malformed") return Response.json({ bad: true });
      const row = { botId: "synthetic-bot", shortBotName: owner };
      return Response.json(kind === "duplicate" ? [row, row] : []);
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const started = Date.now();
      const err = await actualMain({ fetcher, ownershipTimeoutMs: 40, ownershipRetryMs: 2 }).then(() => null, (e: Error) => e);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(err?.message).toMatch(/ownership/i);
      expect(gets).toBeGreaterThan(0); expect(gets).toBeLessThanOrEqual(3);
      expect(methods).not.toContain("DELETE");
      const text = log.mock.calls.flat().join(" ") + err?.message;
      expect(text).toMatch(/temporary agent may remain/i);
      expect(text).not.toMatch(/credential-secret-9384|synthetic-bot/);
      if (kind === "hang" || kind === "body-hang") expect(signal?.aborted).toBe(true);
    } finally { log.mockRestore(); }
  });
  it("rejects conflicting create IDs with orphan warning and no listing or DELETE", async () => {
    const calls: string[] = [];
    const fetcher = async (_url: string, opts: {method: string}) => { calls.push(opts.method); return Response.json({ bot: { schemaName: "one", cdsBotId: "two" } }); };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const err = await actualMain({ fetcher, ownershipTimeoutMs: 40 }).then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/bot ID/i);
      expect(log.mock.calls.flat().join(" ") + err?.message).toMatch(/temporary agent may remain/i);
      expect(calls).toEqual(["POST"]);
    } finally { log.mockRestore(); }
  });
});


it("late successful listing after deadline cannot authorize publication or deletion", async () => {
  let owner = ""; let release!: (value: Response) => void; const methods: string[] = [];
  const fetcher = async (_url: string, opts: {method: string; body?: string}) => {
    methods.push(opts.method);
    if (opts.method === "POST") { owner = JSON.parse(opts.body!).bot.displayName; return Response.json({ bot: { schemaName: "synthetic-bot" } }); }
    return new Promise<Response>((resolve) => { release = resolve; });
  };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(actualMain({ fetcher, ownershipTimeoutMs: 20 })).rejects.toThrow(/temporary agent may remain/i);
    release(Response.json([{ botId: "synthetic-bot", shortBotName: owner }]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(methods).toEqual(["POST", "GET"]);
  } finally { log.mockRestore(); }
});

it("unknown create transport failure warns without echoing transport details", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const e = await actualMain({ fetcher: () => { throw new Error("credential-secret-9384"); } }).then(() => null, (err: Error) => err);
    expect(e?.message).toMatch(/temporary agent may remain/i);
    expect(e?.message).not.toContain("credential-secret-9384");
  } finally { log.mockRestore(); }
});


describe("indeterminate create responses", () => {
  it.each([null, [], "abc", 0, true, {}, {bot:null}, {bot:[]}, {bot:"text"}])("sanitizes JSON shape %j and never deletes", async (body) => {
    const calls: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const err = await actualMain({ fetcher: async (_: string, opts: {method: string}) => { calls.push(opts.method); return Response.json(body); }, createTimeoutMs: 40 }).then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/temporary agent may remain.*inspect/i);
      expect(err?.message).not.toMatch(/TypeError|Cannot read|credential-secret/);
      expect(calls).toEqual(["POST"]);
    } finally { log.mockRestore(); }
  });
  it.each(["invalid-json", "body-throws", "body-hangs", "transport-hangs", "transport-throws", "non-2xx"])("sanitizes %s and completes bounded without DELETE", async (kind) => {
    const calls: string[] = []; let signal: AbortSignal | undefined;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const start = Date.now();
      const fetcher = async (_: string, opts: {method: string; signal?: AbortSignal}) => {
        calls.push(opts.method); signal = opts.signal;
        if (kind === "transport-hangs") return new Promise(() => {});
        if (kind === "transport-throws") throw new Error("credential-secret");
        if (kind === "body-hangs") return { ok: true, status: 200, text: () => new Promise(() => {}) };
        if (kind === "body-throws") return { ok: true, status: 200, text: () => { throw new Error("credential-secret"); } };
        return new Response(kind === "invalid-json" ? "{credential-secret" : "credential-secret", { status: kind === "non-2xx" ? 503 : 200 });
      };
      const err = await actualMain({ fetcher, createTimeoutMs: 40 }).then(() => null, (e: Error) => e);
      expect(Date.now() - start).toBeLessThan(1000);
      expect(err?.message).toMatch(/temporary agent may remain.*inspect/i);
      expect(err?.message).not.toContain("credential-secret");
      expect(log.mock.calls.flat().join(" ")).not.toContain("credential-secret");
      expect(calls).toEqual(["POST"]);
      if (kind.endsWith("hangs")) expect(signal?.aborted).toBe(true);
    } finally { log.mockRestore(); }
  });
});


it("late successful create response after timeout cannot trigger verification or delete", async () => {
  const calls: string[] = []; let release!: (response: Response) => void;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const fetcher = async (_: string, opts: {method: string}) => { calls.push(opts.method); return new Promise<Response>((resolve) => { release = resolve; }); };
    await expect(actualMain({ fetcher, createTimeoutMs: 20 })).rejects.toThrow(/temporary agent may remain/i);
    release(Response.json({ bot: { schemaName: "synthetic-bot" } }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["POST"]);
  } finally { log.mockRestore(); }
});
