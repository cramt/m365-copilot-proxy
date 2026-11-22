import { ImageGenerationRequest, RequestBodyError, handleImageGeneration, readRequestJson } from "@m365-copilot/proxy-lib";

export default defineEventHandler(async (event) => {
  const req = event.node.req;
  let body: ImageGenerationRequest;
  try {
    body = ImageGenerationRequest.parse(await readRequestJson(req, req.headers["content-length"]));
  } catch (err: any) {
    const status = err instanceof RequestBodyError ? err.status : 400;
    return new Response(
      JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }),
      { status, headers: { "Content-Type": "application/json", ...(status > 400 && { Connection: "close" }) } },
    );
  }

  // An image turn takes a while; stop it if the caller hangs up first.
  const ac = new AbortController();
  const res = event.node?.res;
  if (res) {
    let finished = false;
    res.once("finish", () => { finished = true; });
    req.once("close", () => { if (!finished && !res.writableEnded) ac.abort(); });
  }
  return handleImageGeneration(body, { signal: ac.signal });
});
