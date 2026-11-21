import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "opencode-m365");

/** log.ts reads the env once, at load, like the proxy does at startup. */
async function load(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  return import("./log.js");
}

describe("debug log and frame dump paths", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("default to debug.log and frames/ in the config dir", async () => {
    const m = await load({ M365_LOG_FILE: undefined, M365_FRAME_DIR: undefined });
    expect(m.LOG_PATH).toBe(join(CONFIG_DIR, "debug.log"));
    expect(m.FRAME_DIR).toBe(join(CONFIG_DIR, "frames"));
  });

  it("take M365_LOG_FILE and M365_FRAME_DIR relative to the config dir", async () => {
    const m = await load({ M365_LOG_FILE: "my/log.log", M365_FRAME_DIR: "my/frames" });
    expect(m.LOG_PATH).toBe(join(CONFIG_DIR, "my", "log.log"));
    expect(m.FRAME_DIR).toBe(join(CONFIG_DIR, "my", "frames"));
  });

  it("take an absolute path as is, and an empty one as unset", async () => {
    const m = await load({ M365_LOG_FILE: "/tmp/x/a.log", M365_FRAME_DIR: "" });
    expect(m.LOG_PATH).toBe("/tmp/x/a.log");
    expect(m.FRAME_DIR).toBe(join(CONFIG_DIR, "frames"));
  });
});

describe("rolling window over the debug log (M365_LOG_MAX_BYTES)", () => {
  const dirs: string[] = [];

  /** A log path under a fresh temp dir, removed after the test. */
  function tempLog(): string {
    const dir = mkdtempSync(join(tmpdir(), "m365-log-"));
    dirs.push(dir);
    return join(dir, "debug.log");
  }

  /** A logger writing to `logFile`, with the env read at modules-reset time. */
  async function loggerAt(logFile: string, maxBytes?: string) {
    for (const [k, v] of Object.entries({
      M365_TRACE: undefined,
      M365_DEBUG: "1",
      M365_LOG_STDOUT: undefined,
      M365_LOG_FILE: logFile,
      M365_FRAME_DIR: undefined,
      M365_LOG_MAX_BYTES: maxBytes,
    })) vi.stubEnv(k, v);
    vi.resetModules();
    const m = await import("./log.js");
    return m.createLogger("test");
  }

  /** Whole numbered lines, `bytes` of them at 9 bytes a line. */
  function history(bytes: number): string {
    const lines: string[] = [];
    for (let i = 0, size = 0; size < bytes; i++, size += 9) lines.push(`line ${String(i).padStart(3, "0")}`);
    return `${lines.join("\n")}\n`;
  }

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("cuts the oldest bytes once the file passes 1.6x the window", async () => {
    const logFile = tempLog();
    writeFileSync(logFile, history(2_000));
    const logger = await loggerAt(logFile, "1000");

    logger.info("the newest line");
    const text = readFileSync(logFile, "utf8");

    expect(text).toContain("the newest line");
    expect(text).not.toContain("line 000");
    expect(text.length).toBeLessThan(1_200);
    // The cut is on a line boundary: the first kept line is whole.
    expect(text.split("\n")[0]).toMatch(/^line \d{3}$/);
    expect(existsSync(`${logFile}.tmp`)).toBe(false);
  });

  it("leaves a log under the threshold alone", async () => {
    const logFile = tempLog();
    const original = history(2_000);
    writeFileSync(logFile, original);
    const logger = await loggerAt(logFile, "50MB");

    logger.info("the newest line");
    const text = readFileSync(logFile, "utf8");

    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain("the newest line");
  });

  it("keeps the tail when it holds no newline at all", async () => {
    const logFile = tempLog();
    writeFileSync(logFile, "x".repeat(2_000));
    const logger = await loggerAt(logFile, "1000");

    logger.info("the newest line");
    const text = readFileSync(logFile, "utf8");

    expect(text.startsWith("xxx")).toBe(true);
    expect(text).toContain("the newest line");
    // Never emptied: the window is kept even though no line boundary was found.
    expect(text.length).toBeGreaterThan(1_000);
  });

  it("takes a KB/MB suffix and falls back to the default on nonsense", async () => {
    const suffixed = tempLog();
    writeFileSync(suffixed, history(2_000));
    const withSuffix = await loggerAt(suffixed, "1KB");
    withSuffix.info("the newest line");
    expect(readFileSync(suffixed, "utf8").length).toBeLessThan(1_200);

    const nonsense = tempLog();
    const original = history(2_000);
    writeFileSync(nonsense, original);
    const withDefault = await loggerAt(nonsense, "sixty megabytes");
    withDefault.info("the newest line");
    expect(readFileSync(nonsense, "utf8").startsWith(original)).toBe(true);
  });

  // Windows refuses to rename over a file the process holds open (EPERM), and the
  // trim's catch swallowed that, so the log grew forever there. Same rule here on any OS.
  it("closes the log before replacing it, so the trim also works on Windows", async () => {
    vi.doMock("node:fs", async (importOriginal) => {
      const fs = await importOriginal<typeof import("node:fs")>();
      const open = new Map<number, string>();
      return {
        ...fs,
        openSync: (path: string, ...rest: [any?, any?]) => {
          const fd = fs.openSync(path, ...rest);
          open.set(fd, resolve(path));
          return fd;
        },
        closeSync: (fd: number) => { open.delete(fd); fs.closeSync(fd); },
        renameSync: (from: string, to: string) => {
          if ([...open.values()].includes(resolve(to))) {
            throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
          }
          fs.renameSync(from, to);
        },
      };
    });
    try {
      const logFile = tempLog();
      writeFileSync(logFile, history(2_000));
      const logger = await loggerAt(logFile, "1000");

      logger.info("the newest line");

      expect(readFileSync(logFile, "utf8")).not.toContain("line 000");
    } finally {
      vi.doUnmock("node:fs");
    }
  });
});
