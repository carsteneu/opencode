#!/usr/bin/env python3
"""Shared /proc introspection for the B1 measurement harnesses.

CPU is read as cumulative utime+stime ticks from /proc/<pid>/stat and
integrated over windows by a sampler thread, so process creation, retirement
and reuse inside a window are attributed exactly.
"""

import os
import threading
import time

HZ = os.sysconf("SC_CLK_TCK")
PAGE = os.sysconf("SC_PAGE_SIZE")


def read_stat(pid):
    """Return (comm, ppid, ticks, rss_bytes) or None."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    close = raw.rindex(b")")
    comm = raw[raw.index(b"(") + 1 : close].decode("utf-8", "replace")
    after = raw[close + 2 :].split()
    ppid = int(after[1])
    ticks = int(after[11]) + int(after[12])  # utime + stime
    rss = int(after[21]) * PAGE  # rss field (24th overall, 21st after pid+comm)
    return comm, ppid, ticks, rss


def read_cmdline(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as fh:
            return fh.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
    except OSError:
        return ""


def read_pss(pid):
    try:
        with open(f"/proc/{pid}/smaps_rollup", "r") as fh:
            for line in fh:
                if line.startswith("Pss:"):
                    return int(line.split()[1]) * 1024
    except OSError:
        pass
    return None


def all_pids():
    return [int(n) for n in os.listdir("/proc") if n.isdigit()]


def find_by_environ(marker, cmdline_contains=None):
    """Processes whose environment contains `marker` (and whose cmdline matches).

    Kept for ad-hoc inspection; the harnesses identify their own processes with
    b1_common.our_processes, which compares normalised paths and the executable
    instead of a raw substring.
    """
    found = []
    for pid in all_pids():
        cmd = read_cmdline(pid)
        if cmdline_contains and cmdline_contains not in cmd:
            continue
        try:
            with open(f"/proc/{pid}/environ", "rb") as fh:
                env = fh.read().decode("utf-8", "replace")
        except OSError:
            continue
        if marker in env:
            found.append((pid, cmd))
    return found


def read_environ_value(pid, key):
    """Value of one environment variable of `pid`, or None."""
    try:
        with open(f"/proc/{pid}/environ", "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    prefix = key.encode() + b"="
    for entry in raw.split(b"\0"):
        if entry.startswith(prefix):
            return entry[len(prefix):].decode("utf-8", "replace")
    return None


def read_starttime(pid):
    """Process start time (field 22 of /proc/<pid>/stat) — a pid-reuse identity."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    after = raw[raw.rindex(b")") + 2:].split()
    return int(after[19])  # field 22 overall, 19th after pid+comm


def read_exe(pid):
    try:
        return os.readlink(f"/proc/{pid}/exe")
    except OSError:
        return None


class Sampler(threading.Thread):
    """Sample a process tree every `interval` seconds.

    Root pid -> role "client" (TUI) or "server" (headless), children classified
    by cmdline. Extra pids (e.g. a client launched separately) get role "client".
    """

    def __init__(self, root_pid, root_role="server", interval=0.1, pss_every=10):
        super().__init__(daemon=True)
        self.root_pid = root_pid
        self.root_role = root_role
        self.interval = interval
        self.pss_every = pss_every
        self.extra_client_pids = set()
        self.samples = []
        self.stop_flag = threading.Event()

    def _classify(self, pid, cmd):
        if "__opencode_ai_worker__" in cmd:
            return "worker"
        if " serve" in cmd or cmd.endswith("serve"):
            return "server"
        low = cmd.lower()
        if "/git " in low or low.endswith("git") or low.startswith("git "):
            return "git"
        return "other"

    def _roles(self):
        ppid_of = {}
        for pid in all_pids():
            st = read_stat(pid)
            if st:
                ppid_of[pid] = st[1]
        children = {}
        for pid, pp in ppid_of.items():
            children.setdefault(pp, []).append(pid)
        tree, stack = {self.root_pid}, [self.root_pid]
        while stack:
            for ch in children.get(stack.pop(), []):
                if ch not in tree:
                    tree.add(ch)
                    stack.append(ch)
        roles = {}
        for pid in tree:
            roles[pid] = self.root_role if pid == self.root_pid else self._classify(pid, read_cmdline(pid))
        for pid in list(self.extra_client_pids):
            if pid in ppid_of:
                roles[pid] = "client"
        return roles

    def run(self):
        n = 0
        while not self.stop_flag.is_set():
            t = time.monotonic()
            roles = self._roles()
            rec = {}
            want_pss = n % self.pss_every == 0
            for pid, role in roles.items():
                st = read_stat(pid)
                if not st:
                    continue
                _, _, ticks, rss = st
                rec[pid] = (role, ticks, rss, read_pss(pid) if want_pss else None)
            try:
                load = os.getloadavg()[0]
            except OSError:
                load = -1.0
            self.samples.append((t, rec, load))
            n += 1
            self.stop_flag.wait(self.interval)


def integrate(samples, t0, t1):
    """Per-role CPU seconds and peak RSS/PSS over [t0, t1].

    Samples outside the window only ever contribute as a delta baseline, never
    as CPU or as a peak: the sampler stamps `t` before enumerating the tree, so
    a sample taken just before t0 can still be appended after it.
    """
    cpu, peak_rss, peak_pss, last = {}, {}, {}, {}
    for t, rec, _load in samples:
        inside = t0 <= t <= t1
        for pid, (role, ticks, rss, pss) in rec.items():
            key = (role, pid)
            if key in last and inside:
                cpu[key] = cpu.get(key, 0.0) + max(0, ticks - last[key][0]) / HZ
            else:
                cpu.setdefault(key, 0.0)
            last[key] = (ticks, t)
            if inside:
                peak_rss[key] = max(peak_rss.get(key, 0), rss)
                if pss is not None:
                    peak_pss[key] = max(peak_pss.get(key, 0), pss)
    roles = {}
    for (role, pid), c in cpu.items():
        r = roles.setdefault(role, {"cpu_s": 0.0, "rss_peak": 0, "pss_peak": 0, "pids": []})
        r["cpu_s"] += c
        r["rss_peak"] = max(r["rss_peak"], peak_rss.get((role, pid), 0))
        r["pss_peak"] = max(r["pss_peak"], peak_pss.get((role, pid), 0))
        r["pids"].append(pid)
    return roles


def pct(roles, window_s):
    for r in roles.values():
        r["cpu_pct"] = 100.0 * r["cpu_s"] / window_s
    return roles
