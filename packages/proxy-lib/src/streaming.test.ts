import { describe, it, expect, vi, afterEach } from "vitest";

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
  queue: Array<{ fullText: string; messageType?: string | null; result?: { value: string; errorCode?: string; message?: string }; metering?: Record<string, number> }>;
  /** The model argument of every run() call, in order. */
  models: string[];
  /** The `useAgent` argument of every run() call, in order. */
  agentFlags: Array<boolean | undefined>;
  /** How many times the handler rotated to a fresh conversation. */
  newConversations: number;
} = { deltas: [], runs: 0, texts: [], queue: [], agentFlags: [], newConversations: 0, models: [] };

vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  class FakeModelSession {
    turnCount = 0;
    conversationId = "conv-test";
    reset() {}
    newConversation() { this.conversationId = "conv-test-2"; this.turnCount = 0; scripted.newConversations++; }
    async refreshAgent() { return false; }
    async run(text: string, model?: string, _signal?: AbortSignal, useAgent?: boolean) {
      scripted.models.push(model ?? "");
      this.turnCount++; // like the real session: later requests go down the delta path
      scripted.runs++;
      scripted.texts.push(text);
      scripted.agentFlags.push(useAgent);
      const next = scripted.queue.shift();
      const deltas = next ? (next.fullText ? [next.fullText] : []) : scripted.deltas;
      const full = next ? next.fullText : (scripted.fullText ?? deltas.join(""));
      const stream = {
        fullText: full,
        hasContent: full.length > 0,
        result: next?.result ?? scripted.result ?? { value: "Success" },
        metering: next?.metering ?? null,
        images: [],
        throttle: { current: 1, max: 600 },
        contentOrigin: "Claude",
        messageType: (next?.messageType ?? null) as string | null,
        messageId: "m1",
        scores: null,
        turnCount: 1,
        turnState: "Completed",
        async *[Symbol.asyncIterator]() {
          for (const d of deltas) {
            await Promise.resolve(); // yield to the event loop between deltas
            yield d;
          }
        },
      };
      return stream;
    }
  }
  return { ...actual, ModelSession: FakeModelSession };
});

const { handleChatCompletion, SessionPool, ChatCompletionRequest } = await import("./index.js");
const { resetAgentRoutes, resetPriorityAccessState } = await import("@m365-copilot/core");

// The proxy remembers a priority-access wall for the process (until the reset);
// don't let one test's refusal 429 the next test's Opus request.
afterEach(() => resetPriorityAccessState());

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

describe("Disengage retry keeps a model's <system>-free framing", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
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
    for (const model of ["claude-opus-4.5", "claude-opus", "claude-sonnet", "gpt-6-think-deeper"]) {
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

  it("sends both Opus models' tool requests with it (§24)", async () => {
    expect(await agentFlagFor("claude-opus")).toBe(true);
    expect(await agentFlagFor("claude-opus-5[1m]")).toBe(true);
    expect(await agentFlagFor("claude-opus-4.5")).toBe(true);
  });

  it("never attaches it to a request without tools", async () => {
    expect(await agentFlagFor("gpt-5.5-think-deeper", false)).toBe(false);
    expect(await agentFlagFor("claude-opus", false)).toBe(false);
  });

  it("…except for Opus 4.5, which isn't served without it", async () => {
    expect(await agentFlagFor("claude-opus-4.5", false)).toBe(true);
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
    // No fresh conversation, no agent-less switch: the ordinary empty-reply retry.
    expect(scripted.newConversations).toBe(0);
    expect(scripted.agentFlags).toEqual([true, true]);
    expect(scripted.texts[1]).toBe("Please continue.");
    scripted.queue = [CALL];
    await send();
    expect(scripted.agentFlags).toEqual([true]);
  });

  it("doesn't touch tones outside PREMIUM_ONLY_AGENT_TONES", async () => {
    scripted.queue = [DEAD, CALL];
    const res = await send("gpt-5.5-think-deeper");
    expect(res.status).toBe(200);
    expect(scripted.newConversations).toBe(0);
    expect(scripted.agentFlags[1]).toBe(true);
  });

  it("doesn't fall back under M365_FORCE_AGENT=1", async () => {
    process.env.M365_FORCE_AGENT = "1";
    scripted.queue = [DEAD, CALL];
    await send();
    expect(scripted.newConversations).toBe(0);
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
    scripted.newConversations = 0;
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "Done." }, { fullText: "```bash\nls\n```" }];
    const pool = new SessionPool();
    const prompt = `make a pdf ${Math.random()}`;
    const first: any[] = [{ role: "user", content: prompt }];
    const m1 = await ask(first, pool);
    first.push({ role: "assistant", content: null, tool_calls: m1.tool_calls });
    first.push({ role: "tool", tool_call_id: m1.tool_calls[0].id, content: "notlar.md" });
    await ask(first, pool);
    await ask([{ role: "user", content: prompt }], pool); // a new session, same opener
    expect(scripted.newConversations).toBe(1);
    expect(scripted.texts[2]).toContain(prompt); // the full prompt, not a delta
    scripted.queue = [];
  });

  it("gets one after a single-turn session too (equal length used to send 'Please continue.')", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.newConversations = 0;
    scripted.queue = [{ fullText: "I can't do that." }, { fullText: "```bash\nls\n```" }];
    const pool = new SessionPool();
    const prompt = `make a docx ${Math.random()}`;
    await ask([{ role: "user", content: prompt }], pool);
    await ask([{ role: "user", content: prompt }], pool);
    expect(scripted.newConversations).toBe(1);
    expect(scripted.texts[scripted.texts.length - 1]).not.toBe("Please continue.");
    expect(scripted.texts[scripted.texts.length - 1]).toContain(prompt);
    scripted.queue = [];
  });

  it("still continues a real continuation in the same conversation", async () => {
    scripted.result = null;
    scripted.texts = [];
    scripted.newConversations = 0;
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "Done." }];
    const pool = new SessionPool();
    const msgs: any[] = [{ role: "user", content: `go ${Math.random()}` }];
    const m1 = await ask(msgs, pool);
    msgs.push({ role: "assistant", content: null, tool_calls: m1.tool_calls });
    msgs.push({ role: "tool", tool_call_id: m1.tool_calls[0].id, content: "a.txt" });
    await ask(msgs, pool);
    expect(scripted.newConversations).toBe(0);
    expect(scripted.texts[1]).toContain('<tool_response tool="bash"'); // a delta
    scripted.queue = [];
  });
});

