import { describe, it, expect } from "vitest";
import { getAvailableModels } from "@m365-copilot/core";
import { buildModelsPayload, createApp } from "./index.js";

describe("proxy model catalog (offline)", () => {
  it("exposes only the selected included models through the shared payload and endpoint", async () => {
    const app = createApp();
    const response = await app.fetch(new Request("http://localhost/v1/models"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.object).toBe("list");
    const models = body.data.map((model: { id: string }) => model.id);
    expect(models).toEqual(getAvailableModels());
    expect(models).toHaveLength(20);
    expect(models.filter((model: string) => model.startsWith("claude"))).toEqual([
      "claude-sonnet-think-deeper",
    ]);
    expect(models).not.toContain("gpt-6-think-deeper");
    expect(buildModelsPayload().data.map((model) => model.id)).toEqual(models);
  });
});

describe("OpenAI-compatible routing and errors (offline)", () => {
  const app = createApp({}, null);
  const call = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://localhost${path}`, init));

  it("retrieves a single model and 404s an unknown one", async () => {
    const id = getAvailableModels()[0];
    const found = await call(`/v1/models/${encodeURIComponent(id)}`);
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ id, object: "model", owned_by: "microsoft" });

    const missing = await call("/v1/models/no-such-model");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toEqual({
      message: "The model 'no-such-model' does not exist",
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    });
  });

  it("returns 405 with Allow for a known path and 404 for an unknown one", async () => {
    const wrongMethod = await call("/v1/chat/completions");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("POST");

    const unknown = await call("/v1/foo", { method: "POST" });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toMatchObject({ code: "unknown_url", param: null });
  });

  it("rejects malformed JSON and invalid fields with an OpenAI 400", async () => {
    const post = (body: string) =>
      call("/v1/chat/completions", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      });

    const malformed = await post("{not json");
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.type).toBe("invalid_request_error");

    const n2 = await post(JSON.stringify({ n: 2, messages: [{ role: "user", content: "hi" }] }));
    expect(n2.status).toBe(400);
    expect((await n2.json()).error).toMatchObject({
      type: "invalid_request_error",
      param: "n",
      code: null,
    });

    const badRole = await post(JSON.stringify({ messages: [{ role: "wizard", content: "hi" }] }));
    expect((await badRole.json()).error.param).toBe("messages.0.role");
  });

  it("enforces the API key on /v1/* only when one is configured", async () => {
    const locked = createApp({}, "sk-test");
    const get = (path: string, auth?: string) =>
      locked.fetch(
        new Request(
          `http://localhost${path}`,
          auth ? { headers: { Authorization: auth } } : undefined,
        ),
      );

    const missing = await get("/v1/models");
    expect(missing.status).toBe(401);
    expect((await missing.json()).error.code).toBe("invalid_api_key");
    expect((await get("/v1/models", "Bearer wrong")).status).toBe(401);
    expect((await get("/v1/models", "Bearer sk-test")).status).toBe(200);
    expect((await get("/health")).status).toBe(200);
    expect(
      (await locked.fetch(new Request("http://localhost/v1/models", { method: "OPTIONS" }))).status,
    ).toBe(204);
  });
});

// This whole suite hits real M365 (auth, WS, agent creation, ~600-msg quota),
// so it has to be opt-in. Without the guard, `pnpm test` waits 2 min for an
// interactive login that no automated runner can provide. Matches the
// convention in tools.test.ts (none of those tests need M365_LIVE because
// they're pure).
const LIVE = process.env.M365_LIVE === "1";

const tools = [
  {
    type: "function" as const,
    function: {
      name: "bash",
      description: "Run a shell command and return its output",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read the contents of a file at the given path",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
        },
        required: ["path"],
      },
    },
  },
];

function chatRequest(
  messages: Array<{
    role: string;
    content?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
    name?: string;
  }>,
) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "m365-copilot",
      messages,
      tools,
    }),
  });
}

describe.skipIf(!LIVE)("proxy-lib e2e with tools (live)", () => {
  const app = createApp();

  it("should handle a chat completion with tools defined", async () => {
    const res = await app.fetch(
      chatRequest([
        {
          role: "user",
          content:
            "what npm deps do i have in this folder? use your bash and read_file tools to find out. start by running cat package.json",
        },
      ]),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    console.log("Turn 1:", JSON.stringify(body, null, 2));

    const choice = body.choices[0];
    expect(choice.message.role).toBe("assistant");

    // M365 Copilot may or may not follow our tool-calling protocol.
    // If it does produce a tool call, do a follow-up turn.
    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length > 0) {
      const toolCall = choice.message.tool_calls[0];
      console.log(`Tool call: ${toolCall.function.name}(${toolCall.function.arguments})`);

      // Simulate tool execution
      let toolResult: string;
      if (toolCall.function.name === "bash") {
        const args = JSON.parse(toolCall.function.arguments);
        const { execSync } = await import("node:child_process");
        try {
          toolResult = execSync(args.command, { cwd: process.cwd(), encoding: "utf-8" }).trim();
        } catch (e: any) {
          toolResult = e.stderr || e.message;
        }
      } else if (toolCall.function.name === "read_file") {
        const args = JSON.parse(toolCall.function.arguments);
        const { readFileSync } = await import("node:fs");
        try {
          toolResult = readFileSync(args.path, "utf-8");
        } catch (e: any) {
          toolResult = e.message;
        }
      } else {
        toolResult = `Unknown tool: ${toolCall.function.name}`;
      }
      console.log("Tool result:", toolResult.slice(0, 500));

      // Turn 2: send tool result back
      const res2 = await app.fetch(
        chatRequest([
          {
            role: "user",
            content:
              "what npm deps do i have in this folder? use your bash and read_file tools to find out. start by running cat package.json",
          },
          {
            role: "assistant",
            content: choice.message.content,
            tool_calls: choice.message.tool_calls,
          },
          {
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: toolResult,
          },
        ]),
      );

      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      console.log("Turn 2:", JSON.stringify(body2, null, 2));

      const choice2 = body2.choices[0];
      expect(choice2.message.content).toBeTruthy();
    } else {
      // Model responded with plain text — still a valid response
      console.log(
        "Model responded without tool calls (M365 Copilot overrode tool-calling protocol)",
      );
      expect(choice.message.content).toBeTruthy();
    }
  }, 120_000);

  it("should return models list", async () => {
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].id).toBeTruthy();
  });

  it("should return health check", async () => {
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
