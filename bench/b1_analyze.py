#!/usr/bin/env python3
"""Summarise a B1 measurement JSON into report tables.

Usage: python3 bench/b1_analyze.py .yesmem/tmp/b1-paired.json
"""

import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from b1_tokens import rows_for, turns, turns_timed  # noqa: E402


def idx(s):
    return s["round"] if "round" in s else s["i"]


def med(xs):
    return statistics.median(xs) if xs else float("nan")


def arm_tokens(arm, iso, last):
    db = os.path.join(iso, arm, "data", "opencode", "opencode.db")
    if not os.path.exists(db):
        return None
    return [t[0] for t in turns(rows_for(arm, db))[-last:]]


def arm_tokens_for_streams(arm, iso, rows):
    """Match each stream to exactly one turn (nearest by start time).

    Plain window containment is not enough: the arms alternate, so the same
    arm's streams can be adjacent and a generous window then claims the
    neighbour's turn as well. Each turn is consumed at most once.
    """
    db = os.path.join(iso, arm, "data", "opencode", "opencode.db")
    if not os.path.exists(db) or any("wall_start" not in r for r in rows):
        return None
    timed = turns_timed(rows_for(arm, db))
    used = set()
    out = []
    for r in rows:
        start = r["wall_start"] * 1000
        best = None
        for i, (ts, tok) in enumerate(timed):
            if i in used:
                continue
            distance = abs(ts - start)
            if distance <= 6000 and (best is None or distance < best[0]):
                best = (distance, i, tok)
        if best is None:
            out.append(0)
            continue
        used.add(best[1])
        out.append(best[2])
    return out


def sums(per_role):
    """Sum of cpu_pct over roles, per stream."""
    return sum(v.get("cpu_pct", 0.0) for v in per_role.values())


