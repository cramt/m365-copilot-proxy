import type { IncomingMessage } from "node:http";

/** Cancellation pauses/detaches, never destroys the socket needed for the reply. */
export function incomingRequestBody(req: IncomingMessage): ReadableStream<Uint8Array> {
  let detach = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const cleanup = () => {
        req.off("data", data); req.off("end", end);
        req.off("error", fail); req.off("aborted", aborted); req.off("close", close);
      };
      const data = (chunk: Buffer) => {
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 0) <= 0) req.pause();
      };
      const end = () => { if (closed) return; closed = true; cleanup(); controller.close(); };
      const fail = (error: Error) => { if (closed) return; closed = true; cleanup(); controller.error(error); };
      const aborted = () => fail(new Error("Request body aborted"));
      const close = () => { if (!req.complete) aborted(); };
      detach = () => { if (closed) return; closed = true; cleanup(); req.pause(); };
      req.on("data", data); req.once("end", end);
      req.once("error", fail); req.once("aborted", aborted); req.once("close", close);
      if (req.readableEnded) end();
      else if (req.destroyed) aborted();
    },
    pull() { req.resume(); },
    cancel() { detach(); },
  });
}
