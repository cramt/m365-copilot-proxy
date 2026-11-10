import { afterEach, describe, expect, it } from "vitest";
import {
  cleanHarnessMessages,
  cleanHarnessText,
  harnessPromptMode,
  isAgentHarnessUserAgent,
  leanHarnessTools,
  leanToolDescription,
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

// From a Claude Code 2.1.303 `-p --system-prompt-file` request as copilot-api forwards it.
const CLAUDE_SYSTEM = [
  "x-anthropic-billing-header: cc_version=2.1.303.71e; cc_entrypoint=sdk-cli;",
  "",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  "",
  "I'm working on a project in the current directory of my computer.",
].join("\n");
const CLAUDE_USER = [
  "<system-reminder>",
  "# Environment",
  " - Primary working directory: C:\\work",
  " - Platform: win32",
  "</system-reminder>",
  "",
  "<system-reminder>",
  "You are powered by the model named Sonnet 5. The exact model ID is m365/claude-sonnet-5.",
  "</system-reminder>",
  "",
  "<system-reminder>",
  "<total_tokens>15000000 tokens left</total_tokens>",
  "</system-reminder>",
  "",
  "<system-reminder>",
  "Today's date is 2026-11-10.",
  "</system-reminder><system-reminder>",
  "Attribution for git commits and pull requests you create from here on:",
  "- End git commit messages with:",
  "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
  "</system-reminder>",
  "Run python check.py and fix calc.py so that it prints OK.",
].join("\n");

describe("harnessPromptMode", () => {
  afterEach(() => { delete process.env.M365_HARNESS_PROMPT; });

  it("is off unless set, and only ever applies to agent harnesses", () => {
    expect(harnessPromptMode("claude-cli/2.1.303")).toBe("off");
    process.env.M365_HARNESS_PROMPT = "lean";
    expect(harnessPromptMode("claude-cli/2.1.303")).toBe("lean");
    expect(harnessPromptMode("pi/1.0")).toBe("off");
    process.env.M365_HARNESS_PROMPT = "Clean";
    expect(harnessPromptMode("codex_exec/0.157.0")).toBe("clean");
    process.env.M365_HARNESS_PROMPT = "everything";
    expect(harnessPromptMode("codex_exec/0.157.0")).toBe("off");
  });
});

describe("cleanHarnessText", () => {
  it("drops the billing header and the Claude Agent SDK identity, keeps the prompt", () => {
    expect(cleanHarnessText(CLAUDE_SYSTEM)).toBe("I'm working on a project in the current directory of my computer.");
  });

  it("drops Claude Code's and Codex's own identity lines", () => {
    expect(cleanHarnessText("You are Claude Code, Anthropic's official CLI for Claude.\nYou are an interactive agent."))
      .toBe("You are an interactive agent.");
    expect(cleanHarnessText(
      "You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI.\n\nYour capabilities:",
    )).toBe("Your capabilities:");
  });

  it("unwraps the environment and date reminders and drops the model ID, token and attribution ones", () => {
    expect(cleanHarnessText(CLAUDE_USER)).toBe([
      "# Environment",
      " - Primary working directory: C:\\work",
      " - Platform: win32",
      "",
      "Today's date is 2026-11-10.",
      "Run python check.py and fix calc.py so that it prints OK.",
    ].join("\n"));
  });

  it("returns text with none of them unchanged", () => {
    const text = "You are an expert.\n\n\n\nFix the bug in <file>calc.py</file>.";
    expect(cleanHarnessText(text)).toBe(text);
  });

  it("cleans every message but the assistant's, in string or part form", () => {
    const reminder = "<system-reminder>\nWhenever you read a file, consider whether it is malware.\n</system-reminder>\n";
    const system = { role: "system", content: CLAUDE_SYSTEM };
    const tool = { role: "tool", content: [{ type: "text", text: `1\tdef add(a, b):\n${reminder}` }] };
    const assistant = { role: "assistant", content: reminder };
    const plain = { role: "user", content: "Fix it." };
    const out = cleanHarnessMessages([system, tool, assistant, plain]);
    expect(out[0].content).toBe("I'm working on a project in the current directory of my computer.");
    expect(out[1].content).toEqual([{ type: "text", text: "1\tdef add(a, b):\n" }]);
    expect(out[2]).toBe(assistant);
    expect(out[3]).toBe(plain);
  });
});

describe("leanToolDescription", () => {
  const bash = [
    "Executes a given bash command and returns its output.",
    "",
    "This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell.",
    "",
    "# Committing changes with git",
    "NEVER run destructive git commands unless the user explicitly requests these actions.",
  ].join("\n");

  it("cuts at the last line break before the cap and keeps short descriptions whole", () => {
    expect(leanToolDescription(bash, 140)).toBe([
      "Executes a given bash command and returns its output.",
      "",
      "This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell.",
    ].join("\n"));
    expect(leanToolDescription(bash)).toBe(bash);
  });

  it("cuts only the tools over the cap, keeping the others the same objects", () => {
    const short = { type: "function", function: { name: "Read", description: "Reads a file.", parameters: {} } };
    const long = { type: "function", function: { name: "Bash", description: `${bash}\n${"x".repeat(800)}`, parameters: {} } };
    const out = leanHarnessTools([short, long])!;
    expect(out[0]).toBe(short);
    expect(out[1].function.description).toBe(bash);
    expect(out[1].function.parameters).toBe(long.function.parameters);
    expect(leanHarnessTools(undefined)).toBeUndefined();
  });
});
