#!/usr/bin/env python3
"""B1 premise measurement — paired TUI series.

Starts the v2 and the v1 TUI side by side in isolated environments and
alternates one stream per arm, so both arms see the same host conditions
(interleaved / paired design). Idle windows are measured for both arms before
and after the streaming series.

Usage:
  python3 bench/b1_paired_measure.py --rounds 7 --out .yesmem/tmp/b1-paired.json
"""

import argparse
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from b1_common import PROMPT, arm_env, bin_for, clear_stale, find_servers, md5_of  # noqa: E402
from b1_proc import Sampler, integrate  # noqa: E402
from b1_tui_measure import Tui  # noqa: E402


def measure_idle(sampler, window):
    sampler.samples.clear()
    t0 = time.monotonic()
    time.sleep(window)
    t1 = time.monotonic()
    roles = integrate(sampler.samples, t0, t1)
    return {"window_s": t1 - t0, "load": os.getloadavg()[0],
            "per_role": {k: dict(v, cpu_pct=100.0 * v["cpu_s"] / (t1 - t0)) for k, v in roles.items()}}


def measure_stream(tui, sampler, drain, timeout):
    tui.wait_quiet(2.0, 90.0)
    sampler.samples.clear()
    with tui.lock:
        offset = len(tui.raw)
    wall_start = time.time()
    t0 = time.monotonic()
    tui.send(PROMPT)
    dt = tui.wait_quiet(3.0, timeout, offset=offset, start_threshold=200)
    time.sleep(drain)
    t1 = time.monotonic()
    roles = integrate(sampler.samples, t0, t1)
    roles = {k: dict(v, cpu_pct=100.0 * v["cpu_s"] / (t1 - t0)) for k, v in roles.items()}
    with tui.lock:
        term_bytes = len(tui.raw) - offset
    # Wall-clock bounds so token counts can be matched to streams after the fact.
    return {"stream_s": dt, "window_s": t1 - t0, "terminal_bytes": term_bytes,
            "wall_start": wall_start, "wall_end": time.time(),
            "load": os.getloadavg()[0], "per_role": roles}


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=6, help="streams per arm")
    ap.add_argument("--idle-window", type=float, default=20.0)
    ap.add_argument("--settle", type=float, default=20.0)
    ap.add_argument("--ready-timeout", type=float, default=120.0)
    ap.add_argument("--stream-timeout", type=float, default=180.0)
    ap.add_argument("--drain", type=float, default=1.0)
    ap.add_argument("--rows", type=int, default=50)
    ap.add_argument("--cols", type=int, default=200)
    ap.add_argument("--iso", default=os.path.join(here, "..", ".yesmem", "tmp", "iso"))
    ap.add_argument("--tmp", default=os.path.join(here, "..", ".yesmem", "tmp"))
    ap.add_argument("--cwd", default=os.path.join(here, "..", ".yesmem", "tmp", "benchdir"))
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    cwd = os.path.abspath(args.cwd)
    results = {
        "mode": "paired-tui", "host_nproc": os.cpu_count(), "prompt": PROMPT,
        "rows": args.rows, "cols": args.cols, "rounds": args.rounds,
        "started": time.time(),
        "binaries": {a: {"path": bin_for(a), "md5": md5_of(bin_for(a))} for a in ("v2", "v1")},
        "power_profile": subprocess.run(["powerprofilesctl", "get"], capture_output=True, text=True).stdout.strip(),
        "loadavg_at_start": os.getloadavg(),
    }

    for a in ("v2", "v1"):
        stale = clear_stale(a, args.iso)
        if stale:
            results.setdefault("stale_cleared", {})[a] = stale

    tui = {a: Tui(a, arm_env(a, args.iso), cwd, args.rows, args.cols,
                  os.path.join(args.tmp, f"b1-paired-{a}.raw")) for a in ("v2", "v1")}
    sampler = {}
    try:
        for a, t in tui.items():
            ready = t.wait_ready(args.settle, args.ready_timeout)
            print(f"{a}: ready={ready}", file=sys.stderr)
            if not ready:
                raise SystemExit(f"{a} TUI did not become ready")
            # Root the sampler at the server: the v1 shared server detaches, so
            # the TUI is not necessarily its parent.
            servers = find_servers(a, args.iso)
            if len(servers) > 1:
                raise SystemExit(f"{a}: {len(servers)} servers found, expected exactly one: {servers}")
            if servers:
                root_pid, root_role = servers[0][0], "server"
            else:
                root_pid, root_role = t.proc.pid, "client"
            results.setdefault("servers", {})[a] = [{"pid": p, "starttime": s, "cmd": c} for p, s, c in servers]
            results.setdefault("tui_pid", {})[a] = t.proc.pid
            sampler[a] = Sampler(root_pid, root_role=root_role, interval=0.1)
            sampler[a].extra_client_pids.add(t.proc.pid)
            sampler[a].start()
            kids = subprocess.run(["pgrep", "-P", str(t.proc.pid)], capture_output=True, text=True).stdout.split()
            results.setdefault("tui_children", {})[a] = [
                {"pid": int(k), "cmd": open(f"/proc/{k}/cmdline", "rb").read().replace(b"\0", b" ").decode("utf-8", "replace").strip()}
                for k in kids
            ]

        # idle before
        results["idle_before"] = {a: measure_idle(sampler[a], args.idle_window) for a in ("v2", "v1")}

        series = {a: [] for a in ("v2", "v1")}
        for r in range(args.rounds):
            order = ("v2", "v1") if r % 2 == 0 else ("v1", "v2")
            for a in order:
                rec = measure_stream(tui[a], sampler[a], args.drain, args.stream_timeout)
                rec["round"] = r
                if rec["stream_s"] is None:
                    # A window that never saw a stream is mostly idle and would
                    # silently drag that arm's medians down. Drop it.
                    results.setdefault("failed_streams", []).append({"arm": a, "round": r})
                    print(f"  r{r} {a}: NO STREAM DETECTED — record dropped", file=sys.stderr)
                    continue
                series[a].append(rec)
                print(f"  r{r} {a}: stream={rec['stream_s']} win={rec['window_s']:.1f}s "
                      f"load={rec['load']:.1f} "
                      f"roles={ {k: round(v['cpu_pct'], 2) for k, v in rec['per_role'].items()} }",
                      file=sys.stderr)
        results["series"] = series

        results["idle_after"] = {a: measure_idle(sampler[a], args.idle_window) for a in ("v2", "v1")}
        for a in sampler:
            sampler[a].stop_flag.set()
    finally:
        for a, t in tui.items():
            t.close()
        time.sleep(0.5)
        # The v1 shared server detaches and outlives its TUI; clean up our own.
        for a in tui:
            clear_stale(a, args.iso)

    results["power_profile_end"] = subprocess.run(
        ["powerprofilesctl", "get"], capture_output=True, text=True).stdout.strip()
    with open(args.out, "w") as fh:
        json.dump(results, fh, indent=1)
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
