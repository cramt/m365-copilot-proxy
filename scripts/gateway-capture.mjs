// Capture the Island Gateway URL + the TOKEN RESOURCE the real Copilot Studio
// frontend uses, by driving copilotstudio.microsoft.com and reading the
// Authorization header (decode JWT `aud`) off its gateway calls. Unblocks the
// MCP-tool path (we need to know which token to acquire + the gateway host).
//
// Usage: CHROMIUM_PATH=$(which chromium) node scripts/gateway-capture.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSecrets } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "gateway-capture-out");
mkdirSync(OUT, { recursive: true });
const creds = loadSecrets();
if (!creds) { console.log("no secrets"); process.exit(1); }

import { pathToFileURL } from "node:url";
const ROOT = pathToFileURL(process.cwd()).href;
const pwMod = await import(`${ROOT}/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js`);
const chromium = pwMod.chromium ?? pwMod.default?.chromium;
const { TOTP } = await import(`${ROOT}/node_modules/.pnpm/otpauth@9.5.0/node_modules/otpauth/dist/otpauth.esm.js`);

function jwtAud(auth) {
  try { const t = auth.replace(/^Bearer\s+/i, ""); const p = JSON.parse(Buffer.from(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/") + "==", "base64").toString()); return { aud: p.aud, appid: p.appid, scp: p.scp }; } catch { return null; }
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();

const gatewayCalls = new Map(); // url-path -> {method, aud, appid}
const interesting = /island\.powerapps\.com|powervamg|botmanagement|gateway\.prod/i;

page.on("request", (req) => {
  const u = req.url();
  if (!interesting.test(u)) return;
  const auth = req.headers()["authorization"];
  const key = req.method() + " " + u.split("?")[0];
  if (!gatewayCalls.has(key)) {
    gatewayCalls.set(key, { method: req.method(), url: u.split("?")[0], host: new URL(u).host, ...(auth ? { token: jwtAud(auth) } : { token: null }) });
    console.log(`[gw] ${key}\n     host=${new URL(u).host} aud=${auth ? JSON.stringify(jwtAud(auth)) : "(no auth hdr)"}`);
  }
});

async function login() {
  const fill = async (sel, val) => { const loc = page.locator(`${sel}:visible`).first(); await loc.waitFor({ state: "visible", timeout: 30000 }); await loc.fill(val); };
  const submit = () => page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  await fill('input[name="loginfmt"]', creds.email); await submit(); await page.waitForTimeout(2500);
  await fill('input[name="passwd"]', creds.password); await submit(); await page.waitForTimeout(2500);
  await fill('input[name="otc"]', new TOTP({ secret: creds.mfaSecret }).generate()); await submit(); await page.waitForTimeout(2500);
  try { await page.locator("#idSIButton9:visible").click({ timeout: 8000 }); } catch {}
}

try {
  console.log("[gw] navigating to Copilot Studio...");
  await page.goto("https://copilotstudio.microsoft.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/login\.microsoftonline|\/oauth2|signin/i.test(page.url())) { console.log("[gw] login..."); await login(); }
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(6000);
  // Click into "Agents" to trigger more gateway calls
  for (const sel of ['text=/agents/i', 'text=/create/i']) {
    try { await page.locator(sel).first().click({ timeout: 5000 }); await page.waitForTimeout(5000); } catch {}
  }
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
} catch (e) { console.log("[gw] err", e.message); }
finally {
  writeFileSync(join(OUT, "gateway-calls.json"), JSON.stringify([...gatewayCalls.values()], null, 2));
  const hosts = [...new Set([...gatewayCalls.values()].map(c => c.host))];
  const auds = [...new Set([...gatewayCalls.values()].map(c => c.token?.aud).filter(Boolean))];
  console.log(`\n[gw] === SUMMARY ===`);
  console.log(`[gw] gateway hosts: ${hosts.join(", ") || "(none captured)"}`);
  console.log(`[gw] token audiences: ${auds.join(", ") || "(none)"}`);
  console.log(`[gw] ${gatewayCalls.size} distinct gateway calls → ${join(OUT, "gateway-calls.json")}`);
  await browser.close();
}
