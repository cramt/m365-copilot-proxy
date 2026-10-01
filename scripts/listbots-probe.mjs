// Read-only probe: dump the raw Copilot Studio listBots response so we can see
// how the server reflects displayName -> shortBotName (the round-trip the
// hash-in-name versioning depends on). GET requests only — creates nothing.
// Usage: M365_NO_INTERACTIVE=1 node scripts/listbots-probe.mjs
process.env.M365_DEBUG = process.env.M365_DEBUG ?? "1";

import { getTokenForScope, getEnvironmentUrl } from "../packages/core/dist/index.mjs";

const POWERPLATFORM_SCOPES = ["https://api.powerplatform.com/.default"];
const BAP_SCOPES = ["https://api.bap.microsoft.com/.default"];

const ppHeaders = (token) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
  "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)",
});

const bapToken = await getTokenForScope(BAP_SCOPES);
const ppToken = await getTokenForScope(POWERPLATFORM_SCOPES);
console.log(`[probe] bap=${!!bapToken} pp=${!!ppToken}`);
if (!bapToken || !ppToken) process.exit(1);

const envUrl = await getEnvironmentUrl(bapToken);
console.log(`[probe] envUrl=${envUrl}`);

const res = await fetch(
  `${envUrl}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`,
  { headers: ppHeaders(ppToken) },
);
console.log(`[probe] listBots status=${res.status}`);
const bots = await res.json();
// Show the full shape of one bot, plus the name fields for all of them.
console.log("[probe] === one full bot object ===");
console.log(JSON.stringify(Array.isArray(bots) ? bots[0] : bots, null, 2));
console.log("[probe] === name fields for all bots ===");
for (const b of Array.isArray(bots) ? bots : []) {
  console.log(JSON.stringify({
    botId: b.botId,
    shortBotName: b.shortBotName,
    displayName: b.displayName,
    name: b.name,
    schemaName: b.schemaName,
  }));
}
