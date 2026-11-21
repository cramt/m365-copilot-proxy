// Nitro server config for the M365 Copilot proxy.
// Routes live under routes/, the startup auth lives in plugins/, CORS in middleware/.
export default defineNitroConfig({
  compatibilityDate: "2025-01-01",
  preset: "node-server",
  externals: {
    // selenium-webdriver loads its `lib/atoms` modules through computed CommonJS
    // require() calls. Keep it external: bundling the package rewrites those calls
    // into an unsupported dynamic require. Nitro's file tracer copies the package
    // and its atom files into the standalone server runtime.
    // pnpm2nix serves node_modules from the read-only Nix store. Nitro's
    // node-externals plugin copyFile's each external into
    // .output/server/node_modules/<pkg>/ preserving the source mode
    // (read-only), then overwrites its package.json with a stripped version —
    // which fails with EACCES on the read-only copy. chmod:true tells Nitro to
    // chmod each copy to 0o644 right after copyFile, so the rewrite succeeds.
    // No-op for a normal (writable) `pnpm build`.
    chmod: true,
  },
  // Keep selenium-webdriver OUT of the Rollup bundle: it ships ~22M of
  // selenium-manager binaries for every platform, and its computed
  // require('./atoms/' + module) calls break when inlined. Operators who opt
  // into M365_BROWSER_PROVIDER=selenium install selenium-webdriver next to
  // .output themselves.
  rollupConfig: {
    external: (id: string) =>
      id === "selenium-webdriver" || id.startsWith("selenium-webdriver/"),
  },
});
