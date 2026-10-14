#!/usr/bin/env python3
"""Shared setup for the B1 measurement harnesses: arm environments and binaries.

Both arms run in fully isolated XDG roots and from pinned binary copies, so the
live installation is never touched and the measured binaries cannot change
underneath a running series (the installed v2 binary was rebuilt mid-session).
"""

import hashlib
import os
import signal
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_V2 = os.path.expanduser("~/.opencode/bin/opencode")
DEFAULT_V1 = os.path.expanduser("~/.opencode/bin/opencode-v1-bin")
BIN_DIR = os.environ.get("B1_BIN_DIR") or os.path.join(HERE, "..", ".yesmem", "tmp", "bin")

MODEL = "gateway/gd-flash"
PORTS = {"v2": 45871, "v1": 45901}
LINES = 1500

# The marker is not reproducible from the echoed prompt: the prompt asks for
# "TALLY-" followed by the line count, so "TALLY-<digits>" only appears in the
# model's answer.
PROMPT = (
    f"Output the integers 1 to {LINES}, one per line, no other text. "
    "As the very last line, output TALLY- immediately followed by the number "
    "of lines you printed."
)


def bin_for(arm):
    """Pinned binary copy when present, else the installed binary."""
    pinned = os.path.join(BIN_DIR, "opencode-v2" if arm == "v2" else "opencode-v1")
    return pinned if os.path.exists(pinned) else (DEFAULT_V2 if arm == "v2" else DEFAULT_V1)


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def data_home(arm, iso):
    """The arm's XDG_DATA_HOME (normalised) — identifies its processes."""
    return os.path.join(os.path.realpath(iso), arm, "data")


def our_processes(arm, iso):
    """[(pid, starttime, cmdline)] of processes that are unmistakably this arm's.

    Matching a raw environment substring is spelling-sensitive — the path may be
    recorded as `.../bench/../.yesmem/tmp/iso` — and, worse, would signal any
    process that merely inherited the variable. So the candidate's own
    XDG_DATA_HOME is normalised before comparison and the executable must be the
    pinned binary of this arm.
    """
    from b1_proc import all_pids, read_cmdline, read_environ_value, read_exe, read_starttime

    wanted_home = data_home(arm, iso)
    wanted_exe = os.path.realpath(bin_for(arm))
    found = []
    for pid in all_pids():
        home = read_environ_value(pid, "XDG_DATA_HOME")
        if not home or os.path.realpath(home) != wanted_home:
            continue
        exe = read_exe(pid)
        if not exe or os.path.realpath(exe) != wanted_exe:
            continue
        starttime = read_starttime(pid)
        if starttime is None:
            continue
        found.append((pid, starttime, read_cmdline(pid)))
    return found


def clear_stale(arm, iso, wait=6.0):
    """Terminate leftover processes of this arm from an earlier run.

    The v1 shared server detaches (ppid 1) and outlives its TUI; a new TUI then
    attaches to it, which would leave the server outside the TUI's process tree.
    Each kill re-checks the recorded start time first, so a recycled pid is
    never signalled.
    """
    from b1_proc import read_starttime

    targets = our_processes(arm, iso)
    for pid, starttime, _cmd in targets:
        if read_starttime(pid) != starttime:
            continue  # pid was recycled between scan and kill
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if not our_processes(arm, iso):
            break
        time.sleep(0.5)
    for pid, starttime, _cmd in our_processes(arm, iso):
        if read_starttime(pid) != starttime:
            continue
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    time.sleep(0.5)
    return [{"pid": p, "cmd": c} for p, _s, c in targets]


def find_servers(arm, iso):
    """[(pid, starttime, cmdline)] of this arm's servers, newest first.

    Detached servers are found because identification does not rely on the
    process tree.
    """
    servers = [t for t in our_processes(arm, iso) if " serve" in t[2] or t[2].endswith("serve")]
    return sorted(servers, key=lambda t: t[1], reverse=True)


def arm_env(arm, iso):
    """Isolated environment for one arm. `iso` is the isolation root."""
    iso = os.path.realpath(iso)
    root = os.path.join(iso, arm)
    env = dict(os.environ)
    env["OPENCODE_DISABLE_AUTOUPDATE"] = "1"
    # v2 derives its sqlite file name from a per-build "channel"; pinning it off
    # gives both arms the same opencode.db, so credentials live in one place.
    env["OPENCODE_DISABLE_CHANNEL_DB"] = "1"
    env["XDG_CACHE_HOME"] = os.path.join(root, "cache")
    env["XDG_DATA_HOME"] = os.path.join(root, "data")
    env["XDG_STATE_HOME"] = os.path.join(root, "state")
    env["XDG_CONFIG_HOME"] = os.path.join(root, "config")
    if arm == "v1":
        # v1 merges the global config dir; pin both roots so the live
        # ~/.config/opencode never leaks into the measurement.
        env["OPENCODE_CONFIG_DIR"] = os.path.join(root, "config", "opencode")
    else:
        env.pop("OPENCODE_CONFIG_DIR", None)
    os.makedirs(env["XDG_CACHE_HOME"], exist_ok=True)
    return env
