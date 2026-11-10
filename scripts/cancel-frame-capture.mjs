// RE dig: capture what the REAL m365.cloud.microsoft Copilot client sends over
// its chat WebSocket when the user clicks "Stop generating".
//
// Why: our proxy has NO cancellation path — every turn runs to completion and
// only then closes the socket (grep abort/cancel/stop in copilot.ts/session.ts
// → nothing). A harness that aborts an HTTP request can't propagate that to
// M365 today. To wire it up we need to know the on-the-wire cancel frame:
//   - SignalR CancelInvocation (type 5)?
//   - a bespoke target:"stopGenerating" invocation?
//   - or just a socket close?
// This also (bonus) captures the live chat invocation the first-party client
// sends, so we can diff our hand-built payload against the real one.
//
// Method: Playwright-drive the real UI (TOTP login reused from studio-dig),
// intercept ALL ws frames on substrate.office.com/m365Copilot/Chathub, send a
// deliberately long-generating prompt, then click Stop a couple seconds in.
// Everything is dumped — even if the Stop click misses, we keep the captured
// invocation + deltas.
//
// Usage: M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) node scripts/cancel-frame-capture.mjs
// Read-only-ish: sends ONE chat message to the user's real BizChat, then cancels it.

import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadSecrets } from "../packages/core/dist/index.mjs";

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "cancel-frame-out", TS);
mkdirSync(OUT, { recursive: true });
const framesPath = join(OUT, "ws-frames.ndjson");

const creds = loadSecrets();
if (!creds) { console.log("no secrets"); process.exit(1); }

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
const ctx = await browser.newPage();

const RS = "\x1E";
let frameIdx = 0;
let chatHubSeen = false;
let sentAfterStopClick = []; // frames sent in the window right after we click Stop
let stopClickedAt = null;

// Decode a SignalR ws payload (may hold several 0x1E-separated frames).
function recordFrame(direction, payload) {
  const t = Date.now();
  const isChatHub = true; // we only attach to the chathub ws below
  const chunks = String(payload).split(RS).filter((c) => c.length);
  for (const c of chunks) {
    let parsed = null, type = null, target = null;
    try { parsed = JSON.parse(c); type = parsed.type; target = parsed.target; } catch {}
    const rec = { i: frameIdx++, dir: direction, t, type, target, len: c.length, raw: c.slice(0, 4000) };
    appendFileSync(framesPath, JSON.stringify(rec) + "\n");
    // Anything the client SENDS after we click Stop is a cancel candidate.
    if (direction === "send" && stopClickedAt && t >= stopClickedAt) {
      sentAfterStopClick.push({ dt_after_stop_ms: t - stopClickedAt, type, target, raw: c.slice(0, 2000) });
    }
    if (direction === "send") console.log(`[cap] →SEND type=${type} target=${target} len=${c.length}${stopClickedAt && t >= stopClickedAt ? "  <-- AFTER STOP" : ""}`);
    else console.log(`[cap] ←recv type=${type} target=${target} len=${c.length}`);
  }
}

ctx.on("websocket", (ws) => {
  const url = ws.url();
  if (!/m365Copilot\/Chathub|substrate\.office\.com/i.test(url)) return;
  chatHubSeen = true;
  console.log(`[cap] CHATHUB WS OPEN: ${url.split("?")[0]}`);
  writeFileSync(join(OUT, "ws-url.txt"), url.split("?")[0] + "\n(query stripped)");
  ws.on("framesent", (f) => recordFrame("send", f.payload));
  ws.on("framereceived", (f) => recordFrame("recv", f.payload));
  ws.on("close", () => console.log("[cap] CHATHUB WS CLOSED"));
});

const shot = async (n) => { try { await ctx.screenshot({ path: join(OUT, `${n}.png`), fullPage: false }); writeFileSync(join(OUT, `${n}.url.txt`), ctx.url()); } catch {} };

async function login() {
  const fill = async (sel, val) => {
    const loc = ctx.locator(`${sel}:visible`).first();
    await loc.waitFor({ state: "visible", timeout: 30000 });
    await loc.fill(val);
  };
  const submit = () => ctx.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  await fill('input[name="loginfmt"]', creds.email); await submit();
  await ctx.waitForTimeout(2500);
  await fill('input[name="passwd"]', creds.password); await submit();
  await ctx.waitForTimeout(2500);
  const otp = new TOTP({ secret: creds.mfaSecret }).generate();
  await fill('input[name="otc"]', otp); await submit();
  await ctx.waitForTimeout(2500);
  try { await ctx.locator("#idSIButton9:visible").click({ timeout: 8000 }); } catch {}
}

