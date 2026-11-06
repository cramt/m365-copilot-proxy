import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { withAccountContext, admitAccountAttempt, accountKeyFromToken } from "../packages/core/src/account-policy.js";
import { recordTurn, recordThrottle, proxyBudgetStatus, budgetConfig, awaitTurnBudget } from "../packages/core/src/turn-budget.js";
const peer = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock("../node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs", () => ({ default: class extends EventEmitter {
  constructor() { super(); peer.sockets.push(this); }
  send() {} close() {}
} }));
// @ts-expect-error Probe entrypoint has no declarations.
const { oneTurn, probeBudgetStatus } = await import("./_probe-chat.mjs");
// Use built policy, as oneTurn's native recording calls the built module too.
const built = await import("../packages/core/dist/index.mjs");
const claims = (oid: string) => ({ aud: "synthetic", iss: "synthetic", tid: "11111111-1111-1111-1111-111111111111", oid, exp: 2000000000 });
const token = (c: object) => `e30.${Buffer.from(JSON.stringify(c)).toString("base64url")}.sig`;
const a = claims("22222222-2222-2222-2222-222222222222"), b = claims("33333333-3333-3333-3333-333333333333");
afterEach(() => vi.unstubAllEnvs());
it("explicit scoped probe inside another ambient principal never debits or throttles it", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "probe-composition-")), "state.sqlite");
  vi.stubEnv("M365_ACCOUNT_POLICY_PATH", path);
  // Import built account policy explicitly; it shares module authority with built recording.
  const policy = built;
  await policy.withAccountContext({ getToken: async () => token(a), useAgent: false }, async () => {
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO accounts VALUES(?,?,?,?)").run(accountKeyFromToken(token(a)), 17, Date.now(), 0);
    const before = db.prepare("SELECT * FROM accounts").all();
    const result = oneTurn({ token: token(b), claims: b, text: "synthetic", timeoutMs: 1000 });
    const ws = peer.sockets.at(-1); ws.emit("open"); ws.emit("message", Buffer.from("{}\x1e"));
    ws.emit("message", Buffer.from(JSON.stringify({ type: 2, item: { result: { errorCode: "PerUserThrottled" } } }) + "\x1e"));
    expect((await result).attempted).toBe(true);
    const status = probeBudgetStatus({ token: token(b), claims: b });
    expect.soft(status).toMatchObject({ attempts: 1, stopped: true, pacing: { turns: 1 } });
    expect.soft(db.prepare("SELECT * FROM accounts").all()).toEqual(before);
    db.close();
  });
});
it("unscoped authenticated session retains durable admission, no duplicate grant/debit and throttle note", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "session-composition-")), "state.sqlite");
  vi.stubEnv("M365_ACCOUNT_POLICY_PATH", path);
  await withAccountContext({ getToken: async () => token(a), useAgent: false }, async () => {
    admitAccountAttempt(true);
    const db = new DatabaseSync(path);
    const before = db.prepare("SELECT * FROM accounts").all();
    await awaitTurnBudget({ cfg: { ...budgetConfig({}), enabled: true, dirs: [], capacity: 0 } });
    recordTurn();
    expect.soft(db.prepare("SELECT * FROM accounts").all()).toEqual(before);
    expect(proxyBudgetStatus(Date.now(), { ...budgetConfig({}), dirs: [] }, false).turns).toBe(0);
    recordThrottle();
    expect((db.prepare("SELECT hold FROM accounts WHERE account=?").get(accountKeyFromToken(token(a))) as any).hold).toBeGreaterThan(Date.now());
    db.close();
  });
  await expect(withAccountContext({ getToken: async () => token(a), useAgent: false }, async () => admitAccountAttempt(false))).rejects.toMatchObject({ code: "account_throttle_hold" });
});
