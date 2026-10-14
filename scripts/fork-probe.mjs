// H-FORK: does M365 append every turn of a conversation to ONE thread?
//
// The proxy opens a fresh WebSocket per turn on a reused ConversationId. In the
// debug logs of real pi runs, the server's turnCount after each turn often steps
// BACK (1,2,3,2,4,5,3,6,…): the turn ran on an older state of the conversation,
// so the model did not see some of the earlier turns.
//
// Each message carries a fresh word and asks for every word given so far, so the
// reply shows which earlier messages the model can see; turnCount shows where on
// the thread the server ran the turn. Arms:
//   unpinned — temporary chat, no routing key (the proxy before the fix)
//   saved    — saved chat, no routing key (is disableMemory=1 the cause? no: F85)
//   pinned   — temporary chat + X-RoutingParameter-SessionKey (the fix)
//
//   ARMS=pinned,unpinned node scripts/fork-probe.mjs   # CONVS=3 TURNS=6 MODEL=gpt-5.6-think-deeper AGENT=1
//
// Falsification: pinned conversations fork as often as unpinned ones.
// Cost: arms × CONVS threads of TURNS messages. Saved conversations appear in the
// account's Copilot history.
import { ModelSession } from "../packages/core/dist/index.mjs";

const MODEL = process.env.MODEL ?? "gpt-5.6-think-deeper";
const CONVS = Number(process.env.CONVS ?? 3);
const TURNS = Number(process.env.TURNS ?? 6);
const AGENT = process.env.AGENT !== "0";
const ARM_DEFS = {
  unpinned: { temporaryChat: true, pin: false },
  saved: { temporaryChat: false, pin: false },
  pinned: { temporaryChat: true, pin: true },
};
const ARMS = (process.env.ARMS ?? "pinned,unpinned").split(",").map((a) => a.trim());
for (const a of ARMS) if (!ARM_DEFS[a]) throw new Error(`unknown arm ${a} (have ${Object.keys(ARM_DEFS).join(", ")})`);
const POOL = ["copper", "lantern", "meadow", "violet", "harbor", "pepper", "falcon", "marble", "cedar", "quartz",
  "ember", "willow", "saffron", "glacier", "thimble", "orchid", "basalt", "kettle", "juniper", "cobalt",
  "walnut", "sparrow", "canyon", "velvet", "pebble", "lagoon", "maple", "tundra", "garnet", "biscuit"];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (n) => [...POOL].sort(() => Math.random() - 0.5).slice(0, n);

async function turn(session, text) {
  const stream = await session.run(text, MODEL, undefined, AGENT);
  let out = "";
  for await (const d of stream) out += d;
  const answer = (stream.fullText && stream.fullText.length > out.length ? stream.fullText : out).trim();
  return { answer, turnCount: stream.turnCount, result: stream.result?.value ?? null };
}

const rows = [];
outer:
for (let c = 0; c < CONVS; c++) {
  for (const arm of c % 2 ? [...ARMS].reverse() : ARMS) {
    if (ARM_DEFS[arm].pin) delete process.env.M365_NO_SESSION_ROUTING;
    else process.env.M365_NO_SESSION_ROUTING = "1";
    const s = new ModelSession({ temporaryChat: ARM_DEFS[arm].temporaryChat });
    const words = pick(TURNS);
    const counts = [], seen = [];
    for (let k = 1; k <= TURNS; k++) {
      const text = `Memory check ${k}/${TURNS}. My word for this message is "${words[k - 1]}". Reply with every word I have given you in this conversation so far, in the order I gave them, separated by single spaces, and nothing else.`;
      const r = await turn(s, text);
      if (r.result === "Throttled") { console.log(`THROTTLED at ${arm} conv ${c + 1} turn ${k} — stopping`); break outer; }
      const got = words.slice(0, k).map((w) => (r.answer.toLowerCase().includes(w) ? "1" : "0")).join("");
      counts.push(r.turnCount); seen.push(got);
      console.log(`${arm.padEnd(9)} conv ${c + 1} turn ${k}  turnCount ${String(r.turnCount).padStart(2)}  sees ${got.padEnd(TURNS)}  ${JSON.stringify(r.answer.slice(0, 80))}`);
      await pause(150); // about the gap a harness leaves after an instant tool
    }
    rows.push({ arm, conv: c + 1, cid: s.conversationId, counts, seen });
    await pause(20_000);
  }
}

console.log("\n=== SUMMARY ===");
for (const arm of ARMS) {
  const g = rows.filter((r) => r.arm === arm);
  const forked = g.filter((r) => r.counts.some((n, i) => n !== i + 1)).length;
  const turns = g.reduce((a, r) => a + r.counts.length, 0);
  const behind = g.reduce((a, r) => a + r.counts.filter((n, i) => n !== i + 1).length, 0);
  const blind = g.reduce((a, r) => a + r.seen.filter((x) => x.includes("0")).length, 0);
  console.log(`${arm.padEnd(9)} conversations forked ${forked}/${g.length}; turns off the thread ${behind}/${turns}; replies missing a word ${blind}/${turns}`);
  for (const r of g) console.log(`  conv ${r.conv}: turnCount ${r.counts.join(",")}  sees ${r.seen.join(" ")}`);
}
