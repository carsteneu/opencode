#!/usr/bin/env python3
"""Single-root OpenCode /proc benchmark with phase segments and DB correlation.

Usage: bench_proc.py --root PID --session SESSION_ID [--duration 60] [--interval 1.0]
                     [--db ~/.local/share/opencode/opencode.db]

Passive /proc snapshots (no signals, no ptrace, no perf attach): per-bin role
CPU %, RSS/PSS, context switches, I/O; segments phases by worker presence;
correlates with the session DB (messages/parts in window) and log file stats;
verifies power profile before/after/every bin. Writes summary.json,
snapshots.jsonl, bins.jsonl, power.jsonl, workload.json, metadata.json into
a fresh /tmp result root (printed as RESULT_ROOT). See script/perf/README.md.
"""

import argparse
import datetime
import json
import math
import os
import pathlib
import sqlite3
import statistics
import subprocess
import time


def read_text(path):
    try:
        return pathlib.Path(path).read_text(errors="replace")
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        return None


def parse_stat(pid):
    text = read_text(f"/proc/{pid}/stat")
    if text is None:
        return None
    close = text.rfind(")")
    if close < 0:
        return None
    fields = text[close + 2 :].split()
    if len(fields) < 22:
        return None
    return {
        "pid": pid,
        "comm": text[text.find("(") + 1 : close],
        "state": fields[0],
        "ppid": int(fields[1]),
        "pgrp": int(fields[2]),
        "session": int(fields[3]),
        "utime_ticks": int(fields[11]),
        "stime_ticks": int(fields[12]),
        "cutime_ticks": int(fields[13]),
        "cstime_ticks": int(fields[14]),
        "threads": int(fields[17]),
        "starttime_ticks": int(fields[19]),
        "vsize_bytes": int(fields[20]),
        "rss_bytes": int(fields[21]) * os.sysconf("SC_PAGE_SIZE"),
    }


def read_children(pid):
    text = read_text(f"/proc/{pid}/task/{pid}/children")
    if not text:
        return []
    return [int(value) for value in text.split() if value.isdigit()]


def parse_key_values(path, wanted):
    text = read_text(path)
    if text is None:
        return {}
    result = {}
    for line in text.splitlines():
        key, separator, value = line.partition(":")
        if not separator or key not in wanted:
            continue
        token = value.strip().split()[0]
        try:
            result[key] = int(token)
        except ValueError:
            continue
    return result


def read_cmdline(pid):
    try:
        data = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes()
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        return []
    return [part.decode(errors="replace") for part in data.split(b"\0") if part]


def classify(pid, root, cmdline, comm):
    if pid == root:
        return "client"
    joined = "\0".join(cmdline)
    if "__opencode_tui_server__" in joined:
        return "server"
    if "__opencode_ai_worker__" in joined:
        return "worker"
    return f"descendant:{comm}"


def read_process(pid, root):
    stat = parse_stat(pid)
    if stat is None:
        return None
    cmdline = read_cmdline(pid)
    status = parse_key_values(
        f"/proc/{pid}/status",
        {
            "VmRSS",
            "VmHWM",
            "voluntary_ctxt_switches",
            "nonvoluntary_ctxt_switches",
        },
    )
    smaps = parse_key_values(
        f"/proc/{pid}/smaps_rollup",
        {"Pss", "Pss_Anon", "Pss_File", "Pss_Shmem", "Private_Clean", "Private_Dirty"},
    )
    io = parse_key_values(
        f"/proc/{pid}/io",
        {"rchar", "wchar", "syscr", "syscw", "read_bytes", "write_bytes", "cancelled_write_bytes"},
    )
    try:
        exe_target = os.readlink(f"/proc/{pid}/exe")
        exe_stat = os.stat(f"/proc/{pid}/exe")
        exe = {
            "target": exe_target,
            "device": exe_stat.st_dev,
            "inode": exe_stat.st_ino,
            "size": exe_stat.st_size,
        }
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        exe = None
    stat.update(
        {
            "identity": f"{pid}:{stat['starttime_ticks']}",
            "role": classify(pid, root, cmdline, stat["comm"]),
            "cmdline": cmdline,
            "status": status,
            "pss": smaps,
            "io": io,
            "exe": exe,
        }
    )
    return stat


