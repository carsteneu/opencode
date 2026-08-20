#!/usr/bin/env python3
"""Extract boot-phase timeline metrics from runs produced by ab-server-boot.sh.

Per-run metrics (from opencode.log + .tty/.frame):
  TTFD      — "Time to first draw" printed by the TUI when OPENCODE_SHOW_TTFD=1
  boot->wb  — bootstrapping -> first "watcher backend"  (total server boot window)
  init_gap  — plugin-init marker -> first "watcher backend" (plugin-init + tail inits)
  mcp_gap   — "booting location services" -> "server unavailable" (client poll window)

Note: opencode.log lines are NOT strictly time-ordered (client/server writes interleave).
We take the EARLIEST timestamp per marker; negative deltas are dropped as marker mismatches.

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
    "unav": "server unavailable",
}
METRICS = ("boot->wb", "init_gap", "mcp_gap")


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
    return {k: min(v, default=None) for k, v in times.items()}


def ttfd(path_stem):
    for src in (path_stem + ".frame", path_stem + ".tty"):
        if os.path.exists(src):
            m = re.search(r"Time to first draw: ([\d.]+)", open(src, errors="ignore").read())
            if m:
                return float(m.group(1))
    return None


def parse(t):
    return datetime.fromisoformat(t.replace("Z", "+00:00"))


def delta_ms(a, b):
    if not a or not b:
        return None
    d = (parse(b) - parse(a)).total_seconds() * 1000
    return d if d >= 0 else None


def main():
    res = sys.argv[1]
    tags = sys.argv[2:4] if len(sys.argv) > 3 else ["A", "B"]
    for tag in tags:
        series = {m: [] for m in METRICS}
        ttfd_vals = []
        for name in sorted(os.listdir(res)):
            m = re.match(rf"{tag}-(\d+)\.log$", name)
            if not m:
                continue
            stem = os.path.join(res, name[:-4])
            t = marker_times(stem + ".log")
            vals = {
                "boot->wb": delta_ms(t["boot"], t["wb"]),
                "init_gap": delta_ms(t["init"], t["wb"]),
                "mcp_gap": delta_ms(t["loc"], t["unav"]),
            }
            tv = ttfd(stem)
            if tv is not None:
                ttfd_vals.append(tv)
            pretty = " ".join(f"{k}={v is not None and '%.0fms' % v or 'n/a'}" for k, v in vals.items())
            print(f"{tag}{m.group(1)}: TTFD={tv is not None and '%.0fms' % tv or 'n/a'} {pretty}")
            for k, v in vals.items():
                if v is not None:
                    series[k].append(v)
        for metric, vals in sorted(series.items()):
            if vals:
                vals.sort()
                print(f"  {tag} {metric}: median={vals[len(vals) // 2]:.0f}ms min={vals[0]:.0f} max={vals[-1]:.0f} n={len(vals)}")
        if ttfd_vals:
            ttfd_vals.sort()
            print(f"  {tag} TTFD: median={ttfd_vals[len(ttfd_vals) // 2]:.0f}ms min={ttfd_vals[0]:.0f} max={ttfd_vals[-1]:.0f} n={len(ttfd_vals)}")


if __name__ == "__main__":
    main()
