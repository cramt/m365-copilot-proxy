import { JwtClaims } from "./schemas.js";
import type { MeteredBudget } from "./priority-access.js";

// Model name → tone mapping.
// The server VALIDATES tones (an unknown tone errors with "Failed to invoke
// 'Chat'"), so every entry here has been confirmed accepted against the live
// API. Claude tones self-identify as Anthropic models (docs/hypotheses.md
// H8.6) — a genuine non-Microsoft model at zero marginal cost.
//
// A tone is not always one model: `Claude_Sonnet` serves Claude Sonnet 4.6 on
// the included scenario and Claude Sonnet 5.5 on the paid one (tone-probe
// 2026-10-06, docs §26; it was Sonnet 5 until then). The scenario therefore has
// to be derivable from the MODEL ID as well as the tone — see
// PAID_SCENARIO_MODELS below.
//
// Microsoft retired the `*_Quick` tones: `Gpt_Quick` and `Gpt_5_{2,3,4}_Quick`
// are now REJECTED by the validator, and the `*_Chat` tones replaced them
// (tone-probe 2026-09-28, 3/3 each — docs/hypotheses.md §19). The `quick` and
// `-quick` model IDs are kept as aliases, so existing client configs keep
// working; only the tones they resolve to changed. Do not map a `*_Quick` tone.
const MODEL_TONES: Record<string, string> = {
  // Default
  "m365-copilot": "magic",
  auto: "magic",

  // Generic modes. No unversioned tone survives: `Gpt_Quick`, `Gpt_Chat` and
  // `Gpt_Reasoning` are all REJECTED, so these pin to a versioned tone.
  // GPT-5.5 over GPT-5.6, deliberately (bench, confab-retry off, §19): 5.5
  // wins the chat half (16/30 vs 7/30) and the reasoning half is a tie (26/30
  // vs 27/30, p=1.0). Don't re-point them to 5.6 on the reasoning numbers.
  quick: "Gpt_5_5_Chat",
  "think-deeper": "Gpt_5_5_Reasoning",

  // Claude (real Anthropic models, confirmed via self-id) — chat + reasoning.
  // On the included scenario `Claude_Sonnet` is now Sonnet 4.6 (it was 4.5);
  // `claude-sonnet-4.5` stays as a legacy alias so existing configs keep working.
  claude: "Claude_Sonnet",
  "claude-sonnet": "Claude_Sonnet",
  "claude-sonnet-4.5": "Claude_Sonnet",
  "claude-sonnet-4.6": "Claude_Sonnet",
  // Same tone, paid scenario: Claude Sonnet 5.5 (self-IDs "Claude Sonnet 5.5",
  // knowledge cutoff 2026-01, since 2026-10-06). The scenario comes from
  // PAID_SCENARIO_MODELS. Metered, like Opus 5.5 (METERED_BUDGETS).
  "claude-sonnet-5.5": "Claude_Sonnet",
  // Sonnet 5 moved to a tone of its own when Sonnet 5.5 took over the paid
  // scenario of `Claude_Sonnet`: `Claude_Sonnet_5` is Sonnet 5 on the paid
  // scenario (self-IDs "Claude Sonnet 5", cutoff 2026-01) and Sonnet 4.6 on the
  // included one, so it's in PAID_SCENARIO_TONES. Not metered.
  "claude-sonnet-5": "Claude_Sonnet_5",
  "claude-sonnet-think-deeper": "Claude_Sonnet_Reasoning",
  // `Claude_Opus` is one tone and two models, like `Claude_Sonnet`, but the
  // other way round: the TONE is paid (PAID_SCENARIO_TONES) and one model ID
  // opts back into the included scenario (INCLUDED_SCENARIO_MODELS).
  //
  // Paid scenario: Claude Opus 5.5 (self-IDs "Claude Opus 5.5", knowledge
  // cutoff 2026-06, since at least 2026-10-01; it was Opus 5, cutoff 2026-05,
  // in September). Metered
  // by a small daily + weekly priority-access budget (priority-access.ts). On
  // the included scenario agent-less it deflects with a BotConnection apology —
  // what the old "dead tone" reading (F23) was measuring. `claude-opus-5` is a
  // legacy alias: it reaches the same (paid) model.
  "claude-opus": "Claude_Opus",
  "claude-opus-5": "Claude_Opus",
  "claude-opus-5.5": "Claude_Opus",
  // Included scenario, WITH the tool agent attached, on a premium account only:
  // Claude Opus 4.5, outside the priority-access budget. Its system prompt
  // tells it it is "Claude Opus 5" with a May 2026 cutoff, and its chain of
  // thought disputes that ("…that's not accurate to who I actually am"); it
  // self-IDs as Opus 4.5 most of the time. Agent-less it is the dead route on
  // every account, and with the agent it is dead on a non-premium one (docs §24).
  "claude-opus-4.5": "Claude_Opus",

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

  // GPT-6 Sol ("GPT 6.0 Sol" in the web client, which doesn't call it Think
  // Deeper — hence no `-think-deeper` suffix). Self-IDs as "GPT-6 reasoning
  // model". Unlike `Gpt_6_Reasoning` it is NOT entitlement-gated: it serves on
  // the included scenario on premium and non-premium accounts alike (#23,
  // tone-probe 2026-10-02, 4/4 + 2/2), so it stays out of PAID_SCENARIO_TONES.
  // What depends on the account is the tool agent — see
  // PREMIUM_ONLY_AGENT_TONES. `Gpt_6_Sol_Chat` is accepted too but self-IDs
  // as the GPT-5 chat model on both accounts, agent or not, so it isn't mapped.
  "gpt-6-sol": "Gpt_6_Sol_Reasoning",

  // GPT-6.1 Sol ("GPT-6.1 Sol" in the web client). Routed like GPT-6 Sol: the
  // included scenario, where it serves on premium and non-premium accounts
  // alike, and the tool agent only on a premium account (PREMIUM_ONLY_AGENT_TONES;
  // tone-probe + agent-tone-probe 2026-10-06, docs §27). The paid scenario
  // serves it too, but every paid turn spends the `GPT61Sol` priority-access
  // budget (40 a day, 75 a week); included turns don't, so it stays out of
  // PAID_SCENARIO_TONES. Self-IDs as "GPT-6 reasoning model" on both scenarios,
  // like GPT-6 Sol, but isn't GPT-6 Sol renamed: agent-less it keeps out of its
  // sandbox when told to and GPT-6 Sol doesn't (docs §29). The tone name has no
  // separator between 6 and 1, and every
  // sibling (`Gpt_61_Sol`, `Gpt_61_Sol_Chat`, `Gpt_61_Reasoning`, …) is rejected.
  "gpt-6.1-sol": "Gpt_61_Sol_Reasoning",

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
  // survives whatever version suffix a client decides to send. The scenario is
  // attached automatically (getScenarioForModel): paid (Opus 5.5) unless the
  // string names Opus 4.5 (`claude-opus-4-5-…`), which goes to the included one.
  // Likewise an unmapped Sonnet 5 string (`claude-sonnet-5[1m]`, a dated
  // `claude-sonnet-5-…`) goes to Sonnet 5's own tone; Sonnet 5.5 strings stay on
  // `Claude_Sonnet` and get the paid scenario from isSonnet55Model.
  if (/opus/i.test(model)) return "Claude_Opus";
  if (/^claude/i.test(model)) {
    return SONNET_5_PATTERN.test(model) && !SONNET_5_5_PATTERN.test(model) ? "Claude_Sonnet_5" : "Claude_Sonnet";
  }
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
 * metered", "needs lean framing" or "goes without the tool agent":
 * `Claude_Opus` happens to be both gated and drawing on a small priority-access
 * budget, but `Gpt_6_Reasoning` is gated and throttled exactly like every other
 * model, with no separate budget. The properties travelled together only while
 * Opus was the sole member, so nothing downstream should infer one from the
 * other — `defaultFramingForTone`, `parsePriorityAccessExhaustion` and
 * `toneUsesToolAgent` each decide for themselves.
 *
 * A model ID can opt out: `claude-opus-4.5` is the same tone on the included
 * scenario (INCLUDED_SCENARIO_MODELS), and isn't metered.
 *
 * `Claude_Sonnet_5` is here because its own model, Sonnet 5, only serves on the
 * paid scenario; on the included one the tone is Sonnet 4.6, which
 * `claude-sonnet` already reaches (tone-probe 2026-10-06, docs §26).
 */
export const PAID_SCENARIO_TONES: ReadonlySet<string> = new Set([
  "Claude_Opus",
  "Claude_Sonnet_5",
  "Gpt_6_Reasoning",
]);

/**
 * Model IDs that need the paid scenario even though their TONE does not.
 *
 * `Claude_Sonnet` is one tone and two models: Sonnet 4.6 on the included
 * scenario, Sonnet 5.5 on the paid one. PAID_SCENARIO_TONES can't express that
 * (it would drag `claude-sonnet` onto Sonnet 5.5 too), so the choice lives on
 * the model ID. Unmapped strings a client may send for the same model
 * (`claude-sonnet-5.5[1m]`, a dated `claude-sonnet-5-5-…`) are caught by
 * SONNET_5_5_PATTERN rather than silently served by Sonnet 4.6.
 */
export const PAID_SCENARIO_MODELS: ReadonlySet<string> = new Set([
  "claude-sonnet-5.5",
]);
// `sonnet-5.5`, `sonnet-5-5`, `sonnet5_5`, `sonnet 5.5`, and anything after it —
// but not a dated `sonnet-5-2026…` and not a hypothetical `sonnet-5.50`.
const SONNET_5_5_PATTERN = /sonnet[-_ ]?5[-_. ]5(?!\d)/i;
// `sonnet-5`, `sonnet5`, `sonnet_5`, `sonnet 5`, and anything after it — but
// not `sonnet-4.5` / `sonnet-4-5` (the digit after the separator is 4), not a
// hypothetical `sonnet-50`, and not a dotted minor version (`sonnet-5.1`), which
// is some other model. Matches `sonnet-5-5` too: test SONNET_5_5_PATTERN first.
const SONNET_5_PATTERN = /sonnet[-_ ]?5(?!\d|\.\d)/i;

/** True when this model ID is Claude Sonnet 5.5, i.e. `Claude_Sonnet` + paid scenario. */
export function isSonnet55Model(model: string): boolean {
  return PAID_SCENARIO_MODELS.has(model) ||
    (getToneForModel(model) === "Claude_Sonnet" && SONNET_5_5_PATTERN.test(model));
}

/** True when this model ID is Claude Sonnet 5, i.e. the `Claude_Sonnet_5` tone. */
export function isSonnet5Model(model: string): boolean {
  return getToneForModel(model) === "Claude_Sonnet_5";
}

/**
 * Model IDs that need the INCLUDED scenario even though their tone is in
 * PAID_SCENARIO_TONES — the mirror image of PAID_SCENARIO_MODELS.
 *
 * `Claude_Opus` is Opus 5.5 on the paid scenario and Opus 4.5 on the included
 * one. The included model serves only with the tool agent attached and only on
 * a premium account (agent-tone-probe, 2026-10-02/04, docs §24). Unmapped
 * strings a client may send for it (`claude-opus-4-5-20251101`,
 * `claude-opus-4.5[1m]`) are caught by OPUS_4_5_PATTERN rather than silently
 * served by Opus 5.5 — which would also spend the priority-access budget.
 */
export const INCLUDED_SCENARIO_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-4.5",
]);
// `opus-4.5`, `opus-4-5`, `opus4_5`, `opus 4.5`, and anything after it — but not
// `opus-4` / `opus-4-1` / `opus-4.6`, and not a hypothetical `opus-4.50`.
const OPUS_4_5_PATTERN = /opus[-_ ]?4[-_. ]5(?!\d)/i;

