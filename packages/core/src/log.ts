import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".config", "opencode-m365");
// M365_LOG_FILE and M365_FRAME_DIR are relative to CONFIG_DIR (an absolute path
// is taken as is), so a bench sweep can point each proxy straight into its archive.
const LOG_FILE = resolve(CONFIG_DIR, process.env.M365_LOG_FILE || "debug.log");
const LOG_DIR = dirname(LOG_FILE);
/** Where M365_DUMP_FRAMES=1 writes one `<requestId>.ndjson` per turn. */
export const FRAME_DIR = resolve(CONFIG_DIR, process.env.M365_FRAME_DIR || "frames");

// M365_TRACE implies debug logging and disables all payload truncation, so
// every WS frame, prompt, and response is recorded in full for reverse
// engineering. M365_DEBUG keeps the lighter, truncated logging.
const trace = !!process.env.M365_TRACE;
const enabled = !!process.env.M365_DEBUG || trace;
// Tailing ~/.config/opencode-m365/debug.log in a second terminal is the usual
// way to watch a run; this mirrors the same lines to the proxy's own stdout so
// one terminal is enough. Safe here because the proxy speaks HTTP — stdout is
// not a protocol channel.
const stdoutEnabled = !!process.env.M365_LOG_STDOUT;

/**
 * M365_LOG_MAX_BYTES as bytes: a plain number is bytes, `512KB` and `60MB` are
 * taken as binary units. Anything unparsable yields NaN, so the default wins.
 */
function parseBytes(raw: string | undefined): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(KB|MB)?\s*$/i.exec(raw ?? "");
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toUpperCase();
  return unit === "KB" ? n * 1024 : unit === "MB" ? n * 1024 * 1024 : n;
}

// The debug log keeps a rolling window of the most recent history: at least
// M365_LOG_MAX_BYTES (default 50MB) of it is always on disk, because the turn
// throttle replays that history to know how many turns it has left. When the
// file passes TRIM_AT (a little above the window, so trimming is rare), the
// OLDEST bytes are cut from the head and the newest M365_LOG_MAX_BYTES are kept
// — the file never shrinks to nothing and never loses recent lines.
const maxBytesRaw = parseBytes(process.env.M365_LOG_MAX_BYTES);
const MAX_LOG_BYTES = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? maxBytesRaw : 50 * 1024 * 1024;
const TRIM_AT_BYTES = Math.ceil(MAX_LOG_BYTES * 1.6);

function timestamp(): string {
  return new Date().toISOString();
}

/** Rewrites LOG_FILE with only its newest MAX_LOG_BYTES, on a line boundary. */
function trimToWindow(size: number) {
  const keep = Math.min(MAX_LOG_BYTES, size);
  const tmp = `${LOG_FILE}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(LOG_FILE, "r");
    const buf = Buffer.alloc(keep);
    const n = readSync(fd, buf, 0, keep, size - keep);
    // We cut at an arbitrary byte, so the first line is usually a fragment;
    // drop it. If the tail has no newline at all, keep everything: an empty
    // log is never the right answer.
    let start = 0;
    if (size > keep) {
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) start = nl + 1;
    }
    // Close before the rename: Windows refuses to replace a file this process holds open (EPERM).
    closeSync(fd);
    fd = undefined;
    writeFileSync(tmp, buf.subarray(start, n));
    renameSync(tmp, LOG_FILE); // atomic: readers see the old or the new file
  } catch {
    // best effort
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function trimIfNeeded(next: number) {
  let size: number;
  try {
    size = statSync(LOG_FILE).size;
  } catch {
    return; // no log yet, nothing to trim
  }
  if (size + next < TRIM_AT_BYTES) return;
  trimToWindow(size);
}

function write(level: string, component: string, ...args: unknown[]) {
  if (!enabled) return;
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ");
  const line = `[${timestamp()}] [${level}] [${component}] ${msg}\n`;
  if (stdoutEnabled) process.stdout.write(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    trimIfNeeded(Buffer.byteLength(line));
    appendFileSync(LOG_FILE, line);
  } catch {
    // best effort
  }
}

export function createLogger(component: string) {
  return {
    info: (...args: unknown[]) => write("INFO", component, ...args),
    error: (...args: unknown[]) => write("ERROR", component, ...args),
    debug: (...args: unknown[]) => write("DEBUG", component, ...args),
  };
}

/**
 * Truncate a string for logging unless M365_TRACE is set, in which case the
 * full value is returned so the debug file captures complete payloads.
 */
export function trunc(value: string, limit: number): string {
  if (trace) return value;
  return value.slice(0, limit);
}

export const LOG_PATH = LOG_FILE;

/** Whether this process writes its debug log (M365_DEBUG / M365_TRACE). */
export function fileLoggingEnabled(): boolean {
  return enabled;
}
