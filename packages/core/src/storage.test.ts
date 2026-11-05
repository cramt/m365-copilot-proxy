import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { atomicWritePrivate, CachePersistenceError } from "./storage.js";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
let root: string;
let target: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "private-cache-"));
  target = join(root, "cache.json");
  fs.writeFileSync(target, "old-complete", { mode: 0o644 });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("private atomic publication", () => {
  it("writes and syncs complete private same-directory bytes before rename", () => {
    const rename = fs.renameSync;
    const sync = vi.spyOn(fs, "fsyncSync");
    vi.spyOn(fs, "renameSync").mockImplementation((temp, destination) => {
      expect(dirname(String(temp))).toBe(root);
      expect(fs.readFileSync(temp, "utf8")).toBe("new-complete");
      expect(fs.readFileSync(target, "utf8")).toBe("old-complete");
      expect(sync).toHaveBeenCalledTimes(1);
      if (process.platform !== "win32") expect(fs.statSync(temp).mode & 0o777).toBe(0o600);
      rename(temp, destination);
    });
    atomicWritePrivate(target, "new-complete");
    expect(fs.readFileSync(target, "utf8")).toBe("new-complete");
    if (process.platform !== "win32") {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(sync).toHaveBeenCalledTimes(2);
    }
    expect(fs.readdirSync(root)).toEqual(["cache.json"]);
  });

  it("creates private missing parents without chmod of shared existing parents", () => {
    fs.chmodSync(root, 0o755);
    atomicWritePrivate(join(root, "a", "b", "cache"), "complete");
    if (process.platform !== "win32") {
      expect(fs.statSync(root).mode & 0o777).toBe(0o755);
      for (const p of ["a", "a/b"]) expect(fs.statSync(join(root, p)).mode & 0o777).toBe(0o700);
    }
  });

  it.each(["writeFileSync", "fsyncSync", "closeSync", "renameSync"] as const)(
    "%s failure preserves the old complete file and removes owned temp", (operation) => {
      const original = fs[operation];
      let first = true;
      const fault = new Error("synthetic private path and token must not escape");
      // A close failure is injected after actually closing, avoiding a test-owned FD leak.
      vi.spyOn(fs, operation).mockImplementation(((...args: never[]) => {
        if (first) {
          first = false;
          if (operation === "closeSync") (original as (...a: never[]) => unknown)(...args);
          if (operation === "writeFileSync") fs.writeSync(args[0] as number, "partial");
          throw fault;
        }
        return (original as (...a: never[]) => unknown)(...args);
      }) as typeof fs[typeof operation]);
      expect(() => atomicWritePrivate(target, "new")).toThrow(CachePersistenceError);
      expect(fs.readFileSync(target, "utf8")).toBe("old-complete");
      expect(fs.readdirSync(root)).toEqual(["cache.json"]);
    },
  );

  it("does not delete an unowned exclusive-open collision", () => {
    vi.spyOn(fs, "openSync").mockImplementation((path) => {
      fs.writeFileSync(path, "foreign");
      throw Object.assign(new Error("collision"), { code: "EEXIST" });
    });
    expect(() => atomicWritePrivate(target, "new")).toThrow(CachePersistenceError);
    const foreign = fs.readdirSync(root).filter((p) => p !== "cache.json");
    expect(foreign).toHaveLength(1);
    expect(fs.readFileSync(join(root, foreign[0]), "utf8")).toBe("foreign");
  });

  it("secondary cleanup failure cannot hide the primary safe error", () => {
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("private secret"); });
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw new Error("cleanup secret"); });
    try { atomicWritePrivate(target, "new"); expect.fail("must reject"); }
    catch (error) {
      expect(error).toBeInstanceOf(CachePersistenceError);
      expect(String(error)).not.toMatch(/private secret|cleanup secret|private-cache-/);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("rejects malformed parent paths without replacing them", () => {
    expect(() => atomicWritePrivate(join(target, "child"), "new")).toThrow(CachePersistenceError);
    expect(fs.readFileSync(target, "utf8")).toBe("old-complete");
  });

  it.skipIf(process.platform === "win32")("replaces a destination symlink, never writing its target", () => {
    const victim = join(root, "victim");
    fs.writeFileSync(victim, "untouched");
    fs.unlinkSync(target);
    fs.symlinkSync(victim, target);
    atomicWritePrivate(target, "complete");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
  });

  it("reports directory-sync failure after publication without rolling back complete bytes", () => {
    const sync = fs.fsyncSync;
    let calls = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (++calls === 2) throw Object.assign(new Error("I/O failure"), { code: "EIO" });
      sync(fd);
    });
    if (process.platform === "win32") return;
    expect(() => atomicWritePrivate(target, "new-complete")).toThrow(CachePersistenceError);
    expect(fs.readFileSync(target, "utf8")).toBe("new-complete");
    expect(fs.readdirSync(root)).toEqual(["cache.json"]);
  });

  it.skipIf(process.platform === "win32")("rejects a symlink immediate parent without touching its target", () => {
    const link = join(root, "alias");
    fs.symlinkSync(root, link);
    expect(() => atomicWritePrivate(join(link, "other"), "new")).toThrow(CachePersistenceError);
    expect(fs.existsSync(join(root, "other"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("tolerates unsupported directory fsync but still syncs the file", () => {
    const sync = fs.fsyncSync;
    let calls = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (++calls === 2) throw Object.assign(new Error("unsupported"), { code: "EINVAL" });
      sync(fd);
    });
    atomicWritePrivate(target, "new-complete");
    expect(calls).toBe(2);
    expect(fs.readFileSync(target, "utf8")).toBe("new-complete");
  });

  it("competing native writers publish only whole snapshots", async () => {
    // Execute the actual TS helper in independent Node workers (Node supports TS stripping).
    const source = new URL("./storage.ts", import.meta.url).href;
    const workers = ["A", "B"].map((letter) => new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      import(workerData.source).then(({ atomicWritePrivate }) => {
        for (let i = 0; i < 40; i++) atomicWritePrivate(workerData.target, workerData.letter.repeat(32768));
        parentPort.postMessage('done');
      });
    `, { eval: true, workerData: { source, target, letter } }));
    let done = 0;
    const completion = Promise.all(workers.map((w) => new Promise<void>((resolve, reject) => {
      w.on("error", reject);
      w.on("exit", (code) => { done++; code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)); });
    })));
    try {
      while (done < workers.length) {
        const bytes = fs.readFileSync(target, "utf8");
        expect(["old-complete", "A".repeat(32768), "B".repeat(32768)]).toContain(bytes);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await completion;
      expect(fs.readdirSync(root)).toEqual(["cache.json"]);
    } finally { await Promise.all(workers.map((w) => w.terminate())); }
  });
});
