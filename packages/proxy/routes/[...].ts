import { OPENAI_ROUTES, routeNotFound } from "@m365-copilot/proxy-lib";

const ROUTES: Record<string, string[]> = {
  ...OPENAI_ROUTES,
  "/": ["GET"],
  "/actions/ping": ["POST"],
  "/actions/check-models": ["POST"],
};

export default defineEventHandler((event) => {
  const pathname = event.path.split("?")[0];
  return routeNotFound(event.method.toUpperCase(), pathname, ROUTES);
});
