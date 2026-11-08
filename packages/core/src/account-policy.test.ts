import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import * as policy from "./account-policy.js";
import { notePriorityAccessExhausted, activePriorityAccessExhaustion } from "./priority-access.js";
import { requestUsesAgent, noteAgentRouteAlive, noteAgentRouteDead, isAgentRouteAlive, toneUsesToolAgent } from "./copilot.js";
const a = "11111111-1111-1111-1111-111111111111", b = "22222222-2222-2222-2222-222222222222";
const token = (oid = a) => `e30.${Buffer.from(JSON.stringify({ tid: a, oid })).toString("base64url")}.sig`;
const opts = (oid = a) => ({ getToken: async () => token(oid), useAgent: false });
function setup() { process.env.M365_ACCOUNT_POLICY_PATH = join(mkdtempSync(join(tmpdir(), "policy-")), "private", "state.sqlite"); return process.env.M365_ACCOUNT_POLICY_PATH; }
afterEach(() => { vi.restoreAllMocks(); delete process.env.M365_ACCOUNT_POLICY_PATH; delete process.env.M365_REQUEST_MAX_ATTEMPTS; delete process.env.M365_ROUTE_FACT_TTL_MS; delete process.env.M365_AVOID_THROTTLING; });
it("requires credential GUID principal before callback, never uses client/model identity", async () => {
 setup(); let called = false;
 await expect(policy.withAccountContext({ getToken: async () => "not-jwt" }, async () => { called = true; })).rejects.toMatchObject({ status: 401, code: "invalid_account_principal" });
 expect(called).toBe(false);
});
it("persists sanitized priority facts by actual principal and expires on read", async () => {
 const path = setup(); const now = new Date();
 await policy.withAccountContext(opts(), async key => { expect(key).toMatch(/^[a-f0-9]{64}$/); notePriorityAccessExhausted("opus", { window: "day", resetsAt: new Date(+now + 60000), message: "PRIVATE PROMPT NEVER STORE" }); });
 await policy.withAccountContext(opts(b), async () => expect(activePriorityAccessExhaustion("opus")).toBeNull());
 await policy.withAccountContext(opts(), async () => { expect(activePriorityAccessExhaustion("opus")?.window).toBe("day"); expect(activePriorityAccessExhaustion("opus", new Date(+now + 61000))).toBeNull(); });
 expect(readFileSync(path).includes(Buffer.from("PRIVATE PROMPT"))).toBe(false);
 expect(readFileSync(path).includes(Buffer.from(a))).toBe(false);
 expect(statSync(path).mode & 0o777).toBe(0o600); expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
});
it("bounds all attempts in a request, persists accounting, and consults hold even with avoidance off", async () => {
 setup(); process.env.M365_REQUEST_MAX_ATTEMPTS = "2";
 await policy.withAccountContext(opts(), async () => { policy.admitAccountAttempt(true); policy.admitAccountAttempt(false); expect(() => policy.admitAccountAttempt(false)).toThrowError(policy.AccountPolicyError); policy.noteAccountThrottle(); });
 await expect(policy.withAccountContext(opts(), async () => policy.admitAccountAttempt(false))).rejects.toMatchObject({ code: "account_throttle_hold", status: 429 });
 await policy.withAccountContext(opts(b), async () => policy.admitAccountAttempt(true));
});
it("expires alive and dead facts and permits one leased revalidation, with transient cleanup", async () => {
 setup(); process.env.M365_ROUTE_FACT_TTL_MS = "10"; const tone = "Gpt_6_Sol_Reasoning";
 let now = Date.now();
 vi.spyOn(Date, "now").mockImplementation(() => now);
 await policy.withAccountContext(opts(), async () => { noteAgentRouteAlive(tone); expect(isAgentRouteAlive(tone)).toBe(true); });
 now += 20;
 let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let ready!: () => void; const entered = new Promise<void>(r => { ready = r; });
 const probe = policy.withAccountContext(opts(), async () => { expect(isAgentRouteAlive(tone)).toBe(false); expect(toneUsesToolAgent(tone)).toBe(true); ready(); await gate; });
 await entered;
 await policy.withAccountContext(opts(), async () => expect(() => toneUsesToolAgent(tone)).toThrowError(policy.AccountPolicyError));
 release(); await probe;
 await policy.withAccountContext(opts(), async () => { expect(toneUsesToolAgent(tone)).toBe(true); expect(noteAgentRouteDead(tone)).toBe(true); expect(toneUsesToolAgent(tone)).toBe(true); expect(noteAgentRouteDead(tone)).toBe(true); expect(toneUsesToolAgent(tone)).toBe(false); });
 await policy.withAccountContext(opts(b), async () => expect(toneUsesToolAgent(tone)).toBe(true));
 now += 20;
 await policy.withAccountContext(opts(), async () => expect(toneUsesToolAgent(tone)).toBe(true));
});
it("separates one tone across included versus paid scenarios and explicit agent config", async () => {
 setup();
 await policy.withAccountContext(opts(), async () => { requestUsesAgent("claude-sonnet", true); noteAgentRouteAlive("Claude_Sonnet"); expect(isAgentRouteAlive("Claude_Sonnet")).toBe(true); requestUsesAgent("claude-sonnet-5.5", true); expect(isAgentRouteAlive("Claude_Sonnet")).toBe(false); });
 await policy.withAccountContext({ ...opts(), accountRouteScope: "different-agent-config" }, async () => { requestUsesAgent("claude-sonnet", true); expect(isAgentRouteAlive("Claude_Sonnet")).toBe(false); });
});
it("refuses a corrupt database without replacing it", async () => {
 const path = setup(); await policy.withAccountContext(opts(), async () => {}); writeFileSync(path, "corrupt");
 await expect(policy.withAccountContext(opts(), async () => {})).rejects.toMatchObject({ code: "account_policy_unavailable" }); expect(readFileSync(path, "utf8")).toBe("corrupt");
});
it("refuses unknown schema versions and bounds a locked writer wait", async () => {
 const path = setup(); await policy.withAccountContext(opts(), async () => {});
 const db = new DatabaseSync(path); db.exec("PRAGMA user_version=99");
 await expect(policy.withAccountContext(opts(), async () => {})).rejects.toMatchObject({ code:"account_policy_unavailable" });
 db.exec("PRAGMA user_version=1; BEGIN IMMEDIATE"); const start=Date.now();
 await expect(policy.withAccountContext(opts(), async () => {})).rejects.toMatchObject({ code:"account_policy_unavailable" });
 expect(Date.now()-start).toBeLessThan(4000); db.exec("ROLLBACK"); db.close();
});
it("serializes native subprocess admissions and retains priority across restart", async () => {
 const path = setup(); process.env.M365_AVOID_THROTTLING = "1";
 const script = `import {withAccountContext,admitAccountAttempt} from './packages/core/src/account-policy.ts'; import {notePriorityAccessExhausted,activePriorityAccessExhaustion} from './packages/core/src/priority-access.ts'; const token=${JSON.stringify(token())}; try { await withAccountContext({getToken:async()=>token},async()=>{ if(process.argv[1]==='read') {console.log(activePriorityAccessExhaustion('opus')?.window);return;} admitAccountAttempt(true); notePriorityAccessExhausted('opus',{window:'day',resetsAt:new Date(Date.now()+60000),message:'secret'}); }); }catch(e){console.log(e.code);process.exitCode=2;}`;
 const run = (arg: string) => new Promise<{code: number|null,text:string}>(resolve => { const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, arg], { cwd: process.cwd(), env: { ...process.env, M365_ACCOUNT_POLICY_PATH: path, M365_BUDGET_CAPACITY: "1", M365_BUDGET_RESERVE: "0", M365_BUDGET_REFILL: "0.000001" } }); let text = ""; child.stdout.on("data", d => text += d); child.stderr.resume(); child.on("close", code => resolve({code,text})); });
 const results = await Promise.all([run("write"), run("write")]); expect(results.map(r => r.code).sort()).toEqual([0,2]); expect(results.find(r => r.code === 2)?.text).toContain("account_turn_budget"); expect((await run("read")).text).toContain("day");
});
it("rejects malformed v1 native schemas and invalid persisted rows before callback without repairing bytes", async () => {
 const path=setup(); await policy.withAccountContext(opts(),async()=>{});
 const db=new DatabaseSync(path); db.exec("DROP TABLE accounts; CREATE TABLE accounts(account TEXT,level REAL NOT NULL,updated INTEGER NOT NULL,hold INTEGER NOT NULL)"); db.close();
 const before=readFileSync(path); let calls=0;
 await expect(policy.withAccountContext(opts(),async()=>{calls++;})).rejects.toMatchObject({code:"account_policy_unavailable"});
 expect(calls).toBe(0); expect(readFileSync(path)).toEqual(before);
 const fresh=setup(); await policy.withAccountContext(opts(),async()=>{});
 const rows=new DatabaseSync(fresh); rows.prepare("INSERT INTO accounts VALUES(?,?,?,?)").run(policy.accountKeyFromToken(token()),-1,Date.now(),0); rows.close();
 const invalid=readFileSync(fresh);
 await expect(policy.withAccountContext(opts(),async()=>{calls++;})).rejects.toMatchObject({code:"account_policy_unavailable"});
 expect(calls).toBe(0); expect(readFileSync(fresh)).toEqual(invalid);
});
it("rejects expired generation publication after a new owner has acquired the route", async () => {
 setup(); let now=Date.now(); vi.spyOn(Date,"now").mockImplementation(()=>now);
 let release!:()=>void; const gate=new Promise<void>(r=>release=r); let entered!:()=>void; const ready=new Promise<void>(r=>entered=r);
 const old=policy.withAccountContext(opts(),async()=>{policy.leaseAccountRoute("magic");entered();await gate;expect(()=>policy.noteAccountRoute("magic",true)).toThrowError(policy.AccountPolicyError);});
 await ready; now+=120001;
 await policy.withAccountContext(opts(),async()=>{policy.leaseAccountRoute("magic");policy.noteAccountRoute("magic",false);release();await old;expect(policy.accountRouteFact("magic")).toBe("suspect");});
});

it("refuses invalid fact writes before mutation and leaves the next principal readable", async () => {
 const path = setup();
 await policy.withAccountContext(opts(), async () => {
  for (const [kind,dimension,value] of [["priority","raw-private-model","day"],["priority","opus","invalid"],["route","not-hashed","alive"]]) {
   expect(() => policy.writeAccountFact(kind!,dimension!,value!,Date.now()+60000)).toThrowError(policy.AccountPolicyError);
  }
  const db = new DatabaseSync(path); expect(db.prepare("SELECT * FROM facts").all()).toEqual([]); db.close();
 });
 await policy.withAccountContext(opts(b), async () => expect(policy.readAccountFact("priority","opus")).toBeNull());
});
