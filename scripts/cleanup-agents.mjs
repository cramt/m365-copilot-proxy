// Cleanup: find and (optionally) delete the Copilot Studio agents this proxy
// created (`m365-tool-agent-*`) across ALL environments the user can author in.
// DRY-RUN by default — pass --delete to actually remove them.
//   M365_NO_INTERACTIVE=1 node scripts/cleanup-agents.mjs            # list only
//   M365_NO_INTERACTIVE=1 node scripts/cleanup-agents.mjs --delete   # delete
//
// Only touches bots whose shortBotName starts with "m365-tool-agent-" unless
// --all is passed (then it lists every bot but still only DELETES tool-agents).
process.env.M365_DEBUG = process.env.M365_DEBUG ?? "1";

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTokenForScope } from "../packages/core/dist/index.mjs";

const DO_DELETE = process.argv.includes("--delete");
const PP_SCOPES = ["https://api.powerplatform.com/.default"];
const BAP_SCOPES = ["https://api.bap.microsoft.com/.default"];
const BAP_API = "https://api.bap.microsoft.com";
const API_V = "api-version=2022-03-01-preview";
const AGENT_CACHE = join(homedir(), ".config", "m365-proxy", "agent-id.json");

const ppHeaders = (t) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${t}`,
  "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)",
});

const hostForEnvName = (name) => {
  const id = name.replace(/-/g, "").toLowerCase();
  return `https://${id.slice(0, -2)}.${id.slice(-2)}.environment.api.powerplatform.com`;
};

const bapToken = await getTokenForScope(BAP_SCOPES);
const ppToken = await getTokenForScope(PP_SCOPES);
if (!bapToken || !ppToken) {
  console.error("[cleanup] missing token(s)");
  process.exit(1);
}

// Enumerate every environment in the tenant.
const listRes = await fetch(
  `${BAP_API}/providers/Microsoft.BusinessAppPlatform/environments?api-version=2023-06-01`,
  { headers: { Authorization: `Bearer ${bapToken}` } },
);
const envs = listRes.ok ? ((await listRes.json()).value ?? []) : [];
console.log(`[cleanup] ${envs.length} environment(s) in tenant`);

let found = 0;
let deleted = 0;

for (const env of envs) {
  if (!env?.name) continue;
  const url = hostForEnvName(env.name);
  const display = env.properties?.displayName ?? env.name;
  let res;
  try {
    res = await fetch(`${url}/copilotstudio/minimalBots/api?${API_V}`, {
      headers: ppHeaders(ppToken),
    });
  } catch (e) {
    console.log(`  [env ${display}] host unreachable (${e.message})`);
    continue;
  }
  if (res.status !== 200) {
    console.log(`  [env ${display}] minimalBots ${res.status} — skip`);
    continue;
  }
  const bots = await res.json();
  const arr = Array.isArray(bots) ? bots : [];
  const tools = arr.filter((b) => (b.shortBotName || "").startsWith("m365-tool-agent-"));
  console.log(`  [env ${display}] ${arr.length} bot(s), ${tools.length} tool-agent(s)`);
  for (const b of arr) {
    const tag = (b.shortBotName || "").startsWith("m365-tool-agent-") ? "TOOL-AGENT" : "other";
    console.log(
      `      - ${b.shortBotName}  (${b.botId})  [${tag}]  publishedAt=${b.lastPublishedAt ?? "-"}`,
    );
  }
  for (const b of tools) {
    found++;
    if (!DO_DELETE) continue;
    const delRes = await fetch(`${url}/copilotstudio/minimalBots/api/${b.botId}?${API_V}`, {
      method: "DELETE",
      headers: ppHeaders(ppToken),
    });
    const body = delRes.ok ? "" : ` ${(await delRes.text()).slice(0, 200)}`;
    console.log(
      `      ${delRes.ok ? "DELETED" : `FAILED ${delRes.status}`} ${b.shortBotName}${body}`,
    );
    if (delRes.ok) deleted++;
  }
}

console.log(
  `\n[cleanup] tool-agents found=${found}${DO_DELETE ? ` deleted=${deleted}` : " (dry-run; pass --delete to remove)"}`,
);

if (DO_DELETE && deleted > 0 && existsSync(AGENT_CACHE)) {
  rmSync(AGENT_CACHE);
  console.log(`[cleanup] removed local agent cache ${AGENT_CACHE}`);
}
