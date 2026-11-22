import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@m365-copilot/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@m365-copilot/core")>(),
  runtimeCatalog: vi.fn(async () => ["gpt-6.2-astra", "gpt-6.2-sol-substrate"]),
}));

import { buildModelsPayload } from "./index.js";

afterEach(() => vi.unstubAllEnvs());

describe("model input capabilities", () => {
  it("advertises images for Chat aliases and backend-labelled models", async () => {
    vi.stubEnv("M365_BACKENDS", "chat,cowork,code");
    vi.stubEnv("M365_DEFAULT_BACKEND", "chat");
    const { data } = await buildModelsPayload();
    for (const id of ["gpt-6.2-astra", "claude-sonnet-5.5", "gpt-6.2-astra(chat)_272k_credit"]) {
      expect(data.find((m) => m.id === id)?.input_modalities).toEqual(["text", "image"]);
    }
  });

  it("keeps Cowork and Code models text-only without changing their windows", async () => {
    vi.stubEnv("M365_BACKENDS", "chat,cowork,code");
    vi.stubEnv("M365_DEFAULT_BACKEND", "chat");
    const { data } = await buildModelsPayload();
    for (const backend of ["cowork", "code"]) {
      expect(data.find((m) => m.id === `gpt-6.2-astra(${backend})_885k_credit`)).toMatchObject({
        input_modalities: ["text"],
        context_window: 885_000,
      });
    }
  });

  it("uses the resolved backend when an alias defaults to Cowork", async () => {
    vi.stubEnv("M365_BACKENDS", "chat,cowork,code");
    vi.stubEnv("M365_DEFAULT_BACKEND", "cowork");
    const { data } = await buildModelsPayload();
    expect(data.find((m) => m.id === "gpt-6.2-astra")?.input_modalities).toEqual(["text"]);
    expect(data.find((m) => m.id === "gpt-6.2-astra(chat)_272k_credit")?.input_modalities).toEqual(["text", "image"]);
  });
});
