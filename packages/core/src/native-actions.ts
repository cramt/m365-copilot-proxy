// Native custom-action support over the substrate WebSocket (docs/hypotheses.md
// §12.6, H-NATIVE-6). The M365 web client, when an agent decides to call a custom
// action/plugin, receives a server frame that is a confirmation TRIGGER (an adaptive
// card asking "allow this action?"), and replies on the SAME socket with a
// `ResumeInvokeAction` message echoing the invocation. The *server-side* orchestrator
// then makes the real outbound HTTPS call to the action endpoint and streams the
// result back. So the proxy can drive a native action end-to-end over the WS it
// already speaks — it just has to (a) NOT drop the confirmation frame, and (b) send
// the resume reply. These helpers are pure so the round-trip logic is unit-testable
// without a live socket; session.ts wraps buildResumeInvokeAction's message in the
// type-4 chat envelope.
//
// Field names below are from the decompiled client (bundle m365chat-llm-web-ui,
// `onResumeMessage`): the trigger carries `actionId`, `sourceRequestId`,
// `isConsequential`, `adaptiveCards[]` whose Action.Submit `data.message` holds
// `{actionId, confirmationOption}`; the reply is
// `{text, messageType:"ResumeInvokeAction", sourceRequestId, actionId, author,
//   invokeActionMessages:[<trigger msg>]}`.

/**
 * Instruction prompt for the native-action path. Unlike the fenced/shell contract,
 * native actions ARE the tool protocol — the model just calls them and the
 * orchestrator executes them for real. So the prompt is short and anti-fabrication:
 * the only failure mode we fight here is the model guessing a value instead of
 * actually calling the action (M365's chat-RLHF loves to "helpfully" make one up).
 * `{{ACTIONS}}` is replaced with a one-line-per-action list by buildNativeActionPrompt.
 */
export const NATIVE_ACTION_INSTRUCTIONS = `You are an automated agent with real, executable actions. When a request needs one, CALL the action — the runtime runs it against a live system and returns the real result. Rules:
- Never invent, guess, or approximate a value that an action returns. If an action can get it, call the action and report EXACTLY what it returns.
- Do not describe what you "would" do or ask the user to run anything. Call the action.
- After an action returns, answer using its real result — no preamble, no sign-off.

Available actions:
{{ACTIONS}}`;

/** Fill NATIVE_ACTION_INSTRUCTIONS with a concrete action list. */
export function buildNativeActionPrompt(
  actions: Array<{ name: string; description?: string }>,
): string {
  const list = actions
    .map((a) => `- ${a.name}${a.description ? ` — ${a.description}` : ""}`)
    .join("\n");
  return NATIVE_ACTION_INSTRUCTIONS.replace("{{ACTIONS}}", list || "- (none)");
}

/** messageType values that mean "the model wants to run an action; confirm to proceed". */
export const ACTION_CONFIRM_MESSAGE_TYPES = new Set([
  "ConfirmationCard",
  "TriggerConfirmation",
  "RenderCardRequest",
]);

/** Server→client message types tied to native action / plugin / extension flows.
 *  Added to the request's allowedMessageTypes so the server actually SENDS them
 *  (otherwise the whole action vocabulary is filtered out server-side). */
export const ACTION_ALLOWED_MESSAGE_TYPES = [
  "TriggerConfirmation",
  "TriggerPlugin",
  "TriggerUserInputRequest",
  "TriggerExtension",
  "CompleteExtension",
  "TriggerPluginAuth",
  "HintInvocation",
];

interface AdaptiveCardAction {
  type?: string;
  title?: string;
  data?: { message?: { actionId?: string; confirmationOption?: string }; [k: string]: unknown };
  [k: string]: unknown;
}

interface AdaptiveCard {
  actions?: AdaptiveCardAction[];
  body?: Array<{ actions?: AdaptiveCardAction[]; [k: string]: unknown }>;
  [k: string]: unknown;
}

/** A bot message that may be an action confirmation trigger. */
export interface MaybeTriggerMessage {
  messageType?: string;
  layout?: string;
  copilotMessageType?: string;
  actionId?: string;
  sourceRequestId?: string;
  requestId?: string;
  messageId?: string;
  isConsequential?: boolean;
  confirmationMetadata?: unknown;
  adaptiveCards?: AdaptiveCard[];
  [k: string]: unknown;
}

export interface ActionConfirmation {
  actionId: string;
  sourceRequestId: string;
  /** true when the action mutates state and the real UI would demand a click. */
  isConsequential: boolean;
  /** The affirmative option string from the card's confirm button, if any. */
  confirmationOption?: string;
  /** The affirmative button's title (e.g. "Allow") — becomes the resume `text`. */
  confirmationTitle?: string;
  /** The original trigger message, echoed back in invokeActionMessages. */
  triggerMessage: MaybeTriggerMessage;
}

