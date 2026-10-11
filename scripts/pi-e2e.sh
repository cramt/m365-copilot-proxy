#!/usr/bin/env bash
set -euo pipefail

PROXY_URL="${PROXY_URL:-http://localhost:4199/v1}"
MODEL="${MODEL:-gpt-5.5-think-deeper}"
KEY="${KEY:-sk-local}"
COOLDOWN="${COOLDOWN:-120}"
ONLY="${ONLY:-}"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi
if [[ ! "$COOLDOWN" =~ ^[0-9]+$ ]]; then
  echo "COOLDOWN must be a nonnegative integer" >&2
  exit 2
fi
if [[ -n "$ONLY" ]]; then
  IFS=, read -r -a selected <<< "$ONLY"
  for name in "${selected[@]}"; do
    case "$name" in
      bash|write|read|edit|multistep|go-du) ;;
      *) echo "Unknown task: $name" >&2; exit 2 ;;
    esac
  done
fi
REPO_NODE_MODULES="$PWD/node_modules"
if (( ! DRY_RUN )); then
  for executable in pi node perl python3 go du; do
    command -v "$executable" >/dev/null || { echo "Missing executable: $executable" >&2; exit 2; }
  done
  PIH="$(mktemp -d)"
  trap 'rm -rf "$PIH"' EXIT
  node --input-type=module - "$PIH" "$PROXY_URL" "$MODEL" "$KEY" <<'NODE'
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [home, baseUrl, model, apiKey] = process.argv.slice(2);
const config = join(home, ".pi", "agent");
mkdirSync(config, { recursive: true });
writeFileSync(join(config, "models.json"), JSON.stringify({ providers: { m365: {
  api: "openai-completions", apiKey, baseUrl,
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false },
  models: [{ id: model, name: model }],
} } }));
writeFileSync(join(config, "settings.json"), JSON.stringify({ defaultModel: model, defaultProvider: "m365", enableInstallTelemetry: false }));
NODE
fi

RESULTS=()
first=1
passed=0
failed=0
M="E2E_$(date +%s)_$$"

run_pi() {
  local name="$1" task="$2" verify="$3"
  if [[ -n "$ONLY" && ",$ONLY," != *",$name,"* ]]; then return; fi
  if (( DRY_RUN )); then
    echo "[dry-run] task=$name model=$MODEL proxy=$PROXY_URL cooldown=${COOLDOWN}s"
    return
  fi
  if (( ! first )); then
    echo "[e2e] cooldown ${COOLDOWN}s"
    sleep "$COOLDOWN"
  fi
  first=0
  local dir rc verdict elapsed
  dir="$(mktemp -d)"
  (cd "$dir" && "setup_${name//-/_}") || return 2
  echo "[e2e] task=$name model=$MODEL dir=$dir"
  local started=$SECONDS
  task="$task

Run marker: $M-$name"
  rc=0
  (cd "$dir" && HOME="$PIH" PI_OFFLINE=1 perl -e 'alarm shift; exec @ARGV' 300 pi -p \
    --provider m365 --model "$MODEL" --tools read,write,edit,bash \
    --no-context-files --no-extensions --no-skills --approve "$task") > "$dir/.pi-out.txt" 2>&1 || rc=$?
  tail -15 "$dir/.pi-out.txt" | sed 's/^/[pi] /'
  if (( rc == 0 )) && (cd "$dir" && "${verify//-/_}"); then
    verdict=PASS
    passed=$((passed + 1))
  else
    verdict=FAIL
    failed=$((failed + 1))
  fi
  elapsed=$((SECONDS - started))
  echo "[$name] $verdict rc=$rc ${elapsed}s"
  RESULTS+=("$name: $verdict (${elapsed}s), evidence=$dir/.pi-out.txt")
}

