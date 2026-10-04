// H-NATIVE-1 gate probe: what can we actually do toward sideloading a declarative
// agent with a custom action? Mints a Graph token via the repo auth, decodes its
// scopes, checks admin/identity, and inspects the Teams app-catalog + sideload
// policy. READ-ONLY (no upload here) so it's safe to run repeatedly.
import { getTokenForScope, decodeJwt } from "../../packages/core/dist/index.mjs";

const SCOPE_SETS = [
  ["https://graph.microsoft.com/.default"],
  ["https://graph.microsoft.com/AppCatalog.ReadWrite.All", "https://graph.microsoft.com/User.Read"],
];

let token = null,
  usedScopes = null;
for (const s of SCOPE_SETS) {
  try {
    const t = await getTokenForScope(s);
    if (t) {
      token = t;
      usedScopes = s;
      break;
    }
  } catch (e) {
    console.log(`[gate] scope ${s.join(",")} failed: ${e.message}`);
  }
}
if (!token) {
  console.log("[gate] could not mint any Graph token");
  process.exit(1);
}

const claims = decodeJwt(token);
console.log(`[gate] token minted via scopes: ${usedScopes.join(", ")}`);
console.log(
  `[gate] aud=${claims.aud}  appid=${claims.appid || claims.azp}  upn=${claims.upn || claims.unique_name}`,
);
console.log(`[gate] granted scp: ${claims.scp || "(none)"}`);
console.log(`[gate] roles: ${JSON.stringify(claims.roles || claims.wids || "(none)")}`);

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

const checks = {
  me: await g("/me?$select=displayName,userPrincipalName,id"),
  org: await g("/organization?$select=displayName,id"),
  roles: await g("/me/memberOf/microsoft.graph.directoryRole?$select=displayName,roleTemplateId"),
  appSettings: await g("/teamwork/teamsAppSettings"),
  catalogList: await g(
    "/appCatalogs/teamsApps?$filter=distributionMethod eq 'organization'&$top=3&$select=id,displayName,externalId",
  ),
};

for (const [k, v] of Object.entries(checks)) {
  console.log(`\n[gate] === ${k} → HTTP ${v.status} ===`);
  console.log(JSON.stringify(v.body, null, 1).slice(0, 900));
}
