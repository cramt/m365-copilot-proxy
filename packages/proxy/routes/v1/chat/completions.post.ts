import { ChatCompletionRequest, handleChatCompletion } from "@m365-copilot/proxy-lib";
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
  try {
    return await handleChatCompletion(body, pool, { signal: ac.signal });
  } catch (error) {
    cleanup();
    throw error;
  }
});
