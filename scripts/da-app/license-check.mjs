// What Copilot / agent entitlements does this account actually have? Reads assigned
// license SKUs + service plans via Graph — directly informs whether native-agent/MCP
// tool features would be flighted for this tenant. READ-ONLY.
import { getTokenForScope, decodeJwt } from "../../packages/core/dist/index.mjs";

const token = await getTokenForScope(["https://graph.microsoft.com/.default"]);
if (!token) {
  console.log("no token");
  process.exit(1);
}
const me = decodeJwt(token);
console.log(`[lic] ${me.upn} tenant=${me.tid}`);
const g = async (u) => {
  const r = await fetch(`https://graph.microsoft.com/v1.0${u}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let b;
  try {
    b = await r.json();
  } catch {
    b = {};
  }
  return { s: r.status, b };
};

const ld = await g("/me/licenseDetails");
console.log(`\n[lic] /me/licenseDetails → ${ld.s}, ${ld.b.value?.length ?? 0} SKUs`);
const COPILOT = /copilot|m365_copilot|intelligent|agent|graph_connectors|viva|purview/i;
for (const sku of ld.b.value ?? []) {
  const plans = (sku.servicePlans ?? []).filter((p) => p.provisioningStatus === "Success");
  const hit = plans.filter((p) => COPILOT.test(p.servicePlanName));
  console.log(`  • ${sku.skuPartNumber}  (${plans.length} active plans)`);
  if (hit.length)
    console.log(`      ↳ Copilot/agent-ish: ${hit.map((p) => p.servicePlanName).join(", ")}`);
}
// Any Copilot service plan anywhere?
const all = (ld.b.value ?? []).flatMap((s) => (s.servicePlans ?? []).map((p) => p.servicePlanName));
const copilotPlans = [...new Set(all.filter((n) => /copilot/i.test(n)))];
console.log(
  `\n[lic] Copilot-named service plans present: ${copilotPlans.length ? copilotPlans.join(", ") : "NONE"}`,
);
if (ld.s >= 400) console.log("[lic] licenseDetails err:", JSON.stringify(ld.b).slice(0, 300));
