import { JwtClaims } from "./schemas.js";

// Model name → tone mapping.
// The server VALIDATES tones (an unknown tone errors with "Failed to invoke
// 'Chat'"), so every entry here has been confirmed accepted against the live
// API. Claude tones self-identify as Anthropic models (docs/hypotheses.md
// H8.6) — a genuine non-Microsoft model at zero marginal cost.
//
// A tone is not always one model: `Claude_Sonnet` serves Claude Sonnet 4.6 on
// the included scenario and Claude Sonnet 5 on the paid one (tone-probe
// 2026-09-28, docs §21). The scenario therefore has to be derivable from the
// MODEL ID as well as the tone — see PAID_SCENARIO_MODELS below.
//
// Microsoft retired the `*_Quick` tones: `Gpt_Quick` and `Gpt_5_{2,3,4}_Quick`
// are now REJECTED by the validator, and the `*_Chat` tones replaced them
// (tone-probe 2026-09-28, 3/3 each — docs/hypotheses.md §19). The `quick` and
// `-quick` model IDs are kept as aliases, so existing client configs keep
// working; only the tones they resolve to changed. Do not map a `*_Quick` tone.
const MODEL_TONES: Record<string, string> = {
  // Default
  "m365-copilot": "magic",
  "auto": "magic",

  // Generic modes. No unversioned tone survives: `Gpt_Quick`, `Gpt_Chat` and
  // `Gpt_Reasoning` are all REJECTED, so these pin to a versioned tone.
  // GPT-5.5 over GPT-5.6, deliberately (bench, confab-retry off, §19): 5.5
  // wins the chat half (16/30 vs 7/30) and the reasoning half is a tie (26/30
  // vs 27/30, p=1.0). Don't re-point them to 5.6 on the reasoning numbers.
  "quick": "Gpt_5_5_Chat",
  "think-deeper": "Gpt_5_5_Reasoning",

  // Claude (real Anthropic models, confirmed via self-id) — chat + reasoning.
  // On the included scenario `Claude_Sonnet` is now Sonnet 4.6 (it was 4.5);
  // `claude-sonnet-4.5` stays as a legacy alias so existing configs keep working.
  "claude": "Claude_Sonnet",
  "claude-sonnet": "Claude_Sonnet",
  "claude-sonnet-4.5": "Claude_Sonnet",
  "claude-sonnet-4.6": "Claude_Sonnet",
  // Same tone, paid scenario: Claude Sonnet 5 (self-IDs "Claude Sonnet 5",
  // knowledge cutoff 2026-01). The scenario comes from PAID_SCENARIO_MODELS.
  "claude-sonnet-5": "Claude_Sonnet",
  "claude-sonnet-think-deeper": "Claude_Sonnet_Reasoning",
  // Opus is real and strong, but it is NOT reachable on the default
  // `OfficeWebIncludedCopilot` scenario — there it deflects with a
  // BotConnection apology, which is what the old "dead tone" reading (F23) was
  // measuring. Requesting `scenario=OfficeWebPaidCopilot` on the WS query makes
  // it serve; see PAID_SCENARIO_TONES below and docs §5.
  // The model behind this tone is currently Claude Opus 5 (knowledge cutoff May
  // 2026)
  "claude-opus": "Claude_Opus",
  "claude-opus-5": "Claude_Opus",

  // GPT-5.5 (current generation)
  "gpt-5.5": "Gpt_5_5_Chat",
  "gpt-5.5-quick": "Gpt_5_5_Chat",
  "gpt-5.5-think-deeper": "Gpt_5_5_Reasoning",

  // GPT-5.6. Both variants are live and serve on the DEFAULT included scenario,
  // so neither belongs in PAID_SCENARIO_TONES.
  //
  // `Gpt_5_6_Chat` took the long way here and is worth a note, because it
  // repeated F23's "Opus is a dead tone" mistake: §12.15 recorded it as
  // "registered but dead" (BotConnection apology, never DeepLeo) and that
  // measurement only ever ran on the included scenario. It served normally
  // under `OfficeWebPaidCopilot` the whole time — it was entitlement-gated like
  // Opus, not dead. As of 2026-09-24 it returns DeepLeo on the included
  // scenario too, so the gate is gone and no scenario override is needed.
  //
  // It is a chat tone, not a reasoning one: it self-IDs as "the GPT-5 chat
  // model", exactly as `Gpt_5_5_Chat` does, and the web client labels it
  // "GPT 5.6 Quick response" — hence the `-quick` alias, matching GPT-5.5.
  // It is markedly WORSE at agentic work than `Gpt_5_5_Chat` (7/30 vs 16/30
  // on the bench with the confab-retry off, and 22 of its 23 failures give up
  // before a single tool call — §19), so it is advertised but must not become
  // anyone's default — see README and §18.
  "gpt-5.6": "Gpt_5_6_Chat",
  "gpt-5.6-quick": "Gpt_5_6_Chat",
  "gpt-5.6-think-deeper": "Gpt_5_6_Reasoning",

  // GPT-6. Reasoning only: `Gpt_6_Chat` is REJECTED by the tone validator — it
  // errors outright, rather than deflecting via BotConnection the way
  // `Gpt_5_6_Chat` did before its gate lifted (§12.15/§18 — those two states
  // are not the same thing, and only one of them can come good later), so
  // there is no chat variant to map. Like `Claude_Opus`, this tone is
  // entitlement-gated and only serves under the paid scenario; unlike Opus it
  // is NOT separately metered (see PAID_SCENARIO_TONES below and docs §5).
  "gpt-6-think-deeper": "Gpt_6_Reasoning",

  // GPT-5.4. Bare `gpt-5.4` has always been the reasoning tone (unlike its
  // siblings); only the `-quick` alias moved, from the retired `Gpt_5_4_Quick`.
  "gpt-5.4": "Gpt_5_4_Reasoning",
  "gpt-5.4-think-deeper": "Gpt_5_4_Reasoning",
  "gpt-5.4-quick": "Gpt_5_4_Chat",

  // GPT-5.3 (was `Gpt_5_3_Quick`, now retired)
  "gpt-5.3": "Gpt_5_3_Chat",
  "gpt-5.3-quick": "Gpt_5_3_Chat",
  "gpt-5.3-think-deeper": "Gpt_5_3_Reasoning",

  // GPT-5.2 (was `Gpt_5_2_Quick`, now retired)
  "gpt-5.2": "Gpt_5_2_Chat",
  "gpt-5.2-quick": "Gpt_5_2_Chat",
  "gpt-5.2-think-deeper": "Gpt_5_2_Reasoning",
};

