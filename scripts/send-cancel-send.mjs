// RE probe: does "send → cancel → send" work, and what does the cancel cost?
//
// Replicates the real UI Stop button (captured: it sends
// {"type":1,"target":"stop","invocationId":"1","arguments":[{}]} then closes)
// inside a programmatic 2-turn conversation, to answer:
//
//   Q1. Does a CANCELLED turn still count against the 600-msg/conv quota?
//       (compare numUserMessagesInConversation across turns)
//   Q2. Does context survive the cancel? We plant a secret in turn 1, cancel
//       mid-generation, then in turn 2 ask the model to recall it.
//   Q3. Does the model's PARTIAL (cancelled) answer persist as context too?
//
// Both turns share one ConversationId/sessionId (M365 keeps server-side
// context); each turn is a fresh WS with invocationId "0" like the real client.
//
// Usage: M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) node scripts/send-cancel-send.mjs [--stop-after-ms 3000]
// Cost: 2 user messages (one cancelled) in a single throwaway conversation.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getToken, decodeJwt } from "../packages/core/dist/index.mjs";

const RS = "\x1E";
import { pathToFileURL } from "node:url";
const ROOT = pathToFileURL(process.cwd()).href;
const wsMod = await import(`${ROOT}/node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs`);
const WebSocket = wsMod.default ?? wsMod.WebSocket;

const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const STOP_AFTER_MS = Number(val("--stop-after-ms", "3000"));

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "send-cancel-out", TS);
mkdirSync(OUT, { recursive: true });

const token = await getToken();
const claims = decodeJwt(token);

const SECRET = "PURPLE42";
const sessionId = crypto.randomUUID();
const conversationId = crypto.randomUUID();

function buildChat({ text, requestId, isStart }) {
  return {
    arguments: [{
      source: "officeweb", clientCorrelationId: requestId, sessionId,
      optionsSets: [], streamingMode: "ConciseWithPadding", spokenTextMode: "None",
      options: {}, extraExtensionParameters: {},
      allowedMessageTypes: ["Chat", "Suggestion", "InternalSearchQuery", "Disengaged", "Progress", "EndOfRequest", "ReferencesListComplete"],
      sliceIds: [], threadLevelGptId: {}, traceId: requestId, isStartOfSession: isStart,
      clientInfo: { clientPlatform: "mcmcopilot-web", clientAppName: "Office", clientEntrypoint: "mcmcopilot-officeweb", clientSessionId: sessionId, clientAppType: "Web", deviceOS: "Linux", deviceType: "Desktop" },
      message: { author: "user", inputMethod: "Keyboard", text, requestId, locationInfo: { timeZoneOffset: 1, timeZone: "Europe/Copenhagen" }, locale: "en-gb", messageType: "Chat", experienceType: "Default", adaptiveCards: [], clientPreferences: {} },
      plugins: [{ Id: "BingWebSearch", Source: "BuiltIn" }],
      isSbsSupported: true, tone: "magic", renderReferencesBehindEOS: true, disconnectBehavior: "continue",
    }],
    invocationId: "0", target: "chat", type: 4,
  };
}
const metrics = () => ({ arguments: [{ Timestamps: { ConnectionStart: new Date().toISOString(), UserInputStart: new Date().toISOString(), ConnectionEstablished: new Date().toISOString(), UserInputSubmit: new Date().toISOString() } }], target: "Metrics", type: 1 });
// The exact frame the real Stop button sends (captured June 13).
const STOP_FRAME = { arguments: [{}], invocationId: "1", target: "stop", type: 1 };

