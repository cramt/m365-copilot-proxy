import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Replace core's ModelSession with a scripted fake so we can exercise the handler's
// streaming path with no auth/WebSocket. Everything else in core stays real.
const scripted: {
  deltas: string[];
  fullText?: string;
  /** Script an upstream `result` (e.g. Throttled) on a turn with no content. */
  result?: { value: string; errorCode?: string; message?: string } | null;
  runs: number;
  /** Text of every run() call, in order. */
  texts: string[];
  /** Per-call overrides, consumed front-first (e.g. a Disengaged turn, then an answer). */
  queue: Array<{ fullText: string; onRun?: (signal?: AbortSignal) => void; messageType?: string | null; contentOrigin?: string; apology?: boolean; result?: { value: string; errorCode?: string; message?: string }; metering?: Record<string, number>; throttle?: { current: number; max: number } | null; turnState?: string; reasoning?: string[] }>;
  /** The model argument of every run() call, in order. */
  models: string[];
  /** The `useAgent` argument of every run() call, in order. */
  agentFlags: Array<boolean | undefined>;
  /** The image data URLs of every run() call, in order. */
  images: string[][];
  /** How many times the handler rotated to a fresh conversation. */
  newConversations: number;
  /** Held open to keep a turn silent while a test advances the clock (heartbeat tests). */
  gate: Promise<void> | null;
  /** The abort signal of every run() call, in order. */
  signals: Array<AbortSignal | undefined>;
  /** Deltas yielded by the last run() before its signal aborted it (the Stop), or null if it ran out. */
  stoppedAfter: number | null;
  /** Make `fullText` grow with the deltas yielded so far, like the real stream's composed answer. */
  liveFullText?: boolean;
  /** What awaitTurnBudget (M365_AVOID_THROTTLING) throws before every turn, or null to let it through. */
  budgetHold: Error | null;
  /** The options of every awaitTurnBudget call, in order. */
  awaitTurnBudgetCalls: Array<{ maxWaitMs?: number; signal?: AbortSignal }>;
  /** The `waitForBudget` argument of every run() call, in order (one function per call). */
  budgetWaits: Array<(() => Promise<unknown>) | undefined>;
  /** The M365 conversation id of every run() call, in order (unique per conversation). */
  convs: string[];
  ids: number;
  /** Replies to the parts of a long turn (replay.ts), consumed front-first; past them a part gets "OK". */
  partQueue: Array<{ fullText: string; messageType?: string | null; contentOrigin?: string; apology?: boolean; result?: { value: string; errorCode?: string; message?: string }; throttle?: { current: number; max: number } | null; turnState?: string; reasoning?: string[] }>;
  /** The chain of thought a turn without a queue entry hands to `onReasoning`, piece by piece. */
  reasoning: string[];
} = { reasoning: [], deltas: [], runs: 0, texts: [], queue: [], agentFlags: [], newConversations: 0, models: [], images: [], gate: null, signals: [], stoppedAfter: null, budgetHold: null, awaitTurnBudgetCalls: [], budgetWaits: [], convs: [], ids: 0, partQueue: [] };

vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  let sessionsMade = 0;
  class FakeModelSession {
    readonly uid = ++sessionsMade;
    turnCount = 0;
    conversationId = `conv-${++scripted.ids}`;
    reset() {}
    newConversation() { this.conversationId = `conv-${++scripted.ids}`; this.turnCount = 0; scripted.newConversations++; }
    async refreshAgent() { return false; }
    async run(text: string, model?: string, signal?: AbortSignal, useAgent?: boolean, images: string[] = [], waitForBudget?: () => Promise<unknown>, turn?: { onReasoning?: (delta: string) => void }) {
      if (scripted.gate) await scripted.gate;
      scripted.budgetWaits.push(waitForBudget);
      scripted.models.push(model ?? "");
      scripted.images.push(images);
      scripted.signals.push(signal);
      scripted.stoppedAfter = null;
      this.turnCount++; // like the real session: later requests go down the delta path
      scripted.runs++;
      scripted.texts.push(text);
      scripted.convs.push(this.conversationId);
      scripted.agentFlags.push(useAgent);
      servedBy.push(this.uid);
      // A part of a long turn (replay.ts) is acknowledged, as the model does, without using up the queue.
      const isPart = /^\[(?:Earlier conversation, part|This message is too long to send at once)/.test(text);
      const next: (typeof scripted.queue)[number] | undefined = isPart ? (scripted.partQueue.shift() ?? { fullText: "OK" }) : scripted.queue.shift();
      next?.onRun?.(signal);
      const deltas = next ? (next.fullText ? [next.fullText] : []) : scripted.deltas;
      // The chain of thought arrives ahead of the answer, as the real session hands it on.
      const thoughts = next ? (next.reasoning ?? []) : scripted.reasoning;
      for (const t of thoughts) turn?.onReasoning?.(t);
      const full = next ? next.fullText : (scripted.fullText ?? deltas.join(""));
      const yielded: string[] = [];
      const stream = {
        get fullText() { return scripted.liveFullText ? yielded.join("") : full; },
        hasContent: full.length > 0,
        result: next?.result ?? scripted.result ?? { value: "Success" },
        metering: next?.metering ?? null,
        images: [],
        // M365's message count for the conversation, as the real server keeps it.
        throttle: next?.throttle !== undefined ? next.throttle : { current: this.turnCount, max: 600 },
        contentOrigin: next?.contentOrigin ?? "Claude",
        apology: next?.apology ?? false,
        messageType: (next?.messageType ?? null) as string | null,
        messageId: "m1",
        scores: null,
        turnCount: 1,
        turnState: next?.turnState ?? "Completed",
        reasoning: thoughts.join(""),
        async *[Symbol.asyncIterator]() {
          for (const d of deltas) {
            await Promise.resolve(); // yield to the event loop between deltas
            // Like the real session: an aborted signal sends Stop and the turn ends.
            if (signal?.aborted) { scripted.stoppedAfter = yielded.length; return; }
            yielded.push(d);
            yield d;
          }
        },
      };
      return stream;
    }
  }
  // awaitTurnBudget reads the account's real logs; script its verdict instead.
  async function awaitTurnBudget(opts: { maxWaitMs?: number; signal?: AbortSignal } = {}) {
    scripted.awaitTurnBudgetCalls.push(opts);
    if (scripted.budgetHold) throw scripted.budgetHold;
    return { waitedMs: 0 };
  }
  // The agent runtime's session: the same scripted turns, recorded per backend,
  // with what the runtime's stream differs in (no Chat message count; credits).
  class FakeAetherSession extends FakeModelSession {
    readonly mode: string;
    constructor(options: { mode: string }) {
      super();
      this.mode = options.mode;
    }
    override async run(text: string, model?: string, signal?: AbortSignal, useAgent?: boolean, images: string[] = [], waitForBudget?: () => Promise<unknown>, turn?: unknown) {
      runtimeRuns.push({ mode: this.mode, model: model ?? "", useAgent, turn, text });
      return Object.assign(await super.run(text, model, signal, useAgent, images, waitForBudget), { throttle: null, credits: 0.5, agentToolCalls: runtimeToolCalls });
    }
    close() { runtimeClosed.push(this.conversationId); }
  }
  return { ...actual, ModelSession: FakeModelSession, AetherSession: FakeAetherSession, awaitTurnBudget };
});

/** Every run() on a fake agent-runtime session, in order. */
const runtimeRuns: Array<{ mode: string; model: string; useAgent?: boolean; turn: unknown; text: string }> = [];
/** The tool calls the fake runtime's own agent reports on each turn. */
let runtimeToolCalls = 0;
/** The conversation of every fake agent-runtime session the pool dropped (close()), in order. */
const runtimeClosed: string[] = [];

/** Which fake ModelSession (by creation order) served every run() call, in order. */
const servedBy: number[] = [];

const { handleChatCompletion, SessionPool, ChatCompletionRequest } = await import("./index.js");
const { resetAgentRoutes, resetPriorityAccessState, noteRequestOutcome, TurnBudgetHold, noteWebSearchOverflow, toneUsesWebSearch, resetWebSearchOverflow } = await import("@m365-copilot/core");

// The proxy remembers a priority-access wall and degradation backoff for the
// process; reset both between tests so one test's refusal/throttle doesn't
// stall or 429 the next test (the fake numbers distinct conversation ids).
afterEach(() => {
  resetPriorityAccessState();
  noteRequestOutcome(false, "");
});

/** One request on a fresh pool with a fake clock: an empty upstream turn makes
 *  the handler wait 2 s before each quick retry, and that wait is the handler's
 *  own pacing, not what these tests check. */
async function respond(body: ReturnType<typeof ChatCompletionRequest.parse>): Promise<Response> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const pending = handleChatCompletion(body, new SessionPool());
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

/** Drive one streaming request and collect the ordered content-delta strings. */
async function streamContents(deltas: string[], fullText?: string): Promise<string[]> {
  scripted.deltas = deltas;
  scripted.fullText = fullText;
  const body = ChatCompletionRequest.parse({
    model: "m365-copilot",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  });
  const res = await handleChatCompletion(body, new SessionPool());
  expect(res.status).toBe(200);
  const text = await res.text();

  const contents: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    const chunk = JSON.parse(payload);
    const c = chunk.choices?.[0]?.delta?.content;
    if (typeof c === "string" && c.length > 0) contents.push(c);
  }
  return contents;
}

describe("incremental streaming (non-tool path)", () => {
  it("forwards deltas as separate chunks, not one buffered blob", async () => {
    const contents = await streamContents(["Hello", ", ", "world", "!"]);
    // Genuinely incremental: each delta is its own chunk.
    expect(contents.length).toBeGreaterThan(1);
    // Lossless and in-order: reconstructs the full answer exactly once.
    expect(contents.join("")).toBe("Hello, world!");
  });

  it("emits the trailing remainder once when the final text outruns the delta stream", async () => {
    // Deltas cover a prefix ("Hello wor"); the authoritative full text is longer —
    // the renderer must send the "ld" tail exactly once, never re-send the prefix.
    const contents = await streamContents(["Hello ", "wor"], "Hello world");
    expect(contents.join("")).toBe("Hello world");
    // No duplicated prefix.
    expect(contents.join("").match(/Hello/g)?.length).toBe(1);
  });
});

describe("keepalive on a silent turn (tool turns are buffered, so the stream can be quiet for minutes)", () => {
  it("sends a data chunk, not an SSE comment, so a client's last-chunk clock keeps ticking", async () => {
    // A stream carrying only comments looks alive at the socket but dead to a client that
    // measures liveness by data chunks: it warns "no stream output" and can trip its stale
    // watchdog, reconnecting (and re-sending the turn) mid-flight.
    scripted.deltas = ["listo"];
    scripted.fullText = "listo";
    let release!: () => void;
    scripted.gate = new Promise<void>((r) => { release = r; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const body = ChatCompletionRequest.parse({
        model: "m365-copilot",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      });
      const pending = handleChatCompletion(body, new SessionPool()).then((res) => res.text());
      await vi.advanceTimersByTimeAsync(16_000); // the turn has said nothing yet
      release();
      const text = await pending;

      // At least one heartbeat, and it is a no-op data chunk (empty delta, no finish
      // marker). A client that resets its liveness clock on data chunks sees the turn
      // as live; the comment this replaced (`: keepalive`) it does not see at all.
      const beats = text
        .split("\n")
        .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
        .map((l) => JSON.parse(l.slice(6)))
        .filter((c) => c.choices?.[0]?.finish_reason === null && Object.keys(c.choices[0].delta ?? {}).length === 0);
      expect(beats.length).toBeGreaterThan(0);

      // The heartbeat is a no-op: the turn's own text is still emitted exactly once.
      const contents = text
        .split("\n")
        .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
        .map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content)
        .filter((c) => typeof c === "string" && c.length > 0);
      expect(contents.join("")).toBe("listo");
    } finally {
      scripted.gate = null;
      vi.useRealTimers();
    }
  });
});

/** Drive one streaming request and collect content deltas AND error chunks. */
async function streamRaw(
  deltas: string[],
  fullText?: string,
): Promise<{ contents: string[]; errors: any[] }> {
  scripted.deltas = deltas;
  scripted.fullText = fullText;
  const body = ChatCompletionRequest.parse({
    model: "claude-opus",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  });
  const res = await handleChatCompletion(body, new SessionPool());
  const text = await res.text();

  const contents: string[] = [];
  const errors: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    const chunk = JSON.parse(payload);
    const c = chunk.choices?.[0]?.delta?.content;
    if (typeof c === "string" && c.length > 0) contents.push(c);
    if (chunk.error) errors.push(chunk.error);
  }
  return { contents, errors };
}

describe("priority-access exhaustion on the streaming path", () => {
  const REFUSAL =
    "You've used your available priority access to the Opus model for today. " +
    "You can choose another available model or wait until tomorrow to use the Opus model again.";

  it("never leaks the refusal to the client as content", async () => {
    // Chunked the way M365 actually streams it — the gate must hold the head.
    const deltas = REFUSAL.match(/.{1,12}/g)!;
    const { contents } = await streamRaw(deltas);
    expect(contents.join("")).not.toContain("priority access");
    expect(contents.join("")).toBe("");
  });

  it("emits a machine-readable error chunk, not just prose", async () => {
    const { errors } = await streamRaw(REFUSAL.match(/.{1,12}/g)!);
    expect(errors).toHaveLength(1);
    // A streaming client must be able to tell a quota wall from a transient
    // upstream blip without string-matching the message.
    expect(errors[0].code).toBe("priority_access_exhausted");
    expect(errors[0].type).toBe("rate_limit_error");
    expect(errors[0].retry_after).toBeGreaterThan(0);
  });

  it("still streams an ordinary answer that merely starts with \"You\"", async () => {
    const { contents, errors } = await streamRaw(["You", "r code ", "has a bug."]);
    expect(errors).toHaveLength(0);
    expect(contents.join("")).toBe("Your code has a bug.");
  });
});

describe("a tool call the proxy can't read", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const UNCLOSED = "Let me look at the files.\n```bash\nls -la";

  async function ask(replies: string[]) {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = replies.map((fullText) => ({ fullText }));
    const body = ChatCompletionRequest.parse({ model: "gpt-5.6-think-deeper", stream: false, tools, messages: [{ role: "user", content: `list files ${Math.random()}` }] });
    const msg = (await (await handleChatCompletion(body, new SessionPool())).json()).choices[0].message;
    scripted.queue = [];
    return msg;
  }
  afterEach(() => { delete process.env.M365_NO_FENCE_RETRY; });

  it("asks for it again, saying what was wrong, and runs the call it gets", async () => {
    const msg = await ask([UNCLOSED, "```bash\nls -la\n```"]);
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({ command: "ls -la" });
    expect(scripted.texts).toHaveLength(2);
    expect(scripted.texts[1]).toContain("couldn't be read as a tool call — its closing ``` never came on a line of its own");
  });

  it("asks once: a second unreadable reply goes out as text", async () => {
    const msg = await ask([UNCLOSED, UNCLOSED, "```bash\nls\n```"]);
    expect(msg.tool_calls).toBeUndefined();
    expect(scripted.texts).toHaveLength(2);
  });

  it("doesn't force a call after asking again, whatever the answer to that was", async () => {
    // The re-ask told the model it could reply without the call; a confab retry
    // on that reply would force the call anyway (review, #71).
    const msg = await ask([UNCLOSED, "I don't have access to your project files or the ability to run commands here.", "```bash\nls\n```"]);
    expect(msg.tool_calls).toBeUndefined();
    expect(scripted.texts).toHaveLength(2);
  });

  it("doesn't ask when nothing in the reply was a tool call, or when turned off", async () => {
    await ask(["Done. The function is:\n\n```python\ndef f():\n    return 1"]);
    expect(scripted.texts).toHaveLength(1);
    process.env.M365_NO_FENCE_RETRY = "1";
    await ask([UNCLOSED, "```bash\nls\n```"]);
    expect(scripted.texts).toHaveLength(1);
  });

  it("runs after an Apology retry and still sends the closed call through the [Type]: guard", async () => {
    const psTools = [{ type: "function", function: { name: "exec_command", description: "Runs a PowerShell command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } } }];
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      { fullText: "Sorry, it looks like I can't chat about this.", contentOrigin: "DeepLeo", apology: true },
      { fullText: "```powershell\n$u = Get-Content a.txt" },
      { fullText: "```powershell\n$u = :Replace($c, '1', '2')\nSet-Content a.txt $u\n```" },
      { fullText: "```powershell\n$u = [System.Text.RegularExpressions.Regex]::Replace($c, '1', '2')\nSet-Content a.txt $u\n```" },
    ];
    const body = ChatCompletionRequest.parse({
      model: "gpt-6.1-sol",
      stream: false,
      tools: psTools,
      messages: [{ role: "user", content: `edit a.txt ${Math.random()}` }],
    });
    const msg = (await (await handleChatCompletion(body, new SessionPool())).json()).choices[0].message;
    scripted.queue = [];
    expect(scripted.texts).toHaveLength(4);
    expect(scripted.texts[2]).toContain("couldn't be read as a tool call");
    expect(scripted.texts[3]).toContain("didn't run your last command");
    expect(JSON.parse(msg.tool_calls[0].function.arguments).cmd).toContain("[System.Text.RegularExpressions.Regex]::Replace(");
  });
});

describe("the only-the-first-call-ran note", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const NOTE = "(Note: only the first tool call in your previous reply was actually run.";

  /** One conversation, several requests through the same pool. */
  async function converse(replies: string[]): Promise<string[]> {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = replies.map((fullText) => ({ fullText }));
    const pool = new SessionPool();
    const messages: any[] = [{ role: "system", content: "sys" }, { role: "user", content: `fix it ${Math.random()}` }];
    for (let i = 0; i < replies.length; i++) {
      const res = await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, tools, messages }), pool);
      const msg = (await res.json()).choices[0].message;
      if (!msg.tool_calls) break;
      messages.push({ role: "assistant", content: null, tool_calls: msg.tool_calls });
      messages.push({ role: "tool", tool_call_id: msg.tool_calls[0].id, content: `real output ${i}` });
    }
    scripted.queue = [];
    return scripted.texts;
  }

  it("tells the model, with the real result, that its invented tail never ran", async () => {
    const sent = await converse([
      "```bash\ncat config.json\n```\n\n<tool_response>\n{\"port\": 3000}\n</tool_response>\n\nThe bug is fixed.",
      "```bash\nsed -i s/3000/8080/ config.json\n```",
      "Done.",
    ]);
    expect(sent).toHaveLength(3);
    expect(sent[1].startsWith(NOTE)).toBe(true);
    expect(sent[1]).toContain("real output 0");
    expect(sent[2]).not.toContain("(Note:"); // once only: turn 2 was executed in full
  });

  it("says how many batched calls were dropped by one-call-per-turn", async () => {
    const sent = await converse(["```bash\nls\n```\n\n```bash\ncat a.txt\n```", "Done."]);
    expect(sent[1]).toContain("only the first of the 2 tool calls in your previous reply was run; the other one was not");
  });

  it("adds nothing when the whole reply ran", async () => {
    const sent = await converse(["```bash\nls\n```", "Done."]);
    expect(sent[1]).not.toContain("(Note:");
  });

  it("names the tool on a follow-up turn, though the tool message carries no name (#50)", async () => {
    // Like pi: the result names its call only by tool_call_id.
    const sent = await converse(["```bash\nls\n```", "Done."]);
    // The same rendering as the first turn (tool and command), so the model reads one format.
    expect(sent[1]).toMatch(/<tool_response tool="bash" command="ls">\nreal output 0\n<\/tool_response>/);
    expect(sent[1]).not.toContain('name="unknown"');
  });
});

