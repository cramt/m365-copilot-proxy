// After Developer Portal import, find the app in the catalog and install it for the
// current user via Graph (bypasses the headless-unfriendly Teams SPA). Then it should
// appear in Copilot as a selectable agent.
import { getTokenForScope, decodeJwt } from "../../packages/core/dist/index.mjs";

const APP_ID = "5e27c1a0-7b3d-4f2a-9c11-a1b2c3d4e5f6"; // manifest id (externalId in catalog)
const token = await getTokenForScope(["https://graph.microsoft.com/.default"]);
if (!token) {
  console.log("no graph token");
  process.exit(1);
}
const me = decodeJwt(token);
const uid = me.oid || me.sub;
console.log(`[inst] upn=${me.upn} oid=${uid}`);

const g = async (url, opts = {}) => {
  const r = await fetch(`https://graph.microsoft.com/v1.0${url}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  let body;
  try {
    body = await r.json();
  } catch {
    body = await r.text().catch(() => "");
  }
  return { status: r.status, body };
};

// 1) Find the app in the app catalog by manifest (external) id.
let cat = await g(
  `/appCatalogs/teamsApps?$filter=externalId eq '${APP_ID}'&$expand=appDefinitions`,
);
console.log(`[inst] catalog by externalId → ${cat.status}`);
let apps = cat.body?.value || [];
if (!apps.length) {
  cat = await g(
    `/appCatalogs/teamsApps?$filter=displayName eq 'Sentinel Probe'&$expand=appDefinitions`,
  );
  console.log(`[inst] catalog by displayName → ${cat.status}`);
  apps = cat.body?.value || [];
}
console.log(`[inst] catalog matches: ${apps.length}`);
for (const a of apps)
  console.log(
    `   - id=${a.id} extId=${a.externalId} dist=${a.distributionMethod} name=${a.displayName}`,
  );
if (cat.status >= 400) console.log("[inst] catalog err:", JSON.stringify(cat.body).slice(0, 400));

if (!apps.length) {
  console.log("[inst] app not in catalog yet (Developer Portal apps may not surface here). Stop.");
  process.exit(0);
}
const catalogId = apps[0].id;

// 2) Already installed?
const inst = await g(
  `/me/teamwork/installedApps?$expand=teamsApp&$filter=teamsApp/externalId eq '${APP_ID}'`,
);
console.log(`[inst] my installedApps(filter) → ${inst.status}`);

// 3) Install for me.
const add = await g(`/users/${uid}/teamwork/installedApps`, {
  method: "POST",
  body: JSON.stringify({
    "teamsApp@odata.bind": `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${catalogId}`,
  }),
});
console.log(`[inst] install POST → ${add.status}`);
console.log(JSON.stringify(add.body, null, 1).slice(0, 600));
