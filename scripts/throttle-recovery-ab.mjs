// H-R1 decider: does a FRESH login token clear account-level (thread-rate)
// throttle, or is recovery purely time/identity-driven?
//
// Design — within-episode two-token control (the strong version):
//   Hold token_OLD (current cache) AND token_NEW (a fresh full login). Both
//   carry the SAME oid, so if throttle is identity-keyed they share one bucket.
//   While the account is degraded, alternate trivial "pong" probes between the
//   two tokens on a fixed cadence and watch WHICH token starts returning first.
//     - both recover on ~the same tick  => token-independent (H-R1 CONFIRMED:
//       re-auth does nothing the idle wait wasn't already doing).
//     - NEW returns clean while OLD still empties at the same timestamps
//       => the token really is the lever (H-R1 REJECTED — keep auto-reauth).
//
// Precondition: the account must actually be DEGRADED, or every probe returns
// clean at round 0 and you learn nothing. The script confirms degradation first
// and refuses to draw a conclusion from a rested account. Use --induce=N to
// force degradation on demand (burns N threads — mind the quota).
//
// Usage (inside nix develop, unsandboxed):
//   node scripts/throttle-recovery-ab.mjs [--induce=0] [--rounds=12] [--gap=45]
//        [--newtoken=login|silent] [--no-new]
//
//   --induce=N     fire N back-to-back fresh threads to trigger thread-rate
//                  throttle before measuring (default 0 = assume degraded).
//   --rounds=K     alternating A/B rounds (default 12).
//   --gap=SEC      seconds between probes (default 45 — gentle, avoids re-degrading).
//   --newtoken=    how to mint token_NEW: `login` (full Playwright login, faithful
//                  to F13's claim; default) or `silent` (cheap forceRefresh).
//   --no-new       skip token_NEW; just chart the OLD token's natural recovery curve.
//
// Output: NDJSON of every probe → scripts/throttle-recovery-out/run-<ts>.ndjson
// plus a printed per-token recovery summary + a verdict.

import {
  getTokenSilent,
  loginAutomated,
  loadSecrets,
  decodeJwt,
} from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const INDUCE = Number(args.induce ?? 0);
const ROUNDS = Number(args.rounds ?? 12);
const GAP_MS = Number(args.gap ?? 45) * 1000;
const NEWTOKEN = args["no-new"] ? "none" : (args.newtoken ?? "login");

