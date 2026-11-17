import { ChatCompletionRequest, handleChatCompletion } from "@m365-copilot/proxy-lib";
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
  return handleChatCompletion(body, pool, {
    signal: ac.signal,
    userAgent: getRequestHeader(event, "user-agent"),
  });
});
