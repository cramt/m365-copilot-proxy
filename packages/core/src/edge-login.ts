import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "./log.js";

const log = createLogger("edge-login");
const DEFAULT_EDGE_EXE = "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const REDIRECT = new URL("https://login.microsoftonline.com/common/oauth2/nativeclient");

function isWsl(): boolean {
  try { return /microsoft/i.test(readFileSync("/proc/version", "utf-8")); }
  catch { return false; }
}
export function edgeExePath(): string { return process.env.M365_EDGE_PATH || DEFAULT_EDGE_EXE; }

/** A visible browser requires consent; NO_INTERACTIVE always wins. */
export function edgeLoginEnabled(): boolean {
  if (process.env.M365_NO_INTERACTIVE === "1" || process.env.M365_EDGE_LOGIN === "0") return false;
  if (process.env.M365_EDGE_LOGIN === "1") return true;
  return process.env.M365_ENABLE_INTERACTIVE_APPROVAL === "1" && isWsl() && existsSync(edgeExePath());
}
function edgeUserDataDir(): string {
  if (process.env.M365_EDGE_USER_DATA) return process.env.M365_EDGE_USER_DATA;
  const winLocal = execFileSync("cmd.exe", ["/c", "echo %LOCALAPPDATA%"], {
    stdio: ["ignore", "pipe", "ignore"], cwd: "/mnt/c",
  }).toString().trim();
  return join(execFileSync("wslpath", ["-u", winLocal]).toString().trim(), "Microsoft", "Edge", "User Data");
}
function edgeProfile(): string { return process.env.M365_EDGE_PROFILE || "Default"; }

// Import before retrying: an unsupported Node runtime cannot repair itself by polling.
async function sqlite() {
  try { return await import("node:sqlite"); }
  catch { throw new Error("Edge login requires Node.js 22.13+ with node:sqlite available"); }
}

export async function findCodeInHistory(historyFile: string, state: string, tempRoot = tmpdir()): Promise<string | null> {
  const { DatabaseSync } = await sqlite();
  const dir = mkdtempSync(join(tempRoot, "m365-edge-"));
  try {
    const copy = join(dir, "History");
    copyFileSync(historyFile, copy);
    // Include the WAL when present; Edge may not yet have checkpointed recent visits.
    if (existsSync(`${historyFile}-wal`)) copyFileSync(`${historyFile}-wal`, `${copy}-wal`);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const rows = db.prepare("SELECT url FROM urls WHERE url LIKE '%/oauth2/nativeclient?%' ORDER BY last_visit_time DESC").all() as Array<{ url: string }>;
      for (const { url } of rows) {
        try {
          const u = new URL(url);
          if (u.origin === REDIRECT.origin && u.pathname === REDIRECT.pathname &&
              !u.username && !u.password && u.searchParams.get("state") === state && u.searchParams.get("code")) {
            return u.searchParams.get("code");
          }
        } catch { /* Ignore malformed history entries. */ }
      }
      return null;
    } finally { db.close(); }
  } catch (err: any) {
    log.info(`History read failed (will retry): ${err?.message}`);
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function getAuthCodeViaEdge(authUrl: string, state: string, timeoutMs: number): Promise<string> {
  await sqlite();
  // Resolve once so History polling and Windows Edge select the same root/profile.
  // M365_EDGE_USER_DATA is a Linux/WSL path; Windows Edge needs wslpath's spelling.
  const userDataDir = resolve(edgeUserDataDir());
  const profile = edgeProfile();
  const historyFile = join(userDataDir, profile, "History");
  if (!existsSync(historyFile)) throw new Error(`Edge profile history not found at ${historyFile} (set M365_EDGE_PROFILE / M365_EDGE_USER_DATA)`);
  const windowsUserDataDir = execFileSync("wslpath", ["-w", userDataDir]).toString().trim();
  console.error(`[m365 auth] Signing in through Edge profile "${profile}" on the Windows host…`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(edgeExePath(), [`--user-data-dir=${windowsUserDataDir}`, `--profile-directory=${profile}`, authUrl], {
      detached: true, stdio: "ignore", ...(isWsl() && existsSync("/mnt/c") ? { cwd: "/mnt/c" } : {}),
    });
    child.once("error", (err) => reject(new Error(`Failed to launch Edge: ${err.message}`)));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = await findCodeInHistory(historyFile, state);
    if (code) return code;
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(1500, remaining)));
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Edge sign-in`);
}
