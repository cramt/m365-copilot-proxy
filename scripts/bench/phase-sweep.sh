#!/usr/bin/env bash
# Phase sweep: bench arms and real-pi runs for one model, with a FRESH proxy per
# arm, and per phase the proxy's own environment can change (agent off, code
# interpreter off, …). The framing switches per arm through M365_FRAMING_FILE.
# Arms run strictly one at a time (thread-rate throttle, docs F13), with
# cooldowns between them.
#
# Everything a post-mortem needs is archived per arm under $ARCHIVE: the bench
# scorecard and JSON, the proxy's debug log and frame dumps (the proxy writes them
# there itself, via M365_LOG_FILE / M365_FRAME_DIR), pi CSVs and the output of
# failed pi runs, plus manifest.tsv. Read it with analyze-arms.mjs.
# Run both inside the repo's Nix dev shell, which provides node, pi, python3,
# curl and Chromium (Docker comes from the host: bench arms need its daemon):
#
#   MODEL=gpt-6-sol TAG=g6s \
#   PHASES='A:baseline,relay,demo_only|B@M365_FORCE_AGENT=0:relay,pi=fix-bug' \
#     nix develop --command bash scripts/bench/phase-sweep.sh
#   nix develop --command node scripts/bench/analyze-arms.mjs ~/.config/opencode-m365/sweeps/g6s
#
# PHASES: phases separated by `|`, each NAME[@KEY=VAL...]:ARM,ARM,...
#   NAME       [A-Za-z0-9_]+; part of every label in the phase
#   @KEY=VAL   extra env for this phase's proxies. Repeatable. VAL may be empty
#              (`@M365_NO_CONFAB_RETRY=` turns the confab retry back on) but
#              can't contain whitespace or any of @ : | ,
#              `@MODEL=ID` is the model this phase's arms ask for instead of
#              MODEL, so one sweep can interleave two models arm by arm; it stays
#              in the phase env (the proxy ignores it), so analyze-arms can
#              select on `+MODEL=ID`
#   ARM        a framing variant (FRAMING_VARIANT_NAMES in fenced.ts);
#              `default` = no override, i.e. the model's shipped default (or the
#              phase's own M365_FRAMING_VARIANT); or `pi=TASK` = PI_N runs of
#              real pi on TASK (fix-bug | multi | edit-config, see
#              pi-reliability.sh), always on the default framing
# Repeat arms in rotated order to spread order effects: `A:relay,demo_only,demo_only,relay`.
#
# Every proxy runs with M365_DEBUG=1 M365_DUMP_FRAMES=1 M365_NO_CONFAB_RETRY=1
# M365_NO_INTERACTIVE=1, its own M365_FRAMING_FILE, and M365_LOG_FILE /
# M365_FRAME_DIR pointing at the arm's files in $ARCHIVE; phase env goes on top.
# A proxy per arm, not per phase, so no arm inherits what an earlier one taught
# the proxy (a dead agent route, say) — that would be an order effect.
#
# Knobs (env): MODEL and PHASES (required; MODEL may be left out when every
#   phase sets @MODEL=), TAG (sweep), PORT (4141), REPEAT (1,
#   bench reps per task), TASKS (all bench tasks), PI_N (5), COOLDOWN (60 s
#   between arms), PHASE_COOLDOWN (60 s), TASK_GAP (0 s between bench tasks, on
#   top of the pacing below),
#   ARCHIVE (~/.config/opencode-m365/
#   sweeps/$TAG), PROXY_CMD (the built proxy; `node scripts/bench/_mock-proxy.mjs`
#   exercises the driver without spending M365 threads), DRY_RUN=1 (validate and
#   print the plan, spend nothing), and M365_AVOID_THROTTLING / M365_BUDGET_*
#   (pacing, below).
#
# Pacing, only with M365_AVOID_THROTTLING=1: the account throttles once a bucket
# of ~100 turns, refilled at ~1.6 a minute, runs dry (hypotheses §24 F58).
# Before every bench task and every pi run the drivers then wait until the
# proxies' debug logs (this archive included) say there's room for a whole task
# plus a reserve — scripts/bench/turn-budget.mjs. The sweep runs at the account's
# pace instead of tripping the throttle, which makes it much slower: ~1.6 turns
# a minute once the bucket is down to the reserve. Off by default.
# `node scripts/bench/turn-budget.mjs status` shows where the bucket stands.
#
# The sweep stops at the first throttled bench task or pi run (FAILED says where);
# the throttle only lifts once the account stops starting conversations. It stops
# the same way when the model's priority-access budget runs out (Opus 5.5); a
# real-pi arm doesn't see that one, and analyze-arms marks its runs.
#
# One sweep per account at a time: two would spend the same turn budget and
# throttle each other. For a long sweep, run it detached and wait for
# $ARCHIVE/DONE (or FAILED):
#   setsid -f env MODEL=… PHASES=… nix develop --command bash scripts/bench/phase-sweep.sh </dev/null >/dev/null 2>&1
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1

