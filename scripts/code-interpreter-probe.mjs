// RE probe (H8.1): does enabling the `cwc_code_interpreter` optionsSets unlock a
// REAL server-side Python sandbox in BizChat?
//
// Oracle: ask for the SHA-256 of a unique string. The model CANNOT produce a
// correct 64-hex digest from memory — only real execution yields it. We compute
// the expected digest locally and compare. We also watch for `GeneratedCode` /
// `GenerateContentQuery` frames (the code-interpreter message types).
//
// optionsSets + allowedMessageTypes copied verbatim from the wild
// (kuchris/m365-copilot-openai-proxy). Plain chat (no agent) to isolate the
// native capability from our tool-emulation agent.
//
// Usage: M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) node scripts/code-interpreter-probe.mjs [--control]
//   --control : run WITHOUT the optionsSets (baseline: does plain magic refuse/hallucinate?)
// Cost: 1 message.

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getToken, decodeJwt } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

const CONTROL = process.argv.includes("--control");

const CODE_INTERP_OPTIONSSETS = [
  "cwc_code_interpreter",
  "cwc_code_interpreter_amsfix",
  "cwc_code_interpreter_citation_fix",
  "code_interpreter_interactive_charts",
  "code_interpreter_matplotlib_patching",
  "enable_gg_gpt",
];
const CODE_INTERP_ALLOWED = [
  "GeneratedCode",
  "GenerateContentQuery",
  "Progress",
  "TriggerPlugin",
  "InternalLoaderMessage",
  "RenderCardRequest",
];

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "code-interp-out", TS);
mkdirSync(OUT, { recursive: true });
const framesPath = join(OUT, "frames.ndjson");

const SECRET = `m365-codeinterp-probe-${TS}`;
const EXPECTED = createHash("sha256").update(SECRET, "utf8").digest("hex");

console.log(`[ci] secret="${SECRET}"`);
console.log(`[ci] expected sha256=${EXPECTED}`);
console.log(
  `[ci] mode=${CONTROL ? "CONTROL (no optionsSets)" : "code-interpreter optionsSets ON"}`,
);

const token = await getToken();
const claims = decodeJwt(token);

const prompt =
  `Use your Python code interpreter to compute the SHA-256 hex digest of the exact ASCII string \`${SECRET}\`. ` +
  `Actually run the code in the sandbox — do not compute it by hand or from memory. ` +
  `Show the Python you ran, then give the 64-character lowercase hex digest on its own line.`;

const seenTypes = new Set();
const r = await oneTurn({
  token,
  claims,
  text: prompt,
  agentId: null,
  optionsSets: CONTROL ? [] : CODE_INTERP_OPTIONSSETS,
  extraAllowed: CONTROL ? [] : CODE_INTERP_ALLOWED,
  timeoutMs: 180000,
  onFrame: (f) => {
    appendFileSync(framesPath, JSON.stringify(f) + "\n");
    // surface any message types / targets we see
    if (f?.target) seenTypes.add(`target:${f.target}`);
    const args = Array.isArray(f?.arguments) ? f.arguments : [];
    for (const a of args) {
      if (a?.messages)
        for (const m of a.messages) if (m?.messageType) seenTypes.add(`msgType:${m.messageType}`);
      // code interpreter often carries a `messageType` or a code/result payload
      for (const k of ["code", "generatedCode", "executionResult", "result", "language"]) {
        if (a && typeof a === "object" && k in a) seenTypes.add(`field:${k}`);
      }
    }
    if (f?.item?.messages)
      for (const m of f.item.messages)
        if (m?.messageType) seenTypes.add(`msgType:${m.messageType}`);
  },
});

const out = r.fullText || "";
const correct = out.toLowerCase().includes(EXPECTED);
const sawCodeFrame = [...seenTypes].some((t) =>
  /GeneratedCode|GenerateContentQuery|code|execution/i.test(t),
);

writeFileSync(
  join(OUT, "result.json"),
  JSON.stringify(
    {
      mode: CONTROL ? "control" : "codeinterp",
      secret: SECRET,
      expected: EXPECTED,
      correctDigestPresent: correct,
      sawCodeFrame,
      messageTypesAndFields: [...seenTypes].sort(),
      disengaged: r.disengaged,
      contentOrigin: r.contentOrigin,
      throttle: r.throttle,
      elapsedMs: r.elapsedMs,
      error: r.error,
      replyHead: out.slice(0, 600),
    },
    null,
    2,
  ),
);

console.log(`\n[ci] === RESULT ===`);
console.log(`[ci] frames/types seen: ${[...seenTypes].sort().join(", ") || "(none special)"}`);
console.log(`[ci] saw code-interpreter frame: ${sawCodeFrame}`);
console.log(
  `[ci] CORRECT sha256 in reply: ${correct}  ${correct ? "✅ REAL EXECUTION" : "❌ (hallucinated or refused)"}`,
);
console.log(
  `[ci] disengaged=${r.disengaged} origin=${r.contentOrigin} throttle=${JSON.stringify(r.throttle)} ${r.elapsedMs}ms ${r.error ? "ERR=" + r.error : ""}`,
);
console.log(`[ci] --- reply (first 600 chars) ---\n${out.slice(0, 600)}`);
console.log(`[ci] full frames: ${framesPath}`);