def read_tree(root, expected_starttime):
    root_stat = parse_stat(root)
    if root_stat is None:
        raise RuntimeError(f"root PID {root} disappeared")
    if root_stat["starttime_ticks"] != expected_starttime:
        raise RuntimeError(
            f"root PID {root} was reused: expected {expected_starttime}, got {root_stat['starttime_ticks']}"
        )
    queue = [root]
    seen = set()
    processes = []
    races = []
    while queue:
        pid = queue.pop(0)
        if pid in seen:
            continue
        seen.add(pid)
        children = read_children(pid)
        process = read_process(pid, root)
        if process is None:
            races.append({"pid": pid, "event": "vanished_during_snapshot"})
            continue
        processes.append(process)
        queue.extend(children)
    return processes, races


def read_host_cpu():
    text = read_text("/proc/stat")
    if text is None:
        return None
    fields = text.splitlines()[0].split()
    values = [int(value) for value in fields[1:]]
    return {
        "fields": values,
        "total_ticks": sum(values),
        "idle_ticks": (values[3] if len(values) > 3 else 0) + (values[4] if len(values) > 4 else 0),
    }


def read_load():
    text = read_text("/proc/loadavg")
    if text is None:
        return None
    fields = text.split()
    return {
        "load_1": float(fields[0]),
        "load_5": float(fields[1]),
        "load_15": float(fields[2]),
        "runnable_total": fields[3],
    }


def stat_file(path):
    try:
        value = os.stat(path)
    except (FileNotFoundError, PermissionError, OSError):
        return None
    return {"size": value.st_size, "mtime_ns": value.st_mtime_ns, "inode": value.st_ino, "device": value.st_dev}


def snapshot(root, expected_starttime, db_path, log_path, index, planned_mono_ns):
    started = time.monotonic_ns()
    processes, races = read_tree(root, expected_starttime)
    ended = time.monotonic_ns()
    return {
        "index": index,
        "wall_epoch_ms": int(time.time() * 1000),
        "mono_ns": (started + ended) // 2,
        "planned_mono_ns": planned_mono_ns,
        "schedule_lag_ms": (started - planned_mono_ns) / 1_000_000,
        "collection_ms": (ended - started) / 1_000_000,
        "processes": processes,
        "snapshot_races": races,
        "host_cpu": read_host_cpu(),
        "load": read_load(),
        "db_stat": stat_file(db_path),
        "log_stat": stat_file(log_path),
    }


def power_profile(label, index):
    started_mono_ns = time.monotonic_ns()
    started_wall_ms = int(time.time() * 1000)
    result = subprocess.run(["powerprofilesctl", "get"], capture_output=True, text=True, check=False)
    ended_mono_ns = time.monotonic_ns()
    sysfs = read_text("/sys/firmware/acpi/platform_profile")
    return {
        "label": label,
        "index": index,
        "wall_epoch_ms": started_wall_ms,
        "mono_ns": started_mono_ns,
        "duration_ms": (ended_mono_ns - started_mono_ns) / 1_000_000,
        "profile": result.stdout.strip(),
        "returncode": result.returncode,
        "stderr": result.stderr.strip(),
        "sysfs_platform_profile": sysfs.strip() if sysfs else None,
    }


def process_map(snapshot_value):
    return {process["identity"]: process for process in snapshot_value["processes"]}


def delta_counter(before, after, key):
    if before is None:
        return after.get(key)
    if key not in before or key not in after:
        return None
    return max(0, after[key] - before[key])


