// Lean retry: raw TCP SYN to public IPv4s (no DNS, no proxy, no subprocess).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { getToken, decodeJwt } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

void readFileSync("scripts/sentinel-value.txt", "utf8").trim();
const CODE_INTERP = [
  "cwc_code_interpreter",
  "cwc_code_interpreter_amsfix",
  "cwc_code_interpreter_citation_fix",
  "code_interpreter_interactive_charts",
  "code_interpreter_matplotlib_patching",
];

const PY = `
import socket, json
out = {}
def conn(ip, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.settimeout(6)
    try:
        s.connect((ip, port)); return "CONNECTED"
    except Exception as e:
        return "ERR:" + repr(e)
    finally:
        s.close()
out["cloudflare_1.1.1.1:443"] = conn("1.1.1.1", 443)
out["googledns_8.8.8.8:53"]   = conn("8.8.8.8", 53)
out["google_142.250.74.110:443"] = conn("142.250.74.110", 443)
try:
    with open("/etc/resolv.conf") as f: out["resolv_conf"] = f.read()[:300]
except Exception as e:
    out["resolv_conf"] = repr(e)
print(json.dumps(out, indent=2))
`.trim();

const prompt =
  `Run this EXACT Python in your code interpreter for real and paste the complete verbatim stdout in one code block:\n\n` +
  "```python\n" +
  PY +
  "\n```";

mkdirSync("scripts/code-interp-out", { recursive: true });
const token = await getToken();
const claims = decodeJwt(token);
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
const fp = `scripts/code-interp-out/rawip2-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
writeFileSync(fp, out);
console.log(`[rawip2] saved ${fp} (${out.length} chars)\n${out}`);
console.log(
  `[rawip2] msgTypes=${r.messageTypes.join(",")} elapsed=${r.elapsedMs}ms throttle=${JSON.stringify(r.throttle)} disengaged=${r.disengaged}`,
);
