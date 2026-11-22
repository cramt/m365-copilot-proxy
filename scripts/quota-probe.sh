#!/usr/bin/env bash
# Send one turn through the proxy and record what was sent, for the usage-limit
# study (docs/m365-copilot-api.md §7). The server-side half of each row
# (TotalTurnUsageDaily, result, tone) comes from scripts/quota-log.mjs; join on time.
#
#   scripts/quota-probe.sh <exp-label> <model> [prompt] [extra-json-merged-into-body]
set -euo pipefail
label=$1 model=$2 prompt=${3:-Reply with the single word pong.} extra=${4:-'{}'}
out=$(dirname "$0")/../docs/quota/sent.jsonl
mkdir -p "$(dirname "$out")"
body=$(jq -nc --arg m "$model" --arg p "$prompt" --argjson x "$extra" '{model:$m,messages:[{role:"user",content:$p}]} * $x')
t0=$(date -u +%FT%T.%3NZ)
resp=$(curl -s -m 600 -w '\n%{http_code}' 127.0.0.1:24034/v1/chat/completions -H 'content-type: application/json' -d "$body")
t1=$(date -u +%FT%T.%3NZ)
code=${resp##*$'\n'} json=${resp%$'\n'*}
jq -nc --arg l "$label" --arg m "$model" --arg t0 "$t0" --arg t1 "$t1" --argjson c "$code" \
  --argjson n "${#prompt}" --argjson x "$extra" --arg r "$json" '
  ($r | fromjson? // {raw: $r}) as $j |
  {exp:$l, t0:$t0, t1:$t1, model:$m, prompt_chars:$n, extra:$x, http:$c,
   err:($j.error.code // $j.error.type // null), reply:(($j.choices[0].message.content // $j.error.message // $j.raw // "")[:160])}' \
  | tee -a "$out"
