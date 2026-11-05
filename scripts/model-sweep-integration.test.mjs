import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("stops through unchanged oneTurn frame-to-summary integration without real auth or sockets", () => {
  // VM links only synthetic auth/transport; both production modules run unchanged.
  const replay = execFileSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { EventEmitter } from "node:events";
    import { SourceTextModule, SyntheticModule } from "node:vm";
    let sockets = 0;
    let finalFrame;
    class Socket extends EventEmitter {
      constructor() { super(); sockets++; queueMicrotask(() => this.emit("open")); }
      send(data) {
        const first = JSON.parse(data.split("\\x1e")[0]);
        if (first.protocol) queueMicrotask(() => this.emit("message", Buffer.from("{}\\x1e")));
        if (first.type === 4) queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify(finalFrame) + "\\x1e")));
      }
      close() {}
    }
    const ws = new SyntheticModule(["default"], function () { this.setExport("default", Socket); });
    await ws.link(() => { throw Error("unexpected transport import"); });
    await ws.evaluate();
    const helper = new SourceTextModule(readFileSync("scripts/_probe-chat.mjs", "utf8"), {
      importModuleDynamically: async (specifier) => {
        assert.match(specifier, /ws\\/wrapper\\.mjs$/);
        return ws;
      },
    });
    const url = new SyntheticModule(["pathToFileURL"], function () {
      this.setExport("pathToFileURL", (path) => ({ href: "file://" + path }));
    });
    const auth = new SyntheticModule(["getToken", "decodeJwt"], function () {
      this.setExport("getToken", async () => "synthetic-token");
      this.setExport("decodeJwt", () => ({ oid: "synthetic-account", tid: "synthetic-tenant" }));
    });
    await helper.link(() => url);
    await helper.evaluate();
    const sweep = new SourceTextModule(readFileSync("scripts/model-sweep-probe.mjs", "utf8"));
    await sweep.link((specifier) => specifier === "./_probe-chat.mjs" ? helper : specifier === "node:url" ? url : auth);
    await sweep.evaluate();
    const message = "Please try again later.";
    const shapes = [
      (item) => ({ type: 2, item }),
      (item) => ({ type: 2, item: [item] }),
      (item) => ({ type: 2, arguments: [{ item }] }),
    ];
    const receipts = [];
    for (const [index, shape] of shapes.entries()) {
      for (const verdict of [{ value: "Throttled" }, { value: "Error", errorCode: "PerUserThrottled" }]) {
        finalFrame = shape({ result: { ...verdict, message } });
        const summary = await helper.namespace.oneTurn({ token: "synthetic", claims: { oid: "fake", tid: "fake" }, text: "synthetic" });
        assert.equal(summary.fullText, message);
        assert.equal(summary.error, null);
        assert.equal("result" in summary, false);
        const before = sockets;
        const logs = [];
        await sweep.namespace.runSweep(["--only=Gpt_5_6_Chat,Gpt_5_6_Reasoning", "--gap=0"], (line) => logs.push(line));
        assert.equal(sockets - before, 1, "must not start a second conversation");
        assert.equal(logs.at(-1), "THROTTLED — stopping sweep");
        receipts.push({ shape: index, verdict, conversations: sockets - before, summary });
      }
    }
    console.log(JSON.stringify(receipts));
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 15000 });
  const receipts = JSON.parse(replay);
  expect(receipts).toHaveLength(6);
  expect(receipts.every((r) => r.conversations === 1 && !("result" in r.summary))).toBe(true);
});