const OUT_DIR = join(process.cwd(), "scripts", "throttle-recovery-out");
mkdirSync(OUT_DIR, { recursive: true });
const OUT = join(OUT_DIR, `run-${Date.now()}.ndjson`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();

// decodeJwt() runs the payload through a Zod schema that keeps only oid/tid, so
// read iat/exp/uti straight off the raw payload for the diagnostic log lines.
function rawClaims(token) {
  const p = token.split(".")[1];
  return JSON.parse(Buffer.from(p + "=".repeat((4 - (p.length % 4)) % 4), "base64").toString());
}
function rec(obj) {
  const line = { t: stamp(), ...obj };
  appendFileSync(OUT, `${JSON.stringify(line)}\n`);
  return line;
}

// A "throttle-shaped empty": no usable text and NOT a content Disengage.
// (Disengaged is content-specific, not account throttle — exclude it.)
function isThrottleEmpty(r) {
  const text = (r.fullText || "").trim();
  return !r.disengaged && text.length < 3;
}

async function probe(label, token, claims) {
  const r = await oneTurn({
    token,
    claims,
    agentId: null,
    text: "Reply with exactly the word: pong",
    timeoutMs: 60000,
  });
  const empty = isThrottleEmpty(r);
  const clean = !empty && !r.disengaged && /pong/i.test(r.fullText || "");
  const line = rec({
    kind: "probe",
    label,
    empty,
    clean,
    disengaged: r.disengaged,
    reply: (r.fullText || "").slice(0, 40),
    throttle: r.throttle,
    elapsedMs: r.elapsedMs,
    msgTypes: r.messageTypes,
  });
  console.log(
    `  [${label}] ${clean ? "CLEAN" : empty ? "empty" : r.disengaged ? "DISENGAGED" : "other"}` +
      ` reply=${JSON.stringify(line.reply)} throttle=${JSON.stringify(r.throttle)} ${r.elapsedMs}ms`,
  );
  return line;
}

console.log(`H-R1 throttle-recovery A/B — out: ${OUT}`);
console.log(`  induce=${INDUCE} rounds=${ROUNDS} gap=${GAP_MS / 1000}s newtoken=${NEWTOKEN}\n`);

const tokenOld = await getTokenSilent();
if (!tokenOld) {
  console.log("No cached token (silent returned null). Auth first.");
  process.exit(1);
}
const claimsOld = decodeJwt(tokenOld);
const rawOld = rawClaims(tokenOld);
console.log(
  `token_OLD: oid=${claimsOld.oid?.slice(0, 8)} ttl=${Math.round((rawOld.exp - rawOld.iat) / 60)}min uti=${rawOld.uti}`,
);

// --- optional: induce thread-rate degradation ---
if (INDUCE > 0) {
  console.log(`\nInducing degradation: ${INDUCE} back-to-back fresh threads...`);
  let empties = 0;
  for (let i = 0; i < INDUCE; i++) {
    const r = await probe(`induce-${i + 1}`, tokenOld, claimsOld);
    if (r.empty) empties++;
    await sleep(1500); // fast, to spend the thread budget
  }
  console.log(`Induce done: ${empties}/${INDUCE} empty.\n`);
}

// --- confirm we're actually degraded before measuring ---
console.log("Confirming degradation state (probe on OLD token)...");
const confirm = await probe("confirm", tokenOld, claimsOld);
if (confirm.clean) {
  console.log(
    "\n⚠️  Account is NOT degraded right now (OLD token returned a clean pong).\n" +
      "    An A/B on a rested account is meaningless (everything recovers at round 0).\n" +
      "    Rerun when the account is degraded, or pass --induce=N to force it (burns N threads).",
  );
  rec({ kind: "verdict", verdict: "NOT_DEGRADED", note: "aborted before A/B" });
  process.exit(0);
}
console.log("Confirmed degraded (OLD token empties). Proceeding to A/B.\n");

// --- mint token_NEW (the thing F13 credits with recovery) ---
let tokenNew = null,
  claimsNew = null;
if (NEWTOKEN !== "none") {
  const secrets = loadSecrets();
  if (!secrets) {
    console.log("No secrets.json — cannot mint token_NEW. Use --no-new.");
    process.exit(1);
  }
  console.log(`Minting token_NEW via ${NEWTOKEN}...`);
  const t0 = Date.now();
  // Faithful to F13: a full fresh login. (silent path would just return the
  // cached token on most stacks, which isn't a "fresh" token.)
  tokenNew = await loginAutomated(secrets.email, secrets.password, secrets.mfaSecret);
  claimsNew = decodeJwt(tokenNew);
  const rawNew = rawClaims(tokenNew);
  console.log(
    `token_NEW minted in ${Date.now() - t0}ms: oid=${claimsNew.oid?.slice(0, 8)} uti-differs=${rawNew.uti !== rawOld.uti}`,
  );
  if (claimsNew.oid !== claimsOld.oid)
    console.log("  ⚠️ oid differs — different identity, comparison void.");
  rec({
    kind: "newtoken",
    method: NEWTOKEN,
    sameOid: claimsNew.oid === claimsOld.oid,
    utiDiffers: rawNew.uti !== rawOld.uti,
    ttlMin: Math.round((rawNew.exp - rawNew.iat) / 60),
  });
}

// --- the alternating A/B ---
const firstClean = { OLD: null, NEW: null };
console.log(`\nA/B: ${ROUNDS} rounds, ${GAP_MS / 1000}s between probes.\n`);
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`round ${round}/${ROUNDS} @ ${stamp()}`);

  const oldLine = await probe("OLD", tokenOld, claimsOld);
  rec({ kind: "round", round, token: "OLD", clean: oldLine.clean });
  if (oldLine.clean && firstClean.OLD === null) firstClean.OLD = round;
  await sleep(GAP_MS);

  if (tokenNew) {
    const newLine = await probe("NEW", tokenNew, claimsNew);
    rec({ kind: "round", round, token: "NEW", clean: newLine.clean });
    if (newLine.clean && firstClean.NEW === null) firstClean.NEW = round;
    await sleep(GAP_MS);
  }

  // Early exit once both (or the only) token(s) have recovered.
  const done = tokenNew
    ? firstClean.OLD !== null && firstClean.NEW !== null
    : firstClean.OLD !== null;
  if (done) {
    console.log("Both tokens recovered — stopping early.");
    break;
  }
}

// --- verdict ---
console.log("\n=== RESULT ===");
console.log(
  `first CLEAN round — OLD: ${firstClean.OLD ?? "never"}` +
    (tokenNew ? `  NEW: ${firstClean.NEW ?? "never"}` : ""),
);
let verdict;
if (!tokenNew) {
  verdict = "BASELINE_ONLY";
  console.log(
    `OLD-token natural recovery at round ${firstClean.OLD ?? `>${ROUNDS}`}. (No NEW token; run without --no-new to compare.)`,
  );
} else if (firstClean.OLD === null && firstClean.NEW === null) {
  verdict = "INCONCLUSIVE_NEITHER_RECOVERED";
  console.log("Neither token recovered within the window — extend --rounds/--gap and rerun.");
} else if (
  firstClean.NEW !== null &&
  (firstClean.OLD === null || firstClean.NEW <= firstClean.OLD - 2)
) {
  verdict = "H-R1_REJECTED_TOKEN_IS_LEVER";
  console.log(
    "NEW recovered clearly before OLD → the fresh token IS the lever. Auto-reauth is justified.",
  );
} else {
  verdict = "H-R1_CONFIRMED_TOKEN_IRRELEVANT";
  console.log("OLD and NEW recovered together → recovery is time/identity-driven, NOT the token.");
  console.log("Auto-reauth provides no throttle benefit; the loud login is pure downside.");
}
rec({ kind: "verdict", verdict, firstClean });
console.log(`\nverdict=${verdict}\nraw: ${OUT}`);
