// Shared single-turn chat helper for RE probes.
//
// Opens one raw WS to M365 Copilot, sends one chat turn, accumulates the
// response, and returns a structured summary. No files written — callers
// decide what to persist. Modelled on frame-dump-probe.mjs's payload.
//
// Returns: {
//   fullText, deltaText, snapshotText,   // text (we keep the longer of delta vs snapshot)
//   disengaged,                          // saw messageType:"Disengaged"
//   messageTypes, contentOrigin,         // control-frame metadata
//   scores: { BotOffense, dea_violation, ... },
//   throttle: { current, max } | null,
//   serviceVersion, turnCount,
//   elapsedMs, frameCount, error
// }

const RS = "\x1E";

const ROOT = process.cwd();
const wsMod = await import(`${ROOT}/node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs`);
const WebSocket = wsMod.default ?? wsMod.WebSocket;

const BASE_ALLOWED = [
  "Chat", "Suggestion", "InternalSearchQuery", "Disengaged",
  "InternalLoaderMessage", "Progress", "RenderCardRequest", "SemanticSerp",
  "GenerateContentQuery", "SearchQuery", "ConfirmationCard", "DeveloperLogs",
  "EndOfRequest", "ReferencesListComplete",
];

const VARIANTS = [
  "EnableMcpServerWidgets", "feature.EnableMcpServerWidgets",
  "feature.IsStreamingModeInChatRequestEnabled", "DeveloperLogs",
  "Agt_bizchat_enableGpt5ForHelix",
].join(",");

/**
 * @param {object} o
 * @param {string} o.token       Sydney JWT
 * @param {object} o.claims      decoded JWT (oid/tid)
 * @param {string} o.text        full message text to send (caller builds tool blocks etc.)
 * @param {string|null} o.agentId  Copilot Studio agent id, or null for plain chat
 * @param {string} [o.tone]      default "magic"
 * @param {string} [o.streamingMode]  default "ConciseWithPadding"
 * @param {number} [o.timeoutMs] default 120000
 * @param {(frame:object)=>void} [o.onFrame]  optional raw-frame sink
 */
