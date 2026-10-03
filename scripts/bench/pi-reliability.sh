#!/usr/bin/env bash
# Real-harness reliability run (toward the ultimate goal): drive the ACTUAL `pi`
# coding agent headless (--print) against the local M365 proxy on the fix-bug task,
# N times, verifying each with the objective check. This validates the PRODUCT path
# end-to-end (AGENTS.md principle #3: validate wins through a real harness, not only
# the bench), pinning the comply-rate F14 asked for (~10x).
#
# pi runs model-generated commands on the HOST in a throwaway /tmp dir (benign task).
# Run it inside the repo's Nix dev shell, which provides pi, python3 and curl:
#   N=10 nix develop --command bash scripts/bench/pi-reliability.sh
set -u
cd "$(dirname "$0")/../.." || exit 1

N="${N:-10}"
PORT="${PORT:-4141}"
MODEL="${MODEL:-m365-copilot}"
COOLDOWN="${COOLDOWN:-60}"
TIMEOUT="${TIMEOUT:-240}"
BASE="http://localhost:${PORT}/v1"
CSV="${CSV:-/tmp/m365-pi-reliability.csv}"
TASK="${TASK:-fix-bug}"   # fix-bug (find+fix) | multi (2-file bug) | edit-config (F17 "change X->Y" shape)

for t in pi python3 curl; do
  command -v "$t" >/dev/null || { echo "[pi-rel] $t isn't on PATH — run this inside the repo's dev shell: nix develop --command bash scripts/bench/pi-reliability.sh"; exit 1; }
done
# The model's commands and the verifier both run this python3. PYBIN overrides it.
PYBIN="${PYBIN:-$(dirname "$(command -v python3)")}"
[ -x "$PYBIN/python3" ] || { echo "[pi-rel] no python3 in $PYBIN"; exit 1; }
curl -s -m3 "http://localhost:${PORT}/health" >/dev/null || { echo "[pi-rel] proxy not answering on :$PORT"; exit 1; }

[ -f "$CSV" ] || echo "run,iso_ts,outcome,elapsed_s,dir" > "$CSV"
echo "[pi-rel] N=$N model=$MODEL base=$BASE python3=$PYBIN cooldown=${COOLDOWN}s"

for i in $(seq 1 "$N"); do
  D="$(mktemp -d /tmp/pi-task-XXXXXX)"
  if [ "$TASK" = edit-config ]; then
    printf '{\n  "name": "app",\n  "port": 3000,\n  "debug": false\n}\n' > "$D/config.json"
    PROMPT="Edit config.json so the port is 8080 instead of 3000. Leave every other field unchanged."
  elif [ "$TASK" = multi ]; then
    printf 'def average(nums):\n    return sum(nums) / len(nums) + 1\n\ndef total(nums):\n    return sum(nums)\n' > "$D/mathutil.py"
    printf 'from mathutil import average, total\ndata = [2, 4, 6]\nprint("avg", average(data), "total", total(data))\n' > "$D/report.py"
    printf "from mathutil import average, total\nassert average([2,4,6]) == 4.0, 'average wrong'\nassert total([2,4,6]) == 12, 'total wrong'\nassert average([10,20]) == 15.0, 'average wrong'\nprint('OK')\n" > "$D/test.py"
    PROMPT="There is a bug in this Python project: running 'python3 test.py' fails an assertion. Investigate the files, find and fix the bug, and make 'python3 test.py' print OK. Verify it."
  else
    printf 'def add(a, b):\n    return a - b\n' > "$D/calc.py"
    printf "from calc import add\nassert add(2, 3) == 5, 'add is wrong'\nassert add(10, 4) == 14, 'add is wrong'\nprint('OK')\n" > "$D/check.py"
    PROMPT="This project has a bug: running 'python3 check.py' fails an assertion. Read the files, fix the bug in calc.py, and make 'python3 check.py' print OK. Verify it."
  fi
  PIHOME="$D/.pihome"; mkdir -p "$PIHOME/.pi/agent"
  # pi only accepts a --model its provider lists, so list the one under test.
  cat > "$PIHOME/.pi/agent/models.json" <<EOF
{"providers":{"m365":{"api":"openai-completions","apiKey":"not-needed","baseUrl":"$BASE","compat":{"supportsDeveloperRole":false,"supportsReasoningEffort":false,"supportsUsageInStreaming":false},"models":[{"id":"$MODEL","name":"M365 $MODEL"}]}}}
EOF
  cat > "$PIHOME/.pi/agent/settings.json" <<EOF
{"defaultModel":"$MODEL","defaultProvider":"m365","enableInstallTelemetry":false}
EOF
  t0=$(date +%s)
  ( cd "$D" && HOME="$PIHOME" PI_OFFLINE=1 PATH="$PYBIN:$PATH" \
      timeout "$TIMEOUT" pi --provider m365 --model "$MODEL" -nc --print \
      -p "$PROMPT (run-nonce: ${i}-$(date +%s)-$RANDOM)" \
      > "$D/pi.out" 2>&1 )
  if [ "$TASK" = edit-config ]; then
    "$PYBIN/python3" -c "import json,sys;c=json.load(open('$D/config.json'));sys.exit(0 if c.get('port')==8080 and c.get('name')=='app' and c.get('debug')==False else 1)" 2>/dev/null && ok=1 || ok=0
  elif [ "$TASK" = multi ]; then
    "$PYBIN/python3" "$D/test.py" 2>/dev/null | grep -qx OK && ok=1 || ok=0
  else
    "$PYBIN/python3" "$D/check.py" 2>/dev/null | grep -qx OK && ok=1 || ok=0
  fi
  if [ "$ok" = 1 ]; then outcome=SOLVED
  elif grep -qi 'disengag' "$D/pi.out" 2>/dev/null; then outcome=DISENGAGED
  else outcome=FAIL; fi
  el=$(( $(date +%s) - t0 ))
  echo "$i,$(date -Iseconds),$outcome,$el,$D" >> "$CSV"
  echo "  [pi-rel] run $i/$N -> $outcome (${el}s)"
  # keep the dir on FAIL for diagnosis; clean on success
  [ "$outcome" = SOLVED ] && rm -rf "$D" || echo "    (kept $D for diagnosis: pi.out)"
  [ "$i" -lt "$N" ] && sleep "$COOLDOWN"
done
echo "[pi-rel] === $(tail -n+2 "$CSV" | awk -F, '$3=="SOLVED"{s++}END{print s+0"/"NR" SOLVED"}') ==="
