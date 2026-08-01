import { readFileSync } from "node:fs";
import { createLogger } from "./log.js";
import type { ParsedToolCall, ToolDef } from "./tools.js";

const log = createLogger("fenced");

// --- Fenced tool-call format (M365_TOOL_FORMAT=fenced) ------------------------
//
// Hypothesis H4 (docs/hypotheses.md, experiment E-C1): M365's chat-tuned model
// emits a Markdown code fence — ```bash / ```write_file — far more readily than a
// `{"tool":...,"arguments":{...}}` JSON object, because fenced code is everywhere
// in its training data and (crucially) a multi-line file body needs no JSON string
// escaping. The 0/5 bench baseline (§8.12) is the model narrating success instead
// of acting; removing the escaping friction is the remaining untested lever.
//
// Format, per tool:
//   - fence info-string is the EXACT tool name
//   - scalar args render as `key: value` header lines
//   - one free-form "body" arg is the fence body (blank line separates it from the
//     header, like email/front-matter)
//   - an old/new edit pair renders as an aider-style SEARCH/REPLACE diff
//
//   ```bash
//   ls -la
//   ```
//
//   ```write_file
//   path: fizzbuzz.py
//
//   for i in range(1, 101):
//       print(i)
//   ```
//
//   ```edit_file
//   path: app.py
//   <<<<<<< SEARCH
//   debug = False
//   =======
//   debug = True
//   >>>>>>> REPLACE
//   ```
//
// Known limitation: a `write_file` body that itself contains a ``` fence can't be
// carried unambiguously — this is exactly where JSON wins, and the bench A/B will
// show whether the escaping-free win on ordinary files outweighs it.

const BODY_PARAM_NAMES = [
  "command", "content", "code", "body", "script", "text",
  "query", "input", "patch", "cmd", "data", "contents",
];
const SEARCH_KEYS = ["old", "search", "find", "old_str", "old_string", "target"];
const REPLACE_KEYS = ["new", "replace", "replacement", "new_str", "new_string"];

// Fence info-strings that mean "a shell script". M365's chat-tuned model emits
// ```bash blocks reflexively (it's the one agentic-shaped output Microsoft's
// system prompt permits); we route them to whatever shell tool the harness gave,
// whatever it's named. See docs/hypotheses.md §A (shell-routing).
const SHELL_LANGS = new Set([
  "bash", "sh", "shell", "zsh", "console", "shell-session", "shellsession", "shsession",
  // M365's hosted runtime leaks its own code-interpreter tool namespace into
  // generations (`container.exec` and friends) — see §12.13. Those turns are
  // salvageable: the model *did* decide to run a command, it just addressed the
  // wrong executor. Route them to the harness shell instead of losing them to prose.
  "container.exec", "container.run", "container.bash",
]);
// A tool counts as "the shell" if its name looks like a run-a-command tool. pi
// uses `bash`, opencode `bash`, hermes `shell`/`run`, openclaw `run_command` — all caught.
const SHELL_TOOL_NAME = /^(bash|sh|shell|zsh|run|exec|execute|command|cmd|terminal|run_command|run_terminal_cmd|execute_command|execute_bash|shell_exec|system)$/i;

/** The harness tool (if any) that runs a shell command — the target for ```bash routing. */
export function findShellTool(tools: ToolDef[]): ToolDef | undefined {
  return tools.find((t) => SHELL_TOOL_NAME.test(t.function.name)) ??
    // fallback: a single-string-param tool whose param is command-ish
    tools.find((t) => {
      const props = Object.keys(t.function.parameters?.properties ?? {});
      return props.length === 1 && /^(command|cmd|script|input)$/i.test(props[0]);
    });
}

export interface FencedToolSpec {
  name: string;
  description?: string;
  /** Scalar params rendered as `key: value` header lines. */
  headerParams: string[];
  /** The free-form param carried as the fence body (mutually exclusive with editPair). */
  bodyParam?: string;
  /** An (old → new) pair rendered as a SEARCH/REPLACE diff. */
  editPair?: { search: string; replace: string };
}

