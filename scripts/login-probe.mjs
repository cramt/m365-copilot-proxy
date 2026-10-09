// Isolated headless login probe. Never opens browser tabs (M365_NO_INTERACTIVE).
// Usage: M365_DEBUG=1 node scripts/login-probe.mjs [--force]
process.env.M365_DEBUG = process.env.M365_DEBUG ?? "1";
process.env.M365_NO_INTERACTIVE = "1";

import { loadSecrets, loginAutomated, getTokenSilent } from "../packages/core/dist/index.mjs";

const force = process.argv.includes("--force");

const silent = await getTokenSilent();
console.log(`[probe] silent token: ${silent ? `OK (${silent.length} chars)` : "null"}`);

if (silent && !force) {
  console.log("[probe] silent works — pass --force to exercise the browser login anyway");
  process.exit(0);
}

const secrets = loadSecrets();
if (!secrets) {
  console.log("[probe] no secrets.json — cannot test automated login");
  process.exit(1);
}

console.log("[probe] running headless automated login...");
try {
  const token = await loginAutomated(secrets.email, secrets.password, secrets.mfaSecret);
  console.log(
    `[probe] AUTOMATED LOGIN OK — ${token.length} chars, starts ${token.slice(0, 12)}...`,
  );
  process.exit(0);
} catch (e) {
  console.log(`[probe] AUTOMATED LOGIN FAILED: ${e.message}`);
  process.exit(2);
}