setup_bash() { :; }
verify_bash() { grep -qx "$M" sentinel.txt; }
setup_write() { :; }
verify_write() { [[ "$(cat notes/todo.md 2>/dev/null)" == "- [ ] ship $M" ]]; }
setup_read() { echo "secret=$M-READ" > config.ini; }
verify_read() { grep -q "$M-READ" .pi-out.txt; }
setup_edit() { printf 'def add(a, b):\n    return a - b\n\nprint(add(2, 3))\n' > calc.py; }
verify_edit() { [[ "$(python3 calc.py 2>/dev/null)" == "5" ]]; }
setup_multistep() { mkdir -p data; for number in 1 2 3 4; do echo "$((number * 7))" > "data/n$number.txt"; done; }
verify_multistep() { grep -qx "70" total.txt; }

setup_go_du() {
  [[ -d "$REPO_NODE_MODULES" ]] || { echo "Missing $REPO_NODE_MODULES" >&2; return 1; }
  mkdir -p fixture/sub
  printf 'sample\n' > fixture/sub/sample.txt
  ln -s sub/sample.txt fixture/link
}
verify_go_du() {
  [[ -f folder-sizes.go ]] || { echo "Go source missing" >&2; return 1; }
  go build -o folder-sizes folder-sizes.go || return 1
  local fixture_output measured_output allocated du_kib du_bytes difference tolerance
  fixture_output="$(./folder-sizes fixture)" || return 1
  [[ "$fixture_output" == *"sub"* && "$fixture_output" == *"link"* ]] || {
    echo "Go script did not summarize the fixture and its symlink" >&2; return 1;
  }
  measured_output="$(./folder-sizes "$REPO_NODE_MODULES")" || return 1
  printf '%s\n' "$measured_output" > .go-du-output.txt
  allocated="$(printf '%s\n' "$measured_output" | awk '/^Total allocated bytes: [0-9]+$/ {print $4; exit}')"
  [[ "$allocated" =~ ^[0-9]+$ && "$allocated" -gt 0 ]] || {
    echo "Missing numeric allocated-byte total" >&2; return 1;
  }
  du_kib="$(du -sk "$REPO_NODE_MODULES" | awk '{print $1}')"
  [[ "$du_kib" =~ ^[0-9]+$ ]] || return 1
  du_bytes=$((du_kib * 1024))
  difference=$((allocated > du_bytes ? allocated - du_bytes : du_bytes - allocated))
  tolerance=$((du_bytes / 20))
  (( tolerance < 2097152 )) && tolerance=2097152
  echo "[go-du] script=$allocated bytes du=$du_bytes bytes difference=$difference tolerance=$tolerance"
  (( difference <= tolerance )) || return 1
  grep -Fq "$allocated" .pi-out.txt || {
    echo "Pi did not report the measured allocated-byte total" >&2; return 1;
  }
  grep -Fq 'node_modules' .pi-out.txt || return 1
}

run_pi bash "Use the bash tool to run exactly: echo $M > sentinel.txt
Then stop." verify_bash
run_pi write "Create the file notes/todo.md containing exactly one line: - [ ] ship $M" verify_write
run_pi read "Read config.ini and tell me the value of 'secret'. Reply with only the value." verify_read
run_pi edit "calc.py has a bug: add() should return the sum. Fix it, then run python3 calc.py to confirm it prints 5." verify_edit
run_pi multistep "Each file in data/ holds one integer. Sum them all and write only the total (digits, no newline issues) to total.txt." verify_multistep
run_pi go-du "Create a standalone Go program at folder-sizes.go that accepts a folder path, recursively calculates apparent bytes and allocated disk bytes (where supported), counts files, directories and symbolic links without following links, handles traversal errors, and summarizes immediate children largest first. First run it on fixture/, then run it on $REPO_NODE_MODULES. Print a line exactly formatted as Total allocated bytes: N (replace N with an unformatted decimal integer). Include the immediate child names and symlinks in the summary. Report the actual allocated-byte total for node_modules as an unformatted decimal integer, plus a useful summary and limitations. Do not modify the repository or guess results." verify_go_du

if (( ! DRY_RUN )); then
  echo "[e2e] SUMMARY ($MODEL): $passed/$((passed + failed)) passed"
  printf '%s\n' "${RESULTS[@]}"
  (( failed == 0 && passed > 0 )) || exit 1
fi