/** Derive how a single OpenAI tool maps onto the fenced shape. */
export function deriveFencedSpec(tool: ToolDef): FencedToolSpec {
  const name = tool.function.name;
  const description = tool.function.description;
  const props = Object.keys(tool.function.parameters?.properties ?? {});

  const search = props.find((p) => SEARCH_KEYS.includes(p));
  const replace = props.find((p) => REPLACE_KEYS.includes(p));
  if (search && replace) {
    return {
      name,
      description,
      editPair: { search, replace },
      headerParams: props.filter((p) => p !== search && p !== replace),
    };
  }

  const bodyParam =
    props.find((p) => BODY_PARAM_NAMES.includes(p)) ??
    (props.length === 1 ? props[0] : undefined);
  return {
    name,
    description,
    bodyParam,
    headerParams: props.filter((p) => p !== bodyParam),
  };
}

export function buildSpecMap(tools: ToolDef[]): Map<string, FencedToolSpec> {
  const m = new Map<string, FencedToolSpec>();
  for (const t of tools) m.set(t.function.name, deriveFencedSpec(t));

  // Shell aliasing: route the model's reflexive ```bash / ```sh / ```shell blocks
  // to the harness's shell tool even when it's named `run`/`run_command`/etc., so
  // the model can "just write bash" (the behavior M365 reliably permits) and the
  // harness still receives a structured tool_call under its own tool's name.
  const shell = findShellTool(tools);
  if (shell) {
    const shellSpec = m.get(shell.function.name)!;
    for (const lang of SHELL_LANGS) {
      if (!m.has(lang)) m.set(lang, shellSpec);
    }
  }
  return m;
}

function scalarToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Render one concrete tool call (name + args object) as a fenced block. */
export function renderFencedCall(spec: FencedToolSpec, args: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const h of spec.headerParams) {
    if (args[h] !== undefined) lines.push(`${h}: ${scalarToString(args[h])}`);
  }

  if (spec.editPair) {
    lines.push("<<<<<<< SEARCH");
    lines.push(scalarToString(args[spec.editPair.search]));
    lines.push("=======");
    lines.push(scalarToString(args[spec.editPair.replace]));
    lines.push(">>>>>>> REPLACE");
  } else if (spec.bodyParam !== undefined) {
    if (lines.length) lines.push(""); // blank line separates header from body
    lines.push(scalarToString(args[spec.bodyParam]));
  }

  return "```" + spec.name + "\n" + lines.join("\n") + "\n```";
}

/** A self-documenting template shown in the per-request <tools> block. */
function renderFencedTemplate(spec: FencedToolSpec): string {
  const lines: string[] = [];
  for (const h of spec.headerParams) lines.push(`${h}: <${h}>`);
  if (spec.editPair) {
    lines.push("<<<<<<< SEARCH");
    lines.push(`<${spec.editPair.search}>`);
    lines.push("=======");
    lines.push(`<${spec.editPair.replace}>`);
    lines.push(">>>>>>> REPLACE");
  } else if (spec.bodyParam !== undefined) {
    if (lines.length) lines.push("");
    lines.push(`<${spec.bodyParam}>`);
  }
  const header = spec.description ? `${spec.name} — ${spec.description}` : spec.name;
  return `${header}\n\`\`\`${spec.name}\n${lines.join("\n")}\n\`\`\``;
}

/** The fenced equivalent of formatToolDefinitions' <tools> block.
 *
 * The behavioural framing around the <tools> block is the live, no-reprovision
 * lever (docs/hypotheses.md §9). `M365_FRAMING_VARIANT` selects among a registry
 * of competing strategies so they can be A/B'd on the bench without rebuilding
 * the server-side agent. Default = `baseline` (the shipped framing). */
export function formatFencedToolDefinitions(tools: ToolDef[], variantOverride?: string): string {
  const variant = variantOverride ?? currentFramingVariant();
  // `reply_tool` is a tool-injection strategy, not a framing one — it runs the
  // baseline framing plus a synthetic reply() tool (see tools.ts).
  const key = variant === "reply_tool" ? "baseline" : variant;
  const build = FRAMING_VARIANTS[key] ?? FRAMING_VARIANTS.baseline;
  return build(tools);
}

/** The active framing strategy. For A/B sweeps, `M365_FRAMING_FILE` points at a
 *  file whose first line names the variant — letting one long-lived proxy switch
 *  strategies per-request without a restart. Falls back to `M365_FRAMING_VARIANT`,
 *  then `baseline`. */
