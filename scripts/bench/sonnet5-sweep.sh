#!/usr/bin/env bash
# Sonnet 5 framing sweep (docs/hypotheses.md §21).
#
# Starts a fresh proxy per arm with M365_FRAMING_FILE=$CONTROL, switching the
# framing variant between arms by rewriting that file. Arms run strictly one at
# a time (thread-rate throttle, F13), with a cooldown between them. Each arm's
# proxy writes its debug log and frame dumps straight into the archive
# (M365_LOG_FILE / M365_FRAME_DIR), so a failure can be read back from the wire,
# not just from the scorecard. Any other proxy env (M365_NO_CONFAB_RETRY=1, …)
# is passed through from the caller. scripts/bench/phase-sweep.sh does the same
# and more (proxy env per phase, real-pi arms, a manifest).
#
# Usage:
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
CFG="${CFG:-$HOME/.config/opencode-m365}"
ARCHIVE="${ARCHIVE:-$CFG/s5-sweep}"
# The proxy resolves M365_LOG_FILE / M365_FRAME_DIR against ~/.config/opencode-m365, not the cwd.
[[ "$ARCHIVE" == /* ]] || ARCHIVE="$PWD/$ARCHIVE"
PROXY_CMD="${PROXY_CMD:-node packages/proxy/bin/m365-proxy.mjs}"
SUMMARY="$ARCHIVE/summary-$TAG.txt"
mkdir -p "$ARCHIVE"

curl -s -m2 "http://localhost:$PORT/health" >/dev/null && { echo "[s5] something already answers on :$PORT" >&2; exit 1; }
# The proxy appends to an arm's log, so a reused label would mix two runs.
i=0
for arm in $ARMS; do
  i=$((i + 1))
  for f in "$TAG-$i-$arm-debug.log" "$TAG-$i-$arm-bench.txt"; do
    [ -e "$ARCHIVE/$f" ] && { echo "[s5] $ARCHIVE already holds $TAG-$i-$arm — pick another TAG" >&2; exit 1; }
  done
done

CONTROL="$(mktemp "${TMPDIR:-/tmp}/m365-framing.XXXXXX")"
PROXY_PID=""
stop_proxy() {
  [ -n "$PROXY_PID" ] || return 0
  kill "$PROXY_PID" 2>/dev/null; wait "$PROXY_PID" 2>/dev/null; PROXY_PID=""
}
trap 'stop_proxy; rm -f "$CONTROL"' EXIT
trap 'exit 130' INT TERM

start_proxy() {
  local label="$1"
  # shellcheck disable=SC2086  # PROXY_CMD is a command line
  env M365_DEBUG=1 M365_DUMP_FRAMES=1 M365_FRAMING_FILE="$CONTROL" \
    M365_LOG_FILE="$ARCHIVE/$label-debug.log" M365_FRAME_DIR="$ARCHIVE/$label-frames" \
    $PROXY_CMD "$PORT" > "$ARCHIVE/$label-proxy.out" 2>&1 &
  PROXY_PID=$!
  for _ in $(seq 1 120); do
    curl -s -m2 "http://localhost:$PORT/health" >/dev/null && return 0
    kill -0 "$PROXY_PID" 2>/dev/null || { PROXY_PID=""; return 1; }
    sleep 1
  done
  return 1
}

i=0
for arm in $ARMS; do
  i=$((i + 1))
  # `default` = empty control file → the proxy's own per-model default applies,
  # which is how the SHIPPED path gets measured rather than an override.
  if [ "$arm" = default ]; then : > "$CONTROL"; else echo "$arm" > "$CONTROL"; fi
  label="$TAG-$i-$arm"   # arms may repeat (rotated order), so labels carry the slot
  echo "==================== ARM: $arm  ($(date -u +%H:%M:%S)Z) ===================="
  start_proxy "$label" || { echo "[s5] the proxy for $label didn't come up — see $ARCHIVE/$label-proxy.out" >&2; exit 1; }
  node scripts/bench/run.mjs --base-url "http://localhost:$PORT/v1" --model "$MODEL" \
    --label "$label" --repeat "$REPEAT" ${TASKS:+--tasks "$TASKS"} 2>&1 | tee "$ARCHIVE/$label-bench.txt"
  stop_proxy
  echo "$arm : $(grep 'SOLVED' "$ARCHIVE/$label-bench.txt" | tail -1)" >> "$SUMMARY"
  echo "--- cooldown ${COOLDOWN}s ---"
  sleep "$COOLDOWN"
done
echo "==================== SUMMARY ($TAG) ===================="
cat "$SUMMARY"