def build_bin(before_snapshot, after_snapshot, hz):
    before = process_map(before_snapshot)
    after = process_map(after_snapshot)
    before_ids = set(before)
    after_ids = set(after)
    added = sorted(after_ids - before_ids)
    removed = sorted(before_ids - after_ids)
    duration_seconds = (after_snapshot["mono_ns"] - before_snapshot["mono_ns"]) / 1_000_000_000
    by_role = {}
    for identity, process in after.items():
        old = before.get(identity)
        cpu_ticks = delta_counter(
            {"cpu": old["utime_ticks"] + old["stime_ticks"]} if old else None,
            {"cpu": process["utime_ticks"] + process["stime_ticks"]},
            "cpu",
        )
        values = by_role.setdefault(
            process["role"],
            {
                "identities": [],
                "cpu_ticks": 0,
                "rss_bytes": 0,
                "pss_kib": 0,
                "voluntary_ctxt_switches": 0,
                "nonvoluntary_ctxt_switches": 0,
                "io": {key: 0 for key in process["io"]},
                "counter_gaps": [],
            },
        )
        values["identities"].append(identity)
        if cpu_ticks is None:
            values["counter_gaps"].append({"identity": identity, "counter": "cpu"})
        else:
            values["cpu_ticks"] += cpu_ticks
        values["rss_bytes"] += process["rss_bytes"]
        if "Pss" in process["pss"]:
            values["pss_kib"] += process["pss"]["Pss"]
        old_status = old["status"] if old else None
        for key in ("voluntary_ctxt_switches", "nonvoluntary_ctxt_switches"):
            value = delta_counter(old_status, process["status"], key)
            if value is None:
                values["counter_gaps"].append({"identity": identity, "counter": key})
            else:
                values[key] += value
        old_io = old["io"] if old else None
        for key in values["io"]:
            value = delta_counter(old_io, process["io"], key)
            if value is None:
                values["counter_gaps"].append({"identity": identity, "counter": f"io.{key}"})
            else:
                values["io"][key] += value
        values["cpu_pct_one_core"] = values["cpu_ticks"] / hz / duration_seconds * 100
    host_before = before_snapshot["host_cpu"]
    host_after = after_snapshot["host_cpu"]
    host_total = host_after["total_ticks"] - host_before["total_ticks"]
    host_idle = host_after["idle_ticks"] - host_before["idle_ticks"]
    host_busy_pct = ((host_total - host_idle) / host_total * 100) if host_total > 0 else None
    worker_identities = sorted(
        process["identity"] for process in after_snapshot["processes"] if process["role"] == "worker"
    )
    descendant_identities = sorted(
        process["identity"]
        for process in after_snapshot["processes"]
        if process["role"].startswith("descendant:")
    )
    return {
        "index": after_snapshot["index"],
        "start_wall_epoch_ms": before_snapshot["wall_epoch_ms"],
        "end_wall_epoch_ms": after_snapshot["wall_epoch_ms"],
        "duration_seconds": duration_seconds,
        "roles": by_role,
        "added_identities": added,
        "removed_identities": removed,
        "tree_changed": bool(added or removed),
        "worker_identities": worker_identities,
        "descendant_identities": descendant_identities,
        "phase_key": "worker:" + ",".join(worker_identities) if worker_identities else "no-worker",
        "host_busy_pct_all_cpus": host_busy_pct,
        "host_busy_core_equivalent": host_busy_pct * (os.cpu_count() or 1) / 100 if host_busy_pct is not None else None,
        "load": after_snapshot["load"],
        "collection_ms": after_snapshot["collection_ms"],
        "schedule_lag_ms": after_snapshot["schedule_lag_ms"],
    }


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def stats(values):
    if not values:
        return None
    return {
        "count": len(values),
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
        "p95_nearest_rank": percentile(values, 0.95),
        "max": max(values),
        "min": min(values),
    }


def summarize_bins(bins):
    roles = sorted({role for value in bins for role in value["roles"]})
    role_summary = {}
    for role in roles:
        matching = [value["roles"][role] for value in bins if role in value["roles"]]
        role_summary[role] = {
            "bins_present": len(matching),
            "cpu_pct_one_core": stats([value["cpu_pct_one_core"] for value in matching]),
            "rss_mib": stats([value["rss_bytes"] / 1024 / 1024 for value in matching]),
            "pss_mib": stats([value["pss_kib"] / 1024 for value in matching if value["pss_kib"]]),
            "voluntary_context_switches_per_bin": stats(
                [value["voluntary_ctxt_switches"] for value in matching]
            ),
            "nonvoluntary_context_switches_per_bin": stats(
                [value["nonvoluntary_ctxt_switches"] for value in matching]
            ),
            "io_totals": {
                key: sum(value["io"].get(key, 0) for value in matching)
                for key in sorted({key for value in matching for key in value["io"]})
            },
            "counter_gap_count": sum(len(value["counter_gaps"]) for value in matching),
        }
    product_cpu = [sum(role["cpu_pct_one_core"] for role in value["roles"].values()) for value in bins]
    segments = []
    for value in bins:
        if not segments or segments[-1]["phase_key"] != value["phase_key"]:
            segments.append(
                {
                    "phase_key": value["phase_key"],
                    "first_bin": value["index"],
                    "last_bin": value["index"],
                    "bins": [],
                }
            )
        segments[-1]["last_bin"] = value["index"]
        segments[-1]["bins"].append(value)
    for segment in segments:
        values = segment.pop("bins")
        segment["bin_count"] = len(values)
        segment["tree_change_bins"] = [value["index"] for value in values if value["tree_changed"]]
        segment["product_cpu_pct_one_core"] = stats(
            [sum(role["cpu_pct_one_core"] for role in value["roles"].values()) for value in values]
        )
        segment["host_busy_pct_all_cpus"] = stats(
            [value["host_busy_pct_all_cpus"] for value in values if value["host_busy_pct_all_cpus"] is not None]
        )
        segment["roles"] = summarize_bins(values)["roles"] if len(values) != len(bins) else role_summary
    return {
        "bin_count": len(bins),
        "tree_change_bins": [value["index"] for value in bins if value["tree_changed"]],
        "phase_count": len(segments),
        "segments": segments,
        "product_cpu_pct_one_core": stats(product_cpu),
        "host_busy_pct_all_cpus": stats(
            [value["host_busy_pct_all_cpus"] for value in bins if value["host_busy_pct_all_cpus"] is not None]
        ),
        "host_busy_core_equivalent": stats(
            [value["host_busy_core_equivalent"] for value in bins if value["host_busy_core_equivalent"] is not None]
        ),
        "load_1": stats([value["load"]["load_1"] for value in bins if value["load"]]),
        "collection_ms": stats([value["collection_ms"] for value in bins]),
        "schedule_lag_ms": stats([value["schedule_lag_ms"] for value in bins]),
        "roles": role_summary,
    }


