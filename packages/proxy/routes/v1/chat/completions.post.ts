import { ChatCompletionRequest, RequestBodyError, handleChatCompletion, readRequestJson } from "@m365-copilot/proxy-lib";
import { pool } from "../../../server-pool";

export default defineEventHandler(async (event) => {
  const req = event.node.req;
  let body: ReturnType<typeof ChatCompletionRequest.parse>;
  try {
    body = ChatCompletionRequest.parse(await readRequestJson(req, req.headers["content-length"]));
  } catch (err: any) {
    // The cors.ts middleware has already set the CORS headers; h3 keeps them on a returned Response.
    // After a 413 or 408 the client may still be sending, so the connection closes.
    const status = err instanceof RequestBodyError ? err.status : 400;
    return new Response(
      JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }),
      { status, headers: { "Content-Type": "application/json", ...(status > 400 && { Connection: "close" }) } },
    );
  }

  // Propagate client disconnects as an AbortSignal so a long M365 turn gets
  // cancelled (Stop frame) instead of running on after the caller gave up.
  // Only abort on a *premature* close — guard with the response "finish" event
  // so a normal keep-alive socket close after a completed response is ignored.
  const ac = new AbortController();
  const res = event.node?.res;
  if (res) {
    let finished = false;
    res.once("finish", () => { finished = true; });
    const maybeAbort = () => { if (!finished && !res.writableEnded) ac.abort(); };
    req.once("close", maybeAbort);
    res.once("close", maybeAbort);
  }

  // handleChatCompletion returns a Web Response (JSON or an SSE ReadableStream
  // when stream:true). Returning it directly lets h3 forward it untouched.
  return handleChatCompletion(body, pool, {
    signal: ac.signal,
    userAgent: req.headers["user-agent"],
  });
});
