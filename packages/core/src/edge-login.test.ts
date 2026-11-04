import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { EventEmitter } from "node:events";

const launch = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:child_process", () => launch);
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { edgeLoginEnabled, findCodeInHistory, getAuthCodeViaEdge } from "./edge-login.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "edge-test-")); dirs.push(dir);
  const history = join(dir, "History");
  const db = new DatabaseSync(history);
  db.exec("CREATE TABLE urls (url TEXT, last_visit_time INTEGER)");
  return { dir, history, db };
}
beforeEach(() => {
  launch.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  launch.execFileSync.mockReset().mockImplementation((file, args) => {
    if (file === "wslpath" && args[0] === "-w") return Buffer.from("C:\\Synthetic Edge\\User Data\n");
    throw new Error(`Unexpected offline command: ${file}`);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("Edge sign-in", () => {
  it("requires explicit opt-in or existing interactive approval; no-interactive vetoes both", () => {
    vi.stubEnv("M365_EDGE_LOGIN", "1");
    vi.stubEnv("M365_NO_INTERACTIVE", "1");
    expect(edgeLoginEnabled()).toBe(false);
    vi.stubEnv("M365_NO_INTERACTIVE", "0");
    expect(edgeLoginEnabled()).toBe(true);
    vi.stubEnv("M365_EDGE_LOGIN", "0");
    expect(edgeLoginEnabled()).toBe(false);
  });
  it("does not auto-enable on a headless WSL host with Edge installed", () => {
    vi.stubEnv("M365_EDGE_PATH", process.execPath);
    vi.stubEnv("M365_EDGE_LOGIN", "");
    vi.stubEnv("M365_ENABLE_INTERACTIVE_APPROVAL", "");
    vi.stubEnv("M365_NO_INTERACTIVE", "0");
    expect(edgeLoginEnabled()).toBe(false);
  });
  it("fails promptly if node:sqlite is unavailable", async () => {
    vi.doMock("node:sqlite", () => { throw new Error("unavailable"); });
    try {
      await expect(getAuthCodeViaEdge("https://example.invalid", "x", 600000)).rejects.toThrow(/node:sqlite/);
    } finally { vi.doUnmock("node:sqlite"); }
  });
  it("finds only a matching state on the exact redirect, regardless of parameter order and newer decoys", async () => {
    const { dir, history, db } = fixture();
    const put = db.prepare("INSERT INTO urls VALUES (?, ?)");
    put.run("https://login.microsoftonline.com/common/oauth2/nativeclient?state=ok&code=good", 1);
    put.run("https://evil.example/common/oauth2/nativeclient?code=bad&state=ok", 2);
    put.run("https://login.microsoftonline.com/common/oauth2/nativeclient?code=bad&state=wrong", 3);
    db.close();
    expect(await findCodeInHistory(history, "ok", dir)).toBe("good");
    expect(await findCodeInHistory(history, "missing", dir)).toBeNull();
    expect(readdirSync(dir)).toEqual(["History"]);
  });
  it("cleans up after unreadable database", async () => {
    const { dir, db } = fixture(); db.close();
    expect(await findCodeInHistory(join(dir, "missing"), "x", dir)).toBeNull();
    expect(readdirSync(dir)).toEqual(["History"]);
  });
  it.each([false, true])("launches the same resolved user-data root used for History (default=%s)", async (useDefault) => {
    const { dir, history, db } = fixture();
    db.prepare("INSERT INTO urls VALUES (?, ?)").run(
      "https://login.microsoftonline.com/common/oauth2/nativeclient?state=ok&code=selected", 1);
    db.close();
    const root = useDefault ? join(dir, "Microsoft", "Edge", "User Data") : dir;
    const profile = useDefault ? "Default" : "Profile 1";
    mkdirSync(join(root, profile), { recursive: true });
    copyFileSync(history, join(root, profile, "History"));
    vi.stubEnv("M365_EDGE_USER_DATA", useDefault ? "" : root);
    vi.stubEnv("M365_EDGE_PROFILE", useDefault ? "" : profile);
    vi.stubEnv("M365_EDGE_PATH", "/mnt/c/Synthetic Edge/msedge.exe");
    launch.execFileSync.mockImplementation((file, args) => {
      if (file === "cmd.exe") return Buffer.from("C:\\Synthetic Local\r\n");
      if (file === "wslpath" && args[0] === "-u" && args[1] === "C:\\Synthetic Local") return Buffer.from(`${dir}\n`);
      if (file === "wslpath" && args[0] === "-w" && args[1] === root) return Buffer.from("C:\\Synthetic Edge\\User Data\n");
      throw new Error(`Unexpected offline command: ${file} ${args}`);
    });
    const authUrl = "https://example.invalid/authorize?state=ok";
    expect(await getAuthCodeViaEdge(authUrl, "ok", 1000)).toBe("selected");
    expect(launch.execFileSync).toHaveBeenCalledWith("wslpath", ["-w", root]);
    expect(launch.spawn).toHaveBeenCalledWith("/mnt/c/Synthetic Edge/msedge.exe", [
      "--user-data-dir=C:\\Synthetic Edge\\User Data", `--profile-directory=${profile}`, authUrl,
    ], expect.objectContaining({ detached: true, stdio: "ignore" }));
  });
  it("reads an uncheckpointed WAL while its writer remains open", async () => {
    const { dir, history, db } = fixture();
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)");
      db.prepare("INSERT INTO urls VALUES (?, ?)").run(
        "https://login.microsoftonline.com/common/oauth2/nativeclient?state=wal&code=wal-only", 1);
      expect(statSync(`${history}-wal`).size).toBeGreaterThan(0);
      const mainOnly = join(dir, "main-only");
      copyFileSync(history, mainOnly);
      const control = new DatabaseSync(mainOnly, { readOnly: true });
      try { expect(control.prepare("SELECT count(*) AS n FROM urls").get()).toEqual({ n: 0 }); }
      finally { control.close(); }
      const before = readdirSync(dir).sort();
      expect(await findCodeInHistory(history, "wal", dir)).toBe("wal-only");
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally { db.close(); }
  });
  it("fails promptly on launch failure without launching a browser", async () => {
    const { dir, db } = fixture(); db.close();
    mkdirSync(join(dir, "Default"));
    vi.stubEnv("M365_EDGE_USER_DATA", dir);
    vi.stubEnv("M365_EDGE_PATH", join(dir, "nonexistent"));
    // The history must exist before launch.
    const profile = new DatabaseSync(join(dir, "Default", "History")); profile.close();
    launch.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("synthetic launch failure")));
      return child;
    });
    await expect(getAuthCodeViaEdge("https://example.invalid", "x", 1000)).rejects.toThrow(/launch/i);
  });
  it("times out without launching a real browser", async () => {
    const { dir, db } = fixture(); db.close();
    mkdirSync(join(dir, "Default"));
    const profile = new DatabaseSync(join(dir, "Default", "History"));
    profile.exec("CREATE TABLE urls (url TEXT, last_visit_time INTEGER)"); profile.close();
    vi.stubEnv("M365_EDGE_USER_DATA", dir);
    vi.stubEnv("M365_EDGE_PATH", process.execPath);
    await expect(getAuthCodeViaEdge("https://example.invalid", "x", 30)).rejects.toThrow(/timed out/i);
  });
});
