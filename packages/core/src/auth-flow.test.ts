import { describe, expect, it, vi } from "vitest";
import { awaitLoginCode, retryLogin } from "./auth-flow.js";

describe("awaitLoginCode", () => {
  it("returns the code when capture completes first", async () => {
    await expect(awaitLoginCode(Promise.resolve("oauth-code"), new Promise(() => {})))
      .resolves.toBe("oauth-code");
  });

  it("waits for the code after successful form driving", async () => {
    let resolveCode!: (value: string) => void;
    const code = new Promise<string>((resolve) => { resolveCode = resolve; });
    const result = awaitLoginCode(code, Promise.resolve());
    resolveCode("oauth-code");
    await expect(result).resolves.toBe("oauth-code");
  });

  it("propagates form failure and handles a later code-poll rejection", async () => {
    let rejectCode!: (reason: Error) => void;
    const code = new Promise<string>((_, reject) => { rejectCode = reject; });
    const result = awaitLoginCode(code, Promise.reject(new Error("form failed")));
    await expect(result).rejects.toThrow("form failed");
    // The rejection is intentionally later, after the caller has received the
    // form error. awaitLoginCode must already have attached a rejection handler.
    rejectCode(new Error("code polling stopped"));
  });

  it("propagates a code-poll failure", async () => {
    await expect(awaitLoginCode(Promise.reject(new Error("poll failed")), Promise.resolve()))
      .rejects.toThrow("poll failed");
  });
});

describe("retryLogin", () => {
  it("retries up to the configured count and returns the successful result", async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValue("token");
    const onFailure = vi.fn(async () => {});

    await expect(retryLogin(attempt, 3, onFailure)).resolves.toBe("token");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onFailure).toHaveBeenNthCalledWith(1, 1, expect.any(Error), true);
    expect(onFailure).toHaveBeenNthCalledWith(2, 2, expect.any(Error), true);
  });

  it("returns null after the final failed attempt without another retry", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("failed"));
    const onFailure = vi.fn(async () => {});

    await expect(retryLogin(attempt, 2, onFailure)).resolves.toBeNull();
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenNthCalledWith(2, 2, expect.any(Error), false);
  });
});
