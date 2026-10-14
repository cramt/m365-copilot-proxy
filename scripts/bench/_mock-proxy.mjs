// Instrument validation: a fake OpenAI endpoint that returns a REAL tool_call,
// so we can confirm the bench's tool-execution + verify(SOLVED) path works
// end-to-end without spending M365 messages. If the bench scores fizzbuzz as
// SOLVED against this, a 0/5 from the real proxy is genuine model failure, not a
// harness bug.
//
// Usage: node scripts/bench/_mock-proxy.mjs 8799   then point the bench at
//   --base-url http://localhost:8799/v1
// MOCK_THROTTLE_AFTER=N: answer the first N chat requests, then 429
//   m365_throttled like a throttled account (exercises the bench's throttle stop).
// MOCK_QUOTA=1: make that 429 the Opus priority-access one instead.
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || 8799);
const THROTTLE_AFTER = process.env.MOCK_THROTTLE_AFTER ? Number(process.env.MOCK_THROTTLE_AFTER) : Infinity;
let chats = 0;
const FIZZ = "for i in range(1,16):\n    print('FizzBuzz' if i%15==0 else 'Fizz' if i%3==0 else 'Buzz' if i%5==0 else i)\n";

createServer((req, res) => {
  let body = ""; req.on("data", c => body += c); req.on("end", () => {
    if (req.url?.includes("/chat/completions") && ++chats > THROTTLE_AFTER) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify(process.env.MOCK_QUOTA
        ? { error: { message: "M365 Copilot's priority access to claude-opus is used up for today", type: "rate_limit_error", code: "priority_access_exhausted", param: "day" } }
        : { error: { message: "M365 Copilot throttled this account (PerUserThrottled)", type: "rate_limit_error", code: "m365_throttled" } }));
      return;
    }
    const msgs = (() => { try { return JSON.parse(body).messages || []; } catch { return []; } })();
    const hadToolResult = msgs.some(m => m.role === "tool");
    const reply = hadToolResult
      ? { role: "assistant", content: "Done — fizzbuzz.py created." }  // 2nd turn: finish in prose
      : { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "fizzbuzz.py", content: FIZZ }) } }] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "mock", object: "chat.completion", created: 0, model: "mock", choices: [{ index: 0, message: reply, finish_reason: reply.tool_calls ? "tool_calls" : "stop" }] }));
  });
}).listen(PORT, () => console.log(`mock proxy on ${PORT}`));
