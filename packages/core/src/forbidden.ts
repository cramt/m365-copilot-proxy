/** Only documented ForbiddenRequest codes may be disclosed in errors or logs. */
export function publicForbiddenCode(code: unknown): string | undefined {
  switch (code) {
    case "PremiumModelUnavailableForLicense":
    case "ClaudeUnavailableForLicense":
    case "InvalidCopilotLicense":
      return code;
    default:
      return undefined;
  }
}
