#!/usr/bin/env node
// RE probe: the tones and titles in the web client's model selector, without a chat turn.
//
// The web client gets its model selector from POST
// https://copilot.cloud.microsoft/resources/app-shell-action with the body
// {"action":"RefreshNavPane"} (docs/hypotheses.md §62 F177, F178). The server answers with JSON
// only when the request sends `Accept: application/json`; without it, the app's HTML page. With a
// token for `https://m365.cloud.microsoft/v2/M365Copilot.Read.All`, the scope the web app's own
// sign-in asks for, the reply holds the selector. The proxy's Sydney token gets a reply that
// holds only `store.notebooks`. The proxy's MSAL client gets this token from its cached refresh
// token (`getTokenForScope`, which falls back to the same automated login as chat).
//
// Prints the items the jq filter in F177 lists, as a Markdown table with `Tone` and `Title`
// columns, one row per item, sorted by tone, each tone and title pair once:
//   | Tone        | Title    |
//   |-------------|----------|
//   | Claude_Opus | Opus 5.5 |
// The items are read from `store.bizchatAsAgentGpt` and `store.bizchatAsAgentGptWebTab`
// (`clientPreferences.modelSelectorMetadata.availableModelSelectionOptions`): an option with
// `type: "item"`, or a `type: "item"` member of an option's `itemGroup` array.
//
// Usage (inside `nix develop`; `node scripts/chathub-tones.mjs …` works too):
//   scripts/chathub-tones.mjs                 # send the request, print the items
//   scripts/chathub-tones.mjs --save          # also write the reply to scripts/chathub-tones-out/
//   scripts/chathub-tones.mjs --save=<file>   # also write the reply to <file>
//   scripts/chathub-tones.mjs <file>          # read a reply saved earlier; sends no request
//
// Cost: one HTTP request and no M365 turn. The reply also holds the account's conversation
// history list, notebooks and agents, so --save writes it with mode 0600, by default under
// scripts/*-out/ (gitignored).

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTokenForScope } from "../packages/core/dist/index.mjs";

export const APP_SHELL_ACTION_URL = "https://copilot.cloud.microsoft/resources/app-shell-action";

/** The scope the web app's own sign-in asks for. */
export const WEB_CLIENT_SCOPES = ["https://m365.cloud.microsoft/v2/M365Copilot.Read.All"];

/** The stores whose model selector the F177 jq filter reads. */
export const SELECTOR_STORES = ["bizchatAsAgentGpt", "bizchatAsAgentGptWebTab"];

const OUT_DIR = fileURLToPath(new URL("chathub-tones-out/", import.meta.url));

/** A store's `availableModelSelectionOptions` array, or null when the reply has none. */
export function selectorOptions(reply, store) {
  const options = reply?.store?.[store]?.clientPreferences?.modelSelectorMetadata?.availableModelSelectionOptions;
  return Array.isArray(options) ? options : null;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The selector's items as `{ tone, title }` rows, sorted by tone and then title, each pair once. */
export function selectorItems(reply) {
  const rows = new Map();
  for (const store of SELECTOR_STORES) {
    for (const option of selectorOptions(reply, store) ?? []) {
      const members = Array.isArray(option?.itemGroup) ? option.itemGroup : [];
      for (const item of [option, ...members]) {
        if (item?.type !== "item" || typeof item.id !== "string") continue;
        const title = typeof item.menuItemTitle === "string" ? item.menuItemTitle : "";
        rows.set(JSON.stringify([item.id, title]), { tone: item.id, title });
      }
    }
  }
  return [...rows.values()].sort((a, b) => byCodeUnits(a.tone, b.tone) || byCodeUnits(a.title, b.title));
}

/**
 * `rows` as a Markdown table with `Tone` and `Title` columns, each column padded to its widest
 * cell so that the table is aligned in a terminal. A `|` in a cell is escaped and a line break
 * becomes a space, so that every row stays one table row.
 */
export function formatTable(rows) {
  const cell = (text) => text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  const header = ["Tone", "Title"];
  const body = rows.map(({ tone, title }) => [cell(tone), cell(title)]);
  const widths = header.map((name, i) => Math.max(name.length, ...body.map((row) => row[i].length)));
  const line = (cells) => `| ${cells.map((text, i) => text.padEnd(widths[i])).join(" | ")} |`;
  const rule = `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`;
  return [line(header), rule, ...body.map(line)].join("\n");
}

/**
 * POST {"action":"RefreshNavPane"} with `token` as the bearer and return the reply's text.
 * Throws when the reply is a redirect, an HTTP error, or anything other than JSON.
 */
export async function requestNavPane(token, fetchImpl = fetch) {
  const res = await fetchImpl(APP_SHELL_ACTION_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ action: "RefreshNavPane" }),
  });
  const type = res.headers.get("content-type") || "no content type";
  if (res.status >= 300 && res.status < 400) {
    const to = new URL(res.headers.get("location") ?? "/", APP_SHELL_ACTION_URL);
    throw new Error(`HTTP ${res.status} to ${to.origin}${to.pathname}: the server did not accept the token`);
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} (${type}): ${body.slice(0, 200)}`);
  if (!/json/i.test(type)) throw new Error(`HTTP ${res.status} with ${type}, not JSON (${body.length} bytes)`);
  return body;
}

function parseArgs(argv) {
  const opts = { save: null, from: null };
  for (const arg of argv) {
    if (arg === "--save") {
      opts.save = join(OUT_DIR, `RefreshNavPane-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    } else if (arg.startsWith("--save=")) {
      opts.save = arg.slice("--save=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}. Usage: scripts/chathub-tones.mjs [--save[=<file>]] [<saved reply>]`);
    } else {
      opts.from = arg;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let body;
  if (opts.from) {
    body = readFileSync(opts.from, "utf8");
  } else {
    const token = await getTokenForScope(WEB_CLIENT_SCOPES);
    if (!token) {
      throw new Error(`No token for ${WEB_CLIENT_SCOPES.join(" ")}: sign the proxy in first (README, Setup step 2)`);
    }
    body = await requestNavPane(token);
  }
  if (opts.save) {
    mkdirSync(dirname(opts.save), { recursive: true });
    writeFileSync(opts.save, body, { mode: 0o600 });
    console.error(`Saved the reply to ${opts.save}`);
  }
  let reply;
  try {
    reply = JSON.parse(body);
  } catch (error) {
    throw new Error(`${opts.from ?? "The reply"} is not JSON: ${error.message}`);
  }
  const missing = SELECTOR_STORES.filter((store) => !selectorOptions(reply, store));
  if (missing.length) {
    const has = Object.keys(reply?.store ?? {}).join(", ") || "nothing";
    console.error(`No model selector in ${missing.map((s) => `store.${s}`).join(" or ")}; the store holds: ${has}`);
  }
  const rows = selectorItems(reply);
  if (!rows.length) {
    console.error("The reply lists no selector items");
    process.exitCode = 1;
    return;
  }
  console.log(formatTable(rows));
}

/** Whether Node runs this file as its main script, also when started through a symlink. */
function runAsMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (runAsMain()) {
  try {
    await main();
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
