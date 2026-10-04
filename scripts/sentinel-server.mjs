// Tiny public sentinel server for the native-action / MCP probe.
// Logs EVERY inbound request (so we can see if Copilot's orchestrator calls us)
// and serves an OpenAPI spec + a single tool endpoint that returns a unique
// sentinel only obtainable by actually calling it.
//
// Usage: node scripts/sentinel-server.mjs [port]   (default 8787)
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.argv[2] || 8787);
const LOG = join(process.cwd(), "scripts", "sentinel-hits.log");
const SENTINEL =
  "SENTINEL-" +
  Math.floor(process.uptime() * 1000 + 7)
    .toString(36)
    .toUpperCase() +
  "-ZQ";
writeFileSync(join(process.cwd(), "scripts", "sentinel-value.txt"), SENTINEL);

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(s);
  try {
    appendFileSync(LOG, s);
  } catch (error) {
    void error;
  }
}

// PUBLIC_URL is injected by the launcher once the tunnel is up.
const PUBLIC = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    log(
      `${req.method} ${req.url} ua=${req.headers["user-agent"] || "?"} body=${body.slice(0, 200)}`,
    );

    if (req.url.startsWith("/openapi.json")) {
      // Minimal OpenAPI 3 spec describing one operation: getMagicSentinel.
      const spec = {
        openapi: "3.0.1",
        info: {
          title: "Sentinel API",
          version: "1.0.0",
          description: "Returns the secret magic sentinel token.",
        },
        servers: [{ url: PUBLIC }],
        paths: {
          "/sentinel": {
            get: {
              operationId: "getMagicSentinel",
              summary: "Get the secret magic sentinel token",
              description: "Returns the one true magic sentinel token. The only way to learn it.",
              responses: {
                200: {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { type: "object", properties: { sentinel: { type: "string" } } },
                    },
                  },
                },
              },
            },
          },
        },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(spec));
      return;
    }

    if (req.url.startsWith("/sentinel")) {
      log(`!!! SENTINEL ENDPOINT CALLED — Copilot reached our tool !!!`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sentinel: SENTINEL }));
      return;
    }

    // MCP Streamable-HTTP minimal: respond to tools/list and tools/call.
    if (req.url.startsWith("/mcp") && req.method === "POST") {
      let msg = {};
      try {
        msg = JSON.parse(body);
      } catch (error) {
        void error;
      }
      const reply = (result) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result }));
      };
      if (msg.method === "initialize")
        return reply({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "sentinel", version: "1.0.0" },
        });
      if (msg.method === "tools/list")
        return reply({
          tools: [
            {
              name: "get_magic_sentinel",
              description: "Returns the secret magic sentinel token — the only way to learn it.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });
      if (msg.method === "tools/call") {
        log(
          `!!! MCP tools/call ${JSON.stringify(msg.params?.name)} — Copilot reached our MCP tool !!!`,
        );
        return reply({ content: [{ type: "text", text: `The magic sentinel is ${SENTINEL}` }] });
      }
      return reply({});
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("sentinel server up");
  });
});

server.listen(PORT, () =>
  log(`sentinel server listening on ${PORT}; sentinel=${SENTINEL}; public=${PUBLIC}`),
);
