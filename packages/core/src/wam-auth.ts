import { PublicClientApplication } from "@azure/msal-node";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname } from "node:path";
import { createLogger } from "./log.js";

const log = createLogger("wam");

export function createWamAuth(options: {
  clientId: string;
  authority: string;
  accountFile: string;
}) {
  let appPromise: Promise<PublicClientApplication> | undefined;

  async function getApp(): Promise<PublicClientApplication> {
    if (platform() !== "win32") {
      throw new Error("M365_AUTH_MODE=wam requires Windows.");
    }
    return (appPromise ??= (async () => {
      const { NativeBrokerPlugin } = await import("@azure/msal-node-extensions");
      const broker = new NativeBrokerPlugin();
      if (!broker.isBrokerAvailable) {
        throw new Error("The Windows authentication broker is unavailable; browser fallback is disabled.");
      }
      return new PublicClientApplication({
        auth: { clientId: options.clientId, authority: options.authority },
        broker: { nativeBrokerPlugin: broker },
        system: {
          loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
        },
      });
    })());
  }

  function selectedAccountId(): string | undefined {
    try {
      const saved = JSON.parse(readFileSync(options.accountFile, "utf-8"));
      return saved.clientId === options.clientId && typeof saved.accountId === "string"
        ? saved.accountId
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function getToken(scopes: string[], interactive: boolean): Promise<string | null> {
    const app = await getApp();
    const accounts = await app.getAllAccounts();
    const hint = process.env.M365_LOGIN_HINT?.trim().toLowerCase();
    const savedId = selectedAccountId();
    const matching = hint
      ? accounts.filter((account) => account.username.toLowerCase() === hint)
      : savedId
        ? accounts.filter((account) => account.nativeAccountId === savedId)
        : accounts;
    let result;
    if (matching.length === 1) {
      try {
        result = await app.acquireTokenSilent({ scopes, account: matching[0] });
      } catch (error: any) {
        log.info(`Silent broker acquisition failed: ${error.errorCode ?? error.name}`);
      }
    }
    if (!result) {
      if (!interactive) return null;
      let windowHandle: Buffer | undefined;
      const rawHandle = process.env.M365_WAM_WINDOW_HANDLE;
      if (rawHandle) {
        if (!/^[1-9]\d*$/.test(rawHandle)) {
          throw new Error("M365_WAM_WINDOW_HANDLE must be a positive decimal window handle.");
        }
        windowHandle = Buffer.alloc(8);
        windowHandle.writeBigUInt64LE(BigInt(rawHandle));
      }
      console.error("[m365 auth] Complete sign-in in the Windows account picker (WAM).");
      result = await app.acquireTokenInteractive({
        scopes,
        prompt: "select_account",
        ...(hint && { loginHint: hint }),
        ...(windowHandle && { windowHandle }),
      });
    }
    if (!result.accessToken || result.fromPlatformBroker !== true) {
      throw new Error("WAM did not return a native broker access token; browser fallback is disabled.");
    }
    if (hint && result.account?.username.toLowerCase() !== hint) {
      throw new Error("The selected WAM account does not match M365_LOGIN_HINT.");
    }
    if (result.account?.nativeAccountId) {
      mkdirSync(dirname(options.accountFile), { recursive: true });
      writeFileSync(
        options.accountFile,
        JSON.stringify({ clientId: options.clientId, accountId: result.account.nativeAccountId }),
        { mode: 0o600 },
      );
    }
    return result.accessToken;
  }

  return { getToken };
}
