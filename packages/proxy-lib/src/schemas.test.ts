import { describe, it, expect } from "vitest";
import { ChatMessage, ChatCompletionRequest } from "./schemas";

describe("ChatMessage role normalization", () => {
  it("normalizes the OpenAI `developer` role to `system`", () => {
    const msg = ChatMessage.parse({ role: "developer", content: "you are a bot" });
    expect(msg.role).toBe("system");
  });

  it("passes the four canonical roles through unchanged", () => {
    for (const role of ["system", "user", "assistant", "tool"] as const) {
      expect(ChatMessage.parse({ role, content: "hi" }).role).toBe(role);
    }
  });

  it("rejects an unknown role", () => {
    expect(() => ChatMessage.parse({ role: "wizard", content: "hi" })).toThrow();
  });

  it("accepts a request whose first message uses `developer` (the Hermes case)", () => {
    const req = ChatCompletionRequest.parse({
      model: "gpt-5.5-think-deeper",
      messages: [
        { role: "developer", content: "system prompt" },
        { role: "user", content: "hi" },
      ],
    });
    expect(req.messages[0].role).toBe("system");
  });
});

describe("OpenAI request parameters", () => {
  const messages = [{ role: "user", content: "hi" }];

  it("accepts the standard sampling/format parameters", () => {
    const req = ChatCompletionRequest.parse({
      messages,
      top_p: 0.9,
      frequency_penalty: 0,
      presence_penalty: 0,
      stop: ["\n"],
      seed: 1,
      user: "u",
      n: 1,
      response_format: { type: "json_object" },
      parallel_tool_calls: false,
      max_completion_tokens: 100,
      logprobs: false,
      metadata: { a: "b" },
      store: false,
      reasoning_effort: "low",
      stream_options: null,
    });
    expect(req.top_p).toBe(0.9);
    expect(req.legacy_functions).toBe(false);
  });

  it("rejects n > 1", () => {
    expect(() => ChatCompletionRequest.parse({ messages, n: 2 })).toThrow(/Only n=1/);
  });
});

describe("legacy functions / function_call", () => {
  const fn = {
    name: "bash",
    parameters: { type: "object", properties: { command: { type: "string" } } },
  };

  it("maps functions and function_call onto tools and tool_choice", () => {
    const req = ChatCompletionRequest.parse({
      messages: [{ role: "user", content: "hi" }],
      functions: [fn],
      function_call: { name: "bash" },
    });
    expect(req.legacy_functions).toBe(true);
    expect(req.tools).toEqual([{ type: "function", function: fn }]);
    expect(req.tool_choice).toEqual({ type: "function", function: { name: "bash" } });
  });

  it("turns legacy history into tool_calls / role:tool with stable IDs", () => {
    const raw = {
      functions: [fn],
      messages: [
        { role: "user", content: "list" },
        {
          role: "assistant",
          content: null,
          function_call: { name: "bash", arguments: '{"command":"ls"}' },
        },
        { role: "function", name: "bash", content: "a.txt" },
      ],
    };
    const req = ChatCompletionRequest.parse(raw);
    expect(req.messages[1].tool_calls).toEqual([
      {
        id: "call_legacy_1",
        type: "function",
        function: { name: "bash", arguments: '{"command":"ls"}' },
      },
    ]);
    expect(req.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_legacy_1",
      name: "bash",
    });
    expect(ChatCompletionRequest.parse(raw)).toEqual(req);
  });
});
