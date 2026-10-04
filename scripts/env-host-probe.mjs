// Read-only probe: dump the BAP "~default" environment object so we can see the
// REAL Power Platform API host for this tenant (production tenants are NOT on the
// `.df.` dogfood ring, and the host can't be reconstructed by splitting the GUID).
// We print properties.runtimeEndpoints (the authoritative per-service hostnames)
// plus a few likely host fields, then HEAD-probe the powerplatform endpoint.
// GET/HEAD only — creates nothing.
// Usage: M365_NO_INTERACTIVE=1 node scripts/env-host-probe.mjs
process.env.M365_DEBUG = process.env.M365_DEBUG ?? "1";

import { getTokenForScope } from "../packages/core/dist/index.mjs";

const POWERPLATFORM_SCOPES = ["https://api.powerplatform.com/.default"];
const BAP_SCOPES = ["https://api.bap.microsoft.com/.default"];
const BAP_API = "https://api.bap.microsoft.com";

const bapToken = await getTokenForScope(BAP_SCOPES);
const ppToken = await getTokenForScope(POWERPLATFORM_SCOPES);
console.log(`[probe] bap=${!!bapToken} pp=${!!ppToken}`);
if (!bapToken || !ppToken) process.exit(1);

const envRes = await fetch(
  `${BAP_API}/providers/Microsoft.BusinessAppPlatform/environments/~default?api-version=2023-06-01`,
  { headers: { Authorization: `Bearer ${bapToken}` } },
);
console.log(`[probe] env GET status=${envRes.status}`);
const env = await envRes.json();

console.log("[probe] env.name =", env.name);
console.log("[probe] properties.runtimeEndpoints =");
console.log(JSON.stringify(env.properties?.runtimeEndpoints ?? null, null, 2));

// Other fields that sometimes carry the API host / friendly domain.
console.log("[probe] likely host fields:");
for (const path of [
  "properties.azureRegion",
  "properties.environmentSku",
  "properties.linkedEnvironmentMetadata.domainName",
  "properties.linkedEnvironmentMetadata.instanceApiUrl",
  "properties.linkedEnvironmentMetadata.instanceUrl",
]) {
  const val = path.split(".").reduce((o, k) => (o == null ? o : o[k]), env);
  if (val !== undefined) console.log(`  ${path} = ${JSON.stringify(val)}`);
}

// The powerplatform API host lives under runtimeEndpoints["microsoft.PowerApps"]
// region or is itself listed. Derive the powerplatform.com host if present.
const eps = env.properties?.runtimeEndpoints ?? {};
const ppHost = Object.values(eps).find(
  (u) => typeof u === "string" && u.includes("environment.api.powerplatform.com"),
);
console.log("[probe] powerplatform host from runtimeEndpoints =", ppHost ?? "(none found)");

if (ppHost) {
  const origin = new URL(ppHost).origin;
  const head = await fetch(
    `${origin}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`,
    { method: "HEAD", headers: { Authorization: `Bearer ${ppToken}` } },
  ).catch((e) => ({ ok: false, status: `ERR ${e.message}` }));
  console.log(`[probe] HEAD ${origin} -> status=${head.status}`);
}

// --- Probe real minimalBots hosts (the authoring API may live on the PVA gateway
// or a regional powerplatform host rather than the (absent) environment host) ---
const envId2 = env.name
  .replace(/^Default-/i, "")
  .replace(/-/g, "")
  .toLowerCase();
const pva = env.properties?.runtimeEndpoints?.["microsoft.PowerVirtualAgents"];
const hostCandidates = [
  pva && new URL(pva).origin,
  "https://unitedstates.api.powerplatform.com",
  "https://api.powerplatform.com",
  `https://${envId2.slice(0, -2)}.${envId2.slice(-2)}.environment.api.powerplatform.com`,
].filter(Boolean);
const ppHeaders = (t) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${t}`,
  "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)",
});
for (const origin of hostCandidates) {
  for (const tok of [["pp", ppToken]]) {
    try {
      const r = await fetch(
        `${origin}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`,
        { headers: ppHeaders(tok[1]) },
      );
      const body = await r.text();
      console.log(
        `[probe] GET ${origin} (${tok[0]}) -> ${r.status}  ${body.slice(0, 160).replace(/\n/g, " ")}`,
      );
    } catch (e) {
      console.log(`[probe] GET ${origin} (${tok[0]}) -> ERR ${e.message}`);
    }
  }
}

// --- Full body from the global powerplatform API to learn the canonical route ---
{
  const r = await fetch(
    `https://api.powerplatform.com/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`,
    { headers: ppHeaders(ppToken) },
  );
  console.log(`[full] api.powerplatform.com status=${r.status}`);
  console.log("[full] body:", (await r.text()).slice(0, 600));
}
// token tenant id (for path-scoped routes)
try {
  const claims = JSON.parse(Buffer.from(`${ppToken.split(".")[1]}==`, "base64").toString());
  console.log("[full] token tid=", claims.tid, " aud=", claims.aud);
} catch (error) {
  void error;
}
