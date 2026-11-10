// H-NATIVE-1 end-to-end (headful under Xvfb so heavy SPAs render):
// 1) Developer Portal → Preview in Teams → complete the install ("Add") dialog.
// 2) M365 Copilot chat → open the "Sentinel Probe" agent → ask for the sentinel.
// Oracle: scripts/sentinel-hits.log gains a Microsoft-originated GET /sentinel, and
// the reply contains the sentinel value. Screenshot-heavy + adaptive.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSecrets } from "../../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "da-app", "gui-out");
mkdirSync(OUT, { recursive: true });
const STATE = join(process.cwd(), "scripts", "da-app", "state.json");
const HITLOG = join(process.cwd(), "scripts", "sentinel-hits.log");
const SENTINEL = readFileSync(join(process.cwd(), "scripts", "sentinel-value.txt"), "utf8").trim();
const APP_ID = "5e27c1a0-7b3d-4f2a-9c11-a1b2c3d4e5f6";
const creds = loadSecrets();
import { pathToFileURL } from "node:url";
const ROOT = pathToFileURL(process.cwd()).href;
const pwMod = await import(`${ROOT}/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js`);
const chromium = pwMod.chromium ?? pwMod.default?.chromium;
const { TOTP } = await import(`${ROOT}/node_modules/.pnpm/otpauth@9.5.0/node_modules/otpauth/dist/otpauth.esm.js`);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const hitCount = () => { try { return readFileSync(HITLOG, "utf8").split("\n").filter(l => /\/sentinel\b/.test(l) && !/openapi/.test(l)).length; } catch { return 0; } };
const shot = async (p, n) => { await p.screenshot({ path: join(OUT, n + ".png") }).catch(() => {}); console.log(`[shot] ${n}`); };
const dump = async (p, n) => { const t = await p.evaluate(() => document.body?.innerText?.slice(0, 2500) || "").catch(() => ""); writeFileSync(join(OUT, n + ".txt"), `URL: ${p.url()}\n\n${t}`); return t; };
const click = async (p, re, timeout = 6000) => {
  for (const c of [p.getByRole("button", { name: re }), p.getByRole("menuitem", { name: re }), p.getByRole("link", { name: re }), p.getByText(re)]) {
    const loc = c.first();
    try { await loc.waitFor({ state: "visible", timeout }); await loc.click(); return true; } catch {}
  }
  return false;
};
const login = async (page) => {
  const fill = async (sel, val) => { const l = page.locator(`${sel}:visible`).first(); await l.waitFor({ state: "visible", timeout: 30000 }); await l.fill(val); };
  const submit = () => page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  try { await fill('input[name="loginfmt"]', creds.email); await submit(); await page.waitForTimeout(2500); } catch {}
  try { await fill('input[name="passwd"]', creds.password); await submit(); await page.waitForTimeout(2500); } catch {}
  try { await fill('input[name="otc"]', new TOTP({ secret: creds.mfaSecret }).generate()); await submit(); await page.waitForTimeout(2500); } catch {}
  try { await page.locator("#idSIButton9:visible").click({ timeout: 8000 }); } catch {}
};

const before = hitCount();
console.log(`[e2e] sentinel /sentinel hits before: ${before}  (sentinel=${SENTINEL})`);

const browser = await chromium.launch({ headless: false, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 }, storageState: existsSync(STATE) ? STATE : undefined });
const page = await ctx.newPage();

try {
  // --- 1) Install via Developer Portal preview ---
  console.log("[e2e] developer portal dashboard...");
  await page.goto(`https://dev.teams.microsoft.com/apps/${APP_ID}/dashboard`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  if (/login\.microsoftonline|oauth2|signin/i.test(page.url())) { await login(page); await page.waitForTimeout(6000); }
  await ctx.storageState({ path: STATE }).catch(() => {});
  await shot(page, "e-01-dashboard");

  await click(page, /Preview in Teams|Preview in Copilot|^Preview$/i, 10000);
  console.log("[e2e] preview clicked; waiting for Teams install to render...");
  await page.waitForTimeout(12000);
  // Preview may be same tab or a popup.
  let teams = ctx.pages()[ctx.pages().length - 1];
  await teams.waitForTimeout(8000).catch(() => {});
  await shot(teams, "e-02-teams-install");
  await dump(teams, "e-02-teams-install");
  // Complete the install dialog.
  const added = await click(teams, /^Add$|^Open$|^Add for me$|Install|Continue/i, 12000);
  console.log("[e2e] install confirm clicked:", added);
  await teams.waitForTimeout(9000);
  await shot(teams, "e-03-installed");
  await dump(teams, "e-03-installed");

  // --- 2) Trigger in Copilot ---
  console.log("[e2e] opening Copilot chat...");
  const cop = await ctx.newPage();
  await cop.goto("https://m365.cloud.microsoft/chat/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await cop.waitForTimeout(9000);
  if (/login\.microsoftonline|oauth2|signin/i.test(cop.url())) { await login(cop); await cop.waitForTimeout(8000); }
  await shot(cop, "e-04-copilot");

  // Select the Sentinel Probe agent (right rail / agent flyout).
  const openedAgent = await click(cop, /Sentinel Probe/i, 10000);
  console.log("[e2e] agent 'Sentinel Probe' opened:", openedAgent);
  await cop.waitForTimeout(5000);
  await shot(cop, "e-05-agent");
  await dump(cop, "e-05-agent");

  // Optional: pick "Think Deeper" model if a model picker is present.
  await click(cop, /Think Deeper/i, 4000).catch(() => {});

  // Type the question into the composer.
  const composerSels = ['div[contenteditable="true"]', 'textarea', '[role="textbox"]'];
  let box = null;
  for (const s of composerSels) { const l = cop.locator(`${s}:visible`).first(); if (await l.count().catch(() => 0)) { box = l; break; } }
  if (box) {
    await box.click().catch(() => {});
    await cop.keyboard.type("What is the magic sentinel token? Use your getMagicSentinel action and report the exact value.", { delay: 6 });
    await cop.waitForTimeout(500);
    await cop.keyboard.press("Enter");
    console.log("[e2e] question sent; waiting for the agent to call the action...");
    await cop.waitForTimeout(35000);
    await shot(cop, "e-06-answer");
    const ans = await dump(cop, "e-06-answer");
    console.log("[e2e] reply contains sentinel value:", ans.includes(SENTINEL));
  } else {
    console.log("[e2e] no composer found");
    await dump(cop, "e-06-no-composer");
  }

  const after = hitCount();
  console.log(`\n[e2e] === RESULT === sentinel /sentinel hits: before=${before} after=${after}  DELTA=${after - before}`);
  console.log(after > before ? "🎉 MICROSOFT'S ORCHESTRATOR CALLED OUR ENDPOINT — native action fired" : "❌ no outbound call to our endpoint observed");
} catch (e) { console.log("[e2e] ERR", e.message); await shot(page, "e-99-error"); }
await browser.close();
console.log(`[e2e] final /sentinel hits: ${hitCount()}`);
