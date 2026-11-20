// Shared single-turn chat helper for RE probes.
//
// Opens one raw WS to M365 Copilot, sends one chat turn, accumulates the
// response, and returns a structured summary. No files written — callers
// decide what to persist. Modelled on frame-dump-probe.mjs's payload.
//
// Two transports reach the same backend (docs/m365-copilot-api.md §13):
// Chathub, the old web client's and the default, and StreamHub, the new web
// client's (copilot.cloud.microsoft). `transport: "streamhub"` sends one call
// over StreamHub; M365_TRANSPORT=streamhub, the variable the proxy reads, makes
// StreamHub the default for every call. A StreamHub turn has the shape the
// proxy's session.ts sends, with this call's tone, options and plugins. With
// `agentId` it carries the agent in `gpts` and `threadLevelGptId`, as a
// Chathub turn does; over StreamHub the agent sent this way isn't applied (the
// turn is plain chat, hypotheses §49 F144), and the proxy sends StreamHub
// turns agent-less.
//
// The variable changes the transport without a change to the probe, so a probe
// records the result's `transport` with every turn it saves or prints.
//
// Returns: {
//   transport,                           // "chathub" | "streamhub"
//   fullText, deltaText, snapshotText,   // text (we keep the longer of delta vs snapshot)
//   disengaged,                          // saw messageType:"Disengaged"
//   messageTypes, contentOrigin,         // control-frame metadata
//   scores: { BotOffense, dea_violation, ... },
//   throttle: { current, max, metering } | null,   // metering: paid scenario only
//   result: { value, errorCode?, message?, detail? } | null,   // the turn's outcome
//   itemTypes, billing,                  // StreamHub only: item types seen, billing_info items
//   serviceVersion, turnCount,
//   elapsedMs, frameCount, error
// }
//
// On StreamHub `deltaText` is built per message: the text a cursor frame
// restates, then the deltas after it; messages are joined by a blank line.
//
// `result` is Chathub's final `result` as sent (`value` "Success", "Throttled",
// "OutOfCredits", …), or StreamHub's `request_end` outcome in the same names:
// `value` is its `category`, `errorCode` its `code`, `detail` the server
// exception. A StreamHub `error` item (an unknown tone) sets `result` and
// `error`. `billing` holds StreamHub's `billing_info` items: on Nov 17–18 they
// came on the turns of the models the web client marks as using Copilot
// credits (hypotheses §45 F122), and on Nov 20 on no turn (§49 F143).

const RS = "\x1E";

import { pathToFileURL } from "node:url";
const ROOT = pathToFileURL(process.cwd()).href;
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

// StreamHub sends the items that end a turn (`request_end`) only under
// `streamhub11`: without it the answer streams and then the socket only pings
// (hypotheses §40 F107). The proxy adds the same two flags (session.ts).
const STREAMHUB_VARIANTS = `${VARIANTS},streamhub11,feature.enablestreamhubstop`;

// How long a StreamHub turn waits for `request_end` after its `EndOfRequest`
// message before it ends without it. session.ts waits as long.
const STREAMHUB_END_GRACE_MS = 5_000;

const BING = [{ Id: "BingWebSearch", Source: "BuiltIn" }];

/** The proxy's rule (`getTransport`, copilot.ts): StreamHub under M365_TRANSPORT=streamhub. */
function defaultTransport() {
  return process.env.M365_TRANSPORT?.trim().toLowerCase() === "streamhub" ? "streamhub" : "chathub";
}

/** The `gpts` entry that attaches a Copilot Studio agent. */
function agentGpt(agentId) {
  return {
    id: agentId, source: "MOS3", version: "1.0.0",
    clientOverrides: { capabilities: [], "deepResearchModels@odata.type": "Collection(String)" },
  };
}