/** True when this model ID is Claude Opus 4.5, i.e. `Claude_Opus` + included scenario. */
export function isOpus45Model(model: string): boolean {
  return INCLUDED_SCENARIO_MODELS.has(model) ||
    (getToneForModel(model) === "Claude_Opus" && OPUS_4_5_PATTERN.test(model));
}

// --- Which tool requests carry the Copilot Studio tool agent ------------------
//
// The proxy attaches its declarative tool agent to tool requests, because the
// GPT chat path won't act without it. Some tones must NOT get it:
//
// - Claude tones tool-call reliably agent-less (F23), and a non-premium
//   account's agent path doesn't serve Claude at all — a dead route
//   (BotConnection, `result: InternalError`), hypotheses §22 F44. The
//   exception is `Claude_Opus` (AGENT_CLAUDE_TONES).
// - `Gpt_6_Reasoning` doesn't serve with the agent attached on any account:
//   the same dead route, 4/4 across a premium and a non-premium account, while
//   the same tone agent-less answers as GPT-6 (§22 F45, #41). Its bench score
//   (24/30, §17) was measured agent-less.
// - Tones in PREMIUM_ONLY_AGENT_TONES take the agent only on a premium
//   account; on a non-premium one it's the same dead route, learned at runtime.
//
// Listed by exact tone. Check a new tone with `scripts/agent-tone-probe.mjs`
// on BOTH kinds of account before deciding which side it belongs on.
export const AGENTLESS_TOOL_TONES: ReadonlySet<string> = new Set(["Gpt_6_Reasoning"]);

