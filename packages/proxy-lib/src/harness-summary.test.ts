import { describe, expect, it } from "vitest";
import {
  HARNESS_SUMMARY_TEXT,
  harnessSummaryResponse,
  isHarnessSummaryRequest,
} from "./harness-summary.js";

const SUMMARIZER_SYSTEM =
  "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

const HISTORY_PROMPT =
  "<conversation>\n[User]: fix the bug\n[Assistant]: done\n</conversation>\n\nThe messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.";

const UPDATE_PROMPT =
  "<previous-summary>\n## Goal\nfix bug\n</previous-summary>\n\n<conversation>\n[User]: and tests\n</conversation>\n\nThe messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.";

const TURN_PREFIX_PROMPT =
  "# Conversation\n[User]: run the tests\n\n# Instructions\nThe messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.\n\nCreate a concise checkpoint of the user's request and the progress shown above.";

const TOOL = {
  type: "function",
  function: { name: "bash", parameters: { type: "object", properties: {} } },
};

type Frame = {
  id: string;
  object: string;
  model: string;
  choices: Array<{ index: number; delta: Record<string, unknown>; finish_reason: string | null }>;
  usage?: Record<string, unknown>;
};

async function readEvents(response: Response): Promise<string[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((event) => event.length > 0)
    .map((event) => event.replace(/^data: /, ""));
}

describe("isHarnessSummaryRequest", () => {
  it("detects the pi history summary request", () => {
    expect(
      isHarnessSummaryRequest({
        messages: [
          { role: "system", content: SUMMARIZER_SYSTEM },
          { role: "user", content: HISTORY_PROMPT },
        ],
      }),
    ).toBe(true);
  });

  it("detects the update variant", () => {
    expect(
      isHarnessSummaryRequest({
        messages: [
          { role: "system", content: SUMMARIZER_SYSTEM },
          { role: "user", content: UPDATE_PROMPT },
        ],
      }),
    ).toBe(true);
  });

  it("detects the turn-prefix variant with a system message", () => {
    expect(
      isHarnessSummaryRequest({
        messages: [
          { role: "system", content: SUMMARIZER_SYSTEM },
          { role: "user", content: TURN_PREFIX_PROMPT },
        ],
      }),
    ).toBe(true);
  });

  it("detects the turn-prefix variant by its marker alone", () => {
    expect(
      isHarnessSummaryRequest({ messages: [{ role: "user", content: TURN_PREFIX_PROMPT }] }),
    ).toBe(true);
  });

  it("detects array-of-parts content", () => {
    expect(
      isHarnessSummaryRequest({
        messages: [
          { role: "system", content: [{ type: "text", text: SUMMARIZER_SYSTEM }] },
          { role: "user", content: [{ type: "text", text: HISTORY_PROMPT }] },
        ],
      }),
    ).toBe(true);
  });

  it("accepts an empty tools array as no tools", () => {
    expect(
      isHarnessSummaryRequest({
        messages: [{ role: "user", content: HISTORY_PROMPT }],
        tools: [],
      }),
    ).toBe(true);
  });

  it("ignores a normal coding request with tools", () => {
    expect(
      isHarnessSummaryRequest({
        messages: [
          { role: "system", content: "You are a coding agent." },
          { role: "user", content: "list the files" },
        ],
        tools: [TOOL],
      }),
    ).toBe(false);
  });

  it("ignores a request that merely mentions summary", () => {
    expect(
      isHarnessSummaryRequest({
        messages: [{ role: "user", content: "Write a summary of this changelog." }],
      }),
    ).toBe(false);
  });

  it("ignores a summarization-shaped request that has tools", () => {
    expect(
      isHarnessSummaryRequest({
        messages: [
          { role: "system", content: SUMMARIZER_SYSTEM },
          { role: "user", content: HISTORY_PROMPT },
        ],
        tools: [TOOL],
      }),
    ).toBe(false);
  });

  it("ignores a marker that is only in an earlier user message", () => {
    expect(
      isHarnessSummaryRequest({
        messages: [
          { role: "user", content: HISTORY_PROMPT },
          { role: "assistant", content: "ok" },
          { role: "user", content: "now refactor the parser" },
        ],
      }),
    ).toBe(false);
  });

  it("ignores a pasted file that contains the marker phrases", () => {
    const pasted = `Summarize this file.\n\n\`\`\`ts\nconst MARKERS = [\n  "Create a structured context checkpoint summary",\n  "Create a concise checkpoint of the user's request",\n];\n\`\`\``;
    expect(isHarnessSummaryRequest({ messages: [{ role: "user", content: pasted }] })).toBe(false);
  });

  it("returns false for empty messages", () => {
    expect(isHarnessSummaryRequest({ messages: [] })).toBe(false);
  });
});