/** A Chathub turn: the `chat` invocation and a `Metrics` frame, sent together. */
function chathubRequest(t) {
  const params = new URLSearchParams({
    chatsessionid: t.requestId,
    clientrequestid: t.requestId,
    "X-SessionId": t.sessionId,
    ConversationId: t.conversationId,
    access_token: t.token,
    variants: t.variants,
    source: '"officeweb"',
    product: "Office",
    agentHost: "Bizchat.FullScreen",
    licenseType: t.licenseType,
    agent: "web",
    scenario: t.scenario,
  });
  if (t.temporaryChat) params.set("disableMemory", "1");

  const chatMsg = {
    arguments: [{
      source: "officeweb",
      clientCorrelationId: t.requestId,
      sessionId: t.sessionId,
      optionsSets: t.optionsSets,
      streamingMode: t.streamingMode,
      spokenTextMode: "None",
      options: {},
      extraExtensionParameters: {},
      allowedMessageTypes: t.allowedMessageTypes,
      sliceIds: [],
      threadLevelGptId: t.agentId ? { id: t.agentId, source: "MOS3" } : {},
      traceId: t.requestId,
      isStartOfSession: true,
      clientInfo: {
        clientPlatform: "mcmcopilot-web",
        clientAppName: "Office",
        clientEntrypoint: "mcmcopilot-officeweb",
        clientSessionId: t.sessionId,
        clientAppType: "Web",
        deviceOS: "Linux",
        deviceType: "Desktop",
      },
      message: {
        author: "user",
        inputMethod: "Keyboard",
        text: t.text,
        entityAnnotationTypes: ["People", "File", "Event", "Email", "TeamsMessage"],
        requestId: t.requestId,
        locationInfo: { timeZoneOffset: 1, timeZone: "Europe/Copenhagen" },
        locale: "en-gb",
        messageType: "Chat",
        experienceType: "Default",
        adaptiveCards: [],
        clientPreferences: {},
      },
      ...(t.agentId
        ? { gpts: [agentGpt(t.agentId)] }
        : { plugins: t.plugins ?? BING }),
      isSbsSupported: true,
      tone: t.tone,
      renderReferencesBehindEOS: true,
      disconnectBehavior: "continue",
    }],
    invocationId: "0", target: "chat", type: 4,
  };
  const metrics = {
    arguments: [{ Timestamps: { ConnectionStart: new Date().toISOString(), UserInputStart: new Date().toISOString(), ConnectionEstablished: new Date().toISOString(), UserInputSubmit: new Date().toISOString() } }],
    target: "Metrics", type: 1,
  };

  return {
    url: `wss://substrate.office.com/m365Copilot/Chathub/${t.claims.oid}@${t.claims.tid}?${params}`,
    headers: {
      "Origin": "https://m365.cloud.microsoft",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0",
    },
    sends: [JSON.stringify(chatMsg) + RS + JSON.stringify(metrics) + RS],
  };
}

/**
 * A StreamHub turn, as session.ts sends it (API doc §13): the query string in
 * the new web client's order, with the routing key in it (keyed on the user);
 * then a ping, the server stream (invocation "1", fed by client stream "0"),
 * a `subscribe` to the conversation's topic and the `chat_request` item.
 */
