// One turn straight to M365 for the usage-limit study (docs/m365-copilot-api.md §7),
// bypassing the proxy: no exhaustion memory, no retries, no fallback model, so every
// call is exactly one upstream turn and a refusal is seen as M365 sent it.
//
//   HOME=<dir holding .config/opencode-m365/msal-cache.json> M365_NO_INTERACTIVE=1 \
//     node scripts/quota-direct.mjs <exp-label> [tone=magic] [text] [--transport streamhub]
//
// Appends a row to docs/quota/direct.jsonl: time, tone, transport, request size, result,
// TotalTurnUsageDaily, the metering keys that differ from the previous row, and any
// frame that mentions MeteringInfo / billing / cost / resetAt (saved whole, since none
// has been seen on this account yet).
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { getTokenSilent, decodeJwt } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

//   flags: --transport streamhub, --timeout <ms> (cancel the turn by closing the socket),
//          --variants-add a,b (extra WS-query variants, e.g. the web client's opt-ins)
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const [label = "adhoc", tone = "magic", argText = "Reply with the single word pong."] = positional;
// --text-file: inputs past Linux's 128 KiB per-argument limit can't go on the command line.
const text = flag("--text-file") ? readFileSync(flag("--text-file"), "utf8") : argText;
const transport = flag("--transport");
const timeoutMs = flag("--timeout") ? Number(flag("--timeout")) : undefined;
const variantsAdd = flag("--variants-add");
const BASE_VARIANTS = ["EnableMcpServerWidgets", "feature.EnableMcpServerWidgets", "feature.IsStreamingModeInChatRequestEnabled", "DeveloperLogs", "Agt_bizchat_enableGpt5ForHelix"];
const OUT = new URL("../docs/quota/direct.jsonl", import.meta.url).pathname;

const token = await getTokenSilent();
if (!token) throw new Error("no cached token; refusing to log in interactively");
const claims = decodeJwt(token);

const interesting = [];
// Everything in the final frame's `throttling` except the counts and `metering`:
// the client reads `meteringLimitAlerts` from here, which nothing has logged yet.
let throttlingExtra;
const t0 = new Date().toISOString();
const r = await oneTurn({
  token, claims, text, tone,
  ...(transport ? { transport } : {}),
  ...(timeoutMs ? { timeoutMs } : {}),
  ...(variantsAdd ? { variants: [...BASE_VARIANTS, ...variantsAdd.split(",")].join(",") } : {}),
  onFrame: (raw) => {
    const th = raw?.item?.throttling;
    if (th) {
      const { metering, numUserMessagesInConversation, maxNumUserMessagesInConversation, ...rest } = th;
      if (Object.keys(rest).length) throttlingExtra = rest;
    }
    const s = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (/meteringInfo|MeteringInfo|billing_?[iI]nfo|cost_?info|resetAt|creditStatus/.test(s)) interesting.push(s.slice(0, 20000));
  },
});
const rawMeter = r.throttle?.metering;
const meter = rawMeter ? Object.fromEntries(Object.entries(rawMeter).map(([k, v]) => [k, v?.remainingAllowance ?? v])) : null;

let prev = null;
if (existsSync(OUT)) {
  const rows = readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  prev = rows.reverse().find((x) => x.meter)?.meter ?? null;
}
const delta = {};
if (meter) for (const [k, v] of Object.entries(meter)) if (k !== "TotalTurnUsageDaily" && (!prev || prev[k] !== v)) delta[k] = v;

const row = {
  exp: label, t0, t1: new Date().toISOString(), tone, transport: r.transport, text_chars: text.length,
  ...(timeoutMs ? { timeoutMs } : {}), ...(variantsAdd ? { variantsAdd } : {}),
  throttlingExtra,
  result: r.result?.value ?? null, errorCode: r.result?.errorCode ?? null, creditScenario: r.result?.creditScenario ?? null,
  ttud: meter?.TotalTurnUsageDaily ?? null, convMsgs: r.throttle?.current ?? null,
  delta: Object.keys(delta).length ? delta : undefined,
  reply: (r.fullText || r.result?.message || r.error || "").slice(0, 160),
  billing: r.billing?.length ? r.billing : undefined,
  interesting: interesting.length ? interesting : undefined,
  meter,
};
appendFileSync(OUT, JSON.stringify(row) + "\n");
const { meter: _m, ...shown } = row;
console.log(JSON.stringify(shown));
