import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const auth = vi.hoisted(() => ({ token: "" }));
vi.mock("./auth.js", () => ({ getTokenForScope: async () => auth.token }));
vi.mock("node:fs", async importOriginal => { const fs = await importOriginal<typeof import("node:fs")>(); return { ...fs, existsSync: (p: string) => { if (p.endsWith("agent-id.json")) throw new Error("Legacy unscoped agent cache must not be consulted"); return fs.existsSync(p); }, writeFileSync: (p: string, ...args: any[]) => { if (p.endsWith("agent-id.json")) throw new Error("Legacy cache must not be written in account scope"); return (fs.writeFileSync as any)(p, ...args); } }; });
import { withAccountContext } from "./account-policy.js";
import { getOrCreateAgent } from "./agent.js";
const tid = "11111111-1111-1111-1111-111111111111", b = "22222222-2222-2222-2222-222222222222";
const jwt = (oid: string) => `e30.${Buffer.from(JSON.stringify({tid, oid})).toString("base64url")}.sig`;
afterEach(() => { vi.unstubAllGlobals(); delete process.env.M365_ACCOUNT_POLICY_PATH; });
it("does not reuse another principal's policy denial or legacy agent cache", async () => {
 process.env.M365_ACCOUNT_POLICY_PATH = join(mkdtempSync(join(tmpdir(), "agent-scope-")), "state.sqlite");
 const calls: string[] = []; let blocked = true;
 vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
   if (url.includes("api.bap.microsoft.com")) return Response.json({ name: "Default-12345678-abcd-4ef0-9876-0123456789ab" });
   if (init.method === "HEAD") return new Response(null);
   calls.push(init.method ?? "GET");
   if (!init.method || init.method === "GET") return Response.json([]);
   if (blocked) return new Response("CopilotExtensibilityNotEnabled", {status:403});
   if (url.includes("/publish?")) return Response.json({TitleId:"title-b"});
   return Response.json({bot:{schemaName:"bot-b"}});
 }));
 auth.token = jwt(tid);
 await withAccountContext({getToken:async()=>auth.token}, async () => expect(await getOrCreateAgent()).toBeNull());
 const denied = calls.length; auth.token = jwt(b); blocked = false;
 await withAccountContext({getToken:async()=>auth.token}, async () => expect(await getOrCreateAgent()).toBe("title-b.bot-b.gpt.default"));
 expect(calls.length).toBeGreaterThan(denied);
 auth.token = jwt(tid);
 await withAccountContext({getToken:async()=>auth.token}, async () => expect(await getOrCreateAgent()).toBeNull());
});
it("refuses a scoped service token from a switched principal before HTTP", async () => {
 process.env.M365_ACCOUNT_POLICY_PATH = join(mkdtempSync(join(tmpdir(), "agent-swap-")), "state.sqlite");
 const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); auth.token = jwt(tid);
 await expect(withAccountContext({ getToken:async()=>jwt(b) }, () => getOrCreateAgent({forceRefresh:true}))).rejects.toMatchObject({ code:"account_changed" });
 expect(fetch).not.toHaveBeenCalled();
});
