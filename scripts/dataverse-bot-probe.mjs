// Deep dig: read the agent's FULL definition straight from Dataverse (the store
// the Studio UI actually uses) and its components, to find the model binding.
// Read-only GETs. Usage: M365_NO_INTERACTIVE=1 node scripts/dataverse-bot-probe.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTokenForScope } from "../packages/core/dist/index.mjs";

process.env.M365_DEBUG = process.env.M365_DEBUG ?? "1";

const DV = "https://org8f4d7421.crm4.dynamics.com"; // discovered from Studio network capture
const token = await getTokenForScope([`${DV}/.default`]);
if (!token) {
  console.log("no dataverse token");
  process.exit(1);
}

const botId = JSON.parse(
  readFileSync(join(homedir(), ".config", "m365-proxy", "agent-id.json"), "utf-8"),
).botId;
console.log(`[dv] botId=${botId}`);

const hdr = {
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
  "OData-MaxVersion": "4.0",
  "OData-Version": "4.0",
};
const MODEL_RE = /model|deployment|llm|gpt|reasoning|tone|publishedlanguage|aimodel/i;

async function get(label, url) {
  const res = await fetch(url, { headers: hdr });
  const body = res.ok ? await res.json() : await res.text();
  console.log(`\n===== ${label} -> ${res.status} =====`);
  return res.ok ? body : (console.log(String(body).slice(0, 300)), null);
}

// 1) List every Dataverse bot — find ours by name, and see if minimal agents
//    even appear here.
const list = await get(
  "bots list",
  `${DV}/api/data/v9.2/bots?$select=botid,name,schemaname,configuration,authenticationmode&$top=100`,
);
let realBotId = null;
if (list?.value) {
  console.log(`[dv] ${list.value.length} Dataverse bots:`);
  for (const b of list.value) {
    const mine =
      /m365-tool-agent/i.test(b.name || "") || /m365-tool-agent/i.test(b.schemaname || "");
    console.log(
      `   ${b.botid}  name=${JSON.stringify(b.name)} schema=${JSON.stringify(b.schemaname)}${mine ? "  <-- OURS" : ""}`,
    );
    if (mine) realBotId = b.botid;
  }
}

// 2) Dump all columns of one real bot (ours if found, else the first) and flag model-ish.
const target = realBotId || list?.value?.[0]?.botid;
if (target) {
  const bot = await get(`bots(${target})`, `${DV}/api/data/v9.2/bots(${target})`);
  if (bot) {
    const keys = Object.keys(bot).filter((k) => !k.startsWith("@"));
    console.log(`[dv] ${keys.length} columns. Model-ish columns:`);
    for (const k of keys)
      if (MODEL_RE.test(k)) console.log(`   ${k} = ${JSON.stringify(bot[k])?.slice(0, 200)}`);
    console.log("[dv] all columns: " + keys.join(", "));
    // components of this bot
    const comps = await get(
      "botcomponents",
      `${DV}/api/data/v9.2/botcomponents?$filter=_parentbotid_value eq ${target}&$select=name,componenttype,content`,
    );
    if (comps?.value) {
      console.log(`[dv] ${comps.value.length} components:`);
      for (const c of comps.value) {
        const hit = c.content && MODEL_RE.test(c.content);
        console.log(
          `   - ${JSON.stringify(c.name)} type=${c.componenttype}${hit ? "  <-- mentions model" : ""}`,
        );
        if (hit) {
          const frags = [
            ...String(c.content).matchAll(
              /"([^"]*(?:model|deployment|gpt|reasoning|tone|aimodel)[^"]*)"\s*:\s*("[^"]{0,80}"|[\w.-]{0,40})/gi,
            ),
          ].map((m) => `${m[1]}=${m[2]}`);
          console.log("       " + [...new Set(frags)].slice(0, 20).join("\n       "));
        }
      }
    }
  }
}

// 3) The model catalog table.
const models = await get("msdyn_aimodels", `${DV}/api/data/v9.2/msdyn_aimodels?$top=50`);
if (models?.value) {
  console.log(`[dv] ${models.value.length} msdyn_aimodels rows:`);
  for (const m of models.value) {
    const name = m.msdyn_name || m.msdyn_modelname || m.name;
    console.log(`   ${JSON.stringify(name)}`);
  }
  if (models.value[0])
    console.log(
      "[dv] aimodel columns: " +
        Object.keys(models.value[0])
          .filter((k) => !k.startsWith("@"))
          .join(", "),
    );
}