MODEL="${MODEL:-}"
PHASES="${PHASES:?set PHASES, see the header of scripts/bench/phase-sweep.sh}"
TAG="${TAG:-sweep}"
PORT="${PORT:-4141}"
REPEAT="${REPEAT:-1}"
TASKS="${TASKS:-}"
PI_N="${PI_N:-5}"
COOLDOWN="${COOLDOWN:-60}"
PHASE_COOLDOWN="${PHASE_COOLDOWN:-60}"
TASK_GAP="${TASK_GAP:-0}"
CFG="$HOME/.config/opencode-m365"
ARCHIVE="${ARCHIVE:-$CFG/sweeps/$TAG}"
# The proxy resolves M365_LOG_FILE / M365_FRAME_DIR against $CFG, not the cwd.
[[ "$ARCHIVE" == /* ]] || ARCHIVE="$REPO/$ARCHIVE"
PROXY_CMD="${PROXY_CMD:-node packages/proxy/bin/m365-proxy.mjs}"
BASE_ENV=(M365_DEBUG=1 M365_DUMP_FRAMES=1 M365_NO_CONFAB_RETRY=1 M365_NO_INTERACTIVE=1)
# Pacing (M365_AVOID_THROTTLING=1) reads the debug logs under $CFG; an archive
# kept elsewhere has to be named.
export M365_BUDGET_LOGS="$ARCHIVE${M365_BUDGET_LOGS:+:$M365_BUDGET_LOGS}"

ARCHIVE_OURS=""
die() {
  echo "[sweep] $*" >&2
  [ -n "$ARCHIVE_OURS" ] && echo "$*" > "$ARCHIVE/FAILED"
  exit 1
}

# --- parse and validate PHASES before anything is spent --------------------
known_variants=""
if [ -f packages/core/dist/index.mjs ]; then
  known_variants=" default $(node -e 'import("./packages/core/dist/index.mjs").then((m) => console.log(m.FRAMING_VARIANT_NAMES.join(" ")))') "
fi
names=(); envs=(); models=(); armlists=(); need_pi=0; need_docker=0; total_arms=0
IFS='|' read -ra specs <<<"$PHASES"
for spec in "${specs[@]}"; do
  [[ "$spec" == *:* ]] || die "phase '$spec' has no ':ARM,…' part"
  head="${spec%%:*}"; arms="${spec#*:}"; name="${head%%@*}"
  [[ "$name" =~ ^[A-Za-z0-9_]+$ ]] || die "bad phase name '$name' in '$spec'"
  for n in "${names[@]}"; do [ "$n" != "$name" ] || die "phase name '$name' is used twice"; done
  env=""; model="$MODEL"
  if [[ "$head" == *@* ]]; then
    IFS='@' read -ra kvs <<<"${head#*@}"
    for kv in "${kvs[@]}"; do
      [[ "$kv" =~ ^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*$ ]] || die "bad env '$kv' in phase $name"
      [[ "$kv" =~ ^M365_(LOG_FILE|FRAME_DIR)= ]] && die "phase $name sets ${kv%%=*}, which the sweep sets per arm"
      if [[ "$kv" == MODEL=* ]]; then
        model="${kv#MODEL=}"
        [ -n "$model" ] || die "phase $name sets an empty MODEL"
      fi
      env+="$kv "
    done
  fi
  [ -n "$arms" ] || die "phase $name has no arms"
  [ -n "$model" ] || die "phase $name has no model — set MODEL, or @MODEL= on the phase"
  IFS=',' read -ra al <<<"$arms"
  for a in "${al[@]}"; do
    total_arms=$((total_arms + 1))
    if [[ "$a" == pi=* ]]; then
      [[ "$a" =~ ^pi=(fix-bug|multi|edit-config)$ ]] || die "bad pi arm '$a' in phase $name (fix-bug | multi | edit-config)"
      need_pi=1
    else
      [[ "$a" =~ ^[A-Za-z0-9_]+$ ]] || die "bad arm '$a' in phase $name"
      # An unknown variant silently falls back to baseline in the proxy, so catch it here.
      [ -z "$known_variants" ] || [[ "$known_variants" == *" $a "* ]] || die "unknown framing variant '$a' (known:$known_variants)"
      need_docker=1
    fi
  done
  names+=("$name"); envs+=("${env% }"); models+=("$model"); armlists+=("$arms")
done

echo "[sweep] model=${MODEL:-per phase} tag=$TAG port=$PORT archive=$ARCHIVE"
for i in "${!names[@]}"; do
  echo "[sweep]   phase ${names[$i]}  model=${models[$i]}  env=[${envs[$i]:-none}]  arms: ${armlists[$i]//,/ }"
done
if [ -n "${DRY_RUN:-}" ]; then echo "[sweep] DRY_RUN — nothing started"; exit 0; fi

# --- preflight -------------------------------------------------------------
need() {
  local t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || die "$t isn't on PATH — run this inside the repo's dev shell: nix develop --command bash scripts/bench/phase-sweep.sh"
  done
}
need node curl
[ "$need_pi" = 0 ] || need pi python3
if [ "$need_docker" = 1 ]; then
  need docker
  docker info >/dev/null 2>&1 || die "the docker daemon isn't reachable (bench tasks run in containers)"
fi
if [ "$PROXY_CMD" = "node packages/proxy/bin/m365-proxy.mjs" ]; then
  [ -f packages/proxy/.output/server/index.mjs ] && [ -f packages/core/dist/index.mjs ] || die "the proxy isn't built — run pnpm build"
fi
curl -s -m2 "http://localhost:$PORT/health" >/dev/null && die "something already answers on :$PORT"
[ -e "$ARCHIVE/manifest.tsv" ] && die "$ARCHIVE already holds a sweep — pick another TAG or ARCHIVE"
mkdir -p "$ARCHIVE" || die "can't create $ARCHIVE"
ARCHIVE_OURS=1
exec > >(tee -a "$ARCHIVE/driver.log") 2>&1

{
  echo "MODEL=$MODEL"; echo "TAG=$TAG"; echo "PHASES=$PHASES"; echo "REPEAT=$REPEAT"; echo "TASKS=$TASKS"
  echo "PI_N=$PI_N"; echo "TASK_GAP=$TASK_GAP"; echo "COOLDOWN=$COOLDOWN"; echo "PROXY_CMD=$PROXY_CMD"; echo "GIT=$(git describe --always --dirty 2>/dev/null)"
  echo "STARTED=$(date -u +%FT%TZ)"
} > "$ARCHIVE/sweep.env"
printf 'label\tphase\tenv\tarm\tkind\tmodel\tstart\tend\tresult\n' > "$ARCHIVE/manifest.tsv"

CONTROL="$(mktemp "${TMPDIR:-/tmp}/m365-framing.XXXXXX")"
PROXY_PID=""
stop_proxy() {
  [ -n "$PROXY_PID" ] || return 0
  kill "$PROXY_PID" 2>/dev/null; wait "$PROXY_PID" 2>/dev/null; PROXY_PID=""
}
trap 'stop_proxy; rm -f "$CONTROL"' EXIT
trap 'echo "interrupted" > "$ARCHIVE/FAILED"; exit 130' INT TERM

# The proxy for one arm, writing its debug log and frames straight into the archive.
start_proxy() {
  local label="$1" penv="$2"
  : > "$CONTROL"
  # shellcheck disable=SC2086  # penv is a validated KEY=VAL list; PROXY_CMD is a command line
  env "${BASE_ENV[@]}" M365_FRAMING_FILE="$CONTROL" \
    M365_LOG_FILE="$ARCHIVE/$label-debug.log" M365_FRAME_DIR="$ARCHIVE/$label-frames" \
    $penv $PROXY_CMD "$PORT" > "$ARCHIVE/$label-proxy.out" 2>&1 &
  PROXY_PID=$!
  for _ in $(seq 1 120); do
    curl -s -m2 "http://localhost:$PORT/health" >/dev/null && return 0
    kill -0 "$PROXY_PID" 2>/dev/null || { PROXY_PID=""; return 1; }
    sleep 1
  done
  return 1
}

RESULT=""
THROTTLED=""
EXHAUSTED=""
run_bench_arm() {
  local label="$1" arm="$2" model="$3" json
  if [ "$arm" = default ]; then : > "$CONTROL"; else echo "$arm" > "$CONTROL"; fi
  node scripts/bench/run.mjs --base-url "http://localhost:$PORT/v1" --model "$model" \
    --label "$label" --repeat "$REPEAT" --task-gap "$TASK_GAP" ${TASKS:+--tasks "$TASKS"} 2>&1 | tee "$ARCHIVE/$label-bench.txt"
  json="$(sed -n 's/^\[bench\] → //p' "$ARCHIVE/$label-bench.txt" | tail -1)"
  [ -n "$json" ] && [ -f "$json" ] && cp "$json" "$ARCHIVE/$label.json"
  RESULT="$(grep -o 'SOLVED [0-9]*/[0-9]*' "$ARCHIVE/$label-bench.txt" | tail -1)"
  if grep -q '^\[bench\] THROTTLED' "$ARCHIVE/$label-bench.txt"; then THROTTLED=1; RESULT="$RESULT (stopped: throttled)"; fi
  if grep -q '^\[bench\] PRIORITY ACCESS EXHAUSTED' "$ARCHIVE/$label-bench.txt"; then EXHAUSTED=1; RESULT="$RESULT (stopped: priority access exhausted)"; fi
}

run_pi_arm() {
  local label="$1" task="${2#pi=}" model="$3" rc
  : > "$CONTROL"
  N="$PI_N" TASK="$task" PORT="$PORT" MODEL="$model" COOLDOWN="$COOLDOWN" CSV="$ARCHIVE/$label.csv" \
    bash scripts/bench/pi-reliability.sh
  rc=$?
  # pi-reliability leaves a failed run's dir in /tmp; keep its output with the arm.
  tail -n+2 "$ARCHIVE/$label.csv" 2>/dev/null | while IFS=, read -r run _ outcome _ dir; do
    if [ "$outcome" != SOLVED ] && [ -f "$dir/pi.out" ]; then cp "$dir/pi.out" "$ARCHIVE/$label-run$run-pi.out"; fi
  done
  RESULT="$(tail -n+2 "$ARCHIVE/$label.csv" 2>/dev/null | awk -F, '$3=="SOLVED"{s++}END{printf "SOLVED %d/%d", s, NR}')"
  if [ "$rc" = 3 ]; then THROTTLED=1; RESULT="$RESULT (stopped: throttled)"; fi
}

# --- run -------------------------------------------------------------------
slot=0
for i in "${!names[@]}"; do
  name="${names[$i]}"; penv="${envs[$i]}"; model="${models[$i]}"
  [ "$i" -gt 0 ] && { echo "[sweep] phase cooldown ${PHASE_COOLDOWN}s"; sleep "$PHASE_COOLDOWN"; }
  echo "==================== PHASE $name  model=$model  env=[${penv:-none}]  $(date -u +%T)Z ===================="
  IFS=',' read -ra al <<<"${armlists[$i]}"
  for j in "${!al[@]}"; do
    arm="${al[$j]}"
    slot=$((slot + 1))
    label="$TAG-$name-$slot-${arm/=/-}"
    kind=bench; [[ "$arm" == pi=* ]] && kind=pi
    echo "==================== ARM $slot/$total_arms: $arm  ($label)  $(date -u +%T)Z ===================="
    start_proxy "$label" "$penv" || die "the proxy for $label didn't come up — see $ARCHIVE/$label-proxy.out"
    start="$(date -u +%FT%TZ)"
    if [ "$kind" = pi ]; then run_pi_arm "$label" "$arm" "$model"; else run_bench_arm "$label" "$arm" "$model"; fi
    stop_proxy
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$name" "$penv" "$arm" "$kind" "$model" \
      "$start" "$(date -u +%FT%TZ)" "$RESULT" >> "$ARCHIVE/manifest.tsv"
    echo "$label : $RESULT" >> "$ARCHIVE/summary.txt"
    # A throttled account fails every later arm the same way, and each attempt
    # keeps the throttle alive (2026-10-04: 26 min of throttled tasks, §24).
    if [ -n "$THROTTLED" ]; then
      die "throttled in $label — stopping the sweep; re-run the remaining arms once the throttle has lifted"
    fi
    # The model's priority-access budget (Opus 5.5) is used up until midnight UTC
    # (weekly: Monday); every later arm on it would only measure the 429.
    if [ -n "$EXHAUSTED" ]; then
      die "priority access exhausted in $label — stopping the sweep; re-run the remaining arms after the reset"
    fi
    # Between arms of a phase; the phase cooldown covers the gap to the next phase.
    if [ "$j" -lt $(( ${#al[@]} - 1 )) ]; then
      echo "[sweep] cooldown ${COOLDOWN}s"; sleep "$COOLDOWN"
    fi
  done
done

date -u +%FT%TZ > "$ARCHIVE/DONE"
echo "==================== SUMMARY ($TAG) ===================="
cat "$ARCHIVE/summary.txt"
echo "[sweep] analyze: node scripts/bench/analyze-arms.mjs $ARCHIVE"