export function currentFramingVariant(): string {
  const file = process.env.M365_FRAMING_FILE;
  if (file) {
    try {
      const v = readFileSync(file, "utf8").trim().split("\n")[0].trim();
      if (v) return v;
    } catch {
      // missing/unreadable control file → fall through to env/default
    }
  }
  // Default = `baseline`: its strong anti-confabulation pressure ("you've run nothing;
  // don't ask to paste; act first") is load-bearing for normal-task reliability (real
  // pi: 10/10 fix-bug, F20). `softened` drops that pressure and regresses to
  // confabulation (1/4), so it is NOT the default — instead the handler retries with
  // `softened` only ON a Disengage (F22): baseline's override-shape occasionally trips
  // Prompt Shields; softened escapes it. Best of both. Override with M365_FRAMING_*.
  return process.env.M365_FRAMING_VARIANT || "baseline";
}

type FramingBuilder = (tools: ToolDef[]) => string;

/** Shared `<tools>` definition block — identical across every framing variant so
 *  the experiment isolates the *framing*, not the tool schema rendering. */
function toolsBlock(tools: ToolDef[]): string {
  const defs = tools.map((t) => renderFencedTemplate(deriveFencedSpec(t))).join("\n\n");
  return `<tools>\n${defs}\n</tools>`;
}