describe("HARNESS_SUMMARY_TEXT", () => {
  it("is short and uses pi's section format", () => {
    expect(HARNESS_SUMMARY_TEXT.length).toBeLessThan(600);
    for (const heading of ["## Goal", "## Progress", "### Done", "## Next Steps"]) {
      expect(HARNESS_SUMMARY_TEXT).toContain(heading);
    }
  });
});

describe("harnessSummaryResponse", () => {
  it("returns a JSON chat.completion when stream is falsy", async () => {
    const response = harnessSummaryResponse({ model: "claude-sonnet" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("x-proxy-model")).toBe("claude-sonnet");
    expect(response.headers.get("x-proxy-stream")).toBe("0");
    expect(response.headers.get("x-proxy-local-summary")).toBe("1");
    expect(response.headers.get("x-proxy-finish-reason")).toBe("stop");

    const body = (await response.json()) as {
      id: string;
      object: string;
      model: string;
      system_fingerprint: null;
      choices: Array<{
        index: number;
        message: { role: string; content: string };
        logprobs: null;
        finish_reason: string;
      }>;
      usage: Record<string, unknown>;
    };
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("claude-sonnet");
    expect(body.system_fingerprint).toBeNull();
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]).toEqual({
      index: 0,
      message: { role: "assistant", content: HARNESS_SUMMARY_TEXT },
      logprobs: null,
      finish_reason: "stop",
    });
    expect(body.usage).toMatchObject({
      prompt_tokens: 0,
      total_tokens: body.usage.completion_tokens,
      x_proxy_tokens_estimated: true,
      x_proxy_local_summary: true,
    });
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
  });

  it("defaults the model to m365-copilot", async () => {
    const response = harnessSummaryResponse({});
    const body = (await response.json()) as { model: string };

    expect(body.model).toBe("m365-copilot");
    expect(response.headers.get("x-proxy-model")).toBe("m365-copilot");
  });

  it("returns an SSE stream with role, content, finish and [DONE] and no usage by default", async () => {
    const response = harnessSummaryResponse({ model: "gpt-5.5", stream: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("x-proxy-model")).toBe("gpt-5.5");
    expect(response.headers.get("x-proxy-stream")).toBe("1");
    expect(response.headers.get("x-proxy-local-summary")).toBe("1");
    expect(response.headers.get("x-proxy-finish-reason")).toBe("stop");

    const events = await readEvents(response);
    expect(events.at(-1)).toBe("[DONE]");

    const frames = events.slice(0, -1).map((event) => JSON.parse(event) as Frame);
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.object).toBe("chat.completion.chunk");
      expect(frame.model).toBe("gpt-5.5");
      expect(frame.id).toBe(frames[0].id);
    }

    expect(frames[0].choices[0]).toEqual({
      index: 0,
      delta: { role: "assistant" },
      finish_reason: null,
    });
    expect(frames[1].choices[0].delta).toEqual({ content: HARNESS_SUMMARY_TEXT });
    expect(frames[1].choices[0].finish_reason).toBeNull();
    expect(frames[2].choices[0]).toEqual({ index: 0, delta: {}, finish_reason: "stop" });
    expect(frames[2]).not.toHaveProperty("usage");
  });

  it("includes usage on the finish chunk only when include_usage is set", async () => {
    const response = harnessSummaryResponse({
      stream: true,
      stream_options: { include_usage: true },
    });

    const events = await readEvents(response);
    const finish = JSON.parse(events[events.length - 2]) as Frame;

    expect(finish.choices[0].finish_reason).toBe("stop");
    expect(finish.usage).toMatchObject({
      prompt_tokens: 0,
      x_proxy_tokens_estimated: true,
      x_proxy_local_summary: true,
    });
  });
});
