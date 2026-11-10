// Emulate OUR proxy's request from INSIDE the authenticated GUI browser context.
// Logs into the real M365 Copilot web app, lets the GUI open its substrate Chathub
// WS (so we capture the GUI's exact token + query params), then from the PAGE
// opens a fresh WS to the same endpoint and sends OUR proxy's payload (declarative
// AGENT + shell framing + the "replace X->Y" task). Everything is the GUI's (token,
// origin, WS params) EXCEPT the message payload — isolating whether the Disengage is
// caused by our PAYLOAD (the agent) or by our proxy's CONNECTION (token/headers/params).
//
// Usage: CHROMIUM_PATH=$(which chromium) node scripts/m365-gui-emulate.mjs
process.env.M365_FRAMING_VARIANT = process.env.M365_FRAMING_VARIANT || "minimal";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSecrets, formatMessages, getOrCreateAgent } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "gui-capture-out");
mkdirSync(OUT, { recursive: true });
const creds = loadSecrets();
if (!creds) { console.log("no secrets"); process.exit(1); }
import { pathToFileURL } from "node:url";
const ROOT = pathToFileURL(process.cwd()).href;
const pwMod = await import(`${ROOT}/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js`);
const chromium = pwMod.chromium ?? pwMod.default?.chromium;
const { TOTP } = await import(`${ROOT}/node_modules/.pnpm/otpauth@9.5.0/node_modules/otpauth/dist/otpauth.esm.js`);

