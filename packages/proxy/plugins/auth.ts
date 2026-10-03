import { getToken } from "@m365-copilot/core";

/**
 * Authenticate against M365 once, at server startup. A failure here throws and
 * aborts boot — the equivalent of the old binary's `process.exit(1)` on auth
 * failure, so the server never comes up half-broken.
 */
console.log("Authenticating...");
try {
  await getToken();
  console.log("Authenticated.");
} catch (error: unknown) {
  let message = "Unknown error";
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  }
  console.error(`Auth failed: ${message}`);
  throw error;
}

export default defineNitroPlugin(() => {});
