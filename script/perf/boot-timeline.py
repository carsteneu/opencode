#!/usr/bin/env python3
"""Extract boot-phase timeline metrics from opencode.log files produced by ab-server-boot.sh.

Metrics per run:
  boot->wb    — bootstrapping -> first "watcher backend"   (total server boot window)
  init_gap    — plugin-init marker -> first "watcher backend" (plugin-init + tail inits)

Note: opencode.log lines are NOT strictly time-ordered (client/server writes interleave).
We therefore sort matched marker timestamps per marker and take the EARLIEST of each,
and clamp negative deltas to 0 with a warning.

Usage: boot-timeline.py <results-dir> [tagA tagB]   (default tags A B)
"""
import os
import re
import sys
from datetime import datetime

MARKERS = {
    "boot": "bootstrapping",
    "init": "init",
    "wb": "watcher backend",
    "loc": "booting location services",
}


def marker_times(path):
    times = {k: [] for k in MARKERS}
    ts_re = re.compile(r"timestamp=([^ ]+)")
    with open(path, errors="ignore") as fh:
        for line in fh:
            for key, marker in MARKERS.items():
                if f"message={marker}" in line or f'message="{marker}' in line:
                    m = ts_re.search(line)
                    if m:
                        times[key].append(m.group(1))
    return {k: min(v, default=None) for k, v in times.items()}  # earliest occurrence


def parse(t):
    return datetime.fromisoformat(t.replace("Z", "+00:00"))


def delta_ms(a, b):
    if not a or not b:
        return None
    d = (parse(b) - parse(a)).total_seconds() * 1000
    return d if d >= 0 else None  # negative => marker mismatch, drop


def main():
    res = sys.argv[1]
    tags = sys.argv[2:4] if len(sys.argv) > 3 else ["A", "B"]
    for tag in tags:
        series = {"boot->wb": [], "init_gap": []}
        for name in sorted(os.listdir(res)):
            m = re.match(rf"{tag}-(\d+)\.log$", name)
            if not m:
                continue
            t = marker_times(os.path.join(res, name))
            bw = delta_ms(t["boot"], t["wb"])
            ig = delta_ms(t["init"], t["wb"])
            if bw is not None:
                series["boot->wb"].append(bw)
            if ig is not None:
                series["init_gap"].append(ig)
            print(f"{tag}{m.group(1)}: boot->wb={bw and '%.0fms' % bw} init_gap={ig and '%.0fms' % ig}")
        for metric, vals in series.items():
            if vals:
                vals.sort()
                med = vals[len(vals) // 2]
                print(f"  {tag} {metric}: median={med:.0f}ms min={vals[0]:.0f} max={vals[-1]:.0f} n={len(vals)}")


if __name__ == "__main__":
    main()
