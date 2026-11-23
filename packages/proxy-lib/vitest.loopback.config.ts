export default {
  resolve: { alias: { "@m365-copilot/core": new URL("../core/src/index.ts", import.meta.url).pathname, ws: new URL("../core/node_modules/ws/wrapper.mjs", import.meta.url).pathname } },
  test: { include: ["packages/core/src/ownership-loopback.native.ts"], testTimeout: 10000 },
};
