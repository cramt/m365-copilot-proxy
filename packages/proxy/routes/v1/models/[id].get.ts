import { buildModelEntry, modelNotFoundError, safeDecode } from "@m365-copilot/proxy-lib";

export default defineEventHandler((event) => {
  const id = safeDecode(getRouterParam(event, "id") ?? "");
  return buildModelEntry(id) ?? modelNotFoundError(id);
});