/**
 * Claude tones that DO take the tool agent; every other `Claude_*` tone goes
 * agent-less.
 *
 * - `Claude_Opus`: on the included scenario (`claude-opus-4.5`, Opus 4.5) the
 *   agent is the ONLY route — agent-less it is the BotConnection dead route on
 *   every account, with the agent it serves on a premium account (docs §24). On
 *   the paid scenario (`claude-opus`, Opus 5.5) it serves either way, and takes
 *   the agent so both Opus models run the same path and the same framing.
 *   There is no agent-less fallback to learn (it isn't in
 *   PREMIUM_ONLY_AGENT_TONES): a non-premium account can't reach either model
 *   at all — the paid scenario is unlicensed there (F46), and the included one
 *   is dead with and without the agent.
 *
 * Not the Sonnet tones (docs §30, benched on a premium account, where their
 * agent route serves). The agent takes every Sonnet out of its own sandbox,
 * but costs more than that's worth: Sonnet 5 (`Claude_Sonnet_5`, paid) reads
 * the agent's enterprise tools against the harness and refuses it (10/20 vs
 * 19/20 agent-less); Sonnet 4.6 (`Claude_Sonnet`, included) solves the same
 * but spends one more turn per real-pi run (4.4 vs 3.5), using pi's `edit`
 * where relay_batch merges fix and check into one shell call; Sonnet 5.5
 * (`Claude_Sonnet`, paid) gains nothing measurable either way.
 */
