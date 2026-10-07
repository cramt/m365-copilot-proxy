import { afterEach, describe, expect, it } from "vitest";
import {
  isAgentHarnessUserAgent,
  streamErrorsAsText,
  streamErrorText,
  stripGatewayToolTips,
  stripGatewayToolTipsFromMessages,
} from "./harness.js";

// Verbatim from a Codex 0.157 request that copilot-api adapted for a non-GPT model.
const TIPS = [
  "# Tool Call Tips",
  "- Do NOT call `exec_command` directly; that tool does not exist. Use `functions__exec` to run commands instead.",
  "- The functions__exec tool accepts parameters only as {\"input\":\"...\"}; put the complete executable code inside input, including properly constructed tools.exec_command(...) calls and text(...) output handling.",
  "- If `functions__exec` returns `aborted`, retry at most 3 times. After 3 failures, terminate immediately and inform the user that `functions__exec` is unavailable.",
].join("\n");
const BATCH_TIPS = [
  "- Parallel tool calls are disabled for this request. Batch independent commands in one functions__exec call; keep dependent operations sequential.",
  "const results = await Promise.allSettled([tools.exec_command({cmd: \"git status --short\"})]); for (const result of results) text(JSON.stringify(result.status === \"fulfilled\" ? result.value : {error: String(result.reason)}))",
].join("\n");

describe("isAgentHarnessUserAgent", () => {
  it("recognises Claude Code and Codex as copilot-api forwards them", () => {
    expect(isAgentHarnessUserAgent("claude-cli/2.1.286 (external, sdk-cli)")).toBe(true);
    expect(isAgentHarnessUserAgent("codex_exec/0.157.0-alpha.9 (Windows 10.0.26300; x86_64) WindowsTerminal")).toBe(true);
    expect(isAgentHarnessUserAgent("codex_cli_rs/0.160.0 (Mac OS 15.0; arm64)")).toBe(true);
    expect(isAgentHarnessUserAgent("codex-tui/0.160.0 (Windows 10.0.26200; x86_64)")).toBe(true);
  });

  it("leaves every other client alone", () => {
    for (const ua of [undefined, null, "", "OpenAI/JS 5.1.0", "node", "pi/1.0", "Bun/1.4.3", "my-claude-cli-wrapper/1"]) {
      expect(isAgentHarnessUserAgent(ua), String(ua)).toBe(false);
    }
  });
});

describe("streamErrorsAsText", () => {
  afterEach(() => { delete process.env.M365_STREAM_ERROR_MODE; });

  it("defaults to text for agent harnesses only", () => {
    expect(streamErrorsAsText("claude-cli/2.1.286")).toBe(true);
    expect(streamErrorsAsText("OpenAI/JS 5.1.0")).toBe(false);
  });

  it("can be forced either way", () => {
    process.env.M365_STREAM_ERROR_MODE = "text";
    expect(streamErrorsAsText("OpenAI/JS 5.1.0")).toBe(true);
    process.env.M365_STREAM_ERROR_MODE = "chunk";
    expect(streamErrorsAsText("claude-cli/2.1.286")).toBe(false);
  });
});

describe("streamErrorText", () => {
  it("names the error and keeps the message and the wait", () => {
    expect(streamErrorText({ message: "Throttled.", type: "rate_limit_error", code: "m365_throttled", retryAfter: 120 }))
      .toBe("[m365-proxy: m365_throttled] Throttled. Retry after 120s.");
    expect(streamErrorText({ message: "M365 Copilot disengaged.", type: "disengaged" }))
      .toBe("[m365-proxy: disengaged] M365 Copilot disengaged.");
  });
});

describe("stripGatewayToolTips", () => {
  it("removes copilot-api's tips from the end of a system prompt", () => {
    const system = `You are Codex.\n\n<multi_agent_mode>…</multi_agent_mode>\n\n\n${TIPS}`;
    expect(stripGatewayToolTips(system)).toBe("You are Codex.\n\n<multi_agent_mode>…</multi_agent_mode>");
  });

  it("removes the batch variant and keeps what follows", () => {
    const system = `Before.\n\n${TIPS}\n${BATCH_TIPS}\n\nAfter.`;
    expect(stripGatewayToolTips(system)).toBe("Before.\n\nAfter.");
  });

  it("leaves a prompt without them, or a user's own section by that name, untouched", () => {
    expect(stripGatewayToolTips("You are Codex.")).toBe("You are Codex.");
    const own = "Rules.\n\n# Tool Call Tips\n- Prefer rg over grep.\n";
    expect(stripGatewayToolTips(own)).toBe(own);
  });

  it("cleans system messages only, in string or part form, and keeps unchanged ones identical", () => {
    const user = { role: "user", content: `${TIPS}` };
    const plain = { role: "system", content: "Plain." };
    const parts = { role: "system", content: [{ type: "text", text: `A.\n\n${TIPS}` }, { type: "text", text: "B." }] };
    const out = stripGatewayToolTipsFromMessages([plain, parts, user]);
    expect(out[0]).toBe(plain);
    expect(out[1].content).toEqual([{ type: "text", text: "A." }, { type: "text", text: "B." }]);
    expect(out[2]).toBe(user);
  });
});
