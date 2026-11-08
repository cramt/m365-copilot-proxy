import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Deliberately excludes OS error causes, paths and serialized cache contents. */
export class CachePersistenceError extends Error {
  constructor() {
    super("Cannot persist local cache; check directory permissions and available disk space");
    this.name = "CachePersistenceError";
  }
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
      try {
        fd = openSync(parent, "r");
        fsyncSync(fd);
      } catch (error) {
        if (!directorySyncUnsupported(error)) throw error;
      } finally {
        if (fd !== undefined) {
          const closingDirectory = fd;
          fd = undefined;
          closeSync(closingDirectory);
        }
      }
    }
  } catch {
    throw new CachePersistenceError();
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Preserve the publication failure. */ }
    }
    if (owned) {
      try { unlinkSync(temp); } catch { /* Never mask the primary failure. */ }
    }
  }
}