export const AGENT_CLAUDE_TONES: ReadonlySet<string> = new Set([
  "Claude_Opus",
]);

/**
 * Tones whose agent route serves only on a PREMIUM account (a paid Microsoft
 * 365 Copilot seat). On a non-premium account the agent-attached turn is a
 * dead route — BotConnection apology, final `result: InternalError`, no
 * content — while the same tone agent-less serves normally.
 *
 * - `Gpt_6_Sol_Reasoning`: agent attached, premium serves GPT-6 on both
 *   scenarios (4/4), non-premium is dead (2/2) (#23, agent-tone-probe
 *   2026-10-02).
 * - `Gpt_61_Sol_Reasoning`: the same split — agent attached, premium serves on
 *   both scenarios (8/8), non-premium is dead on both accounts (3/3)
 *   (agent-tone-probe 2026-10-06, docs §27).
 *
 * Nothing on the token says which kind of account this is, so the proxy finds
 * out by trying: the first tool request on such a tone carries the agent, and
 * an `InternalError` with no content marks the route dead for the rest of the
 * process (`noteAgentRouteDead`). The request is re-sent agent-less, so the
 * client never sees the failure. A non-premium account pays one ~3 s dead turn
 * per tone per process; `M365_FORCE_AGENT=0` skips even that.
 *
 * The premium account ALSO gets that exact wire state now and then, as a
 * one-off: same BotConnection apology, same `InternalError`, mid-conversation
 * after the agent had answered (1 in ~250 agent turns, 2026-10-02, §23). So one
 * answered agent turn settles it the other way (`noteAgentRouteAlive`): from
 * then on an `InternalError` is a transient, handled like on any other tone.
 */
