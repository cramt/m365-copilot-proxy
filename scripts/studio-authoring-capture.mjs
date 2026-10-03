// Headed portal capture: drive copilotstudio.microsoft.com in your installed Edge,
// sign in BY HAND (no secrets.json on this box — interactive login), then navigate
// the UI while this records every Copilot Studio authoring / Power Platform API
// call — method, full URL, host, path, and token audience/scopes. Goal: discover
// the REAL `minimalBots`-equivalent (list/create agent) host+path for a PRODUCTION
// tenant, which the dogfood-hardcoded agent.ts can't reach.
//
// Read-only by design: it only OBSERVES traffic. (If you click Create in the UI to
// capture the create call, that's your action, not the script's.)
//
// Results are written incrementally to scripts/studio-capture-out/calls.json so they
// can be inspected mid-session. Usage: node scripts/studio-authoring-capture.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "scripts", "studio-capture-out");
mkdirSync(OUT, { recursive: true });

const ROOT = process.cwd();
const pwMod = await import(
  `${ROOT}/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js`
);
const chromium = pwMod.chromium ?? pwMod.default?.chromium;

function jwt(auth) {
  try {
    const t = auth.replace(/^Bearer\s+/i, "");
    const p = JSON.parse(
      Buffer.from(
        t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/") + "==",
        "base64",
      ).toString(),
    );
    return { aud: p.aud, scp: p.scp, appid: p.appid };
  } catch {
    return null;
  }
}

// Hosts/paths worth recording — Power Platform / Copilot Studio / PVA authoring.
const INTERESTING =
  /powerplatform\.com|island\.powerapps\.com|powervamg|powerva|botmanagement|copilotstudio|minimalBots|\/bots|\/gpt|api\.bap|api\.powerapps|environment\.api|\/environments/i;
// The calls that most likely ARE the authoring (list/create agent) API.
const HOT = /minimalBots|botmanagement|\/bots\b|\/gpt\b|\/agents?\b|botComponent|publish/i;

const calls = new Map();
const outFile = join(OUT, "calls.json");

function flush() {
  writeFileSync(outFile, JSON.stringify([...calls.values()], null, 2));
}

function record(req) {
  const u = req.url();
  if (!INTERESTING.test(u)) return;
  const key = req.method() + " " + u.split("?")[0];
  if (calls.has(key)) return;
  const auth = req.headers()["authorization"];
  let host = "";
  let path = "";
  try {
    const parsed = new URL(u);
    host = parsed.host;
    path = parsed.pathname;
  } catch {
    /* ignore */
  }
  const rec = {
    method: req.method(),
    url: u,
    host,
    path,
    hot: HOT.test(u),
    token: auth ? jwt(auth) : null,
  };
  calls.set(key, rec);
  flush();
  console.log(
    `${rec.hot ? "[*]" : "[ ]"} ${req.method()} ${host}${path}${rec.token ? "  aud=" + rec.token.aud : ""}`,
  );
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: false,
  args: ["--disable-dev-shm-usage"],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("request", record);

console.log("\n=== STUDIO AUTHORING CAPTURE (headed Edge) ===");
console.log("In the browser window that just opened:");
console.log("  1. Sign in to your M365 account (MFA as usual).");
console.log("  2. Wait for the Copilot Studio home to finish loading.");
console.log("  3. Click 'Agents' in the left nav to LIST agents.");
console.log("  4. Click '+ New agent' / 'Create' (you can cancel before finishing).");
console.log("Calls are printed below and saved live to:");
console.log(`  ${outFile}`);
console.log("Lines marked [*] are the likely authoring API. Leave the browser open;");
console.log("tell the assistant when you've reached/created an agent.\n");

const save = () => {
  flush();
  const arr = [...calls.values()];
  const hot = arr.filter((c) => c.hot);
  console.log(`\n=== ${arr.length} calls saved (${hot.length} authoring-likely) → ${outFile} ===`);
  for (const c of hot) console.log(`  ${c.method} ${c.host}${c.path}  aud=${c.token?.aud ?? "-"}`);
};

process.on("SIGINT", async () => {
  save();
  await browser.close().catch(() => {});
  process.exit(0);
});
ctx.on("close", () => {
  save();
  process.exit(0);
});

await page
  .goto("https://copilotstudio.microsoft.com/", { waitUntil: "domcontentloaded", timeout: 60000 })
  .catch((e) => console.log("goto err", e.message));

// Keep alive up to 15 minutes for the manual flow; calls.json is saved live regardless.
await new Promise((r) => setTimeout(r, 15 * 60 * 1000));
save();
await browser.close().catch(() => {});
