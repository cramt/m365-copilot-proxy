#!/usr/bin/env bash
# Agent-less framing sweep. The whole point of the pivot: find a lean per-request
# system prompt that makes the AGENT-LESS model (no Copilot Studio agent → never
# Disengages, but only emits ```bash ~1/3 on minimal framing) reliably write a
# ```bash block. One proxy booted with M365_NO_AGENT=1; we rotate --system over
# the al*.txt candidates (+ baseline) and let the bench scorecard pick a winner.
#
# Results: scripts/bench/out/al-<name>-<ts>.json ; summary at /tmp/m365-al-summary.txt
# Usage: [TASKS=fix-bug,find-needle,edit-config] [REPEAT=2] scripts/bench/agentless-sweep.sh
set -u
cd "$(dirname "$0")/../.." || exit 1

PORT="${PORT:-4141}"
TASKS="${TASKS:-fix-bug,find-needle,edit-config}"
MAXTURNS="${MAXTURNS:-12}"
REPEAT="${REPEAT:-2}"
COOLDOWN="${COOLDOWN:-25}"
PROXY_LOG=/tmp/m365-al-proxy.log
SUMMARY=/tmp/m365-al-summary.txt
PIDFILE=/tmp/m365-al-proxy.pid
PROMPTS=scripts/bench/prompts
: > "$SUMMARY"

# name|system-file ("" = bench DEFAULT_SYSTEM baseline)
STRATEGIES=(
  "baseline|"
  "demo|$PROMPTS/al1_demo.txt"
  "terminal|$PROMPTS/al2_terminal.txt"
  "quickstart|$PROMPTS/al3_quickstart.txt"
  "repro|$PROMPTS/al4_repro.txt"
  "curt|$PROMPTS/al5_curt.txt"
  "ssh|$PROMPTS/al6_ssh.txt"
)

kill_proxy() {
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null
  rm -f "$PIDFILE"
}
trap kill_proxy EXIT

# Boot ONE agent-less proxy (env constant across strategies; only --system varies).
kill_proxy; sleep 1
M365_NO_AGENT=1 M365_DEBUG=1 node packages/proxy/bin/m365-proxy.mjs "$PORT" > "$PROXY_LOG" 2>&1 &
echo $! > "$PIDFILE"
for i in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
echo "proxy up (agent-less) on :$PORT — log $PROXY_LOG"
sleep 2

for entry in "${STRATEGIES[@]}"; do
  name="${entry%%|*}"
  sysfile="${entry#*|}"
  sysflag=()
  [ -n "$sysfile" ] && sysflag=(--system "$sysfile")
  echo "==================== AGENT-LESS: $name  (${sysfile:-DEFAULT}) ===================="
  out=$(node scripts/bench/run.mjs --base-url "http://localhost:$PORT/v1" --model m365-copilot \
        --label "al-$name" --tasks "$TASKS" --max-turns "$MAXTURNS" --repeat "$REPEAT" "${sysflag[@]}" 2>&1)
  echo "$out" | grep -E "SCORECARD|SOLVED|GAVE_UP|MAX_TURNS|ERROR|avg tool"
  line=$(echo "$out" | grep "SOLVED" | head -1)
  echo "$name : $line" >> "$SUMMARY"
  echo "--- cooldown ${COOLDOWN}s (thread-rate settle) ---"
  sleep "$COOLDOWN"
done

echo ""
echo "==================== AGENT-LESS SWEEP COMPLETE ===================="
cat "$SUMMARY"
