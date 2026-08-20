#!/bin/bash
# Interleaved A/B server-boot measurement between two checkouts (e.g. base vs levers).
# Boots `bun src/bootstrap.ts` per run in tmux with fresh XDG_DATA_HOME, unique ports,
# captures TTY frame + opencode.log for post-hoc timeline extraction.
#
# Usage: ab-server-boot.sh <worktreeA-packages-opencode> <worktreeB-packages-opencode> [outdir] [runs]
# Example:
#   script/perf/ab-server-boot.sh \
#     ../.worktrees/tmp-server-base/packages/opencode \
#     ./packages/opencode /tmp/ab-server 3
#
# Safety: only its own tmux sessions (abm-*) and temp XDG dirs are created/removed.
# No broad process kills — sessions are ended per-name via tmux kill-session.
set -u
export PATH="$HOME/.bun/bin:$PATH"
A="${1:?worktree A packages/opencode path}"
B="${2:?worktree B packages/opencode path}"
OUT="${3:-/tmp/opencode/ab-server}"
RUNS="${4:-3}"
BASE_PORT="${AB_BOOT_BASE_PORT:-4180}"
mkdir -p "$OUT"

run_one() {
  local wt="$1" tag="$2" idx="$3"
  local port=$((BASE_PORT + idx))
  local data; data=$(mktemp -d /tmp/oc-ab.XXXXXX)
  local sess="abm-${tag}-${idx}"
  tmux kill-session -t "$sess" 2>/dev/null
  tmux new-session -d -s "$sess" -x 110 -y 34
  tmux send-keys -t "$sess" "cd $wt && XDG_DATA_HOME=$data bun src/bootstrap.ts --port $port > $OUT/$tag-$idx.tty 2>&1" Enter
  sleep 13
  tmux capture-pane -pt "$sess" -S -5000 > "$OUT/$tag-$idx.frame" 2>/dev/null
  tmux send-keys -t "$sess" C-c
  sleep 3
  tmux kill-session -t "$sess" 2>/dev/null
  cp "$data/opencode/log/opencode.log" "$OUT/$tag-$idx.log" 2>/dev/null || echo "NO LOG" > "$OUT/$tag-$idx.log"
}

# Primers: warm plugin dependency installs in both trees, results discarded.
for wt in "$A" "$B"; do
  d=$(mktemp -d /tmp/oc-pr.XXXXXX)
  tmux kill-session -t abm-primer 2>/dev/null
  tmux new-session -d -s abm-primer -x 110 -y 34
  tmux send-keys -t abm-primer "cd $wt && XDG_DATA_HOME=$d bun src/bootstrap.ts --port $((BASE_PORT - 1)) 2>&1 | head -50" Enter
  sleep 12
  tmux send-keys -t abm-primer C-c; sleep 2; tmux kill-session -t abm-primer 2>/dev/null
done

i=0
for round in $(seq 1 "$RUNS"); do
  i=$((i+1)); run_one "$A" "A" "$i"; echo "A$i done"
  run_one "$B" "B" "$round"; echo "B$round done"
done
echo "ALL DONE — extract with: python3 script/perf/boot-timeline.py $OUT"