function collectActions(cards: AdaptiveCard[] | undefined): AdaptiveCardAction[] {
  const out: AdaptiveCardAction[] = [];
  for (const c of cards ?? []) {
    for (const a of c.actions ?? []) out.push(a);
    for (const b of c.body ?? []) for (const a of b.actions ?? []) out.push(a);
  }
  return out;
}

const NEGATIVE = /cancel|decline|deny|reject|no\b|dismiss|not now/i;
const AFFIRMATIVE = /allow|confirm|continue|proceed|yes|approve|run|send|ok/i;

/** Pick the affirmative Action.Submit — its `data.message` (actionId + confirmationOption)
 *  AND its title. The decompiled client (bundle 5267fa4dfe8a `_`/`v`/`y`) uses the title
 *  as the resume message's `text`, matching the button by actionId+confirmationOption. */
function pickAffirmative(
  actions: AdaptiveCardAction[],
): { message: { actionId?: string; confirmationOption?: string }; title?: string } | null {
  const submits = actions.filter((a) => (a.type ?? "").includes("Submit") && a.data?.message);
  if (!submits.length) return null;
  // Prefer an explicit affirmative title; else the first non-negative; else the first.
  const affirmative = submits.find(
    (a) => AFFIRMATIVE.test(a.title ?? "") && !NEGATIVE.test(a.title ?? ""),
  );
  const nonNegative = submits.find((a) => !NEGATIVE.test(a.title ?? ""));
  const chosen = affirmative ?? nonNegative ?? submits[0];
  return { message: chosen.data!.message ?? {}, title: chosen.title };
}

/**
 * Detect an action confirmation trigger in a bot message and extract what's needed
 * to resume it. Returns null for ordinary messages. Conservative: requires either an
 * action-confirm messageType/layout or an adaptive card carrying an actionId.
 */
export function parseActionConfirmation(
  m: MaybeTriggerMessage | null | undefined,
): ActionConfirmation | null {
  if (!m || typeof m !== "object") return null;
  const isConfirmType =
    (m.messageType && ACTION_CONFIRM_MESSAGE_TYPES.has(m.messageType)) ||
    m.layout === "confirmation_trigger" ||
    (m.copilotMessageType === "adaptiveCard" && !!m.confirmationMetadata);

  const picked = pickAffirmative(collectActions(m.adaptiveCards));
  const actionId = m.actionId ?? picked?.message.actionId;
  // Need something that looks like an action to act on.
  if (!isConfirmType && !(actionId && m.adaptiveCards?.length)) return null;
  if (!actionId) return null;

  const sourceRequestId = m.sourceRequestId ?? m.requestId ?? m.messageId ?? "";
  return {
    actionId,
    sourceRequestId,
    isConsequential: m.isConsequential ?? true,
    confirmationOption: picked?.message.confirmationOption,
    confirmationTitle: picked?.title,
    triggerMessage: m,
  };
}

export interface ResumeInvokeOptions {
  author?: string;
  text?: string;
}

/**
 * Build the `ResumeInvokeAction` message the client sends to approve the action.
 * session.ts wraps this in the type-4 `chat` invocation envelope (same shape as a
 * normal turn, with this object as `message`).
 */
export function buildResumeInvokeAction(
  conf: ActionConfirmation,
  opts: ResumeInvokeOptions = {},
): Record<string, unknown> {
  // Exact shape of the decompiled client's `y()` (bundle 5267fa4dfe8a:28195): the
  // `text` is the affirmative button's TITLE (fallbacks: confirmationOption string,
  // then "confirmation response"), and confirmationOption is NOT a top-level field —
  // it's only used to locate that title. Getting this wrong is how a resume no-ops.
  return {
    text: opts.text ?? conf.confirmationTitle ?? conf.confirmationOption ?? "confirmation response",
    messageType: "ResumeInvokeAction",
    sourceRequestId: conf.sourceRequestId,
    actionId: conf.actionId,
    author: opts.author ?? "user",
    invokeActionMessages: [conf.triggerMessage],
  };
}

/**
 * Whether to auto-approve this action without a human click. Non-consequential
 * (read-only) actions are auto-approved by the real client after first consent; we
 * auto-approve those, and gate consequential ones behind M365_AUTO_CONFIRM_ACTIONS
 * so a mutating action never fires unattended unless explicitly opted in.
 */
export function shouldAutoConfirm(
  conf: ActionConfirmation,
  env: { autoConfirmAll?: boolean } = {},
): boolean {
  if (env.autoConfirmAll) return true;
  return !conf.isConsequential;
}
