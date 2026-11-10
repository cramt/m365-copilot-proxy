#!/usr/bin/env node
// H39b (docs/hypotheses.md §39): does an agent-less turn with M365's Bing plugin
// return sources a harness can use? Sends ONE web-search question through the
// proxy (tool-less, so agent-less with plugins:[BingWebSearch]), then reads that
// turn's frame dump and reports:
//   - every bot message type seen (InternalSearchQuery, SearchQuery, …) and the
//     queries M365 ran;
//   - sourceAttributions: how many, their keys, the first few entries;
//   - how the answer cites them: private-use markers (\uE200cite\uE202…\uE201),
//     [^n^] / [n] markers, Markdown links.
// Costs one M365 conversation. The proxy must run with M365_DUMP_FRAMES=1 (and
// M365_DEBUG=1); pass --frames if it uses M365_FRAME_DIR. --from-dump=<file.ndjson>
// re-reads an existing dump instead, without sending anything.
//
//   node scripts/search-citations-probe.mjs [--proxy=http://127.0.0.1:4143] [--model=claude-sonnet]
//        [--query="the latest stable Node.js release"] [--frames=<dir>] [--out=<file.json>]
//   node scripts/search-citations-probe.mjs --from-dump=~/.config/opencode-m365/frames/<requestId>.ndjson
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? "true"] : [a, "true"];
}));
const proxy = (args.proxy ?? "http://127.0.0.1:4143").replace(/\/$/, "");
const model = args.model ?? "claude-sonnet";
const query = args.query ?? "the latest stable Node.js release and its release date";
const frames = args.frames ?? path.resolve(os.homedir(), ".config", "opencode-m365", process.env.M365_FRAME_DIR || "frames");

const PRIVATE_USE_CITE = /\uE200cite\uE202([^\uE201]*)\uE201/g;
const CARET_CITE = /\[\^(\d+)\^\]/g;
const MARKDOWN_LINK = /(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Every bot message in a frame: update frames (arguments[].messages) and the final item. */
function botMessages(frame) {
  const out = [];
  if (frame?.type === 1 && Array.isArray(frame.arguments)) {
    for (const a of frame.arguments) for (const m of a?.messages ?? []) if (m?.author === "bot") out.push(m);
  }
  if (frame?.type === 2) for (const m of frame.item?.messages ?? []) if (m?.author === "bot") out.push(m);
  return out;
}

async function main() {
  const t0 = Date.now();
  let status = null;
  let answer = "";
  let dumpFiles;
  if (args["from-dump"]) {
    dumpFiles = [path.resolve(args["from-dump"].replace(/^~(?=[\\/])/, os.homedir()))];
  } else {
    const res = await fetch(`${proxy}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: `Search the web for ${query}. Answer in two sentences and cite your sources.` }],
      }),
    });
    const body = await res.json();
    status = res.status;
    answer = body?.choices?.[0]?.message?.content ?? "";
    if (!res.ok) console.warn(`[search-probe] proxy answered ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    dumpFiles = fs.existsSync(frames)
      ? fs.readdirSync(frames).filter((f) => f.endsWith(".ndjson"))
          .map((f) => ({ f: path.join(frames, f), mtime: fs.statSync(path.join(frames, f)).mtimeMs }))
          .filter((d) => d.mtime >= t0 - 1000).sort((a, b) => a.mtime - b.mtime).map((d) => d.f)
      : [];
    if (!dumpFiles.length) console.warn(`[search-probe] no frame dump in ${frames} since the request started — is the proxy running with M365_DUMP_FRAMES=1?`);
  }

  const types = {};
  const queries = [];
  let sources = [];
  let dumpAnswer = "";
  for (const file of dumpFiles) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.dir !== "recv") continue;
      for (const m of botMessages(rec.frame)) {
        const type = m.messageType ?? "(answer)";
        types[type] = (types[type] ?? 0) + 1;
        if (/SearchQuery/.test(type)) queries.push(m.hiddenText ?? m.text ?? "");
        if (!m.messageType && typeof m.text === "string" && m.text.length >= dumpAnswer.length) dumpAnswer = m.text;
        if (Array.isArray(m.sourceAttributions) && m.sourceAttributions.length >= sources.length) sources = m.sourceAttributions;
      }
    }
  }
  // The raw answer from the frames keeps any markers the proxy's response strips.
  const text = dumpAnswer || answer;

  const summary = {
    model, query: args["from-dump"] ? null : query, status, frameFiles: dumpFiles.map((f) => path.basename(f)),
    messageTypes: types,
    searchQueries: [...new Set(queries)].slice(0, 10),
    sourceAttributions: {
      count: sources.length,
      keys: [...new Set(sources.flatMap((s) => Object.keys(s ?? {})))],
      first: sources.slice(0, 3),
    },
    answer: {
      text,
      proxyResponseDiffers: !!answer && !!dumpAnswer && answer !== dumpAnswer,
      privateUseCitations: [...text.matchAll(PRIVATE_USE_CITE)].map((m) => m[1]),
      caretCitations: [...text.matchAll(CARET_CITE)].map((m) => m[1]),
      markdownLinks: [...text.matchAll(MARKDOWN_LINK)].map((m) => ({ title: m[1], url: m[2] })),
    },
  };
  const out = args.out ?? `search-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, sourceAttributions: { ...summary.sourceAttributions, first: summary.sourceAttributions.first.length } }, null, 2));
  console.log(`[search-probe] full summary in ${out}`);
}

main().catch((e) => { console.error(`[search-probe] ${e.message}`); process.exit(1); });
