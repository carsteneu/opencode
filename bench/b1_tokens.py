#!/usr/bin/env python3
"""Extract output-token counts per conversation turn from an arm's isolated DB.

Both arms persist exact token usage for finished assistant messages:
  v2 -> session_message (type user|assistant), data.tokens.output
  v1 -> message (role user|assistant), data.tokens.output

A "turn" is a user message plus every assistant message until the next user
message, so multi-step answers are summed.

Usage:
  python3 bench/b1_tokens.py --arm v2 --iso .yesmem/tmp/iso --last 7
"""

import argparse
import json
import os
import sqlite3
import sys


def rows_for(arm, db):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    out = []
    if arm == "v2":
        q = "select time_created, type, data from session_message order by time_created, seq"
        for ts, typ, data in con.execute(q):
            if typ in ("user", "assistant"):
                out.append((ts, typ, data))
    else:
        q = "select time_created, data from message order by time_created"
        for ts, data in con.execute(q):
            try:
                role = json.loads(data).get("role")
            except Exception:
                continue
            if role in ("user", "assistant"):
                out.append((ts, role, data))
    return out


def turns(rows):
    """[(output_tokens, n_assistant_msgs)] in chronological order."""
    out = []
    for ts, typ, data in rows:
        try:
            d = json.loads(data)
        except Exception:
            continue
        if typ == "user":
            out.append([0, 0])
            continue
        if not out:
            out.append([0, 0])
        tok = (d.get("tokens") or {}).get("output") or 0
        out[-1][0] += int(tok)
        out[-1][1] += 1
    return [t for t in out if t[1] > 0]


def turns_timed(rows):
    """[(timestamp_ms, output_tokens)] so a turn can be matched to a measured window."""
    out = []
    for ts, typ, data in rows:
        try:
            d = json.loads(data)
        except Exception:
            continue
        if typ == "user":
            out.append([ts, 0])
            continue
        if not out:
            out.append([ts, 0])
        out[-1][1] += int((d.get("tokens") or {}).get("output") or 0)
    return [(ts, tok) for ts, tok in out if tok > 0]


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True, choices=["v1", "v2"])
    ap.add_argument("--iso", default=os.path.join(here, "..", ".yesmem", "tmp", "iso"))
    ap.add_argument("--last", type=int, default=0, help="0 = all turns")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    db = os.path.join(args.iso, args.arm, "data", "opencode", "opencode.db")
    if not os.path.exists(db):
        raise SystemExit(f"no db: {db}")
    t = turns(rows_for(args.arm, db))
    if args.last:
        t = t[-args.last:]
    if args.json:
        print(json.dumps([{"output_tokens": a, "assistant_msgs": b} for a, b in t]))
    else:
        for i, (a, b) in enumerate(t):
            print(f"  turn {i}: output_tokens={a} assistant_msgs={b}")


if __name__ == "__main__":
    main()
