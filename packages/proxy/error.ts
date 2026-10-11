import { createLogger } from "@m365-copilot/core";

const log = createLogger("proxy");

// Uncaught errors (and h3's own 4xx) in OpenAI's error shape instead of Nitro's default.
export default defineNitroErrorHandler((error, event) => {
  const status = error.statusCode || 500;
  if (status >= 500)
    log.error(`${event.method} ${event.path} failed:`, error.stack ?? error.message);
  const message = status >= 500 ? "Internal server error" : error.statusMessage || error.message;
  setResponseStatus(event, status);
  setResponseHeader(event, "Content-Type", "application/json");
  return send(
    event,
    JSON.stringify({
      error: {
        message,
        type: status >= 500 ? "server_error" : "invalid_request_error",
        param: null,
        code: null,
      },
    }),
  );
});
