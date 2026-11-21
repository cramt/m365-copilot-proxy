import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";

const errnoCodes = new Set(Object.keys(constants.errno));

/**
 * The message deliberately excludes paths and serialized cache contents. When the
 * failure had an OS error code, `cause` carries only that code and the failing
 * syscall (e.g. EBUSY/EXDEV from rename), never the original error, its path or message.
 */
export class CachePersistenceError extends Error {
  constructor(cause?: unknown) {
    const safe = errnoOnly(cause);
    super(`Cannot persist local cache; check directory permissions and available disk space${safe ? ` (${(safe as Error & { code: string }).code})` : ""}`);
    this.name = "CachePersistenceError";
    if (safe) this.cause = safe;
  }
}

function errnoOnly(error: unknown): Error | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  if (typeof code !== "string" || !errnoCodes.has(code)) return undefined;
  const call = typeof syscall === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(syscall) ? syscall : undefined;
  return Object.assign(new Error(call ? `${code} (${call})` : code), call ? { code, syscall: call } : { code });
}

function directorySyncUnsupported(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(String(error.code));
}

/** How Windows refuses to replace a file another handle has open: a reader, a competing writer's rename, a scanner. */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** How long a refused rename is retried on Windows. Behind a reader that kept
 *  reopening the file, a scanner held it for up to 1.6 s at a time. */
const RENAME_RETRY_MS = 5_000;
const RENAME_RETRY_MAX_WAIT_MS = 100;

function isDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

/**
 * renameSync, retried on Windows while the destination is open elsewhere. POSIX
 * rename replaces a file whoever has it open; Windows refuses (EPERM, EACCES,
 * EBUSY) until the other handle closes, so two processes refreshing one cache
 * failed one of them. Elsewhere, for a directory in the way, and once
 * RENAME_RETRY_MS is up, the failure is final.
 */
function renameReplacing(from: string, to: string): void {
  const start = Date.now();
  for (let wait = 1; ; wait = Math.min(wait * 2, RENAME_RETRY_MAX_WAIT_MS)) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = String((error as { code?: unknown } | null)?.code);
      if (process.platform !== "win32" || !RENAME_RETRY_CODES.has(code) || Date.now() - start >= RENAME_RETRY_MS || isDirectory(to)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

/**
 * Publish one complete snapshot. Existing shared parents are never chmodded;
 * missing parents are created 0700. The configured ancestor directories must
 * be trusted (this is not an openat-based defence against hostile directory swaps).
 * A destination symlink is replaced, not followed. A symlink as the immediate
 * parent is rejected. Concurrent writers are last-rename-wins, NOT MSAL merging;
 * on Windows a rename that meets another handle is retried (renameReplacing).
 */
export function atomicWritePrivate(path: string, contents: string): void {
  const parent = dirname(path);
  const temp = join(parent, `.m365-cache-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let owned = false;
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!lstatSync(parent).isDirectory()) throw new CachePersistenceError();
    fd = openSync(temp, "wx", 0o600);
    owned = true;
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
    const closing = fd;
    fd = undefined; // Never retry close: an interrupted close may already release the FD.
    closeSync(closing);
    renameReplacing(temp, path);
    owned = false;

    // Windows does not provide POSIX directory fsync. On other systems tolerate
    // only documented unsupported-operation errors, not real I/O/permission faults.
    if (process.platform !== "win32") {
      let syncFailure: unknown;
      let failed = false;
      try {
        fd = openSync(parent, "r");
        fsyncSync(fd);
      } catch (error) {
        if (!directorySyncUnsupported(error)) { failed = true; syncFailure = error; }
      } finally {
        if (fd !== undefined) {
          const closingDirectory = fd;
          fd = undefined;
          try { closeSync(closingDirectory); } catch (error) {
            if (!failed) throw error;
          }
        }
      }
      if (failed) throw syncFailure;
    }
  } catch (error) {
    throw error instanceof CachePersistenceError ? error : new CachePersistenceError(error);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Preserve the publication failure. */ }
    }
    if (owned) {
      try { unlinkSync(temp); } catch { /* Never mask the primary failure. */ }
    }
  }
}
