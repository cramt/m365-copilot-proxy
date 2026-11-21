import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it("runs the native refusal identity transport tests", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const runner = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
  execFileSync(process.execPath, [runner, "run", "--config", "packages/proxy-lib/vitest.native.config.ts"], { cwd: root, encoding: "utf8", timeout: 30000, stdio: "inherit" });
});
