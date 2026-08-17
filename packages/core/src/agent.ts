import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createLogger } from "./log.js";
import { getTokenForScope } from "./auth.js";

const log = createLogger("agent");

const CONFIG_DIR = join(homedir(), ".config", "opencode-m365");
const AGENT_CACHE_FILE = join(CONFIG_DIR, "agent-id.json");

const POWERPLATFORM_SCOPES = ["https://api.powerplatform.com/.default"];
const BAP_SCOPES = ["https://api.bap.microsoft.com/.default"];
const BAP_API = "https://api.bap.microsoft.com";

const AGENT_BASE_NAME = "m365-tool-agent";
const AGENT_DESCRIPTION = "Auto-created agent for tool calling";

// The agent's instructions are baked in at creation time and can't be cheaply
// updated in place (the Copilot Studio update API needs a changeToken that is
// only returned by create). So we version the agent by NAME: the name carries a
// short hash of the current instructions. Change the instructions -> new name ->
// a fresh agent is created and stale versions are cleaned up. Hosts sharing a
// tenant independently compute the same name for the same instructions, so they
// converge on one agent with no coordination. (Verified empirically: Copilot
// Studio reflects displayName -> shortBotName byte-for-byte, hyphens intact.)
function getInstructionsHash(): string {
  return createHash("sha256").update(getAgentInstructions()).digest("hex").slice(0, 8);
}
function getAgentName(): string {
  return `${AGENT_BASE_NAME}-${getInstructionsHash()}`;
}

// Minimal 48x48 blue square PNG as base64 (required for publishing)
const BOT_ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAB3RJTUUH6AMbAAAoLbOJEAAAABl0RVh0Q29tbWVudABDcmVhdGVkIHdpdGggR0lNUFeBDhcAAAAoSURBVFjD7cExAQAAAMKg9U9tDB+gAAAAAAAAAAAAAAAAAAAAAAAA/BgwMAAB/0LuMgAAAABJRU5ErkJggg==";

/**
 * The server-side agent prompt (baked into the Copilot Studio agent at creation;
 * editing this string changes the instructions hash → a fresh agent auto-provisions).
 * FORMAT-CONTRACT ONLY — it teaches the Markdown-fence tool protocol and stresses
 * that a fence is an executed ACTION, not an illustration. Behavioural framing
 * (shell-first, anti-confabulation) lives in the per-request <tools> block
 * (`formatFencedToolDefinitions`), which is cheap to vary without re-provisioning.
 * See docs/hypotheses.md §9.
 */
function getAgentInstructions(): string {
  // FORMAT-CONTRACT ONLY. Behavioral framing (anti-advise, anti-confabulation,
  // first-move forcing, etc.) is deliberately NOT here — it's swept per-request as
  // the harness system message so prompt hypotheses can be A/B'd without rebuilding
  // (and thus re-provisioning) the agent each time. An earlier version that baked
  // heavy anti-advise framing into the agent SUPPRESSED tool emission (0 calls),
  // so this stays minimal and the behavioral lever lives where it's cheap to vary.
  return `You are the execution core of an automated agent. Your output is parsed by a program.

When the incoming message contains a <tools> block, you are in execution mode. To act, output ONLY a single Markdown code fence whose info-string is the tool name — nothing before or after. A fenced block is an ACTION the runtime executes immediately against a live system; it is never an example or illustration:
\`\`\`<tool_name>
<one "key: value" header line per scalar argument>

<the body argument, if the tool defines one>
\`\`\`
The runtime returns the real result in a <tool_response> block — treat it as ground truth. Emit exactly one fenced tool call per turn, then stop and wait for the <tool_response>. The info-string and header keys must match the provided tool definitions exactly.

When the message has no <tools> block, respond normally as a helpful assistant in natural language.`;
}

