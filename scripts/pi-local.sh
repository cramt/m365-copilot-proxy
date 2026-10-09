#!/usr/bin/env bash
# Launch the `pi` harness pointed at the LOCAL M365 proxy, using an isolated,
# repo-local pi HOME (./.pi-local) so it never touches your real ~/.pi config,
# sessions, or auth.
#
#   pnpm run pi                    # interactive, default model m365-copilot
#   PORT=24034 pnpm run pi         # point at a proxy on a different port
#   MODEL=quick pnpm run pi        # different default model
#   pnpm run pi -- -p "write hi"   # pass a prompt / extra pi flags through
#
# Start the proxy first in another shell:  pnpm run proxy   (defaults to :4141)
set -euo pipefail

PORT="${PORT:-4141}"
MODEL="${MODEL:-m365-copilot}"
BASE="http://localhost:${PORT}/v1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIHOME="$ROOT/.pi-local"

mkdir -p "$PIHOME/.pi/agent"

# Model list mirrors the proxy's MODEL_TONES (getAvailableModels) so Ctrl+P
# Make a curl request to v1/models and read and create the model list
response=$(curl -fsS "$BASE/models")
models_list=$(printf '%s\n' "$response" |
  jq '[.data[] | {id: .id, name: .id}]')

cat > "$PIHOME/.pi/agent/models.json" <<EOF
{
  "providers": {
    "m365": {
      "api": "openai-completions",
      "apiKey": "not-needed",
      "baseUrl": "$BASE",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false
      },
      "models": $models_list
    }
  }
}
EOF

cat > "$PIHOME/.pi/agent/settings.json" <<EOF
{"defaultModel":"$MODEL","defaultProvider":"m365","enableInstallTelemetry":false,"compaction":{"enabled":true}}
EOF

# Warn (don't fail) if the proxy isn't reachable — pi can still start.
if ! curl -s --max-time 3 "http://localhost:${PORT}/health" >/dev/null 2>&1; then
  echo "[pi-local] ⚠ no proxy answering on :${PORT} — start it with 'pnpm run proxy' (or set PORT=...)"
fi

echo "[pi-local] proxy=$BASE  model=$MODEL  home=$PIHOME"
exec env HOME="$PIHOME" PI_OFFLINE=1 pi --provider m365 --model "$MODEL" "$@"
