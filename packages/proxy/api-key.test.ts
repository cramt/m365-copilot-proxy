import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface MiddlewareEvent {
  method: string;
  path: string;
  headers: Record<string, string>;
  node: { req: { socket: { remoteAddress?: string } } };
}

let middleware: ((event: MiddlewareEvent) => unknown) | undefined;

beforeAll(async () => {
  vi.stubGlobal("defineEventHandler", (handler: (event: MiddlewareEvent) => unknown) => {
    middleware = handler;
    return handler;
  });
  vi.stubGlobal("getRequestURL", (event: MiddlewareEvent) => new URL(event.path, "http://localhost"));
  vi.stubGlobal("getRequestHeader", (event: MiddlewareEvent, name: string) => event.headers[name]);
  await import("./middleware/1.api-key");
});

afterAll(() => vi.unstubAllGlobals());
beforeEach(() => vi.stubEnv("M365_PROXY_API_KEY", "test-key"));
afterEach(() => vi.unstubAllEnvs());

function request(address: string | undefined, path: string, headers: Record<string, string> = {}) {
  if (!middleware) throw new Error("Expected middleware to be registered");
  return middleware({
    method: "POST",
    path,
    headers,
    node: { req: { socket: { remoteAddress: address } } },
  });
}

describe("loopback-only dashboard", () => {
  it.each(["192.168.1.10", "2001:db8::1", undefined, "localhost"])(
    "rejects remote or unverifiable peer %s despite spoofed headers and a valid API key",
    async (address) => {
      for (const path of ["/", "/?refresh=1", "/actions/ping", "/actions/check-models?refresh=1"]) {
        const response = request(address, path, {
          authorization: "Bearer test-key",
          "x-forwarded-for": "127.0.0.1",
          "x-real-ip": "127.0.0.1",
          host: "localhost",
        });
        expect(response).toBeInstanceOf(Response);
        if (!(response instanceof Response)) throw new Error("Expected a forbidden response");
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: "dashboard_local_only" } });
      }
    },
  );

  it.each(["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"])(
    "allows loopback peer %s without requiring an API key",
    (address) => {
      expect(request(address, "/")).toBeUndefined();
      expect(request(address, "/actions/ping")).toBeUndefined();
    },
  );

  it("still blocks remote dashboard access when no API key is configured", () => {
    vi.stubEnv("M365_PROXY_API_KEY", "");
    expect(request("192.168.1.10", "/actions/ping")).toMatchObject({ status: 403 });
  });

  it("preserves API-key protection for remote API clients", () => {
    expect(request("192.168.1.10", "/v1/models")).toMatchObject({ status: 401 });
    expect(request("192.168.1.10", "/v1/models", { authorization: "Bearer wrong" })).toMatchObject({
      status: 401,
    });
    expect(request("192.168.1.10", "/v1/models", { authorization: "Bearer test-key" })).toBeUndefined();
  });

  it("leaves health checks accessible", () => {
    expect(request("192.168.1.10", "/health")).toBeUndefined();
  });
});