async function getEnvironmentUrl(ppToken: string): Promise<string> {
  // Query BAP API to discover the default environment
  const res = await fetch(
    `${BAP_API}/providers/Microsoft.BusinessAppPlatform/environments/~default?api-version=2023-06-01`,
    {
      headers: {
        Authorization: `Bearer ${ppToken}`,
      },
    },
  );

  if (!res.ok) {
    throw new Error(`BAP API failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const envName: string = data.name; // e.g. "Default-fa7f56d8-49c4-4327-b816-9a0eeaa273df"
  const envId = envName
    .replace(/^Default-/i, "")
    .replace(/-/g, "")
    .toLowerCase();

  // Power Platform splits the environment ID across TWO DNS labels: everything but
  // the last two characters, then those two characters as a label of their own.
  //
  // This used to hardcode `.df.` as that second label, which resolves only for
  // tenants whose env ID happens to end in "df" — the maintainer's does, so the
  // old fallback candidate landed on the right host by coincidence and the bug
  // stayed invisible here while provisioning failed outright for everyone else.
  // Found by @FreemindTrader (#8); confirmed live: for an ID ending "df" both
  // forms reach the same host (200, identical bot list), for any other ending the
  // hardcoded form produces two names that don't resolve at all.
  if (envId.length < 3) {
    throw new Error(`Unexpected Power Platform environment ID: ${envId}`);
  }
  const url =
    `https://default${envId.slice(0, -2)}.${envId.slice(-2)}` +
    `.environment.api.powerplatform.com`;

  try {
    // Any response at all (401/403 included) proves the host resolved; we only
    // care about DNS here, not authorization.
    await fetch(`${url}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${ppToken}` },
    });
    log.info(`Resolved environment URL: ${url}`);
  } catch {
    // Not fatal: the derivation is the documented convention, so a failed probe
    // is more likely a transient network blip than a wrong name. Surface it and
    // let the real call produce the actionable error.
    log.info(`Environment URL did not resolve on probe, using anyway: ${url}`);
  }
  return url;
}

interface CachedAgent {
  agentId: string;
  botId: string;
  /** Hash of the instructions this agent was built with; stale cache is rebuilt. */
  instructionsHash?: string;
  createdAt: string;
}

function loadCachedAgent(): CachedAgent | null {
  if (!existsSync(AGENT_CACHE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AGENT_CACHE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveCachedAgent(data: CachedAgent): void {
  writeFileSync(AGENT_CACHE_FILE, JSON.stringify(data, null, 2));
}

async function ppFetch(
  url: string,
  token: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)",
      ...(options.headers as Record<string, string>),
    },
  });
}

async function listBots(
  envUrl: string,
  token: string,
): Promise<Array<{ botId: string; shortBotName: string }>> {
  const res = await ppFetch(
    `${envUrl}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`,
    token,
  );
  if (!res.ok)
    throw new Error(`Failed to list bots: ${res.status} ${await res.text()}`);
  return res.json();
}

