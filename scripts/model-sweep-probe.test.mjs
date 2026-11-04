import { afterEach, describe, expect, it, vi } from "vitest";

const wire = vi.hoisted(() => ({
  getToken: vi.fn(async () => "synthetic-token"),
  oneTurn: vi.fn(async () => ({ contentOrigin: "DeepLeo", fullText: "synthetic reply" })),
}));
vi.mock("../packages/core/dist/index.mjs", () => ({
  getToken: wire.getToken,
  decodeJwt: () => ({ oid: "synthetic-account", tid: "synthetic-tenant" }),
}));
vi.mock("./_probe-chat.mjs", () => ({ oneTurn: wire.oneTurn }));

// Bound the original script's eager entrypoint during the RED control too.
const savedArgv = process.argv;
process.argv = [...savedArgv.slice(0, 2), "--only=Gpt_5_6_Chat", "--gap=0"];
const { classify, runSweep } = await import("./model-sweep-probe.mjs").finally(() => {
  process.argv = savedArgv;
});

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

const options = ["--only=Gpt_5_6_Chat,Gpt_5_6_Reasoning", "--gap=0"];

describe("model-sweep-probe (offline)", () => {
  it("does not authenticate merely by being imported", () => {
    expect(wire.getToken).not.toHaveBeenCalled();
  });

  it.each(["--gap=-1", "--gap=NaN", "--gap=Infinity", "--gap=2147483648", "--only=unknown", "--only=", "--onlyy=Gpt_5_6_Chat", "--only", "--gap", "--gap=", "--only Gpt_5_6_Chat", "Gpt_5_6_Chat"])(
    "rejects invalid selection/pacing before auth: %s", async (arg) => {
      await expect(runSweep([arg, ...options], vi.fn())).rejects.toThrow();
      expect(wire.getToken).not.toHaveBeenCalled();
      expect(wire.oneTurn).not.toHaveBeenCalled();
    },
  );

  it("sends selected tones sequentially with the requested gap", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const run = runSweep([options[0], "--gap=8000"], log);
    await vi.advanceTimersByTimeAsync(0);
    expect(wire.oneTurn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7999);
    expect(wire.oneTurn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(wire.oneTurn.mock.calls.map(([o]) => o.tone)).toEqual(["Gpt_5_6_Chat", "Gpt_5_6_Reasoning"]);
    expect(wire.oneTurn.mock.calls[0][0]).toMatchObject({ scenario: "OfficeWebIncludedCopilot", licenseType: "Starter" });
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("does not mistake ordinary throttle usage or a non-final result for a refusal", async () => {
    wire.oneTurn.mockImplementationOnce(async ({ onFrame }) => {
      onFrame?.({ type: 1, item: { result: { value: "Throttled" } } });
      onFrame?.({ type: 2, item: {
        result: { value: "Success" },
        throttling: { numUserMessagesInConversation: 1, maxNumUserMessagesInConversation: 600 },
      } });
      return { contentOrigin: "DeepLeo", fullText: "synthetic reply", throttle: { current: 1, max: 600, metering: null } };
    });
    await runSweep(options, vi.fn());
    expect(wire.oneTurn).toHaveBeenCalledTimes(2);
  });

  const finalShapes = [
    ["item object", (item) => ({ type: 2, item })],
    ["item array", (item) => ({ type: 2, item: [item] })],
    ["arguments item", (item) => ({ type: 2, arguments: [{ item }] })],
  ];
  for (const [shape, frame] of finalShapes) {
    it.each([
      { value: "Throttled" },
      { value: "Error", errorCode: "PerUserThrottled" },
    ])(`stops on canonical ${shape} verdict %j without throttle words in human text`, async (verdict) => {
      const log = vi.fn();
      wire.oneTurn.mockImplementationOnce(async ({ onFrame }) => {
        const message = "Please try again later.";
        onFrame?.(frame({ result: { ...verdict, message } }));
        // oneTurn exposes the human message, NOT result.value/errorCode.
        return { fullText: message, deltaText: "", snapshotText: message,
          disengaged: false, messageTypes: [], contentOrigin: null, scores: {},
          throttle: null, serviceVersion: null, turnCount: null,
          elapsedMs: 1, frameCount: 2, error: null };
      });
      await runSweep(options, log);
      expect(wire.oneTurn).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenLastCalledWith("THROTTLED — stopping sweep");
    });
  }

  it.each([
    { error: "PerUserThrottled" },
    { fullText: "PerUserThrottled: please wait" },
    { error: "synthetic failure: PerUserThrottled" },
  ])("preserves throttle error/text fallback for %j", async (result) => {
    const log = vi.fn();
    wire.oneTurn.mockResolvedValueOnce(result);
    await runSweep(options, log);
    expect(wire.oneTurn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith("THROTTLED — stopping sweep");
  });

  it("preserves throttle detection for a rejected helper promise", async () => {
    const log = vi.fn();
    wire.oneTurn.mockRejectedValueOnce(new Error("PerUserThrottled"));
    await runSweep(options, log);
    expect(wire.oneTurn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith("THROTTLED — stopping sweep");
  });

  it("records a validator rejection and continues", async () => {
    const log = vi.fn();
    wire.oneTurn.mockResolvedValueOnce({ error: "Failed to invoke Chat: type:3 rejected" });
    await runSweep(options, log);
    expect(wire.oneTurn).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toMatch(/^REJECTED\s/);
  });

  it("records a failed cell and continues without claiming it is live", async () => {
    const log = vi.fn();
    wire.oneTurn.mockRejectedValueOnce(new Error("synthetic connection failure"));
    await runSweep(options, log);
    expect(wire.oneTurn).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toMatch(/^ERROR\s/);
  });

  it.each([
    [{ contentOrigin: "DeepLeo" }, "LIVE"],
    [{ contentOrigin: "BotConnection" }, "DEAD"],
    [{ error: "Failed to invoke Chat" }, "REJECTED"],
    [{ contentOrigin: "DeepLeo", disengaged: true }, "DISENGAGED"],
    [{ contentOrigin: "DeepLeo", error: "connection lost" }, "ERROR"],
    [{}, "?(none)"],
  ])("classifies %j as %s", (result, state) => {
    expect(classify(result)).toBe(state);
  });
});
