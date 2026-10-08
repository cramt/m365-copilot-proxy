// H-NATIVE-1 GUI sideload + trigger. Logs in as the M365 user, tries to upload the
// declarative-agent app package (sentinel-agent.zip) via Teams "Upload a custom app",
// then opens the agent in Copilot and asks for the sentinel — watching whether
// Microsoft's orchestrator makes the outbound call (scripts/sentinel-hits.log).
//
// Screenshot-heavy + graceful: a single run either completes the flow or leaves
// enough diagnostics (screenshots + page text) to see exactly where it's gated.
//
// Usage: CHROMIUM_PATH=$(which chromium) node scripts/da-app/sideload-gui.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSecrets } from "../../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "da-app", "gui-out");
mkdirSync(OUT, { recursive: true });
const ZIP = join(process.cwd(), "scripts", "da-app", "sentinel-agent.zip");
const creds = loadSecrets();
if (!creds) { console.log("no secrets"); process.exit(1); }

import { pathToFileURL } from "node:url";
const ROOT = pathToFileURL(process.cwd()).href;
const pwMod = await import(`${ROOT}/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js`);
const chromium = pwMod.chromium ?? pwMod.default?.chromium;
const { TOTP } = await import(`${ROOT}/node_modules/.pnpm/otpauth@9.5.0/node_modules/otpauth/dist/otpauth.esm.js`);

const shot = async (page, name) => { await page.screenshot({ path: join(OUT, name + ".png"), fullPage: false }).catch(() => {}); console.log(`[shot] ${name}`); };
const dump = async (page, name) => { const t = await page.evaluate(() => document.body?.innerText?.slice(0, 1500) || "").catch(() => ""); writeFileSync(join(OUT, name + ".txt"), `URL: ${page.url()}\n\n${t}`); return t; };

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext();
const page = await ctx.newPage();

async function login() {
  const fill = async (sel, val) => { const loc = page.locator(`${sel}:visible`).first(); await loc.waitFor({ state: "visible", timeout: 30000 }); await loc.fill(val); };
  const submit = () => page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  await fill('input[name="loginfmt"]', creds.email); await submit(); await page.waitForTimeout(2500);
  await fill('input[name="passwd"]', creds.password); await submit(); await page.waitForTimeout(2500);
  try { await fill('input[name="otc"]', new TOTP({ secret: creds.mfaSecret }).generate()); await submit(); await page.waitForTimeout(2500); } catch {}
  try { await page.locator("#idSIButton9:visible").click({ timeout: 8000 }); } catch {}
}

async function clickByText(re, timeout = 6000) {
  const loc = page.getByText(re).first();
  try { await loc.waitFor({ state: "visible", timeout }); await loc.click(); return true; } catch { return false; }
}

try {
  // 1) Establish SSO via Copilot, then go to Teams apps.
  console.log("[da] login via m365 copilot...");
  await page.goto("https://m365.cloud.microsoft/chat/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/login\.microsoftonline|oauth2|signin|\/login/i.test(page.url())) { await login(); }
  await page.waitForTimeout(5000);
  console.log("[da] post-login url:", page.url());
  await shot(page, "01-copilot");

  // 2) Navigate to Teams web apps → Manage your apps → Upload a custom app.
  console.log("[da] navigating to Teams apps...");
  await page.goto("https://teams.microsoft.com/v2/apps", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);
  if (/login\.microsoftonline|oauth2|signin/i.test(page.url())) { await login(); await page.waitForTimeout(6000); }
  await shot(page, "02-teams-apps");
  const appsText = await dump(page, "02-teams-apps");
  console.log("[da] teams apps url:", page.url());

  // Look for "Manage your apps" then "Upload"
  const foundManage = await clickByText(/Manage your apps/i, 8000);
  console.log("[da] clicked 'Manage your apps':", foundManage);
  await page.waitForTimeout(4000);
  await shot(page, "03-manage");
  await dump(page, "03-manage");

  const foundUpload = await clickByText(/Upload an app|Upload a custom app|Upload custom app/i, 8000);
  console.log("[da] clicked 'Upload an app':", foundUpload);
  await page.waitForTimeout(3000);
  await shot(page, "04-upload-dialog");
  const upText = await dump(page, "04-upload-dialog");

  // Detect whether custom-app upload is available at all (gate signal).
  const gated = /isn'?t available|not allowed|contact your admin|don'?t have permission|upload.*disabled/i.test(appsText + upText);
  console.log("[da] custom-app upload appears GATED:", gated);

  // Try to set the file on any file input present (the "Upload a custom app" chooser).
  let uploaded = false;
  try {
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count()) {
      await fileInput.setInputFiles(ZIP);
      uploaded = true;
      console.log("[da] set zip on file input");
      await page.waitForTimeout(6000);
      await shot(page, "05-after-upload");
      await dump(page, "05-after-upload");
    } else {
      // Some flows need an explicit "Upload a custom app" sub-button that triggers a filechooser.
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 6000 }).catch(() => null),
        clickByText(/Upload a custom app|Upload custom app|Submit a custom app/i, 5000),
      ]);
      if (chooser) { await chooser.setInputFiles(ZIP); uploaded = true; console.log("[da] filechooser accepted zip"); await page.waitForTimeout(6000); await shot(page, "05-after-upload"); await dump(page, "05-after-upload"); }
    }
  } catch (e) { console.log("[da] upload attempt error:", e.message); }
  console.log("[da] uploaded:", uploaded);

  // If an "Add" / "Open" appears after upload, click it to install the agent.
  await clickByText(/^Add$|^Open$|Add to a team|Add for me/i, 6000).catch(() => {});
  await page.waitForTimeout(4000);
  await shot(page, "06-final");
  await dump(page, "06-final");

  console.log(`\n[da] === SUMMARY === gated=${gated} uploaded=${uploaded}`);
} catch (e) {
  console.log("[da] ERR", e.message);
  await shot(page, "99-error");
}
await browser.close();