describe("Opus 4.5 on an account that can't serve it (§24)", () => {
  const DEAD = { fullText: "", result: { value: "InternalError" } };

  afterEach(() => {
    resetAgentRoutes();
    scripted.queue = [];
  });

  it("says the model is premium-only instead of 'empty response', and never goes agent-less", async () => {
    scripted.result = null;
    scripted.agentFlags = [];
    scripted.newConversations = 0;
    scripted.queue = [DEAD, DEAD, DEAD];
    const body = ChatCompletionRequest.parse({
      model: "claude-opus-4.5", stream: false,
      messages: [{ role: "user", content: `hello ${Math.random()}` }],
    });
    const res = await respond(body);
    expect(res.status).toBe(502);
    const err = (await res.json()).error;
    expect(err.code).toBe("model_route_unavailable");
    expect(err.message).toContain("premium");
    // Agent-less is a dead route too, so there is nothing to fall back to.
    expect(scripted.agentFlags).toEqual([true, true, true]);
    expect(scripted.newConversations).toBe(0);
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
    // Opus 4.5 isn't metered, so it is unaffected.
    scripted.queue = [CALL];
    expect((await send("claude-opus-4.5", "third task")).status).toBe(200);
    expect(scripted.models).toEqual(["claude-opus-4.5"]);
  });

  it("with M365_OPUS_FALLBACK_MODEL, re-sends the whole request to it in a fresh conversation", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.5";
    scripted.queue = [REFUSAL, { fullText: "```bash\nls\n```" }];
    const res = await send();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.tool_calls).toHaveLength(1);
    expect(json.model).toBe("claude-opus-4.5"); // says who answered
    expect(scripted.models).toEqual(["claude-opus", "claude-opus-4.5"]);
    expect(scripted.newConversations).toBe(1);
    expect(scripted.agentFlags).toEqual([true, true]);
    expect(scripted.texts[1]).toContain("list files"); // the whole request, not a delta
  });

  it("…and routes the next requests straight to the fallback until the reset", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.5";
    scripted.queue = [REFUSAL, { fullText: "```bash\nls\n```" }];
    await send();
    scripted.queue = [{ fullText: "```bash\npwd\n```" }];
    const res = await send("claude-opus", "another task");
    expect(res.status).toBe(200);
    expect(scripted.models).toEqual(["claude-opus-4.5"]);
  });

  it("starts a fresh conversation when an ongoing Opus 5.5 conversation moves to the fallback", async () => {
    scripted.queue = [CALL];
    await send("claude-opus", "long task");          // turn 1 served by Opus 5.5
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.5";
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
    expect(scripted.models).toEqual(["claude-opus", "claude-opus-4.5"]);
    expect(scripted.texts[1]).toContain("long task");   // full history for the new model
    expect(scripted.texts[1]).toContain("a.txt");
  });

  it("never falls back for an unmetered model's refusal text", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.5";
    scripted.queue = [{ fullText: WEEKLY }];
    const res = await send("gpt-5.5-think-deeper");
    expect(res.status).toBe(429);
    expect(scripted.models).toEqual(["gpt-5.5-think-deeper"]);
  });

  it("falls back on the streaming path too, without leaking the refusal", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.5";
    scripted.queue = [REFUSAL, { fullText: "Hello from 4.5" }];
    scripted.result = null; scripted.models = [];
    const body = ChatCompletionRequest.parse({ model: "claude-opus", stream: true, messages: [{ role: "user", content: `hi ${Math.random()}` }] });
    const res = await handleChatCompletion(body, pool);
    const text = await res.text();
    expect(text).toContain("Hello from 4.5");
    expect(text).not.toContain("priority access");
    expect(scripted.models).toEqual(["claude-opus", "claude-opus-4.5"]);
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
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.5"; // the other budget's, unused here
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
