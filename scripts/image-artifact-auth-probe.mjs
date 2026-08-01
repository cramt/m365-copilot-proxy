// RE probe (H14.2): what auth opens a generated-image artifact?
//
// §14 established that the image URL in `contentGenerationProgressList[].
// ImageReferenceUrls` returns 401 anonymously, with the Sydney token, and with
// every audience this first-party client can silently acquire (graph/substrate
// 401; designerapp/office.com are `invalid_resource` — not preauthorized).
// But the official web client renders the image fine, so *something* opens it.
//
// This probe watches the real client fetch it and reports the auth it carries.
//
// Cost: ZERO image credits — it re-opens an EXISTING conversation from history
// rather than generating anything. One login. Never sends a chat message.
//
// Usage: CHROMIUM_PATH=$(which chromium) node scripts/image-artifact-auth-probe.mjs ["chat title prefix"]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadSecrets } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "image-auth-out");
mkdirSync(OUT, { recursive: true });
const creds = loadSecrets();
if (!creds) { console.log("no secrets"); process.exit(1); }

const TITLE_PREFIX = process.argv[2] || "Draw me a picture";
const ROOT = process.cwd();
const pwMod = await import(`${ROOT}/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js`);
const chromium = pwMod.chromium ?? pwMod.default?.chromium;
const { TOTP } = await import(`${ROOT}/node_modules/.pnpm/otpauth@9.5.0/node_modules/otpauth/dist/otpauth.esm.js`);

// A fresh context, not the persistent profile: the profile carries partial AAD
// SSO cookies that strand the flow on the authorize page without ever showing a
// form. m365-gui-capture.mjs's clean-browser + full-login path is the one that
// reliably lands on the chat.
const USE_PROFILE = process.env.M365_USE_PROFILE === "1";
const PROFILE = process.env.M365_BROWSER_PROFILE ?? join(homedir(), ".config", "opencode-m365", "browser-profile");

const ARTIFACT_HOST = /designerapp\.officeapps\.live\.com|officeapps\.live\.com|sharepoint|spoprod|\.blob\.core\./i;
const hits = [];
const fullAuth = { value: null };

const launchOpts = {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
};
const browser = USE_PROFILE ? null : await chromium.launch(launchOpts);
const ctx = USE_PROFILE
  ? await chromium.launchPersistentContext(PROFILE, { ...launchOpts, viewport: { width: 1280, height: 900 } })
  : await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] ?? await ctx.newPage();

// Second hook: find where the artifact bearer is MINTED. The artifact request
// carries a JWE our first-party client cannot mint (designerapp is
// `invalid_resource` for it), so some earlier call issues it.
const TOKEN_ISH = /\/token|getaccesstoken|oauth2|\/auth\b|designerapp.*token|substrate.*token|\/api\/.*token/i;
const tokenCalls = [];
page.on("response", async (res) => {
  const u = res.url();
  if (!TOKEN_ISH.test(u) || ARTIFACT_HOST.test(u)) return;
  // Request side: the form body carries client_id / scope / grant_type — the
  // non-secret parameters that tell us HOW the artifact token is requested.
  const req = res.request();
  let reqParams = null;
  try {
    const pd = req.postData();
    if (pd) {
      const q = new URLSearchParams(pd);
      reqParams = {
        client_id: q.get("client_id"),
        scope: q.get("scope"),
        grant_type: q.get("grant_type"),
        // presence only — never the values
        hasAssertion: q.has("assertion") || q.has("client_assertion"),
        hasReqCnf: q.has("req_cnf"),           // proof-of-possession / token-binding
        hasBrkClientId: /brk_client_id/.test(u),
      };
    }
  } catch {}
  let bodyHint = null;
  try {
    const t = await res.text();
    bodyHint = { len: t.length, hasRsaOaepJwe: /eyJhbGciOiJSU0EtT0FFUCIs/.test(t), keys: (t.startsWith("{") ? Object.keys(JSON.parse(t)) : []).slice(0, 15) };
  } catch {}
  tokenCalls.push({ status: res.status(), url: u.slice(0, 160), reqParams, bodyHint });
});

page.on("request", (req) => {
  const u = req.url();
  if (!ARTIFACT_HOST.test(u)) return;
  const h = req.headers();
  // Full value goes to the gitignored out dir only — never to stdout.
  if (h.authorization && !fullAuth.value) fullAuth.value = h.authorization;
  hits.push({
    phase: "request",
    method: req.method(),
    url: u.slice(0, 400),
    resourceType: req.resourceType(),
    hasAuthorization: !!h.authorization,
    authorizationPrefix: h.authorization ? h.authorization.slice(0, 24) + "…" : null,
    hasCookie: !!h.cookie,
    cookieNames: h.cookie ? h.cookie.split(";").map((c) => c.split("=")[0].trim()).slice(0, 12) : [],
    headerNames: Object.keys(h),
  });
});
page.on("response", async (res) => {
  const u = res.url();
  if (!ARTIFACT_HOST.test(u)) return;
  hits.push({ phase: "response", status: res.status(), url: u.slice(0, 200), contentType: res.headers()["content-type"] ?? null });
});

