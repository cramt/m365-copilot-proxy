// Continue the Developer Portal sideload: the package validates ("No issues found");
// now commit Import, open the app, and Preview-in-Copilot to install it for the user.
// Reuses the saved session (state.json). Screenshot-heavy + adaptive.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadSecrets } from "../../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "da-app", "gui-out");
mkdirSync(OUT, { recursive: true });
const ZIP = join(process.cwd(), "scripts", "da-app", "sentinel-agent.zip");
const STATE = join(process.cwd(), "scripts", "da-app", "state.json");
const creds = loadSecrets();
import { pathToFileURL } from "node:url";
const ROOT = pathToFileURL(process.cwd()).href;
const pwMod = await import(`${ROOT}/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js`);
const chromium = pwMod.chromium ?? pwMod.default?.chromium;
const { TOTP } = await import(`${ROOT}/node_modules/.pnpm/otpauth@9.5.0/node_modules/otpauth/dist/otpauth.esm.js`);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const shot = async (page, n) => { await page.screenshot({ path: join(OUT, n + ".png") }).catch(() => {}); console.log(`[shot] ${n}`); };
const dump = async (page, n) => { const t = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || "").catch(() => ""); writeFileSync(join(OUT, n + ".txt"), `URL: ${page.url()}\n\n${t}`); return t; };
const clickBtn = async (page, re, timeout = 6000) => {
  for (const cand of [page.getByRole("button", { name: re }), page.getByText(re)]) {
    const loc = cand.last();
    try { await loc.waitFor({ state: "visible", timeout }); await loc.click(); return true; } catch {}
  }
  return false;
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 900 }, storageState: existsSync(STATE) ? STATE : undefined });
const page = await ctx.newPage();

try {
  await page.goto("https://dev.teams.microsoft.com/apps", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  await shot(page, "c-01-apps");

  // Fresh import: click Import app, set file, wait for validation, click confirm Import.
  await clickBtn(page, /^Import app$|Import an existing app|^Import$/i, 8000);
  await page.waitForTimeout(1500);
  try { const fi = page.locator('input[type="file"]').first(); if (await fi.count()) await fi.setInputFiles(ZIP); } catch (e) { console.log("[c] file err", e.message); }
  await page.waitForTimeout(3000);
  await dump(page, "c-02-validated");
  // Click the dialog's confirm Import (last "Import" button on screen).
  const confirmed = await clickBtn(page, /^Import$/i, 8000);
  console.log("[c] confirm Import clicked:", confirmed);
  await page.waitForTimeout(6000);
  await shot(page, "c-03-after-import");
  const t3 = await dump(page, "c-03-after-import");

  // Open the imported app (by name).
  await clickBtn(page, /Sentinel Probe|Sentinel Native Action Probe/i, 8000);
  await page.waitForTimeout(4000);
  await shot(page, "c-04-app");
  await dump(page, "c-04-app");

  // Preview in Copilot / Teams to install it for this user.
  let previewed = await clickBtn(page, /Preview in Copilot/i, 6000);
  if (!previewed) previewed = await clickBtn(page, /Preview in Teams|^Preview$/i, 6000);
  console.log("[c] preview clicked:", previewed);
  await page.waitForTimeout(9000);
  // Handle a possible new tab (preview may open Copilot/Teams in a popup).
  const pages = ctx.pages();
  const active = pages[pages.length - 1];
  await active.waitForTimeout(4000).catch(() => {});
  await shot(active, "c-05-preview");
  const t5 = await dump(active, "c-05-preview");
  // Accept any "Add"/"Open"/consent to finish install.
  await clickBtn(active, /^Add$|^Open$|^Add for me$|Continue|Allow/i, 6000).catch(() => {});
  await active.waitForTimeout(6000).catch(() => {});
  await shot(active, "c-06-installed");
  await dump(active, "c-06-installed");

  const gated = /isn'?t available|not allowed|contact your admin|don'?t have permission|blocked by your organization|custom apps.*not/i.test(t3 + t5);
  console.log(`\n[c] === SUMMARY === confirmed=${confirmed} previewed=${previewed} gated=${gated} pages=${pages.length}`);
} catch (e) { console.log("[c] ERR", e.message); await shot(page, "c-99-error"); }
await browser.close();
