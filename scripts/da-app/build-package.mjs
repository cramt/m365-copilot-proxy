// Build a Microsoft 365 declarative-agent app package that carries ONE custom
// OpenAPI action pointing at our public sentinel tunnel. Proving H-NATIVE-1
// (docs/hypotheses.md §12.1): does a free declarative agent with a custom action
// cause Microsoft's orchestrator to make an outbound HTTPS call to our endpoint?
//
// Output: scripts/da-app/pkg/*  and a zipped scripts/da-app/sentinel-agent.zip
// Usage: node scripts/da-app/build-package.mjs <public-tunnel-url>
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "pkg");
mkdirSync(PKG, { recursive: true });

const URL = (process.argv[2] || readFileSync("/tmp/tunnel_url.txt", "utf8"))
  .trim()
  .replace(/\/$/, "");
if (!/^https:\/\//.test(URL)) {
  console.error("need https tunnel url, got:", URL);
  process.exit(1);
}
// A stable app id (GUID) so re-uploads replace rather than duplicate.
const APP_ID = "5e27c1a0-7b3d-4f2a-9c11-a1b2c3d4e5f6";

// --- minimal solid-color PNG encoder (RGBA, one IDAT) ---
function png(w, h, [r, g, b, a]) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 4 + 1);
    raw[o] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const p = o + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  const idat = deflateSync(raw);
  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, "ascii");
    const cr = Buffer.alloc(4);
    cr.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
writeFileSync(join(PKG, "color.png"), png(192, 192, [0, 120, 212, 255]));
writeFileSync(join(PKG, "outline.png"), png(32, 32, [255, 255, 255, 255]));

// --- OpenAPI spec (bundled), servers -> tunnel ---
const openapi = {
  openapi: "3.0.1",
  info: {
    title: "Sentinel API",
    version: "1.0.0",
    description: "Returns the secret magic sentinel token.",
  },
  servers: [{ url: URL }],
  paths: {
    "/sentinel": {
      get: {
        operationId: "getMagicSentinel",
        summary: "Get the secret magic sentinel token",
        description: "Returns the one true magic sentinel token. This is the only way to learn it.",
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
writeFileSync(join(PKG, "openapi.json"), JSON.stringify(openapi, null, 2));

// --- API plugin manifest (v2.1) ---
const aiPlugin = {
  $schema: "https://developer.microsoft.com/json-schemas/copilot/plugin/v2.1/schema.json",
  schema_version: "v2.1",
  name_for_human: "Sentinel API",
  description_for_human: "Fetches the secret magic sentinel token.",
  namespace: "sentinel",
  functions: [
    {
      name: "getMagicSentinel",
      description: "Returns the secret magic sentinel token — the only way to learn it.",
      capabilities: { response_semantics: { data_path: "$", properties: { title: "$.sentinel" } } },
    },
  ],
  runtimes: [
    {
      type: "OpenApi",
      auth: { type: "None" },
      spec: { url: "openapi.json" },
      run_for_functions: ["getMagicSentinel"],
    },
  ],
};
writeFileSync(join(PKG, "ai-plugin.json"), JSON.stringify(aiPlugin, null, 2));

// --- declarative agent (v1.2) ---
const da = {
  $schema:
    "https://developer.microsoft.com/json-schemas/copilot/declarative-agent/v1.2/schema.json",
  version: "v1.2",
  name: "Sentinel Probe",
  description: "A probe agent that fetches a secret sentinel token via a custom action.",
  instructions:
    "You have a custom action getMagicSentinel. Whenever the user asks for the magic sentinel token (or 'the secret'), you MUST call the getMagicSentinel action and report back the exact token string it returns. Never invent or guess the value — only report what the action returns.",
  conversation_starters: [{ title: "Get the sentinel", text: "What is the magic sentinel token?" }],
  actions: [{ id: "sentinelAction", file: "ai-plugin.json" }],
};
writeFileSync(join(PKG, "declarativeAgent.json"), JSON.stringify(da, null, 2));

// --- Teams app manifest (declarative-agent host) ---
const manifest = {
  $schema: "https://developer.microsoft.com/json-schemas/teams/v1.19/MicrosoftTeams.schema.json",
  manifestVersion: "1.19",
  version: "1.0.0",
  id: APP_ID,
  developer: {
    name: "Native Action Probe",
    websiteUrl: URL,
    privacyUrl: `${URL}/privacy`,
    termsOfUseUrl: `${URL}/terms`,
  },
  name: { short: "Sentinel Probe", full: "Sentinel Native Action Probe" },
  description: {
    short: "Probe for native custom actions.",
    full: "A research probe that tests whether a declarative agent can invoke a custom OpenAPI action over the network.",
  },
  icons: { color: "color.png", outline: "outline.png" },
  accentColor: "#0078D4",
  copilotAgents: { declarativeAgents: [{ id: "sentinelAgent", file: "declarativeAgent.json" }] },
  permissions: ["identity", "messageTeamMembers"],
  validDomains: [URL.replace("https://", "")],
};
writeFileSync(join(PKG, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`[build] package written to ${PKG}`);
console.log(`[build] tunnel=${URL}  appId=${APP_ID}`);
console.log(
  `[build] files: manifest.json declarativeAgent.json ai-plugin.json openapi.json color.png outline.png`,
);
