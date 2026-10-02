import { z } from "zod/v4";

// --- SignalR Protocol Schemas ---

export const SignalRHandshakeResponse = z.object({
  error: z.string().optional(),
});

// --- M365 Copilot Response Schemas ---

export const ThrottlingInfo = z.object({
  maxNumUserMessagesInConversation: z.number(),
  numUserMessagesInConversation: z.number(),
  numLongDocSummaryUserMessagesInConversation: z.number(),
});

/** A single classifier score on a bot message. Observed components include:
 *  - `BotOffense`         — generic offensive-content classifier
 *  - `dea_violation`      — "disengaged-eligible answer" classifier; this is
 *                           the one that actually correlates with Disengaged.
 *  Both arrive as very small floats (1e-13 … 1e-3 in our captures). Disengaged
 *  itself triggers above some threshold > ~2e-3 we haven't yet pinpointed.
 *  See `docs/hypotheses.md §5`. */
export const ClassifierScore = z.object({
  component: z.string(),
  score: z.number(),
});

export const BotMessage = z.object({
  text: z.string(),
  author: z.literal("bot"),
  responseIdentifier: z.string().optional(),
  createdAt: z.string().optional(),
  timestamp: z.string().optional(),
  messageId: z.string().optional(),
  requestId: z.string().optional(),
  offense: z.string().optional(),
  messageType: z.string().optional(),
  adaptiveCards: z.array(z.any()).optional(),
  sourceAttributions: z.array(z.any()).optional(),
  contentOrigin: z.string().optional(),
  // Per-message classifier scores. Present on `update` deltas + the final
  // `type:2` stream item; absent on partial streaming chunks.
  scores: z.array(ClassifierScore).optional(),
  // Authoritative server-side turn count for this conversation.
  turnCount: z.number().optional(),
  // `Completed` / others (only observed `Completed` so far).
  turnState: z.string().optional(),
  suggestedResponses: z
    .array(
      z.object({
        text: z.string(),
        commandText: z.string().optional(),
        author: z.string().optional(),
      }),
    )
    .optional(),
});

export const CursorInfo = z.object({
  j: z.string(),
  p: z.number(),
});

// Update frame with delta text (streaming mode)
export const DeltaUpdate = z.object({
  writeAtCursor: z.string(),
  sourceAttributions: z.array(z.any()).optional(),
  streamingMode: z.literal("Delta").optional(),
  nonce: z.string().optional(),
});

// Update frame with full/initial message
export const MessageUpdate = z.object({
  messages: z.array(BotMessage.partial().extend({ author: z.string() })),
  nonce: z.string().optional(),
  cursor: CursorInfo.optional(),
  streamingMode: z.string().optional(),
  requestId: z.string().optional(),
});

// Update frame with throttling info
export const ThrottlingUpdate = z.object({
  nonce: z.string().optional(),
  requestId: z.string().optional(),
  throttling: ThrottlingInfo,
});

// SignalR type 3 - completion
export const CompletionFrame = z.object({
  type: z.literal(3),
  invocationId: z.string(),
  error: z.string().optional(),
  result: z.any().optional(),
});

// SignalR type 7 - close
export const CloseFrame = z.object({
  type: z.literal(7),
  error: z.string().optional(),
});

// --- JWT Claims ---

export const JwtClaims = z.object({
  aud: z.string(),
  iss: z.string(),
  oid: z.string(),
  tid: z.string(),
  exp: z.number(),
  name: z.string().optional(),
  upn: z.string().optional(),
});
