import type { Socket } from "node:net";
import { ChatCompletionRequest, readRequestJson, requestBodyErrorResponse } from "@m365-copilot/proxy-lib";
import { incomingRequestBody } from "../incoming-body";

// This is the first global middleware, not a route wrapper: Node may emit the
// next request in the same parser turn, before asynchronous validation finishes.
interface Admission {
  pending?: Promise<boolean>;
  release?: (accepted: boolean) => void;
  refused: boolean;
  waiting: number;
  abort?: AbortController;
}
const sockets = new WeakMap<Socket, Admission>();
const MAX_WAITING = 16;

export default defineEventHandler(async (event) => {
  const { req, res } = event.node;
  const socket = req.socket;
  let state = sockets.get(socket);
  if (!state) {
    state = { refused: false, waiting: 0 };
    sockets.set(socket, state);
  }
  // Bound the number of native requests retained behind an upload. There is no
  // application queue, and all waiters share the same validation promise.
  if (state.pending && !state.refused) {
    if (++state.waiting > MAX_WAITING) {
      state.refused = true;
      state.abort?.abort();
    }
    try {
      while (state.pending && !state.refused) await state.pending;
    } finally { state.waiting--; }
  }
  if (state.refused || socket.destroyed) {
    res.end(); // handled, without entering any later middleware or route
    return;
  }
  // H3's app has already decoded event.path (preserving encoded separators).
  // Its router strips the query; radix3 removes exactly one trailing slash.
  // Use that same path: URL parsing would additionally normalize dot segments,
  // while decoding again or collapsing slashes would admit non-routes.
  const path = event.path.split("?", 1)[0].replace(/\/$/, "");
  if (req.method !== "POST" || path !== "/v1/chat/completions") return;

  const ac = new AbortController();
  state.abort = ac;
  state.pending = new Promise<boolean>(resolve => { state.release = resolve; });
  const abort = () => ac.abort();
  const responseClose = () => { if (!res.writableFinished) abort(); };
  req.once("aborted", abort);
  res.once("close", responseClose);
  if (req.aborted || socket.destroyed) abort();
  try {
    event.context.chatCompletionBody = ChatCompletionRequest.parse(
      await readRequestJson(incomingRequestBody(req), req.headers["content-length"], ac.signal),
    );
    if (state.refused) throw new Error("HTTP pipeline admission limit exceeded");
    const release = state.release!;
    state.pending = undefined;
    state.release = undefined;
    release(true); // admission ends here, not at inference/SSE completion
  } catch (error) {
    state.refused = true;
    req.pause();
    res.shouldKeepAlive = false;
    const response = requestBodyErrorResponse(error);
    response.headers.set("Connection", "close");
    res.once("finish", () => socket.destroySoon());
    state.release!(false);
    state.pending = undefined;
    state.release = undefined;
    return response;
  } finally {
    state.abort = undefined;
    req.off("aborted", abort);
    res.off("close", responseClose);
  }
});
