import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { atomicWritePrivate, CachePersistenceError } from "./storage.js";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
let root: string;
let target: string;
const realPlatform = process.platform;
/** Run the rest of the test as if on `platform`: the Windows rename retry depends on it. */
function onPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "private-cache-"));
  target = join(root, "cache.json");
  fs.writeFileSync(target, "old-complete", { mode: 0o644 });
});
afterEach(() => {
  vi.restoreAllMocks();
  onPlatform(realPlatform);
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

  it.each([["EBUSY", "rename"], ["EXDEV", "rename"], ["EACCES", "open"]] as const)(
    "keeps %s from %s on the cause without paths or contents in message or cause", (code, syscall) => {
      onPlatform("linux"); // the error's shape, not the Windows retry of an EBUSY rename (below)
      const secretPath = "/synthetic/private/dir/cache.json";
      const real = fs[syscall === "rename" ? "renameSync" : "openSync"];
      const seam = syscall === "rename" ? "renameSync" : "openSync";
      vi.spyOn(fs, seam).mockImplementation(((...args: never[]) => {
        // Only fail the helper's own call: open(parent,"r") for the directory fsync is not reached.
        if (seam === "openSync" && String(args[0]) === root) return (real as (...a: never[]) => unknown)(...args);
        throw Object.assign(new Error(`${code}: synthetic failure, ${syscall} '${secretPath}' token-abc`), {
          code, syscall, path: secretPath,
        });
      }) as never);
      let thrown: unknown;
      try { atomicWritePrivate(target, "secret-contents"); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(CachePersistenceError);
      const error = thrown as CachePersistenceError;
      expect(error.message).toContain(code);
      expect(error.cause).toMatchObject({ code, syscall });
      const visible = [error.message, String((error.cause as Error).message), JSON.stringify(error.cause),
        String((error.cause as Error).stack)].join("\n");
      for (const leak of [secretPath, "token-abc", "secret-contents", root]) expect(visible).not.toContain(leak);
      expect(fs.readFileSync(target, "utf8")).toBe("old-complete");
      expect(fs.readdirSync(root)).toEqual(["cache.json"]);
    },
  );

  it("does not expose arbitrary code-shaped secrets as errno", () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("private"), { code: "SECRET_TOKEN" }); });
    let thrown: unknown;
    try { atomicWritePrivate(target, "new"); } catch (error) { thrown = error; }
    expect((thrown as Error).message).not.toContain("SECRET_TOKEN");
    expect((thrown as Error).cause).toBeUndefined();
  });

  it("carries no cause code when the failure has no OS error code", () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("no code, /synthetic/path"); });
    let thrown: unknown;
    try { atomicWritePrivate(target, "new"); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(CachePersistenceError);
    expect((thrown as Error).cause).toBeUndefined();
  });

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

  describe("a rename that meets another handle on the destination", () => {
    /** renameSync refusing `failures` times with `code`, then renaming. */
    function refuse(failures: number, code: string) {
      const real = fs.renameSync;
      let calls = 0;
      vi.spyOn(fs, "renameSync").mockImplementation(((...args: Parameters<typeof fs.renameSync>) => {
        if (++calls <= failures) throw Object.assign(new Error("in use"), { code, syscall: "rename" });
        real(...args);
      }) as typeof fs.renameSync);
      return () => calls;
    }

    it("is retried on Windows, which refuses while the other handle is open", () => {
      onPlatform("win32");
      const calls = refuse(3, "EPERM");
      atomicWritePrivate(target, "new-complete");
      expect(calls()).toBe(4);
      expect(fs.readFileSync(target, "utf8")).toBe("new-complete");
      expect(fs.readdirSync(root)).toEqual(["cache.json"]);
    });

    it("fails at once elsewhere, where a refused rename is no sharing conflict", () => {
      onPlatform("linux");
      const calls = refuse(1, "EPERM");
      expect(() => atomicWritePrivate(target, "new-complete")).toThrow(CachePersistenceError);
      expect(calls()).toBe(1);
      expect(fs.readFileSync(target, "utf8")).toBe("old-complete");
    });

    it("fails at once on Windows when a directory is in the way, which no wait clears", () => {
      onPlatform("win32");
      fs.rmSync(target);
      fs.mkdirSync(target);
      const calls = refuse(Infinity, "EPERM");
      expect(() => atomicWritePrivate(target, "new-complete")).toThrow(CachePersistenceError);
      expect(calls()).toBe(1);
    });
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

  it.skipIf(process.platform === "win32")("preserves directory fsync errno if close also fails after rename", () => {
    const sync = fs.fsyncSync, close = fs.closeSync;
    let syncs = 0, closes = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (++syncs === 2) throw Object.assign(new Error("private fsync secret"), { code: "EIO", syscall: "fsync" });
      sync(fd);
    });
    vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      close(fd);
      if (++closes === 2) throw Object.assign(new Error("private close secret"), { code: "EBADF", syscall: "close" });
    });
    let error: any;
    try { atomicWritePrivate(target, "published"); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(CachePersistenceError);
    expect(error.cause).toMatchObject({ code: "EIO", syscall: "fsync" });
    expect(error.message).toContain("EIO");
    expect(fs.readFileSync(target, "utf8")).toBe("published");
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
  }, 30_000);
});
