import { firstToolCallSpan } from "@m365-copilot/core";

type Tools = Parameters<typeof firstToolCallSpan>[1];

/** The longest narration a tool turn passes on; past it the text is cut at a word. */
const NARRATION_MAX_CHARS = 800;

/** A fence opening a line: three or more backticks or tildes, then its info string. */
const FENCE_OPENER = /^[ \t]*(?:`{3,}|~{3,})[^\n]*\n/m;
/** A line that opens or closes a fence. */
const FENCE_LINE = /^[ \t]*(?:`{3,}|~{3,})/;
/** A shell comment line (not a `#!` shebang). */
const COMMENT_LINE = /^[ \t]*#(?!!)[ \t]?(.*)$/;
/** M365's citation of what it grounded a sentence in: a bare number linking to the
 *  source, such as a file its own search found in the user's OneDrive
 *  (`[1](https://…sharepoint-df.com/personal/…)`, §64 F181). */
const CITATION = /[ \t]*\[\d{1,3}\]\(\s*<?https?:\/\/[^\s)>]*>?\s*\)/g;

function capped(text: string): string {
  if (text.length <= NARRATION_MAX_CHARS) return text;
  const cut = text.slice(0, NARRATION_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > NARRATION_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * What the model says it's doing on a tool turn, for the client to show beside
 * the call, as Codex shows its own models' commentary: the prose that leads into
 * the first tool block, or else the comment lines that open it (`# Map each form
 * to its pages`). Claude models wrote a sentence before the block on most calls and
 * GPT-6.2 Astra opened its commands with a comment (§60 F165). The text after the
 * block isn't used: it's written before the call has run. M365's citation links
 * are dropped. Null when there's none.
 *
 * `tools` finds the block by the parser's rule, so an example block ahead of it
 * (```text, ```python) isn't taken for it. `saidIn` is the reply to read the prose
 * from when the call came from the proxy's re-ask of a damaged or unreadable call:
 * the re-ask's answer talks to the proxy ("Resending with the full .NET type
 * name…"), the first reply to the user (§64 F181).
 */
export function toolTurnNarration(reply: string, tools?: Tools, saidIn: string = reply): string | null {
  const block = toolBlock(reply, tools);
  if (!block) return null;
  const lead = saidIn === reply ? block.start : ((toolBlock(saidIn, tools) ?? firstFence(saidIn))?.start ?? saidIn.length);
  const said = leadIn(saidIn.slice(0, lead)).replace(CITATION, "").trim();
  if (said) return capped(said);
  const comments = openingComments(reply.slice(block.start, block.end));
  return comments ? capped(comments) : null;
}

/** The first tool block: by the parser's rule when the tools are known, else the first fence. */
function toolBlock(reply: string, tools?: Tools): { start: number; end: number } | null {
  return tools && tools.length > 0 ? firstToolCallSpan(reply, tools) : firstFence(reply);
}

function firstFence(text: string): { start: number; end: number } | null {
  const opener = FENCE_OPENER.exec(text);
  return opener ? { start: opener.index, end: text.length } : null;
}

/** The prose that leads into the block: what follows the last example block ahead
 *  of it (`It prints this: ```text…``` Checking it:`), else all of it. */
function leadIn(preamble: string): string {
  const lines = preamble.split("\n");
  const fences = lines.flatMap((line, i) => (FENCE_LINE.test(line) ? [i] : []));
  if (fences.length === 0) return preamble.trim();
  const after = fences.length % 2 === 0 ? lines.slice(fences[fences.length - 1] + 1).join("\n").trim() : "";
  return after || lines.slice(0, fences[0]).join("\n").trim();
}

/** The comment lines that open a block, whose first line is its fence. */
function openingComments(block: string): string | null {
  const comments: string[] = [];
  for (const line of block.split("\n").slice(1)) {
    const comment = COMMENT_LINE.exec(line.replace(/\r$/, ""));
    if (!comment) break;
    if (comment[1].trim()) comments.push(comment[1].trim());
  }
  return comments.length > 0 ? comments.join(" ") : null;
}
