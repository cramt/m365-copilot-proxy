// Capture what Microsoft's OWN M365 Copilot web client sends/receives over the
// substrate Chathub WebSocket — to VERIFY our Disengage model with eyes-on and to
// diff the GUI's request payload (optionsSets / variants / agent / tone) against
// ours. Reuses the repo's Playwright+secrets login (cf. gateway-capture.mjs).
//
// Usage: CHROMIUM_PATH=$(which chromium) node scripts/m365-gui-capture.mjs ["task text"]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSecrets } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "gui-capture-out");
mkdirSync(OUT, { recursive: true });
const creds = loadSecrets();
if (!creds) { console.log("no secrets"); process.exit(1); }

const ROOT = process.cwd();
const pwMod = await import(`${ROOT}/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js`);
const chromium = pwMod.chromium ?? pwMod.default?.chromium;
const { TOTP } = await import(`${ROOT}/node_modules/.pnpm/otpauth@9.5.0/node_modules/otpauth/dist/otpauth.esm.js`);

const TASK = process.argv[2] || "Edit config.json so the port is 8080 instead of 3000. Leave every other field unchanged.";
// Image generation runs far longer than a text turn, and its result frame lands
// well past the first 60 — both defaults silently truncated the capture.
const WAIT_MS = Number(process.env.M365_GUI_WAIT_MS ?? 22000);
const FRAME_CAP = Number(process.env.M365_GUI_FRAME_CAP ?? 60);
const RS = "\x1e";

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();

const frames = [];
let chathubUrl = null, sawDisengaged = false, firstChatPayload = null, botText = "";

page.on("websocket", (ws) => {
  const u = ws.url();
  if (!/Chathub|substrate\.office\.com/i.test(u)) return;
  chathubUrl = u;
  console.log(`[ws] OPEN ${u.slice(0, 150)}`);
  const handle = (dir) => (data) => {
    const payload = typeof data === "string" ? data : (data?.payload ?? "");
    for (const f of String(payload).split(RS)) {
      if (!f) continue;
      let p; try { p = JSON.parse(f); } catch { continue; }
      frames.push({ dir, p });
      if (dir === "send" && p.type === 4 && p.target === "chat" && !firstChatPayload) {
        firstChatPayload = p; console.log("[ws] captured GUI outbound chat payload");
      }
      const s = JSON.stringify(p);
      if (/"messageType":"Disengaged"|Conversation disengaged/.test(s)) { sawDisengaged = true; console.log("[ws] !! DISENGAGED"); }
      const m = s.match(/"text":"((?:[^"\\]|\\.){0,160})/); if (dir === "recv" && m && m[1].length > botText.length) botText = m[1];
    }
  };
  ws.on("framesent", handle("send"));
  ws.on("framereceived", handle("recv"));
});

async function login() {
  const fill = async (sel, val) => { const loc = page.locator(`${sel}:visible`).first(); await loc.waitFor({ state: "visible", timeout: 30000 }); await loc.fill(val); };
  const submit = () => page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  await fill('input[name="loginfmt"]', creds.email); await submit(); await page.waitForTimeout(2500);
  await fill('input[name="passwd"]', creds.password); await submit(); await page.waitForTimeout(2500);
  try { await fill('input[name="otc"]', new TOTP({ secret: creds.mfaSecret }).generate()); await submit(); await page.waitForTimeout(2500); } catch {}
  try { await page.locator("#idSIButton9:visible").click({ timeout: 8000 }); } catch {}
}

try {
  console.log("[gui] navigating to M365 Copilot chat...");
  await page.goto("https://m365.cloud.microsoft/chat/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/login\.microsoftonline|oauth2|signin|\/login/i.test(page.url())) { console.log("[gui] login..."); await login(); }
  await page.waitForTimeout(6000);
  console.log("[gui] url:", page.url());
  await page.screenshot({ path: join(OUT, "after-login.png"), fullPage: false }).catch(() => {});

  // Find the chat composer — try common shapes.
  const sels = ['div[contenteditable="true"]:visible', 'textarea:visible', '[role="textbox"]:visible'];
  let box = null;
  for (const s of sels) { const loc = page.locator(s).first(); if (await loc.count().catch(() => 0)) { box = loc; console.log("[gui] composer:", s); break; } }
  if (box) {
    await box.click().catch(() => {});
    await page.keyboard.type(TASK, { delay: 8 });
    await page.waitForTimeout(600);
    await page.keyboard.press("Enter");
    console.log(`[gui] message sent; waiting ${WAIT_MS}ms for response/WS...`);
    await page.waitForTimeout(WAIT_MS);
  } else {
    console.log("[gui] NO composer found — capturing page text for diagnosis");
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 800)).catch(() => "");
    console.log(txt);
  }
  await page.screenshot({ path: join(OUT, "after-send.png"), fullPage: false }).catch(() => {});
} catch (e) { console.log("[gui] ERR", e.message); }

writeFileSync(join(OUT, "frames.json"), JSON.stringify({ chathubUrl, sawDisengaged, frameCount: frames.length, firstChatPayload, frames: Number.isFinite(FRAME_CAP) && FRAME_CAP > 0 ? frames.slice(0, FRAME_CAP) : frames }, null, 2));
console.log(`\n[gui] === RESULT === chathub=${chathubUrl ? "yes" : "NO"} disengaged=${sawDisengaged} frames=${frames.length} botText="${botText.slice(0, 80)}"`);
if (chathubUrl) {
  try { const q = new URL(chathubUrl.replace(/^wss/, "https")).searchParams; console.log("[gui] WS query keys:", [...q.keys()].join(",")); console.log("[gui] variants:", q.get("variants")); } catch {}
}
if (firstChatPayload) {
  const a = firstChatPayload.arguments?.[0] ?? {};
  console.log("[gui] optionsSets:", JSON.stringify(a.optionsSets));
  console.log("[gui] threadLevelGptId:", JSON.stringify(a.threadLevelGptId), "gpts:", JSON.stringify(a.gpts));
  console.log("[gui] plugins:", JSON.stringify(a.plugins), "tone:", a.tone, "source:", a.source);
  console.log("[gui] allowedMessageTypes:", JSON.stringify(a.allowedMessageTypes));
}
await browser.close();
