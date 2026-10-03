// Does M365's code-interpreter sandbox have OUTBOUND NETWORK? If so, the
// lightweight bot can call our tunnel via Python — a tool bridge with no native
// tool attachment needed.
//
// Asks the model (code-interpreter optionsSets, no agent) to HTTP-GET our tunnel
// /sentinel endpoint from inside the sandbox and report the secret value. We
// then cross-check: (a) did our sentinel server log an inbound hit (proves real
// egress, from a Microsoft IP), and (b) did the model report the correct value.
//
// Usage: node scripts/code-interp-egress.mjs <tunnel-base-url> ["python snippet hint"]
import { readFileSync } from "node:fs";
import { getToken, decodeJwt } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

const TUNNEL = (process.argv[2] || readFileSync("/tmp/tunnel_url.txt", "utf8"))
  .trim()
  .replace(/\/$/, "");
const HINT = process.argv[3] || "";
const SENTINEL = readFileSync("scripts/sentinel-value.txt", "utf8").trim();
const URL = `${TUNNEL}/sentinel`;

const CODE_INTERP = [
  "cwc_code_interpreter",
  "cwc_code_interpreter_amsfix",
  "cwc_code_interpreter_citation_fix",
  "code_interpreter_interactive_charts",
  "code_interpreter_matplotlib_patching",
];

const token = await getToken();
const claims = decodeJwt(token);

const prompt =
  `Use your Python code interpreter to make a real outbound HTTP GET request to this exact URL: ${URL}\n` +
  `${HINT ? `${HINT}\n` : ""}` +
  `Use urllib.request (or requests). Actually execute the code in the sandbox, then print the EXACT raw response body you received. ` +
  `If the request fails, print the full exception text verbatim so I can see the error.`;

const hitsBefore = (() => {
  try {
    return readFileSync("scripts/sentinel-hits.log", "utf8");
  } catch {
    return "";
  }
})();

console.log(`[egress] tunnel=${TUNNEL} sentinel=${SENTINEL}`);
const r = await oneTurn({
  token,
  claims,
  agentId: null,
  optionsSets: CODE_INTERP,
  extraAllowed: ["GeneratedCode", "GenerateContentQuery", "Progress"],
  text: prompt,
  timeoutMs: 120000,
});
const out = r.fullText || "";

const hitsAfter = (() => {
  try {
    return readFileSync("scripts/sentinel-hits.log", "utf8");
  } catch {
    return "";
  }
})();
const newHits = hitsAfter.slice(hitsBefore.length);
const serverGotHit = /GET \/sentinel|SENTINEL ENDPOINT CALLED/.test(newHits);
const modelHasValue = out.includes(SENTINEL);

console.log(`\n[egress] === RESULT ===`);
console.log(`[egress] model reply (first 500):\n${out.slice(0, 500)}`);
console.log(
  `\n[egress] sentinel server got a NEW inbound hit: ${serverGotHit}  ${serverGotHit ? "🎉 SANDBOX HAS EGRESS" : "❌ no inbound hit"}`,
);
console.log(
  `[egress] model reported the correct sentinel value: ${modelHasValue}  ${modelHasValue ? "🎉 END-TO-END" : ""}`,
);
if (newHits.trim()) console.log(`[egress] new hit log lines:\n${newHits.trim().slice(0, 400)}`);
console.log(`[egress] msgTypes=${r.messageTypes.join(",")} ${r.elapsedMs}ms`);
