#!/usr/bin/env node
// One JSON row per finished M365 turn in the proxy's debug.log, for the usage-limit
// study (docs/m365-copilot-api.md §7, data in docs/quota/turns.jsonl).
//
//   ssh root@luna cat /var/lib/m365-copilot-proxy/.config/opencode-m365/debug.log \
//     | node scripts/quota-log.mjs [--since 2026-11-22T00:00:00Z] [--all-keys]
//
// A row: t (final frame), cid, model/tone/scenario (from the run's own log lines),
// result value/errorCode, turnState, the conversation counter, TotalTurnUsageDaily
// (`ttud`), and every other metering key whose value differs from the previous row
// (`delta`), so a key that moves stands out without printing 60 keys a turn.
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const since = args.includes("--since") ? new Date(args[args.indexOf("--since") + 1]) : null;
const allKeys = args.includes("--all-keys");

const byCid = new Map(); // cid → {model, tone, scenario}
let lastCid = null;
let prevMeter = null;
const ts = (l) => l.match(/^\[([^\]]+)\]/)?.[1];

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let m;
  if ((m = line.match(/\[model\] run: model=([^,]+),.*cid=([0-9a-f-]+)/))) {
    byCid.set(m[2], { model: m[1] });
    lastCid = m[2];
    continue;
  }
  if ((m = line.match(/\[session\] Routing: tone=([^,]+), scenario=([^,]+)/)) && lastCid) {
    Object.assign(byCid.get(lastCid), { tone: m[1], scenario: m[2], sent: ts(line) });
    continue;
  }
  if (!line.includes('WS recv: {"type":2')) continue;
  const t = ts(line);
  if (since && new Date(t) < since) continue;
  let item;
  try {
    item = JSON.parse(line.slice(line.indexOf("{")).replace(/\x1e.*$/s, "")).item;
  } catch {
    continue; // truncated frame
  }
  if (!item) continue;
  const meter = Object.fromEntries(
    Object.entries(item.throttling?.metering ?? {}).map(([k, v]) => [k, v?.remainingAllowance]),
  );
  const delta = {};
  for (const [k, v] of Object.entries(meter)) {
    if (k === "TotalTurnUsageDaily") continue;
    if (allKeys || !prevMeter || prevMeter[k] !== v) delta[k] = v;
  }
  if (Object.keys(meter).length) prevMeter = meter;
  const run = byCid.get(item.conversationId) ?? {};
  console.log(
    JSON.stringify({
      t,
      cid: item.conversationId,
      ...run,
      durS: run.sent ? Math.round((new Date(t) - new Date(run.sent)) / 100) / 10 : undefined,
      result: item.result?.value,
      errorCode: item.result?.errorCode,
      creditScenario: item.result?.creditScenario,
      turnState: item.turnState,
      convMsgs: item.throttling?.numUserMessagesInConversation,
      ttud: meter.TotalTurnUsageDaily,
      ...(Object.keys(delta).length && prevMeter !== null ? { delta } : {}),
    }),
  );
}
