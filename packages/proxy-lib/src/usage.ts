import { utf8Bytes } from "./replay.js";

// M365 reports no token counts, so a client never sees its context fill and
// never compacts (Codex: docs/hypotheses.md §46). The proxy reports estimates
// instead: a quarter of the UTF-8 bytes, about right for English and code, and
// low for number-dense text (the §47 haystack ran 3.1 characters a token).

/** Estimated tokens in `text`. */
export function estimateTokens(text: string): number {
  return Math.ceil(utf8Bytes(text) / 4);
}

/** Whether `usage` carries estimated token counts: on unless M365_REPORT_USAGE=0. */
export function reportsUsage(): boolean {
  return process.env.M365_REPORT_USAGE?.trim() !== "0";
}
