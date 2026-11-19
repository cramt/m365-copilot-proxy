import { createLogger } from "./log.js";

const log = createLogger("backends");

// --- Which M365 surface a model runs on ---------------------------------------
//
// `chat` is Microsoft 365 Copilot Chat (Chathub or StreamHub, session.ts): what
// the proxy has always used. `cowork` and `code` are the web app's Cowork and
// Code tabs. Both run on the Copilot agent runtime (aether.ts), which reads a
// longer turn than Chat does (GPT-6.2 Sol answered about 806k tokens in one
// turn, Chat's GPT-6.x about 272k) and isn't under Chat's per-user throttle,
// but every turn is charged to the account's Copilot credits (docs/hypotheses.md
// §48).
//
// A model ID names its backend in parentheses, then the tokens one turn has been
// seen to carry and whether turns cost credits: `gpt-6.2-sol(chat)_272k`,
// `gpt-6.2-sol(cowork)_800k_credit`. Only the parentheses route; the rest is
// information, so a client may send `gpt-6.2-sol(cowork)` or an ID with stale
// suffixes. An ID without parentheses is a Chat model, as before, unless
// M365_DEFAULT_BACKEND moves it.

export type Backend = "chat" | "cowork" | "code";
export const BACKENDS: readonly Backend[] = ["chat", "cowork", "code"];

function isBackend(name: string): name is Backend {
  return (BACKENDS as readonly string[]).includes(name);
}

/**
 * The backends whose models `/v1/models` lists (M365_BACKENDS, a comma list;
 * default all three). A request may name `cowork` or `code` only when it's
 * listed: `M365_BACKENDS=chat` keeps a proxy off the credit-charged runtime.
 * Chat requests are always served, and an ID without a backend stays on Chat,
 * so a client spends credits only by naming a `(cowork)` or `(code)` model.
 */
export function enabledBackends(): Backend[] {
  const raw = process.env.M365_BACKENDS?.trim();
  if (!raw) return [...BACKENDS];
  const out: Backend[] = [];
  for (const name of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!isBackend(name)) {
      log.info(`M365_BACKENDS: unknown backend "${name}" ignored (known: ${BACKENDS.join(", ")})`);
      continue;
    }
    if (!out.includes(name)) out.push(name);
  }
  return out.length > 0 ? out : ["chat"];
}

/**
 * Where a model ID without a `(backend)` goes (M365_DEFAULT_BACKEND, default
 * `chat`), when that backend is enabled and serves the model; anything else
 * stays on Chat.
 */
export function defaultBackend(): Backend {
  const name = process.env.M365_DEFAULT_BACKEND?.trim().toLowerCase();
  if (!name || name === "chat") return "chat";
  if (!isBackend(name)) {
    log.info(`M365_DEFAULT_BACKEND: unknown backend "${name}" ignored`);
    return "chat";
  }
  if (!enabledBackends().includes(name)) {
    log.info(`M365_DEFAULT_BACKEND=${name} isn't in M365_BACKENDS; model IDs without a backend stay on chat`);
    return "chat";
  }
  return name;
}

/** One model on one backend, as `/v1/models` lists it. */
export interface ModelEntry {
  /** The proxy's model ID, without suffixes: a Chat model ID, or the Chat name of an agent-runtime model. */
  base: string;
  backend: Backend;
  /** Tokens (o200k) one turn has been seen to carry; absent when not measured. */
  window?: number;
  /** Turns are charged to the account's Copilot credits. */
  credits: boolean;
  /** The agent runtime's ID for the model (`cowork` and `code`). */
  runtimeModel?: string;
}

// Chat models, one per model rather than per alias. Windows from docs/
// hypotheses.md §47: GPT-6.x answered ~252k tokens in one turn and refused
// ~291k (its standard 272k window); GPT-6 Think Deeper 81k and not 97k; the
// Claude models 2M characters (~645k tokens, Sonnet 5 refused 2.6M; Sonnet 5.5
// and Fable refused ~806k tokens). Opus 5.5 and Sonnet 4.6 weren't measured and
// take their family's number; GPT-5.x has none. "Uses credits" is the web
// picker's mark, and StreamHub bills those turns (§45 F122).
const CHAT_MODELS: ReadonlyArray<{ base: string; window?: number; credits?: boolean }> = [
  { base: "gpt-6.2-sol", window: 272_000 },
  { base: "gpt-6.2-astra", window: 272_000, credits: true },
  { base: "gpt-6.1-sol", window: 272_000 },
  { base: "gpt-6-sol", window: 272_000 },
  { base: "gpt-6-astra", window: 272_000, credits: true },
  { base: "gpt-6-think-deeper", window: 80_000 },
  { base: "gpt-5.6-think-deeper" },
  { base: "gpt-5.6" },
  { base: "gpt-5.5-think-deeper" },
  { base: "gpt-5.5" },
  { base: "claude-opus-5.5", window: 640_000 },
  { base: "claude-opus-4.8", window: 640_000 },
  { base: "claude-sonnet-5.5", window: 640_000 },
  { base: "claude-sonnet-5", window: 640_000 },
  { base: "claude-sonnet-4.6", window: 640_000 },
  { base: "claude-fable", window: 640_000, credits: true },
  { base: "m365-copilot" },
];

