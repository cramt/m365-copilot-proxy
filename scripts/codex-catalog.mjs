#!/usr/bin/env node
// Builds a Codex model catalog (`model_catalog_json`) from copilot-api's own Codex catalog, so the
// Codex app lists the gateway's M365 models, Claude included, with the context windows you choose.
// Without a catalog the app lists only the GPT models it ships with (hypotheses §41 F114).
//
// Usage:
//   node scripts/codex-catalog.mjs [--gateway=http://127.0.0.1:4141] [--window=1000000]
//                                  [--out=~/.codex/m365-models.json] MODEL[=WINDOW] ...
//   node scripts/codex-catalog.mjs --out=~/.codex/m365-models.json \
//     m365/gpt-6.1-sol m365/claude-sonnet-5 m365/claude-opus
//
// MODEL is a copilot-api model ID; `=WINDOW` gives that model its own context window. The picker
// keeps the order given. Codex counts 95% of a window as usable and compacts at 90% of it. Point a
// top-level `model_catalog_json` at the file; it is then the catalog for every Codex provider.
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
};
const gateway = option("gateway", "http://127.0.0.1:4141").replace(/\/+$/, "");
const defaultWindow = Number(option("window", "1000000"));
const out = option("out")?.replace(/^~(?=$|[\\/])/, homedir());
const wanted = args.filter((a) => !a.startsWith("--"));

if (wanted.length === 0 || !Number.isFinite(defaultWindow)) {
  console.error("usage: node scripts/codex-catalog.mjs [--gateway=URL] [--window=N] [--out=FILE] MODEL[=WINDOW] ...");
  process.exit(2);
}

// copilot-api answers /models with its Codex catalog only for a Codex User-Agent.
const res = await fetch(`${gateway}/models?client_version=0.169.0`, {
  headers: { "User-Agent": "codex_cli_rs/0.169.0" },
});
if (!res.ok) {
  console.error(`${gateway}/models: HTTP ${res.status}`);
  process.exit(1);
}
const { models } = await res.json();
if (!Array.isArray(models)) {
  console.error(`${gateway}/models didn't return a Codex catalog; is it copilot-api?`);
  process.exit(1);
}
const bySlug = new Map(models.map((m) => [m.slug, m]));

const picked = [];
for (const [i, arg] of wanted.entries()) {
  const [slug, ownWindow] = arg.split("=");
  const entry = bySlug.get(slug);
  if (!entry) {
    console.error(`${slug} isn't in copilot-api's Codex catalog (provider models appear as provider/model)`);
    process.exit(1);
  }
  const window = ownWindow ? Number(ownWindow) : defaultWindow;
  picked.push({ ...entry, context_window: window, max_context_window: window, priority: i + 1, visibility: "list" });
}

const json = `${JSON.stringify({ models: picked }, null, 2)}\n`;
if (out) {
  writeFileSync(out, json);
  console.error(`wrote ${picked.length} models to ${out}`);
} else {
  process.stdout.write(json);
}
