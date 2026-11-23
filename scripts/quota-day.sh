#!/usr/bin/env bash
# The usage-limit study's day plan (docs/m365-copilot-api.md §7, data in docs/quota/).
# Run one phase at a time and read the rows between phases:
#
#   scripts/quota-day.sh reset     # 23:58Z–00:06Z: probe every 20 s until the first Success
#   scripts/quota-day.sh cost      # what each kind of turn costs (~25 turns)
#   scripts/quota-day.sh race N    # N concurrent turns at once (run with N > turns left)
#   scripts/quota-day.sh web       # one web-UI turn + screenshot (WEB_OUT=dir)
#
# Text turns report their own after-value (`ttud`). Anything that doesn't is bracketed
# by controls, so its cost is (before − after) − 1.
set -uo pipefail
cd "$(dirname "$0")/.."
export HOME_DIR=${QUOTA_HOME:-/tmp/quota-study/home}
D() { env HOME="$HOME_DIR" M365_NO_INTERACTIVE=1 timeout 200 node scripts/quota-direct.mjs "$@" 2>/dev/null \
  | jq -rc '[.exp,.t0[11:19],.tone,.result,.errorCode,.ttud,(.reply[:40])]|@tsv'; }
ctl() { D "$1-ctl" Gpt_5_5_Chat; }
pause() { sleep "${PACE:-20}"; }
FILLER=$(python3 -c 'print(("The quick brown fox jumps over the lazy dog. " * 1400)[:60000])')
HUGE=$(python3 -c 'print(("The quick brown fox jumps over the lazy dog. " * 10000)[:400000])')

case ${1:-} in
reset)
  until [ "$(date -u +%H%M)" = 2358 ]; do sleep 5; done
  for _ in $(seq 1 25); do
    row=$(D reset Gpt_5_5_Chat); echo "$row"
    # A Success at 0 can be the ~8% leak; the reset is the first one with turns left.
    [[ $row == *Success* && $(cut -f6 <<<"$row") != 0 ]] && break
    sleep 20
  done ;;
cost)
  ctl c1; pause
  D c2-reasoning Gpt_5_5_Reasoning; pause
  D c3-magic magic; pause
  D c4-gpt54-reasoning Gpt_5_4_Reasoning; pause
  D c5-long-60k Gpt_5_5_Chat "$FILLER

Ignore the text above. Reply with the single word pong."; pause
  D c6-search magic "What is the weather in Aarhus, Denmark right now? One sentence."; pause
  # Follow-up turns in one conversation, through the proxy (it keeps the conversation).
  scripts/quota-probe.sh c7-followup gpt-5.5 "Remember the number 41. Reply ok." | jq -c '{exp,http,reply}'; pause
  curl -s 127.0.0.1:24034/v1/chat/completions -H 'content-type: application/json' -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"Remember the number 41. Reply ok."},{"role":"assistant","content":"ok"},{"role":"user","content":"What number? Reply with just the number."}]}' \
    | jq -c '{exp:"c7-followup-2",reply:.choices[0].message.content,ttud:.usage.x_m365_total_turns_daily_remaining,conv:.usage.x_m365_conversation_messages}'; pause
  ctl c8-pre; pause
  curl -s -m 300 -o /dev/null -w 'c8-image http %{http_code}\n' 127.0.0.1:24034/v1/images/generations -H 'content-type: application/json' -d '{"prompt":"a red bicycle leaning on a brick wall, flat illustration","size":"1024x1024"}'; pause
  ctl c8-post; pause
  D c9-claude-license Claude_Sonnet; pause
  ctl c9-post; pause
  D c10-cancel magic "Write a 1500-word essay about the history of lighthouses." --timeout 2500; sleep 90
  ctl c10-post; pause
  D c11-huge-400k Gpt_5_5_Chat "$HUGE

Reply with the single word pong."; pause
  ctl c11-post; pause
  env M365_SCENARIO=OfficeWebIncludedCopilot M365_LICENSE_TYPE=Starter HOME="$HOME_DIR" M365_NO_INTERACTIVE=1 \
    node scripts/quota-direct.mjs c12-streamhub Gpt_5_5_Chat --transport streamhub 2>/dev/null | jq -rc '[.exp,.result,.ttud,(.billing|tostring)[:200]]|@tsv'; pause
  ctl c12-post; pause
  D c13-variant-meter Gpt_5_5_Chat "Reply with the single word pong." --variants-add feature.EnableMeteringThrottleChatRequest,feature.EnableFreeMSA_AADUser100TurnLimit; pause
  D c14-reasoning-2 Gpt_5_6_Reasoning ;;
race)
  n=${2:-6}
  for i in $(seq 1 "$n"); do D "race-$n-$i" Gpt_5_5_Chat & done; wait ;;
web)
  (cd /tmp/quota-study && CHROMIUM_PATH=$(command -v chromium) timeout 300 node web.mjs "${WEB_OUT:-/tmp/quota-study/web-$(date -u +%H%M%S)}" "Reply with the single word pong.") ;;
*) sed -n 2,12p "$0"; exit 1 ;;
esac
