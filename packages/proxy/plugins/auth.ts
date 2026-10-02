import { getToken } from "@m365-copilot/core";

/**
 * Authenticate against M365 once, at server startup. A failure here throws and
 * aborts boot — the equivalent of the old binary's `process.exit(1)` on auth
 * failure, so the server never comes up half-broken.
 */
export default defineNitroPlugin(async () => {
  console.log("Authenticating...");
  try {
    await getToken();
    console.log("Authenticated.");
  } catch (err: any) {
    console.error(`Auth failed: ${err.message}`);
    throw err;
  }
});