export const PREMIUM_ONLY_AGENT_TONES: ReadonlySet<string> = new Set([
  "Gpt_6_Sol_Reasoning",
  "Gpt_61_Sol_Reasoning",
]);

// What this process has learned about the agent route, per tone. The proxy
// serves one account, so this is per-account knowledge; a restart re-learns it.
const deadAgentRoutes = new Set<string>();
const aliveAgentRoutes = new Set<string>();

/**
 * Record that this account's agent route doesn't serve `tone` (see
 * PREMIUM_ONLY_AGENT_TONES). Returns false, and records nothing, when the route
 * has already answered in this process: then the failure was a transient.
 */
export function noteAgentRouteDead(tone: string): boolean {
  if (aliveAgentRoutes.has(tone)) return false;
  deadAgentRoutes.add(tone);
  return true;
}

/** Record that this account's agent route answered for `tone`. */
export function noteAgentRouteAlive(tone: string): void {
  aliveAgentRoutes.add(tone);
}

/** Whether this process has seen the agent route answer for `tone`. */
export function isAgentRouteAlive(tone: string): boolean {
  return aliveAgentRoutes.has(tone);
}

/** Forget everything learned about agent routes. For tests. */
export function resetAgentRoutes(): void {
  deadAgentRoutes.clear();
  aliveAgentRoutes.clear();
}

/** Whether a tool request on this tone should carry the tool agent. */
export function toneUsesToolAgent(tone: string): boolean {
  if (AGENTLESS_TOOL_TONES.has(tone) || deadAgentRoutes.has(tone)) return false;
  if (/^Claude_/i.test(tone)) return AGENT_CLAUDE_TONES.has(tone);
  return true;
}

/**
 * The agent decision for one tool request, with the `M365_FORCE_AGENT`
 * override applied: `1` always attaches it, `0` never does, anything else
 * leaves it to toneUsesToolAgent.
 */
export function toolRequestUsesAgent(tone: string): boolean {
  const force = process.env.M365_FORCE_AGENT;
  if (force === "1") return true;
  if (force === "0") return false;
  return toneUsesToolAgent(tone);
}

/**
 * Model IDs that serve ONLY with the tool agent attached, so a request carries
 * it even without tools (the agent's instructions say to answer normally when
 * there's no <tools> block). Today that's Opus 4.5: agent-less, the included
 * scenario gives `Claude_Opus` the BotConnection dead route (docs §24).
 */
export function modelRequiresAgent(model: string): boolean {
  return isOpus45Model(model);
}

/**
 * The agent decision for one request of any kind. Tool requests follow
 * toolRequestUsesAgent; a tool-less request carries the agent only when the
 * model can't be served without it (`M365_FORCE_AGENT=0` still turns it off).
 */
