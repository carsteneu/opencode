#!/usr/bin/env python3
"""B1 premise measurement — headless (CLI) arm.

Client and server as two separate processes, so the per-process split is exact:

  v2 -> server `opencode serve --port P`  + client `opencode run --server URL`
  v1 -> server `opencode-v1 serve --port P` + client `opencode-v1 run --attach URL`
        (the server spawns `__opencode_ai_worker__` children, measured separately)

This is the secondary view; the TUI series (b1_paired_measure.py) is the primary
one because the premise's client numbers were TUI numbers.

Usage:
  python3 bench/b1_headless_measure.py --arm v2 --streams 6 --out .yesmem/tmp/b1-head-v2.json
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from b1_common import MODEL, PORTS, PROMPT, arm_env, bin_for, clear_stale, md5_of  # noqa: E402
from b1_proc import Sampler, integrate  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def start_server(arm, env, cwd, logpath, port):
    log = open(logpath, "wb")
    proc = subprocess.Popen([bin_for(arm), "serve", "--hostname", "127.0.0.1", "--port", str(port)],
                            env=env, cwd=cwd, stdout=log, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL)
    password, deadline = None, time.time() + 90
    while time.time() < deadline:
        if proc.poll() is not None:
            raise SystemExit(f"server exited early: {open(logpath, errors='replace').read()[:500]}")
        txt = open(logpath, errors="replace").read()
        if arm == "v2" and "server password " in txt:
            password = [l for l in txt.splitlines() if l.startswith("server password ")][-1].split(" ", 2)[2].strip()
            break
        if arm == "v1" and "listening on http" in txt:
            break
        time.sleep(0.2)
    else:
        raise SystemExit("server did not become ready in 90s")
    return proc, password


def client_cmd(arm, port, prompt):
    binary = bin_for(arm)
    if arm == "v2":
        return [binary, "run", "--server", f"http://127.0.0.1:{port}", "-m", MODEL, prompt]
    return [binary, "run", "--attach", f"http://127.0.0.1:{port}", "-m", MODEL, prompt]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True, choices=["v1", "v2"])
    ap.add_argument("--streams", type=int, default=6)
    ap.add_argument("--idle-window", type=float, default=20.0)
    ap.add_argument("--settle", type=float, default=12.0)
    ap.add_argument("--worker-retire-wait", type=float, default=35.0)
    ap.add_argument("--drain", type=float, default=0.6)
    ap.add_argument("--iso", default=os.path.join(HERE, "..", ".yesmem", "tmp", "iso"))
    ap.add_argument("--tmp", default=os.path.join(HERE, "..", ".yesmem", "tmp"))
    ap.add_argument("--cwd", default=os.path.join(HERE, "..", ".yesmem", "tmp", "benchdir"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--lines", type=int, default=None,
                    help="override the prompt size (counts 1..N) for a volume-scaling probe")
    args = ap.parse_args()

    prompt = PROMPT if args.lines is None else (
        f"Output the integers 1 to {args.lines}, one per line, no other text. "
        "As the very last line, output TALLY- immediately followed by the number "
        "of lines you printed."
    )
    cwd = os.path.abspath(args.cwd)
    port = PORTS[args.arm]
    env = arm_env(args.arm, args.iso)
    results = {"mode": "headless", "arm": args.arm, "model": MODEL, "prompt": prompt,
               "lines": args.lines, "port": port, "cwd": cwd, "host_nproc": os.cpu_count(),
               "started": time.time(), "binary": bin_for(args.arm),
               "binary_md5": md5_of(bin_for(args.arm)), "loadavg_at_start": os.getloadavg()}

    stale = clear_stale(args.arm, args.iso)
    if stale:
        results["stale_cleared"] = [{"pid": p, "cmd": c} for p, c in stale]
    server, password = start_server(args.arm, env, cwd, os.path.join(args.tmp, f"b1-head-{args.arm}.log"), port)
    results["server_pid"] = server.pid
    if password:
        env["OPENCODE_PASSWORD"] = password
    try:
        time.sleep(args.settle)
        sampler = Sampler(server.pid, root_role="server", interval=0.1)
        sampler.start()

        # Worker pools retire after 30 s idle; wait past that for a steady idle.
        time.sleep(args.worker_retire_wait)
        t0 = time.monotonic()
        time.sleep(args.idle_window)
        t1 = time.monotonic()
        roles = integrate(sampler.samples, t0, t1)
        results["idle"] = {"window_s": t1 - t0, "load": os.getloadavg()[0],
                           "per_role": {k: dict(v, cpu_pct=100.0 * v["cpu_s"] / (t1 - t0)) for k, v in roles.items()}}

        streams = []
        for i in range(args.streams):
            outpath = os.path.join(args.tmp, f"b1-head-{args.arm}-s{i}.out")
            sampler.samples.clear()
            t0 = time.monotonic()
            with open(outpath, "wb") as fh:
                client = subprocess.Popen(client_cmd(args.arm, port, prompt), env=env, cwd=cwd,
                                          stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
            sampler.extra_client_pids.add(client.pid)
            client.wait()
            sampler.extra_client_pids.discard(client.pid)
            time.sleep(args.drain)
            t1 = time.monotonic()
            roles = integrate(sampler.samples, t0, t1)
            roles = {k: dict(v, cpu_pct=100.0 * v["cpu_s"] / (t1 - t0)) for k, v in roles.items()}
            rec = {"i": i, "exit": client.returncode, "window_s": t1 - t0,
                   "out_bytes": os.path.getsize(outpath), "load": os.getloadavg()[0],
                   "per_role": roles}
            streams.append(rec)
            print(f"  stream {i}: exit={client.returncode} window={t1 - t0:.1f}s out={rec['out_bytes']}B "
                  f"roles={ {r: round(v['cpu_pct'], 2) for r, v in roles.items()} }", file=sys.stderr)
        results["streams"] = streams

        t0 = time.monotonic()
        time.sleep(args.idle_window)
        t1 = time.monotonic()
        roles = integrate(sampler.samples, t0, t1)
        results["idle_after"] = {"window_s": t1 - t0,
                                 "per_role": {k: dict(v, cpu_pct=100.0 * v["cpu_s"] / (t1 - t0)) for k, v in roles.items()}}
        sampler.stop_flag.set()
    finally:
        try:
            os.kill(server.pid, signal.SIGTERM)
        except OSError:
            pass
        time.sleep(1.5)
        if server.poll() is None:
            try:
                os.kill(server.pid, signal.SIGKILL)
            except OSError:
                pass
        clear_stale(args.arm, args.iso)

    with open(args.out, "w") as fh:
        json.dump(results, fh, indent=1)
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