def db_snapshot(db_path, session_id):
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    session = connection.execute(
        "SELECT id,title,version,time_created,time_updated,cost,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write FROM session WHERE id=?",
        (session_id,),
    ).fetchone()
    latest = connection.execute(
        "SELECT id,time_created,time_updated,data FROM message WHERE session_id=? ORDER BY time_created DESC LIMIT 1",
        (session_id,),
    ).fetchone()
    connection.close()
    result = {"wall_epoch_ms": int(time.time() * 1000), "session": session}
    if latest:
        try:
            data = json.loads(latest[3])
        except json.JSONDecodeError:
            data = {}
        result["latest_message"] = {
            "id": latest[0],
            "time_created": latest[1],
            "time_updated": latest[2],
            "role": data.get("role"),
            "created": data.get("time", {}).get("created"),
            "completed": data.get("time", {}).get("completed"),
            "finish": data.get("finish"),
            "error": data.get("error"),
        }
    return result


def db_window(db_path, session_id, start_ms, end_ms):
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    rows = connection.execute(
        "SELECT id,time_created,time_updated,data FROM message WHERE session_id=? AND (time_created BETWEEN ? AND ? OR time_updated BETWEEN ? AND ?) ORDER BY time_created,id",
        (session_id, start_ms - 5000, end_ms + 5000, start_ms - 5000, end_ms + 5000),
    ).fetchall()
    part_rows = connection.execute(
        "SELECT id,message_id,time_created,time_updated,data FROM part WHERE session_id=? AND (time_created BETWEEN ? AND ? OR time_updated BETWEEN ? AND ?) ORDER BY time_created,id",
        (session_id, start_ms - 5000, end_ms + 5000, start_ms - 5000, end_ms + 5000),
    ).fetchall()
    connection.close()
    messages = []
    for row in rows:
        try:
            data = json.loads(row[3])
        except json.JSONDecodeError:
            data = {}
        messages.append(
            {
                "id": row[0],
                "time_created": row[1],
                "time_updated": row[2],
                "role": data.get("role"),
                "created": data.get("time", {}).get("created"),
                "completed": data.get("time", {}).get("completed"),
                "finish": data.get("finish"),
                "error": data.get("error"),
                "model_id": data.get("modelID"),
                "provider_id": data.get("providerID"),
            }
        )
    parts = []
    for row in part_rows:
        try:
            data = json.loads(row[4])
        except json.JSONDecodeError:
            data = {}
        parts.append(
            {
                "id": row[0],
                "message_id": row[1],
                "time_created": row[2],
                "time_updated": row[3],
                "type": data.get("type"),
                "call_id": data.get("callID"),
                "tool": data.get("tool"),
                "state_status": data.get("state", {}).get("status") if isinstance(data.get("state"), dict) else None,
            }
        )
    return {"messages": messages, "parts": parts}


