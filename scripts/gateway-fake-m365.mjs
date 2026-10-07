#!/usr/bin/env node
// The real proxy (built proxy-lib + core) with the M365 turn faked, for checking
// Claude Code / Codex end to end through copilot-api without spending quota or
// threads. The fake answers like a cooperative model under shell routing: a
// ```bash block first, then "done" once a real tool result comes back.
//
//   pnpm build                                  # proxy-lib and core dist
//   node scripts/gateway-fake-m365.mjs [port]   # default 4143
//   FAKE_MODE=disengaged node scripts/gateway-fake-m365.mjs   # every turn Disengages
//
// Every prompt the proxy would have sent to M365 is written to $OUT
// (default ./gateway-fake-m365-out/) as NNN-turn.txt. See docs/claude-code-codex.md.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (pkg) => pathToFileURL(path.join(root, "packages", pkg, "dist", "index.mjs")).href;
const { ModelSession } = await import(dist("core"));
const { createApp } = await import(dist("proxy-lib"));

const PORT = Number(process.argv[2] || process.env.PORT || 4143);
const OUT = process.env.OUT || path.join(process.cwd(), "gateway-fake-m365-out");
const REPLY = process.env.FAKE_REPLY || "```bash\necho hello-from-m365\n```";
fs.mkdirSync(OUT, { recursive: true });
let n = 0;

ModelSession.prototype.refreshAgent = async function () { return false; };
ModelSession.prototype.run = async function (text, model, _signal, useAgent) {
  // The real turnCount getter reads copilotSession.turnCount.
  this.copilotSession = { turnCount: (this.copilotSession?.turnCount ?? 0) + 1 };
  const disengaged = process.env.FAKE_MODE === "disengaged";
  // A result block the proxy wrote, not the framing's mention of one.
  const reply = disengaged ? "" : /<tool_response (?:name|tool)=/.test(text) ? "done" : REPLY;
  const file = path.join(OUT, `${String(++n).padStart(3, "0")}-turn.txt`);
  fs.writeFileSync(file, `model=${model} agent=${useAgent} cid=${this.conversationId} turn=${this.copilotSession.turnCount}\n--- prompt (${text.length} chars) ---\n${text}\n--- reply ---\n${disengaged ? "(Disengaged)" : reply}\n`);
  console.log(`[fake-m365] turn ${n}: ${model}, prompt ${text.length} chars -> ${disengaged ? "Disengaged" : JSON.stringify(reply.slice(0, 40))}`);
  return {
    fullText: reply, hasContent: reply.length > 0, result: { value: "Success" }, metering: null, images: [],
    throttle: { current: this.copilotSession.turnCount, max: 600 }, contentOrigin: "fake",
    messageType: disengaged ? "Disengaged" : null, messageId: `m${n}`, scores: null,
    turnCount: this.copilotSession.turnCount, turnState: "Completed",
    async *[Symbol.asyncIterator]() { if (reply) yield reply; },
  };
};

const app = createApp();
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]));
  const response = await app.fetch(new Request(`http://127.0.0.1:${PORT}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) for await (const chunk of response.body) res.write(chunk);
  res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`[fake-m365] proxy with a fake M365 on http://127.0.0.1:${PORT}, prompts in ${OUT}`));
