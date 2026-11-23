import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The Entra sign-in origins that can ask the browser for a TLS client certificate.
 * Which of them asks depends on the tenant and its policies, so the certificate is
 * offered to all of them; the browser presents it only to an origin that asks.
 */
export const CLIENT_CERT_ORIGINS = [
  "https://certauth.login.microsoftonline.com",
  "https://certauth.login.microsoftonline.us",
  "https://device.login.microsoftonline.com",
] as const;

/** One entry of Playwright's `clientCertificates` context option. */
export interface ClientCertificate {
  origin: string;
  pfxPath: string;
  passphrase?: string;
}

/**
 * Playwright `clientCertificates` for the PKCS#12 bundle that secrets.json names in
 * `clientCertPath` (its password in `clientCertPassword`), one entry per origin in
 * `CLIENT_CERT_ORIGINS`. Undefined when no certificate is configured. A relative
 * path is read from `secretsDir`, the directory holding secrets.json; `~/` is the
 * home directory.
 *
 * Throws when the file does not exist. Without this check the login would fail later,
 * at the step that needs the certificate, with an error that does not name it.
 */
export function clientCertificatesFrom(
  secrets: Record<string, unknown> | null,
  secretsDir: string,
  fileExists: (path: string) => boolean = existsSync,
): ClientCertificate[] | undefined {
  const rawPath = secrets?.clientCertPath;
  if (rawPath === undefined || rawPath === null || rawPath === "") return undefined;
  if (typeof rawPath !== "string") {
    throw new Error("secrets.json: clientCertPath must be a string");
  }
  const password = secrets?.clientCertPassword;
  if (password !== undefined && password !== null && typeof password !== "string") {
    throw new Error("secrets.json: clientCertPassword must be a string");
  }
  const pfxPath = rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : resolve(secretsDir, rawPath);
  if (!fileExists(pfxPath)) {
    throw new Error(`secrets.json: clientCertPath names a file that does not exist: ${pfxPath}`);
  }
  return CLIENT_CERT_ORIGINS.map((origin) => ({
    origin,
    pfxPath,
    ...(typeof password === "string" ? { passphrase: password } : {}),
  }));
}
