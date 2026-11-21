import { describe, it, expect, vi } from "vitest";

vi.mock("../packages/core/dist/index.mjs", async (importOriginal) => ({
  ...await importOriginal<object>(),
  getToken: async () => "synthetic",
  decodeJwt: () => ({}),
  getOrCreateAgent: async () => "synthetic-agent",
  formatMessages: () => "synthetic prompt",
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<object>(), mkdirSync: () => {}, writeFileSync: () => {}, readFileSync: (p: unknown) => String(p).includes("tunnel_url") ? "https://example.invalid" : "sentinel",
}));

vi.mock("./_probe-chat.mjs", () => ({ oneTurn: async () => { throw new Error("unexpected top-level dispatch"); } }));

const modules = [
  // @ts-expect-error JavaScript probe entrypoint.
  ["claude-tools-probe", () => import("./claude-tools-probe.mjs")],
  // @ts-expect-error JavaScript probe entrypoint.
  ["disengage-config-probe", () => import("./disengage-config-probe.mjs")],
  // @ts-expect-error JavaScript probe entrypoint.
  ["disengage-agentless-probe", () => import("./disengage-agentless-probe.mjs")],
  // @ts-expect-error JavaScript probe entrypoint.
  ["output-ceiling-probe", () => import("./output-ceiling-probe.mjs")],
  // @ts-expect-error JavaScript probe entrypoint.
  ["input-size-bisect", () => import("./input-size-bisect.mjs")],
  // @ts-expect-error JavaScript probe entrypoint.
  ["sonnet5-native-tools-probe", () => import("./sonnet5-native-tools-probe.mjs")],
  // @ts-expect-error JavaScript probe entrypoint.
  ["da-app/tone-selfid", () => import("./da-app/tone-selfid.mjs")],
  // @ts-expect-error JavaScript probe entrypoint.
  ["code-interpreter-probe", () => import("./code-interpreter-probe.mjs")],
  // @ts-expect-error JavaScript probe entrypoint.
  ["code-interp-egress", () => import("./code-interp-egress.mjs")],
  // @ts-expect-error JavaScript probe entrypoint.
  ["code-interp-egress-diag", () => import("./code-interp-egress-diag.mjs")],
  // @ts-expect-error JavaScript probe entrypoint.
  ["code-interp-rawip-probe", () => import("./code-interp-rawip-probe.mjs")],
  // @ts-expect-error JavaScript probe entrypoint.
  ["code-interp-rawip2", () => import("./code-interp-rawip2.mjs")],
  // @ts-expect-error JavaScript probe entrypoint.
  ["code-interp-proxy-probe", () => import("./code-interp-proxy-probe.mjs")],
] as const;

describe("actual probe callers stop at local admission refusal", () => {
  it.each(modules)("%s stops instead of treating refusal as an observation", async (_name, load) => {
    const mod = await load();
    let calls = 0;
    const oneTurn = async () => { calls++; return { attempted: false, error: "probe turn budget hold", fullText: "", messageTypes: [], scores: {}, transport: "chathub" }; };
    await expect(mod.main({ oneTurn })).rejects.toThrow(/not attempted.*probe turn budget hold/i);
    expect(calls).toBe(1);
  });
});
