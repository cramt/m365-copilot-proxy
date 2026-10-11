import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import importX from "eslint-plugin-import-x";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/.output/**",
    "**/.nitro/**",
    "**/.*/**",
    "scripts/*-out/**",
    "scripts/bench/out/**",
    "scripts/harness/out/**",
    "scripts/da-app/pkg/**",
    "packages/openclaw/**",
    "packages/openclaw-plugin/**",
    "nix/**",
  ]),
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ["packages/**/*.{ts,tsx,mts,cts}"],
    extends: [tseslint.configs.recommendedTypeCheckedOnly],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    plugins: { "import-x": importX },
    settings: {
      "import-x/resolver-next": [
        createTypeScriptImportResolver({
          project: ["packages/*/tsconfig.json"],
        }),
      ],
    },
    rules: {
      "import-x/no-cycle": "error",
      "import-x/no-duplicates": "error",
      "import-x/no-self-import": "error",
    },
  },
  {
    files: ["**/*.{test,spec}.{js,mjs,cjs,ts,tsx,mts,cts}"],
    extends: [vitest.configs.recommended],
  },
]);
