// Hunt for a REST endpoint that exposes token usage / context-window limits
// for M365 Copilot. We have three tokens already (Sydney, PowerPlatform, BAP).
// Try plausible URLs against each; record status + first 800 chars of body.
// Read-only — GETs only. Run unsandboxed.
//
// Usage: M365_NO_INTERACTIVE=1 node scripts/usage-endpoint-hunt.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTokenForScope, getToken, decodeJwt, getEnvironmentUrl } from "../packages/core/dist/index.mjs";

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "usage-endpoint-out", TS);
mkdirSync(OUT, { recursive: true });

const sydney = await getToken();
const claims = decodeJwt(sydney);
const tid = claims.tid;
const oid = claims.oid;

const pp = await getTokenForScope(["https://api.powerplatform.com/.default"]).catch(() => null);
const bap = await getTokenForScope(["https://api.bap.microsoft.com/.default"]).catch(() => null);

console.log(`[hunt] sydney=${!!sydney} pp=${!!pp} bap=${!!bap}`);
console.log(`[hunt] tid=${tid} oid=${oid}`);

// --- Discover the env URL via BAP (shared with agent.ts).
const envUrl = bap ? await getEnvironmentUrl(bap).catch(() => null) : null;
console.log(`[hunt] envUrl=${envUrl}`);

// --- Endpoints to probe. Pair each with the most plausible token.
// Tags: `usage` = looks for token/message counts, `limits` = context-window
// type limits, `model` = available models/tones, `meta` = environment meta.
const candidates = [
  // Sydney (substrate.office.com) — the chat host. Try GET on the chat hub
  // base + plausible sibling REST paths.
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/me/usage", "usage"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/usage", "usage"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/me/license", "limits"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/me", "meta"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/quota", "limits"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/conversations", "meta"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/models", "model"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/UsageMetrics", "usage"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v2/me", "meta"],
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/limits", "limits"],
  ["sydney", "GET", "https://substrate.office.com/sydney/api/usage", "usage"],
  ["sydney", "GET", "https://substrate.office.com/sydney/m365copilot/usage", "usage"],
  ["sydney", "GET", "https://substrate.office.com/sydney/m365copilot/limits", "limits"],
  ["sydney", "GET", "https://substrate.office.com/sydney/m365copilot/tones", "model"],
  // Substrate sibling endpoints (some real ones live under /api/v1 too)
  ["sydney", "GET", "https://substrate.office.com/sydney/v1/me/conversations", "meta"],
];

if (pp && envUrl) {
  candidates.push(
    ["pp", "GET", `${envUrl}/analytics/api/conversations?api-version=2022-03-01-preview`, "usage"],
    ["pp", "GET", `${envUrl}/analytics/api/usage?api-version=2022-03-01-preview`, "usage"],
    ["pp", "GET", `${envUrl}/copilotstudio/analytics/api?api-version=2022-03-01-preview`, "usage"],
    ["pp", "GET", `${envUrl}/copilotstudio/usage/api?api-version=2022-03-01-preview`, "usage"],
    ["pp", "GET", `${envUrl}/copilotstudio/aiModels/api?api-version=2022-03-01-preview`, "model"],
    ["pp", "GET", `${envUrl}/copilotstudio/api/metering?api-version=2022-03-01-preview`, "usage"],
  );
}

if (bap) {
  candidates.push(
    ["bap", "GET", `https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/listConsumption?api-version=2023-06-01`, "usage"],
    ["bap", "GET", `https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/me?api-version=2023-06-01`, "meta"],
    ["bap", "GET", `https://api.bap.microsoft.com/providers/PowerPlatform.Governance/copilot/usage?api-version=2023-06-01`, "usage"],
  );
}

const tokensByTag = { sydney, pp, bap };
const results = [];

for (const [tag, method, url, kind] of candidates) {
  const tok = tokensByTag[tag];
  if (!tok) {
    console.log(`[skip] (no ${tag} token) ${url}`);
    continue;
  }
  try {
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" } });
    const ct = r.headers.get("content-type") ?? "";
    const body = await r.text().catch(() => "");
    const ok = r.status >= 200 && r.status < 300;
    const interesting = ok || (r.status >= 400 && r.status !== 404 && r.status !== 401 && r.status !== 403);
    console.log(`[${tag}] ${method} ${r.status} ${url} ${interesting ? "  <- LOOK" : ""}`);
    results.push({ tag, method, url, kind, status: r.status, contentType: ct, body: body.slice(0, 800) });
  } catch (e) {
    console.log(`[${tag}] ${method} ERR  ${url} (${e.message})`);
    results.push({ tag, method, url, kind, error: e.message });
  }
}

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n[done] ${results.length} endpoints probed. ${OUT}/results.json`);

// Highlight the non-404/non-403 successes
const winners = results.filter((r) => r.status && r.status >= 200 && r.status < 400);
console.log(`\n[winners] ${winners.length} 2xx/3xx`);
for (const w of winners) console.log(`  ${w.status} ${w.method} ${w.url}`);
