// Prints the account's metering map: the allowances M365 reports the account has left.
//
// The final item of every Chathub turn under the paid scenario (`OfficeWebPaidCopilot` + `Premium`)
// carries `throttling.metering`, a map of `{<key>: {remainingAllowance: n}}` (API doc §5, priority
// access). StreamHub turns carry no such map (API doc §13), so this script always uses Chathub. It
// sends one turn, agent-less, on a tone that no budget counts (`Magic`, the web client's "Auto",
// unless --tone names another), and prints three parts, a blank line apart:
//
// 1. Whose map it is (the token's `upn`), when it was read, and the turn it came from, with the
//    service version the turn's result names:
//
//      Chathub metering for user@contoso.com, read 2026-11-28T04:11:21.641Z
//      from a Magic turn on OfficeWebPaidCopilot (service 1.0.03611.67938)
//
// 2. The budgets in METERED_BUDGETS (priority-access.ts) as a table: each budget's daily and weekly
//    allowance left and the keys they are read from, "-" for a key the map doesn't have:
//
//      Budget      Daily  Weekly  Keys (daily / weekly)
//      Opus           40      61  ClaudeOpusQueryDaily / ClaudeOpusQuery75
//      Sonnet 5.5     80     147  ClaudeSonnet55QueryDaily / ClaudeSonnet55QueryWeekly
//
// 3. Every other key in the map, sorted by name, one line each, indented two spaces: the key, then
//    its allowance left, right-aligned in a column of its own, four spaces after the widest key:
//
//      Other keys (no budget in METERED_BUDGETS)
//        ClaudeOpus55QueryDailyWord      40
//        ClaudeOpus55QueryWeeklyWord     75
//        ClaudeOpusQuery                100
//
// An entry that holds anything but a number in `remainingAllowance` is printed as JSON. The map is
// read after the turn, so with a tone that a budget counts, that budget shows one less than it had
// before the turn. A turn that doesn't end `Success` is reported on stderr, with its result's value,
// error code and message, or the connection's error; when it carried no map, the script exits 1.
//
// Usage (inside `nix develop`, from the repository root):
//   node scripts/metering.mjs [--tone <tone>]
//
// Cost: one Chathub turn, which lowered no allowance on 2026-11-28 (hypotheses §65 F184). On a
// premium account `Magic` answered, and the map was the same before and after (3 of 3). On a
// non-premium account it left `TotalTurnUsageDaily`, the account's daily turns left, unchanged (2 of
// 2; the one reply recorded was empty), so there the script reads it without spending one.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { METERED_BUDGETS, decodeJwt, getToken } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

/** The paid scenario, and the licence type it is sent with. */
export const SCENARIO = "OfficeWebPaidCopilot";
export const LICENSE_TYPE = "Premium";

/** A tone that no budget counts. */
export const DEFAULT_TONE = "Magic";

const PROMPT = "Reply with exactly the single word: pong";

const USAGE = "Usage: node scripts/metering.mjs [--tone <tone>]";

/**
 * What a metering entry holds: its `remainingAllowance` when that is a number and the entry holds
 * nothing else, otherwise the entry as JSON.
 */
export function allowanceOf(entry) {
  const plain = entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
    Object.keys(entry).length === 1 && Number.isFinite(entry.remainingAllowance);
  return plain ? entry.remainingAllowance : JSON.stringify(entry);
}

/**
 * `throttling.metering` as a Map from each key to what its entry holds; null when the turn carried
 * no map or an empty one. Not core's `parseMetering`: that drops an entry that isn't
 * `{remainingAllowance: n}`, and this script prints every entry M365 sends.
 */
export function readMetering(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  return entries.length ? new Map(entries.map(([key, entry]) => [key, allowanceOf(entry)])) : null;
}