describe("a reply that opens with a tool call and then writes an essay", () => {
  it("runs the opening call and tells the model its essay was written before the result", async () => {
    const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      { fullText: "```bash\ncat config.json\n```\n\nThe file `config.json` doesn't exist in my environment, so here is how you could fix it yourself:\n\n## Steps\n\n```bash\nsed -i s/3000/8080/ config.json\n```\n\nThat's all." },
      { fullText: "Done." },
    ];
    const pool = new SessionPool();
    const messages: any[] = [{ role: "user", content: `essay ${Math.random()}` }];
    const r1 = await (await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, tools, messages }), pool)).json();
    const call = r1.choices[0].message.tool_calls?.[0];
    expect(call).toBeDefined(); // the old guard returned the essay as text
    expect(JSON.parse(call.function.arguments).command).toBe("cat config.json");
    messages.push({ role: "assistant", content: null, tool_calls: r1.choices[0].message.tool_calls });
    messages.push({ role: "tool", tool_call_id: call.id, content: '{"port": 3000}' });
    await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, tools, messages }), pool);
    expect(scripted.texts[1]).toContain("was written before its result existed");
    expect(scripted.texts[1]).toContain('{"port": 3000}');
    scripted.queue = [];
  });
});

describe("a reply that restates its call as a correction (Sonnet 5.5)", () => {
  it("runs the corrected copy and doesn't tell the model its correction was dropped", async () => {
    const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
    const plan = "The logs are plain text, so the viewer can read them once they are renamed. Two of the files are empty "
      + "and can go. Next I'll rename the rest to `.log`, delete the two empty ones, and point the index page at the "
      + "local copies, keeping a backup of the page first so the change is easy to undo if anything looks wrong.";
    const cmd = (grep: string) => `cd /tmp/proj && rm logs/a.txt && for f in logs/*.txt; do mv "$f" "\${f%.txt}.log"; done && ls logs; grep -n '${grep}' index.html`;
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      { fullText: `${plan}\n\n\`\`\`bash\n${cmd("href\\|src")}</bash>\n\`\`\`\n\nOops, that closing fence is wrong. Here is the same command, correctly formatted:\n\n\`\`\`bash\n${cmd("href")}\n\`\`\`` },
      { fullText: "Done." },
    ];
    const pool = new SessionPool();
    const messages: any[] = [{ role: "user", content: `rename the logs ${Math.random()}` }];
    const r1 = await (await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet-5.5", stream: false, tools, messages }), pool)).json();
    const calls = r1.choices[0].message.tool_calls;
    expect(calls).toHaveLength(1); // the document guard used to return the whole reply as text
    expect(JSON.parse(calls[0].function.arguments).command).toBe(cmd("href"));
    messages.push({ role: "assistant", content: null, tool_calls: calls });
    messages.push({ role: "tool", tool_call_id: calls[0].id, content: "c.log" });
    await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet-5.5", stream: false, tools, messages }), pool);
    expect(scripted.texts[1]).not.toContain("(Note:");
    scripted.queue = [];
  });
});

describe("an explicitly Throttled turn (result.value = Throttled)", () => {
  // Verbatim from the Sep 28 dumps: no content frames, only this final result.
  const THROTTLED = {
    value: "Throttled",
    errorCode: "PerUserThrottled",
    message: "We're temporarily unable to respond to this volume of requests. Please try again later.",
  };

  it("fails fast with a 429 — no quick retries back into the throttle", async () => {
    scripted.deltas = [];
    scripted.fullText = "";
    scripted.result = THROTTLED;
    scripted.runs = 0;
    const body = ChatCompletionRequest.parse({
      model: "claude-sonnet",
      stream: false,
      messages: [{ role: "user", content: "hello throttled" }],
    });
    const res = await handleChatCompletion(body, new SessionPool());
    expect(res.status).toBe(429);
    const err = (await res.json()).error;
    expect(err.type).toBe("rate_limit_error");
    expect(err.code).toBe("m365_throttled");
    expect(err.param).toBe("PerUserThrottled");
    expect(scripted.runs).toBe(1); // the old path spent 3 attempts here
    scripted.result = null;
  });

  it("carries the code through the streaming path as an error chunk", async () => {
    scripted.result = THROTTLED;
    const { contents, errors } = await streamRaw([], "");
    expect(contents).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("m365_throttled");
    scripted.result = null;
  });
});

describe("a prompt over the model's input limit (result.value = InvalidRequest)", () => {
  // Live, GPT-6.1 Sol on a Codex first turn: no content, only this final result.
  const TOO_LONG = { value: "InvalidRequest", errorCode: "InputTokenLimitExceeded" };
  afterEach(() => resetWebSearchOverflow());

  it("fails fast with a 400 that says the prompt is too long — no retries", async () => {
    noteWebSearchOverflow("Gpt_61_Sol_Reasoning"); // Bing already ruled out (see the next test)
    scripted.deltas = [];
    scripted.fullText = "";
    scripted.result = TOO_LONG;
    scripted.runs = 0;
    const body = ChatCompletionRequest.parse({
      model: "gpt-6.1-sol",
      stream: false,
      messages: [{ role: "user", content: "a very long prompt" }],
    });
    const res = await handleChatCompletion(body, new SessionPool());
    scripted.result = null;
    expect(res.status).toBe(400);
    const err = (await res.json()).error;
    expect(err.type).toBe("invalid_request_error");
    expect(err.code).toBe("context_length_exceeded");
    expect(err.param).toBe("InputTokenLimitExceeded");
    expect(err.message).toContain("too long for gpt-6.1-sol");
    expect(scripted.runs).toBe(1); // the empty-reply path spent 3 attempts here
  });

  it("re-sends an agent-less request once without the Bing plugin, and remembers the tone", async () => {
    // Live, GPT-6 and GPT-5.5 Think Deeper on the test account: a one-line
    // prompt is "too long" with Bing attached and answers without it (§40).
    const ask = () => handleChatCompletion(
      ChatCompletionRequest.parse({ model: "gpt-6-think-deeper", stream: false, messages: [{ role: "user", content: "hi" }] }),
      new SessionPool(),
    );
    scripted.runs = 0;
    scripted.newConversations = 0;
    scripted.queue = [{ fullText: "", result: TOO_LONG }, { fullText: "hello" }];
    const res = await ask();
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("hello");
    expect(scripted.runs).toBe(2);
    expect(scripted.newConversations).toBe(1);
    expect(toneUsesWebSearch("Gpt_6_Reasoning")).toBe(false);

    // Known now: a refusal without Bing is a real limit, so no second retry.
    scripted.queue = [{ fullText: "", result: TOO_LONG }];
    expect((await ask()).status).toBe(400);
    expect(scripted.runs).toBe(3);
  });
});

describe("M365_AVOID_THROTTLING holds a turn it would have to wait too long for", () => {
  const hold = () => new TurnBudgetHold("throttle hold", 65 * 60_000, Date.parse("2026-10-12T08:00:00.000Z"));

  it("answers 429 with Retry-After and never sends the turn", async () => {
    scripted.result = null;
    scripted.runs = 0;
    scripted.budgetHold = hold();
    const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, messages: [{ role: "user", content: "held" }] });
    const res = await handleChatCompletion(body, new SessionPool());
    scripted.budgetHold = null;
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(65 * 60));
    const err = (await res.json()).error;
    expect(err.type).toBe("rate_limit_error");
    expect(err.code).toBe("m365_throttle_hold");
    expect(err.message).toMatch(/throttled this account at 2026-10-12T08:00:00\.000Z/);
    expect(scripted.runs).toBe(0);
  });

  it("carries the code and retry_after through the streaming path", async () => {
    scripted.runs = 0;
    scripted.budgetHold = new TurnBudgetHold("refill", 20 * 60_000, null);
    const { contents, errors } = await streamRaw([], "");
    scripted.budgetHold = null;
    expect(contents).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("m365_turn_budget");
    expect(errors[0].retry_after).toBe(20 * 60);
    expect(scripted.runs).toBe(0);
  });

  it("lets a streamed request wait as long as configured, an unstreamed one 2 min, and passes the client's signal", async () => {
    scripted.result = null;
    scripted.queue = [];
    scripted.awaitTurnBudgetCalls = [];
    await streamContents(["hi"]);
    const ac = new AbortController();
    const body = ChatCompletionRequest.parse({ model: "m365-copilot", stream: false, messages: [{ role: "user", content: "hi" }] });
    await handleChatCompletion(body, new SessionPool(), { signal: ac.signal });
    expect(scripted.awaitTurnBudgetCalls.map((c) => c.maxWaitMs)).toEqual([undefined, 2 * 60_000]);
    expect(scripted.awaitTurnBudgetCalls[1]!.signal).toBe(ac.signal);
  });

  it("makes the forcing retry wait for the budget too: every upstream turn goes through awaitTurnBudget", async () => {
    scripted.awaitTurnBudgetCalls = [];
    scripted.runs = 0;
    scripted.queue = [
      { fullText: "I can't access your files from here. Please paste the contents of calc.py." },
      { fullText: "```bash\ncat calc.py\n```" },
    ];
    const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
    const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, tools, messages: [{ role: "user", content: "fix calc.py" }] });
    const res = await handleChatCompletion(body, new SessionPool());
    expect(res.status).toBe(200);
    expect(scripted.runs).toBe(2);
    expect(scripted.awaitTurnBudgetCalls).toHaveLength(2);
    scripted.queue = [];
  });

  it("hands run() the same wait for its reconnect's turn (#77)", async () => {
    scripted.result = null;
    scripted.queue = [];
    scripted.awaitTurnBudgetCalls = [];
    scripted.budgetWaits = [];
    const ac = new AbortController();
    const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, messages: [{ role: "user", content: "hi" }] });
    await handleChatCompletion(body, new SessionPool(), { signal: ac.signal });
    expect(scripted.budgetWaits).toHaveLength(1);
    await scripted.budgetWaits[0]!(); // what run() does before it reconnects
    expect(scripted.awaitTurnBudgetCalls).toHaveLength(2);
    expect(scripted.awaitTurnBudgetCalls[1]).toEqual(scripted.awaitTurnBudgetCalls[0]);
    expect(scripted.awaitTurnBudgetCalls[1]!.maxWaitMs).toBe(2 * 60_000);
    expect(scripted.awaitTurnBudgetCalls[1]!.signal).toBe(ac.signal);
  });
});

describe("Disengage retry keeps a model's <system>-free framing", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];

  it("retries the prompt filter's canned apology once in a fresh conversation, like a Disengage", async () => {
    const APOLOGY = "Sorry, it looks like I can't chat about this. Let's try a different topic.";
    scripted.result = null;
    scripted.texts = [];
    scripted.newConversations = 0;
    // Live: the apology streams as contentOrigin "Apology"; the final item restates it under another origin.
    scripted.queue = [{ fullText: APOLOGY, contentOrigin: "DeepLeo", apology: true }, { fullText: "```bash\nls\n```" }];
    const body = ChatCompletionRequest.parse({
      model: "gpt-5.6-think-deeper", stream: false, tools,
      messages: [{ role: "user", content: "change the port in config.json to 8080, leave everything else unchanged" }],
    });
    const res = await handleChatCompletion(body, new SessionPool());
    scripted.queue = [];
    expect(res.status).toBe(200);
    expect(scripted.texts).toHaveLength(2);
    expect(scripted.newConversations).toBe(1);
    const message = (await res.json()).choices[0].message;
    expect(message.content ?? "").not.toContain("can't chat about this");
    expect(message.tool_calls[0].function.name).toBe("bash");
  });
  async function disengageThenAnswer(model: string): Promise<string> {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [{ fullText: "", messageType: "Disengaged" }, { fullText: "```bash\nls\n```" }];
    const body = ChatCompletionRequest.parse({
      model, stream: false, tools,
      messages: [{ role: "system", content: "sys" }, { role: "user", content: `do it ${model}` }],
    });
    const res = await handleChatCompletion(body, new SessionPool());
    expect(res.status).toBe(200);
    expect(scripted.texts).toHaveLength(2);
    scripted.queue = [];
    return scripted.texts[1];
  }

  it("retries Sonnet 5 with relay again, never a <system>-tagged framing", async () => {
    const retry = await disengageThenAnswer("claude-sonnet-5");
    expect(retry).not.toContain("<system>");
    expect(retry).toContain("guide me through this from my terminal, one command at a time");
    expect(retry).not.toContain("put as much as you can into one block");
  });

  it("sends Opus, Sonnet 4.6 and GPT-6 relay_batch on the first try and keeps it on the retry (§24, §25)", async () => {
    for (const model of ["claude-opus-4.8", "claude-opus", "claude-sonnet", "gpt-6-think-deeper"]) {
      const retry = await disengageThenAnswer(model);
      expect(scripted.texts[0]).toContain("put as much as you can into one block");
      expect(scripted.texts[0]).not.toContain("<system>");
      expect(retry).toContain("put as much as you can into one block");
    }
  });


  it("still retries the <system>-tagged defaults with softened (F22)", async () => {
    const retry = await disengageThenAnswer("gpt-5.5-think-deeper");
    expect(retry).toContain("<system>");
    expect(retry).toContain("You are an automated coding agent working in a real working directory");
  });
});

describe("which requests carry the tool agent (#41)", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];

  /** The `useAgent` flag the handler passed for one request on `model`. */
  async function agentFlagFor(model: string, withTools = true): Promise<boolean | undefined> {
    scripted.result = null;
    scripted.agentFlags = [];
    scripted.queue = [{ fullText: "```bash\nls\n```" }];
    const body = ChatCompletionRequest.parse({
      model, stream: false,
      ...(withTools ? { tools } : {}),
      messages: [{ role: "user", content: `list files ${model} ${Math.random()}` }],
    });
    const res = await handleChatCompletion(body, new SessionPool());
    expect(res.status).toBe(200);
    scripted.queue = [];
    expect(scripted.agentFlags).toHaveLength(1);
    return scripted.agentFlags[0];
  }

  afterEach(() => { delete process.env.M365_FORCE_AGENT; });

  it("sends gpt-6-think-deeper tool requests without the agent", async () => {
    expect(await agentFlagFor("gpt-6-think-deeper")).toBe(false);
  });

  it("still sends GPT-5.x tool requests with the agent", async () => {
    expect(await agentFlagFor("gpt-5.5-think-deeper")).toBe(true);
    expect(await agentFlagFor("m365-copilot")).toBe(true);
  });

  it("still sends Claude Sonnet tool requests without it", async () => {
    expect(await agentFlagFor("claude-sonnet")).toBe(false);
    expect(await agentFlagFor("claude-sonnet-5")).toBe(false);
  });

  it("sends both Opus models' tool requests with it (§24, §36)", async () => {
    expect(await agentFlagFor("claude-opus")).toBe(true);
    expect(await agentFlagFor("claude-opus-5[1m]")).toBe(true);
    expect(await agentFlagFor("claude-opus-4.8")).toBe(true);
    expect(await agentFlagFor("claude-opus-4.5")).toBe(true);
  });

  it("never attaches it to a request without tools — Opus 4.8 included, which serves agent-less (§36)", async () => {
    expect(await agentFlagFor("gpt-5.5-think-deeper", false)).toBe(false);
    expect(await agentFlagFor("claude-opus", false)).toBe(false);
    expect(await agentFlagFor("claude-opus-4.8", false)).toBe(false);
    expect(await agentFlagFor("claude-opus-4.5", false)).toBe(false);
  });

  it("lets M365_FORCE_AGENT=1 put it back", async () => {
    process.env.M365_FORCE_AGENT = "1";
    expect(await agentFlagFor("gpt-6-think-deeper")).toBe(true);
  });

  it("lets M365_FORCE_AGENT=0 take it away", async () => {
    process.env.M365_FORCE_AGENT = "0";
    expect(await agentFlagFor("gpt-5.5-think-deeper")).toBe(false);
  });
});

