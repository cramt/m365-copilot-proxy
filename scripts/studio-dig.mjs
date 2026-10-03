// Reverse-engineering dig: log into the real Copilot Studio web UI and capture
// every API call it makes, to discover (a) the endpoint that returns a full
// agent definition and (b) whether an agent can be bound to a model. Read-only
// — we only navigate and observe; we never save/publish anything.
// Usage: CHROMIUM_PATH=... node scripts/studio-dig.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { loadSecrets } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "studio-dig-out");
mkdirSync(OUT, { recursive: true });

const creds = loadSecrets();
if (!creds) { console.log("no secrets"); process.exit(1); }
const cache = JSON.parse(readFileSync(join(homedir(), ".config", "opencode-m365", "agent-id.json"), "utf-8"));
const botId = cache.botId;

import { pathToFileURL } from "node:url";
const ROOT = pathToFileURL(process.cwd()).href;
const pwMod = await import(`${ROOT}/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js`);
const chromium = pwMod.chromium ?? pwMod.default?.chromium;
const { TOTP } = await import(`${ROOT}/node_modules/.pnpm/otpauth@9.5.0/node_modules/otpauth/dist/otpauth.esm.js`);

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();

// --- network capture ---
const apiHits = new Set();
const modelHits = [];
const KW = /model|deployment|llm|gpt[-_]?[0-9]|reasoning|aiModel|tone|capabilit/i;
const isApi = (u) => /\/(api|copilotstudio|powerplatform|bots?|agents?|environments)\b/i.test(u) && !/\.(js|css|png|svg|woff2?|json\?v=|map)$/i.test(u);

page.on("response", async (res) => {
  const u = res.url();
  if (!isApi(u)) return;
  apiHits.add(`${res.request().method()} ${u.split("?")[0]}`);
  const ct = res.headers()["content-type"] || "";
  if (!ct.includes("json")) return;
  try {
    const body = await res.text();
    if (KW.test(body)) {
      modelHits.push({ url: u.split("?")[0], status: res.status(), snippet: body.slice(0, 0) });
      // pull just the model-ish key/value fragments
      const frags = [...body.matchAll(/"([^"]*(?:model|deployment|gpt[-_]?\d|reasoning|aiModel|tone)[^"]*)"\s*:\s*("[^"]{0,80}"|\[[^\]]{0,120}\]|[\w.-]{0,40})/gi)]
        .map((m) => `${m[1]} = ${m[2]}`);
      if (frags.length) modelHits.push({ url: u.split("?")[0], frags: [...new Set(frags)].slice(0, 25) });
    }
  } catch {}
});

async function login() {
  const fill = async (sel, val) => {
    const loc = page.locator(`${sel}:visible`).first();
    await loc.waitFor({ state: "visible", timeout: 30000 });
    await loc.fill(val);
  };
  const submit = () => page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  await fill('input[name="loginfmt"]', creds.email); await submit();
  await page.waitForTimeout(2500);
  await fill('input[name="passwd"]', creds.password); await submit();
  await page.waitForTimeout(2500);
  const otp = new TOTP({ secret: creds.mfaSecret }).generate();
  await fill('input[name="otc"]', otp); await submit();
  await page.waitForTimeout(2500);
  try { await page.locator("#idSIButton9:visible").click({ timeout: 8000 }); } catch {}
}

const shot = async (n) => { try { await page.screenshot({ path: join(OUT, `${n}.png`), fullPage: true }); writeFileSync(join(OUT, `${n}.url.txt`), page.url()); } catch {} };

try {
  console.log("[dig] navigating to Copilot Studio...");
  await page.goto("https://copilotstudio.microsoft.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/login\.microsoftonline|\/oauth2|signin/i.test(page.url())) {
    console.log("[dig] login form, driving AAD...");
    await login();
  }
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await shot("01-home");
  console.log("[dig] home url:", page.url());

  // Try to open our agent directly — capture the definition-load API calls.
  const envSeg = page.url().match(/environments\/([^/]+)/)?.[1];
  if (envSeg) {
    for (const path of [`/environments/${envSeg}/bots/${botId}/overview`, `/environments/${envSeg}/bots/${botId}/settings`, `/environments/${envSeg}/bots/${botId}/configuration`]) {
      console.log("[dig] nav", path);
      await page.goto(`https://copilotstudio.microsoft.com${path}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 40000 }).catch(() => {});
      await page.waitForTimeout(4000);
      await shot(`02-${path.split("/").pop()}`);
    }
  }
  // Scan the rendered settings page for a model picker.
  const modelUi = await page.locator('text=/model|GPT|reasoning|deep/i').allInnerTexts().catch(() => []);
  writeFileSync(join(OUT, "model-ui-text.txt"), modelUi.join("\n"));
} catch (e) {
  console.log("[dig] error:", e.message);
  await shot("99-error");
} finally {
  writeFileSync(join(OUT, "api-endpoints.txt"), [...apiHits].sort().join("\n"));
  writeFileSync(join(OUT, "model-hits.json"), JSON.stringify(modelHits, null, 2));
  console.log(`\n[dig] ${apiHits.size} distinct API endpoints, ${modelHits.length} model-related responses`);
  console.log("[dig] model-ish fragments:");
  for (const h of modelHits.filter((m) => m.frags)) {
    console.log(`  --- ${h.url}`);
    for (const f of h.frags) console.log("    " + f);
  }
  await browser.close();
}
