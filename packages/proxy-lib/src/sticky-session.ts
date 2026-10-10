// Sticky sessions: keep a client on one M365 conversation across compaction and model switches.
// Framework-free: no node:* imports, env is read through globalThis.process.

export type StickySessionMode = "off" | "model" | "all";

const OFF_VALUES = new Set(["off", "0", "false", "no"]);

/** Unset or unrecognised is `all`; `off`/`0`/`false`/`no` opt out. */
export function parseStickySessionMode(value: string | undefined): StickySessionMode {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (OFF_VALUES.has(normalized)) return "off";
  return normalized === "model" ? "model" : "all";
}

export function stickySessionMode(): StickySessionMode {
  return parseStickySessionMode(getEnvironmentVariable("M365_STICKY_SESSION"));
}

export function stickyConversationKey(mode: "model" | "all", model: string): string {
  return mode === "all" ? "sticky:all" : `sticky:model:${model}`;
}

export interface DigestableMessage {
  role: string;
  content?: unknown;
  name?: string | null;
  tool_call_id?: string | null;
  tool_calls?: ReadonlyArray<{
    id?: string | null;
    function: { name: string; arguments: string };
  }> | null;
}

export function messageDigest(message: DigestableMessage): string {
  const toolCalls =
    message.tool_calls?.map((call) => [
      call.id ?? null,
      call.function.name,
      call.function.arguments,
    ]) ?? null;
  const serialized = JSON.stringify([
    message.role,
    message.content ?? null,
    message.name ?? null,
    message.tool_call_id ?? null,
    toolCalls,
  ]);
  return `${hashString(serialized)}:${serialized.length}`;
}

export type StickyDeltaReason = "full" | "append" | "rebased" | "rewritten";

/** Index where the not-yet-sent tail of `messages` starts, tolerating client-side history rewrites. */
export function stickyDeltaStart(
  messages: ReadonlyArray<DigestableMessage>,
  sentMessageCount: number,
  lastDigest: string | null,
): { start: number; reason: StickyDeltaReason } {
  if (sentMessageCount === 0) return { start: 0, reason: "full" };
  if (lastDigest === null) {
    return { start: Math.min(sentMessageCount, messages.length), reason: "append" };
  }
  if (
    sentMessageCount <= messages.length &&
    messageDigest(messages[sentMessageCount - 1]) === lastDigest
  ) {
    return { start: sentMessageCount, reason: "append" };
  }
  const lastSent = lastIndexWhere(messages, (message) => messageDigest(message) === lastDigest);
  if (lastSent >= 0) return { start: lastSent + 1, reason: "rebased" };
  return { start: rewrittenStart(messages), reason: "rewritten" };
}

/** FIFO mutex: turns on one conversation must never interleave. */
export class TurnQueue {
  #tail: Promise<void> = Promise.resolve();
  #holders = 0;

  acquire(): Promise<() => void> {
    this.#holders++;
    let finishTurn: () => void = () => {};
    const turnDone = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => turnDone);
    return previous.then(() => this.#oneShot(finishTurn));
  }

  get busy(): boolean {
    return this.#holders > 0;
  }

  #oneShot(finishTurn: () => void): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#holders--;
      finishTurn();
    };
  }
}

function rewrittenStart(messages: ReadonlyArray<DigestableMessage>): number {
  const lastAssistant = lastIndexWhere(messages, (message) => message.role === "assistant");
  if (lastAssistant >= 0) return lastAssistant + 1;
  const lastUser = lastIndexWhere(messages, (message) => message.role === "user");
  return lastUser >= 0 ? lastUser : messages.length;
}

function lastIndexWhere(
  messages: ReadonlyArray<DigestableMessage>,
  predicate: (message: DigestableMessage) => boolean,
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (predicate(messages[index])) return index;
  }
  return -1;
}

// djb2 variant, unsigned, base-36 output.
function hashString(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getEnvironmentVariable(name: string): string | undefined {
  const runtimeProcess: unknown = Reflect.get(globalThis, "process");
  if (!isRecord(runtimeProcess)) return undefined;
  const environment = runtimeProcess.env;
  if (!isRecord(environment)) return undefined;
  const value = environment[name];
  return typeof value === "string" ? value : undefined;
}
