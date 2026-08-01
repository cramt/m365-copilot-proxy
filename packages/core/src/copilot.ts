import { JwtClaims } from "./schemas.js";

// Model name → tone mapping.
// The server VALIDATES tones (an unknown tone errors with "Failed to invoke
// 'Chat'"), so every entry here has been confirmed accepted against the live
// API. Claude tones self-identify as "Claude Sonnet 4.5, by Anthropic"
// (docs/hypotheses.md H8.6) — a genuine non-Microsoft model at zero marginal cost.
const MODEL_TONES: Record<string, string> = {
  // Default
  "m365-copilot": "magic",
  "auto": "magic",

  // Generic modes
  "quick": "Gpt_Quick",
  "think-deeper": "Gpt_Reasoning",

  // Claude (real Anthropic models, confirmed via self-id) — chat + reasoning.
  "claude": "Claude_Sonnet",
  "claude-sonnet": "Claude_Sonnet",
  "claude-sonnet-4.5": "Claude_Sonnet",
  "claude-sonnet-think-deeper": "Claude_Sonnet_Reasoning",
  "claude-opus": "Claude_Opus", // accepted tone; identity deflected, likely Opus

  // GPT-5.5 (current generation)
  "gpt-5.5": "Gpt_5_5_Chat",
  "gpt-5.5-quick": "Gpt_5_5_Chat",
  "gpt-5.5-think-deeper": "Gpt_5_5_Reasoning",

  // GPT-5.4
  "gpt-5.4": "Gpt_5_4_Reasoning",
  "gpt-5.4-think-deeper": "Gpt_5_4_Reasoning",
  "gpt-5.4-quick": "Gpt_5_4_Quick",

  // GPT-5.3
  "gpt-5.3": "Gpt_5_3_Quick",
  "gpt-5.3-quick": "Gpt_5_3_Quick",
  "gpt-5.3-think-deeper": "Gpt_5_3_Reasoning",

  // GPT-5.2
  "gpt-5.2": "Gpt_5_2_Quick",
  "gpt-5.2-quick": "Gpt_5_2_Quick",
  "gpt-5.2-think-deeper": "Gpt_5_2_Reasoning",
};

export function getToneForModel(model: string): string {
  const exact = MODEL_TONES[model];
  if (exact) return exact;
  // Unmapped `claude-*` strings (e.g. the `claude-opus-4-8[1m]` a Claude Code client
  // sends) must NOT fall back to the `magic` (GPT) tone. Empirically (route-probe,
  // 2026-07-07) the magic path does not tool-call right now — 0/2, confabulates
  // "I don't have a shell" — while the Claude tone agent-less path tool-calls 2/2 and
  // fast (~5s). Route anything Claude-labelled to the working Claude_Sonnet tone
  // rather than silently serving GPT under a Claude name and landing in the
  // confabulation quadrant. (getAvailableModels still only advertises the exact keys.)
  if (/^claude/i.test(model)) return "Claude_Sonnet";
  return MODEL_TONES["m365-copilot"];
}

export function getAvailableModels(): string[] {
  return Object.keys(MODEL_TONES);
}

export function decodeJwt(token: string) {
  const payload = token.split(".")[1];
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const raw = JSON.parse(Buffer.from(padded, "base64").toString());
  return JwtClaims.parse(raw);
}

/**
 * The streaming result of one M365 Copilot turn. Implemented by
 * `CopilotSession.chat` (session.ts); async-iterate it for delta text and read
 * the getters for the turn's diagnostic metadata after it completes.
 */
/** One generated image, as carried on a GraphicArt frame (§14). URLs point at
 *  designerapp.officeapps.live.com and need the designerappservice token to
 *  fetch — see `fetchImageBytes` / `generateImage`. */
export interface CapturedImage {
  referenceUrls: string[];
  fileToken?: string;
  pollUrl?: string;
  size?: string;
  orientation?: string;
  /** Server status; 2 = ready (observed). */
  status?: number;
}

export interface CopilotStream {
  [Symbol.asyncIterator](): AsyncIterator<string>;
  fullText: string;
  /** Generated images captured this turn (empty unless image gen was requested
   *  and the server returned a GraphicArt frame). */
  images: CapturedImage[];
  /** True if the server returned content (deltas or full text) */
  hasContent: boolean;
  /** Throttle info if provided by M365 */
  throttle: { current: number; max: number } | null;
  /** `DeepLeo` (reasoning) / `3PDeclarativeAgent` (agent) / etc.  */
  contentOrigin?: string | null;
  /** Last seen messageType (e.g. `Disengaged`, `EndOfRequest`). Null when M365 sends an unmistakably content message. */
  messageType?: string | null;
  /** Server-assigned bot message id, useful for telemetry correlation. */
  messageId?: string | null;
  /** Per-message classifier scores from M365 (BotOffense / dea_violation).
   *  Highest values across the response. Drives the "how close to Disengaged are we" metric. */
  scores?: Record<string, number> | null;
  /** Authoritative server-side turn count for this conversation. */
  turnCount?: number | null;
  /** `Completed` etc. */
  turnState?: string | null;
  /** True if the model triggered a native custom action this turn (H-NATIVE-6). */
  sawAction?: boolean;
}