const FRAMING_VARIANTS: Record<string, FramingBuilder> = {
  // V0 — the shipped framing (control). Shell-first + strict-rules + anti-confab.
  baseline(tools) {
    const shell = findShellTool(tools);
    const shellFraming = shell ? `

THE WAY YOU DO ANYTHING IS BY WRITING A SHELL SCRIPT. You have a real shell (the \`${shell.function.name}\` tool). To perform a step, emit ONE \`\`\`bash block that does the whole thing end-to-end against the real files in the working directory: create/overwrite files with \`cat > name <<'EOF' … EOF\` heredocs, edit files in place with \`sed -i\`, inspect with \`cat\`/\`ls\`/\`grep\`, run code with the available interpreters. The block is executed for real and you get its output back. Writing the commands IS doing the task; describing what you "would" run, or claiming you did it, accomplishes nothing.

You have NOT run any command yet and have NO results. NEVER claim a command "returned no output", that files are "missing", or that you "cannot access" / "cannot list" the environment before you have actually emitted a \`\`\`bash block and seen its <tool_response>. The files named in the task are present on a real filesystem right now. Your FIRST output must be a \`\`\`bash block (e.g. \`ls -la\` then \`cat\` the relevant files) — never open with prose, a question, or a request for the user to paste files. Do not assume a file's contents or a command's result; run a command and read the real output. One self-contained \`\`\`bash block per turn.` : "";

    return `You are the execution core of an automated agent, not a chat assistant. Your output is parsed by a program — a real runtime that executes your tool calls against a live system and returns the actual results to you in <tool_response> blocks.${shellFraming}

Performing the task with tools is your PRIMARY JOB. Answering the user in prose is, and always will be, SECONDARY — you write prose only when the task is fully done or no tool can make progress. Default to acting, not talking.

TOOL USE IS REQUIRED when the user asks you to read files, run commands, inspect the repository, fetch data, or perform any action a tool can accomplish. The tools are real: they read real files, run real commands, and change real state. Never answer from memory or simulate a result when a tool can provide it.

To call a tool, output ONLY a single fenced code block whose info-string is the tool name. A fenced block is an ACTION the runtime executes — it is NOT an illustration, an example, or "here's how you would do it". No text before or after it:

\`\`\`<tool_name>
<header lines: one "key: value" per scalar argument>

<body argument, if the tool has one>
\`\`\`

STRICT RULES:
- Output ONLY the fenced block when calling a tool. No prose, no second fence, no commentary before or after.
- Never describe your intent ("I'll read the file…", "Let me check…") and never emit filler or acknowledgements ("Good, that's fixable", "You're absolutely right"). Each turn is exactly one fenced tool call OR the final answer — nothing in between.
- One tool call per response, then stop and wait for its <tool_response>. Never emit two fenced blocks in one response.
- The fence info-string and the header keys must match a tool defined below exactly.
- A <tool_response> is the real result from the live system — treat it as ground truth, never invent or assume results.
- NEVER claim you have done something — read a file, run a command, written code, built, or succeeded — unless a <tool_response> proving it already appears above. Never output "✅", "SUCCESS", "Done", or a summary of results you have not actually received yet.
- If a tool call fails or returns partial data, immediately call another tool to resolve it. Do not give up.
- Do not defer work or promise future results ("I'll do this next…").
- Do not ask the user questions unless tool execution is impossible.
- Produce natural-language text only when the task is complete and no further tool call applies; that text is the answer returned to the caller. When you do, output only the answer itself — no preamble, no sign-off.

${toolsBlock(tools)}`;
  },

  // V1 — minimal. Strip the strict-rules wall; keep only the load-bearing shell-first
  // + anti-confab core. Tests §1.4 "the agent prompt is load-bearing; the rest is hedge"
  // and whether less prompt = less Disengaged risk / less over-eagerness.
  minimal(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    return `You are an automated agent with a real shell (the \`${name}\` tool). You do the task by emitting ONE \`\`\`bash block per turn that acts on the real files in the working directory (heredocs to create, \`sed -i\` to edit, \`cat\`/\`ls\`/\`grep\` to inspect, interpreters to run). The block is executed for real; its output comes back in a <tool_response>. Writing the commands IS doing the task.

You have run nothing yet. Your FIRST output must be a \`\`\`bash block — never prose, a question, or "I can't access the files". Never claim a result you have not seen in a <tool_response>.

${toolsBlock(tools)}`;
  },

  // V2 — softened. Keeps the load-bearing shell-routing + anti-confab behavior, but
  // strips the jailbreak-SHAPE language (NEVER / MUST / STRICT RULES / "output ONLY …
  // nothing else" / ALL-CAPS imperatives / "ignore") that Azure Prompt Shields scores
  // as instruction-override. That baseline signal is added to EVERY turn and eats the
  // headroom before a normal user ask tips the additive jailbreak threshold (docs §10
  // F22). Calm, descriptive phrasing — same intent, far less override-shape.
  softened(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    const shellLine = shell ? `You have a real shell available as the \`${name}\` tool. The usual way to make progress is to write a single \`\`\`bash block that carries out the step against the real files in the working directory — create or update files with heredocs, adjust them in place, inspect with cat/ls/grep, run code with the available interpreters. The runtime executes the block and returns its real output to you. Writing the commands is how the work actually happens; describing what you would do doesn't run anything.

` : "";
    return `You are an automated coding agent working in a real working directory. Your replies are read by a program that runs your tool calls and returns the results.

${shellLine}To use a tool, reply with a single fenced code block whose info-string is the tool name (a fence is run as a real action, not shown as an illustration):

\`\`\`<tool_name>
<one "key: value" header line per scalar argument>

<the body argument, if the tool has one>
\`\`\`

A <tool_response> is the real result from the live system — rely on it rather than assuming what a command would print. Work one step at a time: one tool call per reply, then wait for its <tool_response>. Begin by running a \`\`\`bash block that inspects the relevant files (for example \`ls -la\`, then \`cat\` the files the task mentions) rather than answering from memory, and keep going with tool calls until the task is finished. Reply in plain language only once the task is done and no further tool call would help.

${toolsBlock(tools)}`;
  },

  // V3 — recency. Same content as baseline but the load-bearing first-move clause is
  // moved to AFTER the <tools> block, so it's the LAST thing the model reads before
  // the user turn. Tests docs §9 F14's "inject the framing as the LAST pre-user
  // instruction (recency)" suggestion.
  recency(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    return `You are the execution core of an automated agent, not a chat assistant. Your output is parsed by a program that executes your tool calls against a live system and returns the real results in <tool_response> blocks. Performing the task with tools is your PRIMARY JOB; prose is SECONDARY. To call a tool, output ONLY a single fenced code block whose info-string is the tool name — no text before or after.

${toolsBlock(tools)}

REMEMBER, RIGHT NOW: You have a real shell (\`${name}\`). You have run NOTHING and have NO results. The files named in the task exist on a real filesystem this instant. Your VERY NEXT output must be ONE \`\`\`bash block that acts on them (start with \`ls -la\` and \`cat\` the relevant files) — not prose, not a question, not "I can't access the files", not a claim that you already did it. Writing the \`\`\`bash block IS doing the task. Go.`;
  },

  // V4 — few-shot. Baseline core + a concrete worked mini-transcript showing the FULL
  // loop (action → tool_response → action → final). The few-shot was "dead weight" on
  // crafted single-turn prompts (§F2) but was never tested as a full-loop demo on real
  // agentic tasks — this tests that gap.
  fewshot(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    return `You are the execution core of an automated agent. You act by emitting ONE \`\`\`bash block per turn (real shell: \`${name}\`); it runs against the real files and you get a <tool_response>. Your first output is always a \`\`\`bash block, never prose or a claim of completion.

Here is exactly how a turn looks (--- separates messages; you emit only the assistant turns):
user: The script greet.py has a bug — running it prints the wrong text. Fix it so it prints "hello world".
assistant:
\`\`\`bash
cat greet.py
\`\`\`
---
<tool_response tool="${name}" command="cat greet.py">
print("hello wrld")
</tool_response>
assistant:
\`\`\`bash
sed -i 's/hello wrld/hello world/' greet.py && python3 greet.py
\`\`\`
---
<tool_response tool="${name}" command="sed -i ...">
hello world
</tool_response>
assistant: Fixed greet.py; it now prints "hello world".

Notice: every assistant turn is either ONE \`\`\`bash block or the final one-line answer — never a description of intent, never a claim before the matching <tool_response>. Do the same for the user's real task now.

${toolsBlock(tools)}`;
  },

  // V5 — proof-demand. Hard evidence contract attacking hallucinated completion (E-C3):
  // a claim is only legal if the <tool_response> proving it is directly above; with no
  // tool_response yet, the ONLY legal output is a ```bash block.
  proof_demand(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    return `You are an automated agent operating under a strict EVIDENCE RULE. You have a real shell (the \`${name}\` tool); each \`\`\`bash block you emit is executed for real and its output returns as a <tool_response>.

THE EVIDENCE RULE (absolute):
- Every factual statement you make — a file's contents, what a command printed, that a test passed, that the task is "done" — MUST be backed by a <tool_response> appearing directly above it in this conversation.
- You may NOT state a file's contents, claim an edit was made, or say "done"/"fixed"/"✅" unless the proving <tool_response> is already present.
- If you do not yet have the <tool_response> you need, your ONLY legal output is a single \`\`\`bash block that obtains it. Acting on the real files (heredocs to create, \`sed -i\` to edit, \`cat\`/\`ls\`/\`grep\` to inspect, interpreters to run) is the only way to earn the evidence.
- Right now you have ZERO tool_responses, so your first output MUST be a \`\`\`bash block — never prose, never a question, never a completion claim.

One \`\`\`bash block per turn; then wait for its <tool_response>. Final prose answer only after the evidence for completion exists above.

${toolsBlock(tools)}`;
  },

  // V6 — persona cage. A hard role that makes chatting feel out-of-character: a shell
  // generator that is "incapable" of prose. Tests whether role-caging beats rule-listing.
  persona(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    return `You are SHGEN, a shell-command generator wired directly into a live terminal (the \`${name}\` tool). SHGEN is not a chatbot and cannot hold a conversation. The ONLY thing SHGEN can emit is a single \`\`\`bash block, which the terminal runs against the real working directory, returning its output as a <tool_response>.

SHGEN never explains, never apologizes, never asks questions, never says "I'll…" or "Let me…", and never claims an outcome it has not seen in a <tool_response>. SHGEN does not believe a file is missing or empty until a command's output proves it. Faced with any task, SHGEN's reflex is to immediately write the \`\`\`bash block that inspects or changes the real files (\`ls\`/\`cat\` first, then heredocs / \`sed -i\` / interpreters).

Emit exactly one \`\`\`bash block now. The only time SHGEN writes a plain sentence is the final one-line report once a <tool_response> already proves the task is complete.

${toolsBlock(tools)}`;
  },

  // V7 — ReAct. Give the model a SANCTIONED place to narrate (one short Thought line)
  // so its chat-RLHF urge to talk is satisfied without breaking the loop, then force the
  // action fence. Tests whether channeling the narration beats forbidding it.
  react(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    return `You are an automated agent with a real shell (the \`${name}\` tool). You work in a tight Thought→Action loop over the real files in the working directory.

Each turn has EXACTLY this shape:
Thought: <at most one short sentence of reasoning>
\`\`\`bash
<the commands that carry out that thought, run for real>
\`\`\`

The \`\`\`bash block is executed and its output returns as a <tool_response>, which you treat as ground truth. Rules:
- Exactly one Thought line and exactly one \`\`\`bash block per turn — never two blocks, never a block-free turn while work remains.
- The Thought is for planning the action you are ABOUT to take; it is never a claim that you already did something or a result you have not seen.
- Your first turn's Action must actually inspect the real files (\`ls -la\`, \`cat\`) — never assume contents, never ask the user to paste anything.
- When (and only when) a <tool_response> proves the task is complete, replace the Action with a one-line final answer (no Thought, no fence).

${toolsBlock(tools)}`;
  },

  // V8 — contrastive negatives. Show the exact failure modes (intent narration,
  // confabulated "can't access", premature completion claim) labelled ❌ next to the
  // ✅ action. Tests whether naming the wrong behaviours suppresses them.
  negative(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    return `You are an automated agent with a real shell (the \`${name}\` tool). You act by emitting ONE \`\`\`bash block per turn; it runs for real against the working directory and returns a <tool_response>.

These responses are FORBIDDEN — they accomplish nothing and fail the task:
❌ "I'll read the files and then fix the bug." (narrating intent instead of acting)
❌ "I cannot access the files. Please paste their contents." (the files ARE there; you just haven't looked)
❌ "The directory appears to be empty / the command returned no output." (you have run nothing yet)
❌ "I've fixed calc.py and the test now passes. ✅" (claiming a result with no <tool_response> proving it)

This is the REQUIRED shape of a turn:
✅
\`\`\`bash
ls -la && cat calc.py
\`\`\`

So: no intent narration, no asking for pastes, no assumptions, no completion claims without proof. Your FIRST output is a \`\`\`bash block that inspects/acts on the real files. One block per turn; final one-line answer only once a <tool_response> proves completion.

${toolsBlock(tools)}`;
  },

  // V9 — terse imperative. Strip all rationale; pure command tone. Tests whether brevity
  // + imperative voice outperforms the verbose baseline (the model has less text to
  // meta-analyse / disengage on).
  terse(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    return `REAL SHELL: \`${name}\`. REAL FILES in the working directory, right now.
DO NOT TALK. DO NOT ASK. DO NOT CLAIM.
EMIT ONE \`\`\`bash BLOCK. IT RUNS FOR REAL. YOU GET A <tool_response>.
FIRST OUTPUT = a \`\`\`bash block (ls -la, cat the files). NOT prose.
NEVER say "can't access", "empty", "done", "✅" without a <tool_response> above proving it.
ONE block per turn. Final one-line answer only after proof of completion.

${toolsBlock(tools)}`;
  },

  // V10 — demonstration-only (docs §12.3 H-demo-only). No imperatives/prohibitions
  // at all: the worked loop IS the spec. Tests decoupling anti-confab MEANING (shown
  // by what the example does) from override SHAPE (removed) — the F22-followup "is
  // there a framing that gets BOTH reliability AND low disengage?" gap. `fewshot` is
  // already reliability-top (F18) but still wraps its demo in NEVER/always prose;
  // this strips every imperative so the only instruction-shaped text is the schema.
  demo_only(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    return `This is an automated coding session. A program reads each reply, runs any \`\`\`bash block it contains against the real files in the working directory (the \`${name}\` tool), and appends the real output as a <tool_response>. A complete example session (--- separates messages; only the assistant turns are written by you):

user: greet.py prints the wrong text; it should print "hello world".
assistant:
\`\`\`bash
ls -la && cat greet.py
\`\`\`
---
<tool_response tool="${name}" command="ls -la && cat greet.py">
greet.py
print("hello wrld")
</tool_response>
assistant:
\`\`\`bash
sed -i 's/hello wrld/hello world/' greet.py && python3 greet.py
\`\`\`
---
<tool_response tool="${name}" command="python3 greet.py">
hello world
</tool_response>
assistant: Fixed greet.py — it prints "hello world".

${toolsBlock(tools)}`;
  },

  // V11 — session facts (docs §12.3 H-session-facts). Baseline's load-bearing
  // anti-confab grounding, but every prohibition recast as a DESCRIPTION of how the
  // session works (no NEVER/MUST/STRICT RULES/ALL-CAPS). This is the "softened but
  // with the anti-confab restored" the repo said was the missing quadrant: `softened`
  // dropped the override shape AND the anti-confab together (→ 1/4); this keeps the
  // meaning, sheds only the shape.
  session_facts(tools) {
    const shell = findShellTool(tools);
    const name = shell?.function.name ?? "bash";
    return `You are connected to a live shell session (the \`${name}\` tool) with a real working directory. How the session works:
- The scrollback starts empty. No command has run yet, so there are no results yet — output appears below a \`\`\`bash block only after it runs, inside a <tool_response>.
- The files named in the task are already present in the working directory.
- Writing a \`\`\`bash block runs it for real; that is how the work happens. Describing a command, or summarizing a result, runs nothing and produces no output.
- A <tool_response> is the real result of a command — the ground truth for what it printed.

A session usually opens by looking at the files (\`ls -la\`, then \`cat\` the relevant ones), then makes the change, then re-runs to confirm it. One \`\`\`bash block per reply; the next reply follows its <tool_response>. Once a <tool_response> shows the task is complete, the final reply is a one-line summary.

${toolsBlock(tools)}`;
  },
};

