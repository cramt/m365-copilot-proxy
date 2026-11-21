import { EventEmitter } from "node:events";
export const wire = { sockets: [] as Socket[], texts: [] as string[], answer: "visible answer", hold: false, replies: [] as (() => void)[], onChat: undefined as (() => void) | undefined, failFirst: false, result: undefined as undefined | { value: string; errorCode?: string; message?: string } };
export default class Socket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  constructor(readonly url: string) {
    super(); wire.sockets.push(this);
    queueMicrotask(() => { if (wire.failFirst) { wire.failFirst = false; this.emit("error", new Error("synthetic transport failure")); } else { this.emit("open"); this.frame({}); } });
  }
  frame(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value) + "\x1e")); }
  send(raw: string) {
    for (const part of raw.split("\x1e").filter(Boolean)) {
      const frame = JSON.parse(part);
      const isStream = frame.type === 2 && frame.item?.type === "chat_request";
      if (frame.target !== "chat" && !isStream) continue;
      wire.texts.push(isStream ? frame.item.chatStreamRequest.message.text : frame.arguments[0].message.text);
      wire.onChat?.();
      const reply = () => {
        if (isStream) {
          this.frame({ type: 2, item: { type: "message_part", argument: { messages: [{ author: "bot", text: wire.answer, messageId: "m" }] } } });
          const r = wire.result ?? { value: "Success" };
          this.frame({ type: 2, item: { type: "request_end", outcome: { category: r.value, errorCode: r.errorCode, message: r.message } } });
        } else {
          this.frame({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", text: wire.answer, messageId: "m" }] }] });
          this.frame({ type: 2, item: { result: wire.result ?? { value: "Success" }, turnState: "Completed", messages: [] } });
        }
      };
      if (wire.hold) wire.replies.push(reply); else queueMicrotask(reply);
    }
  }
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
}
