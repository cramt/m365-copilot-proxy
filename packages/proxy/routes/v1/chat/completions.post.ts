import { ChatCompletionRequest, handleChatCompletion, requestContext, RequestContextError } from "@m365-copilot/proxy-lib";
import { pool } from "../../../server-pool";

export default defineEventHandler(async (event) => {
  let body: ReturnType<typeof ChatCompletionRequest.parse>;
  try {
    body = ChatCompletionRequest.parse(await readBody(event));
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Propagate client disconnects as an AbortSignal so a long M365 turn gets
  // cancelled (Stop frame) instead of running on after the caller gave up.
  // Only abort on a *premature* close — guard with the response "finish" event
  // so a normal keep-alive socket close after a completed response is ignored.
  const ac = new AbortController();
  const req = event.node?.req;
  const res = event.node?.res;
  if (req && res) {
    let finished = false;
    res.once("finish", () => { finished = true; });
    const maybeAbort = () => { if (!finished && !res.writableEnded) ac.abort(); };
    req.once("close", maybeAbort);
    res.once("close", maybeAbort);
  }

  // handleChatCompletion returns a Web Response (JSON or an SSE ReadableStream
  // when stream:true). Returning it directly lets h3 forward it untouched.
  const headers = new Headers();
  for (const name of ["x-claude-code-session-id", "x-opencode-session", "idempotency-key"]) {
    const value = getHeader(event, name);
    if (value !== undefined) headers.set(name, value);
  }
  try {
    return await handleChatCompletion(body, pool, { ...requestContext(body, headers), signal: ac.signal });
  } catch (err) {
    if (err instanceof RequestContextError) return new Response(JSON.stringify({ error: { message: err.message, type: "invalid_request_error", code: err.code } }), { status: err.status, headers: { "Content-Type": "application/json" } });
    throw err;
  }
});
