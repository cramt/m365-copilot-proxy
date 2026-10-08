// Borrow a live Island Gateway token from the authenticated Copilot Studio
// frontend, then probe whether the gateway sees OUR minimalBots agent and lets
// us read/write its components (the path to attaching an MCP tool).
//
// Usage: CHROMIUM_PATH=$(which chromium) node scripts/gateway-explore.mjs
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadSecrets } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "gateway-explore-out");
mkdirSync(OUT, { recursive: true });
const creds = loadSecrets();
const cache = JSON.parse(readFileSync(join(homedir(), ".config", "opencode-m365", "agent-id.json"), "utf8"));
const BOT_ID = cache.botId;
const TENANT = "fa7f56d8-49c4-4327-b816-9a0eeaa273df";
const ENV = `Default-${TENANT}`;
const GW = "https://powervamg.eu-il105.gateway.prod.island.powerapps.com";

import { pathToFileURL } from "node:url";
const ROOT = pathToFileURL(process.cwd()).href;
const pwMod = await import(`${ROOT}/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js`);
const chromium = pwMod.chromium ?? pwMod.default?.chromium;
const { TOTP } = await import(`${ROOT}/node_modules/.pnpm/otpauth@9.5.0/node_modules/otpauth/dist/otpauth.esm.js`);

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();

let gwToken = null;
let resolveToken;
const tokenReady = new Promise((r) => (resolveToken = r));
page.on("request", (req) => {
  if (gwToken) return;
  if (!/island\.powerapps\.com/i.test(req.url())) return;
  const a = req.headers()["authorization"];
  if (a) { gwToken = a.replace(/^Bearer\s+/i, ""); resolveToken(gwToken); }
});

async function login() {
  const fill = async (sel, val) => { const loc = page.locator(`${sel}:visible`).first(); await loc.waitFor({ state: "visible", timeout: 30000 }); await loc.fill(val); };
  const submit = () => page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  await fill('input[name="loginfmt"]', creds.email); await submit(); await page.waitForTimeout(2500);
  await fill('input[name="passwd"]', creds.password); await submit(); await page.waitForTimeout(2500);
  await fill('input[name="otc"]', new TOTP({ secret: creds.mfaSecret }).generate()); await submit(); await page.waitForTimeout(2500);
  try { await page.locator("#idSIButton9:visible").click({ timeout: 8000 }); } catch {}
}

const H = () => ({
  Authorization: `Bearer ${gwToken}`,
  "x-ms-client-tenant-id": TENANT,
  "x-cci-tenantid": TENANT,
  "x-cci-bapenvironmentid": ENV,
  "x-cci-cdsbotid": BOT_ID,
  "Content-Type": "application/json",
});
async function gw(method, path, body) {
  const res = await fetch(`${GW}${path}`, { method, headers: H(), ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, text };
}

try {
  await page.goto("https://copilotstudio.microsoft.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/login\.microsoftonline|\/oauth2|signin/i.test(page.url())) { console.log("[gw] login..."); await login(); }
  console.log("[gw] waiting for a gateway token...");
  await Promise.race([tokenReady, page.waitForTimeout(45000)]);
  if (!gwToken) throw new Error("no gateway token captured");
  console.log(`[gw] got gateway token (len ${gwToken.length})`);
  writeFileSync(join(OUT, "gw-token.txt"), gwToken);

  // 1) Does the gateway know our bot?
  const route = await gw("GET", `/api/botmanagement/v1/environments/${ENV}/botroutinginfo?cdsBotId=${BOT_ID}`);
  console.log(`\n[1] botroutinginfo → ${route.status}\n    ${route.text.slice(0, 400)}`);
  writeFileSync(join(OUT, "botroutinginfo.json"), route.text);

  // 2) Read its components (POST = delta read per the API doc)
  const readBody = { componentEntityTags: [], publishMetadataAndDependencyValidation: false };
  const comps = await gw("POST", `/api/botmanagement/v1/environments/${ENV}/bots/${BOT_ID}/content/botcomponents`, readBody);
  console.log(`\n[2] read botcomponents → ${comps.status}\n    ${comps.text.slice(0, 600)}`);
  writeFileSync(join(OUT, "botcomponents-read.json"), comps.text);

  // 3) List all bots the gateway sees (to learn the right shape / confirm species)
  const list = await gw("GET", `/api/botmanagement/v1/environments/${ENV}/bots`);
  console.log(`\n[3] list bots → ${list.status}\n    ${list.text.slice(0, 500)}`);
  writeFileSync(join(OUT, "bots-list.json"), list.text);

  console.log(`\n[gw] outputs in ${OUT}`);
} catch (e) { console.log("[gw] error:", e.message); }
finally { await browser.close(); }
