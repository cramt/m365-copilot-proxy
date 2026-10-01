// Read-only deep probe: can a Copilot Studio minimal agent carry a model
// binding? Pull the FULL bot definition and hunt for model/deployment fields,
// then try to discover a models-list endpoint. GETs only — mutates nothing.
// Usage: M365_NO_INTERACTIVE=1 node scripts/agent-model-probe.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTokenForScope, getEnvironmentUrl } from "../packages/core/dist/index.mjs";

process.env.M365_DEBUG = process.env.M365_DEBUG ?? "1";

const BAP_SCOPES = ["https://api.bap.microsoft.com/.default"];
const PP_SCOPES = ["https://api.powerplatform.com/.default"];
const API = "api-version=2022-03-01-preview";

const pp = (token) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
  "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)",
});

const bapToken = await getTokenForScope(BAP_SCOPES);
const ppToken = await getTokenForScope(PP_SCOPES);
if (!bapToken || !ppToken) { console.log("[probe] no tokens"); process.exit(1); }

const envUrl = await getEnvironmentUrl(bapToken);
console.log(`[probe] envUrl=${envUrl}`);

// botId from cache
const cache = JSON.parse(readFileSync(join(homedir(), ".config", "opencode-m365", "agent-id.json"), "utf-8"));
const botId = cache.botId;
console.log(`[probe] botId=${botId}`);

// Hunt for model-ish keys anywhere in a JSON object.
function findModelKeys(obj, path = "") {
  const hits = [];
  const re = /model|deployment|llm|gpt|tone|reasoning|capabilit/i;
  const walk = (o, p) => {
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        const np = p ? `${p}.${k}` : k;
        if (re.test(k)) hits.push(`${np} = ${JSON.stringify(v)?.slice(0, 120)}`);
        walk(v, np);
      }
    }
  };
  walk(obj, path);
  return hits;
}

async function get(label, url) {
  try {
    const res = await fetch(url, { headers: pp(ppToken) });
    const body = res.ok ? await res.json() : await res.text();
    console.log(`\n===== ${label} -> ${res.status} =====`);
    if (res.ok) {
      const hits = findModelKeys(body);
      console.log(hits.length ? hits.join("\n") : "(no model/deployment/llm/gpt keys found)");
    } else {
      console.log(String(body).slice(0, 200));
    }
    return res.ok ? body : null;
  } catch (e) {
    console.log(`\n===== ${label} -> ERROR ${e.message} =====`);
    return null;
  }
}

// 1) Full single-bot definition + its components.
await get("GET bot", `${envUrl}/copilotstudio/minimalBots/api/${botId}?${API}`);
await get("GET bot/components", `${envUrl}/copilotstudio/minimalBots/api/${botId}/components?${API}`);

// 2) Candidate model-list endpoints (guesses — see which resolve).
for (const ep of [
  "copilotstudio/aiModels/api",
  "copilotstudio/models/api",
  "copilotstudio/minimalBots/api/models",
  "copilotstudio/gptModels/api",
  "copilotstudio/api/aiModels",
]) {
  await get(`GET /${ep}`, `${envUrl}/${ep}?${API}`);
}
