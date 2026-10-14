#!/usr/bin/env python3
"""B1 premise measurement — TUI arm.

Drives a real opencode TUI headlessly through a PTY (fixed window size) and
measures CPU/RAM per process role over the idle and streaming windows.

  v2 -> `opencode --standalone`   : TUI process + private server child
  v1 -> `opencode-v1-bin`         : TUI process + `serve --shared` child
                                     + `__opencode_ai_worker__` grandchildren

Completion of a stream is detected with a transformation marker the model has
to compute ("TALLY-" followed by the line count), so the marker cannot match
the echoed prompt text.

Usage:
  python3 bench/b1_tui_measure.py --arm v2 --streams 5 --out .yesmem/tmp/b1-tui-v2.json
"""

import argparse
import fcntl
import json
import os
import pty
import re
import signal
import struct
import subprocess
import sys
import termios
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from b1_common import LINES, MODEL, PROMPT, arm_env, bin_for, clear_stale, find_servers, md5_of  # noqa: E402
from b1_proc import Sampler, integrate  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][A-Z0-9]|\x1b[=>]|\x1b\][^\x07]*\x07")


def clean(data):
    return ANSI_RE.sub("", data)


def arm_cmd(arm):
    binary = bin_for(arm)
    return [binary, "--standalone"] if arm == "v2" else [binary]


