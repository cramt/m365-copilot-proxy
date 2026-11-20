// The probe helper's scenario pair and the probes' reading of licence refusals
// (hypotheses §49 F145, F146). No M365 turns: the helper's `ws` is a stand-in
// that records the URL the helper opens and ends the turn at once.
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const RS = "\x1e";
  const state = { urls: [] };
  class FakeWs {
    constructor(url) {
      state.urls.push(url);
      this.handlers = {};
      setTimeout(() => this.emit("open"), 0);
    }
    on(ev, fn) {
      (this.handlers[ev] ??= []).push(fn);
      return this;
    }
    emit(ev, ...a) {
      for (const fn of this.handlers[ev] ?? []) fn(...a);
    }
    send(data) {
      const reply = (o) => setTimeout(() => this.emit("message", Buffer.from(JSON.stringify(o) + RS)), 0);
      for (const f of data.split(RS).filter(Boolean)) {
        const frame = JSON.parse(f);
        if (frame.protocol === "json") reply({});
        // The turn itself: Chathub's `chat` invocation, StreamHub's `chat_request` item.
        if (frame.target === "chat") reply({ type: 2, invocationId: "0", item: { result: { value: "Success" } } });
        if (frame.item?.type === "chat_request") {
          reply({ type: 2, invocationId: "1", item: { type: "request_end", outcome: { category: "Success" } } });
        }
      }
    }
    close() {
      this.emit("close");
    }
  }
  return { state, FakeWs };
});
// The helper imports `ws` from this path (built from the cwd, the repo root).
vi.mock("../node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs", () => ({ default: fake.FakeWs }));

import { getStreamHubScenario } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";
import { classifyRow, isLicenceRefusal, outcome, selfId, summarize } from "./agent-tone-probe.mjs";

const VARS = ["M365_TRANSPORT", "M365_SCENARIO", "M365_LICENSE_TYPE"];
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
const setVars = (vars) => {
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, vars);
};

/** One helper turn against the stand-in; what its URL carried. */
async function sent(opts) {
  const before = fake.state.urls.length;
  const r = await oneTurn({ token: "token", claims: { oid: "oid-1", tid: "tid-1" }, text: "pong", timeoutMs: 5000, ...opts });
  const url = new URL(fake.state.urls[before]);
  return {
    transport: r.transport,
    host: url.host,
    pair: { scenario: url.searchParams.get("scenario"), licenseType: url.searchParams.get("licenseType") },
    result: r.result,
  };
}

