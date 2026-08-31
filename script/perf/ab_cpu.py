#!/usr/bin/env python3
"""Parallel host-CPU sampling + normalization for ab-server-boot.sh A/B runs.

Subcommands:
  sample <csv>                  foreground 0.4 s bins: epoch, busy_pct, load1
                                (stop via SIGTERM from the wrapper)
  analyze <runs_dir> <A> <B> <csv>
                                per-run 20 s window stats from *.frame mtimes,
                                TTFD via boot-timeline.py, Pearson r and
                                slope-normalized A/B median delta

Why: single-variable discipline (#83591) requires the contamination channel to
be measured, not assumed. Background load shifts TTFD by hundreds of ms; the
interleaved design cancels slow drift, the slope correction cancels residual
per-window load differences (power profile must stay constant, #85449).
"""
import csv
import glob
import math
import os
import re
import statistics
import subprocess
import sys
import time


def sample(csv_path, interval=0.4):
    def cpu_ticks():
        for line in open("/proc/stat"):
            if line.startswith("cpu "):
                f = [int(x) for x in line.split()[1:8]]
                idle = f[3] + f[4]
                return sum(f), idle
        raise RuntimeError("no cpu line in /proc/stat")

    prev = None
    with open(csv_path, "w") as out:
        out.write("t,busy_pct,load1\n")
        out.flush()
        while True:
            total, idle = cpu_ticks()
            load = open("/proc/loadavg").read().split()[0]
            if prev is not None:
                pt, pi = prev
                busy = 100.0 * (total - pt - (idle - pi)) / (total - pt)
                out.write(f"{time.time():.3f},{busy:.1f},{load}\n")
                out.flush()
            prev = (total, idle)
            time.sleep(interval)


def analyze(runs_dir, a, b, csv_path, window_s=20.0):
    timeline = subprocess.run(
        ["python3", os.path.join(os.path.dirname(__file__), "boot-timeline.py"), runs_dir, a, b],
        capture_output=True, text=True).stdout
    ttfd = {f"{m[1]}-{m[2]}": int(m[3]) for m in
            re.finditer(rf"([{a}{b}])(\d+): TTFD=(\d+)ms", timeline)}

    rows = []
    with open(csv_path) as f:
        for r in csv.DictReader(f):
            rows.append((float(r["t"]), float(r["busy_pct"]), float(r["load1"])))
    if not rows:
        sys.exit("empty sample csv")

    def window(end):
        sel = [(b, l) for t, b, l in rows if end - window_s <= t <= end]
        if not sel:
            return None
        return (statistics.mean(x[0] for x in sel),
                statistics.mean(x[1] for x in sel))

    data = []
    for path in sorted(glob.glob(os.path.join(runs_dir, "*.frame"))):
        run = os.path.basename(path).rsplit(".", 1)[0]
        end = os.path.getmtime(path)
        st = window(end)
        if st and run in ttfd:
            data.append((run, ttfd[run], *st))

    print(f"{'run':>6} {'TTFD':>6} {'cpu%':>6} {'load1':>6}")
    for d in data:
        print(f"{d[0]:>6} {d[1]:6} {d[2]:6.1f} {d[3]:6.2f}")

    def med(vals):
        return statistics.median(vals)

    # d = (run, ttfd, busy_pct, load1) — positional access avoids shadowing a/b
    variants = {a: [d for d in data if d[0].split("-")[0] == a],
                b: [d for d in data if d[0].split("-")[0] == b]}
    if not all(variants.values()):
        sys.exit("missing runs for at least one variant")

    for v in (a, b):
        g = variants[v]
        print(f"\n{v}: n={len(g)} TTFD median={med(d[1] for d in g):.0f}ms "
              f"cpu mean={statistics.mean(d[2] for d in g):.1f}% "
              f"load mean={statistics.mean(d[3] for d in g):.2f}")

    cpu = [d[2] for d in data]
    ms = [d[1] for d in data]
    mc, mt = statistics.mean(cpu), statistics.mean(ms)
    cov = sum((x - mc) * (y - mt) for x, y in zip(cpu, ms))
    sc = math.sqrt(sum((x - mc) ** 2 for x in cpu) * sum((y - mt) ** 2 for y in ms))
    r = cov / sc if sc else 0.0
    slope = cov / sum((x - mc) ** 2 for x in cpu)
    print(f"\npearson r (cpu% vs TTFD) = {r:.2f}, slope = {slope:.1f} ms per cpu%")

    names = {v: [d[1] - slope * (d[2] - mc) for d in variants[v]] for v in (a, b)}
    raw_delta = med(d[1] for d in variants[b]) - med(d[1] for d in variants[a])
    norm_delta = med(names[b]) - med(names[a])
    print(f"TTFD raw  median: {a}={med(d[1] for d in variants[a]):.0f}ms "
          f"{b}={med(d[1] for d in variants[b]):.0f}ms delta {raw_delta:+.0f}ms")
    print(f"TTFD norm median: {a}={med(names[a]):.0f}ms {b}={med(names[b]):.0f}ms "
          f"delta {norm_delta:+.0f}ms")


if __name__ == "__main__":
    if sys.argv[1] == "sample":
        sample(sys.argv[2])
    elif sys.argv[1] == "analyze":
        analyze(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
    else:
        sys.exit(__doc__)
