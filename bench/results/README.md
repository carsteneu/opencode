# B2 prose-tail A/B: baseline (unpatched) vs patch

Interleaved measurement of the streamed markdown projection, run on 2026-10-13 at 18:37-18:39 CEST.

- Baseline: `cf5bf5fb91` (the branch point, unpatched), worktree `.yesmem/tmp/base-checkout`
- Patch: `1182ece213` (this branch), worktree `bench/..`
- Probe file copied unchanged into both arms: `bench/prose-tail-ram.ts`, sha256 `93f676ee31a346a5e9aa475ade715b259aa36aa1da286c1cb9f9c1b96b8285d7`
- Runner: `bun bench/prose-tail-ab.ts 5` - arms alternate inside one series (b p b p b p b p b p), 5 paired rounds
- Raw data: `prose-tail-ab.ndjson` (one line per sample), `prose-tail-ab.json` (samples + aggregation + worker arm)
- Workload: `bench/stream.ts`, 40000 chars in 1667 deltas of 24 chars

## Host load

The host load average was **9.3 - 17.4** across the series (the fork runbook budget is <= 4), and a
second yesloop agent ran in parallel on the same machine. **Every absolute number below is therefore
UNVERIFIED as a machine-independent figure**; the finding is the paired baseline/patch ratio, which
is computed inside the series. The `n`, load range and source command are given per row.

## Results (median, spread in brackets, ratio = baseline/patch paired median)

| metric                                                                                   | baseline              | patch                 | ratio                 | n   | load     | source                                           |
| ---------------------------------------------------------------------------------------- | --------------------- | --------------------- | --------------------- | --- | -------- | ------------------------------------------------ |
| **markdown projection CPU per 40 KB stream** (core metric; median of 3 in-process runs)  | 2204 ms [1842-2775]   | 86 ms [67-105]        | **27.5x** [20.3-37.7] | 5   | 9.3-17.4 | `bench/parse.ts` `current_full_relex.cpuMs`      |
| projection CPU per stream, own process                                                   | 2777.6 ms [2148-3681] | 146.4 ms [134-315]    | **19.9x** [6.8-25.1]  | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `load.cpuMsPerStream`  |
| wall clock per stream                                                                    | 2494.4 ms [1901-3315] | 98.0 ms [89-240]      | **25.5x** [7.9-33.8]  | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `load.wallMs`          |
| CPU idle (per 400 ms idle window)                                                        | 0.5 ms [0.3-3.3]      | 2.4 ms [1.7-3.7]      | 0.19 [0.17-1.36]      | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `idle.idleCpuMs`       |
| process PSS idle                                                                         | 36.19 MiB [35.3-45.0] | 38.35 MiB [38.1-38.6] | 0.94 [0.92-1.18]      | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `idle.pssKb`           |
| process PSS peak under streaming load                                                    | 63.39 MiB [62.8-71.5] | 61.04 MiB [59.8-63.1] | 1.05 [1.00-1.17]      | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `load.pssKbPeak`       |
| process PSS after the stream                                                             | 63.39 MiB [62.8-71.5] | 60.94 MiB [58.9-61.3] | 1.06 [1.03-1.17]      | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `load.pssKbEnd`        |
| harness arm: v1 same-line fast path                                                      | 505.8 ms [431-611]    | 77.2 ms [57-116]      | 7.6x [4.2-10.3]       | 5   | 9.3-17.4 | `bench/parse.ts` `fastpath_v1_same_line.cpuMs`   |
| **negative control:** block lexer alone over the full text (identical code in both arms) | 2296.8 ms [2070-2979] | 2927.7 ms [2136-4437] | 0.97 [0.52-1.27]      | 5   | 9.3-17.4 | `bench/parse.ts` `lexer_probe_full_lex.cpuMs`    |
| worker boundary, full-text protocol, round trip per stream                               | 2434.0 ms             | 285.0 ms              | 8.5x                  | 1   | 9.3      | `bench/worker.ts` `proj-full.totalRoundTripMs`   |
| worker boundary, suffix protocol, round trip per stream                                  | 706.7 ms              | 268.6 ms              | 2.6x                  | 1   | 9.3      | `bench/worker.ts` `proj-suffix.totalRoundTripMs` |
| main thread post of the request payload (1667 deltas)                                    | 25.4 ms               | 15.5 ms               | 1.6x                  | 1   | 9.3      | `bench/worker.ts` `proj-full.totalPostMs`        |

## How to read this

- **The negative control is the honest yardstick.** `lexer_probe_full_lex` exercises `stream()` only,
  which this change does not touch, in both arms it is literally the same call. Its paired ratio is
  0.97 with a spread of 0.52-1.27 - that is the noise band of this series. The projection ratio of
  27.5x is far outside it, and every one of the 5 paired rounds was above 20x.
- **The core metric is the row the task asked for**: CPU per stream in the markdown path, off the
  main thread, in the worker-side projection. 27.5x paired by `bench/parse.ts`, 19.9x by the
  independent own-process probe.
- **CPU idle is noise at this resolution** (0.5 ms vs 2.4 ms over a 400 ms window, ratio spread
  0.17-1.36 - that is sub-millisecond jitter of an idle process). It is reported because the task
  asked for an idle figure, not because it differs.
- **RAM is unchanged within noise.** Idle PSS is 2.2 MiB _higher_ in the patch arm (ratio 0.94,
  spread overlaps 1.0), peak PSS is 2.4 MiB lower (ratio 1.05, spread overlaps 1.0). At this n and
  load I read that as no memory effect in either direction, not as a win.
- **The worker boundary is not touched by the patch.** The request payload is still the full text per
  delta, which is B2 proper and remains NO-GO. The boundary rows are n=1 and only show that the
  protocol itself did not change (main-thread post cost ratio 1.6 sits in the noise band at n=1) while
  the worker's round trip drops because the parse inside it is cheaper.

## Limits and corrections

- **No app-level measurement.** An A/B of the real GUI process (its RAM and CPU, the process split
  between renderer and worker) would need a built bundle, which the task forbids. The probe runs the
  real `project()` code in its own process and reports that process's `/proc` counters. It is not
  presented as an app measurement.
- **No process split.** In Bun a `Worker` is a thread in the same process, so "client vs worker PSS"
  is not separable; the harness's worker arm measures the _protocol_ instead.
- **No start time.** `yesdocs/v2-cleanup-2026-10-13/run-bench.sh` measures the TUI ready time of a
  built binary. Not reproducible here (no build), and the change is worker-side with no startup path.
- **Row label corrected after the run.** The JSON was produced by the runner before this README, and
  its second control row is labelled "v1 same-line fast path CPU (harness copy, untouched by the
  patch)". That label is wrong: that arm calls `project()` for its own fallbacks (`bench/parse.ts:24`,
  `:35`, `:40`), so the patch does affect it. The row's numbers are unaffected, only its reading: it is
  a second arm that also benefits, not a control. The negative control is the lexer probe row.
- The harness's own equivalence check reports the same numbers in both arms
  (`blockStructureMismatches: 0`, `srcMismatches: 0`, `rawMismatches: 2` - the known lexer newline
  normalization), so the patch neither improved nor regressed that check.
