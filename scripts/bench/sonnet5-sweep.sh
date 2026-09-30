#!/usr/bin/env bash
# Sonnet 5 framing sweep (docs/hypotheses.md §21).
#
# Drives ONE persistent proxy that was started with M365_FRAMING_FILE=$CONTROL,
# switching the framing variant between arms by rewriting that file — no
# restarts, so every arm shares the same process, token and warm-up state.
# Arms run strictly one at a time (thread-rate throttle, F13), with a cooldown
# between them. Each arm's debug log and frame dumps are archived separately so
# a failure can be read back from the wire, not just from the scorecard.
#
# Usage:
#   M365_FRAMING_FILE=/tmp/m365-framing M365_DUMP_FRAMES=1 M365_DEBUG=1 \
#     node packages/proxy/bin/m365-proxy.mjs 4141 &
#   ARMS="baseline retag honest terse_user relay" REPEAT=1 \
#     bash scripts/bench/sonnet5-sweep.sh
#   # confirmation, rotated so no arm always runs first or last:
#   ARMS="default retag retag default default retag" TAG=s5b bash scripts/bench/sonnet5-sweep.sh
set -u
cd "$(dirname "$0")/../.." || exit 1

PORT="${PORT:-4141}"
MODEL="${MODEL:-claude-sonnet-5}"
ARMS="${ARMS:-baseline retag honest terse_user relay}"
REPEAT="${REPEAT:-1}"
TASKS="${TASKS:-}"
COOLDOWN="${COOLDOWN:-45}"
TAG="${TAG:-s5}"
CONTROL="${CONTROL:-/tmp/m365-framing}"
CFG="${CFG:-$HOME/.config/opencode-m365}"
ARCHIVE="${ARCHIVE:-$CFG/s5-sweep}"
SUMMARY="$ARCHIVE/summary-$TAG.txt"
mkdir -p "$ARCHIVE"

i=0
for arm in $ARMS; do
  i=$((i + 1))
  # `default` = empty control file → the proxy's own per-model default applies,
  # which is how the SHIPPED path gets measured rather than an override.
  if [ "$arm" = default ]; then : > "$CONTROL"; else echo "$arm" > "$CONTROL"; fi
  label="$TAG-$i-$arm"   # arms may repeat (rotated order), so labels carry the slot
  echo "==================== ARM: $arm  ($(date -u +%H:%M:%S)Z) ===================="
  # Start each arm with empty logs so the archive holds exactly this arm.
  [ -f "$CFG/debug.log" ] && mv "$CFG/debug.log" "$ARCHIVE/pre-$label-debug.log"
  [ -d "$CFG/frames" ] && mv "$CFG/frames" "$ARCHIVE/pre-$label-frames"
  node scripts/bench/run.mjs --base-url "http://localhost:$PORT/v1" --model "$MODEL" \
    --label "$label" --repeat "$REPEAT" ${TASKS:+--tasks "$TASKS"} 2>&1 | tee "$ARCHIVE/$label-bench.txt"
  [ -f "$CFG/debug.log" ] && mv "$CFG/debug.log" "$ARCHIVE/$label-debug.log"
  [ -d "$CFG/frames" ] && mv "$CFG/frames" "$ARCHIVE/$label-frames"
  echo "$arm : $(grep 'SOLVED' "$ARCHIVE/$label-bench.txt" | tail -1)" >> "$SUMMARY"
  echo "--- cooldown ${COOLDOWN}s ---"
  sleep "$COOLDOWN"
done
echo "==================== SUMMARY ($TAG) ===================="
cat "$SUMMARY"
