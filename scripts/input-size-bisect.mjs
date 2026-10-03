// RE probe: how large an INPUT will M365 Copilot accept before it caps,
// truncates, Disengages, or errors?
//
// Key design choice: isolate pure SIZE from jailbreak-SHAPE. The existing
// Disengaged data conflates the two (12 tools + ALL-CAPS framing). Here we send
// BENIGN filler (innocuous repeated prose) so any failure is attributable to
// size alone. We log dea_violation at every size to see whether benign bulk
// raises the classifier score at all, or whether Disengaged is purely
// content-driven.
//
// Method: a ladder of input sizes (chars). Each turn = a trivial instruction
// the model can only satisfy if it actually received & processed the message,
// followed by N chars of benign filler. We check:
//   - did content come back? (vs Disengaged / empty / error)
//   - did it answer correctly? (canary survived → message not truncated)
//   - dea_violation at this size
//   - latency growth with size
//
// Plain chat (no agent) by default — isolates size from the tool-block content
// that itself nudges Disengaged. Add --agent for the realistic agent-on case.
//
// Usage:
//   M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) \
//     node scripts/input-size-bisect.mjs [--agent]
//     [--ladder 2000,8000,32000,64000,128000,256000]
//
// Cost: one message per ladder rung. Default 6 messages.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getToken, getOrCreateAgent, decodeJwt } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

const args = process.argv.slice(2);
const has = (k) => args.includes(k);
const val = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const USE_AGENT = has("--agent");
const LADDER = val("--ladder", "2000,8000,32000,64000,128000,256000").split(",").map(Number);

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "input-size-out", TS);
mkdirSync(OUT, { recursive: true });

console.log(`[in-probe] out=${OUT}`);
const token = await getToken();
const claims = decodeJwt(token);
let agentId = null;
if (USE_AGENT) {
  agentId = await getOrCreateAgent();
  console.log(`[in-probe] agent=${agentId}`);
}

// Benign filler: innocuous, low-entropy prose. Nothing jailbreak-shaped.
const FILLER_UNIT = "The quick brown fox jumps over the lazy dog. ";
function filler(chars) {
  let s = "";
  while (s.length < chars) s += FILLER_UNIT;
  return s.slice(0, chars);
}

// A canary the model can only echo if it actually received the (whole) message.
// We put the instruction FIRST (survives head-truncation) and a second copy of
// the canary at the very END (survives only if the tail wasn't dropped), so we
// can distinguish "processed head" from "processed whole".
const CANARY_HEAD = "BANANA7";
const CANARY_TAIL = "ZEBRA9";
function makePrompt(chars) {
  return (
    `Reply with EXACTLY two words separated by a space: the secret word at the ` +
    `start of this message and the secret word at the very end. ` +
    `The start secret is "${CANARY_HEAD}". ` +
    `Ignore the filler text in between.\n\n` +
    filler(chars) +
    `\n\nThe end secret is "${CANARY_TAIL}".`
  );
}

const results = [];

async function run(chars) {
  const text = makePrompt(chars);
  const r = await oneTurn({ token, claims, text, agentId, timeoutMs: 150000 });
  const out = r.fullText ?? "";
  const sawHead = out.includes(CANARY_HEAD);
  const sawTail = out.includes(CANARY_TAIL);
  const row = {
    inputChars: text.length,
    approxTokens: Math.round(text.length / 4),
    gotContent: out.trim().length > 0,
    sawHeadCanary: sawHead,
    sawTailCanary: sawTail,
    tailSurvived: sawTail, // tail canary present ⇒ message tail reached the model
    disengaged: r.disengaged,
    messageTypes: r.messageTypes,
    contentOrigin: r.contentOrigin,
    dea: r.scores?.dea_violation ?? null,
    offense: r.scores?.BotOffense ?? null,
    throttle: r.throttle,
    serviceVersion: r.serviceVersion,
    elapsedMs: r.elapsedMs,
    error: r.error,
    replySample: out.slice(0, 120),
  };
  results.push(row);
  console.log(
    `[in-probe] in=${text.length}c (~${row.approxTokens}t) → content=${row.gotContent} ` +
    `head=${sawHead} tail=${sawTail} disengaged=${r.disengaged} ` +
    `dea=${row.dea != null ? row.dea.toExponential(2) : "?"} ${r.elapsedMs}ms ` +
    `${r.error ? `ERR=${r.error}` : ""}`,
  );
  console.log(`           reply: ${JSON.stringify(out.slice(0, 100))}`);
  return row;
}

for (const c of LADDER) {
  await run(c);
}

writeFileSync(
  join(OUT, "results.json"),
  JSON.stringify(
    {
      meta: {
        agent: USE_AGENT,
        ladder: LADDER,
        canaryHead: CANARY_HEAD,
        canaryTail: CANARY_TAIL,
        ts: TS,
      },
      results,
    },
    null,
    2,
  ),
);

// Verdict
console.log(`\n[in-probe] === VERDICT ===`);
for (const r of results) {
  const verdict = r.error
    ? `ERROR(${r.error})`
    : r.disengaged
      ? "DISENGAGED"
      : !r.gotContent
        ? "EMPTY"
        : !r.sawTailCanary
          ? "TAIL-TRUNCATED"
          : !r.sawHeadCanary
            ? "HEAD-LOST"
            : "OK";
  console.log(
    `  ${String(r.inputChars).padStart(7)}c (~${String(r.approxTokens).padStart(6)}t): ${verdict.padEnd(16)} dea=${r.dea != null ? r.dea.toExponential(2) : "?"}`,
  );
}
const firstBad = results.find((r) => r.disengaged || !r.gotContent || !r.sawTailCanary || r.error);
const lastGood = [...results]
  .reverse()
  .find((r) => r.gotContent && r.sawTailCanary && !r.disengaged && !r.error);
if (firstBad) {
  console.log(
    `[in-probe] INPUT CEILING between ${lastGood ? lastGood.inputChars : "?"}c (last good) and ${firstBad.inputChars}c (first bad).`,
  );
  console.log(`[in-probe] Next: bisect that range with --ladder.`);
} else {
  console.log(
    `[in-probe] All ${LADDER.length} rungs OK up to ${Math.max(...LADDER)}c (~${Math.round(Math.max(...LADDER) / 4)}t). Ceiling is higher — extend the ladder.`,
  );
}
// Did benign size move the classifier?
const deas = results.filter((r) => r.dea != null).map((r) => ({ c: r.inputChars, dea: r.dea }));
if (deas.length >= 2) {
  const lo = deas[0],
    hi = deas[deas.length - 1];
  console.log(
    `[in-probe] dea_violation: ${lo.c}c=${lo.dea.toExponential(2)} → ${hi.c}c=${hi.dea.toExponential(2)} (does benign bulk raise the score?)`,
  );
}
console.log(`[in-probe] full output: ${OUT}`);