class Tui:
    def __init__(self, arm, env, cwd, rows, cols, logpath):
        self.arm = arm
        self.rows, self.cols = rows, cols
        self.logpath = logpath
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.raw = bytearray()
        self.lock = threading.Lock()
        self.log = open(logpath, "wb")
        self.master = master
        self.proc = subprocess.Popen(
            arm_cmd(arm), stdin=slave, stdout=slave, stderr=slave, env=env, cwd=cwd,
            preexec_fn=os.setsid, close_fds=True,
        )
        os.close(slave)
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            try:
                data = os.read(self.master, 65536)
            except OSError:
                return
            if not data:
                return
            with self.lock:
                self.raw.extend(data)
            self.log.write(data)
            self.log.flush()

    def text(self):
        with self.lock:
            return clean(self.raw.decode("utf-8", "replace"))

    def nbytes(self):
        with self.lock:
            return len(self.raw)

    def wait_ready(self, min_settle, timeout):
        t0 = time.monotonic()
        time.sleep(min_settle)
        last, stable = -1, 0
        while time.monotonic() - t0 < timeout:
            n = self.nbytes()
            stable = stable + 1 if n == last else 0
            last = n
            if stable >= 2 and "Ask anything" in self.text():
                return True
            time.sleep(1.0)
        return False

    def send(self, prompt):
        os.write(self.master, prompt.encode())
        time.sleep(0.3)
        os.write(self.master, b"\r")

    def wait_quiet(self, quiet, timeout, offset=0, start_threshold=0):
        """Wait until terminal output stops growing for `quiet` seconds.

        The TUI repaints whole frames, so a text marker cannot distinguish the
        current answer from a previous one. Idle output is measurably zero, so
        quiescence after a burst is the reliable end-of-stream signal.
        """
        t0 = time.monotonic()
        started = start_threshold == 0
        while time.monotonic() - t0 < timeout:
            if not started and self.nbytes() > offset + start_threshold:
                started = True
            if started:
                break
            time.sleep(0.2)
        if not started:
            return None
        last = self.nbytes()
        last_change = time.monotonic()
        while time.monotonic() - t0 < timeout:
            time.sleep(0.25)
            n = self.nbytes()
            if n != last:
                last, last_change = n, time.monotonic()
            elif time.monotonic() - last_change >= quiet:
                return time.monotonic() - t0
        return None

    def close(self):
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except OSError:
            pass
        time.sleep(1.5)
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
        except OSError:
            pass


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True, choices=["v1", "v2"])
    ap.add_argument("--streams", type=int, default=5)
    ap.add_argument("--idle-window", type=float, default=20.0)
    ap.add_argument("--settle", type=float, default=15.0)
    ap.add_argument("--ready-timeout", type=float, default=90.0)
    ap.add_argument("--stream-timeout", type=float, default=180.0)
    ap.add_argument("--drain", type=float, default=1.0)
    ap.add_argument("--rows", type=int, default=50)
    ap.add_argument("--cols", type=int, default=200)
    ap.add_argument("--iso", default=os.path.join(here, "..", ".yesmem", "tmp", "iso"))
    ap.add_argument("--tmp", default=os.path.join(here, "..", ".yesmem", "tmp"))
    ap.add_argument("--cwd", default=os.path.join(here, "..", ".yesmem", "tmp", "benchdir"))
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if not os.path.isdir(args.cwd):
        raise SystemExit(f"cwd does not exist: {args.cwd}")

    results = {"mode": "tui", "arm": args.arm, "model": MODEL, "prompt": PROMPT, "lines": LINES,
               "rows": args.rows, "cols": args.cols, "streams_planned": args.streams,
               "host_nproc": os.cpu_count(), "started": time.time(),
               "binary": bin_for(args.arm), "binary_md5": md5_of(bin_for(args.arm))}

    clear_stale(args.arm, args.iso)
    tui = Tui(args.arm, arm_env(args.arm, args.iso),
              os.path.abspath(args.cwd), args.rows, args.cols,
              os.path.join(args.tmp, f"b1-tui-{args.arm}.raw"))
    try:
        ready = tui.wait_ready(args.settle, args.ready_timeout)
        results["ready"] = ready
        if not ready:
            raise SystemExit("TUI did not become ready")
        results["tui_pid"] = tui.proc.pid
        children = subprocess.run(["pgrep", "-P", str(tui.proc.pid)],
                                  capture_output=True, text=True).stdout.split()
        results["children_at_start"] = [
            {"pid": int(c), "cmd": open(f"/proc/{c}/cmdline", "rb").read().replace(b"\0", b" ").decode("utf-8", "replace").strip()}
            for c in children
        ]

        # Root the sampler at the server: the v1 shared server detaches, so the
        # TUI is not necessarily its parent.
        servers = find_servers(args.arm, args.iso)
        root_pid, root_role = (servers[0][0], "server") if servers else (tui.proc.pid, "client")
        if len(servers) > 1:
            raise SystemExit(f"{len(servers)} servers found, expected exactly one: {servers}")
        results["servers"] = [{"pid": p, "starttime": st, "cmd": c} for p, st, c in servers]
        sampler = Sampler(root_pid, root_role=root_role, interval=0.1)
        sampler.extra_client_pids.add(tui.proc.pid)
        sampler.start()

        sampler.samples.clear()
        t0 = time.monotonic()
        time.sleep(args.idle_window)
        t1 = time.monotonic()
        roles = integrate(sampler.samples, t0, t1)
        results["idle"] = {"window_s": t1 - t0, "load": os.getloadavg()[0],
                           "per_role": {k: dict(v, cpu_pct=100.0 * v["cpu_s"] / (t1 - t0)) for k, v in roles.items()}}

        streams = []
        for i in range(args.streams):
            # let the previous stream's post-processing settle before the baseline
            tui.wait_quiet(2.0, 60.0)
            sampler.samples.clear()
            with tui.lock:
                offset = len(tui.raw)
            t0 = time.monotonic()
            tui.send(PROMPT)
            dt = tui.wait_quiet(3.0, args.stream_timeout, offset=offset, start_threshold=200)
            time.sleep(args.drain)
            t1 = time.monotonic()
            roles = integrate(sampler.samples, t0, t1)
            roles = {k: dict(v, cpu_pct=100.0 * v["cpu_s"] / (t1 - t0)) for k, v in roles.items()}
            with tui.lock:
                term_bytes = len(tui.raw) - offset
            rec = {"i": i, "stream_s": dt, "window_s": t1 - t0,
                   "terminal_bytes": term_bytes, "load": os.getloadavg()[0],
                   "per_role": roles}
            streams.append(rec)
            print(f"  stream {i}: stream={dt} window={t1 - t0:.1f}s term={term_bytes}B "
                  f"roles={ {r: round(v['cpu_pct'], 2) for r, v in roles.items()} }", file=sys.stderr)
            if dt is None:
                print(f"  stream {i}: NO DONE MARKER — aborting", file=sys.stderr)
                break
        results["streams"] = streams

        t0 = time.monotonic()
        time.sleep(args.idle_window)
        t1 = time.monotonic()
        roles = integrate(sampler.samples, t0, t1)
        results["idle_after"] = {"window_s": t1 - t0,
                                 "per_role": {k: dict(v, cpu_pct=100.0 * v["cpu_s"] / (t1 - t0)) for k, v in roles.items()}}
        sampler.stop_flag.set()
    finally:
        tui.close()
        time.sleep(0.5)
        # The v1 shared server detaches and outlives its TUI; clean up our own.
        clear_stale(args.arm, args.iso)

    with open(args.out, "w") as fh:
        json.dump(results, fh, indent=1)
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
