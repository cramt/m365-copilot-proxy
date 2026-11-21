import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

it.each(["EXDEV", "EBUSY"])("setup CLI stderr and proxy startup stderr show safe %s", (code) => {
  for (const entrypoint of ["setup", "proxy"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./test-fixtures/cache-entrypoint.mjs", import.meta.url)), entrypoint, code], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Auth failed: Cannot persist local cache`);
    expect(result.stderr).toContain(code);
    expect(result.stderr).not.toMatch(/secret-token|\/private\/cache/);
  }
});
