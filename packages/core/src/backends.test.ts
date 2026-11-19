import { afterEach, describe, expect, it } from "vitest";
import {
  enabledBackends,
  formatModelId,
  formatWindow,
  listModelEntries,
  resolveModelRoute,
} from "./backends.js";
import { getAvailableModels } from "./copilot.js";

afterEach(() => {
  delete process.env.M365_BACKENDS;
  delete process.env.M365_DEFAULT_BACKEND;
});

describe("model IDs with a backend", () => {
  it("names the backend, the measured window and credits", () => {
    expect(formatModelId({ base: "gpt-6.2-sol", backend: "chat", window: 272_000, credits: false })).toBe("gpt-6.2-sol(chat)_272k");
    expect(formatModelId({ base: "gpt-6.2-sol", backend: "cowork", window: 800_000, credits: true })).toBe("gpt-6.2-sol(cowork)_800k_credit");
    expect(formatModelId({ base: "gpt-5.5", backend: "chat", credits: false })).toBe("gpt-5.5(chat)");
    expect(formatWindow(1_000_000)).toBe("1m");
  });

  it("keeps an ID without a backend on Chat, unchanged", () => {
    expect(resolveModelRoute("gpt-6.2-sol")).toEqual({ requested: "gpt-6.2-sol", backend: "chat", model: "gpt-6.2-sol" });
    expect(resolveModelRoute("claude-opus-5[1m]").model).toBe("claude-opus-5[1m]");
  });

  it("routes on the parentheses and ignores the suffixes after them", () => {
    process.env.M365_BACKENDS = "chat,cowork,code";
    expect(resolveModelRoute("gpt-6.2-sol(chat)_272k")).toMatchObject({ backend: "chat", model: "gpt-6.2-sol" });
    expect(resolveModelRoute("gpt-6.1-sol(cowork)_1m_credit")).toMatchObject({ backend: "cowork", model: "gpt-6.1-sol", runtimeModel: "gpt-6.1-sol-substrate" });
    // The runtime's own ID works too, and an ID the table doesn't know goes through as sent.
    expect(resolveModelRoute("opus-5.5(code)")).toMatchObject({ backend: "code", model: "claude-opus-5.5", runtimeModel: "opus-5.5" });
    expect(resolveModelRoute("gpt-7(cowork)")).toMatchObject({ backend: "cowork", model: "gpt-7", runtimeModel: "gpt-7" });
  });

  it("refuses a credit-spending backend that M365_BACKENDS doesn't enable, but always serves Chat", () => {
    process.env.M365_BACKENDS = "chat";
    expect(resolveModelRoute("gpt-6.2-sol(cowork)").error).toMatch(/M365_BACKENDS/);
    process.env.M365_BACKENDS = "cowork";
    expect(resolveModelRoute("gpt-6.2-sol(chat)").error).toBeUndefined();
    expect(resolveModelRoute("gpt-6.2-sol(code)").error).toMatch(/code backend isn't enabled/);
  });

  it("sends an ID without a backend to M365_DEFAULT_BACKEND when that backend serves the model", () => {
    process.env.M365_BACKENDS = "chat,cowork";
    process.env.M365_DEFAULT_BACKEND = "cowork";
    expect(resolveModelRoute("claude-sonnet-5.5")).toMatchObject({ backend: "cowork", runtimeModel: "sonnet-5.5" });
    expect(resolveModelRoute("claude-sonnet-5")).toMatchObject({ backend: "chat", model: "claude-sonnet-5" });
    // A default backend that isn't enabled changes nothing.
    process.env.M365_DEFAULT_BACKEND = "code";
    expect(resolveModelRoute("claude-sonnet-5.5").backend).toBe("chat");
  });

  it("reads M365_BACKENDS leniently, and lists all three backends by default", () => {
    expect(enabledBackends()).toEqual(["chat", "cowork", "code"]);
    process.env.M365_BACKENDS = " Cowork, chat,cowork,bogus ";
    expect(enabledBackends()).toEqual(["cowork", "chat"]);
    process.env.M365_BACKENDS = "bogus";
    expect(enabledBackends()).toEqual(["chat"]);
  });

  it("lists only what the runtime's catalog has, when it's given", () => {
    const ids = listModelEntries(["cowork"], ["opus-5.5", "sonnet-5.5", "gpt-7"]).map(formatModelId);
    expect(ids).toEqual(["claude-opus-5.5(cowork)_640k_credit", "claude-sonnet-5.5(cowork)_640k_credit", "gpt-7(cowork)_credit"]);
    expect(listModelEntries(["cowork"], null).length).toBeGreaterThan(3); // no catalog: the whole table
  });

  it("lists only real Chat models, and every listed ID routes back to its entry", () => {
    process.env.M365_BACKENDS = "chat,cowork,code";
    const chatIds = new Set(getAvailableModels());
    for (const entry of listModelEntries()) {
      if (entry.backend === "chat") expect(chatIds).toContain(entry.base);
      else expect(entry.credits).toBe(true);
      expect(resolveModelRoute(formatModelId(entry))).toMatchObject({ backend: entry.backend, model: entry.base });
    }
  });
});
