// H-NATIVE-1 sideload attempt #2: Teams Developer Portal (dev.teams.microsoft.com)
// is more automation-friendly than Teams v2 and can import an app package + preview
// it in Copilot. Uses a real desktop UA (Teams v2 reset our headless client) and
// persists the logged-in session to scripts/da-app/state.json for reuse.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadSecrets } from "../../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "da-app", "gui-out");
mkdirSync(OUT, { recursive: true });
const ZIP = join(process.cwd(), "scripts", "da-app", "sentinel-agent.zip");
const STATE = join(process.cwd(), "scripts", "da-app", "state.json");
const creds = loadSecrets();
if (!creds) { console.log("no secrets"); process.exit(1); }

import { pathToFileURL } from "node:url";
const ROOT = pathToFileURL(process.cwd()).href;
const pwMod = await import(`${ROOT}/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js`);
const chromium = pwMod.chromium ?? pwMod.default?.chromium;
const { TOTP } = await import(`${ROOT}/node_modules/.pnpm/otpauth@9.5.0/node_modules/otpauth/dist/otpauth.esm.js`);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const shot = async (page, name) => { await page.screenshot({ path: join(OUT, name + ".png") }).catch(() => {}); console.log(`[shot] ${name}`); };
const dump = async (page, name) => { const t = await page.evaluate(() => document.body?.innerText?.slice(0, 1800) || "").catch(() => ""); writeFileSync(join(OUT, name + ".txt"), `URL: ${page.url()}\n\n${t}`); return t; };

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 900 }, storageState: existsSync(STATE) ? STATE : undefined });
const page = await ctx.newPage();

async function login() {
  const fill = async (sel, val) => { const loc = page.locator(`${sel}:visible`).first(); await loc.waitFor({ state: "visible", timeout: 30000 }); await loc.fill(val); };
  const submit = () => page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  try { await fill('input[name="loginfmt"]', creds.email); await submit(); await page.waitForTimeout(2500); } catch {}
  try { await fill('input[name="passwd"]', creds.password); await submit(); await page.waitForTimeout(2500); } catch {}
  try { await fill('input[name="otc"]', new TOTP({ secret: creds.mfaSecret }).generate()); await submit(); await page.waitForTimeout(2500); } catch {}
  try { await page.locator("#idSIButton9:visible").click({ timeout: 8000 }); } catch {}
}

async function clickByText(re, timeout = 6000) {
  const loc = page.getByRole("button", { name: re }).first();
  try { await loc.waitFor({ state: "visible", timeout }); await loc.click(); return true; } catch {}
  const t = page.getByText(re).first();
  try { await t.waitFor({ state: "visible", timeout: 3000 }); await t.click(); return true; } catch { return false; }
}

try {
  console.log("[dp] opening Teams Developer Portal apps...");
  const resp = await page.goto("https://dev.teams.microsoft.com/apps", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(e => { console.log("[dp] goto err:", e.message); return null; });
  await page.waitForTimeout(4000);
  if (/login\.microsoftonline|oauth2|signin|\/login/i.test(page.url())) { console.log("[dp] login..."); await login(); await page.waitForTimeout(6000); }
  await page.context().storageState({ path: STATE }).catch(() => {});
  console.log("[dp] url:", page.url(), "status:", resp?.status());
  await shot(page, "dp-01-apps");
  const t1 = await dump(page, "dp-01-apps");

  // Import an app package.
  const importClicked = await clickByText(/Import app|Import an existing app|Import/i, 8000);
  console.log("[dp] Import clicked:", importClicked);
  await page.waitForTimeout(1500);
  let uploaded = false;
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 6000 }).catch(() => null),
      (async () => { const fi = page.locator('input[type="file"]').first(); if (await fi.count()) { await fi.setInputFiles(ZIP); uploaded = true; } })(),
    ]);
    if (chooser && !uploaded) { await chooser.setInputFiles(ZIP); uploaded = true; }
  } catch (e) { console.log("[dp] import file err:", e.message); }
  console.log("[dp] uploaded:", uploaded);
  await page.waitForTimeout(6000);
  await shot(page, "dp-02-imported");
  const t2 = await dump(page, "dp-02-imported");

  // Try "Preview in Teams"/"Preview in Copilot" to install for the user.
  const preview = await clickByText(/Preview in Copilot|Preview in Teams|Preview/i, 8000);
  console.log("[dp] Preview clicked:", preview);
  await page.waitForTimeout(8000);
  await shot(page, "dp-03-preview");
  await dump(page, "dp-03-preview");

  const gated = /isn'?t available|not allowed|contact your admin|don'?t have permission|blocked by your organization/i.test(t1 + t2);
  console.log(`\n[dp] === SUMMARY === importClicked=${importClicked} uploaded=${uploaded} preview=${preview} gated=${gated}`);
} catch (e) { console.log("[dp] ERR", e.message); await shot(page, "dp-99-error"); }
await browser.close();
