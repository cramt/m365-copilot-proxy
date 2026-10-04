// Final egress confirmation: bypass DNS and the localhost proxy entirely by
// connecting to raw external IPs from inside the M365 code-interpreter sandbox.
// If even a raw TCP SYN to a public IP fails, the network namespace itself is
// airgapped (not merely DNS/proxy filtered). We also re-check our tunnel via its
// resolved IP if we can pass one in, and list the sandbox's own interfaces/routes.
//
// Usage: node scripts/code-interp-rawip-probe.mjs <tunnel-public-ip-optional>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { getToken, decodeJwt } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

const TUNNEL_IP = (process.argv[2] || "").trim(); // optional resolved cloudflare IP
const SENTINEL = readFileSync("scripts/sentinel-value.txt", "utf8").trim();

const CODE_INTERP = [
  "cwc_code_interpreter",
  "cwc_code_interpreter_amsfix",
  "cwc_code_interpreter_citation_fix",
  "code_interpreter_interactive_charts",
  "code_interpreter_matplotlib_patching",
];

const extraIp = TUNNEL_IP ? `\n    ("tunnel_ip", "${TUNNEL_IP}", 443),` : "";

const PY = `
import socket, subprocess, json

out = {}

def step(name, fn):
    try:
        out[name] = {"ok": True, "val": fn()}
    except Exception as e:
        out[name] = {"ok": False, "err": repr(e)}

# Raw TCP SYN to well-known public IPs, NO DNS, NO proxy.
def connect_ip(ip, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(6)
    try:
        s.connect((ip, port)); return "connected"
    finally:
        s.close()

for name, ip, port in [
    ("cloudflare_dns_443", "1.1.1.1", 443),
    ("google_dns_53", "8.8.8.8", 53),
    ("google_443", "142.250.74.110", 443),${extraIp}
]:
    step(name, (lambda i, p: (lambda: connect_ip(i, p))())(ip, port))

# Sandbox network identity: interfaces, routes, resolv.conf.
step("ifconfig", lambda: subprocess.run(["ip","addr"], capture_output=True, text=True, timeout=8).stdout[:1200])
step("route", lambda: subprocess.run(["ip","route"], capture_output=True, text=True, timeout=8).stdout[:600])
def resolv():
    with open("/etc/resolv.conf") as f: return f.read()[:400]
step("resolv_conf", resolv)
# Try curl directly (subprocess) to a raw IP, see its verbose error.
def curl_ip():
    r = subprocess.run(["curl","-s","-v","--max-time","8","https://1.1.1.1/"], capture_output=True, text=True, timeout=12)
    return (r.stderr or r.stdout)[-400:]
step("curl_1111", curl_ip)

print(json.dumps(out, indent=2))
`.trim();

const prompt =
  `Run this EXACT Python program in your code interpreter sandbox unchanged, for real (no simulation). ` +
  `Paste the COMPLETE verbatim stdout in one code block, omitting nothing.\n\n` +
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

console.log(`[rawip] tunnelIp=${TUNNEL_IP || "(none)"}`);
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
const fp = `scripts/code-interp-out/rawip-${stamp}.txt`;
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

console.log(`\n[rawip] === RESULT === saved ${fp} (${out.length} chars)`);
console.log(out);
console.log(
  `\n[rawip] sentinel inbound hit: ${serverGotHit}  leaked value: ${out.includes(SENTINEL)}`,
);
if (newHits.trim()) console.log(`[rawip] new hit log lines:\n${newHits.trim()}`);
console.log(
  `[rawip] msgTypes=${r.messageTypes.join(",")} elapsed=${r.elapsedMs}ms throttle=${JSON.stringify(r.throttle)}`,
);