/** One row per budget, in the order `budgets` lists them: its label, its two keys and their values. */
export function budgetRows(metering, budgets = METERED_BUDGETS) {
  return Object.values(budgets).map(({ label, daily, weekly }) => ({
    label,
    dailyKey: daily,
    weeklyKey: weekly,
    daily: metering.get(daily),
    weekly: metering.get(weekly),
  }));
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The keys that no budget in `budgets` reads, as `[key, value]` pairs sorted by key. */
export function otherKeys(metering, budgets = METERED_BUDGETS) {
  const read = new Set(Object.values(budgets).flatMap(({ daily, weekly }) => [daily, weekly]));
  return [...metering].filter(([key]) => !read.has(key)).sort(([a], [b]) => byCodeUnits(a, b));
}

/**
 * Rows of cells as lines: columns `gap` spaces apart, each as wide as its widest cell. A column that
 * `rightAligned` marks is padded on the left, any other on the right, except a last column, which is
 * not padded, so that no line ends in spaces.
 */
function columnLines(rows, rightAligned, gap = 2) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((cells) => cells[i].length)));
  const pad = (text, i, last) => (rightAligned[i] ? text.padStart(widths[i]) : last ? text : text.padEnd(widths[i]));
  return rows.map((cells) => cells.map((text, i) => pad(text, i, i === cells.length - 1)).join(" ".repeat(gap)));
}

/** The two lines above the table: whose map it is and when it was read, then the turn it came from. */
export function formatHeader({ account, readAt, tone, scenario, serviceVersion }) {
  const service = serviceVersion ? ` (service ${serviceVersion})` : "";
  return `Chathub metering for ${account}, read ${readAt}\nfrom a ${tone} turn on ${scenario}${service}`;
}

/** The budget rows as a table, the allowances right-aligned, "-" for a key the map doesn't have. */
export function formatBudgetTable(rows) {
  const value = (v) => (v === undefined ? "-" : String(v));
  return columnLines([
    ["Budget", "Daily", "Weekly", "Keys (daily / weekly)"],
    ...rows.map((row) => [row.label, value(row.daily), value(row.weekly), `${row.dailyKey} / ${row.weeklyKey}`]),
  ], [false, true, true, false]).join("\n");
}

/**
 * The other keys under a title, one line each, indented two spaces: the key, then its value,
 * right-aligned in a column of its own, four spaces after the widest key.
 */
export function formatOtherKeys(entries) {
  const lines = entries.length
    ? columnLines(entries.map(([key, value]) => [key, String(value)]), [false, true], 4)
    : ["(none)"];
  return ["Other keys (no budget in METERED_BUDGETS)", ...lines.map((line) => `  ${line}`)].join("\n");
}

/**
 * How a turn failed: its result's value, error code and message, and the connection's error; null
 * when it ended `Success` without an error.
 */
export function failureOf(turn) {
  if (turn.result?.value === "Success" && !turn.error) return null;
  const what = [turn.result?.value ?? "no result", turn.result?.errorCode, turn.error].filter(Boolean).join(", ");
  const message = typeof turn.result?.message === "string" ? turn.result.message.replace(/\s+/g, " ").trim() : "";
  return message ? `${what}: ${message}` : what;
}

function parseOptions(argv) {
  try {
    return parseArgs({ args: argv, options: { tone: { type: "string", default: DEFAULT_TONE } } }).values;
  } catch (error) {
    throw new Error(`${error.message}\n${USAGE}`);
  }
}

async function main() {
  const { tone } = parseOptions(process.argv.slice(2));
  const token = await getToken();
  const claims = decodeJwt(token);
  const r = await oneTurn({
    token, claims, agentId: null, text: PROMPT,
    transport: "chathub", scenario: SCENARIO, licenseType: LICENSE_TYPE, tone,
  });
  const readAt = new Date().toISOString();
  const failure = failureOf(r);
  if (failure) console.error(`The ${tone} turn on ${SCENARIO} did not succeed: ${failure}`);
  const metering = readMetering(r.throttle?.metering);
  if (!metering) throw new Error("The turn carried no metering map");
  const account = claims.upn ?? claims.unique_name ?? claims.oid;
  console.log([
    formatHeader({ account, readAt, tone, scenario: SCENARIO, serviceVersion: r.serviceVersion }),
    formatBudgetTable(budgetRows(metering)),
    formatOtherKeys(otherKeys(metering)),
  ].join("\n\n"));
}

/** Whether Node runs this file as its main script, also when started through a symlink. */
function runAsMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (runAsMain()) {
  try {
    await main();
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
