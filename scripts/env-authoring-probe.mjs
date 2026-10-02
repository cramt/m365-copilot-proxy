// Read-only probe: decide the production agent-authoring path.
// Enumerates ALL environments (not just ~default), picks the ones that are
// Dataverse-backed (have linkedEnvironmentMetadata.instanceApiUrl), and for each:
//   (a) GET {first30}.{last2}.environment.api.powerplatform.com/copilotstudio/minimalBots/api
//       with the api.powerplatform.com token  → does the LEGACY path work here?
//   (b) GET {dataverseOrg}/api/data/v9.2/bots with a Dataverse token
//       → can we auth + list bots the way the production portal does?
// GET/HEAD only — creates nothing.
// Usage: M365_NO_INTERACTIVE=1 node scripts/env-authoring-probe.mjs
process.env.M365_DEBUG = process.env.M365_DEBUG ?? "1";

import { getTokenForScope } from "../packages/core/dist/index.mjs";

const BAP_API = "https://api.bap.microsoft.com";
const BAP_SCOPES = ["https://api.bap.microsoft.com/.default"];
const PP_SCOPES = ["https://api.powerplatform.com/.default"];

const bapToken = await getTokenForScope(BAP_SCOPES);
const ppToken = await getTokenForScope(PP_SCOPES);
console.log(`[probe] bap=${!!bapToken} pp=${!!ppToken}`);
if (!bapToken || !ppToken) process.exit(1);

const ppHeaders = (t) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${t}`,
    "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)",
});

// 1. Enumerate all environments the user can edit.
const listRes = await fetch(
    `${BAP_API}/providers/Microsoft.BusinessAppPlatform/environments?api-version=2023-06-01&$expand=properties.permissions`,
    { headers: { Authorization: `Bearer ${bapToken}` } },
);
console.log(`[probe] env list status=${listRes.status}`);
const list = await listRes.json();
const envs = list.value ?? [];
console.log(`[probe] ${envs.length} environment(s) found`);

for (const env of envs) {
    const name = env.name; // the env GUID (NOT prefixed "Default-")
    const display = env.properties?.displayName;
    const sku = env.properties?.environmentSku;
    const lem = env.properties?.linkedEnvironmentMetadata;
    const instanceApiUrl = lem?.instanceApiUrl; // e.g. https://orgXXXX.crm.dynamics.com
    const domainName = lem?.domainName;
    console.log(`\n=== ${display}  (${name})`);
    console.log(`    sku=${sku} dataverse=${instanceApiUrl ?? "(none)"} domain=${domainName ?? "-"}`);

    if (!instanceApiUrl) {
        console.log("    [skip] no Dataverse instance — cannot host a Copilot Studio bot");
        continue;
    }

    // (a) Legacy minimalBots on the per-env powerplatform host.
    const envId = name.replace(/-/g, "").toLowerCase();
    const envHost = `https://${envId.slice(0, -2)}.${envId.slice(-2)}.environment.api.powerplatform.com`;
    try {
        const r = await fetch(
            `${envHost}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`,
            { headers: ppHeaders(ppToken) },
        );
        const body = await r.text();
        console.log(`    [a] minimalBots GET ${envHost} -> ${r.status}  ${body.slice(0, 140).replace(/\n/g, " ")}`);
    } catch (e) {
        console.log(`    [a] minimalBots GET ${envHost} -> ERR ${e.message}`);
    }

    // (b) Dataverse bots list (the production portal path).
    const dvOrigin = new URL(instanceApiUrl).origin;
    const dvToken = await getTokenForScope([`${dvOrigin}/.default`]).catch((e) => null);
    if (!dvToken) {
        console.log(`    [b] Dataverse token for ${dvOrigin} -> (could not acquire)`);
        continue;
    }
    try {
        const r = await fetch(
            `${dvOrigin}/api/data/v9.2/bots?$select=botid,name,schemaname,template&$top=5`,
            { headers: { Authorization: `Bearer ${dvToken}`, Accept: "application/json" } },
        );
        const body = await r.text();
        console.log(`    [b] Dataverse bots GET ${dvOrigin} -> ${r.status}  ${body.slice(0, 200).replace(/\n/g, " ")}`);
    } catch (e) {
        console.log(`    [b] Dataverse bots GET ${dvOrigin} -> ERR ${e.message}`);
    }
}
