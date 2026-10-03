import { describe, it, expect } from "vitest";
import { getAvailableModels } from "@m365-copilot/core";
import { buildModelsPayload, createApp } from "./index.js";
import { z } from "zod";

type JsonObject = Record<string, unknown>;

const modelListSchema = z.array(z.object({ id: z.string() }));
const bashArgumentsSchema = z.object({ command: z.string() });
const fileArgumentsSchema = z.object({ path: z.string() });
const chatCompletionSchema = z.object({
  choices: z.array(
    z.object({
      finish_reason: z.unknown().optional(),
      message: z.object({
        role: z.string(),
        content: z.string().nullable().optional(),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              function: z.object({
                name: z.string(),
                arguments: z.string(),
              }),
            }),
          )
          .optional(),
      }),
    }),
  ),
});

type ChatCompletion = z.infer<typeof chatCompletionSchema>;
type ChatChoice = ChatCompletion["choices"][number];

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireJsonObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError("Expected a JSON object");
  }

  return value;
}

async function readJson(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  return value;
}

async function readJsonObject(response: Response): Promise<JsonObject> {
  return requireJsonObject(await readJson(response));
}

function jsonObjectField(value: JsonObject, key: string): JsonObject {
  return requireJsonObject(value[key]);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Expected ${field} to be a string`);
  }

  return value;
}

function modelIds(value: unknown): string[] {
  return modelListSchema.parse(value).map((model) => model.id);
}

function parseChatCompletion(value: unknown): ChatCompletion {
  return chatCompletionSchema.parse(value);
}

function firstChoice(completion: ChatCompletion): ChatChoice {
  const choice = completion.choices[0];
  if (!choice) {
    throw new TypeError("Expected at least one chat completion choice");
  }

  return choice;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandErrorMessage(error: unknown): string {
  if (error instanceof Error && "stderr" in error) {
    const stderr = error.stderr;
    if (typeof stderr === "string" && stderr) {
      return stderr;
    }
    if (stderr instanceof Uint8Array && stderr.byteLength > 0) {
      return new TextDecoder().decode(stderr);
    }
  }

  return errorMessage(error);
}

function currentWorkingDirectory(): string {
  const currentProcess = requireJsonObject(Reflect.get(globalThis, "process"));
  const getWorkingDirectory = currentProcess.cwd;
  if (typeof getWorkingDirectory !== "function") {
    throw new TypeError("Expected process.cwd to be a function");
  }

  const directory: unknown = Reflect.apply(getWorkingDirectory, currentProcess, []);
  return requiredString(directory, "current working directory");
}

function liveTestsEnabled(): boolean {
  const currentProcess = requireJsonObject(Reflect.get(globalThis, "process"));
  const environment = requireJsonObject(currentProcess.env);
  return environment.M365_LIVE === "1";
}

describe("proxy model catalog (offline)", () => {
  it("exposes only the selected included models through the shared payload and endpoint", async () => {
    const app = createApp();
    const response = await app.fetch(new Request("http://localhost/v1/models"));
    expect(response.status).toBe(200);
    const body = await readJsonObject(response);
    expect(body.object).toBe("list");
    const models = modelIds(body.data);
    expect(models).toEqual(getAvailableModels());
    expect(models).toHaveLength(20);
    expect(models.filter((model: string) => model.startsWith("claude"))).toEqual([
      "claude-sonnet-think-deeper",
    ]);
    expect(models).not.toContain("gpt-6-think-deeper");
    expect(modelIds(buildModelsPayload().data)).toEqual(models);
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
    expect(await readJsonObject(found)).toMatchObject({
      id,
      object: "model",
      owned_by: "microsoft",
    });

    const missing = await call("/v1/models/no-such-model");
    expect(missing.status).toBe(404);
    expect(jsonObjectField(await readJsonObject(missing), "error")).toEqual({
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
    expect(jsonObjectField(await readJsonObject(unknown), "error")).toMatchObject({
      code: "unknown_url",
      param: null,
    });
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
    expect(jsonObjectField(await readJsonObject(malformed), "error").type).toBe(
      "invalid_request_error",
    );

    const n2 = await post(JSON.stringify({ n: 2, messages: [{ role: "user", content: "hi" }] }));
    expect(n2.status).toBe(400);
    expect(jsonObjectField(await readJsonObject(n2), "error")).toMatchObject({
      type: "invalid_request_error",
      param: "n",
      code: null,
    });

    const badRole = await post(JSON.stringify({ messages: [{ role: "wizard", content: "hi" }] }));
    expect(jsonObjectField(await readJsonObject(badRole), "error").param).toBe("messages.0.role");
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
    expect(jsonObjectField(await readJsonObject(missing), "error").code).toBe("invalid_api_key");
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
const LIVE = liveTestsEnabled();

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
    const body = parseChatCompletion(await readJson(res));
    console.log("Turn 1:", JSON.stringify(body, null, 2));

    const choice = firstChoice(body);
    expect(choice.message.role).toBe("assistant");

    // M365 Copilot may or may not follow our tool-calling protocol.
    // If it does produce a tool call, do a follow-up turn.
    const toolCalls = choice.message.tool_calls ?? [];
    const toolCall = toolCalls[0];
    let finalStatus = res.status;
    let finalContent = choice.message.content;
    if (choice.finish_reason === "tool_calls" && toolCall) {
      console.log(`Tool call: ${toolCall.function.name}(${toolCall.function.arguments})`);

      // Simulate tool execution
      let toolResult: string;
      if (toolCall.function.name === "bash") {
        const { command } = bashArgumentsSchema.parse(JSON.parse(toolCall.function.arguments));
        try {
          const childProcess: unknown = await import("node:child_process");
          const childProcessExports = requireJsonObject(childProcess);
          const execute = childProcessExports.execSync;
          if (typeof execute !== "function") {
            throw new TypeError("Expected child_process.execSync to be a function");
          }

          const output: unknown = Reflect.apply(execute, undefined, [
            command,
            { cwd: currentWorkingDirectory(), encoding: "utf-8" },
          ]);
          toolResult = requiredString(output, "bash output").trim();
        } catch (error: unknown) {
          toolResult = commandErrorMessage(error);
        }
      } else if (toolCall.function.name === "read_file") {
        const { path } = fileArgumentsSchema.parse(JSON.parse(toolCall.function.arguments));
        try {
          const fileSystem: unknown = await import("node:fs");
          const fileSystemExports = requireJsonObject(fileSystem);
          const readFile = fileSystemExports.readFileSync;
          if (typeof readFile !== "function") {
            throw new TypeError("Expected fs.readFileSync to be a function");
          }

          const contents: unknown = Reflect.apply(readFile, undefined, [path, "utf-8"]);
          toolResult = requiredString(contents, "file contents");
        } catch (error: unknown) {
          toolResult = errorMessage(error);
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
            ...(choice.message.content === undefined ? {} : { content: choice.message.content }),
            tool_calls: toolCalls,
          },
          {
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: toolResult,
          },
        ]),
      );

      const body2 = parseChatCompletion(await readJson(res2));
      console.log("Turn 2:", JSON.stringify(body2, null, 2));

      const choice2 = firstChoice(body2);
      finalStatus = res2.status;
      finalContent = choice2.message.content;
    } else {
      // Model responded with plain text — still a valid response
      console.log(
        "Model responded without tool calls (M365 Copilot overrode tool-calling protocol)",
      );
    }
    expect(finalStatus === 200 && finalContent).toBeTruthy();
  }, 120_000);

  it("should return models list", async () => {
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const body = await readJsonObject(res);
    expect(body.object).toBe("list");
    const models = modelIds(body.data);
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toBeTruthy();
  });

  it("should return health check", async () => {
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = await readJsonObject(res);
    expect(body.status).toBe("ok");
  });
});