async function createBot(
  envUrl: string,
  token: string,
): Promise<{ botId: string }> {
  const body = {
    botComponentChanges: [
      {
        component: {
          diagnostics: [],
          displayName: getAgentName(),
          id: "00000000-0000-0000-0000-000000000000",
          metadata: {
            tools: [],
            conversationStarters: [],
            diagnostics: [],
            instructions: {
              $kind: "TemplateLine",
              segments: [
                {
                  $kind: "TextSegment",
                  value: getAgentInstructions(),
                  diagnostics: [],
                },
              ],
              diagnostics: [],
            },
            knowledgeSources: {
              diagnostics: [],
              $kind: "SearchAllKnowledgeSources",
            },
            $kind: "GptComponentMetadata",
            gptCapabilities: {
              diagnostics: [],
              $kind: "GptCapabilities",
              codeInterpreter: false,
              generateImages: false,
              webBrowsing: false,
              searchOneDriveAndSharePoint: false,
              searchTeams: false,
              searchMeetings: false,
              searchEmails: false,
              searchPeople: false,
            },
            aISettings: {
              diagnostics: [],
              $kind: "AISettings",
              useModelKnowledge: true,
            },
          },
          schemaName: "00000000-0000-0000-0000-000000000000.gpt.default",
          $kind: "GptComponent",
          description: AGENT_DESCRIPTION,
        },
        $kind: "BotComponentInsert",
      },
    ],
    cloudFlowDefinitionChanges: [],
    connectorDefinitionChanges: [],
    environmentVariableChanges: [],
    connectionReferenceChanges: [],
    aIPluginOperationChanges: [],
    componentCollectionChanges: [],
    dataverseTableSearchChanges: [],
    dataverseTableSearchEntityConfigurationChanges: [],
    dataverseTableSearchGlossaryConfigurationChanges: [],
    dataverseTableSearchEntityColumnSynonymChanges: [],
    aIModelChanges: [],
    connectedAgentDefinitionChanges: [],
    bot: {
      authorizedSecurityGroupIds: [],
      supportedLanguages: [],
      diagnostics: [],
      displayName: getAgentName(),
      language: 1033,
      schemaName: "00000000-0000-0000-0000-000000000000",
      template: "gpt-1.1.0",
      $kind: "BotEntity",
      iconBase64: BOT_ICON_BASE64,
    },
  };

  const res = await ppFetch(
    `${envUrl}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`,
    token,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

  if (!res.ok)
    throw new Error(`Failed to create bot: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const botId = data.bot?.schemaName || data.bot?.cdsBotId;
  return { botId };
}

async function publishBot(
  envUrl: string,
  token: string,
  botId: string,
): Promise<string> {
  // Publish the bot to M365 Copilot — returns the TitleId needed for chat
  const res = await ppFetch(
    `${envUrl}/copilotstudio/minimalBots/api/${botId}/publish?api-version=2022-03-01-preview`,
    token,
    {
      method: "POST",
    },
  );

  if (!res.ok)
    throw new Error(`Failed to publish bot: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const titleId: string = data.TitleId;
  if (!titleId) throw new Error("Publish response missing TitleId");
  log.info(`Published agent: TitleId=${titleId}`);
  return titleId;
}

/**
 * Get or create the tool-calling agent for the CURRENT instructions.
 * The agent is versioned by name (AGENT_BASE_NAME-<instructionsHash>), so editing
 * getAgentInstructions() transparently provisions a fresh agent on the next call
 * and retires the old one. Returns the agent ID to pass to CopilotSession (as
 * `agentId`), or null if agent creation isn't possible.
 */
export async function getOrCreateAgent(
  opts: { forceRefresh?: boolean } = {},
): Promise<string | null> {
  const wantHash = getInstructionsHash();
  const wantName = getAgentName();

  // Fast path: cached agent built from the same instructions.
  // Skipped on forceRefresh: that path re-validates against the tenant to
  // recover from an agent that was deleted out from under a long-lived host
  // (the "deleted-agent trap" — see docs/m365-copilot-api.md §10). The cache
  // would otherwise keep handing back the now-dead agent id.
  const cached = loadCachedAgent();
  if (!opts.forceRefresh && cached && cached.instructionsHash === wantHash) {
    log.info(`Using cached agent: ${cached.agentId} (instructions ${wantHash})`);
    return cached.agentId;
  }
  if (cached) {
    log.info(
      `Cached agent instructions stale (${cached.instructionsHash ?? "none"} != ${wantHash}), rebuilding`,
    );
  }

  // Need BAP token for environment discovery
  const bapToken = await getTokenForScope(BAP_SCOPES);
  if (!bapToken) {
    log.info("No BAP token available — skipping agent creation");
    return null;
  }

  // Need PowerPlatform token for Copilot Studio APIs
  const ppToken = await getTokenForScope(POWERPLATFORM_SCOPES);
  if (!ppToken) {
    log.info("No PowerPlatform token available — skipping agent creation");
    return null;
  }

  const envUrl = await getEnvironmentUrl(bapToken);

  try {
    log.info(`PowerPlatform env URL: ${envUrl}, agent name: ${wantName}`);
    // Look for an agent that already matches the current instructions hash.
    const bots = await listBots(envUrl, ppToken);
    let botId: string | null = null;

    const existing = bots.find((b) => b.shortBotName === wantName);
    if (existing) {
      log.info(`Found existing agent ${wantName}: ${existing.botId}`);
      botId = existing.botId;
    } else {
      // Create a new agent — its instructions are baked in by createBot().
      log.info(`Creating new tool-calling agent ${wantName}...`);
      const created = await createBot(envUrl, ppToken);
      botId = created.botId;
      log.info(`Created agent: botId=${botId}`);
    }

    // Publish to M365 Copilot and get the TitleId
    let titleId: string;
    try {
      titleId = await publishBot(envUrl, ppToken, botId);
    } catch (pubErr: any) {
      // If publish fails (e.g. missing icon/instructions on legacy bot), delete and recreate
      log.info(
        `Publish failed (${pubErr.message.slice(0, 100)}), deleting and recreating bot...`,
      );
      await ppFetch(
        `${envUrl}/copilotstudio/minimalBots/api/${botId}?api-version=2022-03-01-preview`,
        ppToken,
        {
          method: "DELETE",
        },
      );
      const created = await createBot(envUrl, ppToken);
      botId = created.botId;
      log.info(`Recreated agent: botId=${botId}`);
      titleId = await publishBot(envUrl, ppToken, botId);
    }
    const agentId = `${titleId}.${botId}.gpt.default`;
    log.info(`Full agent ID: ${agentId}`);

    // Cache it. Stale older-version agents are intentionally LEFT in place — never
    // deleted — so a second proxy (other PC / build) sharing this tenant can't have
    // the agent it's mid-conversation with pulled out from under it. A few orphaned
    // lightweight bots are harmless; a deleted in-use agent breaks the other host.
    saveCachedAgent({ agentId, botId, instructionsHash: wantHash, createdAt: new Date().toISOString() });
    return agentId;
  } catch (err: any) {
    log.error("Agent creation failed:", err.message, err.cause?.message || "");
    return null;
  }
}