describe("GPT-6 Sol: agent on premium, learned fallback on non-premium (#23)", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const DEAD = { fullText: "", result: { value: "InternalError" } };
  const CALL = { fullText: "```bash\nls\n```" };

  async function send(model = "gpt-6-sol") {
    scripted.result = null;
    scripted.texts = [];
    scripted.agentFlags = [];
    scripted.newConversations = 0;
    const body = ChatCompletionRequest.parse({
      model, stream: false, tools,
      messages: [{ role: "system", content: "sys" }, { role: "user", content: `list files ${Math.random()}` }],
    });
    return respond(body);
  }

  afterEach(() => {
    resetAgentRoutes();
    scripted.queue = [];
    delete process.env.M365_FORCE_AGENT;
  });

  it("sends the agent first and keeps it when it serves (premium)", async () => {
    scripted.queue = [CALL];
    const res = await send();
    expect(res.status).toBe(200);
    expect(scripted.agentFlags).toEqual([true]);
    expect(scripted.newConversations).toBe(0);
  });

  it("on the dead route, re-sends the full prompt agent-less in a fresh conversation", async () => {
    scripted.queue = [DEAD, CALL];
    const res = await send();
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.tool_calls).toHaveLength(1);
    expect(scripted.agentFlags).toEqual([true, false]);
    expect(scripted.newConversations).toBe(1);
    // The retry is the whole request, not a "Please continue." into nothing.
    expect(scripted.texts[1]).toContain("list files");
    expect(scripted.texts[1]).toContain("```bash");
  });

  it("remembers it: the next request goes agent-less from the start", async () => {
    scripted.queue = [DEAD, CALL];
    await send();
    scripted.queue = [CALL];
    await send();
    expect(scripted.agentFlags).toEqual([false]);
    expect(scripted.newConversations).toBe(0);
  });

  it("treats InternalError as a transient once the agent has answered (premium, §23)", async () => {
    scripted.queue = [CALL];
    await send(); // the agent answered: this account is premium
    scripted.queue = [DEAD, CALL];
    const res = await send();
    expect(res.status).toBe(200);
    // No agent-less switch: the ordinary InternalError retry, which re-sends the
    // whole request in a fresh conversation — the dropped turn processed nothing,
    // so "Please continue." would lose the request.
    expect(scripted.newConversations).toBe(1);
    expect(scripted.agentFlags).toEqual([true, true]);
    expect(scripted.texts[1]).not.toBe("Please continue.");
    // The same request, in another conversation (the fake numbers its ids).
    const id = (t: string) => /<conversation_id>([^<]*)</.exec(t)?.[1];
    const sameRequest = (t: string) => t.replace(/<conversation_id>[^<]*</, "<conversation_id><");
    expect(id(scripted.texts[1])).not.toBe(id(scripted.texts[0]));
    expect(sameRequest(scripted.texts[1])).toBe(sameRequest(scripted.texts[0]));
    scripted.queue = [CALL];
    await send();
    expect(scripted.agentFlags).toEqual([true]);
  });

  it("doesn't touch tones outside PREMIUM_ONLY_AGENT_TONES", async () => {
    scripted.queue = [DEAD, CALL];
    const res = await send("gpt-5.5-think-deeper");
    expect(res.status).toBe(200);
    // The fresh-conversation InternalError retry, still with the agent.
    expect(scripted.newConversations).toBe(1);
    expect(scripted.agentFlags[1]).toBe(true);
  });

  it("doesn't fall back under M365_FORCE_AGENT=1", async () => {
    process.env.M365_FORCE_AGENT = "1";
    scripted.queue = [DEAD, CALL];
    await send();
    // The fresh-conversation InternalError retry, still with the agent.
    expect(scripted.newConversations).toBe(1);
    expect(scripted.agentFlags).toEqual([true, true]);
  });
});

describe("follow-up turns and give-ups (Windows / pi, measured)", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];

  async function ask(messages: any[], pool: InstanceType<typeof SessionPool>) {
    const res = await handleChatCompletion(ChatCompletionRequest.parse({ model: "gpt-5.6-think-deeper", stream: false, tools, messages }), pool);
    return (await res.json()).choices[0].message;
  }

  // A pi session is delta turns from turn 2 on. The delta path labelled every
  // tool result name="unknown" with no command — the misread formatMessages was
  // fixed for, and the turn on which live runs said "bash is not enabled".
  it("names a follow-up tool result after the call that produced it", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [{ fullText: "```bash\nls -la\n```" }, { fullText: "Done." }];
    const pool = new SessionPool();
    const messages: any[] = [{ role: "user", content: `look ${Math.random()}` }];
    const m1 = await ask(messages, pool);
    messages.push({ role: "assistant", content: null, tool_calls: m1.tool_calls });
    messages.push({ role: "tool", tool_call_id: m1.tool_calls[0].id, content: "README.md" });
    await ask(messages, pool);
    expect(scripted.texts[1]).toContain('<tool_response tool="bash" command="ls -la">');
    expect(scripted.texts[1]).not.toContain('name="unknown"');
    scripted.queue = [];
  });

  // Live: a refusal that came with "run these yourself" fences was parsed as two
  // tool calls (confab check skipped), then returned to the user as a document.
  it("forces a retry when a give-up comes dressed as a document", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      // Verbatim from the live run (pdf task, Windows / pi / gpt-5.6-think-deeper).
      { fullText: "Dosya oluşturma özelliği bu oturumda devre dışı olduğu için `notlar.pdf` dosyasını doğrudan oluşturamıyorum.\n\nYerel bilgisayarınızda Türkçe karakter desteğiyle dönüştürmek için şu komutu çalıştırabilirsiniz:\n\n```bash\nwinget install --id JohnMacFarlane.Pandoc\npandoc notlar.md -o notlar.pdf --pdf-engine=weasyprint\n```\n\n`weasyprint` eksikse:\n\n```bash\npy -m pip install weasyprint\npandoc notlar.md -o notlar.pdf --pdf-engine=weasyprint\n```\n\nHer iki komutu da `notlar.md` dosyasının bulunduğu klasörde çalıştırın. Dosyanın UTF-8 olarak kaydedilmiş olması `ç, ğ, ı, İ, ö, ş, ü` karakterlerinin doğru görünmesini sağlar." },
      { fullText: "```bash\nls -la\n```" },
    ];
    const m = await ask([{ role: "user", content: `pdf ${Math.random()}` }], new SessionPool());
    expect(scripted.texts).toHaveLength(2); // the forcing retry ran
    expect(m.tool_calls?.[0] && JSON.parse(m.tool_calls[0].function.arguments).command).toBe("ls -la");
    scripted.queue = [];
  });

  // Live: after a real tool result showed no PDF tool installed, the model said
  // "bash is not enabled"; the forcing prompt then claimed "you have not run any
  // command yet", and the model refused that too.
  it("doesn't tell a model that already ran tools that it ran nothing", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      { fullText: "```bash\ncommand -v pandoc || echo none\n```" },
      { fullText: "Dosya oluşturma araçları şu anda etkin olmadığı için notlar.pdf dosyasını oluşturamıyorum." },
      { fullText: "```bash\npy -m pip install fpdf2\n```" },
    ];
    const pool = new SessionPool();
    const messages: any[] = [{ role: "user", content: `pdf ${Math.random()}` }];
    const m1 = await ask(messages, pool);
    messages.push({ role: "assistant", content: null, tool_calls: m1.tool_calls });
    messages.push({ role: "tool", tool_call_id: m1.tool_calls[0].id, content: "none" });
    const m2 = await ask(messages, pool);
    expect(scripted.texts).toHaveLength(3);
    expect(scripted.texts[2]).toContain("Your tools are working");
    expect(scripted.texts[2]).not.toContain("you have not run any command yet");
    expect(JSON.parse(m2.tool_calls[0].function.arguments).command).toBe("py -m pip install fpdf2");
    scripted.queue = [];
  });

  describe("a single call after a long written answer (M365_LONG_ANSWER_GUARD)", () => {
    const doc = `# Recommendations\n${"Consider a local development improvement. ".repeat(45)}\n\n\`\`\`bash\nprintf example\n\`\`\``;
    // The maintainer's repro: an explanation with a python block whose comments start
    // with "# ", then the call that applies the fix.
    const fix = [
      "The date parser treats %d as zero padded everywhere, so single digit days fail. ".repeat(8),
      "",
      "```python",
      ...Array.from({ length: 14 }, (_, i) => `# case ${i}: a single digit day parses like its padded form\nassert parse("2026-11-${i + 1}") == parse("2026-11-${String(i + 1).padStart(2, "0")}")`),
      "```",
      "",
      "```bash\nsed -i 's/%d/%e/' src/date.py && pytest -q\n```",
    ].join("\n");

    afterEach(() => { delete process.env.M365_LONG_ANSWER_GUARD; });

    const reply = async (fullText: string) => {
      scripted.result = null;
      scripted.texts = [];
      scripted.queue = [{ fullText }];
      const m = await ask([{ role: "user", content: `recommendations ${Math.random()}` }], new SessionPool());
      scripted.queue = [];
      return m;
    };

    it.each([["long structured answer", doc], ["python block then sed && pytest", fix]])(
      "runs the call by default (%s)", async (_name, text) => {
        const m = await reply(text);
        expect(m.tool_calls).toHaveLength(1);
        expect(scripted.texts).toHaveLength(1);
      });

    it("returns the long structured answer as prose when the guard is on", async () => {
      process.env.M365_LONG_ANSWER_GUARD = "1";
      const m = await reply(doc);
      expect(scripted.texts).toHaveLength(1);
      expect(m.tool_calls).toBeUndefined();
      expect(m.content).toBe(doc);
    });

    it.each([
      ["mid-line python", "Example: ```python\n# comment\nx = 1\n```"],
      ["nested markdown", "```markdown\n```python\nx = 1\n```\n# comment\n```"],
      ["mid-line table", "Example: ```text\n| a | b |\n```"],
    ])("replay_7124b7e_fences: handler runs action after %s with guard on and off", async (_name, block) => {
      const text = `${"A detailed explanation of the fix without document structure. ".repeat(30)}\n${block}\n\`\`\`bash\nsed -i 's/a/b/' file && pytest -q\n\`\`\``;
      for (const enabled of [false, true]) {
        if (enabled) process.env.M365_LONG_ANSWER_GUARD = "1";
        else delete process.env.M365_LONG_ANSWER_GUARD;
        const m = await reply(text);
        expect(m.tool_calls).toHaveLength(1);
        expect(JSON.parse(m.tool_calls[0].function.arguments).command).toContain("sed -i");
      }
    });

    it.each([
      ["tilde python", "~~~python\n# comment\nx=1\n~~~\n```bash\nsed -i s/a/b/ file && pytest\n```"],
      ["four-backtick python", "````python\n# comment\nx=1\n````\n```bash\nsed -i s/a/b/ file && pytest\n```"],
    ])("replay_8d5a8dd_ambiguous: handler retains %s action", async (_name, suffix) => {
      const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n${suffix}`;
      for (const enabled of [false, true]) {
        if (enabled) process.env.M365_LONG_ANSWER_GUARD = "1";
        else delete process.env.M365_LONG_ANSWER_GUARD;
        const m = await reply(text);
        expect(m.tool_calls).toHaveLength(1);
        expect(JSON.parse(m.tool_calls[0].function.arguments).command).toContain("sed -i");
      }
    });

    // #139: since the CommonMark scanner (#71) these read as no call and no re-ask.
    it.fails.each([
      ["unclosed python before native closer", "```python\n# comment\nx=1\n```bash\nsed -i s/a/b/ file && pytest\n</invoke>"],
    ])("replay_8d5a8dd_ambiguous: handler retains %s action", async (_name, suffix) => {
      const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n${suffix}`;
      for (const enabled of [false, true]) {
        if (enabled) process.env.M365_LONG_ANSWER_GUARD = "1";
        else delete process.env.M365_LONG_ANSWER_GUARD;
        const m = await reply(text);
        expect(m.tool_calls).toHaveLength(1);
        expect(JSON.parse(m.tool_calls[0].function.arguments).command).toContain("sed -i");
      }
    });

    it.each(["# comment", "| table row |"])("replay_ea83f49_mixed_fences: handler retains action after four-backtick block containing %s", async (structure) => {
      const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n${"`".repeat(4)}python\n\`\`\`\n${structure}\n\`\`\`python\n${"`".repeat(4)}\n\`\`\`bash\nsed -i s/a/b/ file && pytest\n\`\`\``;
      for (const enabled of [false, true]) {
        if (enabled) process.env.M365_LONG_ANSWER_GUARD = "1";
        else delete process.env.M365_LONG_ANSWER_GUARD;
        const m = await reply(text);
        expect(m.tool_calls).toHaveLength(1);
        expect(JSON.parse(m.tool_calls[0].function.arguments).command).toBe("sed -i s/a/b/ file && pytest");
      }
    });

    it.each(["~~~", "~~~~"])("conservatively retains a call when %s appears inside a closed native fence", async (marker) => {
      const text = `# Heading\n${"Detailed explanation of the change. ".repeat(50)}\n\`\`\`python\n${marker}python\nx=1\n${marker}\n\`\`\`\n\`\`\`bash\nprintf example\n\`\`\``;
      for (const enabled of [false, true]) {
        if (enabled) process.env.M365_LONG_ANSWER_GUARD = "1";
        else delete process.env.M365_LONG_ANSWER_GUARD;
        const m = await reply(text);
        expect(m.tool_calls).toHaveLength(1);
        expect(JSON.parse(m.tool_calls[0].function.arguments).command).toBe("printf example");
      }
    });

    // #139: since the CommonMark scanner (#71) these read as no call and no re-ask.
    it.fails.each(["````", "`````"])("conservatively retains a call when %s appears inside a closed native fence", async (marker) => {
      const text = `# Heading\n${"Detailed explanation of the change. ".repeat(50)}\n\`\`\`python\n${marker}python\nx=1\n${marker}\n\`\`\`\n\`\`\`bash\nprintf example\n\`\`\``;
      for (const enabled of [false, true]) {
        if (enabled) process.env.M365_LONG_ANSWER_GUARD = "1";
        else delete process.env.M365_LONG_ANSWER_GUARD;
        const m = await reply(text);
        expect(m.tool_calls).toHaveLength(1);
        expect(JSON.parse(m.tool_calls[0].function.arguments).command).toBe("printf example");
      }
    });

    it.each(["# Heading", "| Area | Value |"])("conservatively keeps action with %s and a nested fence", async (structure) => {
      const text = `${structure}\n${"Useful explanation. ".repeat(90)}\nExample: \`\`\`markdown\n\`\`\`python\n# comment\n\`\`\`\n\`\`\`\n\`\`\`bash\nprintf example\n\`\`\``;
      delete process.env.M365_LONG_ANSWER_GUARD;
      expect((await reply(text)).tool_calls).toHaveLength(1);
      process.env.M365_LONG_ANSWER_GUARD = "1";
      const m = await reply(text);
      expect(m.tool_calls).toHaveLength(1);
    });

    it.each(["    | a | b |", "     | a | b |", "\t| a | b |", " \t| a | b |", "    # comment", "\t# comment"])("replay_f2d1258_indented: handler keeps action after code line %j", async (line) => {
      const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n\n${line}\n\n\`\`\`bash\nsed -i s/a/b/ file && pytest\n\`\`\``;
      for (const enabled of [false, true]) {
        if (enabled) process.env.M365_LONG_ANSWER_GUARD = "1";
        else delete process.env.M365_LONG_ANSWER_GUARD;
        const m = await reply(text);
        expect(m.tool_calls).toHaveLength(1);
        expect(JSON.parse(m.tool_calls[0].function.arguments).command).toBe("sed -i s/a/b/ file && pytest");
      }
    });

    it.each(["", " ", "  ", "   "])("handler recognizes real heading and table with %j indentation", async (indent) => {
      for (const structure of ["| a | b |\n" + indent + "| --- | --- |", "# Heading"]) {
        const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n\n${indent}${structure}\n\`\`\`bash\nprintf example\n\`\`\``;
        delete process.env.M365_LONG_ANSWER_GUARD;
        expect((await reply(text)).tool_calls).toHaveLength(1);
        process.env.M365_LONG_ANSWER_GUARD = "1";
        const m = await reply(text);
        expect(m.tool_calls).toBeUndefined();
        expect(m.content).toBe(text);
      }
    });

    it.each([
      ["HTML comment heading", "<!--\n# internal implementation note\n-->"],
      ["HTML comment table", "<!--\n| a | b |\n-->"],
      ["HTML pre", "<pre>\n# code comment\n</pre>"],
      ["multiline inline code", "Here is the snippet: `first line\n# this is code, not a heading\nlast line`"],
      ["indented code with real heading", "# Plan\n    x = 1"],
      ["inline code with real heading", "# Plan\nUse `example` here."],
      ["list with real heading", "# Plan\n- item"],
      ["link with real heading", "# Plan\n[reference](example)"],
    ])("replay_a804b53_markup: handler retains action with %s", async (_name, block) => {
      const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n\n${block}\n\n\`\`\`bash\nsed -i s/a/b/ file && pytest\n\`\`\``;
      for (const enabled of [false, true]) {
        if (enabled) process.env.M365_LONG_ANSWER_GUARD = "1";
        else delete process.env.M365_LONG_ANSWER_GUARD;
        const m = await reply(text);
        expect(m.tool_calls).toHaveLength(1);
        expect(JSON.parse(m.tool_calls[0].function.arguments).command).toBe("sed -i s/a/b/ file && pytest");
      }
    });

    describe.each([false, true])("table handler stream=%s", (stream) => {
    it.each([
      ["empty", "||", false], ["space", "| |", false], ["separator", "|---|---|", false],
      ["one row", "| a | b |", false], ["blank header", "| | |\n|---|---|", false],
      ["punctuation header", "| ... | --- |\n|---|---|", false],
      ["valid table", "| a | b |\n|---|---|\n| x | y |", true],
      ["escaped pipe", "| a \\| b | c |\n| --- | :---: |", true],
      ["mismatched columns", "| a | b |\n| --- |", false],
      ["CRLF spaced", "   | a | b |\r\n   | --- | --- |", true],
      ["four spaces", "    | a | b |\n    | --- | --- |", false],
      ["tab", "\t| a | b |\n\t| --- | --- |", false], ["heading", "# Heading", true],
    ])("replay_34e3a2d_table: handler JSON and SSE %s", async (_name, structure, expected) => {
      const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n\n${structure}\n\`\`\`bash\nsed -i s/a/b/ file && pytest\n\`\`\``;
      for (const enabled of [false, true]) {
        if (enabled) process.env.M365_LONG_ANSWER_GUARD = "1"; else delete process.env.M365_LONG_ANSWER_GUARD;
        scripted.result = null; scripted.texts = []; scripted.queue = [{ fullText: text }];
        const body = ChatCompletionRequest.parse({ model: "gpt-5.6-think-deeper", stream, tools, messages: [{ role: "user", content: `check ${Math.random()}` }] });
        const res = await handleChatCompletion(body, new SessionPool());
        expect(res.status).toBe(200);
        const prose = enabled && expected;
        if (!stream) {
          const m = (await res.json()).choices[0].message;
          if (prose) { expect(m.tool_calls).toBeUndefined(); expect(m.content).toBe(text); }
          else { expect(m.tool_calls).toHaveLength(1); expect(JSON.parse(m.tool_calls[0].function.arguments).command).toBe("sed -i s/a/b/ file && pytest"); }
        } else {
          const raw = await res.text();
          expect(raw).toContain("data: [DONE]");
          const chunks = raw.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]").map(l => JSON.parse(l.slice(6)));
          const deltas = chunks.map(c => c.choices?.[0]?.delta).filter(Boolean);
          const calls = deltas.flatMap(d => d.tool_calls ?? []);
          if (prose) { expect(calls).toHaveLength(0); expect(deltas.map(d => d.content ?? "").join("")).toBe(text); }
          else { expect(calls.length).toBeGreaterThan(0); expect(JSON.parse(calls.map(c => c.function?.arguments ?? "").join("")).command).toBe("sed -i s/a/b/ file && pytest"); }
        }
      }
    });

    });

    describe.each([false, true])("heading handler stream=%s", (stream) => {
      it.each([
        ["#  ", false], ["##    ", false], ["# ---", false], ["#", false], ["### !!!", false], ["#### ###", false],
        ["# Heading", true], ["## 123", true], ["### Café", true], ["  # 東京", true],
        ["| --- | ... |\n| --- | --- |", false], ["| 東京 | ... |\n| --- | --- |", true],
      ])("replay_84edab9_heading: meaningful structure %j", async (row, expected) => {
        const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n\n${row}\n\n\`\`\`bash\nsed -i s/a/b/ file && pytest\n\`\`\``;
        for (const enabled of [false, true]) {
          if (enabled) process.env.M365_LONG_ANSWER_GUARD = "1"; else delete process.env.M365_LONG_ANSWER_GUARD;
          scripted.result = null; scripted.texts = []; scripted.queue = [{ fullText: text }];
          const body = ChatCompletionRequest.parse({ model: "gpt-5.6-think-deeper", stream, tools, messages: [{ role: "user", content: `check ${Math.random()}` }] });
          const res = await handleChatCompletion(body, new SessionPool());
          expect(res.status).toBe(200);
          if (!stream) {
            const m = (await res.json()).choices[0].message;
            if (enabled && expected) { expect(m.tool_calls).toBeUndefined(); expect(m.content).toBe(text); }
            else { expect(m.tool_calls).toHaveLength(1); expect(JSON.parse(m.tool_calls[0].function.arguments).command).toBe("sed -i s/a/b/ file && pytest"); }
          } else {
            const raw = await res.text(); expect(raw).toContain("data: [DONE]");
            const deltas = raw.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]").map(l => JSON.parse(l.slice(6)).choices?.[0]?.delta).filter(Boolean);
            const calls = deltas.flatMap(d => d.tool_calls ?? []);
            if (enabled && expected) { expect(calls).toHaveLength(0); expect(deltas.map(d => d.content ?? "").join("")).toBe(text); }
            else { expect(calls.length).toBeGreaterThan(0); expect(JSON.parse(calls.map(c => c.function?.arguments ?? "").join("")).command).toBe("sed -i s/a/b/ file && pytest"); }
          }
        }
      });
    });

    it("returns a structured answer with a native-closer example only when enabled", async () => {
      const text = `# Recommendations\n${"Useful explanation. ".repeat(90)}\n\`\`\`bash\nprintf example\n</invoke>`;
      delete process.env.M365_LONG_ANSWER_GUARD;
      expect((await reply(text)).tool_calls).toHaveLength(1);
      process.env.M365_LONG_ANSWER_GUARD = "1";
      const m = await reply(text);
      expect(m.tool_calls).toBeUndefined();
      expect(m.content).toBe(text);
    });

    it("still runs the python-block-then-sed call when the guard is on", async () => {
      process.env.M365_LONG_ANSWER_GUARD = "1";
      const m = await reply(fix);
      expect(m.tool_calls).toHaveLength(1);
      expect(JSON.parse(m.tool_calls[0].function.arguments).command).toContain("sed -i");
    });
  });

  it("leaves a real document alone even if its body sounds like a give-up", async () => {
    scripted.result = null;
    scripted.texts = [];
    const doc = "Here is the README you asked for:\n\n# Setup\n\nIf you can't access the API, check the token.\n\n```bash\nnpm install\n```\n\n```bash\nnpm test\n```";
    scripted.queue = [{ fullText: doc }];
    const m = await ask([{ role: "user", content: `readme ${Math.random()}` }], new SessionPool());
    expect(scripted.texts).toHaveLength(1); // no forcing retry
    expect(m.tool_calls).toBeUndefined();
    expect(m.content).toContain("If you can't access the API");
    scripted.queue = [];
  });
});

