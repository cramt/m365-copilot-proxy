import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameFlags, select, stratifiedPermutation, turnsOf } from "./analyze-arms.mjs";

const rows = (task, ...turns) => turns.map((t, i) => ({ task: `${task}#${i + 1}`, turns: t }));

describe("analyze-arms", () => {
  it("finds a shift that holds within every task", () => {
    const xs = [...rows("fix-bug", 6, 5, 6, 5, 6), ...rows("multi", 8, 7, 8, 9, 8)];
    const ys = [...rows("fix-bug", 4, 3, 3, 4, 3), ...rows("multi", 5, 4, 5, 5, 4)];
    expect(stratifiedPermutation(xs, ys, { iters: 20_000 })).toBeLessThan(0.001);
  });

  it("doesn't credit a selection for running the short task more often", () => {
    // Same turns per task in both; only the mix differs.
    const xs = [...rows("short", 2, 2, 2), ...rows("long", 8, 8, 8, 8, 8, 8, 8)];
    const ys = [...rows("short", 2, 2, 2, 2, 2, 2, 2), ...rows("long", 8, 8, 8)];
    expect(stratifiedPermutation(xs, ys, { iters: 2_000 })).toBe(1);
  });

  it("is reproducible for a seed", () => {
    const xs = rows("t", 3, 4, 2, 5, 3, 3), ys = rows("t", 2, 3, 3, 2, 4, 2);
    expect(stratifiedPermutation(xs, ys, { seed: 7, iters: 5_000 })).toBe(stratifiedPermutation(xs, ys, { seed: 7, iters: 5_000 }));
  });

  it("counts a sandbox turn by its Code progress frame, whatever the model calls it", () => {
    const dir = mkdtempSync(join(tmpdir(), "frames-"));
    const progress = (text) => JSON.stringify({ type: 1, arguments: [{ messages: [{ text, author: "bot", messageType: "Progress", contentType: "Code" }] }] });
    const chat = JSON.stringify({ type: 1, arguments: [{ messages: [{ text: "```bash\nls\n```", author: "bot", contentOrigin: "DeepLeo" }] }] });
    writeFileSync(join(dir, "s46.ndjson"), [progress("Analysing"), chat].join("\n")); // Sonnet 4.6's code interpreter
    writeFileSync(join(dir, "g6s.ndjson"), [progress("Coding and executing"), chat].join("\n")); // GPT-6 Sol, Sonnet 5
    writeFileSync(join(dir, "plain.ndjson"), chat);
    const flags = frameFlags(dir);
    expect(flags.get("s46").sandbox).toBe(true);
    expect(flags.get("g6s").sandbox).toBe(true);
    expect(flags.get("plain").sandbox).toBe(false);
  });

  it("leaves a fallback's dead agent turn out of the count", () => {
    expect(turnsOf({ wire: { turns: 4, fallback: 1 } })).toBe(3);
    expect(turnsOf({})).toBeNull();
  });

  it("selects by arm, phase env and path", () => {
    const row = (path) => ({ task: "fix-bug#1", solved: true, invalid: null, path });
    const arms = [
      { arm: "pi=fix-bug", env: "M365_FORCE_AGENT=0 M365_FRAMING_VARIANT=relay", rows: [row("agent-less")] },
      { arm: "pi=fix-bug", env: "M365_FRAMING_VARIANT=relay_batch", rows: [row("agent"), row("agent-less")] },
      { arm: "relay", env: "", rows: [row("agent")] },
    ];
    expect(select(arms, "pi=fix-bug").length).toBe(3);
    expect(select(arms, "pi=fix-bug+M365_FRAMING_VARIANT=relay").length).toBe(1);
    expect(select(arms, "pi=fix-bug+M365_FRAMING_VARIANT=relay_batch@agent").length).toBe(1);
    expect(select(arms, "pi=fix-bug,relay+M365_FORCE_AGENT=0+M365_FRAMING_VARIANT=relay").length).toBe(1);
    expect(select(arms, "relay@agent").length).toBe(1);
  });
});