export function getToneForModel(model: string): string {
  const exact = MODEL_TONES[model];
  if (exact) return exact;
  // Unmapped `claude-*` strings (e.g. the `claude-opus-5[1m]` a Claude Code client
  // sends) must NOT fall back to the `magic` (GPT) tone. Empirically (route-probe,
  // 2026-07-07) the magic path does not tool-call right now — 0/2, confabulates
  // "I don't have a shell" — while the Claude tone agent-less path tool-calls 2/2 and
  // fast (~5s). Route anything Claude-labelled to the working Claude_Sonnet tone
  // rather than silently serving GPT under a Claude name and landing in the
  // confabulation quadrant. (getAvailableModels still only advertises the exact keys.)
  // …except an unmapped Opus string (`claude-opus-5[1m]`, and any dated or
  // context-suffixed Opus 5 variant), which now has a working route of its own
  // rather than being downgraded to Sonnet. The match is on `opus` alone, so it
  // survives whatever version suffix a client decides to send. The paid scenario
  // is attached automatically (getScenarioForTone).
  if (/opus/i.test(model)) return "Claude_Opus";
  if (/^claude/i.test(model)) return "Claude_Sonnet";
  return MODEL_TONES["m365-copilot"];
}

// --- Scenario / licenseType routing -----------------------------------------
//
// The WS query string carries a `scenario` and a `licenseType`. We hardcoded
// `OfficeWebIncludedCopilot` + `Starter` (what a seat-included Copilot web
// client sends) for every turn. That silently caps which models the backend
// will serve: `Claude_Opus` and `Gpt_6_Reasoning` are accepted as tones but
// never reach a model on the included scenario — they return M365's canned
// BotConnection apology, the "registered but dead" third state from §12.15.
//
// `scenario=OfficeWebPaidCopilot` is what unlocks them. `licenseType=Premium` is
// the value the paid scenario travels with, NOT a lever in its own right:
// flipping licenseType alone on the included scenario changes nothing (it does
// not grant access to different models). We send the pair for coherence with
// the real client and because the scenario is the load-bearing half.
//
// This is an entitlement, not a bypass: the account must actually hold paid /
// premium Copilot access. On a seat that doesn't, the paid scenario simply
// doesn't yield those models.
const DEFAULT_SCENARIO = "OfficeWebIncludedCopilot";
const DEFAULT_LICENSE_TYPE = "Starter";
const PAID_SCENARIO = "OfficeWebPaidCopilot";
const PAID_LICENSE_TYPE = "Premium";

