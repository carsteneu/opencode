#!/bin/bash
# Interleaved A/B server-boot measurement between two variants.
# Each variant is either a packages/opencode directory (dev mode: `bun src/bootstrap.ts`)
# or a compiled opencode binary (production mode: `<binary> --port N` from the repo root).
# Per run: fresh XDG_DATA_HOME, unique port, tmux capture, OPENCODE_SHOW_TTFD=1,
# copies opencode.log for post-hoc timeline extraction.
#
# Usage: ab-server-boot.sh <variantA> <variantB> [outdir] [runs]
# Examples:
#   # dev tree vs dev tree
#   script/perf/ab-server-boot.sh \
#     ../.worktrees/tmp-server-base/packages/opencode \
#     ./packages/opencode /tmp/ab-server 3
#   # installed binary vs freshly built one
#   script/perf/ab-server-boot.sh \
#     ~/.opencode/bin/opencode \
#     packages/opencode/dist/local-only/1.18.18-patched.130-serverstartup/opencode \
#     /tmp/ab-bin 3
#
# Safety: only its own tmux sessions (abm-*) and temp XDG dirs are created/removed.
# No broad process kills — sessions are ended per-name via tmux kill-session.
set -u
export PATH="$HOME/.bun/bin:$PATH"
A="${1:?variant A: packages/opencode dir or opencode binary}"
B="${2:?variant B: packages/opencode dir or opencode binary}"
OUT="${3:-/tmp/opencode/ab-server}"
RUNS="${4:-3}"
BASE_PORT="${AB_BOOT_BASE_PORT:-4180}"
RUN_CWD="${AB_BOOT_CWD:-$HOME/projects/opencode}"   # cwd for binary runs (project config/plugins)
mkdir -p "$OUT"

# boot_cmd <variant> <port> -> shell command string
boot_cmd() {
  if [ -d "$1" ]; then
    echo "cd $1 && XDG_DATA_HOME=%%DATA%% OPENCODE_SHOW_TTFD=1 bun src/bootstrap.ts --port $2"
  else
    echo "cd $RUN_CWD && XDG_DATA_HOME=%%DATA%% OPENCODE_SHOW_TTFD=1 $1 --port $2"
  fi
}

run_one() {
  local var="$1" tag="$2" idx="$3"
  local port=$((BASE_PORT + idx))
  local data; data=$(mktemp -d /tmp/oc-ab.XXXXXX)
  local sess="abm-${tag}-${idx}"
  local cmd; cmd=$(boot_cmd "$var" "$port" | sed "s|%%DATA%%|$data|g")
  tmux kill-session -t "$sess" 2>/dev/null
  tmux new-session -d -s "$sess" -x 110 -y 34
  tmux send-keys -t "$sess" "$cmd > $OUT/$tag-$idx.tty 2>&1" Enter
  sleep 13
  tmux capture-pane -pt "$sess" -S -5000 > "$OUT/$tag-$idx.frame" 2>/dev/null
  tmux send-keys -t "$sess" C-c
  sleep 3
  tmux kill-session -t "$sess" 2>/dev/null
  cp "$data/opencode/log/opencode.log" "$OUT/$tag-$idx.log" 2>/dev/null || echo "NO LOG" > "$OUT/$tag-$idx.log"
}

# Primers: warm plugin dependency installs / binary caches, results discarded.
for var in "$A" "$B"; do
  d=$(mktemp -d /tmp/oc-pr.XXXXXX)
  cmd=$(boot_cmd "$var" $((BASE_PORT - 1)) | sed "s|%%DATA%%|$d|g")
  tmux kill-session -t abm-primer 2>/dev/null
  tmux new-session -d -s abm-primer -x 110 -y 34
  tmux send-keys -t abm-primer "$cmd 2>&1 | head -50" Enter
  sleep 12
  tmux send-keys -t abm-primer C-c; sleep 2; tmux kill-session -t abm-primer 2>/dev/null
done

i=0
for round in $(seq 1 "$RUNS"); do
  i=$((i+1)); run_one "$A" "A" "$i"; echo "A$i done"
  run_one "$B" "B" "$round"; echo "B$round done"
done
echo "ALL DONE — extract with: python3 script/perf/boot-timeline.py $OUT A B"