def main():
    path = sys.argv[1]
    iso = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".yesmem", "tmp", "iso")
    last = 0
    for a in sys.argv[2:]:
        if a.startswith("--iso="):
            iso = a.split("=", 1)[1]
        elif a.startswith("--last="):
            last = int(a.split("=", 1)[1])
    d = json.load(open(path))

    print(f"# B1 measurement summary — {path}")
    print(f"mode={d.get('mode', d.get('arm'))}  prompt_lines={d.get('lines')}  "
          f"term={d.get('rows')}x{d.get('cols')}  nproc={d.get('host_nproc')}")
    print(f"power_profile={d.get('power_profile', 'unknown')}")
    for arm, info in (d.get("binaries") or {}).items():
        print(f"bin {arm}: {info['path']} md5={info['md5']}")
    if "binary_md5" in d:
        print(f"bin {d['arm']}: {d.get('binary')} md5={d['binary_md5']}")
    print()

    series = d.get("series") or {d["arm"]: d.get("streams", [])}
    roles_seen = sorted({r for arm in series for s in series[arm] for r in s["per_role"]})

    # --- idle ---
    for phase in ("idle", "idle_before", "idle_after"):
        if phase not in d:
            continue
        blk = d[phase]
        if "per_role" in blk:
            blk = {d["arm"]: blk}
        print(f"## {phase}")
        for arm, rec in blk.items():
            cells = " ".join(f"{r}={rec['per_role'].get(r, {}).get('cpu_pct', 0):.2f}%" for r in roles_seen)
            print(f"  {arm}: {cells}  [total={sums(rec['per_role']):.2f}%, "
                  f"window={rec['window_s']:.0f}s, load={rec.get('load', float('nan')):.1f}]")
        print()

    # --- streaming, warm-up excluded ---
    for label, skip in (("all rounds", 0), ("warm-up round 0 excluded", 1)):
        print(f"## streaming CPU % of one core — {label}")
        header = f"  {'arm':4} {'n':>2} " + " ".join(f"{r:>9}" for r in roles_seen) + f" {'TOTAL':>9}"
        print(header)
        for arm in series:
            rows = [s for s in series[arm] if idx(s) >= skip]
            if not rows:
                continue
            cells = []
            for r in roles_seen:
                cells.append(f"{med([s['per_role'].get(r, {}).get('cpu_pct', 0.0) for s in rows]):9.2f}")
            tot = f"{med([sums(s['per_role']) for s in rows]):9.2f}"
            print(f"  {arm:4} {len(rows):>2} " + " ".join(cells) + f" {tot}")
        print()

    # --- spread ---
    print("## per-role min / median / max (warm-up excluded), and v2/v1 ratio")
    for r in roles_seen:
        print(f"  role {r}:")
        vals = {}
        for arm in series:
            rows = [s for s in series[arm] if idx(s) >= 1]
            v = [s["per_role"].get(r, {}).get("cpu_pct", 0.0) for s in rows]
            if not v:
                continue
            vals[arm] = med(v)
            print(f"    {arm}: min={min(v):6.2f} med={med(v):6.2f} max={max(v):6.2f}  (raw={[round(x, 1) for x in v]})")
        if "v2" in vals and "v1" in vals and vals["v1"] > 0:
            print(f"    v2/v1 ratio (median): {vals['v2'] / vals['v1']:.2f}")
    print()

    # --- RAM ---
    print("## peak PSS / RSS per role (median over streams, MiB)")
    for arm in series:
        rows = [s for s in series[arm] if idx(s) >= 1]
        print(f"  {arm}:")
        for r in roles_seen:
            pss = [s["per_role"].get(r, {}).get("pss_peak", 0) for s in rows if r in s["per_role"]]
            rss = [s["per_role"].get(r, {}).get("rss_peak", 0) for s in rows if r in s["per_role"]]
            if pss:
                print(f"    {r}: pss={med(pss) / 1048576:.1f} MiB rss={med(rss) / 1048576:.1f} MiB")

    # --- host load during streams ---
    print()
    print("## host load (1 min) during streams")
    for arm in series:
        rows = [s for s in series[arm] if idx(s) >= 1]
        print(f"  {arm}: {[round(s['load'], 1) for s in rows]}")

    # --- normalisation per 1000 output tokens ---
    print()
    print("## CPU seconds per 1000 output tokens")
    for arm in series:
        allrows = series[arm]
        keep = [i for i, s in enumerate(allrows) if idx(s) >= 1]
        rows = [allrows[i] for i in keep]
        exact = arm_tokens_for_streams(arm, iso, allrows)
        if exact is not None:
            tok = [exact[i] for i in keep]
            src = "matched by wall-clock window"
        elif last:
            t = arm_tokens(arm, iso, last)
            if not t or len(t) < len(rows):
                print(f"  {arm}: token data unavailable (turns={len(t) if t else 0}, streams={len(rows)})")
                continue
            tok = t[-len(rows):]
            src = f"APPROXIMATE: last {last} turns, result file has no wall bounds"
        else:
            print(f"  {arm}: skipped — result file has no wall bounds and no --last given")
            continue
        if not all(tok):
            print(f"  {arm}: skipped — incomplete token match {tok}")
            continue
        print(f"  {arm}: output_tokens={tok}  [{src}]")
        for role in [r for r in roles_seen if r != "other"]:
            cpus = [s["per_role"].get(role, {}).get("cpu_s", 0.0) for s in rows]
            per = [c / t * 1000 for c, t in zip(cpus, tok) if t]
            if per:
                print(f"    {role:8} {med(per):6.3f} s/1k tok  (med over {len(per)})")
        tot_cpu = [sum(v.get("cpu_s", 0.0) for v in s["per_role"].values()) for s in rows]
        per = [c / t * 1000 for c, t in zip(tot_cpu, tok) if t]
        if per:
            print(f"    {'TOTAL':8} {med(per):6.3f} s/1k tok")


if __name__ == "__main__":
    main()