/**
 * Tones that only serve under the paid scenario.
 *
 * Membership means ENTITLEMENT and nothing else. It is not a proxy for "is
 * metered" or "needs lean framing": `Claude_Opus` happens to be both gated and
 * drawing on a small priority-access budget, but `Gpt_6_Reasoning` is gated and
 * throttled exactly like every other model, with no separate budget. The two
 * properties travelled together only while Opus was the sole member, so nothing
 * downstream should infer one from the other — `defaultFramingForTone` and
 * `parsePriorityAccessExhaustion` each decide for themselves.
 */
export const PAID_SCENARIO_TONES: ReadonlySet<string> = new Set([
  "Claude_Opus",
  "Gpt_6_Reasoning",
]);

/**
 * Model IDs that need the paid scenario even though their TONE does not.
 *
 * `Claude_Sonnet` is one tone and two models: Sonnet 4.6 on the included
 * scenario, Sonnet 5 on the paid one. PAID_SCENARIO_TONES can't express that
 * (it would drag `claude-sonnet` onto Sonnet 5 too), so the choice lives on
 * the model ID. Unmapped strings a client may send for the same model
 * (`claude-sonnet-5[1m]`, a dated `claude-sonnet-5-…`) are caught by
 * SONNET_5_PATTERN rather than silently served by Sonnet 4.6.
 */
export const PAID_SCENARIO_MODELS: ReadonlySet<string> = new Set([
  "claude-sonnet-5",
]);
// `sonnet-5`, `sonnet5`, `sonnet_5`, `sonnet 5`, and anything after it — but
// not `sonnet-4.5` / `sonnet-4-5` (the digit after the separator is 4) and not
// a hypothetical `sonnet-50`.
const SONNET_5_PATTERN = /sonnet[-_ ]?5(?!\d)/i;

/** True when this model ID is Claude Sonnet 5, i.e. `Claude_Sonnet` + paid scenario. */
export function isSonnet5Model(model: string): boolean {
  return PAID_SCENARIO_MODELS.has(model) ||
    (getToneForModel(model) === "Claude_Sonnet" && SONNET_5_PATTERN.test(model));
}

export interface ScenarioRouting {
  scenario: string;
  licenseType: string;
}

function routing(paid: boolean): ScenarioRouting {
  return {
    scenario: process.env.M365_SCENARIO ?? (paid ? PAID_SCENARIO : DEFAULT_SCENARIO),
    licenseType: process.env.M365_LICENSE_TYPE ?? (paid ? PAID_LICENSE_TYPE : DEFAULT_LICENSE_TYPE),
  };
}

/**
 * The `scenario`/`licenseType` pair a given tone must be requested under.
 * Env overrides (`M365_SCENARIO` / `M365_LICENSE_TYPE`) win, so a tenant whose
 * entitlement is named differently can still be driven without a code change.
 * Prefer getScenarioForModel when a model ID is at hand: a tone alone can't
 * tell Sonnet 4.6 from Sonnet 5.
 */
export function getScenarioForTone(tone: string): ScenarioRouting {
  return routing(PAID_SCENARIO_TONES.has(tone));
}

/**
 * The scenario a MODEL ID must be requested under: paid when its tone is
 * entitlement-gated (Opus, GPT-6) or when the ID itself selects the paid
 * model behind a shared tone (Sonnet 5). This is what session.ts routes on.
 */
export function getScenarioForModel(model: string): ScenarioRouting {
  return routing(PAID_SCENARIO_TONES.has(getToneForModel(model)) || isSonnet5Model(model));
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
  /** The final item's `result`: `{value:"Success"}`, or `{value:"Throttled",
   *  errorCode:"PerUserThrottled", message}` when the account is rate-limited. */
  result?: { value: string; errorCode?: string; message?: string } | null;
  /** True if the model triggered a native custom action this turn (H-NATIVE-6). */
  sawAction?: boolean;
}
