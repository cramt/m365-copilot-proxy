#!/usr/bin/env bash
# Sequential framing sweep against one proxy using M365_FRAMING_FILE=$CONTROL.
set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1

PROXY_URL="${PROXY_URL:-http://localhost:4199/v1}"
MODEL="${MODEL:-gpt-5.5-think-deeper}"
ARMS="${ARMS:-baseline relay honest dual_env dual_env_sys dual_env_protocol}"
TASKS="${TASKS:-fix-bug,find-needle,edit-config}"
MAXTURNS="${MAXTURNS:-12}"
REPEAT="${REPEAT:-2}"
COOLDOWN="${COOLDOWN:-5}"
TAG="${TAG:-dual-env}"
CONTROL="${CONTROL:-/tmp/m365-framing}"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi
if [[ ! "$REPEAT" =~ ^[1-9][0-9]*$ || ! "$COOLDOWN" =~ ^[0-9]+$ ]]; then
  echo "REPEAT must be positive and COOLDOWN must be nonnegative integers" >&2
  exit 2
fi
read -r -a strategies <<< "$ARMS"
IFS=, read -r -a tasks <<< "$TASKS"
if (( ${#strategies[@]} == 0 || ${#tasks[@]} == 0 )); then
  echo "ARMS and TASKS must not be empty" >&2
  exit 2
fi
if (( ! DRY_RUN )); then
  curl --fail --silent --show-error --max-time 5 "${PROXY_URL%/v1}/health" >/dev/null
fi

echo "[sweep] model=$MODEL threads=$((${#strategies[@]} * ${#tasks[@]} * REPEAT)) cooldown=${COOLDOWN}s control=$CONTROL"
for ((round = 1; round <= REPEAT; round++)); do
  for ((slot = 0; slot < ${#strategies[@]}; slot++)); do
    arm="${strategies[$(((slot + round - 1) % ${#strategies[@]}))]}"
    if (( ! DRY_RUN )); then
      if [[ "$arm" == "default" ]]; then printf '' > "$CONTROL"; else printf '%s\n' "$arm" > "$CONTROL"; fi
    fi
    for task in "${tasks[@]}"; do
      label="$TAG-$task-$arm-r$round"
      command=(node scripts/bench/run.mjs --base-url "$PROXY_URL" --model "$MODEL" --label "$label" --tasks "$task" --max-turns "$MAXTURNS" --repeat 1)
      if (( DRY_RUN )); then
        printf '[dry-run] framing=%s BENCH_THREAD_COOLDOWN_S=%s ' "$arm" "$COOLDOWN"
        printf '%q ' "${command[@]}"
        printf '\n'
      else
        BENCH_THREAD_COOLDOWN_S="$COOLDOWN" "${command[@]}"
      fi
    done
  done
done

if (( ! DRY_RUN )); then node scripts/bench/analyze-sweep.mjs "$TAG" "$MODEL"; fi