describe("a new harness session that shares the first user message", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const ask = async (messages: any[], pool: InstanceType<typeof SessionPool>) =>
    (await (await handleChatCompletion(ChatCompletionRequest.parse({ model: "gpt-5.6-think-deeper", stream: false, tools, messages }), pool)).json()).choices[0].message;

  // Measured: pi sessions opened with the same prompt (even in different
  // directories) were joined to the first session's M365 conversation and
  // answered from it — "notlar.docx was already created" in an empty directory.
  it("gets a fresh M365 conversation after a longer earlier session", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.convs = [];
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "Done." }, { fullText: "```bash\nls\n```" }];
    const pool = new SessionPool();
    const prompt = `make a pdf ${Math.random()}`;
    const first: any[] = [{ role: "user", content: prompt }];
    const m1 = await ask(first, pool);
    first.push({ role: "assistant", content: null, tool_calls: m1.tool_calls });
    first.push({ role: "tool", tool_call_id: m1.tool_calls[0].id, content: "notlar.md" });
    await ask(first, pool);
    await ask([{ role: "user", content: prompt }], pool); // a new session, same opener
    expect(scripted.convs[2]).not.toBe(scripted.convs[0]);
    expect(scripted.texts[2]).toContain(prompt); // the full prompt, not a delta
    scripted.queue = [];
  });

  it("gets one after a single-turn session too (equal length used to send 'Please continue.')", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.convs = [];
    scripted.queue = [{ fullText: "I can't do that." }, { fullText: "```bash\nls\n```" }];
    const pool = new SessionPool();
    const prompt = `make a docx ${Math.random()}`;
    await ask([{ role: "user", content: prompt }], pool);
    await ask([{ role: "user", content: prompt }], pool);
    expect(scripted.convs[1]).not.toBe(scripted.convs[0]);
    expect(scripted.texts[scripted.texts.length - 1]).not.toBe("Please continue.");
    expect(scripted.texts[scripted.texts.length - 1]).toContain(prompt);
    scripted.queue = [];
  });

  it("still continues a real continuation in the same conversation", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.convs = [];
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "Done." }];
    const pool = new SessionPool();
    const msgs: any[] = [{ role: "user", content: `go ${Math.random()}` }];
    const m1 = await ask(msgs, pool);
    msgs.push({ role: "assistant", content: null, tool_calls: m1.tool_calls });
    msgs.push({ role: "tool", tool_call_id: m1.tool_calls[0].id, content: "a.txt" });
    await ask(msgs, pool);
    expect(scripted.convs[1]).toBe(scripted.convs[0]);
    expect(scripted.texts[1]).toContain('<tool_response tool="bash"'); // a delta
    scripted.queue = [];
  });

  // §52 F153: the fresh conversation used to REPLACE the earlier session's, so a
  // session still running (two measurement jobs at once) lost its thread each
  // time the other one moved, and its next delta landed in the other's.
  it("leaves the earlier session's conversation alone: each continues in its own", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.convs = [];
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "```bash\npwd\n```" }, { fullText: "X done." }, { fullText: "Y done." }];
    const pool = new SessionPool();
    const prompt = `merhaba ${Math.random()}`;
    const x: any[] = [{ role: "user", content: prompt }];
    const y: any[] = [{ role: "user", content: prompt }];
    const mx = await ask(x, pool);
    const my = await ask(y, pool);
    x.push({ role: "assistant", content: null, tool_calls: mx.tool_calls }, { role: "tool", tool_call_id: mx.tool_calls[0].id, content: "x.txt" });
    y.push({ role: "assistant", content: null, tool_calls: my.tool_calls }, { role: "tool", tool_call_id: my.tool_calls[0].id, content: "/y" });
    await ask(x, pool);
    await ask(y, pool);
    expect(scripted.convs[1]).not.toBe(scripted.convs[0]);
    expect(scripted.convs[2]).toBe(scripted.convs[0]);
    expect(scripted.convs[3]).toBe(scripted.convs[1]);
    expect(scripted.texts[2]).toContain("x.txt"); // deltas, each in its own thread
    expect(scripted.texts[3]).toContain("/y");
    scripted.queue = [];
  });

  it("tells text replies apart too", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.convs = [];
    scripted.queue = [{ fullText: "Hi from X." }, { fullText: "Hi from Y." }, { fullText: "Sure." }];
    const pool = new SessionPool();
    const prompt = `hi ${Math.random()}`;
    const mx = await ask([{ role: "user", content: prompt }], pool);
    await ask([{ role: "user", content: prompt }], pool);
    await ask([{ role: "user", content: prompt }, { role: "assistant", content: mx.content }, { role: "user", content: "and X?" }], pool);
    expect(scripted.convs[2]).toBe(scripted.convs[0]); // X's, though Y spoke last
    scripted.queue = [];
  });

  it("gives a same-opener request its own conversation while a turn is in flight", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.convs = [];
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "```bash\nls\n```" }];
    const pool = new SessionPool();
    const prompt = `parallel ${Math.random()}`;
    await Promise.all([ask([{ role: "user", content: prompt }], pool), ask([{ role: "user", content: prompt }], pool)]);
    expect(scripted.convs[1]).not.toBe(scripted.convs[0]);
    scripted.queue = [];
  });

  it("still continues when the client rewrote the reply it echoes", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.convs = [];
    scripted.queue = [{ fullText: "Hello there." }, { fullText: "Sure." }];
    const pool = new SessionPool();
    const prompt = `hello ${Math.random()}`;
    const m1 = await ask([{ role: "user", content: prompt }], pool);
    await ask([{ role: "user", content: prompt }, { role: "assistant", content: `${m1.content} (trimmed)` }, { role: "user", content: "and now?" }], pool);
    expect(scripted.convs[1]).toBe(scripted.convs[0]);
    expect(scripted.texts[1]).not.toContain(prompt); // a delta, not a fresh full prompt
    scripted.queue = [];
  });

  // With two conversations on one fingerprint, a guess would put one session's
  // turn into the other's thread; an unmatched echo starts fresh instead.
  it("doesn't guess between several conversations when the echo matches none", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.convs = [];
    scripted.queue = [{ fullText: "Hi from X." }, { fullText: "Hi from Y." }, { fullText: "Sure." }];
    const pool = new SessionPool();
    const prompt = `guess ${Math.random()}`;
    await ask([{ role: "user", content: prompt }], pool);
    await ask([{ role: "user", content: prompt }], pool);
    await ask([{ role: "user", content: prompt }, { role: "assistant", content: "something neither said" }, { role: "user", content: "and now?" }], pool);
    expect(scripted.convs[2]).not.toBe(scripted.convs[0]);
    expect(scripted.convs[2]).not.toBe(scripted.convs[1]);
    expect(scripted.texts[2]).toContain(prompt); // the full history, in a fresh conversation
    scripted.queue = [];
  });

  it("returns M365's file markup as the bare file name, outside code blocks", async () => {
    scripted.result = null;
    scripted.queue = [{ fullText: "<File>notlar.docx</File> oluşturuldu; < File>ozet.md</File> da hazır. Etiket: `<File>a.txt</File>`.\n\n```xml\n<File>keep.xml</File>\n```\n\n~~~xml\n<File>tilde.xml</File>\n~~~\n\n```xml\n<File>unclosed.xml</File>" }];
    const m = await ask([
      { role: "user", content: `docx ${Math.random()}` },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "notlar.md" },
    ], new SessionPool());
    expect(m.content).toBe("notlar.docx oluşturuldu; ozet.md da hazır. Etiket: `<File>a.txt</File>`.\n\n```xml\n<File>keep.xml</File>\n```\n\n~~~xml\n<File>tilde.xml</File>\n~~~\n\n```xml\n<File>unclosed.xml</File>");
    scripted.queue = [];
  });
});

describe("a side request that shares the session's first user message (#83)", () => {
  const tools = [
    { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
    { type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  ];
  const post = (pool: InstanceType<typeof SessionPool>, messages: any[], withTools?: unknown[]) =>
    handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet-5", stream: false, ...(withTools ? { tools: withTools } : {}), messages }), pool);

  it("puts opencode's title request in a conversation of its own, though it arrives with the task", async () => {
    scripted.result = null;
    scripted.texts = [];
    servedBy.length = 0;
    scripted.newConversations = 0;
    scripted.queue = [{ fullText: "Fix calc bug" }, { fullText: "```bash\nls\n```" }, { fullText: "Done." }];
    const pool = new SessionPool();
    const opener = { role: "user", content: `calc.py prints the wrong result ${Math.random()}` };
    // Like opencode: the title request (no tools) and the task (tools), at the same time.
    const [, task] = await Promise.all([
      post(pool, [{ role: "system", content: "You are a title generator. You output ONLY a thread title." }, opener]),
      post(pool, [{ role: "system", content: "You are an AI agent running in OpenCode." }, opener], tools),
    ]);
    expect(pool.size).toBe(2);
    expect(servedBy[0]).not.toBe(servedBy[1]);
    const call = (await task.json()).choices[0].message.tool_calls[0];
    // The task's next turn continues the task's conversation, as a delta.
    await post(pool, [
      { role: "system", content: "You are an AI agent running in OpenCode." }, opener,
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "calc.py" },
    ], tools);
    expect(servedBy[2]).toBe(servedBy[1]);
    expect(scripted.texts[2]).toContain('<tool_response tool="bash"');
    expect(scripted.newConversations).toBe(0);
    scripted.queue = [];
  });

  it("keys on the tool names, not their order or descriptions", async () => {
    scripted.result = null;
    servedBy.length = 0;
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "Done." }];
    const pool = new SessionPool();
    const opener = { role: "user", content: `list it ${Math.random()}` };
    const call = (await (await post(pool, [opener], tools)).json()).choices[0].message.tool_calls[0];
    const reordered = [{ ...tools[1], function: { ...tools[1].function, description: "Read a file (cwd: /tmp/x)" } }, tools[0]];
    await post(pool, [opener, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: "a.txt" }], reordered);
    expect(pool.size).toBe(1);
    expect(servedBy[1]).toBe(servedBy[0]);
    scripted.queue = [];
  });

  it("sends the whole history when a session changes its tool set", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "Done." }];
    const pool = new SessionPool();
    const opener = { role: "user", content: `look ${Math.random()}` };
    const call = (await (await post(pool, [opener], [tools[0]])).json()).choices[0].message.tool_calls[0];
    await post(pool, [opener, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: "a.txt" }], tools);
    expect(pool.size).toBe(2);
    expect(scripted.texts[1]).toContain(opener.content); // the full prompt, not a delta into a fresh conversation
    scripted.queue = [];
  });
});

describe("Opus 4.8 on an account that can't serve it (§24, §36)", () => {
  const DEAD = { fullText: "", result: { value: "InternalError" } };
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];

  afterEach(() => {
    resetAgentRoutes();
    scripted.queue = [];
  });

  async function deadRoute(withTools: boolean) {
    scripted.result = null;
    scripted.agentFlags = [];
    scripted.newConversations = 0;
    scripted.queue = [DEAD, DEAD, DEAD];
    const body = ChatCompletionRequest.parse({
      model: "claude-opus-4.8", stream: false, ...(withTools ? { tools } : {}),
      messages: [{ role: "user", content: `hello ${Math.random()}` }],
    });
    const res = await respond(body);
    expect(res.status).toBe(502);
    const err = (await res.json()).error;
    expect(err.code).toBe("model_route_unavailable");
    expect(err.message).toContain("premium");
    expect(scripted.newConversations).toBe(0);
  }

  it("says the model is premium-only instead of 'empty response' on a tool-less (agent-less) request", async () => {
    await deadRoute(false);
    expect(scripted.agentFlags).toEqual([false, false, false]);
  });

  it("…and on a tool request, which keeps the agent: agent-less is dead too, so there's no fallback", async () => {
    await deadRoute(true);
    expect(scripted.agentFlags).toEqual([true, true, true]);
  });

  it("keeps the generic message for other models' empty InternalErrors", async () => {
    scripted.result = null;
    scripted.queue = [DEAD, DEAD, DEAD];
    const body = ChatCompletionRequest.parse({
      model: "claude-opus", stream: false,
      messages: [{ role: "user", content: `hello ${Math.random()}` }],
    });
    const res = await respond(body);
    expect(res.status).toBe(502);
    expect((await res.json()).error.type).toBe("upstream_empty_response");
  });
});

