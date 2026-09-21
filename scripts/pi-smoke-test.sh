#!/usr/bin/env bash
# Reusable end-to-end test: drive the real `pi` harness against a running proxy
# and verify the TOOL LOOP actually executes — not just that text comes back.
#
# It asks pi to write a unique sentinel via the bash tool, then checks the file
# exists on disk with the exact marker. Prose/hallucinated "tool output" can't
# fake that, so PASS means the agent genuinely called a tool and pi ran it.
#
# Uses an ISOLATED pi HOME so it never touches your real ~/.pi config or your
# production proxy. Point it at whichever proxy build you want to test.
#
# Usage:
#   scripts/pi-smoke-test.sh [PROXY_URL] [MODEL]
#   PROXY_URL default: http://localhost:4148/v1   MODEL default: m365-copilot
#
# Requires: pi on PATH, a proxy already running at PROXY_URL.

set -uo pipefail
PROXY_URL="${1:-http://localhost:4148/v1}"
MODEL="${2:-m365-copilot}"

MARKER="PI_SMOKE_$(date +%s)_$$"
SCRATCH="$(mktemp -d)"
PIH="$(mktemp -d)"
SENTINEL="$SCRATCH/sentinel.txt"

mkdir -p "$PIH/.pi/agent"
cat > "$PIH/.pi/agent/models.json" <<EOF
{"providers":{"m365":{"api":"openai-completions","apiKey":"not-needed","baseUrl":"$PROXY_URL","compat":{"supportsDeveloperRole":false,"supportsReasoningEffort":false,"supportsUsageInStreaming":false},"models":[{"id":"$MODEL","name":"$MODEL"}]}}}
EOF
cat > "$PIH/.pi/agent/settings.json" <<EOF
{"defaultModel":"$MODEL","defaultProvider":"m365","enableInstallTelemetry":false}
EOF

echo "[pi-smoke] proxy=$PROXY_URL model=$MODEL"
echo "[pi-smoke] scratch=$SCRATCH marker=$MARKER"
echo "[pi-smoke] health: $(curl -s --max-time 5 "${PROXY_URL%/v1}/health" || echo UNREACHABLE)"

cd "$SCRATCH" || exit 2
TASK="Use the bash tool to run exactly: echo $MARKER > sentinel.txt
Then stop. Do not explain. Actually run the command."

HOME="$PIH" PI_OFFLINE=1 timeout 180 pi -p \
  --provider m365 --model "$MODEL" \
  --tools read,write,bash \
  --no-context-files --no-extensions --no-skills --approve \
  "$TASK" 2>&1 | sed 's/^/[pi] /' | tail -20

echo "[pi-smoke] --- verdict ---"
if [ -f "$SENTINEL" ] && grep -q "$MARKER" "$SENTINEL"; then
  echo "[pi-smoke] PASS — tool loop executed; sentinel written with marker."
  RC=0
else
  echo "[pi-smoke] FAIL — no sentinel with marker on disk. The model likely answered in prose / hallucinated tool output instead of calling bash."
  echo "[pi-smoke]   sentinel exists: $([ -f "$SENTINEL" ] && echo yes || echo no)"
  RC=1
fi
rm -rf "$SCRATCH" "$PIH"
exit $RC