describe("_probe-chat.mjs: the scenario pair a turn goes out under", () => {
  afterEach(() => {
    for (const k of VARS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
  });

  it("over StreamHub, with M365_SCENARIO / M365_LICENSE_TYPE unset: officeweb + Premium, the proxy's pair", async () => {
    setVars({});
    const s = await sent({ transport: "streamhub" });
    expect(s).toMatchObject({ transport: "streamhub", host: "substrate.svc.cloud.microsoft", result: { value: "Success" } });
    expect(s.pair).toEqual({ scenario: "officeweb", licenseType: "Premium" });
    expect(s.pair).toEqual(getStreamHubScenario());
  });

  it("over StreamHub, follows M365_SCENARIO / M365_LICENSE_TYPE as the proxy does (the included scenario a non-premium account needs)", async () => {
    setVars({ M365_SCENARIO: "OfficeWebIncludedCopilot", M365_LICENSE_TYPE: "Starter" });
    const s = await sent({ transport: "streamhub" });
    expect(s.pair).toEqual({ scenario: "OfficeWebIncludedCopilot", licenseType: "Starter" });
    expect(s.pair).toEqual(getStreamHubScenario());
  });

  it("over StreamHub, takes each variable on its own", async () => {
    setVars({ M365_SCENARIO: "OfficeWebIncludedCopilot" });
    expect((await sent({ transport: "streamhub" })).pair).toEqual({ scenario: "OfficeWebIncludedCopilot", licenseType: "Premium" });
    expect(getStreamHubScenario()).toEqual({ scenario: "OfficeWebIncludedCopilot", licenseType: "Premium" });
    setVars({ M365_LICENSE_TYPE: "Starter" });
    expect((await sent({ transport: "streamhub" })).pair).toEqual({ scenario: "officeweb", licenseType: "Starter" });
    expect(getStreamHubScenario()).toEqual({ scenario: "officeweb", licenseType: "Starter" });
  });

  it("under M365_TRANSPORT=streamhub, a probe that passes no transport or pair gets StreamHub and the variables' pair", async () => {
    setVars({ M365_TRANSPORT: "streamhub", M365_SCENARIO: "OfficeWebIncludedCopilot", M365_LICENSE_TYPE: "Starter" });
    const s = await sent({});
    expect(s.transport).toBe("streamhub");
    expect(s.pair).toEqual({ scenario: "OfficeWebIncludedCopilot", licenseType: "Starter" });
  });

  it("sends a pair the probe passes as it is, over the variables", async () => {
    setVars({ M365_SCENARIO: "OfficeWebIncludedCopilot", M365_LICENSE_TYPE: "Starter" });
    const s = await sent({ transport: "streamhub", scenario: "OfficeWebPaidCopilot", licenseType: "Premium" });
    expect(s.pair).toEqual({ scenario: "OfficeWebPaidCopilot", licenseType: "Premium" });
  });

  it("over Chathub, keeps its own default, the included scenario, whatever the variables", async () => {
    setVars({ M365_SCENARIO: "officeweb", M365_LICENSE_TYPE: "Premium" });
    const s = await sent({ transport: "chathub" });
    expect(s).toMatchObject({ transport: "chathub", host: "substrate.office.com", result: { value: "Success" } });
    expect(s.pair).toEqual({ scenario: "OfficeWebIncludedCopilot", licenseType: "Starter" });
  });
});

// A turn as agent-tone-probe's probeTurn records it.
const turn = (reply, { result = { value: "Success" }, answerOrigin = "DeepLeo", scenario = "OfficeWebIncludedCopilot", agentHandled = false } = {}) => ({
  scenario, licenseType: "Starter", transport: "streamhub",
  reply, id: selfId(reply), answerOrigin,
  origins: answerOrigin ? [answerOrigin] : [], agentNames: agentHandled ? ["3PDeclarativeAgent"] : [], agentHandled,
  result, disengaged: false, messageTypes: [], error: null, elapsedMs: 1000,
});
const CLAUDE_REFUSAL = "Claude isn't available with your current license. Choose another model and try again.";
const MODEL_REFUSAL = "This model requires a Premium license. Choose another model and try again.";
const SCENARIO_REFUSAL = "It looks like you don’t have a valid license. To get access, please check with your administrator.";

describe("licence refusals read as UNLICENSED (agent-tone-probe; tone-probe uses the same isLicenceRefusal)", () => {
  it("isLicenceRefusal: the scenario code and the two model codes, nothing else", () => {
    for (const errorCode of ["InvalidCopilotLicense", "ClaudeUnavailableForLicense", "PremiumModelUnavailableForLicense"]) {
      expect(isLicenceRefusal({ value: "ForbiddenRequest", errorCode })).toBe(true);
    }
    for (const result of [
      { value: "Success" },
      { value: "InternalError" },
      { value: "Throttled", errorCode: "PerUserThrottled" },
      { value: "InvalidRequest", errorCode: "InputTokenLimitExceeded" },
      { value: "InvalidRequest", errorCode: "InvalidNote" },
      null,
      undefined,
    ]) {
      expect(isLicenceRefusal(result)).toBe(false);
    }
  });

  it("a model refused by licence is UNLICENSED, not AGENT_DROPPED, and takes no self-ID from the refusal", () => {
    const claude = turn(CLAUDE_REFUSAL, { result: { value: "ForbiddenRequest", errorCode: "ClaudeUnavailableForLicense" }, answerOrigin: null });
    const gpt = turn(MODEL_REFUSAL, { result: { value: "ForbiddenRequest", errorCode: "PremiumModelUnavailableForLicense" }, answerOrigin: null });
    expect(outcome(claude)).toBe("UNLICENSED");
    expect(outcome(gpt)).toBe("UNLICENSED");
    const rows = [classifyRow({ tone: "Claude_Sonnet", note: "" }, claude, null), classifyRow({ tone: "Gpt_61_Sol_Reasoning", note: "" }, gpt, null)];
    expect(rows.map((r) => r.verdict)).toEqual(["UNLICENSED", "UNLICENSED"]);
    const out = summarize({ account: null, baseline: false, results: rows }).join("\n");
    expect(out).toContain("doesn't cover Claude_Sonnet (ClaudeUnavailableForLicense), Gpt_61_Sol_Reasoning (PremiumModelUnavailableForLicense)");
    expect(out).not.toContain("self-ID=");
    expect(out).not.toContain("can't use");
  });

  it("a scenario refused by licence is UNLICENSED, and the summary names the scenario", () => {
    const refused = turn(SCENARIO_REFUSAL, { result: { value: "ForbiddenRequest", errorCode: "InvalidCopilotLicense" }, answerOrigin: "MaestroGrain", scenario: "officeweb" });
    const row = classifyRow({ tone: "Gpt_5_5_Chat", note: "" }, refused, null);
    expect(row.verdict).toBe("UNLICENSED");
    const out = summarize({ account: null, baseline: false, results: [row] }).join("\n");
    expect(out).toContain("can't use officeweb at all (InvalidCopilotLicense)");
    expect(out).not.toContain("doesn't cover");
  });

  it("leaves the other verdicts as they were", () => {
    const answered = turn("I am Microsoft Copilot, powered by the GPT-5 chat model from OpenAI.");
    expect(classifyRow({ tone: "magic", note: "" }, answered, null).verdict).toBe("AGENT_DROPPED");
    expect(classifyRow({ tone: "magic", note: "" }, { ...answered, agentHandled: true }, null).verdict).toBe("SUPPORTED");
    expect(outcome(turn("", { result: { value: "Throttled", errorCode: "PerUserThrottled" }, answerOrigin: null }))).toBe("THROTTLED");
    expect(outcome(turn("Sorry, I wasn't able to respond to that.", { result: { value: "InternalError" }, answerOrigin: "BotConnection" }))).toBe("REGISTERED_BUT_DEAD");
  });
});
