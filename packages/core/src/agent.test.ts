import { describe, it, expect } from "vitest";
import { environmentUrlFromName } from "./agent.js";

describe("environmentUrlFromName", () => {
  it("splits the last two env-ID chars into their own DNS label", () => {
    expect(environmentUrlFromName("Default-fa7f56d8-49c4-4327-b816-9a0eeaa273df")).toBe(
      "https://defaultfa7f56d849c44327b8169a0eeaa273.df.environment.api.powerplatform.com",
    );
  });

  // Regression: the old hardcoded `.df.` only worked for IDs ending in "df".
  it("uses the real trailing chars, not a hardcoded `.df.`", () => {
    expect(environmentUrlFromName("Default-906AEFE9-76A7-4F65-B82D-5EC20775D5A1")).toBe(
      "https://default906aefe976a74f65b82d5ec20775d5.a1.environment.api.powerplatform.com",
    );
  });

  it("rejects a degenerate env ID", () => {
    expect(() => environmentUrlFromName("Default-")).toThrow(/Unexpected/);
  });
});
