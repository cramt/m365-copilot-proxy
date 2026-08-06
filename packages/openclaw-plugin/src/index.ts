import { getToken, getAvailableModels, createLogger } from "@m365-copilot/core";
import { createApp } from "@m365-copilot/proxy-lib";
import { serve } from "srvx";

const log = createLogger("openclaw-plugin");

export { getAvailableModels };

// --- OpenClaw config generation ---

export interface OpenClawModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface OpenClawProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: OpenClawModelConfig[];
}

export interface OpenClawConfig {
  models: {
    mode: "merge";
    providers: {
      m365: OpenClawProviderConfig;
    };
  };
  agents: {
    defaults: {
      models: Record<string, { alias: string }>;
    };
  };
}

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "gpt-5.6-think-deeper": "GPT-5.6 Think Deeper",
  "m365-copilot": "M365 Copilot (Auto)",
  "auto": "M365 Auto",
  "quick": "GPT Quick",
  "think-deeper": "GPT Think Deeper",
  "gpt-5.4": "GPT-5.4 Think Deeper",
  "gpt-5.4-quick": "GPT-5.4 Quick",
  "gpt-5.4-think-deeper": "GPT-5.4 Think Deeper",
  "gpt-5.3": "GPT-5.3 Quick",
  "gpt-5.3-quick": "GPT-5.3 Quick",
  "gpt-5.3-think-deeper": "GPT-5.3 Think Deeper",
  "gpt-5.2": "GPT-5.2 Quick",
  "gpt-5.2-quick": "GPT-5.2 Quick",
  "gpt-5.2-think-deeper": "GPT-5.2 Think Deeper",
};

const REASONING_MODELS = new Set([
  "gpt-5.6-think-deeper",
  "think-deeper",
  "gpt-5.4", "gpt-5.4-think-deeper",
  "gpt-5.3-think-deeper",
  "gpt-5.2-think-deeper",
]);

export function generateOpenClawConfig(proxyPort: number = 4141): OpenClawConfig {
  const models = getAvailableModels();

  const modelConfigs: OpenClawModelConfig[] = models.map((id) => ({
    id,
    name: MODEL_DISPLAY_NAMES[id] || id,
    reasoning: REASONING_MODELS.has(id),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }));

  const modelAllowlist: Record<string, { alias: string }> = {};
  for (const id of models) {
    modelAllowlist[`m365/${id}`] = { alias: id };
  }

  return {
    models: {
      mode: "merge",
      providers: {
        m365: {
          baseUrl: `http://localhost:${proxyPort}/v1`,
          apiKey: "not-needed",
          api: "openai-completions",
          models: modelConfigs,
        },
      },
    },
    agents: {
      defaults: {
        models: modelAllowlist,
      },
    },
  };
}

export interface ProxyHandle {
  port: number;
  close: () => void;
}

/**
 * Start the M365 proxy and return the OpenClaw config pointing to it.
 */
export async function startForOpenClaw(options: { port?: number } = {}): Promise<{
  proxy: ProxyHandle;
  config: OpenClawConfig;
}> {
  log.info("Starting M365 proxy for OpenClaw...");

  try {
    await getToken();
  } catch (err: any) {
    log.error("Auth failed:", err.message);
    throw err;
  }

  const app = createApp();
  const port = options.port ?? 4141;

  // Bind and resolve the *actual* port (port 0 picks a free one).
  const server = serve({ fetch: app.fetch, port, hostname: "localhost", silent: true });
  await server.ready();
  const actualPort = server.url ? Number(new URL(server.url).port) : port;

  const config = generateOpenClawConfig(actualPort);
  log.info(`Proxy started on port ${actualPort}`);

  return {
    proxy: {
      port: actualPort,
      close: () => {
        void server.close();
      },
    },
    config,
  };
}
