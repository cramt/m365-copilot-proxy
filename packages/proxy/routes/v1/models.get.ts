import { buildModelsPayload } from "@m365-copilot/proxy-lib";

export default defineEventHandler(async () => await buildModelsPayload());
