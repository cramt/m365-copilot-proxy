import { z } from "zod/v4";

// --- OpenAI Request Schemas ---

export const ToolCallFunction = z.object({
  name: z.string(),
  arguments: z.string(),
});

export const ToolCall = z.object({
  id: z.string(),
  type: z.literal("function").default("function"),
  function: ToolCallFunction,
});

export const ToolDefinition = z.object({
  type: z.literal("function").default("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.any().optional(),
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export const ChatMessage = z.object({
  // `developer` is OpenAI's reasoning-model role — it replaces `system` for o1/
  // gpt-5-class reasoning models, and clients like Hermes emit it when pointed at
  // a `*-think-deeper` model. Accept it and normalize to `system` so every
  // downstream consumer only ever sees the four canonical roles.
  role: z
    .enum(["system", "developer", "user", "assistant", "tool"])
    .transform((r) => (r === "developer" ? "system" : r)),
  content: z
    .union([
      z.string(),
      z.array(
        z.object({
          type: z.string(),
          text: z.string().optional(),
        }),
      ),
    ])
    .nullable()
    .optional(),
  tool_calls: z.array(ToolCall).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

/**
 * Rewrite the legacy `functions` / `function_call` request shape into
 * `tools` / `tool_choice` / `tool_calls` / `role:"tool"`. Synthetic call IDs are
 * derived from message position so the same history always maps the same way.
 */
function normalizeLegacyFunctions(input: unknown): unknown {
  if (!isRecord(input) || Array.isArray(input)) return input;
  const raw = input;
  const usesLegacy =
    raw.functions !== undefined ||
    raw.function_call !== undefined ||
    (isUnknownArray(raw.messages) &&
      raw.messages.some(
        (m) => isRecord(m) && (m.role === "function" || m.function_call !== undefined),
      ));
  if (!usesLegacy) return input;

  const out: Record<string, unknown> = { ...raw, legacy_functions: raw.functions !== undefined };
  delete out.functions;
  delete out.function_call;
  if (raw.functions !== undefined && raw.tools === undefined) {
    out.tools = isUnknownArray(raw.functions)
      ? raw.functions.map((fn) => ({ type: "function", function: fn }))
      : raw.functions;
  }
  if (raw.function_call !== undefined && raw.tool_choice === undefined) {
    const fc = raw.function_call;
    out.tool_choice =
      isRecord(fc) && "name" in fc ? { type: "function", function: { name: fc.name } } : fc;
  }
  if (isUnknownArray(raw.messages)) {
    let lastCallId: string | undefined;
    out.messages = raw.messages.map((m, i) => {
      if (!isRecord(m)) return m;
      const msg = m;
      if (msg.role === "assistant" && msg.function_call && !msg.tool_calls) {
        const { function_call, ...rest } = msg;
        lastCallId = `call_legacy_${i}`;
        return {
          ...rest,
          tool_calls: [{ id: lastCallId, type: "function", function: function_call }],
        };
      }
      if (msg.role === "function") {
        return {
          ...msg,
          role: "tool",
          tool_call_id: msg.tool_call_id ?? lastCallId ?? `call_legacy_${i}`,
        };
      }
      return msg;
    });
  }
  return out;
}

export const ChatCompletionRequest = z.preprocess(
  normalizeLegacyFunctions,
  z.object({
    // Default when the client sends no model. An explicit reasoning tone is a more
    // reliable default than `m365-copilot` (the `magic` auto-router), which is
    // high-variance at turn-1 tool-calling (see docs/hypotheses.md F24 + correction:
    // magic swung 0/2 → 2/2 across probes; explicit tones pin a specific backend).
    model: z.string().optional().default("gpt-5.5-think-deeper"),
    messages: z.array(ChatMessage).min(1),
    stream: z.boolean().optional().default(false),
    // OpenAI streaming option: include_usage=true → emit a final chunk with `usage`.
    stream_options: z.object({ include_usage: z.boolean().optional() }).nullable().optional(),
    tools: z.array(ToolDefinition).optional(),
    tool_choice: z
      .union([
        z.enum(["auto", "none", "required"]),
        z.object({
          type: z.literal("function"),
          function: z.object({ name: z.string() }),
        }),
      ])
      .optional(),
    // Set by normalizeLegacyFunctions: reply with `function_call` instead of `tool_calls`.
    legacy_functions: z.boolean().optional().default(false),
    // Accepted for OpenAI compatibility; M365 exposes no sampling or length controls.
    temperature: z.number().nullable().optional(),
    top_p: z.number().nullable().optional(),
    frequency_penalty: z.number().nullable().optional(),
    presence_penalty: z.number().nullable().optional(),
    max_tokens: z.number().nullable().optional(),
    max_completion_tokens: z.number().nullable().optional(),
    stop: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .optional(),
    seed: z.number().int().nullable().optional(),
    user: z.string().optional(),
    response_format: z
      .object({
        type: z.enum(["text", "json_object", "json_schema"]),
        json_schema: z.any().optional(),
      })
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
    logprobs: z.boolean().nullable().optional(),
    top_logprobs: z.number().int().nullable().optional(),
    metadata: z.record(z.string(), z.any()).nullable().optional(),
    store: z.boolean().nullable().optional(),
    reasoning_effort: z.string().nullable().optional(),
    n: z
      .number()
      .int()
      .nullable()
      .optional()
      .refine((n) => n === undefined || n === null || n === 1, {
        message: "Only n=1 is supported: M365 Copilot returns a single answer per turn.",
      }),
  }),
);