def write_json(path, value):
    pathlib.Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def write_jsonl(path, values):
    with pathlib.Path(path).open("w") as output:
        for value in values:
            output.write(json.dumps(value, sort_keys=True) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=int)
    parser.add_argument("--duration", type=int, default=60)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--session", required=True)
    parser.add_argument("--db", default="/home/chief/.local/share/opencode/opencode.db")
    parser.add_argument("--log", default="/home/chief/.local/share/opencode/log/opencode.log")
    args = parser.parse_args()

    root_stat = parse_stat(args.root)
    if root_stat is None:
        raise SystemExit(f"root PID {args.root} does not exist")
    expected_starttime = root_stat["starttime_ticks"]
    timestamp = datetime.datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    result_root = pathlib.Path(f"/tmp/opencode-proc-bench-{timestamp}")
    result_root.mkdir(mode=0o700)
    print(f"RESULT_ROOT={result_root}", flush=True)

    log_before = stat_file(args.log)
    db_before = db_snapshot(args.db, args.session)
    before_power = power_profile("before", 0)
    hz = os.sysconf("SC_CLK_TCK")
    start_mono_ns = time.monotonic_ns()
    snapshots = [snapshot(args.root, expected_starttime, args.db, args.log, 0, start_mono_ns)]
    powers = [before_power]
    count = round(args.duration / args.interval)
    aborted = None
    for index in range(1, count + 1):
        deadline = start_mono_ns + int(index * args.interval * 1_000_000_000)
        remaining = (deadline - time.monotonic_ns()) / 1_000_000_000
        if remaining > 0:
            time.sleep(remaining)
        try:
            snapshots.append(snapshot(args.root, expected_starttime, args.db, args.log, index, deadline))
        except RuntimeError as error:
            aborted = {"index": index, "error": str(error), "wall_epoch_ms": int(time.time() * 1000)}
            break
        powers.append(power_profile("bin", index))
    powers.append(power_profile("after", len(snapshots) - 1))

    bins = [build_bin(snapshots[index - 1], snapshots[index], hz) for index in range(1, len(snapshots))]
    end_wall_ms = snapshots[-1]["wall_epoch_ms"]
    db_after = db_snapshot(args.db, args.session)
    workload = db_window(args.db, args.session, snapshots[0]["wall_epoch_ms"], end_wall_ms)
    profiles = sorted({value["profile"] for value in powers if value["returncode"] == 0})
    summary = summarize_bins(bins)
    summary.update(
        {
            "result_root": str(result_root),
            "root_pid": args.root,
            "root_starttime_ticks": expected_starttime,
            "session_id": args.session,
            "start_wall_epoch_ms": snapshots[0]["wall_epoch_ms"],
            "end_wall_epoch_ms": end_wall_ms,
            "actual_window_seconds": (snapshots[-1]["mono_ns"] - snapshots[0]["mono_ns"]) / 1_000_000_000,
            "power_profiles_seen": profiles,
            "power_profile_stable": len(profiles) == 1 and len(powers) == len(snapshots) + 1,
            "power_sample_count": len(powers),
            "aborted": aborted,
            "db_before": db_before,
            "db_after": db_after,
            "workload_message_count": len(workload["messages"]),
            "workload_part_count": len(workload["parts"]),
            "warnings": [],
        }
    )
    if summary["tree_change_bins"]:
        summary["warnings"].append("process tree changed; use phase segments, not the whole-window mean as homogeneous")
    if any(value["snapshot_races"] for value in snapshots):
        summary["warnings"].append("one or more processes vanished during a snapshot")
    if not summary["power_profile_stable"]:
        summary["warnings"].append("power profile was not stable or a per-bin profile sample is missing")
    if any(value["phase_key"] != "no-worker" for value in bins):
        summary["warnings"].append("AI worker present: this is active workload, not idle")
    if aborted:
        summary["warnings"].append("benchmark aborted because root identity did not remain valid")

    metadata = {
        "argv": os.sys.argv,
        "observer_pid": os.getpid(),
        "clock_ticks_per_second": hz,
        "page_size": os.sysconf("SC_PAGE_SIZE"),
        "logical_cpus": os.cpu_count(),
        "boot_id": (read_text("/proc/sys/kernel/random/boot_id") or "").strip(),
        "root_initial": snapshots[0]["processes"][0] if snapshots[0]["processes"] else None,
        "db_path": args.db,
        "log_path": args.log,
        "log_before": log_before,
        "log_after": stat_file(args.log),
        "method": "passive /proc snapshots; no signals, product API, ptrace, perf attach, or terminal input",
    }
    write_json(result_root / "metadata.json", metadata)
    write_jsonl(result_root / "snapshots.jsonl", snapshots)
    write_jsonl(result_root / "bins.jsonl", bins)
    write_jsonl(result_root / "power.jsonl", powers)
    write_json(result_root / "workload.json", workload)
    write_json(result_root / "summary.json", summary)
    print(json.dumps(summary, indent=2, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
