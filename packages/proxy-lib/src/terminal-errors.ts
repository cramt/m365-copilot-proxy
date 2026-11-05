export interface UpstreamRefusal {
  errorCode?: string;
  message?: string;
}

/** A terminal result must not be amplified by an SDK's independent retry loop. */
export function terminalErrorResponse(
  status: number,
  error: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { ...error, retryable: false } }), {
    status,
    headers: { "Content-Type": "application/json", ...headers, "x-should-retry": "false" },
  });
}

const MODEL_LICENCE_CODES = new Set([
  "PremiumModelUnavailableForLicense",
  "ClaudeUnavailableForLicense",
]);

/** Keep model entitlement, account entitlement and unknown denials distinct. */
export function forbiddenResponse(model: string, result: UpstreamRefusal): Response {
  const upstreamCode = result.errorCode && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(result.errorCode)
    ? result.errorCode : undefined;
  const accountDenied = upstreamCode === "InvalidCopilotLicense";
  const modelDenied = upstreamCode !== undefined && MODEL_LICENCE_CODES.has(upstreamCode);
  return terminalErrorResponse(403, {
    message: accountDenied
      ? "M365 Copilot is not licensed for this account."
      : modelDenied
        ? `M365 Copilot does not serve ${JSON.stringify(model)} with this account's licence.`
        : "M365 Copilot denied this request. The result does not establish a model-specific licence failure.",
    type: "permission_error",
    code: accountDenied ? "m365_account_not_licensed" : modelDenied ? "m365_model_not_licensed" : "m365_forbidden",
    ...(modelDenied ? { param: model } : {}),
    ...(upstreamCode ? { m365_error_code: upstreamCode } : {}),
  });
}

export function disengagedResponse(): Response {
  return terminalErrorResponse(403, {
    message: "M365 Copilot declined this request (Disengaged). This marker alone does not identify a content-policy violation. The proxy did not retry or reframe the request.",
    type: "permission_error",
    code: "m365_request_declined",
    m365_message_type: "Disengaged",
  });
}