export function requestUsesAgent(model: string, hasTools: boolean): boolean {
  if (hasTools) return toolRequestUsesAgent(getToneForModel(model));
  return modelRequiresAgent(model) && process.env.M365_FORCE_AGENT !== "0";
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
 * tell Sonnet 4.6 from Sonnet 5.5.
 */
export function getScenarioForTone(tone: string): ScenarioRouting {
  return routing(PAID_SCENARIO_TONES.has(tone));
}

/**
 * The scenario a MODEL ID must be requested under: paid when its tone is
 * entitlement-gated (Opus, Sonnet 5, GPT-6) or when the ID itself selects the
 * paid model behind a shared tone (Sonnet 5.5); included when the ID selects
 * the included model behind a paid tone (Opus 4.5). This is what session.ts
 * routes on.
 */
export function getScenarioForModel(model: string): ScenarioRouting {
  if (isOpus45Model(model)) return routing(false);
  return routing(PAID_SCENARIO_TONES.has(getToneForModel(model)) || isSonnet55Model(model));
}

/**
 * The priority-access budget this model's turns draw on, or null when it isn't
 * metered: Opus on the paid scenario (Opus 5.5) and `Claude_Sonnet` on the paid
 * scenario (Sonnet 5.5). Opus 4.5, Sonnet 4.6 and Sonnet 5 aren't metered.
 * Follows the scenario the request will really use, `M365_SCENARIO` included.
 */
export function meteredBudgetOf(model: string): MeteredBudget | null {
  if (getScenarioForModel(model).scenario !== PAID_SCENARIO) return null;
  const tone = getToneForModel(model);
  if (tone === "Claude_Opus") return "opus";
  if (tone === "Claude_Sonnet") return "sonnet-5.5";
  return null;
}

/** The env var naming each budget's fallback model. */
export const PRIORITY_ACCESS_FALLBACK_ENV: Readonly<Record<MeteredBudget, string>> = {
  opus: "M365_OPUS_FALLBACK_MODEL",
  "sonnet-5.5": "M365_SONNET_FALLBACK_MODEL",
};

/**
 * The model to serve a metered request with once its priority-access budget is
 * used up, instead of a 429: `M365_OPUS_FALLBACK_MODEL` for Opus 5.5 (typically
 * `claude-opus-4.5`), `M365_SONNET_FALLBACK_MODEL` for Sonnet 5.5 (typically
 * `claude-sonnet-5`). Opt-in, because it swaps the model: the response's
 * `model` field then names the one that answered. Ignored when it names a
 * metered model itself.
 */
export function priorityAccessFallbackModel(budget: MeteredBudget): string | null {
  const v = process.env[PRIORITY_ACCESS_FALLBACK_ENV[budget]]?.trim();
  if (!v || meteredBudgetOf(v)) return null;
  return v;
}

// Advertised catalog for this account; routing above remains compatible with
// explicit model IDs. Evidence: findings/models.md (2026-10-02).
const EXPOSED_MODELS: readonly string[] = [
  // Included GPT routes that responded; local tool support is not established.
  "m365-copilot",
  "auto",
  "quick",
  "think-deeper",
  "gpt-5.5",
  "gpt-5.5-quick",
  "gpt-5.5-think-deeper",
  "gpt-5.6",
  "gpt-5.6-quick",
  "gpt-5.6-think-deeper",
  "gpt-6-sol",
  "gpt-5.4",
  "gpt-5.4-think-deeper",
  "gpt-5.4-quick",
  "gpt-5.3",
  "gpt-5.3-quick",
  "gpt-5.3-think-deeper",
  "gpt-5.2",
  "gpt-5.2-quick",
  "gpt-5.2-think-deeper",

  // Included Claude reasoning responded; local tool support is unverified.
  "claude-sonnet-think-deeper",

  // Included Claude chat routes failed upstream on this account.
  // "claude",
  // "claude-sonnet",
  // "claude-sonnet-4.5",
  // "claude-sonnet-4.6",

  // Known paid routes; this account returned InvalidCopilotLicense.
  // "claude-sonnet-5",
  // "claude-opus",
  // "claude-opus-5",
  // "gpt-6-think-deeper",

  // Unverified version; resolves to the same paid route as Sonnet 5.
  // "claude-sonnet-5.5",
];

export function getAvailableModels(): string[] {
  return [...EXPOSED_MODELS];
}

export function decodeJwt(token: string) {
  const payload = token.split(".")[1];
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const raw: unknown = JSON.parse(Buffer.from(padded, "base64").toString());
  return JwtClaims.parse(raw);
}

export interface CapturedImage {
  referenceUrls: string[];
  fileToken?: string;
  pollUrl?: string;
  size?: string;
  orientation?: string;
  status?: number;
}

/**
 * The streaming result of one M365 Copilot turn. Implemented by
 * `CopilotSession.chat` (session.ts); async-iterate it for delta text and read
 * the getters for the turn's diagnostic metadata after it completes.
 */
export interface CopilotStream {
  [Symbol.asyncIterator](): AsyncIterator<string>;
  fullText: string;
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
  /** The final item's `throttling.metering` as `{budget: remainingAllowance}`
   *  (e.g. `ClaudeOpusQueryDaily`, `ClaudeOpusQuery75`), read after the turn.
   *  Paid-scenario turns only (docs §24 F55). */
  metering?: Record<string, number> | null;
  /** True if the model triggered a native custom action this turn (H-NATIVE-6). */
  sawAction?: boolean;
}
