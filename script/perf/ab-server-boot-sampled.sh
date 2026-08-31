#!/bin/bash
# A/B boot benchmark with parallel host-CPU sampling and normalized analysis.
# Usage: ab-server-boot-sampled.sh <variantA> <variantB> <outdir> <runs>
# Power profile must be constant across arms (record it: powerprofilesctl get).
set -eu
A=$1
B=$2
OUT=$3
RUNS=${4:-3}

mkdir -p "$OUT"
CSV="$OUT/samples.csv"
python3 "$(dirname "$0")/ab_cpu.py" sample "$CSV" &
SAMPLER=$!
trap 'kill "$SAMPLER" 2>/dev/null || true' EXIT

bash "$(dirname "$0")/ab-server-boot.sh" "$A" "$B" "$OUT/runs" "$RUNS"

kill "$SAMPLER" 2>/dev/null || true
sleep 0.5
python3 "$(dirname "$0")/ab_cpu.py" analyze "$OUT/runs" A B "$CSV"
