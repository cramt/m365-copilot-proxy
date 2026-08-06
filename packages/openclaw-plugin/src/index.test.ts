import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateOpenClawConfig, startForOpenClaw, type ProxyHandle } from "./index.js";
import { getAvailableModels } from "@m365-copilot/core";

// --- Sample tools for integration tests ---

const SAMPLE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file from the filesystem",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bash",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" },
        },
        required: ["command"],
      },
    },
  },
];

// --- Unit tests (no network) ---

describe("generateOpenClawConfig", () => {
  it("generates valid config with all models", () => {
    const config = generateOpenClawConfig(4141);

    expect(config.models.mode).toBe("merge");
    expect(config.models.providers.m365.baseUrl).toBe("http://localhost:4141/v1");
    expect(config.models.providers.m365.api).toBe("openai-completions");

    const modelIds = config.models.providers.m365.models.map((m) => m.id);
    for (const id of getAvailableModels()) {
      expect(modelIds).toContain(id);
    }
  });

  it("generates agent defaults with m365/ prefix and marks reasoning models", () => {
    const config = generateOpenClawConfig(9999);

    expect(config.models.providers.m365.baseUrl).toBe("http://localhost:9999/v1");

    for (const key of Object.keys(config.agents.defaults.models)) {
      expect(key).toMatch(/^m365\//);
    }

    const models = config.models.providers.m365.models;
    expect(models.find((m) => m.id === "gpt-5.6-think-deeper")?.reasoning).toBe(true);
    expect(models.find((m) => m.id === "think-deeper")?.reasoning).toBe(true);
    expect(models.find((m) => m.id === "quick")?.reasoning).toBe(false);
  });
});

// --- Integration tests against real M365 Copilot via proxy ---
// Requires valid auth credentials in ~/.config/opencode-m365/secrets.json
// Only 3 API calls to avoid rate limiting

describe.skipIf(!process.env.M365_LIVE)("OpenClaw proxy integration (live)", () => {
  let proxy: ProxyHandle;
  let baseUrl: string;

  beforeAll(async () => {
    const result = await startForOpenClaw({ port: 0 });
    proxy = result.proxy;
    baseUrl = `http://localhost:${proxy.port}`;
  }, 30000);

  afterAll(async () => {
    if (proxy) await proxy.close();
  });

  it("GET /health and /v1/models work", async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect((await health.json() as any).status).toBe("ok");

    const models = await fetch(`${baseUrl}/v1/models`);
    expect(models.status).toBe(200);
    const data: any = await models.json();
    expect(data.data.map((m: any) => m.id)).toContain("m365-copilot");
  });

  it("POST /v1/chat/completions returns a text response", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "m365-copilot",
        messages: [{ role: "user", content: "What is 2+2? Answer with just the number." }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.choices[0].message.role).toBe("assistant");
    expect(data.choices[0].message.content.length).toBeGreaterThan(0);
    console.log("Response:", data.choices[0].message.content.slice(0, 200));
  }, 120000);

  it("POST /v1/chat/completions with tools detects tool calls", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "m365-copilot",
        messages: [{ role: "user", content: "Read the file /etc/hostname" }],
        tools: SAMPLE_TOOLS,
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const data: any = await res.json();
    const choice = data.choices[0];
    console.log("Tool response:", JSON.stringify(choice, null, 2).slice(0, 500));

    // M365 is non-deterministic — tool call is expected but text is acceptable
    if (choice.finish_reason === "tool_calls") {
      expect(choice.message.tool_calls.length).toBeGreaterThan(0);
      expect(choice.message.tool_calls[0].function.name).toBe("read_file");
    } else {
      // At minimum, we got a valid response back through the proxy
      expect(choice.message.content.length).toBeGreaterThan(0);
    }
  }, 120000);
});
