#!/usr/bin/env node
// Builds a Codex model catalog (`model_catalog_json`) from copilot-api's own Codex catalog, so the
// Codex app lists the gateway's M365 models, Claude included, with the context windows you choose.
// Without a catalog the app lists only the GPT models it ships with (hypotheses §41 F114).
//
// Usage:
//   node scripts/codex-catalog.mjs [--gateway=http://127.0.0.1:4141] [--window=N]
//                                  [--out=~/.codex/m365-models.json] (--all [MODEL=WINDOW ...] | MODEL[=WINDOW] ...)
//   node scripts/codex-catalog.mjs --all --out=~/.codex/m365-models.json
//   node scripts/codex-catalog.mjs --out=~/.codex/m365-models.json \
//     m365/gpt-6.1-sol m365/claude-sonnet-5 m365/claude-opus
//
// --all lists every model the gateway advertises on /v1/models that its Codex catalog offers, in the
// gateway's order, each with the window the gateway advertises for it (the proxy's
// M365_CONTEXT_WINDOW), else its catalog window. Otherwise MODEL is a copilot-api model ID, the picker
// keeps the order given, and each model gets --window (default 1,000,000). `MODEL=WINDOW` gives one
// model its own window, and --window gives every model one under --all too. Codex counts 95% of a
// window as usable and compacts at 90% of it. Point a top-level `model_catalog_json` at the file; it is
// then the catalog for every Codex provider.
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const isWindow = (n) => Number.isSafeInteger(n) && n > 0;
const gateway = option("gateway", "http://127.0.0.1:4141").replace(/\/+$/, "");
const windowOption = option("window");
const defaultWindow = Number(windowOption ?? "1000000");
const out = option("out")?.replace(/^~(?=$|[\\/])/, homedir());
const all = args.includes("--all");
const named = args.filter((a) => !a.startsWith("--"));

if ((!all && named.length === 0) || (all && named.some((a) => !a.includes("="))) || !isWindow(defaultWindow)) {
  console.error("usage: node scripts/codex-catalog.mjs [--gateway=URL] [--window=N] [--out=FILE] (--all [MODEL=WINDOW ...] | MODEL[=WINDOW] ...)");
  process.exit(2);
}

async function getJson(path, headers) {
  const url = `${gateway}${path.split("?")[0]}`;
  const res = await fetch(`${gateway}${path}`, { headers }).catch((error) => fail(`${url}: ${error.cause?.code ?? error.message}`));
  if (!res.ok) fail(`${url}: HTTP ${res.status}`);
  return res.json().catch(() => null);
}

// copilot-api answers /models with its Codex catalog only for a Codex User-Agent. By default it caps
// the catalog at 1 MiB and drops some models by name; x-full-model-catalog returns all of it.
const models = (await getJson("/models?client_version=0.169.0", {
  "User-Agent": "codex_cli_rs/0.169.0",
  "x-full-model-catalog": "true",
}))?.models;
if (!Array.isArray(models)) fail(`${gateway}/models didn't return a Codex catalog; is it copilot-api?`);
const bySlug = new Map(models.filter((m) => typeof m?.slug === "string").map((m) => [m.slug, m]));

let wanted = named;
const discovered = new Map();
if (all) {
  // /v1/models lists what the gateway routes. Its Codex catalog leaves out what Codex can't drive
  // (image, embedding and tool-less models) and adds the upstream models Codex ships with.
  const data = (await getJson("/v1/models"))?.data;
  if (!Array.isArray(data)) fail(`${gateway}/v1/models didn't return a model list`);
  for (const model of data) {
    if (typeof model?.id === "string" && model.id && !discovered.has(model.id)) discovered.set(model.id, model);
  }
  const offered = [...discovered.keys()].filter((id) => bySlug.has(id));
  const skipped = [...discovered.keys()].filter((id) => !bySlug.has(id));
  if (skipped.length > 0) console.error(`skipped, not in the gateway's Codex catalog: ${skipped.join(", ")}`);
  const overrides = new Map(named.map((arg) => arg.split("=")));
  for (const slug of overrides.keys()) {
    if (!offered.includes(slug)) fail(`${slug} isn't one of the gateway's Codex models`);
  }
  wanted = offered.map((id) => (overrides.has(id) ? `${id}=${overrides.get(id)}` : id));
  if (wanted.length === 0) fail("The gateway didn't advertise any model its Codex catalog offers");
}

const picked = [];
for (const [i, arg] of wanted.entries()) {
  const [slug, ownWindow] = arg.split("=");
  const entry = bySlug.get(slug);
  if (!entry) fail(`${slug} isn't in copilot-api's Codex catalog (provider models appear as provider/model)`);
  // A catalog entry copied from an upstream model of the same name (m365/gpt-6.1-sol) carries that
  // model's window, not the route's, so the gateway's advertised window comes first.
  const gatewayWindow = [discovered.get(slug)?.context_window, entry.context_window].find((n) => isWindow(n));
  const window =
    ownWindow !== undefined
      ? Number(ownWindow)
      : all && windowOption === undefined && gatewayWindow
        ? gatewayWindow
        : defaultWindow;
  if (!isWindow(window)) fail(`${slug}: context window must be a positive integer`);
  picked.push({ ...entry, context_window: window, max_context_window: window, priority: i + 1, visibility: "list" });
}

const json = `${JSON.stringify({ models: picked }, null, 2)}\n`;
if (out) {
  writeFileSync(out, json);
  console.error(`wrote ${picked.length} models to ${out}`);
} else {
  process.stdout.write(json);
}
