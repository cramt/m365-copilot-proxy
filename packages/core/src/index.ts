export {
  getToken,
  getTokenSilent,
  getTokenForScope,
  getImageArtifactToken,
  loginAutomated,
  loadSecrets,
  forceReauth,
} from "./auth.js";

export {
  generateImage,
  fetchImageBytes,
  buildImagePrompt,
  classifyImageFailure,
  ImageGenerationError,
  type GeneratedImage,
  type GenerateImageOptions,
  type ImageOrientation,
  type ImageStyle,
  type ImageGenFailureReason,
} from "./image.js";

export {
  noteRequestOutcome,
  awaitDegradationBackoff,
  isDegradationBackoff,
  createBackoffController,
  type BackoffController,
  type BackoffOptions,
} from "./auth-recovery.js";

export { getOrCreateAgent } from "./agent.js";

export {
  decodeJwt,
  getToneForModel,
  getAvailableModels,
  type CopilotStream,
  type CapturedImage,
} from "./copilot.js";

export {
  CopilotSession,
  type CopilotSessionOptions,
  type ChatTurnOptions,
  type NativeActionConfig,
} from "./session.js";

export {
  parseActionConfirmation,
  buildResumeInvokeAction,
  shouldAutoConfirm,
  buildNativeActionPrompt,
  NATIVE_ACTION_INSTRUCTIONS,
  ACTION_ALLOWED_MESSAGE_TYPES,
  ACTION_CONFIRM_MESSAGE_TYPES,
  type ActionConfirmation,
} from "./native-actions.js";

export {
  ModelSession,
  type ModelSessionOptions,
} from "./model.js";

export {
  formatMessages,
  formatToolDefinitions,
  formatToolChoiceInstruction,
  getMessageContent,
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  looksLikeRemoteArtifactCompletion,
  isProseDocument,
  type Message,
  type ToolDef,
  type ToolFunction,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
} from "./tools.js";

export { createLogger, trunc, LOG_PATH } from "./log.js";