export function oneTurn(o) {
  const {
    token, claims, text, agentId = null,
    tone = "magic", streamingMode = "ConciseWithPadding",
    timeoutMs = 120000, onFrame,
    optionsSets = [],                 // extra BizChat optionsSets (code interpreter, memory, …)
    extraAllowed = [],                // extra allowedMessageTypes (GeneratedCode, …)
    plugins = undefined,              // override plugins; default = BingWebSearch (or [] to disable search)
    variants = VARIANTS,              // override the WS-query variants flag list (string)
    // Entitlement the connection is opened under. The default included scenario
    // will NOT serve Claude_Opus (canned BotConnection apology); the paid one
    // does. `licenseType` is the value the paid scenario travels with — it is
    // not a model lever on its own. See packages/core/src/copilot.ts.
    scenario = "OfficeWebIncludedCopilot",
    licenseType = "Starter",
  } = o;

  const sessionId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const requestId = crypto.randomUUID();

  const params = new URLSearchParams({
    chatsessionid: requestId,
    clientrequestid: requestId,
    "X-SessionId": sessionId,
    ConversationId: conversationId,
    access_token: token,
    variants,
    source: '"officeweb"',
    product: "Office",
    agentHost: "Bizchat.FullScreen",
    licenseType,
    agent: "web",
    scenario,
  });
  const wsUrl = `wss://substrate.office.com/m365Copilot/Chathub/${claims.oid}@${claims.tid}?${params}`;

  const chatMsg = {
    arguments: [{
      source: "officeweb",
      clientCorrelationId: requestId,
      sessionId,
      optionsSets,
      streamingMode,
      spokenTextMode: "None",
      options: {},
      extraExtensionParameters: {},
      allowedMessageTypes: [...new Set([...BASE_ALLOWED, ...extraAllowed])],
      sliceIds: [],
      threadLevelGptId: agentId ? { id: agentId, source: "MOS3" } : {},
      traceId: requestId,
      isStartOfSession: true,
      clientInfo: {
        clientPlatform: "mcmcopilot-web",
        clientAppName: "Office",
        clientEntrypoint: "mcmcopilot-officeweb",
        clientSessionId: sessionId,
        clientAppType: "Web",
        deviceOS: "Linux",
        deviceType: "Desktop",
      },
      message: {
        author: "user",
        inputMethod: "Keyboard",
        text,
        entityAnnotationTypes: ["People", "File", "Event", "Email", "TeamsMessage"],
        requestId,
        locationInfo: { timeZoneOffset: 1, timeZone: "Europe/Copenhagen" },
        locale: "en-gb",
        messageType: "Chat",
        experienceType: "Default",
        adaptiveCards: [],
        clientPreferences: {},
      },
      ...(agentId
        ? { gpts: [{ id: agentId, source: "MOS3", version: "1.0.0",
            clientOverrides: { capabilities: [], "deepResearchModels@odata.type": "Collection(String)" } }] }
        : { plugins: plugins ?? [{ Id: "BingWebSearch", Source: "BuiltIn" }] }),
      isSbsSupported: true,
      tone,
      renderReferencesBehindEOS: true,
      disconnectBehavior: "continue",
    }],
    invocationId: "0", target: "chat", type: 4,
  };
  const metrics = {
    arguments: [{ Timestamps: { ConnectionStart: new Date().toISOString(), UserInputStart: new Date().toISOString(), ConnectionEstablished: new Date().toISOString(), UserInputSubmit: new Date().toISOString() } }],
    target: "Metrics", type: 1,
  };

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        "Origin": "https://m365.cloud.microsoft",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0",
      },
    });

    const t0 = Date.now();
    let handshakeDone = false;
    let frameCount = 0;
    let deltaText = "";
    let snapshotText = "";
    let disengaged = false;
    const messageTypes = new Set();
    let contentOrigin = null;
    let scores = {};
    let throttle = null;
    let serviceVersion = null;
    let turnCount = null;
    let settled = false;

    const timer = setTimeout(() => {
      finish("timeout");
    }, timeoutMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      const fullText = snapshotText.length >= deltaText.length ? snapshotText : deltaText;
      resolve({
        fullText, deltaText, snapshotText,
        disengaged, messageTypes: [...messageTypes].sort(), contentOrigin,
        scores, throttle, serviceVersion, turnCount,
        elapsedMs: Date.now() - t0, frameCount, error: error ?? null,
      });
    }

    function ingestBotMessage(msgObj) {
      if (!msgObj || typeof msgObj !== "object") return;
      if (msgObj.messageType) {
        messageTypes.add(msgObj.messageType);
        if (msgObj.messageType === "Disengaged") disengaged = true;
        return; // control/meta — not content
      }
      if (msgObj.author === "bot") {
        if (typeof msgObj.text === "string" && msgObj.text.length > snapshotText.length) {
          snapshotText = msgObj.text;
        }
        if (Array.isArray(msgObj.scores)) {
          for (const s of msgObj.scores) if (s?.component) scores[s.component] = s.score;
        }
        if (msgObj.contentOrigin) contentOrigin = msgObj.contentOrigin;
      }
    }

    ws.on("open", () => {
      ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
    });

    ws.on("message", (data) => {
      const frames = data.toString().split(RS).filter((f) => f.length > 0);
      for (const f of frames) {
        let parsed;
        try { parsed = JSON.parse(f); } catch { continue; }
        frameCount++;
        if (onFrame) { try { onFrame(parsed); } catch {} }

        if (!handshakeDone) {
          handshakeDone = true;
          ws.send(JSON.stringify(chatMsg) + RS + JSON.stringify(metrics) + RS);
          continue;
        }

        const args = parsed.arguments;
        if (Array.isArray(args)) {
          for (const a of args) {
            if (!a || typeof a !== "object") continue;
            if (typeof a.writeAtCursor === "string") deltaText += a.writeAtCursor;
            if (Array.isArray(a.messages)) for (const m of a.messages) ingestBotMessage(m);
            if (a.throttling) {
              throttle = {
                current: a.throttling.numUserMessagesInConversation,
                max: a.throttling.maxNumUserMessagesInConversation,
              };
            }
          }
        }

        // type:2 stream item — canonical final state
        if (parsed.type === 2) {
          const item = Array.isArray(parsed.item) ? parsed.item[0] : parsed.item;
          const it = item ?? (Array.isArray(args) ? args[0]?.item : null);
          if (it) {
            if (Array.isArray(it.messages)) for (const m of it.messages) ingestBotMessage(m);
            if (it.throttling) throttle = { current: it.throttling.numUserMessagesInConversation, max: it.throttling.maxNumUserMessagesInConversation };
            if (it.result?.serviceVersion) serviceVersion = it.result.serviceVersion;
            if (typeof it.turnCount === "number") turnCount = it.turnCount;
            if (typeof it.result?.message === "string" && it.result.message.length > snapshotText.length) snapshotText = it.result.message;
          }
        }

        if (parsed.type === 6) ws.send(JSON.stringify({ type: 6 }) + RS);
        if (parsed.type === 2 || parsed.type === 3 || parsed.type === 7) finish(parsed.error ?? null);
      }
    });

    ws.on("error", (err) => finish(err.message));
    ws.on("close", () => finish(null));
  });
}
