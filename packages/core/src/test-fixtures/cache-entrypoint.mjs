import { registerHooks } from "node:module";
const storage = new URL("../storage.ts", import.meta.url).href;
const core = `import { CachePersistenceError } from ${JSON.stringify(storage)};
export async function getToken() { throw new CachePersistenceError(Object.assign(new Error("secret-token /private/cache"), { code: process.argv[3], syscall: "rename" })); }
export function createLogger() { return { info() {}, error() {} }; }
export function enabledBackends() { return ["chat"]; }
export async function trackRuntimeConversations() { return 0; }`;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@m365-copilot/core") return { url: `data:text/javascript,${encodeURIComponent(core)}`, shortCircuit: true };
  if (specifier === "./index.js" && context.parentURL?.endsWith("/openclaw-plugin/src/setup.ts")) return { url: "data:text/javascript,export%20const%20generateOpenClawConfig%3D()%3D%3E%7B%7D%2C%20startForOpenClaw%3D()%3D%3E%7B%7D", shortCircuit: true };
  return next(specifier, context);
} });
if (process.argv[2] === "setup") {
  await import("../../../openclaw-plugin/src/setup.ts");
} else {
  globalThis.defineNitroPlugin = (fn) => fn;
  const { default: plugin } = await import("../../../proxy/plugins/auth.ts");
  try { await plugin(); } catch { process.exitCode = 1; }
}