// The persistent profile usually carries AAD SSO cookies, so the form often
// never appears and we're already through. Treat every step as optional.
async function login() {
  const fill = async (sel, val) => { const loc = page.locator(`${sel}:visible`).first(); await loc.waitFor({ state: "visible", timeout: 30000 }); await loc.fill(val); };
  const submit = () => page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  await fill('input[name="loginfmt"]', creds.email); await submit(); await page.waitForTimeout(2500);
  await fill('input[name="passwd"]', creds.password); await submit(); await page.waitForTimeout(2500);
  try { await fill('input[name="otc"]', new TOTP({ secret: creds.mfaSecret }).generate()); await submit(); await page.waitForTimeout(2500); } catch {}
  try { await page.locator("#idSIButton9:visible").click({ timeout: 8000 }); } catch {}
}

try {
  console.log("[probe] opening M365 Copilot chat…");
  await page.goto("https://m365.cloud.microsoft/chat/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/login\.microsoftonline|oauth2|signin|\/login/i.test(page.url())) { console.log("[probe] login…"); await login(); }
  await page.waitForTimeout(8000);
  console.log("[probe] landed on:", page.url().slice(0, 100));

  // Re-open the existing image conversation from the sidebar — no new generation.
  const item = page.locator(`text=${TITLE_PREFIX}`).first();
  if (await item.count().catch(() => 0)) {
    console.log(`[probe] clicking existing chat: "${TITLE_PREFIX}…"`);
    await item.click().catch(() => {});
    await page.waitForTimeout(15000);
  } else {
    console.log(`[probe] NO chat matching "${TITLE_PREFIX}" in sidebar`);
  }
  await page.screenshot({ path: join(OUT, "reopened.png") }).catch(() => {});

  const cookies = await ctx.cookies();
  const artifactCookies = cookies.filter((c) => ARTIFACT_HOST.test(c.domain));
  writeFileSync(join(OUT, "auth-probe.json"), JSON.stringify({ hits, tokenCalls, artifactCookieNames: artifactCookies.map((c) => `${c.domain}:${c.name}`) }, null, 2));
  if (fullAuth.value) {
    writeFileSync(join(OUT, "artifact-auth.txt"), fullAuth.value);
    const raw = fullAuth.value.replace(/^Bearer\s+/i, "");
    const parts = raw.split(".");
    let hdr = null; try { hdr = JSON.parse(Buffer.from(parts[0], "base64url").toString()); } catch {}
    console.log(`\n[probe] artifact auth: len=${raw.length} segments=${parts.length} header=${JSON.stringify(hdr)}`);
    console.log("[probe] (full value written to scripts/image-auth-out/artifact-auth.txt — gitignored)");
  }
  console.log(`\n[probe] token-ish calls: ${tokenCalls.length}`);
  for (const t of tokenCalls) {
    console.log(`  ${t.status} jwe=${t.bodyHint?.hasRsaOaepJwe ?? "?"} ${t.url}`);
    if (t.reqParams) console.log(`      client_id=${t.reqParams.client_id} grant=${t.reqParams.grant_type} brk=${t.reqParams.hasBrkClientId} assertion=${t.reqParams.hasAssertion} req_cnf=${t.reqParams.hasReqCnf}`);
    if (t.reqParams?.scope) console.log(`      scope=${t.reqParams.scope}`);
  }

  console.log(`\n[probe] === artifact requests: ${hits.filter((h) => h.phase === "request").length} ===`);
  for (const h of hits) {
    if (h.phase === "request") {
      console.log(`REQ ${h.method} auth=${h.hasAuthorization ? h.authorizationPrefix : "NO"} cookie=${h.hasCookie ? h.cookieNames.join(",") : "NO"}`);
      console.log(`    ${h.url.slice(0, 150)}`);
    } else {
      console.log(`RES ${h.status} ${h.contentType ?? ""}`);
    }
  }
  console.log(`\n[probe] cookies scoped to artifact hosts: ${artifactCookies.length}`, artifactCookies.map((c) => `${c.domain}:${c.name}`).slice(0, 10).join(" "));
} catch (e) {
  console.log("[probe] ERR", e.message);
} finally {
  await ctx.close();
  if (browser) await browser.close();
}
