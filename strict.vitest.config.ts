import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({ resolve: { alias: { "@m365-copilot/core": resolve("packages/core/src/index.ts"), "ws": resolve("node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs") } }, test: { include: ["strict.native.check.ts"] } });