describe("Priority access (Opus 5.5, Sonnet 5.5): OutOfCredits, remembering it, metering, the opt-in fallback (#18)", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const WEEKLY = "You\u2019ve used your available priority access to the Opus model for the week. You can choose another available model or wait until Monday to use the Opus model again.";
  const REFUSAL = { fullText: WEEKLY, result: { value: "OutOfCredits", message: WEEKLY } };
  const CALL = { fullText: "```bash\nls\n```", metering: { ClaudeOpusQueryDaily: 12, ClaudeOpusQuery75: 30 } };

  async function send(model = "claude-opus", content = `list files ${Math.random()}`, stream = false) {
    scripted.result = null;
    scripted.texts = [];
    scripted.models = [];
    scripted.agentFlags = [];
    scripted.newConversations = 0;
    const body = ChatCompletionRequest.parse({
      model, stream, tools,
      messages: [{ role: "system", content: "sys" }, { role: "user", content }],
    });
    return handleChatCompletion(body, pool);
  }
  let pool = new SessionPool();

  afterEach(() => {
    resetPriorityAccessState();
    scripted.queue = [];
    delete process.env.M365_OPUS_FALLBACK_MODEL;
    delete process.env.M365_SONNET_FALLBACK_MODEL;
    pool = new SessionPool();
  });

  it("surfaces the Opus allowances left in usage", async () => {
    scripted.queue = [CALL];
    const res = await send();
    const usage = (await res.json()).usage;
    expect(usage.x_m365_opus_daily_remaining).toBe(12);
    expect(usage.x_m365_opus_weekly_remaining).toBe(30);
  });

  it("429s an OutOfCredits turn with the weekly reset", async () => {
    scripted.queue = [REFUSAL];
    const res = await send();
    expect(res.status).toBe(429);
    const err = (await res.json()).error;
    expect(err.code).toBe("priority_access_exhausted");
    expect(err.param).toBe("week");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("then answers later metered Opus requests itself, without an M365 turn", async () => {
    scripted.queue = [REFUSAL];
    await send();
    const res = await send("claude-opus", "another task");
    expect(res.status).toBe(429);
    expect(scripted.models).toEqual([]); // nothing sent upstream
    // Opus 4.8 isn't metered, so it is unaffected.
    scripted.queue = [CALL];
    expect((await send("claude-opus-4.8", "third task")).status).toBe(200);
    expect(scripted.models).toEqual(["claude-opus-4.8"]);
  });

  it("with M365_OPUS_FALLBACK_MODEL, re-sends the whole request to it in a fresh conversation", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.8";
    scripted.queue = [REFUSAL, { fullText: "```bash\nls\n```" }];
    const res = await send();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.tool_calls).toHaveLength(1);
    expect(json.model).toBe("claude-opus-4.8"); // says who answered
    expect(scripted.models).toEqual(["claude-opus", "claude-opus-4.8"]);
    expect(scripted.newConversations).toBe(1);
    expect(scripted.agentFlags).toEqual([true, true]);
    expect(scripted.texts[1]).toContain("list files"); // the whole request, not a delta
  });

  it("…and routes the next requests straight to the fallback until the reset", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.8";
    scripted.queue = [REFUSAL, { fullText: "```bash\nls\n```" }];
    await send();
    scripted.queue = [{ fullText: "```bash\npwd\n```" }];
    const res = await send("claude-opus", "another task");
    expect(res.status).toBe(200);
    expect(scripted.models).toEqual(["claude-opus-4.8"]);
  });

  it("starts a fresh conversation when an ongoing Opus 5.5 conversation moves to the fallback", async () => {
    scripted.queue = [CALL];
    await send("claude-opus", "long task");          // turn 1 served by Opus 5.5
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.8";
    scripted.queue = [REFUSAL, { fullText: "Done." }];
    // the client continues the same conversation with a tool result
    scripted.texts = []; scripted.models = []; scripted.newConversations = 0;
    const body = ChatCompletionRequest.parse({
      model: "claude-opus", stream: false, tools,
      messages: [
        { role: "system", content: "sys" }, { role: "user", content: "long task" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }] },
        { role: "tool", tool_call_id: "c1", content: "a.txt" },
      ],
    });
    const res = await handleChatCompletion(body, pool);
    expect(res.status).toBe(200);
    expect(scripted.models).toEqual(["claude-opus", "claude-opus-4.8"]);
    expect(scripted.texts[1]).toContain("long task");   // full history for the new model
    expect(scripted.texts[1]).toContain("a.txt");
  });

  it("never falls back for an unmetered model's refusal text", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.8";
    scripted.queue = [{ fullText: WEEKLY }];
    const res = await send("gpt-5.5-think-deeper");
    expect(res.status).toBe(429);
    expect(scripted.models).toEqual(["gpt-5.5-think-deeper"]);
  });

  it("falls back on the streaming path too, without leaking the refusal", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.8";
    scripted.queue = [REFUSAL, { fullText: "Hello from 4.8" }];
    scripted.result = null; scripted.models = [];
    const body = ChatCompletionRequest.parse({ model: "claude-opus", stream: true, messages: [{ role: "user", content: `hi ${Math.random()}` }] });
    const res = await handleChatCompletion(body, pool);
    const text = await res.text();
    expect(text).toContain("Hello from 4.8");
    expect(text).not.toContain("priority access");
    expect(scripted.models).toEqual(["claude-opus", "claude-opus-4.8"]);
  });

  // Sonnet 5.5 has a budget of its own (§26): ClaudeSonnet55QueryDaily/Weekly.
  const SONNET_DAILY = "You\u2019ve used your available priority access to the Sonnet model for today. You can choose another available model or wait until tomorrow to use the Sonnet model again.";
  const SONNET_REFUSAL = { fullText: SONNET_DAILY, result: { value: "OutOfCredits", message: SONNET_DAILY } };

  it("surfaces Sonnet 5.5's allowances in usage, next to Opus's", async () => {
    scripted.queue = [{ fullText: "```bash\nls\n```", metering: { ClaudeOpusQueryDaily: 12, ClaudeOpusQuery75: 30, ClaudeSonnet55QueryDaily: 79, ClaudeSonnet55QueryWeekly: 149 } }];
    const usage = (await (await send("claude-sonnet-5.5")).json()).usage;
    expect(usage.x_m365_sonnet55_daily_remaining).toBe(79);
    expect(usage.x_m365_sonnet55_weekly_remaining).toBe(149);
    expect(usage.x_m365_opus_daily_remaining).toBe(12);
  });

  it("keeps the Sonnet 5.5 and Opus walls apart", async () => {
    scripted.queue = [SONNET_REFUSAL];
    const res = await send("claude-sonnet-5.5");
    expect(res.status).toBe(429);
    expect((await res.json()).error.param).toBe("day");
    // Sonnet 5.5 is answered locally until the reset…
    expect((await send("claude-sonnet-5.5", "another task")).status).toBe(429);
    expect(scripted.models).toEqual([]);
    // …while Opus 5.5, Sonnet 5 and Sonnet 4.6 still go upstream.
    for (const model of ["claude-opus", "claude-sonnet-5", "claude-sonnet"]) {
      scripted.queue = [CALL];
      expect((await send(model, `task for ${model}`)).status).toBe(200);
      expect(scripted.models).toEqual([model]);
    }
  });

  it("with M365_SONNET_FALLBACK_MODEL, re-sends a Sonnet 5.5 request to it", async () => {
    process.env.M365_SONNET_FALLBACK_MODEL = "claude-sonnet-5";
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.8"; // the other budget's, unused here
    scripted.queue = [SONNET_REFUSAL, { fullText: "```bash\nls\n```" }];
    const res = await send("claude-sonnet-5.5");
    expect(res.status).toBe(200);
    expect((await res.json()).model).toBe("claude-sonnet-5");
    expect(scripted.models).toEqual(["claude-sonnet-5.5", "claude-sonnet-5"]);
    expect(scripted.agentFlags).toEqual([false, false]);
  });

  it("remembers an unexpected OutOfCredits under that model alone", async () => {
    scripted.queue = [{ fullText: "Out of credits.", result: { value: "OutOfCredits", message: "Out of credits." } }];
    expect((await send("gpt-6-sol")).status).toBe(429);
    expect((await send("gpt-6-sol", "again")).status).toBe(429);
    expect(scripted.models).toEqual([]);
    scripted.queue = [CALL];
    expect((await send("claude-opus", "opus task")).status).toBe(200);
  });
});

describe("image input (#39)", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  const tools = [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }];

  it("sends a read image with the turn that carries its tool result, and only that turn", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.images = [];
    scripted.queue = [{ fullText: "```read\npath: chart.png\n```" }, { fullText: "The title is Lot 7." }];
    const pool = new SessionPool();
    const messages: any[] = [{ role: "user", content: `what does chart.png say? ${Math.random()}` }];
    const ask = async () => (await (await handleChatCompletion(ChatCompletionRequest.parse({ model: "gpt-5.6-think-deeper", stream: false, tools, messages }), pool)).json()).choices[0].message;
    const call = (await ask()).tool_calls[0];
    // pi's shape for a model with image input: the tool result, then the image in a user message.
    messages.push({ role: "assistant", content: null, tool_calls: [call] });
    messages.push({ role: "tool", tool_call_id: call.id, content: "Read image file [image/png]" });
    messages.push({ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, { type: "image_url", image_url: { url: PNG } }] });
    expect((await ask()).content).toBe("The title is Lot 7.");
    expect(scripted.images).toEqual([[], [PNG]]);
    expect(scripted.texts[1]).toContain("Attached image(s) from tool result:");
    scripted.queue = [];
  });

  it("sends the images of the whole history with a full prompt", async () => {
    scripted.result = null;
    scripted.images = [];
    scripted.queue = [{ fullText: "A red square." }];
    const body = ChatCompletionRequest.parse({
      model: "gpt-5.6-think-deeper", stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: `what is this? ${Math.random()}` }, { type: "image_url", image_url: { url: PNG, detail: "auto" } }] }],
    });
    await handleChatCompletion(body, new SessionPool());
    expect(scripted.images).toEqual([[PNG]]);
    scripted.queue = [];
  });

  it("sends a document file part along with the images, its name folded into the data URL", async () => {
    scripted.result = null;
    scripted.images = [];
    scripted.queue = [{ fullText: "Revision C." }];
    const body = ChatCompletionRequest.parse({
      model: "gpt-5.6-think-deeper", stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: `what revision? ${Math.random()}` },
        { type: "file", file: { filename: "spec.pdf", file_data: "data:application/pdf;base64,JVBERi0=" } },
      ] }],
    });
    await handleChatCompletion(body, new SessionPool());
    expect(scripted.images).toEqual([["data:application/pdf;name=spec.pdf;base64,JVBERi0="]]);
    scripted.queue = [];
  });
});

describe("stopping a turn that writes its own <tool_response> (early stop)", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  // A call, then the model's own result and the rest of an invented session:
  // a short tail (~500 chars, the usual kind) and a runaway (~3,700).
  const head = ["```bash\nls\n```\n\n", "<tool_res", "ponse>\nconfig.json\n</tool_response>\n\n"];
  const steps = (n: number) => Array.from({ length: n }, (_, i) => `invented step ${i}\n`);
  const short = [...head, ...steps(30)];
  const runaway = [...head, ...steps(200)];
  const tagAt = head[0].length;

  /** How many deltas have streamed once the tail is `after` chars past the tag. */
  function deltasUntil(deltas: string[], after: number): number {
    let n = 0, len = 0;
    while (len - tagAt < after) len += deltas[n++].length;
    return n;
  }

  async function toolTurn(deltas: string[], withTools = true, env: Record<string, string> = {}): Promise<any> {
    scripted.result = null;
    scripted.queue = [];
    scripted.deltas = deltas;
    scripted.fullText = undefined;
    scripted.liveFullText = true;
    Object.assign(process.env, env);
    try {
      const res = await respond(ChatCompletionRequest.parse({
        model: "claude-sonnet", stream: false, messages: [{ role: "user", content: `stop ${Math.random()}` }],
        ...(withTools ? { tools } : {}),
      }));
      return (await res.json()).choices[0].message;
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
      scripted.liveFullText = false;
      scripted.deltas = [];
    }
  }

  it("lets a short invented tail run to its end, then cuts it and runs the call", async () => {
    const msg = await toolTurn(short);
    expect(scripted.signals.at(-1)?.aborted).toBe(false);
    expect(scripted.stoppedAfter).toBeNull();
    expect(msg.tool_calls).toHaveLength(1);
    expect(JSON.parse(msg.tool_calls[0].function.arguments).command).toBe("ls");
    expect(msg.content ?? "").not.toContain("invented step");
  });

  it("stops a runaway once its tail is 2,000 chars past the tag, and runs the call", async () => {
    const msg = await toolTurn(runaway);
    const n = deltasUntil(runaway, 2000);
    expect(n).toBeLessThan(runaway.length);
    expect(scripted.signals.at(-1)?.aborted).toBe(true);
    expect(scripted.stoppedAfter).toBe(n);
    expect(JSON.parse(msg.tool_calls[0].function.arguments).command).toBe("ls");
  });

  it("stops at the tag itself under M365_EARLY_STOP_AFTER=0, even split across deltas", async () => {
    const msg = await toolTurn(short, true, { M365_EARLY_STOP_AFTER: "0" });
    expect(scripted.signals.at(-1)?.aborted).toBe(true);
    expect(scripted.stoppedAfter).toBe(3); // the tag completes in the third delta
    expect(JSON.parse(msg.tool_calls[0].function.arguments).command).toBe("ls");
  });

  it("honours another M365_EARLY_STOP_AFTER", async () => {
    await toolTurn(short, true, { M365_EARLY_STOP_AFTER: "100" });
    expect(scripted.stoppedAfter).toBe(deltasUntil(short, 100));
  });

  it("doesn't stop for a tag that follows prose rather than a call", async () => {
    const msg = await toolTurn(["I can't run tools here. A result would look like ", "<tool_response>…</tool_response>", " and so on."], true, { M365_EARLY_STOP_AFTER: "0" });
    expect(scripted.signals.at(-1)?.aborted ?? false).toBe(false);
    expect(scripted.stoppedAfter).toBeNull();
    expect(msg.tool_calls ?? []).toHaveLength(0);
  });

  it("leaves a request without tools alone", async () => {
    await toolTurn(runaway, false);
    expect(scripted.signals.at(-1)).toBeUndefined();
    expect(scripted.stoppedAfter).toBeNull();
  });

  it("waits for the turn to end under M365_NO_EARLY_STOP=1, and still cuts the invented tail", async () => {
    const msg = await toolTurn(runaway, true, { M365_NO_EARLY_STOP: "1" });
    expect(scripted.signals.at(-1)?.aborted ?? false).toBe(false);
    expect(scripted.stoppedAfter).toBeNull();
    expect(JSON.parse(msg.tool_calls[0].function.arguments).command).toBe("ls");
  });
});