// The agent runtime's models (`GET /v1/models`, the same list for Cowork and
// Code), under the Chat names of the same models. Windows measured on Cowork,
// one needle turn each (§48): every GPT model answered 2.0M characters (~806k
// tokens), the most tried; Opus 5.5 and Sonnet 5.5 answered 1.6M (~645k), and
// Sonnet 5.5 refused 2.0M. The Fast variants serve the same models faster and
// take their numbers, unmeasured. Code is taken to be the same: it's the same
// runtime, and its GPT-6.2 Sol answered ~363k tokens.
const RUNTIME_MODELS: ReadonlyArray<{ base: string; runtimeModel: string; window?: number }> = [
  { base: "gpt-6.2-sol", runtimeModel: "gpt-6.2-sol", window: 800_000 },
  { base: "gpt-6.2-sol-fast", runtimeModel: "gpt-6.2-sol-fast", window: 800_000 },
  { base: "gpt-6.2-astra", runtimeModel: "gpt-6.2-astra", window: 800_000 },
  { base: "gpt-6.1-sol", runtimeModel: "gpt-6.1-sol-substrate", window: 800_000 },
  { base: "gpt-5.5", runtimeModel: "gpt-5.5", window: 800_000 },
  { base: "claude-opus-5.5", runtimeModel: "opus-5.5", window: 640_000 },
  { base: "claude-opus-5.5-fast", runtimeModel: "opus-5.5-fast", window: 640_000 },
  { base: "claude-sonnet-5.5", runtimeModel: "sonnet-5.5", window: 640_000 },
];

/** The agent runtime's entry for a model, by its Chat name or its runtime ID. */
function runtimeEntry(model: string): (typeof RUNTIME_MODELS)[number] | undefined {
  const id = model.trim().toLowerCase();
  return RUNTIME_MODELS.find((m) => m.base === id || m.runtimeModel === id);
}

/** The agent runtime's ID for a model: its table entry's, or the ID itself for one the table doesn't know. */
export function runtimeModelFor(model: string): string {
  return runtimeEntry(model)?.runtimeModel ?? model.trim();
}

/** `272k`, `640k`, `1m`. */
export function formatWindow(tokens: number): string {
  return tokens >= 1_000_000 && tokens % 1_000_000 === 0 ? `${tokens / 1_000_000}m` : `${Math.round(tokens / 1000)}k`;
}

/** The ID `/v1/models` lists for an entry: `<base>(<backend>)[_<window>][_credit]`. */
export function formatModelId(entry: ModelEntry): string {
  const window = entry.window ? `_${formatWindow(entry.window)}` : "";
  return `${entry.base}(${entry.backend})${window}${entry.credits ? "_credit" : ""}`;
}

/**
 * Every model on the given backends (default: the enabled ones), in listing
 * order. With the runtime's live catalog (aether.ts `runtimeCatalog`), Cowork
 * and Code list only what it has now, and a model the table doesn't know under
 * its runtime ID, without a window; without one, the whole table.
 */
export function listModelEntries(backends: readonly Backend[] = enabledBackends(), catalog?: readonly string[] | null): ModelEntry[] {
  const runtime = catalog
    ? [
        ...RUNTIME_MODELS.filter((m) => catalog.includes(m.runtimeModel)),
        ...catalog.filter((id) => !RUNTIME_MODELS.some((m) => m.runtimeModel === id)).map((id) => ({ base: id, runtimeModel: id, window: undefined })),
      ]
    : RUNTIME_MODELS;
  const out: ModelEntry[] = [];
  for (const backend of backends) {
    if (backend === "chat") {
      for (const m of CHAT_MODELS) out.push({ base: m.base, backend, window: m.window, credits: !!m.credits });
    } else {
      for (const m of runtime) out.push({ base: m.base, backend, window: m.window, credits: true, runtimeModel: m.runtimeModel });
    }
  }
  return out;
}

/** What a requested model ID resolves to. */
export interface ModelRoute {
  /** The ID the request named; responses echo it. */
  requested: string;
  backend: Backend;
  /**
   * The model behind the suffixes. On Chat, a model ID as getToneForModel and
   * the rest of the Chat routing take it; on the agent runtime, the model's
   * Chat name when the table knows it (framing defaults key on it), else the ID
   * as sent.
   */
  model: string;
  /** The agent runtime's model ID (`cowork` and `code`). */
  runtimeModel?: string;
  /** Set when the request can't be served: the backend isn't enabled. */
  error?: string;
}

// `<base>(<backend>)` and any `_<tag>` suffixes after it.
const SUFFIXED_ID = /^(.+?)\((chat|cowork|code)\)((?:_[a-z0-9.]+)*)$/i;

/** Route a requested model ID to its backend (see the notes at the top of this file). */
export function resolveModelRoute(requested: string): ModelRoute {
  const id = requested.trim();
  const m = SUFFIXED_ID.exec(id);
  if (!m) {
    const fallback = defaultBackend();
    if (fallback !== "chat" && runtimeEntry(id)) return runtimeRoute(requested, fallback, id);
    return { requested, backend: "chat", model: id };
  }
  const backend = m[2].toLowerCase() as Backend;
  const base = m[1].trim();
  if (backend === "chat") return { requested, backend, model: base };
  if (!enabledBackends().includes(backend)) {
    return {
      requested,
      backend,
      model: base,
      error: `The ${backend} backend isn't enabled, so ${requested} can't be served: its turns spend Copilot credits. Add it to M365_BACKENDS (now "${enabledBackends().join(",")}").`,
    };
  }
  return runtimeRoute(requested, backend, base);
}

function runtimeRoute(requested: string, backend: Backend, base: string): ModelRoute {
  const entry = runtimeEntry(base);
  return { requested, backend, model: entry?.base ?? base, runtimeModel: entry?.runtimeModel ?? base };
}
