import { ChatCompletionRequest, handleChatCompletion, requestContext, RequestContextError } from "@m365-copilot/proxy-lib";
import { pool } from "../../../server-pool";

export default defineEventHandler(async (event) => {
  const req = event.node.req;
  const res = event.node.res;
  const ac = new AbortController();
  const cleanup = () => {
    req.off("aborted", abort); req.off("close", requestClose);
    res.off("close", responseClose); res.off("finish", cleanup);
  };
  const abort = () => { ac.abort(); cleanup(); };
  // IncomingMessage close also fires on a normally completed upload.
  const requestClose = () => { if (!req.complete) abort(); };
  const responseClose = () => { if (!res.writableFinished) abort(); else cleanup(); };
  req.once("aborted", abort); req.once("close", requestClose);
  res.once("close", responseClose); res.once("finish", cleanup);
  if (req.aborted || (res.destroyed && !res.writableFinished)) abort();

  // Validated by the first global native admission middleware. Fail closed if
  // this route is accidentally mounted without the application's ingress glue.
  const body = event.context.chatCompletionBody as ReturnType<typeof ChatCompletionRequest.parse> | undefined;
  if (!body) { cleanup(); throw new Error("Missing native request admission"); }
  // Conversation ownership and idempotency come from these headers (#107).
  const headers = new Headers();
  for (const name of ["x-claude-code-session-id", "x-opencode-session", "idempotency-key"]) {
    const value = getHeader(event, name);
    if (value !== undefined) headers.set(name, value);
  }
  try {
    return await handleChatCompletion(body, pool, { ...requestContext(body, headers), signal: ac.signal });
  } catch (err) {
    cleanup();
    if (err instanceof RequestContextError) return new Response(JSON.stringify({ error: { message: err.message, type: "invalid_request_error", code: err.code } }), { status: err.status, headers: { "Content-Type": "application/json" } });
    throw err;
  }
});
