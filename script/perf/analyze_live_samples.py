#!/usr/bin/env python3
"""Analyzer for live_process_sampler.py output directories.

Usage: analyze_live_samples.py SAMPLES_DIR

SAMPLES_DIR must contain meta.json + samples.jsonl. Reads clk_tck from
meta.json (no hardcoded 100). Prints one JSON blob: per-tree role CPU %,
context switches/s, read/write B/s, RSS/PSS avg/max/end, per-bin CPU stats,
and signature segments (phases of constant process-tree composition).
"""
import json
import pathlib
import statistics
import sys


directory = pathlib.Path(sys.argv[1])
samples = [json.loads(line) for line in (directory / "samples.jsonl").read_text().splitlines() if line.strip()]
meta = json.loads((directory / "meta.json").read_text())
clk = meta["clk_tck"]
result = {"samples": len(samples), "seconds": (samples[-1]["monotonic_ns"] - samples[0]["monotonic_ns"]) / 1e9}
profiles = sorted({sample["power_profile"] for sample in samples})
result["profiles"] = profiles
host_total = samples[-1]["host_cpu"]["total_ticks"] - samples[0]["host_cpu"]["total_ticks"]
host_idle = samples[-1]["host_cpu"]["idle_ticks"] - samples[0]["host_cpu"]["idle_ticks"]
result["host_busy_pct"] = 100 * (host_total - host_idle) / host_total
result["load_start"] = samples[0]["loadavg"]
result["load_end"] = samples[-1]["loadavg"]
result["trees"] = {}
for root in samples[0]["trees"]:
    cpu = {}
    ctx = {}
    io_read = {}
    io_write = {}
    bins = []
    signatures = []
    rss = []
    pss = []
    for sample in samples:
        procs = sample["trees"][root]
        rss.append(sum(proc["rss_bytes"] for proc in procs))
        pss.append(sum(proc["pss_bytes"] or 0 for proc in procs))
        signatures.append(tuple(sorted((proc["identity"], proc["role"]) for proc in procs)))
    for before, after in zip(samples, samples[1:]):
        dt = (after["monotonic_ns"] - before["monotonic_ns"]) / 1e9
        prior = {proc["identity"]: proc for proc in before["trees"][root]}
        current = {proc["identity"]: proc for proc in after["trees"][root]}
        role_cpu = {}
        for identity in prior.keys() & current.keys():
            one = prior[identity]
            two = current[identity]
            role = two["role"]
            ticks = two["utime_ticks"] + two["stime_ticks"] - one["utime_ticks"] - one["stime_ticks"]
            role_cpu[role] = role_cpu.get(role, 0) + ticks / clk
            cpu[role] = cpu.get(role, 0) + ticks / clk
            ctx[role] = ctx.get(role, 0) + two["voluntary_ctx"] + two["nonvoluntary_ctx"] - one["voluntary_ctx"] - one["nonvoluntary_ctx"]
            io_read[role] = io_read.get(role, 0) + two["io"].get("read_bytes", 0) - one["io"].get("read_bytes", 0)
            io_write[role] = io_write.get(role, 0) + two["io"].get("write_bytes", 0) - one["io"].get("write_bytes", 0)
        bins.append({"dt": dt, "cpu_pct": 100 * sum(role_cpu.values()) / dt, "roles_cpu_pct": {role: 100 * value / dt for role, value in role_cpu.items()}, "signature_changed": signatures[len(bins)] != signatures[len(bins) + 1]})
    segments = []
    start = 0
    for index in range(1, len(signatures)):
        if signatures[index] == signatures[index - 1]:
            continue
        segments.append([start, index - 1, list(signatures[index - 1])])
        start = index
    segments.append([start, len(signatures) - 1, list(signatures[-1])])
    seconds = result["seconds"]
    result["trees"][root] = {
        "cpu_pct": 100 * sum(cpu.values()) / seconds,
        "role_cpu_pct": {role: 100 * value / seconds for role, value in cpu.items()},
        "ctx_per_s": {role: value / seconds for role, value in ctx.items()},
        "read_Bps": {role: value / seconds for role, value in io_read.items()},
        "write_Bps": {role: value / seconds for role, value in io_write.items()},
        "rss_MiB_avg_max_end": [statistics.mean(rss) / 2**20, max(rss) / 2**20, rss[-1] / 2**20],
        "pss_MiB_avg_max_end": [statistics.mean(pss) / 2**20, max(pss) / 2**20, pss[-1] / 2**20],
        "bin_cpu_pct_min_med_max": [min(bin["cpu_pct"] for bin in bins), statistics.median(bin["cpu_pct"] for bin in bins), max(bin["cpu_pct"] for bin in bins)],
        "segments": segments,
        "bins": bins,
    }
print(json.dumps(result, indent=2))
