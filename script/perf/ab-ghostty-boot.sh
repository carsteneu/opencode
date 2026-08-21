#!/bin/bash
# Interleaved A/B TUI-boot measurement inside REAL Ghostty windows,
# comparing two opencode binaries as the user sees them — including
# OSC 10/11 theme detection round-trips that tmux harnesses silence.
#
# Method: ghostty -e script -fec 'timeout N opencode ...' out.log
#   - opencode gets a real pty (via util-linux script) inside a real ghostty window
#   - everything rendered (incl. "Time to first draw") is logged to out.log
#   - cleanup is timeout-based (TERM to the exact process) — no pattern kills
#
# Usage: ab-ghostty-boot.sh <binaryA> <binaryB> [outdir] [runs]
# Note: opens 2*runs ghostty windows sequentially (~9s each). Focus stealing possible.
set -u
A="${1:?binary A}"; B="${2:?binary B}"
OUT="${3:-/tmp/opencode/ab-ghostty}"; RUNS="${4:-3}"
mkdir -p "$OUT"
CWD="${AB_BOOT_CWD:-$HOME/projects/opencode}"
BASE_PORT="${AB_GHOSTTY_BASE_PORT:-4230}"
RUN_SECONDS="${AB_GHOSTTY_RUN_SECONDS:-12}"

run_one() {
  local bin="$1" tag="$2" idx="$3"
  local data; data=$(mktemp -d /tmp/oc-gh.XXXXXX)
  local port=$((BASE_PORT + idx))
  local log="$OUT/$tag-$idx.io" tlog="$OUT/$tag-$idx.tty"
  # ghostty stays in foreground of this shell; script+timeout self-terminate the run
  timeout "$((RUN_SECONDS + 25))" ghostty --window-decoration=false -e \
    script -qfec "env XDG_DATA_HOME=$data OPENCODE_SHOW_TTFD=1 timeout $RUN_SECONDS \"$bin\" --port $port" "$log" \
    > "$tlog" 2>&1
  cp "$data/opencode/log/opencode.log" "$OUT/$tag-$idx.log" 2>/dev/null || echo "NO LOG" > "$OUT/$tag-$idx.log"
  local ttfd; ttfd=$(grep -aoE "Time to first draw: [0-9.]+" "$log" 2>/dev/null | head -1)
  echo "$tag$idx: ${ttfd:-TTFD-not-found}"
}

i=0
for r in $(seq 1 "$RUNS"); do
  i=$((i+1)); run_one "$A" A "$i"
  run_one "$B" B "$r"
done
echo "DONE — phase markers: python3 script/perf/boot-timeline.py $OUT A B"
