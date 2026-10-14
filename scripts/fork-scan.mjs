// Did the server append every turn to the conversation? Reads proxy debug logs
// (M365_DEBUG=1; files or directories, *.debug.log / debug.log found recursively)
// and checks the server's own count of user messages after each turn, which must
// grow by one per turn on one ConversationId. A turn whose count falls short ran
// on an older copy of the conversation (docs/hypotheses.md F85).
//
//   node scripts/fork-scan.mjs ~/.config/opencode-m365/debug.log
//   SHOW=1 node scripts/fork-scan.mjs <dir>     # one line per conversation
//
// Turns are joined across files by ConversationId, in path order, so a session
// logged one file per request reads as one conversation. A conversation first
// seen mid-way is anchored on its first count. Also compares the turns that ran
// on an older copy with the rest: how often the model repeated a tool call it had
// already made for the same request, and reasoned about "mismatched" responses.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const files = [];
const walk = (p) => {
  let st; try { st = statSync(p); } catch { return; }
  if (st.isFile()) { files.push(p); return; }
  let names; try { names = readdirSync(p); } catch { return; }
  for (const n of names) {
    if (/^(?:appdata|node_modules|\.git)$/i.test(n)) continue;
    const q = join(p, n);
    let s; try { s = statSync(q); } catch { continue; }
    if (s.isDirectory()) walk(q); else if (/debug\.log$/.test(n)) files.push(q);
  }
};
process.argv.slice(2).forEach(walk);
files.sort();

const MISMATCH = /mismatch|unexpected|instead of|glitch|discrepanc|didn.t run|out of context/i;
const convs = new Map(); // cid -> { file, counts, calls, offset }
const turns = { on: { n: 0, calls: 0, repeats: 0, cot: 0 }, off: { n: 0, calls: 0, repeats: 0, cot: 0 } };
for (const f of files) {
  let cid = null, conv = null, t = null;
  const flush = () => {
    if (!t) return;
    if (t.count === null) { conv.offset -= 1; return; } // no count (throttled, failed): the server took no message
    if (conv.offset === null) conv.offset = t.count - t.pos;
    t.behind = t.count < t.pos + conv.offset;
    conv.counts.push(t.behind ? `${t.count}*` : String(t.count));
    const w = turns[t.behind ? "off" : "on"];
    w.n++; if (t.cot) w.cot++;
    if (t.call) { w.calls++; if (conv.calls.has(t.call)) w.repeats++; conv.calls.add(t.call); }
  };
  let newRequest = false;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const run = line.match(/\[model\] run: .*?cid=([0-9a-f-]+)/);
    if (run) cid = run[1];
    // A new request (a delta that opens with the user's message): calls repeated
    // from an earlier request are legitimate (re-run the tests, re-read an edited file).
    if (/Formatted prompt: <user>/.test(line)) newRequest = true;
    if (/Chat turn \d+:/.test(line)) {
      flush();
      if (!convs.has(cid)) convs.set(cid, { file: f, counts: [], calls: new Set(), offset: null, sent: 0 });
      conv = convs.get(cid);
      if (newRequest) { conv.calls.clear(); newRequest = false; }
      t = { pos: ++conv.sent, count: null, call: null, cot: false };
      continue;
    }
    if (!t) continue;
    const tc = line.match(/"turnCount":(\d+)/);
    if (tc) t.count = +tc[1];
    const call = line.match(/\[handler\] Tool call: (.*)$/);
    if (call && !t.call) t.call = call[1].trim();
    if (line.includes('"addToChainOfThought":true') && MISMATCH.test(line)) t.cot = true;
  }
  flush();
}

const multi = [...convs.values()].filter((c) => c.counts.length >= 3);
const forked = multi.filter((c) => c.counts.some((n) => n.endsWith("*")));
if (process.env.SHOW) for (const c of multi) console.log(`${c.counts.join(",")}${forked.includes(c) ? "  FORKED" : ""}  ${c.file}`);
const pct = (a, b) => `${a}/${b} (${Math.round((100 * a) / Math.max(1, b))}%)`;
console.log(`${files.length} logs, ${multi.length} conversations with 3+ turns, forked: ${pct(forked.length, multi.length)}`);
console.log(`turns on an older copy (* above): ${pct(turns.off.n, turns.off.n + turns.on.n)}`);
for (const [w, s] of Object.entries(turns)) {
  console.log(`  ${w === "on" ? "on the full thread" : "on an older copy  "}: repeated an earlier tool call ${pct(s.repeats, s.calls)}, 'mismatch' reasoning ${pct(s.cot, s.n)}`);
}
