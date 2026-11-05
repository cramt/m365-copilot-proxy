import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { timestamp, validateAccountStore, validAccountFact } from "./account-store-validation.js";
import type { ModelSessionOptions } from "./model.js";

/** Local policy refusal; never a transport failure or a reason to refresh auth. */
export class AccountPolicyError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfter?: number) {
    super(({ invalid_account_principal: "A valid credential account principal is required", account_changed: "Credential account changed; replay in a new conversation", account_throttle_hold: "Local account cooldown policy is active", account_turn_budget: "Local approximate account turn budget is exhausted", request_attempt_limit: "Request upstream attempt limit reached", route_probe_busy: "Account route revalidation is already in progress" } as Record<string,string>)[code] ?? "Account policy storage is unavailable");
    this.name = "AccountPolicyError";
  }
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** Decoding is NOT signature authentication; tokens come only from the existing auth resolver. */
export function accountKeyFromToken(token: string): string {
  try {
    if (typeof token !== "string" || token.length > 32768) throw 0;
    const parts = token.split(".");
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]{1,16384}$/.test(parts[1]!)) throw 0;
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (!guid.test(claims.tid) || !guid.test(claims.oid)) throw 0;
    return hash(`${claims.tid.toLowerCase()}:${claims.oid.toLowerCase()}`);
  } catch { throw new AccountPolicyError(401, "invalid_account_principal"); }
}
function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]; const n = raw?.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
interface Context { key: string; token: string; db: DatabaseSync; attempts: number; maxAttempts: number; owner: string; scope: string; route: string; refs: number; completed: boolean; closed: boolean; leases: Map<string, string>; timer?: ReturnType<typeof setInterval>; failure?: AccountPolicyError; listeners: Set<(error: AccountPolicyError) => void> }
const contexts = new AsyncLocalStorage<Context>();
export function currentAccountContext(): Readonly<Context> | undefined { return contexts.getStore(); }
function unavailable(): never { throw new AccountPolicyError(503, "account_policy_unavailable", 1); }
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  try { db.exec("BEGIN IMMEDIATE"); try { const v = fn(); db.exec("COMMIT"); return v; } catch (e) { db.exec("ROLLBACK"); throw e; } }
  catch (e) { if (e instanceof AccountPolicyError) throw e; return unavailable(); }
}
function database(): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    const path = resolve(process.env.M365_ACCOUNT_POLICY_PATH ?? join(homedir(), ".config", "opencode-m365", "account-policy", "state.sqlite"));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(path)).isSymbolicLink()) return unavailable();
    try { const fd = openSync(path, "wx", 0o600); closeSync(fd); } catch (e: unknown) { if (!(e && typeof e === "object" && "code" in e && e.code === "EEXIST")) throw e; }
    const st = lstatSync(path); if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024 * 1024) return unavailable();
    chmodSync(path, 0o600);
    db = new DatabaseSync(path); db.exec("PRAGMA busy_timeout=2000; PRAGMA journal_mode=DELETE; PRAGMA max_page_count=16384;");
    transaction(db, () => {
      const version = db!.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version !== 0 && version.user_version !== 1) return unavailable();
      if (version.user_version === 0 && db!.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) return unavailable();
      if (version.user_version === 0) db!.exec(`CREATE TABLE IF NOT EXISTS facts(account TEXT NOT NULL, kind TEXT NOT NULL, dimension TEXT NOT NULL, value TEXT NOT NULL, observed INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(account,kind,dimension));
        CREATE TABLE IF NOT EXISTS accounts(account TEXT PRIMARY KEY, level REAL NOT NULL, updated INTEGER NOT NULL, hold INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY, account TEXT NOT NULL, at INTEGER NOT NULL, thread_start INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS attempts_time ON attempts(at);
        CREATE TABLE IF NOT EXISTS leases(account TEXT NOT NULL, dimension TEXT NOT NULL, owner TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(account,dimension)); PRAGMA user_version=1;`);
      validateAccountStore(db!);
      const now = Date.now();
      db!.prepare("DELETE FROM facts WHERE expires<=?").run(now);
      db!.prepare("DELETE FROM leases WHERE expires<=?").run(now);
      db!.prepare("DELETE FROM attempts WHERE at<?").run(now - 72 * 3600000);
      db!.prepare("DELETE FROM accounts WHERE updated<? AND hold<=?").run(now - 72 * 3600000, now);
      for (const table of ["facts", "accounts", "attempts", "leases"]) {
        const row = db!.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }; if (row.n > 100000) return unavailable();
      }
    });
    return db;
  } catch (e) { try { db?.close(); } catch {} if (e instanceof AccountPolicyError) throw e; return unavailable(); }
}
/** Establish before pool lookup/fact checks; ALS propagates through asynchronous stream producers. */
export async function withAccountContext<T>(options: ModelSessionOptions, callback: (accountKey: string) => Promise<T>): Promise<T> {
  const token = await (options.getToken ?? (await import("./auth.js")).getToken)();
  const key = accountKeyFromToken(token); const existing = contexts.getStore();
  if (existing) { if (existing.key !== key) throw new AccountPolicyError(409, "account_changed"); return callback(key); }
  const ctx: Context = { key, token, db: database(), attempts: 0, maxAttempts: Math.floor(numberEnv("M365_REQUEST_MAX_ATTEMPTS", 3, 1, 10)), owner: randomUUID(), scope: options.accountRouteScope ?? "default-agent-v1", route: "OfficeWebIncludedCopilot", refs: 0, completed: false, closed: false, leases: new Map(), listeners: new Set() };
  let failed = false;
  try { return await contexts.run(ctx, () => callback(key)); }
  catch (error) { failed = true; throw error; }
  finally { ctx.completed = true; try { closeContext(ctx); } catch (error) { if (!failed) throw error; } }
}
function closeContext(ctx: Context): void {
  if (ctx.closed || !ctx.completed || ctx.refs > 0) return;
  ctx.closed = true;
  if (ctx.timer) clearInterval(ctx.timer);
  let failed = false;
  try { ctx.db.prepare("DELETE FROM leases WHERE owner=?").run(ctx.owner); for (const [dimension, owner] of ctx.leases) ctx.db.prepare("DELETE FROM leases WHERE account=? AND dimension=? AND owner=?").run(ctx.key, dimension, owner); } catch { failed = true; }
  finally { try { ctx.db.close(); } catch { failed = true; } ctx.listeners.clear(); }
  if (failed) unavailable();
}
/** A real upstream stream retains policy storage until its terminal callback, not handshake. */
export function retainAccountContext(onFailure?: (error: AccountPolicyError) => void): () => void {
  const ctx = contexts.getStore(); if (!ctx) return () => {};
  ctx.refs++; if (onFailure) ctx.listeners.add(onFailure); let released = false;
  return () => { if (released) return; released = true; if (onFailure) ctx.listeners.delete(onFailure); ctx.refs--; closeContext(ctx); };
}
export function bindAccountPolicy<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R { return AsyncLocalStorage.bind(fn); }
export function assertAccountToken(token: string): void {
  const ctx = contexts.getStore(); if (ctx && accountKeyFromToken(token) !== ctx.key) throw new AccountPolicyError(409, "account_changed");
}
export function readAccountFact(kind: string, dimension: string, now = Date.now()): { value: string; expires: number } | null {
  const ctx = contexts.getStore(); if (!ctx) return null;
  try {
    const row = ctx.db.prepare("SELECT value, expires FROM facts WHERE account=? AND kind=? AND dimension=?").get(ctx.key, kind, dimension) as { value: string; expires: number } | undefined;
    if (!row || row.expires <= now) return null;
    if (!Number.isSafeInteger(row.expires) || typeof row.value !== "string" || row.value.length > 64) return unavailable();
    return row;
  } catch (e) { if (e instanceof AccountPolicyError) throw e; return unavailable(); }
}
export function writeAccountFact(kind: string, dimension: string, value: string, expires: number, now = Date.now()): void {
  const ctx = contexts.getStore(); if (!ctx) return;
  if (ctx.failure) throw ctx.failure;
  if (!validAccountFact(kind, dimension, value, expires, now)) return unavailable();
  transaction(ctx.db, () => {
    if (kind === "route") {
      const owner = ctx.leases.get(dimension);
      const lease = ctx.db.prepare("SELECT owner,expires FROM leases WHERE account=? AND dimension=?").get(ctx.key, dimension);
      if ((owner && (!lease || lease.owner !== owner || Number(lease.expires) <= now)) || (!owner && lease && Number(lease.expires) > now)) throw new AccountPolicyError(429, "route_probe_busy", 1);
    }
    ctx.db.prepare("INSERT INTO facts VALUES(?,?,?,?,?,?) ON CONFLICT(account,kind,dimension) DO UPDATE SET value=excluded.value,observed=excluded.observed,expires=excluded.expires").run(ctx.key, kind, dimension, value, now, expires); });
}
export function setAccountRouteScenario(scenario: string): void { const ctx = contexts.getStore(); if (ctx) ctx.route = scenario; }
export function accountRouteDimension(tone: string): string {
  const ctx = contexts.getStore(); return hash(JSON.stringify([tone, ctx?.scope, ctx?.route, process.env.M365_FORCE_AGENT ?? "", process.env.M365_AGENT_ID ?? ""]));
}
export function accountRouteFact(tone: string): string | null {
  const fact = readAccountFact("route", accountRouteDimension(tone)); if (fact && fact.value !== "alive" && fact.value !== "dead" && fact.value !== "suspect") return unavailable(); return fact?.value ?? null;
}
export function noteAccountRoute(tone: string, alive: boolean): void {
  const previous = readAccountFact("route", accountRouteDimension(tone));
  writeAccountFact("route", accountRouteDimension(tone), alive ? "alive" : previous?.value === "suspect" || previous?.value === "dead" ? "dead" : "suspect", Date.now() + numberEnv("M365_ROUTE_FACT_TTL_MS", 15 * 60000, 1, 86400000));
}
const LEASE_MS = 120000;
function renewContext(ctx: Context): void {
  if (ctx.closed || ctx.failure) return;
  try {
    transaction(ctx.db, () => {
      const now = Date.now();
      for (const [dimension, owner] of ctx.leases) {
        const result = ctx.db.prepare("UPDATE leases SET expires=? WHERE account=? AND dimension=? AND owner=? AND expires>?").run(now + LEASE_MS, ctx.key, dimension, owner, now);
        if (Number(result.changes) !== 1) throw new AccountPolicyError(503, "account_policy_unavailable", 1);
      }
    });
  } catch {
    ctx.failure = new AccountPolicyError(503, "account_policy_unavailable", 1);
    if (ctx.timer) clearInterval(ctx.timer);
    for (const listener of [...ctx.listeners]) { try { listener(ctx.failure); } catch {} }
  }
}
/** Renew on traffic as well as a bounded heartbeat; never resurrect an expired generation. */
export function renewAccountLeases(): void {
  const ctx = contexts.getStore(); if (!ctx) return;
  if (ctx.leases.size) renewContext(ctx);
  if (ctx.failure) throw ctx.failure;
}
export function leaseAccountRoute(tone: string): void {
  const ctx = contexts.getStore(); if (!ctx) return;
  if (ctx.failure) throw ctx.failure;
  transaction(ctx.db, () => {
    const dimension = accountRouteDimension(tone); const now = Date.now();
    const row = ctx.db.prepare("SELECT owner,expires FROM leases WHERE account=? AND dimension=?").get(ctx.key, dimension) as { owner: string; expires: number } | undefined;
    if (row && row.owner !== ctx.leases.get(dimension) && row.expires > now) throw new AccountPolicyError(429, "route_probe_busy", Math.max(1, Math.ceil((row.expires - now)/1000)));
    const owner = row && row.expires > now ? row.owner : randomUUID();
    ctx.db.prepare("INSERT INTO leases VALUES(?,?,?,?) ON CONFLICT(account,dimension) DO UPDATE SET owner=excluded.owner,expires=excluded.expires").run(ctx.key, dimension, owner, now + LEASE_MS);
    ctx.leases.set(dimension, owner);
  });
  if (!ctx.timer) { ctx.timer = setInterval(() => renewContext(ctx), LEASE_MS / 4); ctx.timer.unref(); }
}
/** Atomic account debit immediately before chat, including reconnects and hidden proxy retries. */
export function admitAccountAttempt(threadStart: boolean, now = Date.now()): void {
  const ctx = contexts.getStore(); if (!ctx) return unavailable();
  if (ctx.failure) throw ctx.failure;
  if (ctx.attempts >= ctx.maxAttempts) throw new AccountPolicyError(429, "request_attempt_limit");
  transaction(ctx.db, () => {
    const capacity = numberEnv("M365_BUDGET_CAPACITY", 100, 1, 10000), refill = numberEnv("M365_BUDGET_REFILL", 1.6, 0.000001, 10000), reserve = numberEnv("M365_BUDGET_RESERVE", 20, 0, capacity - 1);
    const row = ctx.db.prepare("SELECT level,updated,hold FROM accounts WHERE account=?").get(ctx.key) as { level: number; updated: number; hold: number } | undefined;
    if (row && (!Number.isFinite(row.level) || row.level < 0 || row.level > 10000 || !timestamp(row.updated) || !timestamp(row.hold))) return unavailable();
    if (row && row.hold > now) throw new AccountPolicyError(429, "account_throttle_hold", Math.ceil((row.hold-now)/1000));
    const level = row ? Math.min(capacity, row.level + Math.max(0, now-row.updated)*refill/60000) : capacity;
    if (process.env.M365_AVOID_THROTTLING && process.env.M365_AVOID_THROTTLING !== "0" && level < 1 + reserve) throw new AccountPolicyError(429, "account_turn_budget", Math.ceil((1+reserve-level)/refill*60));
    ctx.db.prepare("INSERT INTO accounts VALUES(?,?,?,0) ON CONFLICT(account) DO UPDATE SET level=excluded.level,updated=excluded.updated").run(ctx.key, Math.max(0,level-1), now);
    ctx.db.prepare("INSERT INTO attempts(account,at,thread_start) VALUES(?,?,?)").run(ctx.key, now, threadStart ? 1 : 0);
  });
  ctx.attempts++;
}
/** Operator cooldown policy, not a claimed Microsoft reset time. Always enforced. */
export function noteAccountThrottle(now = Date.now()): void {
  const ctx = contexts.getStore(); if (!ctx) return;
  const hold = now + numberEnv("M365_BUDGET_HOLD_MIN", 75, 1, 1440)*60000;
  transaction(ctx.db, () => { ctx.db.prepare("INSERT INTO accounts VALUES(?,0,?,?) ON CONFLICT(account) DO UPDATE SET hold=max(hold,excluded.hold),updated=excluded.updated").run(ctx.key,now,hold); });
}
