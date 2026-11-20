import { enabledBackends, getToken, trackRuntimeConversations } from "@m365-copilot/core";

/**
 * Authenticate against M365 once, at server startup. A failure here throws and
 * aborts boot — the equivalent of the old binary's `process.exit(1)` on auth
 * failure, so the server never comes up half-broken.
 *
 * With Cowork or Code enabled, the proxy then lists the runtime conversations it
 * opens, and deletes the ones a proxy that's no longer running left in the
 * user's Copilot sidebar (core aether.ts), in the background.
 */
export default defineNitroPlugin(async () => {
  console.log("Authenticating...");
  try {
    await getToken();
  } catch (err: any) {
    console.error(`Auth failed: ${err.message}`);
    throw err;
  }
  if (enabledBackends().some((b) => b !== "chat")) {
    void trackRuntimeConversations().then((n) => {
      if (n > 0) console.log(`Deleted ${n} Cowork/Code conversation(s) an earlier proxy left`);
    });
  }
});
