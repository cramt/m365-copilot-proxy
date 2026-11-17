#!/usr/bin/env node
// Thin launcher for the built Nitro server.
// Usage: m365-proxy [port]   (default 4141, or $PORT)
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const port = process.argv[2] || process.env.PORT || "4141";
process.env.PORT = String(port);
process.env.NITRO_PORT = String(port);
// Nitro binds every interface when neither is set, and the proxy spends the
// signed-in account for anyone who reaches it (#93). HOST=0.0.0.0 opts back in.
if (!process.env.HOST && !process.env.NITRO_HOST) process.env.NITRO_HOST = "127.0.0.1";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../.output/server/index.mjs");

await import(pathToFileURL(entry).href);
