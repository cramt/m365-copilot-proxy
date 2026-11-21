import { afterEach, describe, expect, it } from "vitest";
import { wire } from "./settlement-wire.fixture.js";
import { handleChatCompletion, SessionPool } from "./handler.js";
import { ChatCompletionRequest } from "./schemas.js";

// Replace only the physical transport via the native Vitest configuration.

const token = `x.${Buffer.from(JSON.stringify({ oid: "synthetic", tid: "synthetic", aud: "test", iss: "test", exp: 9999999999 })).toString("base64url")}.x`;
const expected = "x = [regex]::Replace(a)\nthen the rest";
const oldTransport = process.env.M365_TRANSPORT;
const oldIdle = process.env.M365_TURN_IDLE_MS;
afterEach(() => {
  if (oldTransport === undefined) delete process.env.M365_TRANSPORT; else process.env.M365_TRANSPORT = oldTransport;
  if (oldIdle === undefined) delete process.env.M365_TURN_IDLE_MS; else process.env.M365_TURN_IDLE_MS = oldIdle;
});

describe("proxy response settlement across real sessions", () => {
  for (const [transport, ending] of [["chathub", "3"], ["chathub", "7"], ["streamhub", "request_end"], ["streamhub", "grace"], ["chathub", "close"], ["streamhub", "close"]] as const) {
    for (const stream of [false, true]) it(`${transport} ${ending} ${stream ? "SSE" : "JSON"}`, async () => {
      wire.transport = transport; wire.ending = ending; wire.sockets = [];
      process.env.M365_TRANSPORT = transport;
      process.env.M365_TURN_IDLE_MS = "9000";
      const pool = new SessionPool({ getToken: async () => token, useAgent: false });
      const body = ChatCompletionRequest.parse({ model: "m365-copilot", stream, messages: [{ role: "user", content: "hello" }] });
      const response = await handleChatCompletion(body, pool);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(wire.sockets).toHaveLength(1);
      if (ending !== "close") {
        expect(wire.sockets[0].closed).toBe(true);
        expect(wire.sockets[0].readyState).toBe(2); // close deliberately never acknowledged
      }
      if (stream) {
        const chunks = text.split("\n").filter(x => x.startsWith("data: ") && x !== "data: [DONE]")
          .map(x => JSON.parse(x.slice(6)).choices?.[0]?.delta?.content).filter((x): x is string => typeof x === "string");
        expect(chunks.join("")).toBe(expected);
        expect(text).toContain("data: [DONE]");
      } else {
        expect(JSON.parse(text).choices[0].message.content).toBe(expected);
      }
    }, 12000);
  }
});
