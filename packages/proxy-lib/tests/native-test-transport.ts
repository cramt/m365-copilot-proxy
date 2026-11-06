import { EventEmitter } from "node:events";
export const wire = { sockets: [] as Socket[], texts: [] as string[], answer: "visible answer", hold: false, replies: [] as (() => void)[], onChat: undefined as (() => void) | undefined };
export default class Socket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  constructor(readonly url: string) {
    super(); wire.sockets.push(this);
    queueMicrotask(() => { this.emit("open"); this.frame({}); });
  }
  frame(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value) + "\x1e")); }
  send(raw: string) {
    for (const part of raw.split("\x1e").filter(Boolean)) {
      const frame = JSON.parse(part);
      if (frame.target !== "chat") continue;
      wire.texts.push(frame.arguments[0].message.text);
      wire.onChat?.();
      const reply = () => {
        this.frame({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", text: wire.answer, messageId: "m" }] }] });
        this.frame({ type: 2, item: { result: { value: "Success" }, turnState: "Completed", messages: [] } });
      };
      if (wire.hold) wire.replies.push(reply); else queueMicrotask(reply);
    }
  }
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
}
