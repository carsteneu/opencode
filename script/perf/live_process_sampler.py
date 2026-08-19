#!/usr/bin/env python3
"""Multi-root /proc sampler for live OpenCode measurements (runbook B01/B03 style).

Usage: live_process_sampler.py ROOT_PIDS DURATION_SECONDS OUTPUT_DIR

Tracks the full process trees of one or more OpenCode client roots at 1 s
intervals: per-process CPU ticks, RSS/PSS, context switches, I/O counters,
host CPU, loadavg, and the power profile in every bin. Roots are identity-
guarded via starttime_ticks so a reused PID can never contaminate a series.
Writes OUTPUT_DIR/meta.json (before) + samples.jsonl, then finalizes meta.

Output dirs are throwaway raw data: keep them in /tmp, only summaries belong
in yesdocs/. See script/perf/README.md.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time


ROOT_PIDS = [int(value) for value in sys.argv[1].split(",")]
DURATION = int(sys.argv[2])
OUTPUT = pathlib.Path(sys.argv[3])
OUTPUT.mkdir(parents=True, exist_ok=False)
CLK_TCK = os.sysconf("SC_CLK_TCK")
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")


def read_text(path):
    try:
        return pathlib.Path(path).read_text(errors="replace")
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        return None


def read_stat(pid):
    value = read_text(f"/proc/{pid}/stat")
    if not value:
        return None
    end = value.rfind(")")
    if end < 0:
        return None
    fields = value[end + 2 :].split()
    if len(fields) < 22:
        return None
    return {
        "pid": pid,
        "comm": value[value.find("(") + 1 : end],
        "state": fields[0],
        "ppid": int(fields[1]),
        "utime_ticks": int(fields[11]),
        "stime_ticks": int(fields[12]),
        "threads": int(fields[17]),
        "starttime_ticks": int(fields[19]),
        "vsize_bytes": int(fields[20]),
        "rss_bytes": int(fields[21]) * PAGE_SIZE,
    }


def process_snapshot(pid, stat, roots):
    cmdline_raw = None
    try:
        cmdline_raw = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes()
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        pass
    cmdline = cmdline_raw.replace(b"\0", b" ").decode(errors="replace").strip() if cmdline_raw else stat["comm"]
    try:
        exe = os.readlink(f"/proc/{pid}/exe")
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        exe = None
    try:
        cwd = os.readlink(f"/proc/{pid}/cwd")
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        cwd = None

    status = read_text(f"/proc/{pid}/status") or ""
    status_values = {}
    for line in status.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        status_values[key] = value.strip()

    io_text = read_text(f"/proc/{pid}/io") or ""
    io_values = {}
    for line in io_text.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        try:
            io_values[key] = int(value.strip())
        except ValueError:
            pass

    smaps = read_text(f"/proc/{pid}/smaps_rollup") or ""
    pss_bytes = None
    for line in smaps.splitlines():
        if not line.startswith("Pss:"):
            continue
        try:
            pss_bytes = int(line.split()[1]) * 1024
        except (IndexError, ValueError):
            pass
        break

    identity_check = read_stat(pid)
    if not identity_check or identity_check["starttime_ticks"] != stat["starttime_ticks"]:
        return None

    if pid in roots:
        role = "client"
    elif "__opencode_tui_server__" in cmdline:
        role = "server"
    elif "__opencode_ai_worker__" in cmdline:
        role = "ai"
    elif stat["comm"] == "yesmem" or "/yesmem" in cmdline or cmdline.startswith("yesmem "):
        role = "yesmem"
    else:
        role = "tool"

    stat.update(
        {
            "identity": f'{pid}:{stat["starttime_ticks"]}',
            "role": role,
            "cmdline": cmdline,
            "exe": exe,
            "cwd": cwd,
            "pss_bytes": pss_bytes,
            "voluntary_ctx": int(status_values.get("voluntary_ctxt_switches", "0")),
            "nonvoluntary_ctx": int(status_values.get("nonvoluntary_ctxt_switches", "0")),
            "io": io_values,
        }
    )
    return stat


def all_stats():
    result = {}
    for item in pathlib.Path("/proc").iterdir():
        if not item.name.isdigit():
            continue
        stat = read_stat(int(item.name))
        if stat:
            result[stat["pid"]] = stat
    return result


def descendants(root, stats):
    children = {}
    for stat in stats.values():
        children.setdefault(stat["ppid"], []).append(stat["pid"])
    found = []
    pending = [root]
    while pending:
        pid = pending.pop()
        if pid in found or pid not in stats:
            continue
        found.append(pid)
        pending.extend(children.get(pid, []))
    return sorted(found)


def host_cpu():
    line = (read_text("/proc/stat") or "").splitlines()[0].split()
    values = [int(value) for value in line[1:]]
    return {
        "values": values,
        "total_ticks": sum(values),
        "idle_ticks": sum(values[3:5]),
    }


def power_profile():
    try:
        return subprocess.run(
            ["powerprofilesctl", "get"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        ).stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None


def root_meta(pid):
    stat = read_stat(pid)
    if not stat:
        raise RuntimeError(f"root {pid} is not alive")
    try:
        exe = os.readlink(f"/proc/{pid}/exe")
        exe_stat = os.stat(f"/proc/{pid}/exe")
    except OSError as error:
        raise RuntimeError(f"cannot identify root {pid}: {error}")
    cmdline = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
    return {
        "pid": pid,
        "starttime_ticks": stat["starttime_ticks"],
        "identity": f'{pid}:{stat["starttime_ticks"]}',
        "exe": exe,
        "exe_inode": exe_stat.st_ino,
        "exe_size": exe_stat.st_size,
        "cmdline": cmdline,
    }


root_metadata = [root_meta(pid) for pid in ROOT_PIDS]
binary = root_metadata[0]["exe"]
binary_hash = None
if binary and all(item["exe"] == binary for item in root_metadata):
    digest = hashlib.sha256()
    with open(binary, "rb") as handle:
        while chunk := handle.read(4 * 1024 * 1024):
            digest.update(chunk)
    binary_hash = digest.hexdigest()

metadata = {
    "format": 1,
    "started_wall_ns": time.time_ns(),
    "duration_seconds": DURATION,
    "interval_seconds": 1,
    "clk_tck": CLK_TCK,
    "page_size": PAGE_SIZE,
    "cpu_count": os.cpu_count(),
    "roots": root_metadata,
    "binary_sha256": binary_hash,
    "power_profile_before": power_profile(),
}
(OUTPUT / "meta.json").write_text(json.dumps(metadata, indent=2) + "\n")
print(f"START output={OUTPUT} profile={metadata['power_profile_before']} roots={ROOT_PIDS}", flush=True)

# Separate executable hashing and sampler onset so it cannot contaminate the first interval.
time.sleep(2)
raw = (OUTPUT / "samples.jsonl").open("w")
start = time.monotonic()
for sequence in range(DURATION + 1):
    deadline = start + sequence
    delay = deadline - time.monotonic()
    if delay > 0:
        time.sleep(delay)
    stats = all_stats()
    trees = {}
    for root in ROOT_PIDS:
        processes = []
        for pid in descendants(root, stats):
            snapshot = process_snapshot(pid, stats[pid], ROOT_PIDS)
            if snapshot:
                processes.append(snapshot)
        trees[str(root)] = processes
    loadavg = (read_text("/proc/loadavg") or "").strip()
    sample = {
        "sequence": sequence,
        "wall_ns": time.time_ns(),
        "monotonic_ns": time.monotonic_ns(),
        "power_profile": power_profile(),
        "host_cpu": host_cpu(),
        "loadavg": loadavg,
        "trees": trees,
    }
    raw.write(json.dumps(sample, separators=(",", ":")) + "\n")
    raw.flush()
    if sequence and sequence % 10 == 0:
        counts = {root: len(items) for root, items in trees.items()}
        print(f"PROGRESS second={sequence} counts={counts}", flush=True)
raw.close()
metadata["finished_wall_ns"] = time.time_ns()
metadata["power_profile_after"] = power_profile()
(OUTPUT / "meta.json").write_text(json.dumps(metadata, indent=2) + "\n")
print(f"DONE profile={metadata['power_profile_after']}", flush=True)
