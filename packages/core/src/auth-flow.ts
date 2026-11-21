/** Race OAuth-code capture against form driving without leaving a rejection unhandled. */
export async function awaitLoginCode<T>(codePromise: Promise<T>, loginPromise: Promise<void>): Promise<T> {
  const codeResult = codePromise.then(
    (code) => ({ kind: "code" as const, code }),
    (error) => ({ kind: "code-error" as const, error }),
  );
  const loginResult = loginPromise.then(
    () => ({ kind: "login-ok" as const }),
    (error) => ({ kind: "login-error" as const, error }),
  );
  const first = await Promise.race([codeResult, loginResult]);
  if (first.kind === "code") return first.code;
  if (first.kind === "code-error") throw first.error;
  if (first.kind === "login-error") throw first.error;
  return codePromise;
}

/** Retry an operation, invoking onRetry between failed attempts. */
export async function retryLogin<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  attempts: number,
  onFailure: (attemptNumber: number, error: unknown, willRetry: boolean) => Promise<void>,
): Promise<T | null> {
  for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber++) {
    try {
      return await attempt(attemptNumber);
    } catch (error) {
      const willRetry = attemptNumber < attempts;
      await onFailure(attemptNumber, error, willRetry);
      if (!willRetry) break;
    }
  }
  return null;
}
