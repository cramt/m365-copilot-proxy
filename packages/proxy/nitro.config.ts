// Nitro server config for the M365 Copilot proxy.
// Routes live under routes/, the startup auth lives in plugins/, CORS in middleware/.
export default defineNitroConfig({
  compatibilityDate: "2025-01-01",
  preset: "node-server",
  externals: {
    // Keep Selenium inside its dynamically imported chunk. Otherwise Nitro's
    // dependency tracer adds the optional peer to the production package manifest,
    // making every proxy deployment install it even when Playwright is selected.
    inline: ["selenium-webdriver"],
    // pnpm2nix serves node_modules from the read-only Nix store. Nitro's
    // node-externals plugin copyFile's each external into
    // .output/server/node_modules/<pkg>/ preserving the source mode
    // (read-only), then overwrites its package.json with a stripped version —
    // which fails with EACCES on the read-only copy. chmod:true tells Nitro to
    // chmod each copy to 0o644 right after copyFile, so the rewrite succeeds.
    // No-op for a normal (writable) `pnpm build`.
    chmod: true,
  },
});
