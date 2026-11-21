import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", exclude: ["**/node_modules/**", "**/.test-tmp/**", "**/settlement-native.test.ts"] } },
      {
        test: {
          name: "settlement-native",
          include: ["packages/proxy-lib/src/settlement-native.test.ts"],
          alias: {
            ws: new URL("./packages/proxy-lib/src/settlement-wire.fixture.ts", import.meta.url).pathname,
            "@m365-copilot/core": new URL("./packages/core/dist/index.mjs", import.meta.url).pathname,
          },
          server: { deps: { inline: ["@m365-copilot/core"] } },
        },
      },
    ],
  },
});
