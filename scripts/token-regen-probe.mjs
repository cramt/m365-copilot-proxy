// Science: what happens when we KILL the cached token and regenerate it?
// Tests (a) robustness — does auth self-heal from an empty cache? — and (b) the
// hypothesis that a fresh token clears account-level throttling (vs throttle
// being token-independent).
//
// Modes (each run as its own process so M365_CACHE_FILE applies cleanly):
//   baseline   — getTokenSilent against whatever cache M365_CACHE_FILE points to;
//                decode + print claims. Use with the REAL cache.
//   cold       — getToken with an EMPTY/throwaway cache → forces full
//                regeneration (silent fails → automated browser login). Times it,
//                decodes the new token, then does ONE cheap chat to confirm the
//                token works AND reads the throttle counter.
//
// Usage:
//   M365_NO_INTERACTIVE=1 node scripts/token-regen-probe.mjs baseline
//   M365_NO_INTERACTIVE=1 M365_CACHE_FILE=/tmp/cold.json CHROMIUM_PATH=$(which chromium) \
//     node scripts/token-regen-probe.mjs cold
import { getToken, getTokenSilent, decodeJwt } from "../packages/core/dist/index.mjs";

const MODE = process.argv[2] || "baseline";

function claims(t) {
  const p = JSON.parse(
    Buffer.from(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
  );
  return {
    iat: p.iat,
    exp: p.exp,
    aud: p.aud,
    appid: p.appid,
    tid: p.tid?.slice(0, 8),
    oid: p.oid?.slice(0, 8),
    scp: p.scp,
    len: t.length,
    ttl_min: Math.round((p.exp - p.iat) / 60),
    uti: p.uti,
  };
}

if (MODE === "baseline") {
  const t0 = Date.now();
  const t = await getTokenSilent();
  if (!t) {
    console.log("BASELINE: silent returned NULL (no valid cache)");
    process.exit(0);
  }
  console.log(`BASELINE silent: ok ${Date.now() - t0}ms`);
  console.log(`  claims: ${JSON.stringify(claims(t))}`);
} else if (MODE === "cold") {
  const t0 = Date.now();
  let t;
  try {
    t = await getToken();
  } catch (e) {
    console.log(`COLD: regeneration FAILED — ${e.message}`);
    process.exit(1);
  }
  const ms = Date.now() - t0;
  console.log(`COLD regen: ok ${ms}ms  (browser-login=${ms > 5000})`);
  console.log(`  claims: ${JSON.stringify(claims(t))}`);
  // Confirm the fresh token actually works + read throttle state.
  try {
    const { oneTurn } = await import("./_probe-chat.mjs");
    const r = await oneTurn({
      token: t,
      claims: decodeJwt(t),
      agentId: null,
      text: "Reply with exactly the word: pong",
      timeoutMs: 60000,
    });
    console.log(
      `  fresh-token chat: reply=${JSON.stringify((r.fullText || "(empty)").slice(0, 40))} throttle=${JSON.stringify(r.throttle)} disengaged=${r.disengaged} ${r.elapsedMs}ms`,
    );
  } catch (e) {
    console.log(`  fresh-token chat ERROR: ${e.message}`);
  }
}