describe("Claude Code and Codex behind copilot-api", () => {
  const CLAUDE_CODE_UA = "claude-cli/2.1.286 (external, sdk-cli)";
  const bashTool = [{ type: "function", function: { name: "Bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];

  /** One streaming request; returns the content text, the error chunks and the finish reason. */
  async function streamAs(userAgent: string, prompt: string) {
    const body = ChatCompletionRequest.parse({
      model: "claude-sonnet", stream: true, messages: [{ role: "user", content: prompt }],
    });
    const res = await handleChatCompletion(body, new SessionPool(), { userAgent });
    expect(res.status).toBe(200);
    let content = "";
    const errors: any[] = [];
    let finish: string | null = null;
    for (const line of (await res.text()).split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const chunk = JSON.parse(line.slice(6));
      if (chunk.error) errors.push(chunk.error);
      content += chunk.choices?.[0]?.delta?.content ?? "";
      finish = chunk.choices?.[0]?.finish_reason ?? finish;
    }
    return { content, errors, finish };
  }

  it("ends a failed streaming turn with the reason as text, so the harness doesn't retry it", async () => {
    scripted.queue = [];
    scripted.deltas = [];
    scripted.fullText = "";
    scripted.result = { value: "Throttled", errorCode: "PerUserThrottled", message: "Try again later." };
    const { content, errors, finish } = await streamAs(CLAUDE_CODE_UA, "throttled for the harness");
    scripted.result = null;
    expect(errors).toHaveLength(0);
    expect(content).toContain("[m365-proxy: m365_throttled]");
    expect(content).toContain("Try again later.");
    expect(finish).toBe("stop");
  });

  it("keeps the error chunk for other clients", async () => {
    scripted.queue = [];
    scripted.result = { value: "Throttled", errorCode: "PerUserThrottled", message: "Try again later." };
    const { content, errors } = await streamAs("OpenAI/JS 5.1.0", "throttled for pi");
    scripted.result = null;
    expect(content).toBe("");
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("m365_throttled");
  });

  it("sends keepalive chunks while the turn is silent, and the reason as the very last chunk", async () => {
    scripted.queue = [];
    scripted.deltas = [];
    scripted.fullText = "";
    scripted.result = { value: "Throttled", errorCode: "PerUserThrottled", message: "Try again later." };
    let release!: () => void;
    scripted.gate = new Promise<void>((r) => { release = r; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const body = ChatCompletionRequest.parse({
        model: "claude-sonnet", stream: true, messages: [{ role: "user", content: "silent, then throttled" }],
      });
      const pending = handleChatCompletion(body, new SessionPool(), { userAgent: CLAUDE_CODE_UA }).then((res) => res.text());
      await vi.advanceTimersByTimeAsync(31_000);
      release();
      const chunks = (await pending).split("\n")
        .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
        .map((l) => JSON.parse(l.slice(6)));
      const beats = chunks.filter((c) => c.choices?.[0]?.finish_reason === null && Object.keys(c.choices[0].delta ?? {}).length === 0);
      expect(beats.length).toBeGreaterThanOrEqual(2);
      expect(chunks.some((c) => c.error)).toBe(false);
      // The keepalive stops before the reason goes out: nothing follows the finish chunk.
      expect(chunks.at(-2).choices[0].delta.content).toContain("[m365-proxy: m365_throttled]");
      expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    } finally {
      vi.useRealTimers();
      scripted.gate = null;
      scripted.result = null;
    }
  });

  it("gives two sessions that open with the same message their own conversations (prompt_cache_key)", async () => {
    const pool = new SessionPool();
    const opener = { role: "user", content: "same first message" };
    const ask = (key: string, messages: unknown[]) => handleChatCompletion(ChatCompletionRequest.parse({
      model: "claude-sonnet", prompt_cache_key: key, messages,
    }), pool);
    scripted.queue = [{ fullText: "one" }, { fullText: "two" }, { fullText: "three" }];
    scripted.texts = [];
    servedBy.length = 0;
    scripted.newConversations = 0;
    await ask("session-a", [opener]);
    await ask("session-b", [opener]);
    // Session a carries on in its own conversation, as a delta: keyed on the opener
    // alone, b's request would have rotated a's conversation and a's delta gone there.
    await ask("session-a", [opener, { role: "assistant", content: "one" }, { role: "user", content: "and then?" }]);
    scripted.queue = [];
    expect(pool.size).toBe(2);
    expect(scripted.texts[1]).toContain("same first message");
    expect(scripted.texts[2]).toContain("and then?");
    expect(scripted.texts[2]).not.toContain("same first message");
    expect(servedBy[1]).not.toBe(servedBy[0]);
    expect(servedBy[2]).toBe(servedBy[0]);
    expect(scripted.newConversations).toBe(0);
  });

  it("keeps subagents sharing both prompt_cache_key and the same opener in their own conversations (§52 F153)", async () => {
    const pool = new SessionPool();
    const opener = { role: "user", content: "audit module" };
    const ask = (messages: unknown[]) => handleChatCompletion(ChatCompletionRequest.parse({
      model: "claude-sonnet", prompt_cache_key: "parent-session", messages,
    }), pool);
    scripted.queue = [{ fullText: "sub-a" }, { fullText: "sub-b" }, { fullText: "done-a" }, { fullText: "done-b" }];
    scripted.texts = [];
    servedBy.length = 0;
    await ask([opener]);
    await ask([opener]);
    await ask([opener, { role: "assistant", content: "sub-a" }, { role: "user", content: "next for a" }]);
    await ask([opener, { role: "assistant", content: "sub-b" }, { role: "user", content: "next for b" }]);
    scripted.queue = [];
    expect(pool.size).toBe(2);
    expect(servedBy[1]).not.toBe(servedBy[0]);
    expect(servedBy[2]).toBe(servedBy[0]);
    expect(servedBy[3]).toBe(servedBy[1]);
    expect(scripted.texts[2]).toContain("next for a");
    expect(scripted.texts[3]).toContain("next for b");
  });

  it("drops copilot-api's JavaScript tool tips from the system prompt", async () => {
    scripted.queue = [{ fullText: "```bash\nls\n```" }];
    scripted.texts = [];
    const system = "You are Codex.\n\n# Tool Call Tips\n- Do NOT call `exec_command` directly; that tool does not exist. Use `functions__exec` to run commands instead.";
    const res = await handleChatCompletion(ChatCompletionRequest.parse({
      model: "claude-sonnet", tools: bashTool,
      messages: [{ role: "system", content: system }, { role: "user", content: "list the files, tips test" }],
    }), new SessionPool());
    expect(res.status).toBe(200);
    expect(scripted.texts[0]).toContain("You are Codex.");
    expect(scripted.texts[0]).not.toContain("Tool Call Tips");
    expect(scripted.texts[0]).not.toContain("functions__exec");
  });
});

describe("a PowerShell command that lost a [Type]: to M365's post-processing (§40 F111)", () => {
  // Codex's shell on Windows. Live, `[regex]::Replace(` arrived as `:Replace(`, the
  // edit set its result to nothing, and Set-Content emptied the file (4 of 4).
  const psTool = [{ type: "function", function: { name: "exec_command", description: "Runs a PowerShell command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } } }];
  const damaged = "```powershell\n$c = Get-Content config.json -Raw\n$u = :Replace($c, '3000', '8080')\nSet-Content config.json $u\n```";
  const whole = "```powershell\n$c = Get-Content config.json -Raw\n$u = [System.Text.RegularExpressions.Regex]::Replace($c, '3000', '8080')\nSet-Content config.json $u\n```";
  const ask = () => handleChatCompletion(
    ChatCompletionRequest.parse({ model: "gpt-6.1-sol", stream: false, messages: [{ role: "user", content: "set the port to 8080" }], tools: psTool }),
    new SessionPool(),
  );

  it("doesn't run it: asks once for full type names and passes on the re-sent command", async () => {
    scripted.runs = 0;
    scripted.queue = [{ fullText: damaged }, { fullText: whole }];
    const res = await ask();
    expect(res.status).toBe(200);
    const call = (await res.json()).choices[0].message.tool_calls[0];
    expect(JSON.parse(call.function.arguments).cmd).toContain("[System.Text.RegularExpressions.Regex]::Replace(");
    expect(scripted.runs).toBe(2);
    expect(scripted.texts.at(-1)).toContain("didn't run your last command");
  });

  it("fails closed when the command comes back damaged again", async () => {
    scripted.runs = 0;
    scripted.queue = [{ fullText: damaged }, { fullText: damaged }];
    const res = await ask();
    expect(res.status).toBe(502);
    expect((await res.json()).error.type).toBe("damaged_tool_call");
    expect(scripted.runs).toBe(2);
  });

  it("leaves an intact static call alone", async () => {
    scripted.runs = 0;
    scripted.queue = [{ fullText: whole }];
    const res = await ask();
    expect(res.status).toBe(200);
    expect(scripted.runs).toBe(1);
  });
});
describe("a conversation M365 has lost (§46)", () => {
  type Msg = { role: string; content: string };
  const ask = (pool: InstanceType<typeof SessionPool>, messages: Msg[], stream = false) =>
    handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", stream, messages }), pool);
  const answerOf = async (res: Response) => (await res.json()).choices[0].message.content as string;
  /** The content deltas of a streamed reply, joined. */
  async function streamed(res: Response): Promise<string> {
    const parts: string[] = [];
    for (const line of (await res.text()).split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const c = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
      if (typeof c === "string") parts.push(c);
    }
    return parts.join("");
  }
  /** A follow-up M365 answers as the conversation's first message: the history is gone. */
  const LOST = { fullText: "I don't see the setup here.", throttle: { current: 1, max: 600 } };

  function reset(...queue: typeof scripted.queue) {
    scripted.result = null;
    scripted.texts = [];
    scripted.newConversations = 0;
    scripted.queue = queue;
  }
  afterEach(() => { scripted.queue = []; vi.useRealTimers(); });

  it("re-sends the whole request in a fresh conversation instead of answering without context", async () => {
    const pool = new SessionPool();
    const opener = `The example is a line field on R^2 ${Math.random()}`;
    reset({ fullText: "Noted." });
    await ask(pool, [{ role: "user", content: opener }]);
    scripted.queue = [LOST, { fullText: "For that example, the normal complex is ..." }];
    const res = await ask(pool, [
      { role: "user", content: opener },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "Write it out for this example" },
    ]);
    expect(await answerOf(res)).toBe("For that example, the normal complex is ...");
    expect(scripted.newConversations).toBe(1);
    expect(scripted.texts).toHaveLength(3);
    expect(scripted.texts[1]).not.toContain(opener); // the delta M365 had no context for
    expect(scripted.texts[2]).toContain(opener); // the whole history, again
    expect(scripted.texts[2]).toContain("Write it out for this example");
  });

  it("stops a streamed reply before any of it reaches the client", async () => {
    const pool = new SessionPool();
    const opener = `The example is a line field on R^2 ${Math.random()}`;
    reset({ fullText: "Noted." });
    await ask(pool, [{ role: "user", content: opener }]);
    scripted.queue = [LOST, { fullText: "For that example, the normal complex is ..." }];
    const res = await ask(pool, [
      { role: "user", content: opener },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "Write it out for this example" },
    ], true);
    expect(await streamed(res)).toBe("For that example, the normal complex is ...");
  });

  it("after losing a long opening, re-sends the history in parts shorter than it, then goes on with deltas (§47)", async () => {
    const pool = new SessionPool();
    const opener = `${"Background for the task. ".repeat(10_000)}${Math.random()}`; // 250k chars
    reset({ fullText: "Noted." });
    const history: Msg[] = [{ role: "user", content: opener }];
    await ask(pool, history);
    // The follow-up finds the history gone. The pool learns the size at once, so
    // the same request re-sends the whole history in a fresh conversation, in
    // turns M365 keeps.
    scripted.queue = [LOST, { fullText: "Answer 2." }];
    history.push({ role: "assistant", content: "Noted." }, { role: "user", content: "Question 2" });
    expect(await answerOf(await ask(pool, history))).toBe("Answer 2.");
    expect(pool.unkeptOpeningChars("claude-sonnet")).toBeGreaterThanOrEqual(250_000);
    expect(scripted.newConversations).toBe(1);
    const replay = scripted.texts.slice(2);
    expect(replay.length).toBeGreaterThan(1);
    for (const t of replay) expect(t.length).toBeLessThanOrEqual(pool.unkeptOpeningChars("claude-sonnet") * 0.75);
    expect(replay[0]).toContain("Background for the task.");
    expect(replay.at(-2)).toContain(opener.slice(-20));
    expect(replay.at(-1)).toContain("Question 2");
    // The conversation opened with a part M365 keeps, so the next request continues it.
    scripted.queue = [{ fullText: "Answer 3." }];
    history.push({ role: "assistant", content: "Answer 2." }, { role: "user", content: "Question 3" });
    expect(await answerOf(await ask(pool, history))).toBe("Answer 3.");
    expect(scripted.texts.at(-1)).not.toContain("Background for the task.");
    expect(scripted.newConversations).toBe(1);
  });

  it("treats a short history's loss as a one-off: the next request continues it", async () => {
    const pool = new SessionPool();
    const opener = `Short background ${Math.random()}`;
    reset({ fullText: "Noted." });
    const history: Msg[] = [{ role: "user", content: opener }];
    await ask(pool, history);
    scripted.queue = [LOST, { fullText: "Answer 2." }];
    history.push({ role: "assistant", content: "Noted." }, { role: "user", content: "Question 2" });
    await ask(pool, history);
    scripted.queue = [{ fullText: "Answer 3." }];
    history.push({ role: "assistant", content: "Answer 2." }, { role: "user", content: "Question 3" });
    await ask(pool, history);
    expect(scripted.texts).toHaveLength(4);
    expect(scripted.texts[3]).not.toContain(opener);
    expect(pool.unkeptOpeningChars("claude-sonnet")).toBe(Infinity);
  });

  it("keeps an idle conversation for 24 hours, not 30 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    const pool = new SessionPool();
    const opener = `Background ${Math.random()}`;
    reset({ fullText: "Noted." }, { fullText: "Answer 2." }, { fullText: "Answer 3." });
    const history: Msg[] = [{ role: "user", content: opener }];
    await ask(pool, history);
    vi.setSystemTime(new Date("2026-11-18T15:00:00Z")); // 3 h idle: still the same conversation
    history.push({ role: "assistant", content: "Noted." }, { role: "user", content: "Question 2" });
    await ask(pool, history);
    expect(scripted.texts[1]).not.toContain(opener);
    vi.setSystemTime(new Date("2026-11-19T16:00:00Z")); // 25 h idle: evicted, so the whole history
    history.push({ role: "assistant", content: "Answer 2." }, { role: "user", content: "Question 3" });
    await ask(pool, history);
    expect(scripted.texts[2]).toContain(opener);
  });

  it("doesn't take a whole history sent after a failed request for a lost conversation", async () => {
    const pool = new SessionPool();
    const opener = `${"Background for the task. ".repeat(10_000)}${Math.random()}`; // 250k chars
    // M365 rejects the turn outright, so it never stores it, but the session has counted it.
    reset({ fullText: "", result: { value: "InvalidRequest" } });
    expect((await ask(pool, [{ role: "user", content: opener }])).status).toBe(400);
    // The client's retry sends the whole history into that conversation, where it's message 1.
    scripted.queue = [{ fullText: "Answer.", throttle: { current: 1, max: 600 } }];
    expect(await answerOf(await ask(pool, [{ role: "user", content: opener }]))).toBe("Answer.");
    expect(scripted.texts).toHaveLength(2);
    expect(scripted.newConversations).toBe(0);
    expect(pool.unkeptOpeningChars("claude-sonnet")).toBe(Infinity);
  });

  it("learns no size limit from an opening M365 never answered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pool = new SessionPool();
    const opener = `${"Background for the task. ".repeat(10_000)}${Math.random()}`; // 250k chars
    // An empty opening; the quick retry's "Please continue." then finds no history.
    reset({ fullText: "" }, LOST, { fullText: "Answer." });
    const pending = ask(pool, [{ role: "user", content: opener }]);
    await vi.runAllTimersAsync();
    expect(await answerOf(await pending)).toBe("Answer.");
    expect(scripted.texts.map((t) => t.includes(opener))).toEqual([true, false, true]);
    expect(pool.unkeptOpeningChars("claude-sonnet")).toBe(Infinity);
  });

  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const askWithTools = (pool: InstanceType<typeof SessionPool>, messages: Msg[]) =>
    handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, tools, messages }), pool);
  const CONFAB = { fullText: "I can't access your files from here. Please paste the contents of calc.py." };
  const commandOf = async (res: Response) => JSON.parse((await res.json()).choices[0].message.tool_calls[0].function.arguments).command;

  it("re-sends a forcing turn's instruction after the whole history", async () => {
    const pool = new SessionPool();
    const opener = `fix calc.py ${Math.random()}`;
    reset(CONFAB, LOST, { fullText: "```bash\ncat calc.py\n```" });
    expect(await commandOf(await askWithTools(pool, [{ role: "user", content: opener }]))).toBe("cat calc.py");
    expect(scripted.texts).toHaveLength(3);
    expect(scripted.texts[2]).toContain(opener);
    expect(scripted.texts[2].endsWith(`\n\n${scripted.texts[1]}`)).toBe(true); // the forcing prompt
    expect(scripted.newConversations).toBe(1);
  });

  it("re-sends the history once per request, not once per forcing turn", async () => {
    const pool = new SessionPool();
    const opener = `fix calc.py ${Math.random()}`;
    reset({ fullText: "Noted." });
    await askWithTools(pool, [{ role: "user", content: opener }]);
    scripted.queue = [LOST, CONFAB, { fullText: "```bash\ncat calc.py\n```", throttle: { current: 1, max: 600 } }];
    const res = await askWithTools(pool, [
      { role: "user", content: opener },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "Go ahead" },
    ]);
    expect(await commandOf(res)).toBe("cat calc.py");
    expect(scripted.texts).toHaveLength(4); // opening, lost delta, whole re-send, forcing turn
    expect(scripted.newConversations).toBe(1);
  });

  it("keeps a size limit for the model that lost the history, for a day", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    const pool = new SessionPool();
    pool.noteUnkeptOpening("claude-sonnet", 300_000);
    pool.noteUnkeptOpening("claude-sonnet", 250_000);
    expect(pool.unkeptOpeningChars("claude-sonnet")).toBe(250_000);
    expect(pool.unkeptOpeningChars("gpt-6.1-sol")).toBe(Infinity);
    vi.setSystemTime(new Date("2026-11-19T13:00:00Z")); // 25 h later
    expect(pool.unkeptOpeningChars("claude-sonnet")).toBe(Infinity);
  });

  it("evicts to make room for a new conversation, never the one a request continues", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const pool = new SessionPool();
    const messages = (content: string) => ChatCompletionRequest.parse({ model: "claude-sonnet", messages: [{ role: "user", content }] }).messages;
    const start = Date.parse("2026-11-18T12:00:00Z");
    vi.setSystemTime(start);
    const oldest = pool.resolve(messages("conversation 0"));
    for (let i = 1; i < 1000; i++) {
      vi.setSystemTime(start + i);
      pool.resolve(messages(`conversation ${i}`));
    }
    vi.setSystemTime(start + 1000);
    expect(pool.resolve(messages("conversation 0"))).toBe(oldest); // least recently used, and kept
    expect(pool.size).toBe(1000);
    pool.resolve(messages("conversation 1000"));
    expect(pool.size).toBe(1000);
  });
});

