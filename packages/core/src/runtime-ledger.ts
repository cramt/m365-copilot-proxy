import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./log.js";

const log = createLogger("aether");

/** Where each proxy process lists the agent runtime's conversations it has open, one file per process. */
export const DEFAULT_LEDGER_DIR = join(homedir(), ".config", "opencode-m365", "runtime-conversations");

/** A conversation a proxy opened on the agent runtime (Cowork or Code). */
export interface LedgerEntry {
  /** The runtime's session key: a UUID (Cowork) or `code-<uuid>` (Code). */
  session: string;
  mode: "cowork" | "code";
  /** When the proxy opened it (ms). */
  at: number;
}

/**
 * The agent runtime's conversations this process has open, kept in a file of its
 * own (`<dir>/<pid>.json`). The runtime lists every conversation in the user's
 * Copilot sidebar until it's deleted, and a proxy deletes the ones it leaves
 * (AetherSession.discard); a proxy that's stopped or restarted can't, so the
 * next one deletes them from its files (aether.ts `trackRuntimeConversations`).
 */
export class RuntimeLedger {
  private readonly file: string;
  private readonly open = new Map<string, LedgerEntry>();

  constructor(
    readonly dir: string = DEFAULT_LEDGER_DIR,
    private readonly pid: number = process.pid,
  ) {
    this.file = join(dir, `${pid}.json`);
  }

  add(entry: LedgerEntry): void {
    if (this.open.has(entry.session)) return;
    this.open.set(entry.session, entry);
    this.save();
  }

  remove(session: string): void {
    if (this.open.delete(session)) this.save();
  }

  /** The conversations of processes no longer running; their files are removed. */
  takeLeftovers(): LedgerEntry[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: LedgerEntry[] = [];
    for (const name of names) {
      const pid = /^(\d+)\.json$/.exec(name)?.[1];
      if (!pid || Number(pid) === this.pid || processAlive(Number(pid))) continue;
      const file = join(this.dir, name);
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { conversations?: unknown };
        if (Array.isArray(parsed.conversations)) out.push(...parsed.conversations.filter(isEntry));
      } catch (err: any) {
        log.info(`Unreadable list of agent runtime conversations ${file}: ${err?.message ?? err}`);
      }
      rmSync(file, { force: true });
    }
    return out;
  }

  private save(): void {
    try {
      if (this.open.size === 0) {
        rmSync(this.file, { force: true });
        return;
      }
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ pid: this.pid, conversations: [...this.open.values()] }));
      renameSync(tmp, this.file);
    } catch (err: any) {
      log.info(`Couldn't record the agent runtime's conversations in ${this.file}: ${err?.message ?? err}`);
    }
  }
}

function isEntry(value: unknown): value is LedgerEntry {
  const e = value as LedgerEntry;
  return !!e && typeof e.session === "string" && (e.mode === "cowork" || e.mode === "code") && typeof e.at === "number";
}

/** Signal 0 only checks that the process exists; EPERM means it does, under another user. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}