// Try hard to find the chat composer across the various BizChat surfaces.
async function findComposer() {
  const cands = [
    'textarea[placeholder*="Copilot" i]',
    'textarea[placeholder*="Message" i]',
    'textarea[placeholder*="Ask" i]',
    'div[contenteditable="true"]',
    'textarea',
    '[role="textbox"]',
  ];
  for (const sel of cands) {
    const loc = ctx.locator(`${sel}:visible`).first();
    if (await loc.count().catch(() => 0)) {
      try { await loc.waitFor({ state: "visible", timeout: 4000 }); console.log(`[cap] composer: ${sel}`); return loc; } catch {}
    }
  }
  return null;
}

// Find the Stop button (appears only while generating).
async function findStop() {
  const cands = [
    'button[aria-label*="Stop" i]',
    'button[title*="Stop" i]',
    '[aria-label*="Stop generating" i]',
    'button:has-text("Stop")',
    '[data-testid*="stop" i]',
  ];
  for (const sel of cands) {
    const loc = ctx.locator(`${sel}:visible`).first();
    if (await loc.count().catch(() => 0)) { console.log(`[cap] stop btn: ${sel}`); return loc; }
  }
  return null;
}

try {
  // The Copilot chat surface. Try the dedicated chat host first.
  for (const target of ["https://m365.cloud.microsoft/chat", "https://m365.cloud.microsoft/", "https://www.office.com/chat"]) {
    console.log(`[cap] goto ${target}`);
    await ctx.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("  goto err", e.message));
    await ctx.waitForTimeout(3000);
    if (/login\.microsoftonline|\/oauth2|signin/i.test(ctx.url())) {
      console.log("[cap] AAD login...");
      await login();
      await ctx.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    }
    await ctx.waitForTimeout(4000);
    const composer = await findComposer();
    if (composer) { await shot("01-chat-ready"); var THE_COMPOSER = composer; break; }
    await shot(`00-no-composer-${target.replace(/\W+/g, "_")}`);
  }

  if (!THE_COMPOSER) { console.log("[cap] no composer found on any surface — see screenshots"); throw new Error("no composer"); }

  // Send a prompt that generates for a while, so we have time to hit Stop.
  const PROMPT = "Write an extremely detailed, very long essay (at least 3000 words) about the complete history of cathedral construction in medieval Europe. Use long continuous prose with many paragraphs.";
  console.log("[cap] typing prompt...");
  await THE_COMPOSER.click();
  await THE_COMPOSER.fill(PROMPT).catch(async () => { await THE_COMPOSER.type(PROMPT); });
  await ctx.waitForTimeout(500);
  await ctx.keyboard.press("Enter");
  console.log("[cap] submitted; waiting for generation to start...");

  // Wait until we see streaming deltas (recv frames flowing), then let it run ~2.5s.
  await ctx.waitForTimeout(3500);
  await shot("02-generating");

  // Click Stop and mark the timestamp so we tag subsequent sent frames.
  const stop = await findStop();
  if (stop) {
    stopClickedAt = Date.now();
    console.log("[cap] >>> CLICKING STOP <<<");
    await stop.click().catch((e) => console.log("  stop click err", e.message));
    await ctx.waitForTimeout(4000); // capture whatever the client sends on cancel
    await shot("03-after-stop");
  } else {
    console.log("[cap] !! no Stop button found — capturing screenshot for selector discovery");
    await shot("03-no-stop-button");
    // Dump the visible button landscape to help find the selector next time.
    const btns = await ctx.locator("button:visible").evaluateAll(
      (els) => els.map((e) => ({ aria: e.getAttribute("aria-label"), title: e.getAttribute("title"), txt: (e.textContent || "").trim().slice(0, 30), testid: e.getAttribute("data-testid") })).filter((b) => b.aria || b.title || b.txt || b.testid)
    ).catch(() => []);
    writeFileSync(join(OUT, "visible-buttons.json"), JSON.stringify(btns, null, 2));
    console.log(`[cap] dumped ${btns.length} visible buttons → visible-buttons.json`);
  }
} catch (e) {
  console.log("[cap] error:", e.message);
  await shot("99-error");
} finally {
  writeFileSync(join(OUT, "cancel-candidates.json"), JSON.stringify({
    chatHubSeen,
    stopClicked: stopClickedAt != null,
    framesAfterStop: sentAfterStopClick,
  }, null, 2));
  console.log(`\n[cap] === SUMMARY ===`);
  console.log(`[cap] chathub ws seen: ${chatHubSeen}`);
  console.log(`[cap] frames sent AFTER stop click: ${sentAfterStopClick.length}`);
  for (const f of sentAfterStopClick) console.log(`   +${f.dt_after_stop_ms}ms type=${f.type} target=${f.target}: ${f.raw.slice(0, 200)}`);
  console.log(`[cap] full capture: ${OUT}`);
  await browser.close();
}
