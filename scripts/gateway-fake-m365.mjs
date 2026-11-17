#!/usr/bin/env node
// The real proxy (built proxy-lib + core) with the M365 turn faked, for checking
// Claude Code / Codex end to end through copilot-api without spending quota or
// threads. The fake answers like a cooperative model under shell routing: a
// ```bash block first, then "done" once a real tool result comes back. Two
// harness-check.mjs tasks get the tool they ask for instead, so their side
// requests show up too: `web-search` (a WebSearch call, an answer for Claude
// Code's search sub-request, then the URL) and `subagent` (an Agent call).
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
const { ModelSession, createLogger } = await import(dist("core"));
const { createApp } = await import(dist("proxy-lib"));
// Same `[model] run:` line the real ModelSession writes (with M365_DEBUG=1), so
// tools that read the debug log (harness-check.mjs) work on a dry run too.
const modelLog = createLogger("model");

const PORT = Number(process.argv[2] || process.env.PORT || 4143);
const OUT = process.env.OUT || path.join(process.cwd(), "gateway-fake-m365-out");
const REPLY = process.env.FAKE_REPLY || "```bash\necho hello-from-m365\n```";
const REPO_URL = "https://github.com/cramt/m365-copilot-proxy";
fs.mkdirSync(OUT, { recursive: true });
let n = 0;

/** What a cooperative model would answer. A result block the proxy wrote — not
 *  the framing's mention of one — means the tool ran. */
function fakeReply(text) {
  if (/<tool_response (?:name|tool)="WebSearch"/.test(text)) return REPO_URL;
  if (/<tool_response (?:name|tool)=/.test(text)) return "done";
  if (text.includes("Perform a web search for the query:")) return `Search results:\n1. [cramt/m365-copilot-proxy](${REPO_URL})`;
  // harness-check.mjs's task prompts, word for word (harness system prompts mention subagents too).
  if (text.includes("Use web search to find the GitHub repository")) return "```WebSearch\nquery: m365-copilot-proxy github cramt\n```";
  if (text.includes("Use a subagent (the Agent tool)")) return "```Agent\ndescription: list the files\nsubagent_type: general-purpose\nprompt: List the files in the current directory and report their names.\n```";
  return REPLY;
}

ModelSession.prototype.refreshAgent = async function () { return false; };
ModelSession.prototype.run = async function (text, model, _signal, useAgent) {
  // The real turnCount getter reads copilotSession.turnCount.
  this.copilotSession = { turnCount: (this.copilotSession?.turnCount ?? 0) + 1 };
  const disengaged = process.env.FAKE_MODE === "disengaged";
  const reply = disengaged ? "" : fakeReply(text);
  const file = path.join(OUT, `${String(++n).padStart(3, "0")}-turn.txt`);
  fs.writeFileSync(file, `model=${model} agent=${useAgent} cid=${this.conversationId} turn=${this.copilotSession.turnCount}\n--- prompt (${text.length} chars) ---\n${text}\n--- reply ---\n${disengaged ? "(Disengaged)" : reply}\n`);
  modelLog.info(`run: model=${model}, agent=fake, turn=${this.copilotSession.turnCount - 1}, sid=${this.sessionId}, cid=${this.conversationId}, text=${JSON.stringify(text.slice(0, 200))}`);
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
