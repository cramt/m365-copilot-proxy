import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLIENT_CERT_ORIGINS, clientCertificatesFrom } from "./client-cert.js";

const SECRETS_DIR = "/config/opencode-m365";
const exists = () => true;

describe("clientCertificatesFrom", () => {
  it("returns nothing when secrets.json names no certificate", () => {
    expect(clientCertificatesFrom(null, SECRETS_DIR, exists)).toBeUndefined();
    expect(clientCertificatesFrom({ email: "a@b.c" }, SECRETS_DIR, exists)).toBeUndefined();
    expect(clientCertificatesFrom({ clientCertPath: "" }, SECRETS_DIR, exists)).toBeUndefined();
  });

  it("offers the PKCS#12 bundle with its password to every certificate origin", () => {
    const certs = clientCertificatesFrom(
      { clientCertPath: "/certs/device.p12", clientCertPassword: "pw" },
      SECRETS_DIR,
      exists,
    );
    expect(certs?.map((c) => c.origin)).toEqual([...CLIENT_CERT_ORIGINS]);
    for (const cert of certs ?? []) {
      expect(cert).toEqual({ origin: cert.origin, pfxPath: "/certs/device.p12", passphrase: "pw" });
    }
  });

  it("covers the commercial and US Government CBA origins and the device origin", () => {
    expect(CLIENT_CERT_ORIGINS).toEqual([
      "https://certauth.login.microsoftonline.com",
      "https://certauth.login.microsoftonline.us",
      "https://device.login.microsoftonline.com",
    ]);
  });

  it("omits the passphrase when no password is configured, and keeps an empty one", () => {
    const [noPassword] = clientCertificatesFrom({ clientCertPath: "/c.p12" }, SECRETS_DIR, exists) ?? [];
    expect(noPassword).not.toHaveProperty("passphrase");
    const [empty] = clientCertificatesFrom({ clientCertPath: "/c.p12", clientCertPassword: "" }, SECRETS_DIR, exists) ?? [];
    expect(empty?.passphrase).toBe("");
  });

  it("reads a relative path from the secrets directory and expands ~/", () => {
    const [relative] = clientCertificatesFrom({ clientCertPath: "certs/c.p12" }, SECRETS_DIR, exists) ?? [];
    expect(relative?.pfxPath).toBe(join(SECRETS_DIR, "certs/c.p12"));
    const [home] = clientCertificatesFrom({ clientCertPath: "~/certs/c.p12" }, SECRETS_DIR, exists) ?? [];
    expect(home?.pfxPath).toBe(join(homedir(), "certs/c.p12"));
  });

  it("fails loudly when the configured file is missing or a field has the wrong type", () => {
    expect(() => clientCertificatesFrom({ clientCertPath: "/missing.p12" }, SECRETS_DIR, () => false)).toThrow(
      "does not exist: /missing.p12",
    );
    expect(() => clientCertificatesFrom({ clientCertPath: 12 }, SECRETS_DIR, exists)).toThrow("must be a string");
    expect(() =>
      clientCertificatesFrom({ clientCertPath: "/c.p12", clientCertPassword: 1234 }, SECRETS_DIR, exists),
    ).toThrow("clientCertPassword must be a string");
  });
});