function streamHubRequest(t) {
  const params = new URLSearchParams({
    chatsessionid: t.requestId,
    XRoutingParameterSessionKey: t.claims.oid,
    clientrequestid: t.requestId,
    "X-SessionId": t.sessionId,
  });
  if (t.temporaryChat) params.set("disableMemory", "1");
  params.set("access_token", t.token);
  params.set("variants", t.variants);
  params.set("source", "officeweb");
  params.set("product", "Office");
  params.set("agentHost", "Bizchat.FullScreen");
  params.set("licenseType", t.licenseType);
  params.set("isEdu", "false");
  params.set("agent", "work");
  params.set("scenario", t.scenario);

  const clientInfo = {
    clientPlatform: "ccmcopilot-web",
    clientAppName: "Office",
    clientEntrypoint: "ccmcopilot-officeweb",
    clientSessionId: t.sessionId,
    ProductCategory: "Chat",
    clientAppType: "Web",
    productEntryPoint: "ChatPanel",
    deviceOS: "Windows",
    deviceType: "Desktop",
    clientPlatformVersion: "10",
  };
  const topicId = `/conversations/${t.conversationId}`;
  const chatStreamRequest = {
    source: "officeweb",
    optionsSets: t.optionsSets,
    streamingMode: t.streamingMode,
    options: {},
    extraExtensionParameters: {},
    allowedMessageTypes: t.allowedMessageTypes,
    sliceIds: [],
    threadLevelGptId: t.agentId ? { id: t.agentId, source: "MOS3" } : {},
    conversationId: t.conversationId,
    requestId: t.requestId,
    traceId: t.requestId,
    isStartOfSession: true,
    clientInfo,
    message: {
      author: "user",
      inputMethod: "Keyboard",
      text: t.text,
      requestId: t.requestId,
      locationInfo: { timeZoneOffset: 1, timeZone: "Europe/Copenhagen" },
      locale: "en-us",
      messageType: "Chat",
      adaptiveCards: [],
      clientPreferences: {},
      clientInfo,
    },
    // The web client's plain chat carries its built-in agent here.
    ...(t.agentId
      ? { gpts: [agentGpt(t.agentId)] }
      : { gpts: [{ id: "bizchat-as-gpt-scenario", source: "BuiltInAgents" }], plugins: t.plugins ?? BING }),
    tone: t.tone,
    disconnectBehavior: "continue",
  };
  const item = (it) => JSON.stringify({ invocationId: "0", item: { ...it, noteId: crypto.randomUUID() }, type: 2 }) + RS;

  return {
    url: `wss://substrate.svc.cloud.microsoft/m365Copilot/StreamHub/${t.claims.oid}@${t.claims.tid}?${params}`,
    headers: {
      "Origin": "https://copilot.cloud.microsoft",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
    sends: [
      JSON.stringify({ type: 6 }) + RS + JSON.stringify({ arguments: [], invocationId: "1", streamIds: ["0"], target: "stream", type: 4 }) + RS,
      item({ type: "subscribe", topicId, action: "create" }),
      item({ type: "chat_request", chatStreamRequest, topicId }),
    ],
  };
}

/** A StreamHub outcome in the names of Chathub's final `result`. */
function streamHubResult(value, errorCode, message, detail) {
  return Object.fromEntries(
    Object.entries({ value, errorCode, message, detail }).filter(([, v]) => typeof v === "string"),
  );
}

/**
 * @param {object} o
 * @param {string} o.token       Sydney JWT
 * @param {object} o.claims      decoded JWT (oid/tid)
 * @param {string} o.text        full message text to send (caller builds tool blocks etc.)
 * @param {string|null} o.agentId  Copilot Studio agent id, or null for plain chat
 * @param {"chathub"|"streamhub"} [o.transport]  default "streamhub" under M365_TRANSPORT=streamhub, else "chathub"
 * @param {string} [o.tone]      default "magic"
 * @param {string} [o.streamingMode]  default "ConciseWithPadding" (Chathub), "ConciseV2" (StreamHub)
 * @param {number} [o.timeoutMs] default 120000
 * @param {(frame:object)=>void} [o.onFrame]  optional raw-frame sink
 */
export function oneTurn(o) {
  const {
    token, claims, text, agentId = null,
    // The defaults below that differ between the transports follow this one;
    // a value the caller passes is sent as it is, on either transport.
    transport = defaultTransport(),
    tone = "magic",
    streamingMode = transport === "streamhub" ? "ConciseV2" : "ConciseWithPadding",
    timeoutMs = 120000, onFrame,
    optionsSets = [],                 // extra BizChat optionsSets (code interpreter, memory, …)
    extraAllowed = [],                // extra allowedMessageTypes (GeneratedCode, …)
    baseAllowed = BASE_ALLOWED,       // override the base allowedMessageTypes (declare-to-receive probes)
    plugins = undefined,              // override plugins; default = BingWebSearch (or [] to disable search)
    // Override the WS-query variants flag list (string). A StreamHub turn
    // whose list lacks `streamhub11` ends only by the EndOfRequest wait.
    variants = transport === "streamhub" ? STREAMHUB_VARIANTS : VARIANTS,
    // Entitlement the connection is opened under. The default included scenario
    // will NOT serve Claude_Opus (canned BotConnection apology); the paid one
    // does. `licenseType` is the value the paid scenario travels with — it is
    // not a model lever on its own. See packages/core/src/copilot.ts.
    // StreamHub's default is the new web client's own pair, as the proxy's
    // (`getStreamHubScenario`): under the included scenario StreamHub refuses
    // GPT-6.1 Sol, as Chathub does, and serves it under `officeweb`
    // (hypotheses §40 F108).
    scenario = transport === "streamhub" ? "officeweb" : "OfficeWebIncludedCopilot",
    licenseType = transport === "streamhub" ? "Premium" : "Starter",
    // Temporary chat (`disableMemory=1`), the proxy's default since #15: context
    // survives, but the thread never lands in the Copilot history sidebar
    // (docs/hypotheses.md §16 F28/F29). `false` / M365_SAVE_HISTORY=1 restores the
    // pre-#15 wire state most recorded probe evidence was taken under.
    temporaryChat = process.env.M365_SAVE_HISTORY !== "1",
  } = o;
  if (transport !== "chathub" && transport !== "streamhub") {
    throw new Error(`oneTurn: transport must be "chathub" or "streamhub", not ${JSON.stringify(transport)}`);
  }
  const streamHub = transport === "streamhub";

  const turn = {
    token, claims, text, agentId, tone, streamingMode, optionsSets, plugins,
    variants, scenario, licenseType, temporaryChat,
    allowedMessageTypes: [...new Set([...baseAllowed, ...extraAllowed])],
    sessionId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
  };
  const request = streamHub ? streamHubRequest(turn) : chathubRequest(turn);

  return new Promise((resolve) => {
    const ws = new WebSocket(request.url, { headers: request.headers });

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
    let result = null;
    let serviceVersion = null;
    let turnCount = null;
    const itemTypes = new Set();
    const billing = [];
    let settled = false;

    // StreamHub text, per message (the proxy's TurnTextComposer, reduced). A
    // cursor frame names the message the next deltas extend and restates its
    // text; a long answer is restated as "" and then sent again whole (§40
    // F107), so a restatement replaces the message's text instead of adding to it.
    const streamTexts = new Map();
    let cursorTarget = "";
    const streamDelta = (w) => streamTexts.set(cursorTarget, (streamTexts.get(cursorTarget) ?? "") + w);
    let endGrace = null;

    const timer = setTimeout(() => {
      finish("timeout");
    }, timeoutMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(endGrace);
      try { ws.close(); } catch {}
      if (streamHub) deltaText = [...streamTexts.values()].filter((t) => t.length > 0).join("\n\n");
      const fullText = snapshotText.length >= deltaText.length ? snapshotText : deltaText;
      resolve({
        transport,
        fullText, deltaText, snapshotText,
        disengaged, messageTypes: [...messageTypes].sort(), contentOrigin,
        scores, throttle, result, serviceVersion, turnCount,
        itemTypes: [...itemTypes].sort(), billing,
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

    // A StreamHub server item (type 2 on invocation "1"). The turn ends at
    // `request_end`, at an `error` item (the server would hold the socket open
    // ~120 s), or STREAMHUB_END_GRACE_MS after the `EndOfRequest` message when
    // no `request_end` follows it.
    function ingestStreamHubItem(item) {
      if (!item || typeof item !== "object") return;
      if (typeof item.type === "string") itemTypes.add(item.type);

      if (item.type === "message_part") {
        const a = item.argument;
        if (!a || typeof a !== "object") return;
        const cursorId = typeof a.cursor?.j === "string" ? a.cursor.j.match(/^\$\['([^']+)'\]/)?.[1] : undefined;
        if (cursorId) cursorTarget = cursorId;
        if (Array.isArray(a.messages)) {
          for (const m of a.messages) {
            ingestBotMessage(m);
            if (m?.messageType === "EndOfRequest" && !endGrace) {
              endGrace = setTimeout(() => finish(null), STREAMHUB_END_GRACE_MS);
            }
            if (m?.author !== "bot") continue;
            if (typeof m.turnCount === "number") turnCount = m.turnCount;
            if (cursorId && m.messageId === cursorId && !m.messageType && typeof m.text === "string") {
              streamTexts.set(cursorId, m.text);
            }
          }
        }
        if (typeof a.w === "string") streamDelta(a.w);
        if (typeof a.writeAtCursor === "string") streamDelta(a.writeAtCursor);
        if (a.throttling) {
          throttle = {
            current: a.throttling.numUserMessagesInConversation,
            max: a.throttling.maxNumUserMessagesInConversation,
            metering: a.throttling.metering ?? null,
          };
        }
        return;
      }
      if (item.type === "billing_info") {
        billing.push(item);
        return;
      }
      if (item.type === "request_end") {
        const out = item.outcome ?? {};
        result = streamHubResult(out.category, out.code ?? out.errorCode, out.message, out.error);
        // As with Chathub's final `result.message`: a refusal's only text can be here.
        if (typeof out.message === "string" && out.message.length > snapshotText.length) snapshotText = out.message;
        finish(null);
        return;
      }
      if (item.type === "error") {
        result = streamHubResult(item.errorCategory, item.errorCode, item.message, item.detail);
        finish([item.errorCategory, item.errorCode].filter(Boolean).join("/") || "error item");
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
          for (const s of request.sends) ws.send(s);
          continue;
        }

        if (streamHub) {
          if (settled) continue;
          if (parsed.type === 6) ws.send(JSON.stringify({ type: 6 }) + RS);
          else if (parsed.type === 2) ingestStreamHubItem(parsed.item);
          else if (parsed.type === 3 || parsed.type === 7) finish(parsed.error ?? null);
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
            if (it.throttling) {
              throttle = {
                current: it.throttling.numUserMessagesInConversation,
                max: it.throttling.maxNumUserMessagesInConversation,
                metering: it.throttling.metering ?? null,
              };
            }
            if (it.result && typeof it.result === "object") result = it.result;
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
