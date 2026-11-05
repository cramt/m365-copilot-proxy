import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { fetchImageBytes } from "./image.js";

const trusted = "https://designerapp.officeapps.live.com/designerapp/document.ashx?sig=synthetic%2Bopaque";
const nativeFetch = globalThis.fetch;
afterEach(() => vi.unstubAllGlobals());

// Only transport is remapped: production still validates the trusted signed URL,
// constructs the bearer, disables redirects and reads native streamed bodies.
// Runs behind the mandatory OS network namespace, never against real M365.
async function peer(handler: (response: ServerResponse, path: string) => void) {
  const requests: Array<{ path: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url!, authorization: request.headers.authorization });
    handler(response, request.url!);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  const origin = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal("fetch", (input: string, init: RequestInit) => {
    expect(input).toMatch(/^https:\/\/designerapp\.officeapps\.live\.com(?::443)?\//i);
    return nativeFetch(input.replace(/^https:\/\/[^/]+/i, origin), init);
  });
  return { requests, origin, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

it.each([
  "/a%2Fb%25+c//signed?sig=%2B+x%252F&k=1&k=2",
  "/a/.../x%2ey/%252e%252e/signed?path=/a/../%2E%2e&sig=+%25%2F",
  "/a/%2f/%2F?sig=%2e%2E&k=2&k=1",
  "/signed?", "/signed?sig=x??/../signed",
])("native peer receives the exact signed request target: %s", async (target) => {
  const p = await peer((response) => response.end(Buffer.from([1, 2, 3])));
  try {
    const result = await fetchImageBytes(`https://designerapp.officeapps.live.com${target}`, "synthetic-bearer");
    expect(result.data).toEqual(Buffer.from([1, 2, 3]));
    expect(p.requests).toEqual([{ path: target, authorization: "Bearer synthetic-bearer" }]);
  } finally { await p.close(); }
});

it("native fetch rejects a redirect without sending bearer to its target", async () => {
  const p = await peer((response, path) => {
    if (path.startsWith("/designerapp/document.ashx")) response.writeHead(302, { location: `${p.origin}/untrusted` }).end();
    else response.end("credential leak");
  });
  try {
    await expect(fetchImageBytes(trusted, "synthetic-bearer")).rejects.toThrow(/^Image artifact fetch failed$/);
    expect(p.requests).toEqual([{ path: "/designerapp/document.ashx?sig=synthetic%2Bopaque", authorization: "Bearer synthetic-bearer" }]);
  } finally { await p.close(); }
});

it.each(["caller", "deadline"])("native slow-drip %s cancellation closes the peer before EOF", async (mode) => {
  let received!: () => void;
  let closed!: () => void;
  const receiving = new Promise<void>((resolve) => { received = resolve; });
  const peerClosed = new Promise<void>((resolve) => { closed = resolve; });
  const p = await peer((response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.write(Buffer.from([1]));
    received();
    const interval = setInterval(() => response.write(Buffer.from([2])), 25);
    response.on("close", () => { clearInterval(interval); closed(); });
  });
  try {
    const controller = new AbortController();
    const outcome = expect(fetchImageBytes(trusted, "synthetic-bearer", controller.signal)).rejects.toThrow(mode === "caller" ? "aborted" : "timed out");
    await receiving;
    if (mode === "caller") controller.abort(new Error("synthetic-private-reason"));
    await outcome;
    await Promise.race([peerClosed, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("peer remained open")), 2000);
      peerClosed.finally(() => clearTimeout(timer));
    })]);
    expect(p.requests).toHaveLength(1);
  } finally { await p.close(); }
}, 70_000);