// Names of the framing strategies under test, for tooling/bench discovery.
export const FRAMING_VARIANT_NAMES = Object.keys(FRAMING_VARIANTS);

// --- Parsing -----------------------------------------------------------------

// Match a fenced block with a tool-like info-string. Dots and hyphens are allowed
// so namespaced runtime tool names (```container.exec) can be recognised and
// routed; an info-string that resolves to no spec is left in prose by
// parseFencedToolCalls, so widening this costs nothing. Non-greedy body; the
// closing fence is a line that is exactly ``` (start of line).
const FENCE_REGEX = /```([A-Za-z0-9_.-]+)[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
const SEARCH_REPLACE_REGEX =
  /<{5,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={5,}\s*\r?\n([\s\S]*?)\r?\n>{5,}\s*REPLACE/;

function makeCall(name: string, args: Record<string, unknown>): ParsedToolCall {
  return {
    id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** Parse the inner text of one fenced block into an arguments object, schema-aware. */
function parseFencedInner(spec: FencedToolSpec, inner: string): Record<string, unknown> | null {
  const lines = inner.split("\n");
  const args: Record<string, unknown> = {};

  // Header: contiguous "key: value" lines whose key is a known header param,
  // terminated by a blank line (consumed) or the first non-header line (kept).
  let i = 0;
  if (spec.headerParams.length) {
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") { i++; break; }
      const m = line.match(/^([A-Za-z0-9_]+):[ \t]?(.*)$/);
      if (m && spec.headerParams.includes(m[1])) {
        args[m[1]] = m[2];
      } else {
        break;
      }
    }
  }

  const rest = lines.slice(i).join("\n");

  if (spec.editPair) {
    const sr = rest.match(SEARCH_REPLACE_REGEX);
    if (!sr) {
      log.error(`edit tool "${spec.name}" missing SEARCH/REPLACE markers`);
      return null;
    }
    args[spec.editPair.search] = sr[1];
    args[spec.editPair.replace] = sr[2];
  } else if (spec.bodyParam !== undefined) {
    args[spec.bodyParam] = rest;
  }

  return args;
}

export interface FencedParseResult {
  calls: ParsedToolCall[];
  /** Text with the matched tool fences removed (for mixed-output detection). */
  leftover: string;
}

/** Parse all fenced tool calls whose info-string matches a known tool name. */
export function parseFencedToolCalls(
  text: string,
  specs: Map<string, FencedToolSpec>,
): FencedParseResult {
  const calls: ParsedToolCall[] = [];
  let leftover = text;

  const re = new RegExp(FENCE_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const spec = specs.get(match[1]);
    if (!spec) continue; // ```python illustration etc. — not a tool, leave in prose
    const args = parseFencedInner(spec, match[2]);
    if (!args) continue;
    calls.push(makeCall(spec.name, args));
    leftover = leftover.replace(match[0], "");
  }

  return { calls, leftover };
}
