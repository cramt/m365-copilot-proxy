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

/**
 * Publish one complete snapshot. Existing shared parents are never chmodded;
 * missing parents are created 0700. The configured ancestor directories must
 * be trusted (this is not an openat-based defence against hostile directory swaps).
 * A destination symlink is replaced, not followed. A symlink as the immediate
 * parent is rejected. Concurrent writers are last-rename-wins, NOT MSAL merging.
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
    renameSync(temp, path);
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
