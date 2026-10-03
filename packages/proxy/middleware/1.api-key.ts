import { configuredApiKey, isAuthorized, unauthorizedError } from "@m365-copilot/proxy-lib";

// Sorted after 0.cors.ts so a 401 still carries CORS headers.
export default defineEventHandler((event) => {
  const apiKey = configuredApiKey();
  if (!apiKey || event.method === "OPTIONS" || !event.path.startsWith("/v1/")) return;
  if (!isAuthorized(getRequestHeader(event, "authorization"), apiKey)) return unauthorizedError();
});