function runTurn({ text, isStart, cancelAfterMs }) {
  const requestId = crypto.randomUUID();
  const params = new URLSearchParams({
    chatsessionid: requestId, clientrequestid: requestId, "X-SessionId": sessionId,
    ConversationId: conversationId, access_token: token,
    variants: "feature.IsStreamingModeInChatRequestEnabled",
    source: '"officeweb"', product: "Office", agentHost: "Bizchat.FullScreen",
    licenseType: "Starter", agent: "web", scenario: "OfficeWebIncludedCopilot",
  });
  const wsUrl = `wss://substrate.office.com/m365Copilot/Chathub/${claims.oid}@${claims.tid}?${params}`;

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { "Origin": "https://m365.cloud.microsoft", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0" } });
    const t0 = Date.now();
    let handshakeDone = false, deltaText = "", snapshotText = "", throttle = null, disengaged = false, sentStop = false, stopAck = null, settled = false;
    let stopTimer = null;
    const messageTypes = new Set();

    function finish(reason) {
      if (settled) return; settled = true;
      if (stopTimer) clearTimeout(stopTimer);
      try { ws.close(); } catch {}
      const fullText = snapshotText.length >= deltaText.length ? snapshotText : deltaText;
      resolve({ fullText, throttle, disengaged, messageTypes: [...messageTypes], sentStop, stopAck, elapsedMs: Date.now() - t0, reason });
    }
    const hardTimer = setTimeout(() => finish("hard-timeout"), 60000);

    ws.on("open", () => ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS));
    ws.on("message", (data) => {
      for (const f of data.toString().split(RS).filter(Boolean)) {
        let p; try { p = JSON.parse(f); } catch { continue; }
        if (!handshakeDone) {
          handshakeDone = true;
          ws.send(JSON.stringify(buildChat({ text, requestId, isStart })) + RS + JSON.stringify(metrics()) + RS);
          if (cancelAfterMs != null) {
            stopTimer = setTimeout(() => {
              if (settled) return;
              sentStop = true;
              console.log(`   [turn] sending STOP frame at +${Date.now() - t0}ms`);
              try { ws.send(JSON.stringify(STOP_FRAME) + RS); } catch {}
              // Give the server a moment to ack/close, then end the turn.
              setTimeout(() => finish("stopped"), 4000);
            }, cancelAfterMs);
          }
          continue;
        }
        // accumulate
        const a = Array.isArray(p.arguments) ? p.arguments : [];
        for (const x of a) {
          if (!x || typeof x !== "object") continue;
          if (typeof x.writeAtCursor === "string") deltaText += x.writeAtCursor;
          if (Array.isArray(x.messages)) for (const m of x.messages) {
            if (m?.messageType) { messageTypes.add(m.messageType); if (m.messageType === "Disengaged") disengaged = true; }
            else if (m?.author === "bot" && typeof m.text === "string" && m.text.length > snapshotText.length) snapshotText = m.text;
          }
          if (x.throttling) throttle = { current: x.throttling.numUserMessagesInConversation, max: x.throttling.maxNumUserMessagesInConversation };
        }
        if (p.type === 2) {
          const it = (Array.isArray(p.item) ? p.item[0] : p.item) ?? a[0]?.item;
          if (it?.throttling) throttle = { current: it.throttling.numUserMessagesInConversation, max: it.throttling.maxNumUserMessagesInConversation };
          if (Array.isArray(it?.messages)) for (const m of it.messages) { if (!m?.messageType && m?.author === "bot" && typeof m.text === "string" && m.text.length > snapshotText.length) snapshotText = m.text; }
        }
        // Did the server respond to our stop frame? (completion w/ invocationId 1, or close)
        if (sentStop && (p.type === 3 || p.type === 7)) stopAck = { type: p.type, error: p.error ?? null };
        if (p.type === 6) ws.send(JSON.stringify({ type: 6 }) + RS);
        // If NOT cancelling, end on normal terminators.
        if (cancelAfterMs == null && (p.type === 2 || p.type === 3 || p.type === 7)) { clearTimeout(hardTimer); finish("complete"); }
      }
    });
    ws.on("error", (e) => finish("error:" + e.message));
    ws.on("close", () => finish("ws-close"));
  });
}

console.log(`[scs] conversation=${conversationId.slice(0, 8)} secret=${SECRET} stopAfter=${STOP_AFTER_MS}ms\n`);

// --- Turn 1: plant the secret, ask for a long answer, then CANCEL mid-stream.
console.log(`[scs] TURN 1 (plant secret + long gen, will cancel):`);
const t1 = await runTurn({
  isStart: true, cancelAfterMs: STOP_AFTER_MS,
  text: `Remember this secret code for later: ${SECRET}. Now, write an extremely detailed 3000-word essay about the history of medieval cathedral construction, in long continuous prose.`,
});
console.log(`   partialChars=${t1.fullText.length} throttle=${JSON.stringify(t1.throttle)} sentStop=${t1.sentStop} stopAck=${JSON.stringify(t1.stopAck)} reason=${t1.reason} ${t1.elapsedMs}ms`);
console.log(`   partial head: ${JSON.stringify(t1.fullText.slice(0, 90))}`);

await new Promise((r) => setTimeout(r, 1500));

// --- Turn 2: ask the model to recall the secret (tests context survival).
console.log(`\n[scs] TURN 2 (recall secret — tests context survival of a cancelled turn):`);
const t2 = await runTurn({
  isStart: false, cancelAfterMs: null,
  text: `What was the secret code I asked you to remember? Reply with only the code.`,
});
const recalled = t2.fullText.includes(SECRET);
console.log(`   reply=${JSON.stringify(t2.fullText.slice(0, 120))}`);
console.log(`   recalledSecret=${recalled} throttle=${JSON.stringify(t2.throttle)} reason=${t2.reason} ${t2.elapsedMs}ms`);

// --- Verdict
const q1 = t2.throttle ? `turn2 counter=${t2.throttle.current} (turn1 cancelled ${t1.throttle ? `had counter=${t1.throttle.current}` : "reported no counter"}) → cancelled turn ${t2.throttle.current >= 2 ? "DID" : "did NOT"} count against quota` : "no throttle data";
console.log(`\n[scs] === VERDICT ===`);
console.log(`[scs] Q1 quota cost of cancel: ${q1}`);
console.log(`[scs] Q2 context survives cancel: ${recalled ? "YES — secret recalled after cancel" : "NO — secret lost"}`);
console.log(`[scs] Q3 stop frame ack: turn1 ${t1.sentStop ? "sent stop" : "no stop"}, server ${t1.stopAck ? "acked " + JSON.stringify(t1.stopAck) : "no explicit ack (closed)"}`);

writeFileSync(join(OUT, "results.json"), JSON.stringify({ meta: { conversationId, secret: SECRET, stopAfterMs: STOP_AFTER_MS, ts: TS }, turn1: t1, turn2: t2, recalled }, null, 2));
console.log(`[scs] full output: ${OUT}`);
