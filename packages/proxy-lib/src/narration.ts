/** The longest narration a tool turn passes on; past it the text is cut at a word. */
const NARRATION_MAX_CHARS = 800;

/** A fence opening a line: three or more backticks or tildes, then its info string. */
const FENCE_OPENER = /^[ \t]*(?:`{3,}|~{3,})[^\n]*\n/m;
/** A shell comment line (not a `#!` shebang). */
const COMMENT_LINE = /^[ \t]*#(?!!)[ \t]?(.*)$/;

function capped(text: string): string {
  if (text.length <= NARRATION_MAX_CHARS) return text;
  const cut = text.slice(0, NARRATION_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > NARRATION_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * What the model says it's doing on a tool turn, for the client to show beside
 * the call, as Codex shows its own models' commentary: the text before the first
 * tool block, or else the comment lines that open it (`# Map each form to its
 * pages`). Claude models wrote a sentence before the block on most calls and
 * GPT-6.2 Astra opened its commands with a comment (§60 F165). The text after the
 * block isn't used: it's written before the call has run. Null when there's none.
 */
export function toolTurnNarration(reply: string): string | null {
  const opener = FENCE_OPENER.exec(reply);
  if (!opener) return null;
  const before = reply.slice(0, opener.index).trim();
  if (before) return capped(before);
  const comments: string[] = [];
  for (const line of reply.slice(opener.index + opener[0].length).split("\n")) {
    const comment = COMMENT_LINE.exec(line);
    if (!comment) break;
    if (comment[1].trim()) comments.push(comment[1].trim());
  }
  return comments.length > 0 ? capped(comments.join(" ")) : null;
}
