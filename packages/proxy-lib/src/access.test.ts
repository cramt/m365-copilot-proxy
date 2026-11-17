import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAccess, configuredProxyKey, corsHeaders, corsPolicy, type AccessRequest } from "./access.js";

const req = (over: Partial<AccessRequest> = {}): AccessRequest => ({
  method: "POST",
  pathname: "/v1/chat/completions",
  origin: null,
  authorization: null,
  apiKey: null,
  ...over,
});

describe("corsPolicy", () => {
  it("is closed by default", () => {
    expect(corsPolicy(undefined)).toEqual({ kind: "none" });
    expect(corsPolicy(" , ")).toEqual({ kind: "none" });
  });
  it("reads * and lists, ignoring trailing slashes", () => {
    expect(corsPolicy("*")).toEqual({ kind: "any" });
    const p = corsPolicy("http://localhost:3000/, https://app.example");
    expect(p.kind === "list" && [...p.origins]).toEqual(["http://localhost:3000", "https://app.example"]);
  });
});

describe("corsHeaders", () => {
  it("sends none by default or without an Origin", () => {
    expect(corsHeaders(corsPolicy(undefined), "https://evil.example")).toEqual({});
    expect(corsHeaders(corsPolicy("*"), null)).toEqual({});
  });
  it("echoes a listed origin and varies on it", () => {
    const h = corsHeaders(corsPolicy("https://app.example"), "https://app.example");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://app.example");
    expect(h.Vary).toBe("Origin");
    expect(corsHeaders(corsPolicy("https://app.example"), "https://other.example")).toEqual({});
  });
  it("keeps the old wildcard behaviour with *", () => {
    expect(corsHeaders(corsPolicy("*"), "https://x.example")["Access-Control-Allow-Origin"]).toBe("*");
  });
});

describe("checkAccess", () => {
  it("lets CLI clients (no Origin) through with no key configured", () => {
    expect(checkAccess(req(), corsPolicy(undefined), undefined)).toEqual({ kind: "allow" });
  });
  it("refuses a browser Origin by default, including a DNS-rebound localhost one", () => {
    for (const origin of ["https://evil.example", "http://rebind.example:4141"]) {
      const d = checkAccess(req({ origin }), corsPolicy(undefined), undefined);
      expect(d).toMatchObject({ kind: "deny", status: 403 });
    }
  });
  it("allows a listed Origin", () => {
    expect(checkAccess(req({ origin: "https://app.example" }), corsPolicy("https://app.example"), undefined))
      .toEqual({ kind: "allow" });
  });
  it("requires the key when M365_PROXY_KEY is set", () => {
    const p = corsPolicy(undefined);
    expect(checkAccess(req(), p, "s3cret")).toMatchObject({ kind: "deny", status: 401 });
    expect(checkAccess(req({ authorization: "Bearer wrong" }), p, "s3cret")).toMatchObject({ status: 401 });
    expect(checkAccess(req({ authorization: "Bearer s3cret" }), p, "s3cret")).toEqual({ kind: "allow" });
    expect(checkAccess(req({ apiKey: "s3cret" }), p, "s3cret")).toEqual({ kind: "allow" });
  });
  it("leaves /health and preflights open even with a key", () => {
    const p = corsPolicy(undefined);
    expect(checkAccess(req({ method: "GET", pathname: "/health" }), p, "k")).toEqual({ kind: "allow" });
    expect(checkAccess(req({ method: "OPTIONS" }), p, "k")).toEqual({ kind: "allow" });
  });
  it("checks the Origin before the key", () => {
    const d = checkAccess(req({ origin: "https://evil.example", authorization: "Bearer k" }), corsPolicy(undefined), "k");
    expect(d).toMatchObject({ kind: "deny", status: 403 });
  });
});

describe("configuredProxyKey", () => {
  it("prefers M365_PROXY_KEY, else reads M365_PROXY_KEY_FILE", () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-key-"));
    const file = join(dir, "key");
    writeFileSync(file, "from-file\n");
    expect(configuredProxyKey({})).toBeUndefined();
    expect(configuredProxyKey({ M365_PROXY_KEY: "direct", M365_PROXY_KEY_FILE: file })).toBe("direct");
    expect(configuredProxyKey({ M365_PROXY_KEY_FILE: file })).toBe("from-file");
  });
  it("fails closed on a missing or empty key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-key-"));
    const empty = join(dir, "empty");
    writeFileSync(empty, "  \n");
    expect(() => configuredProxyKey({ M365_PROXY_KEY_FILE: join(dir, "nope") })).toThrow();
    expect(() => configuredProxyKey({ M365_PROXY_KEY_FILE: empty })).toThrow(/empty/);
  });
});
