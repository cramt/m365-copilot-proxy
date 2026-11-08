import { validPriorityDimension } from "./priority-dimension.js";
import type { DatabaseSync } from "node:sqlite";

export const timestamp = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000;
const key = (s: unknown) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
/** Same closed contract for admission and persisted-row validation. */
export function validAccountFact(kind: unknown, dimension: unknown, value: unknown, expires: unknown, observed: unknown): boolean {
  return timestamp(observed) && timestamp(expires) && expires > observed && expires - observed <= 8 * 86400000 &&
    (kind === "route" ? key(dimension) && ["alive", "dead", "suspect"].includes(String(value)) :
     kind === "priority" && validPriorityDimension(dimension) && ["day", "week"].includes(String(value)));
}
const uuid = (s: unknown) => typeof s === "string" && /^[a-f0-9-]{36}$/.test(s);
const columns = {
  facts: [["account","TEXT",1,1],["kind","TEXT",1,2],["dimension","TEXT",1,3],["value","TEXT",1,0],["observed","INTEGER",1,0],["expires","INTEGER",1,0]],
  accounts: [["account","TEXT",0,1],["level","REAL",1,0],["updated","INTEGER",1,0],["hold","INTEGER",1,0]],
  attempts: [["id","INTEGER",0,1],["account","TEXT",1,0],["at","INTEGER",1,0],["thread_start","INTEGER",1,0]],
  leases: [["account","TEXT",1,1],["dimension","TEXT",1,2],["owner","TEXT",1,0],["expires","INTEGER",1,0]],
};
/** Inspect native schema and persisted values before any pruning or caller callback. */
export function validateAccountStore(db: DatabaseSync): void {
  const bad = () => { throw new Error("Invalid account policy store"); };
  for (const [table, expected] of Object.entries(columns)) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all();
    if (JSON.stringify(actual.map(r => [r.name,r.type,r.notnull,r.pk])) !== JSON.stringify(expected)) bad();
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all();
    const primary = expected.filter(c => Number(c[3]) > 0).map(c => c[0]);
    if (table !== "attempts" && !indexes.some(i => i.unique === 1 && i.origin === "pk" && JSON.stringify(db.prepare(`PRAGMA index_info('${String(i.name).replaceAll("'", "''")}')`).all().map(r => r.name)) === JSON.stringify(primary))) bad();
    if (table === "attempts" && !indexes.some(i => i.name === "attempts_time" && i.unique === 0 && i.partial === 0 && JSON.stringify(db.prepare("PRAGMA index_info(attempts_time)").all().map(r => r.name)) === '["at"]')) bad();
    const count = db.prepare(`SELECT count(*) AS n FROM ${table}`).get();
    if (!count || Number(count.n) > 100000) bad();
    for (const r of db.prepare(`SELECT * FROM ${table}`).iterate()) {
      if (!key(r.account)) bad();
      if (table === "accounts" && !(typeof r.level === "number" && Number.isFinite(r.level) && r.level >= 0 && r.level <= 10000 && timestamp(r.updated) && timestamp(r.hold))) bad();
      if (table === "attempts" && !(typeof r.id === "number" && Number.isSafeInteger(r.id) && r.id > 0 && timestamp(r.at) && (r.thread_start === 0 || r.thread_start === 1))) bad();
      if (table === "leases" && !(key(r.dimension) && uuid(r.owner) && timestamp(r.expires))) bad();
      if (table === "facts") {
        if (!validAccountFact(r.kind, r.dimension, r.value, r.expires, r.observed)) bad();
      }
    }
  }
}
