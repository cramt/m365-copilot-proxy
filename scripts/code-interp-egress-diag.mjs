// Egress DIAGNOSTIC battery for the M365 code-interpreter sandbox.
//
// Single message that asks the model to run an EXACT Python script which probes,
// in order: DNS resolution, raw TCP connect (port 443 + 80), an HTTPS GET to our
// tunnel, an HTTPS GET to example.com, and the env (proxy vars). Each step is
// wrapped so one failure does not abort the rest. Full output is captured to disk
// and cross-checked against scripts/sentinel-hits.log (ground truth for egress).
//
// Usage: node scripts/code-interp-egress-diag.mjs [tunnel-base-url]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { getToken, decodeJwt } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

const TUNNEL = (process.argv[2] || readFileSync("/tmp/tunnel_url.txt", "utf8"))
  .trim()
  .replace(/\/$/, "");
const SENTINEL = readFileSync("scripts/sentinel-value.txt", "utf8").trim();
const host = TUNNEL.replace(/^https?:\/\//, "");

const CODE_INTERP = [
  "cwc_code_interpreter",
  "cwc_code_interpreter_amsfix",
  "cwc_code_interpreter_citation_fix",
  "code_interpreter_interactive_charts",
  "code_interpreter_matplotlib_patching",
];

// The exact Python we want executed. We give it verbatim and ask for verbatim output.
const PY = `
import socket, ssl, os, sys, traceback, json
out = {}

def step(name, fn):
    try:
        out[name] = {"ok": True, "val": fn()}
    except Exception as e:
        out[name] = {"ok": False, "err": repr(e)}

# 1. DNS resolution of our tunnel host
step("dns_tunnel", lambda: socket.gethostbyname("${host}"))
# 2. DNS resolution of a well-known host
step("dns_example", lambda: socket.gethostbyname("example.com"))
# 3. Raw TCP connect to tunnel:443
def tcp443():
    s = socket.create_connection(("${host}", 443), timeout=8); s.close(); return "connected"
step("tcp_tunnel_443", tcp443)
# 4. Raw TCP connect to example.com:443
def tcpex():
    s = socket.create_connection(("example.com", 443), timeout=8); s.close(); return "connected"
step("tcp_example_443", tcpex)
# 5. Full HTTPS GET to our tunnel /sentinel
def https_tunnel():
    import urllib.request
    req = urllib.request.Request("${TUNNEL}/sentinel", headers={"User-Agent":"m365-sandbox-probe"})
    return urllib.request.urlopen(req, timeout=12).read().decode()
step("https_tunnel_sentinel", https_tunnel)
# 6. Full HTTPS GET to example.com
def https_example():
    import urllib.request
    return urllib.request.urlopen("https://example.com", timeout=12).read()[:80].decode("latin1")
step("https_example", https_example)
# 7. Proxy / network env
step("env_proxy", lambda: {k:v for k,v in os.environ.items() if "proxy" in k.lower() or "PROXY" in k})

print(json.dumps(out, indent=2))
`.trim();

const prompt =
  `Run this EXACT Python program in your code interpreter sandbox, with no modifications. ` +
  `Execute it for real (do not simulate or predict the output). Then paste the COMPLETE stdout it produced, verbatim, inside a code block. Do not summarise or omit any field.\n\n` +
  "```python\n" +
  PY +
  "\n```";

mkdirSync("scripts/code-interp-out", { recursive: true });

const token = await getToken();
const claims = decodeJwt(token);

const hitsBefore = (() => {
  try {
    return readFileSync("scripts/sentinel-hits.log", "utf8");
  } catch {
    return "";
  }
})();

console.log(`[diag] tunnel=${TUNNEL} host=${host} sentinel=${SENTINEL}`);
const r = await oneTurn({
  token,
  claims,
  agentId: null,
  optionsSets: CODE_INTERP,
  extraAllowed: ["GeneratedCode", "GenerateContentQuery", "Progress"],
  text: prompt,
  timeoutMs: 150000,
});
const out = r.fullText || "";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const fp = `scripts/code-interp-out/diag-${stamp}.txt`;
writeFileSync(fp, out);

const hitsAfter = (() => {
  try {
    return readFileSync("scripts/sentinel-hits.log", "utf8");
  } catch {
    return "";
  }
})();
const newHits = hitsAfter.slice(hitsBefore.length);
const serverGotHit = /GET \/sentinel|SENTINEL ENDPOINT CALLED/.test(newHits);
const modelHasValue = out.includes(SENTINEL);

console.log(`\n[diag] === RESULT ===`);
console.log(`[diag] full reply saved to ${fp} (${out.length} chars)`);
console.log(`[diag] --- model reply ---\n${out}`);
console.log(
  `\n[diag] sentinel server got a NEW inbound hit: ${serverGotHit}  ${serverGotHit ? "SANDBOX HAS EGRESS" : "no inbound hit"}`,
);
console.log(`[diag] model reported the correct sentinel value: ${modelHasValue}`);
if (newHits.trim()) console.log(`[diag] new hit log lines:\n${newHits.trim()}`);
console.log(
  `[diag] msgTypes=${r.messageTypes.join(",")} elapsed=${r.elapsedMs}ms throttle=${JSON.stringify(r.throttle)} disengaged=${r.disengaged}`,
);
