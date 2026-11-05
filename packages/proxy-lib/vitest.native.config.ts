// A plain Vitest config keeps Vite's server-only Node type graph out of the
// workspace production typecheck; the native runner consumes the same options.
export default {
  resolve: { alias: {
    ws: new URL("./tests/native-test-transport.ts", import.meta.url).pathname,
    "@m365-copilot/core": new URL("../core/src/index.ts", import.meta.url).pathname,
  } },
  test: { include: ["packages/proxy-lib/tests/account-composition.native.ts"], testTimeout: 10000 },
};