describe("a turn too long for M365 to keep goes up in parts (§47)", () => {
  type Msg = { role: string; content: string };
  const LIMIT = 2_000;
  const ask = (pool: InstanceType<typeof SessionPool>, messages: Msg[]) =>
    handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", messages }), pool);
  const answerOf = async (res: Response) => (await res.json()).choices[0].message.content as string;
  const bytes = (s: string) => Buffer.byteLength(s, "utf8");
  /** A system prompt, six exchanges of ~700 characters, and the request: ~5k characters. */
  const history = (): Msg[] => [
    { role: "system", content: "You are a careful assistant." },
    ...Array.from({ length: 6 }, (_, i) => [
      { role: "user", content: `Question ${i}: ${"background ".repeat(60)}` },
      { role: "assistant", content: `Answer ${i}.` },
    ]).flat(),
    { role: "user", content: `The last question ${Math.random()}` },
  ];
  function reset(...queue: typeof scripted.queue) {
    scripted.result = null;
    scripted.deltas = [];
    scripted.texts = [];
    scripted.newConversations = 0;
    scripted.queue = queue;
    scripted.partQueue = [];
  }
  beforeEach(() => { process.env.M365_TURN_CHUNK_BYTES = String(LIMIT); });
  afterEach(() => {
    delete process.env.M365_TURN_CHUNK_BYTES;
    scripted.queue = [];
    scripted.partQueue = [];
  });

  it("sends the earlier messages as acknowledged parts, then the request, and returns only the answer to it", async () => {
    const msgs = history();
    reset({ fullText: "The answer." });
    expect(await answerOf(await ask(new SessionPool(), msgs))).toBe("The answer.");
    const sent = scripted.texts;
    expect(sent.length).toBeGreaterThan(2);
    for (const t of sent) expect(bytes(t)).toBeLessThanOrEqual(LIMIT);
    expect(sent[0]).toMatch(/^\[Earlier conversation, part 1 of \d+\./);
    expect(sent[0]).toContain("Question 0:");
    const final = sent.at(-1)!;
    expect(final).toContain("You are a careful assistant."); // the system prompt rides with the request
    expect(final).toContain(msgs.at(-1)!.content);
    // Every message goes up once, in order.
    const at = (s: string) => sent.findIndex((t) => t.includes(s));
    for (let i = 0; i < 6; i++) expect(sent.filter((t) => t.includes(`Question ${i}:`))).toHaveLength(1);
    for (let i = 1; i < 6; i++) expect(at(`Question ${i}:`)).toBeGreaterThanOrEqual(at(`Question ${i - 1}:`));
    expect(scripted.newConversations).toBe(0);
  });

  it("splits a follow-up too long to keep, and has the model answer the whole of it", async () => {
    const pool = new SessionPool();
    const opener = `Short opener ${Math.random()}`;
    reset({ fullText: "Noted." }, { fullText: "Read it all." });
    await ask(pool, [{ role: "user", content: opener }]);
    const long = Array.from({ length: 80 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
    const res = await ask(pool, [{ role: "user", content: opener }, { role: "assistant", content: "Noted." }, { role: "user", content: long }]);
    expect(await answerOf(res)).toBe("Read it all.");
    const sent = scripted.texts.slice(1);
    expect(sent.length).toBeGreaterThan(1);
    for (const t of sent) expect(bytes(t)).toBeLessThanOrEqual(LIMIT);
    expect(sent[0]).toMatch(/^\[This message is too long to send at once, so it comes in (\d+) parts\. This is part 1 of \1\./);
    expect(sent.at(-1)).toMatch(/^\[This is part (\d+) of \1, the end of the message\./);
    expect(sent[0]).toContain("line 0 ");
    expect(sent.at(-1)).toContain("line 79 ");
    expect(sent.some((t) => t.includes(opener))).toBe(false); // a delta, in the same conversation
    expect(scripted.newConversations).toBe(0);
  });

  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const request = (model: string, messages: Msg[], withTools = false) =>
    ChatCompletionRequest.parse({ model, messages, ...(withTools ? { tools } : {}) });
  const firstParts = () => scripted.texts.filter((t) => /^\[(?:Earlier conversation, part 1 of|This message is too long to send at once, so it comes in \d+ parts\. This is part 1 of)/.test(t));

  it("judges a part M365 doesn't acknowledge like any turn: an InternalError is re-sent once, fresh", async () => {
    reset({ fullText: "The answer." });
    scripted.partQueue = [{ fullText: "", result: { value: "InternalError" } }];
    const res = await respond(request("claude-sonnet", history()));
    expect(await answerOf(res)).toBe("The answer.");
    expect(scripted.newConversations).toBe(1);
    expect(firstParts()).toHaveLength(2);
  });

  it("learns a dead agent route from a part, and re-sends the parts agent-less", async () => {
    reset({ fullText: "```bash\nls\n```" });
    scripted.agentFlags = [];
    scripted.partQueue = [{ fullText: "", result: { value: "InternalError" } }];
    try {
      const res = await respond(request("gpt-6-sol", history(), true));
      expect((await res.json()).choices[0].message.tool_calls).toHaveLength(1);
      expect(scripted.agentFlags[0]).toBe(true);
      expect(scripted.agentFlags.slice(1)).not.toContain(true);
      expect(firstParts()).toHaveLength(2);
    } finally {
      resetAgentRoutes();
    }
  });

  it("429s a part refused for priority access, as for any turn", async () => {
    reset();
    scripted.partQueue = [{ fullText: "Out of credits.", result: { value: "OutOfCredits", message: "Out of credits." } }];
    const res = await handleChatCompletion(request("claude-opus", history()), new SessionPool());
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("priority_access_exhausted");
    expect(scripted.texts).toHaveLength(1);
  });

  it("fails a part it can't recover, and drops the conversation that holds the rest", async () => {
    reset();
    scripted.partQueue = [{ fullText: "Sorry, it looks like I can't chat about this.", contentOrigin: "Apology", apology: true }];
    const res = await ask(new SessionPool(), history());
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/didn't acknowledge part 1 of \d+ of this long conversation/);
    expect(scripted.newConversations).toBe(1);
  });

  it("re-sends the whole history when a long delta's first part finds the conversation gone", async () => {
    const pool = new SessionPool();
    const messages: Msg[] = [{ role: "user", content: `Opening ${Math.random()}` }];
    reset({ fullText: "Noted." });
    await ask(pool, messages);
    messages.push({ role: "assistant", content: "Noted." }, { role: "user", content: `Look at this:\n${"a log line\n".repeat(500)}` });
    scripted.partQueue = [{ fullText: "OK", throttle: { current: 1, max: 600 } }];
    scripted.queue = [{ fullText: "Answered with the history." }];
    expect(await answerOf(await ask(pool, messages))).toBe("Answered with the history.");
    expect(scripted.newConversations).toBe(1);
    expect(scripted.texts.slice(2).some((t) => t.includes(messages[0].content))).toBe(true);
  });

  it("drops the conversation when the request fails after its history's parts went up", async () => {
    const pool = new SessionPool();
    const messages = history();
    reset({ fullText: "", result: { value: "Throttled" } });
    expect((await ask(pool, messages)).status).toBe(429);
    // The retry would otherwise put a second copy of the history into the same conversation.
    expect(scripted.newConversations).toBe(1);
  });

  it("keeps the conversation when a long delta is held before any of it went up", async () => {
    const pool = new SessionPool();
    const messages: Msg[] = [{ role: "user", content: `Opening ${Math.random()}` }];
    reset({ fullText: "Noted." });
    await ask(pool, messages);
    messages.push({ role: "assistant", content: "Noted." }, { role: "user", content: `Look at this:\n${"a log line\n".repeat(500)}` });
    scripted.budgetHold = new TurnBudgetHold("refill", 20 * 60_000, null);
    try {
      expect((await ask(pool, messages)).status).toBe(429);
    } finally {
      scripted.budgetHold = null;
    }
    expect(scripted.newConversations).toBe(0);
  });

  it("refuses a long turn that would take more turns than M365_MAX_TURN_PARTS", async () => {
    process.env.M365_MAX_TURN_PARTS = "2";
    try {
      reset({ fullText: "A." });
      const res = await ask(new SessionPool(), history());
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("context_length_exceeded");
      expect(scripted.texts).toHaveLength(0);
    } finally {
      delete process.env.M365_MAX_TURN_PARTS;
    }
  });

  it("sends a history that fits whole, and every history whole under M365_TURN_CHUNK_BYTES=0", async () => {
    reset({ fullText: "A." });
    await ask(new SessionPool(), [{ role: "user", content: `Short ${Math.random()}` }]);
    expect(scripted.texts).toHaveLength(1);
    process.env.M365_TURN_CHUNK_BYTES = "0";
    reset({ fullText: "B." });
    await ask(new SessionPool(), history());
    expect(scripted.texts).toHaveLength(1);
    expect(scripted.texts[0]).toContain("Question 0:");
  });
});

describe("a turn M365 failed: InternalError with its canned apology (§47)", () => {
  const SORRY = "Sorry, I wasn't able to respond to that. Is there something else I can help with?";
  const FAILED = { fullText: SORRY, result: { value: "InternalError" }, turnState: "Failed" };
  const request = (stream: boolean) =>
    ChatCompletionRequest.parse({ model: "gpt-6.2-sol", stream, messages: [{ role: "user", content: `A question ${Math.random()}` }] });
  function reset(...queue: typeof scripted.queue) {
    scripted.result = null;
    scripted.texts = [];
    scripted.newConversations = 0;
    scripted.queue = queue;
  }
  afterEach(() => { scripted.queue = []; });

  it("isn't returned as the answer: the request goes again in a fresh conversation", async () => {
    reset(FAILED, { fullText: "The real answer." });
    const res = await respond(request(false));
    expect((await res.json()).choices[0].message.content).toBe("The real answer.");
    expect(scripted.newConversations).toBe(1);
    expect(scripted.texts).toHaveLength(2);
  });

  it("never streams the apology to the client", async () => {
    reset(FAILED, { fullText: "The real answer." });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const res = await handleChatCompletion(request(true), new SessionPool());
      const body = res.text();
      await vi.runAllTimersAsync();
      const text = await body;
      expect(text).not.toContain("wasn't able to respond");
      expect(text).toContain("The real answer.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still returns an ordinary answer that starts the same way", async () => {
    reset({ fullText: "Sorry, I wasn't able to find that file, so here is a sketch instead." });
    const res = await respond(request(false));
    expect((await res.json()).choices[0].message.content).toMatch(/^Sorry, I wasn't able to find that file/);
    expect(scripted.newConversations).toBe(0);
  });

  it("isn't taken for the dead agent route, which carries no text", async () => {
    const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
    reset(FAILED, { fullText: "```bash\nls\n```" });
    scripted.agentFlags = [];
    try {
      const res = await respond(ChatCompletionRequest.parse({ model: "gpt-6-sol", tools, messages: [{ role: "user", content: `list files ${Math.random()}` }] }));
      expect((await res.json()).choices[0].message.tool_calls).toHaveLength(1);
      expect(scripted.agentFlags).toEqual([true, true]);
    } finally {
      resetAgentRoutes();
    }
  });

  it("stops once the fresh re-send fails too", async () => {
    reset(FAILED, FAILED, FAILED);
    const res = await respond(request(false));
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/failed this turn twice/);
    expect(scripted.texts).toHaveLength(2);
  });
});

describe("estimated token usage (§47)", () => {
  afterEach(() => {
    delete process.env.M365_REPORT_USAGE;
    scripted.queue = [];
  });
  const request = (content: string) => ChatCompletionRequest.parse({ model: "claude-sonnet", messages: [{ role: "user", content }] });

  it("counts the whole prompt and the reply at a quarter of their UTF-8 bytes", async () => {
    scripted.queue = [{ fullText: "Four score and seven" }]; // 20 bytes
    const { usage } = await (await respond(request("x".repeat(4_000)))).json();
    expect(usage.completion_tokens).toBe(5);
    expect(usage.prompt_tokens).toBeGreaterThanOrEqual(1_000);
    expect(usage.prompt_tokens).toBeLessThan(1_100);
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
  });

  it("counts the whole history on a follow-up, not just what went up", async () => {
    const pool = new SessionPool();
    const opener = `${"y".repeat(8_000)} ${Math.random()}`;
    scripted.queue = [{ fullText: "Noted." }, { fullText: "Done." }];
    await handleChatCompletion(request(opener), pool);
    const res = await handleChatCompletion(ChatCompletionRequest.parse({
      model: "claude-sonnet",
      messages: [{ role: "user", content: opener }, { role: "assistant", content: "Noted." }, { role: "user", content: "Next" }],
    }), pool);
    expect((await res.json()).usage.prompt_tokens).toBeGreaterThanOrEqual(2_000);
  });

  it("reports zeros under M365_REPORT_USAGE=0", async () => {
    process.env.M365_REPORT_USAGE = "0";
    scripted.queue = [{ fullText: "Hi." }];
    const { usage } = await (await respond(request("Hello"))).json();
    expect(usage).toMatchObject({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});
describe("the agent runtime backends: Cowork and Code (§48)", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const ask = (model: string, extra: Record<string, unknown> = {}) =>
    handleChatCompletion(ChatCompletionRequest.parse({ model, messages: [{ role: "user", content: `list files ${Math.random()}` }], ...extra }), new SessionPool());
  beforeEach(() => {
    scripted.result = null;
    scripted.queue = [];
    runtimeRuns.length = 0;
  });
  afterEach(() => {
    delete process.env.M365_BACKENDS;
    delete process.env.M365_TURN_CHUNK_BYTES;
    scripted.queue = [];
  });

  it("refuses a backend M365_BACKENDS doesn't enable, without sending a turn", async () => {
    process.env.M365_BACKENDS = "chat";
    const runs = scripted.runs;
    const res = await ask("gpt-6.2-sol(cowork)_800k_credit");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: "model_backend_not_enabled", param: "model" });
    expect(scripted.runs).toBe(runs);
  });

  it("runs a (cowork) ID there: its model, no tool agent or Chat budget wait, the request's effort, credits in usage, the ID echoed", async () => {
    process.env.M365_BACKENDS = "chat,cowork";
    scripted.queue = [{ fullText: "```bash\nls\n```" }];
    const budgetCalls = scripted.awaitTurnBudgetCalls.length;
    const res = await ask("claude-opus-5.5(cowork)_640k_credit", { tools, reasoning_effort: "high" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe("claude-opus-5.5(cowork)_640k_credit");
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("bash");
    expect(body.usage.x_m365_credits).toBe(0.5);
    // On Chat, Opus tool requests carry the agent; the runtime has none.
    expect(runtimeRuns).toEqual([expect.objectContaining({ mode: "cowork", model: "claude-opus-5.5", useAgent: false, turn: expect.objectContaining({ reasoningEffort: "high" }) })]);
    expect(scripted.awaitTurnBudgetCalls.length).toBe(budgetCalls);
  });

  it("frames a runtime model with no default of its own in the user voice: every turn there is agent-less", async () => {
    process.env.M365_BACKENDS = "chat,cowork";
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "```bash\nls\n```" }];
    await ask("gpt-5.5", { tools });
    expect(scripted.texts.at(-1)).toContain("<system>"); // Chat's GPT-5.5 keeps the baseline, with the agent
    await ask("gpt-5.5(cowork)", { tools });
    expect(runtimeRuns).toHaveLength(1);
    expect(runtimeRuns[0].text).not.toContain("<system>");
  });

  it("ends a runtime turn with no reply text with an explanation, not Chat's \"Please continue.\" retries", async () => {
    process.env.M365_BACKENDS = "code";
    runtimeToolCalls = 3;
    try {
      scripted.queue = [{ fullText: "" }, { fullText: "late" }];
      const res = await ask("gpt-6.2-astra(code)", { tools });
      expect(res.status).toBe(502);
      const error = (await res.json()).error;
      expect(error.code).toBe("runtime_no_reply");
      expect(error.message).toMatch(/3 tool calls in its cloud workspace/);
      expect(runtimeRuns.map((r) => r.text)).not.toContain("Please continue.");
      expect(runtimeRuns).toHaveLength(1);
    } finally {
      runtimeToolCalls = 0;
    }
  });

  it("answers a model the runtime's catalog doesn't have with a 400 model_not_found", async () => {
    process.env.M365_BACKENDS = "cowork";
    scripted.queue = [{ fullText: "", result: { value: "InvalidRequest", errorCode: "ModelNotInCatalog", message: "Model 'gpt-6.2-sol:copilot' is not a known catalog entry." } }];
    const res = await ask("gpt-6.2-sol(cowork)_800k_credit");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: "model_not_found", type: "invalid_request_error" });
  });

  it("starts afresh after the runtime refuses a prompt as too long: the conversation keeps the refused message", async () => {
    process.env.M365_BACKENDS = "cowork";
    scripted.queue = [{ fullText: "", result: { value: "InvalidRequest", errorCode: "InputTokenLimitExceeded" } }];
    const fresh = scripted.newConversations;
    const res = await ask("claude-sonnet-5.5(cowork)");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("context_length_exceeded");
    expect(scripted.newConversations).toBe(fresh + 1);
  });

  it("keeps Chat on Chat, suffixes and all", async () => {
    process.env.M365_BACKENDS = "chat,cowork";
    scripted.queue = [{ fullText: "pong" }];
    const res = await ask("gpt-6.2-sol(chat)_272k");
    expect((await res.json()).model).toBe("gpt-6.2-sol(chat)_272k");
    expect(scripted.models.at(-1)).toBe("gpt-6.2-sol");
    expect(runtimeRuns).toHaveLength(0);
  });

  it("sends a long history whole: the runtime keeps a turn Chat would need in parts", async () => {
    process.env.M365_BACKENDS = "code";
    process.env.M365_TURN_CHUNK_BYTES = "2000";
    scripted.queue = [{ fullText: "Read it." }];
    const res = await handleChatCompletion(ChatCompletionRequest.parse({
      model: "gpt-6.2-sol(code)",
      messages: [{ role: "user", content: "log ".repeat(5_000) }, { role: "assistant", content: "OK" }, { role: "user", content: "Summarize it." }],
    }), new SessionPool());
    expect((await res.json()).choices[0].message.content).toBe("Read it.");
    expect(runtimeRuns).toHaveLength(1);
    expect(runtimeRuns[0].mode).toBe("code");
    expect(runtimeRuns[0].text.length).toBeGreaterThan(20_000);
  });

  it("starts the client's retry of a failed request in a fresh conversation, not on top of the failed one", async () => {
    process.env.M365_BACKENDS = "code";
    const pool = new SessionPool();
    const opener = `fix calc.py ${Math.random()}`;
    const retry = () => handleChatCompletion(ChatCompletionRequest.parse({ model: "gpt-6.2-astra(code)", tools, messages: [{ role: "user", content: opener }] }), pool);
    scripted.queue = [{ fullText: "" }, { fullText: "```bash\nls\n```" }];
    const fresh = scripted.newConversations;
    expect((await retry()).status).toBe(502); // runtime_no_reply
    expect(scripted.newConversations).toBe(fresh + 1);
    expect((await retry()).status).toBe(200);
    expect(runtimeRuns).toHaveLength(2);
    expect(runtimeRuns[1].text).toContain(opener);
    expect(scripted.newConversations).toBe(fresh + 1);
  });

  it("drops an idle runtime conversation half an hour after its last request, without waiting for another; Chat's stay", async () => {
    process.env.M365_BACKENDS = "chat,cowork";
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const pool = new SessionPool();
      const send = (model: string) => handleChatCompletion(ChatCompletionRequest.parse({ model, messages: [{ role: "user", content: `${model} ${Math.random()}` }] }), pool);
      scripted.queue = [{ fullText: "a" }, { fullText: "b" }];
      await send("claude-sonnet");
      await send("claude-sonnet-5.5(cowork)"); // the last request: no later one runs the pool's eviction
      const closed = runtimeClosed.length;
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect(runtimeClosed).toHaveLength(closed);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(runtimeClosed).toHaveLength(closed + 1);
      expect(pool.size).toBe(1); // the Chat conversation, a temporary chat, stays its 24 hours
    } finally {
      vi.useRealTimers();
    }
  });
});

// Synthetic ModelSession transport, real handler/parser/renderer: no credentials or network.
describe("capability-aware existing recovery", () => {
  const stage = { type: "function", function: { name: "stage_skill", description: "Stage a skill by name", parameters: { type: "object", properties: { skill: { type: "string" }, enabled: { type: "boolean" } } } } };
  const shell = { type: "function", function: { name: "Bash", parameters: { type: "object", properties: { command: { type: "string" } } } } };
  const reasons = {
    confab: "I can't access the files. Please paste them here.",
    remote: "I created the patch: [download](sandbox:/mnt/data/fix.patch). Apply it to update the local file.",
    halluc: "I have updated the file and saved the changes.",
  };
  const legacy = {
    confab: "The working directory and the files named in the task ARE present on a real filesystem right now. Do NOT ask me to paste anything, and do NOT say commands return no output — you have not run any command yet. Emit ONE ```bash block this turn: run `ls -la` and `cat` the relevant files. Output only the ```bash block, nothing else.",
    remote: "The patch or download link you produced exists only in M365's remote environment and is NOT a file in the caller's working directory. Do NOT create, download, or apply a patch, and do NOT use a Teams artifact link. Use the provided local edit/write tool directly; if needed, emit ONE ```bash block that modifies the named local file in place. Output only that single local tool call, nothing else.",
    halluc: "You have NOT actually done that — no tool ran this turn, so nothing changed on disk. Do not claim a file was created, replaced, or updated until a <tool_response> confirms it. Emit ONE ```bash block now that performs the change for real (write the file with a `cat > path <<'EOF' … EOF` heredoc), and nothing else.",
  };
  const corrections = {
    confab: "Continue using only the capabilities declared by the provided tools; do not assume filesystem or shell access beyond their definitions.",
    remote: "A remote artifact or download link is not evidence that the requested change was applied. Do not offer a remote patch or artifact as a completed change; use only a provided tool whose definition supports the requested action.",
    halluc: "No tool ran this turn. Do not claim the requested action completed without a confirming <tool_response>.",
  };
  async function send(stream: boolean, tools: any[], reply: string, choice: any = "auto", followup = "All set.", messages: any[] = [{ role: "user", content: "Use stage_skill for the requested task." }]) {
    scripted.result = null;
    scripted.fullText = undefined;
    scripted.deltas = [];
    scripted.texts = [];
    scripted.queue = [{ fullText: reply }, { fullText: followup }];
    const res = await handleChatCompletion(ChatCompletionRequest.parse({ model: "gpt-5.6-think-deeper", stream, tools, tool_choice: choice, messages }), new SessionPool());
    const wire = await res.text();
    const chunks = stream ? wire.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]").map(l => JSON.parse(l.slice(6))) : [JSON.parse(wire)];
    return { res, wire, chunks };
  }
  afterEach(() => { scripted.queue = []; vi.unstubAllEnvs(); });

  for (const stream of [false, true]) {
    for (const [reason, reply] of Object.entries(reasons)) {
      for (const hasShell of [false, true]) {
        it(`${stream ? "SSE" : "JSON"} ${reason} ${hasShell ? "shell" : "shellless"}: exact existing recovery and one call`, async () => {
          const tools = hasShell ? [shell, stage] : [stage];
          const { chunks } = await send(stream, tools, reply, "auto", hasShell ? "```bash\nprintf ok\n```" : "```stage_skill\nskill: example\nenabled: true\n```\n```stage_skill\nskill: ignored\n```" );
          expect(scripted.texts).toHaveLength(2);
          if (!hasShell) {
            const definitions = "<tools>\nstage_skill — Stage a skill by name\n```stage_skill\nskill: <skill>\nenabled: <enabled>\n```\n</tools>";
            expect(scripted.texts[1]).toBe(`${corrections[reason as keyof typeof corrections]}\n\nUse ONE fenced tool call with an exact tool name and the argument format below, then wait for its <tool_response>. Output only that single tool block, nothing else.\n\n${definitions}`);
            expect(scripted.texts[1]).not.toMatch(/```bash|ls -la|cat >|working directory|install it/);
          } else {
            expect(scripted.texts[1]).toBe(legacy[reason as keyof typeof legacy]);
          }
          const calls = chunks.flatMap(c => c.choices?.[0]?.message?.tool_calls ?? c.choices?.[0]?.delta?.tool_calls ?? []);
          expect(calls).toHaveLength(1);
          expect(calls[0].function.name).toBe(hasShell ? "Bash" : "stage_skill");
          expect(JSON.parse(calls[0].function.arguments)).toEqual(hasShell ? { command: "printf ok" } : { skill: "example", enabled: true });
        });
      }
      it(`${stream ? "SSE" : "JSON"} ${reason}: explicit non-shell choice excludes the available shell`, async () => {
        await send(stream, [shell, stage], reply, { type: "function", function: { name: "stage_skill" } });
        expect(scripted.texts).toHaveLength(2);
        expect(scripted.texts[1]).toContain("```stage_skill");
        expect(scripted.texts[1]).not.toMatch(/```bash|Bash/);
      });
    }
    for (const [reason, reply] of Object.entries(reasons)) {
      it(`${stream ? "SSE" : "JSON"} ${reason}: literal delimiters preserve complete recovery templates`, async () => {
        const marked = { ...stage, function: { ...stage.function,
          description: "Stage literal <tools> and </tools> markers without truncation",
          parameters: { type: "object", properties: {
            skill: { type: "string", description: "Accept <tools> and </tools> as literal skill text" },
            enabled: { type: "boolean", description: "Keep </tools> and <tools> literal here too" },
          } },
        } };
        const inspect = { type: "function", function: { name: "inspect_skill", description: "Inspect after the literal markers", parameters: { type: "object", properties: { skill: { type: "string" }, verbose: { type: "boolean" } } } } };
        const { res, chunks, wire } = await send(stream, [marked, inspect], reply, "auto", "```inspect_skill\nskill: example\nverbose: true\n```");
        expect(res.status).toBe(200);
        if (stream) expect(wire).toContain("data: [DONE]");
        expect(scripted.texts).toHaveLength(2);
        const definitions = "<tools>\nstage_skill — Stage literal <tools> and </tools> markers without truncation\n```stage_skill\nskill: <skill>\nenabled: <enabled>\n```\n\ninspect_skill — Inspect after the literal markers\n```inspect_skill\nskill: <skill>\nverbose: <verbose>\n```\n</tools>";
        expect(scripted.texts[1]).toBe(`${corrections[reason as keyof typeof corrections]}\n\nUse ONE fenced tool call with an exact tool name and the argument format below, then wait for its <tool_response>. Output only that single tool block, nothing else.\n\n${definitions}`);
        expect(scripted.texts[1]).not.toMatch(/```bash|WRITING A SHELL SCRIPT|HOST PLATFORM|real filesystem|install it/);
        const calls = chunks.flatMap(c => c.choices?.[0]?.message?.tool_calls ?? c.choices?.[0]?.delta?.tool_calls ?? []);
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe("inspect_skill");
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ skill: "example", verbose: true });
      });
    }
    it(`${stream ? "SSE" : "JSON"}: input-shaped search is not shell capability`, async () => {
      const search = { type: "function", function: { name: "search_docs", description: "Search documentation", parameters: { type: "object", properties: { input: { type: "string" } } } } };
      const { res, chunks } = await send(stream, [search], reasons.confab, "auto", "```search_docs\nmanuals\n```");
      expect(res.status).toBe(200);
      expect(scripted.texts).toHaveLength(2);
      expect(scripted.texts[1]).toContain("```search_docs");
      expect(scripted.texts[1]).not.toMatch(/```bash|real filesystem|ls -la/);
      const calls = chunks.flatMap(c => c.choices?.[0]?.message?.tool_calls ?? c.choices?.[0]?.delta?.tool_calls ?? []);
      expect(calls).toHaveLength(1);
      expect(calls[0].function.name).toBe("search_docs");
      expect(JSON.parse(calls[0].function.arguments)).toEqual({ input: "manuals" });
    });
    it(`${stream ? "SSE" : "JSON"}: Codex Code Mode retains shell recovery`, async () => {
      const codex = { type: "function", function: { name: "functions__exec", description: "Execute JavaScript", parameters: { type: "object", properties: { input: { type: "string" } } } } };
      const { chunks } = await send(stream, [codex], reasons.confab, "auto", "```bash\nprintf ok\n```");
      expect(scripted.texts[1]).toBe(legacy.confab);
      const calls = chunks.flatMap(c => c.choices?.[0]?.message?.tool_calls ?? c.choices?.[0]?.delta?.tool_calls ?? []);
      expect(calls).toHaveLength(1);
      expect(calls[0].function.name).toBe("functions__exec");
      expect(JSON.parse(calls[0].function.arguments).input).toContain("tools.exec_command");
    });
    for (const name of ["bash", "sh", "shell", "zsh", "run", "exec", "execute", "command", "cmd", "terminal", "run_command", "run_terminal_cmd", "execute_command", "execute_bash", "shell_exec", "system", "exec_command", "shell_command"]) {
      it(`${stream ? "SSE" : "JSON"}: recognized ${name} retains legacy recovery`, async () => {
        await send(stream, [{ ...shell, function: { ...shell.function, name } }], reasons.confab);
        expect(scripted.texts[1]).toBe(legacy.confab);
      });
    }
    it(`${stream ? "SSE" : "JSON"}: explicit shell choice retains legacy recovery`, async () => {
      await send(stream, [shell, stage], reasons.confab, { type: "function", function: { name: "Bash" } });
      expect(scripted.texts).toHaveLength(2);
      expect(scripted.texts[1]).toBe(legacy.confab);
    });
    it(`${stream ? "SSE" : "JSON"}: unknown explicit choice never invents a tool`, async () => {
      await send(stream, [stage], reasons.confab, { type: "function", function: { name: "missing" } });
      expect(scripted.texts).toHaveLength(2);
      expect(scripted.texts[1]).toBe("The requested tool is not provided. Explain that limitation without claiming the action completed.");
    });
    it(`${stream ? "SSE" : "JSON"}: cancellation during recovery propagates without another attempt`, async () => {
      const controller = new AbortController();
      scripted.result = null;
      scripted.texts = [];
      scripted.queue = [{ fullText: reasons.confab }, { fullText: "", onRun(signal) {
        controller.abort();
        expect(signal?.aborted).toBe(true);
        throw new Error("synthetic cancellation");
      } }];
      const res = await handleChatCompletion(ChatCompletionRequest.parse({ model: "gpt-5.6-think-deeper", stream, tools: [stage], messages: [{ role: "user", content: "Stage a skill" }] }), new SessionPool(), { signal: controller.signal });
      const wire = await res.text();
      expect(scripted.texts).toHaveLength(2);
      expect(wire).toContain("synthetic cancellation");
      expect(res.status).toBe(stream ? 200 : 502);
    });
    it(`${stream ? "SSE" : "JSON"}: none never enters recovery`, async () => {
      await send(stream, [stage], reasons.confab, "none");
      expect(scripted.texts).toHaveLength(1);
    });
    for (const choice of ["auto", "required", { type: "function", function: { name: "stage_skill" } }]) {
      it(`${stream ? "SSE" : "JSON"}: named-tool prose alone does not introduce a retry (${JSON.stringify(choice)})`, async () => {
        const prose = "The stage_skill tool stages a skill by name.";
        const { wire } = await send(stream, [stage], prose, choice);
        expect(scripted.texts).toHaveLength(1);
        expect(wire).toContain(prose);
      });
    }
    it(`${stream ? "SSE" : "JSON"}: required recovers only with declared tools`, async () => {
      await send(stream, [stage], reasons.confab, "required");
      expect(scripted.texts).toHaveLength(2);
      expect(scripted.texts[1]).toContain("```stage_skill");
      expect(scripted.texts[1]).not.toContain("```bash");
    });
    it(`${stream ? "SSE" : "JSON"}: exhausted remote artifact still fails closed at the existing budget`, async () => {
      vi.stubEnv("M365_CONFAB_RETRIES", "1");
      const { res, wire } = await send(stream, [stage], reasons.remote, "auto", reasons.remote);
      expect(scripted.texts).toHaveLength(2);
      expect(res.status).toBe(stream ? 200 : 502);
      expect(wire).toContain("file_mutation_without_local_tool");
    });
    it(`${stream ? "SSE" : "JSON"}: disabled recovery does not dispatch`, async () => {
      vi.stubEnv("M365_NO_CONFAB_RETRY", "1");
      await send(stream, [stage], reasons.confab);
      expect(scripted.texts).toHaveLength(1);
    });
    it(`${stream ? "SSE" : "JSON"}: prior non-shell call does not assert commands ran or suggest installs`, async () => {
      await send(stream, [stage], reasons.confab, "auto", "All set.", [
        { role: "user", content: "Stage the skill" },
        { role: "assistant", content: null, tool_calls: [{ id: "previous", type: "function", function: { name: "stage_skill", arguments: '{"skill":"old"}' } }] },
        { role: "tool", tool_call_id: "previous", content: "staged" },
        { role: "user", content: "Stage another skill" },
      ]);
      expect(scripted.texts).toHaveLength(2);
      expect(scripted.texts[1]).not.toMatch(/command really ran|install|```bash/);
    });
  }
});

describe("the model's chain of thought as reasoning_content", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const THOUGHT = "I'm setting up the equations: the ball and bat together cost 1.10.";
  const MORE = " Substituting gives 2 times the ball equals 0.10.";
  /** Every SSE chunk's delta, in order. */
  async function deltasOf(res: Response): Promise<Array<{ reasoning_content?: string; content?: string; tool_calls?: unknown[] }>> {
    const out = [];
    for (const line of (await res.text()).split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
      if (delta) out.push(delta);
    }
    return out;
  }
  const ask = (extra: Record<string, unknown>) => handleChatCompletion(ChatCompletionRequest.parse({
    model: "claude-sonnet", messages: [{ role: "user", content: `How much is the ball? ${Math.random()}` }], ...extra,
  }), new SessionPool());
  afterEach(() => {
    scripted.reasoning = [];
    scripted.deltas = [];
    scripted.fullText = undefined;
    scripted.queue = [];
    scripted.partQueue = [];
    delete process.env.M365_NO_REASONING;
  });

  it("streams it ahead of the answer, piece by piece, as pi and opencode read it", async () => {
    scripted.reasoning = [THOUGHT, MORE];
    scripted.deltas = ["The ball", " costs $0.05."];
    const deltas = await deltasOf(await ask({ stream: true }));
    const thinking = deltas.filter((d) => d.reasoning_content).map((d) => d.reasoning_content);
    expect(thinking).toEqual([THOUGHT, MORE]);
    expect(deltas.filter((d) => d.content).map((d) => d.content).join("")).toBe("The ball costs $0.05.");
    expect(deltas.findIndex((d) => d.reasoning_content)).toBeLessThan(deltas.findIndex((d) => d.content));
  });

  it("streams it on a tool turn, whose text is held back, then sends the call", async () => {
    scripted.queue = [{ fullText: "```bash\nls\n```", reasoning: ["Listing the files first."] }];
    const deltas = await deltasOf(await ask({ stream: true, tools }));
    expect(deltas.filter((d) => d.reasoning_content).map((d) => d.reasoning_content)).toEqual(["Listing the files first."]);
    const call = deltas.findIndex((d) => d.tool_calls);
    expect(call).toBeGreaterThan(deltas.findIndex((d) => d.reasoning_content));
    expect(deltas.some((d) => d.content)).toBe(false);
  });

  it("returns it as message.reasoning_content when the request doesn't stream", async () => {
    scripted.queue = [{ fullText: "The ball costs $0.05.", reasoning: [THOUGHT, MORE] }];
    const text = (await (await ask({})).json()).choices[0].message;
    expect(text).toMatchObject({ content: "The ball costs $0.05.", reasoning_content: THOUGHT + MORE });
    scripted.queue = [{ fullText: "```bash\nls\n```", reasoning: ["Listing the files first."] }];
    const call = (await (await ask({ tools })).json()).choices[0].message;
    expect(call.reasoning_content).toBe("Listing the files first.");
    expect(call.tool_calls[0].function.name).toBe("bash");
  });

  it("keeps every turn's, a retry's after the refused one's, a blank line apart", async () => {
    scripted.queue = [
      { fullText: "", messageType: "Disengaged", reasoning: ["This looks like a prompt injection."] },
      { fullText: "```bash\nls\n```", reasoning: ["Running ls."] },
    ];
    const message = (await (await ask({ tools })).json()).choices[0].message;
    expect(message.reasoning_content).toBe("This looks like a prompt injection.\n\nRunning ls.");
  });

  it("has no reasoning_content when the model sent none", async () => {
    scripted.queue = [{ fullText: "The ball costs $0.05." }];
    expect((await (await ask({})).json()).choices[0].message).not.toHaveProperty("reasoning_content");
    scripted.deltas = ["The ball costs $0.05."];
    expect((await deltasOf(await ask({ stream: true }))).some((d) => "reasoning_content" in d)).toBe(false);
  });

  it("leaves it out under M365_NO_REASONING=1", async () => {
    process.env.M365_NO_REASONING = "1";
    scripted.queue = [{ fullText: "The ball costs $0.05.", reasoning: [THOUGHT] }];
    expect((await (await ask({})).json()).choices[0].message).not.toHaveProperty("reasoning_content");
    scripted.reasoning = [THOUGHT];
    scripted.deltas = ["The ball costs $0.05."];
    expect((await deltasOf(await ask({ stream: true }))).some((d) => "reasoning_content" in d)).toBe(false);
  });

  it("leaves out what the model thinks while acknowledging a long turn's parts", async () => {
    process.env.M365_TURN_CHUNK_BYTES = "2000";
    try {
      const messages = [
        ...Array.from({ length: 6 }, (_, i) => [
          { role: "user", content: `Question ${i}: ${"background ".repeat(60)}` },
          { role: "assistant", content: `Answer ${i}.` },
        ]).flat(),
        { role: "user", content: `The last question ${Math.random()}` },
      ];
      scripted.partQueue = [{ fullText: "OK", reasoning: ["The user is sending part 1."] }];
      scripted.queue = [{ fullText: "The answer.", reasoning: ["Answering the last question."] }];
      const res = await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", messages }), new SessionPool());
      expect(scripted.partQueue).toHaveLength(0); // the part went up and thought
      expect((await res.json()).choices[0].message.reasoning_content).toBe("Answering the last question.");
    } finally {
      delete process.env.M365_TURN_CHUNK_BYTES;
    }
  });
});
