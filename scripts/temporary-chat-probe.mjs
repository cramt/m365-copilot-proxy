// H-TEMPCHAT: `disableMemory=1` on the Chathub URL gives a *temporary* chat —
// multi-turn context still works on the live ConversationId, but the thread is
// never added to the Copilot history sidebar.
//
// Two falsifiable halves, run separately because the second needs a browser:
//
//   node scripts/temporary-chat-probe.mjs            # context retention + send A/B markers
//   node scripts/temporary-chat-probe.mjs --sidebar  # then: is the temporary one listed?
//
// Falsification: turn 2 forgets a fact from turn 1 (half 1), or the temporary
// conversation shows up in the sidebar (half 2).
//
// Cost: one conversation of two messages, plus two single-turn conversations.
// That is the cheap profile — the throttle tracks threads started, not messages.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelSession, loadSecrets } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "gui-capture-out");
const MAGIC = "plum-harbor-77";
const TEMP_MARKER = "alpha-marker";
const SAVED_MARKER = "beta-marker";

async function say(session, text) {
  const stream = await session.run(text, "m365-copilot", undefined, false);
  let out = "";
  for await (const d of stream) out += d;
  return (stream.fullText && stream.fullText.length > out.length ? stream.fullText : out).trim();
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes("--sidebar")) {
  const creds = loadSecrets();
  if (!creds) { console.log("no secrets — cannot drive the GUI"); process.exit(1); }
  mkdirSync(OUT, { recursive: true });
  const ROOT = process.cwd();
  const pwMod = await import(`${ROOT}/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js`);
  const chromium = pwMod.chromium ?? pwMod.default?.chromium;
  const { TOTP } = await import(`${ROOT}/node_modules/.pnpm/otpauth@9.5.0/node_modules/otpauth/dist/otpauth.esm.js`);

  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  const fill = async (sel, val) => { const l = page.locator(`${sel}:visible`).first(); await l.waitFor({ state: "visible", timeout: 30000 }); await l.fill(val); };
  const submit = () => page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  try {
    await page.goto("https://m365.cloud.microsoft/chat/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    if (/login\.microsoftonline|oauth2|signin|\/login/i.test(page.url())) {
      await fill('input[name="loginfmt"]', creds.email); await submit(); await page.waitForTimeout(2500);
      await fill('input[name="passwd"]', creds.password); await submit(); await page.waitForTimeout(2500);
      try { await fill('input[name="otc"]', new TOTP({ secret: creds.mfaSecret }).generate()); await submit(); await page.waitForTimeout(2500); } catch {}
      try { await page.locator("#idSIButton9:visible").click({ timeout: 8000 }); } catch {}
    }
    await page.waitForTimeout(8000);
    for (const sel of ['button[aria-label*="hat history" i]', 'button[aria-label*="istory" i]', 'button[aria-label*="ecent" i]']) {
      try { const l = page.locator(sel).first(); if (await l.count()) { await l.click({ timeout: 4000 }); await page.waitForTimeout(3500); break; } } catch {}
    }
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    writeFileSync(join(OUT, "sidebar.txt"), text);
    await page.screenshot({ path: join(OUT, "sidebar.png"), fullPage: true }).catch(() => {});
    const hasTemp = new RegExp(TEMP_MARKER, "i").test(text);
    const hasSaved = new RegExp(SAVED_MARKER, "i").test(text);
    console.log(`  temporary chat ("${TEMP_MARKER}") listed: ${hasTemp}`);
    console.log(`  saved chat     ("${SAVED_MARKER}") listed: ${hasSaved}`);
    console.log(`  VERDICT: ${!hasTemp && hasSaved ? "CONFIRMED — disableMemory keeps it out of history"
      : hasTemp && hasSaved ? "REFUTED — the temporary chat is listed too"
      : "INCONCLUSIVE — sidebar not captured, or not yet indexed"}`);
  } catch (e) { console.log("ERR", e.message); }
  await browser.close();
} else {
  // Half 1 — context must survive across turns of one temporary conversation.
  const s = new ModelSession({ useAgent: false, temporaryChat: true });
  console.log(await say(s, `Remember this codeword exactly: ${MAGIC}. Reply with just "ok".`) && `turn1 cid=${s.conversationId}`);
  await pause(3000);
  const recall = await say(s, "What was the codeword I just gave you? Reply with only the codeword.");
  const retained = recall.toLowerCase().includes(MAGIC);
  console.log(`turn2 <- ${recall.slice(0, 120)}`);
  console.log(`  context across turns: ${retained ? "RETAINED" : "LOST"}`);

  // Half 2, part A — leave one marker in each mode for --sidebar to look for.
  await pause(4000);
  const t = new ModelSession({ useAgent: false, temporaryChat: true });
  await say(t, `Say the word ${TEMP_MARKER} and nothing else.`);
  console.log(`temporary marker sent  cid=${t.conversationId}`);
  await pause(4000);
  const v = new ModelSession({ useAgent: false, temporaryChat: false });
  await say(v, `Say the word ${SAVED_MARKER} and nothing else.`);
  console.log(`saved marker sent      cid=${v.conversationId}`);
  console.log(`\nNow run:  node scripts/temporary-chat-probe.mjs --sidebar`);
  process.exit(retained ? 0 : 1);
}
