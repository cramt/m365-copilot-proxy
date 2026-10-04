import { describe, it, expect } from "vitest";
import { createBackoffController } from "./auth-recovery.js";

function setup(overrides: Record<string, unknown> = {}) {
  let t = 0;
  const slept: number[] = [];
  const controller = createBackoffController({
    now: () => t,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        slept.push(ms);
        resolve();
      }),
    rng: () => 0, // deterministic: jitter lands at jitterMinMs
    windowMs: 1000,
    threshold: 3,
    baseCooldownMs: 5000,
    maxCooldownMs: 60000,
    jitterMinMs: 100,
    jitterMaxMs: 100,
    ...overrides,
  });
  return {
    controller,
    slept,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createBackoffController", () => {
  it("starts backoff on the first explicit throttle and exposes a decreasing retry delay", () => {
    const { controller, advance } = setup();
    expect(controller.retryAfterSeconds()).toBe(0);
    controller.noteThrottle();
    expect(controller.isBackingOff()).toBe(true);
    expect(controller.retryAfterSeconds()).toBe(5);
    advance(1001);
    expect(controller.retryAfterSeconds()).toBe(4);
    controller.noteThrottle();
    expect(controller.retryAfterSeconds()).toBe(4);
    advance(3999);
    expect(controller.retryAfterSeconds()).toBe(0);
    controller.noteThrottle();
    expect(controller.retryAfterSeconds()).toBe(10);
    controller.note(false, "recovered");
    expect(controller.retryAfterSeconds()).toBe(0);
  });

  it("caps repeated explicit throttle backoff windows", () => {
    const { controller, advance } = setup({ maxCooldownMs: 10000 });
    controller.noteThrottle();
    advance(5000);
    controller.noteThrottle();
    advance(10000);
    controller.noteThrottle();
    expect(controller.retryAfterSeconds()).toBe(10);
  });

  it("does not back off below the distinct-conversation threshold", async () => {
    const { controller, slept } = setup();
    controller.note(true, "c1");
    controller.note(true, "c2");
    expect(controller.isBackingOff()).toBe(false);
    expect(await controller.waitForSlot()).toBe(0);
    expect(slept).toEqual([]);
  });

  it("enters backoff once enough DISTINCT conversations go empty within the window", async () => {
    const { controller, slept } = setup();
    controller.note(true, "c1");
    controller.note(true, "c2");
    controller.note(true, "c3");
    expect(controller.isBackingOff()).toBe(true);
    const delay = await controller.waitForSlot();
    expect(delay).toBe(100); // jitterMin, rng()=0
    expect(slept).toEqual([100]);
  });

  it("does NOT count repeated empties in the SAME conversation", () => {
    const { controller } = setup();
    controller.note(true, "c1");
    controller.note(true, "c1");
    controller.note(true, "c1");
    expect(controller.isBackingOff()).toBe(false);
  });

  it("a clean response lifts the backoff immediately", async () => {
    const { controller } = setup();
    controller.note(true, "c1");
    controller.note(true, "c2");
    controller.note(true, "c3");
    expect(controller.isBackingOff()).toBe(true);
    controller.note(false, "c3"); // recovered
    expect(controller.isBackingOff()).toBe(false);
    expect(await controller.waitForSlot()).toBe(0);
  });

  it("waitForSlot is a no-op after the backoff window elapses", async () => {
    const { controller, advance, slept } = setup();
    controller.note(true, "c1");
    controller.note(true, "c2");
    controller.note(true, "c3");
    advance(5001); // past baseCooldownMs
    expect(controller.isBackingOff()).toBe(false);
    expect(await controller.waitForSlot()).toBe(0);
    expect(slept).toEqual([]);
  });

  it("escalates the cooldown on repeated triggers", () => {
    const { controller, advance } = setup();
    controller.note(true, "a1");
    controller.note(true, "a2");
    controller.note(true, "a3"); // level 1 → 5000ms window
    advance(5001); // window elapsed
    expect(controller.isBackingOff()).toBe(false);
    controller.note(true, "b1");
    controller.note(true, "b2");
    controller.note(true, "b3"); // level 2 → 10000ms window
    advance(5001);
    expect(controller.isBackingOff()).toBe(true); // still backing off (10s > 5s)
    advance(5000);
    expect(controller.isBackingOff()).toBe(false);
  });

  it("does not re-arm/stack the window while already backing off", () => {
    const { controller, advance } = setup();
    controller.note(true, "a1");
    controller.note(true, "a2");
    controller.note(true, "a3"); // backoff until t=5000
    advance(1000);
    controller.note(true, "b1");
    controller.note(true, "b2");
    controller.note(true, "b3"); // ignored — still within window, no escalation
    advance(4001); // t=5001, past the ORIGINAL window
    expect(controller.isBackingOff()).toBe(false);
  });

  it("drops empties that fall outside the window", () => {
    const { controller } = setup();
    controller.note(true, "c1");
    // advance beyond windowMs via a fresh controller clock
    const { controller: c2, advance } = setup();
    c2.note(true, "c1");
    advance(2000); // > windowMs (1000) → c1 expires
    c2.note(true, "c2");
    c2.note(true, "c3");
    expect(c2.isBackingOff()).toBe(false); // only 2 in-window
    void controller;
  });

  it("caps a single paced delay at the remaining backoff window", async () => {
    const { controller, advance } = setup({ jitterMinMs: 3000, jitterMaxMs: 3000 });
    controller.note(true, "c1");
    controller.note(true, "c2");
    controller.note(true, "c3"); // window until t=5000
    advance(4000); // 1000ms remaining, but jitter wants 3000
    const delay = await controller.waitForSlot();
    expect(delay).toBe(1000); // capped at remaining
  });
});