const TASK = "Edit config.json so the port is 8080 instead of 3000. Leave every other field unchanged.";
const BENCH_TOOLS = [{ type: "function", function: { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }];

const agentId = await getOrCreateAgent().catch(() => null);
const framingText = formatMessages([{ role: "user", content: TASK }], BENCH_TOOLS, "auto", crypto.randomUUID());
console.log(`[emu] agent=${agentId ?? "none"} framing=${process.env.M365_FRAMING_VARIANT} textlen=${framingText.length}`);

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
let chathubUrl = null;
page.on("websocket", (ws) => { const u = ws.url(); if (/Chathub|substrate\.office\.com/i.test(u) && !chathubUrl) { chathubUrl = u; console.log("[emu] captured GUI chathub URL (token+params)"); } });

async function login() {
  const fill = async (sel, val) => { const loc = page.locator(`${sel}:visible`).first(); await loc.waitFor({ state: "visible", timeout: 30000 }); await loc.fill(val); };
  const submit = () => page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  await fill('input[name="loginfmt"]', creds.email); await submit(); await page.waitForTimeout(2500);
  await fill('input[name="passwd"]', creds.password); await submit(); await page.waitForTimeout(2500);
  try { await fill('input[name="otc"]', new TOTP({ secret: creds.mfaSecret }).generate()); await submit(); await page.waitForTimeout(2500); } catch {}
  try { await page.locator("#idSIButton9:visible").click({ timeout: 8000 }); } catch {}
}

try {
  await page.goto("https://m365.cloud.microsoft/chat/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/login\.microsoftonline|oauth2|signin|\/login/i.test(page.url())) { await login(); }
  await page.waitForTimeout(6000);
  // Trigger a GUI turn so the GUI opens its WS and we capture token+params.
  await page.screenshot({ path: join(OUT, "emu-after-login.png") }).catch(() => {});
  let box = null;
  for (const s of ['div[contenteditable="true"]:visible', 'textarea:visible', '[role="textbox"]:visible']) {
    const loc = page.locator(s).first(); if (await loc.count().catch(() => 0)) { box = loc; console.log("[emu] composer:", s); break; }
  }
  if (!box) { console.log("[emu] page text:", (await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => ""))); throw new Error("no composer"); }
  await box.click().catch(() => {});
  await page.keyboard.type("List the files in the current directory.", { delay: 8 });
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  // M365 composer often needs the send button, not Enter — click it as fallback.
  for (const s of ['button[aria-label*="Send" i]', 'button[title*="Send" i]', '[data-testid*="send" i]', 'button:has(svg):near(:text("Mic"))']) {
    if (chathubUrl) break;
    const b = page.locator(s).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); console.log("[emu] clicked send:", s); await page.waitForTimeout(1500); }
  }
  console.log("[emu] GUI message sent; waiting for WS...");
  for (let i = 0; i < 20 && !chathubUrl; i++) await page.waitForTimeout(1000);
  if (!chathubUrl) { await page.screenshot({ path: join(OUT, "emu-nows.png") }).catch(() => {}); throw new Error("never captured GUI chathub URL"); }
  await page.waitForTimeout(2000);

  // Build OUR payload (proxy-faithful) and inject it over a fresh WS FROM THE PAGE.
  const ourPayload = {
    source: "officeweb",
    optionsSets: [],
    streamingMode: "ConciseWithPadding",
    spokenTextMode: "None",
    options: {},
    extraExtensionParameters: {},
    allowedMessageTypes: ["Chat", "Suggestion", "InternalSearchQuery", "Disengaged", "InternalLoaderMessage", "Progress", "RenderCardRequest", "SemanticSerp", "GenerateContentQuery", "SearchQuery", "ConfirmationCard", "DeveloperLogs", "EndOfRequest", "ReferencesListComplete", "GeneratedCode"],
    sliceIds: [],
    threadLevelGptId: agentId ? { id: agentId, source: "MOS3" } : {},
    traceId: crypto.randomUUID(),
    isStartOfSession: true,
    message: { author: "user", inputMethod: "Keyboard", text: framingText, entityAnnotationTypes: ["People", "File", "Event", "Email", "TeamsMessage"], locale: "en-gb", messageType: "Chat", experienceType: "Default", adaptiveCards: [], clientPreferences: {} },
    ...(agentId ? { gpts: [{ id: agentId, source: "MOS3", version: "1.0.0", clientOverrides: { capabilities: [], "deepResearchModels@odata.type": "Collection(String)" } }] } : { plugins: [{ Id: "BingWebSearch", Source: "BuiltIn" }] }),
    isSbsSupported: true,
    tone: "magic",
    disconnectBehavior: "continue",
  };

  const result = await page.evaluate(async ({ baseUrl, payload }) => {
    // Fresh conversation/request ids; keep the GUI's token + other query params.
    const u = new URL(baseUrl);
    const cid = crypto.randomUUID(), rid = crypto.randomUUID();
    u.searchParams.set("ConversationId", cid);
    u.searchParams.set("chatsessionid", rid);
    u.searchParams.set("clientrequestid", rid);
    u.searchParams.set("X-SessionId", crypto.randomUUID());
    const RS = String.fromCharCode(0x1e);
    return await new Promise((resolve) => {
      const frames = []; let disengaged = false, botText = "", handshook = false, settled = false;
      const ws = new WebSocket(u.toString());
      const done = (err) => { if (settled) return; settled = true; try { ws.close(); } catch {} resolve({ frames: frames.slice(0, 50), disengaged, botText, err: err || null, frameCount: frames.length }); };
      const t = setTimeout(() => done("timeout"), 35000);
      ws.onopen = () => ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
      ws.onerror = (e) => done("wserror");
      ws.onmessage = (ev) => {
        for (const f of String(ev.data).split(RS)) {
          if (!f) continue; let p; try { p = JSON.parse(f); } catch { continue; }
          if (!handshook) { handshook = true;
            ws.send(JSON.stringify({ arguments: [payload], invocationId: "0", target: "chat", type: 4 }) + RS + JSON.stringify({ arguments: [{ Timestamps: {} }], target: "Metrics", type: 1 }) + RS);
            continue;
          }
          frames.push(p);
          const s = JSON.stringify(p);
          if (/"messageType":"Disengaged"|Conversation disengaged/.test(s)) disengaged = true;
          const m = s.match(/"text":"((?:[^"\\]|\\.){0,120})/); if (m && m[1].length > botText.length) botText = m[1];
          if (p.type === 2 || p.type === 3) { clearTimeout(t); done(null); }
        }
      };
    });
  }, { baseUrl: chathubUrl, payload: ourPayload });

  writeFileSync(join(OUT, "emulate-result.json"), JSON.stringify({ agentId, result }, null, 2));
  console.log(`\n[emu] === RESULT (our payload via GUI context) ===`);
  console.log(`[emu] disengaged=${result.disengaged}  frames=${result.frameCount}  err=${result.err}`);
  console.log(`[emu] botText="${result.botText.slice(0, 100)}"`);
  console.log(result.disengaged
    ? "[emu] -> our PAYLOAD (the agent) Disengages even in the GUI's own context => connection/token is NOT the difference."
    : "[emu] -> our payload did NOT disengage in GUI context => our proxy's CONNECTION (token/headers/params) is the difference, not the agent!");
} catch (e) { console.log("[emu] ERR", e.message); }
await browser.close();
