# B2 prose-tail A/B: baseline (unpatched) vs patch

Interleaved measurement of the streamed markdown projection. Two revisions of this branch were
measured, and both belong in the record:

- **Run A - the incremental-region variant** (`1182ece213`), measured 2026-10-13 18:37-18:39.
  It carried a large win and was then **rejected in cold review for correctness**, see below.
- **Run B - the shipped revision** (`aa75deab8f` plus the later `refs()` reorder), measured
  2026-10-13 19:12-19:15. It is a correctness fix without a performance claim.

- Baseline for both runs: `cf5bf5fb91` (the branch point, unpatched), worktree `.yesmem/tmp/base-checkout`.
  Verified byte-identical to the base commit for the file under test:
  `md5sum .yesmem/tmp/base-checkout/packages/session-ui/src/components/markdown-stream.ts` =
  `git show cf5bf5fb91:...` = `d00c5f6bc644641e6d6f73546bdc5668`.
- Probe copied unchanged into both arms: `bench/prose-tail-ram.ts`, sha256
  `93f676ee31a346a5e9aa475ade715b259aa36aa1da286c1cb9f9c1b96b8285d7`.
- Runner: `bun bench/prose-tail-ab.ts 5` - arms alternate inside one series (`b p b p b p b p b p`),
  5 paired rounds.
- Raw data: `prose-tail-ab.ndjson` / `prose-tail-ab.json` (run B), `prose-tail-ab-regionpath.ndjson` /
  `prose-tail-ab-regionpath.json` (run A), `prose-tail-ab-refsfirst.ndjson` / `prose-tail-ab-refsfirst.json`
  (an intermediate revision of run B whose `refs()` guard sat on every delta).
- Workload: `bench/stream.ts`, 40000 chars in 1667 deltas of 24 chars.
- Reproduce: `bun bench/prose-tail-ab.ts 5`.

## Host load

Run A ran at load **9.3-17.4**, run B at **8.0-8.4** (the fork runbook budget is <= 4), with a second
yesloop agent on the same machine. **Every absolute number below is UNVERIFIED as a
machine-independent figure**; the finding is the paired baseline/patch ratio, computed inside one
series. `n`, load range and source command are given per row.

## Run B - the shipped revision (correctness fix, no performance claim)

| metric                                                                                   | baseline              | patch                 | ratio                | n   | load    | source                                           |
| ---------------------------------------------------------------------------------------- | --------------------- | --------------------- | -------------------- | --- | ------- | ------------------------------------------------ |
| markdown projection CPU per 40 KB stream (median of 3 in-process runs)                   | 2394.5 ms [1733-2623] | 2371.7 ms [1761-2534] | 1.01 [0.75-1.36]     | 5   | 8.0-8.4 | `bench/parse.ts` `current_full_relex.cpuMs`      |
| projection CPU per stream, own process                                                   | 2512.1 ms [2051-2700] | 2574.8 ms [1925-2822] | 1.03 [0.73-1.30]     | 5   | 8.0-8.4 | `bench/prose-tail-ram.ts` `load.cpuMsPerStream`  |
| wall clock per stream                                                                    | 2257.8 ms [1778-2461] | 2314.8 ms [1676-2545] | 1.04 [0.72-1.35]     | 5   | 8.0-8.4 | `bench/prose-tail-ram.ts` `load.wallMs`          |
| CPU idle (400 ms window)                                                                 | 0.4 ms                | 0.3 ms                | 0.88 [0.49-1.33]     | 5   | 8.0-8.4 | `bench/prose-tail-ram.ts` `idle.idleCpuMs`       |
| process PSS idle                                                                         | 45.45 MiB [43.4-47.0] | 44.33 MiB [43.8-46.2] | 1.01 [0.94-1.06]     | 5   | 8.0-8.4 | `bench/prose-tail-ram.ts` `idle.pssKb`           |
| process PSS peak under streaming load                                                    | 71.96 MiB [71.2-72.6] | 72.35 MiB [71.7-72.7] | 1.00 [0.98-1.01]     | 5   | 8.0-8.4 | `bench/prose-tail-ram.ts` `load.pssKbPeak`       |
| process PSS after the stream                                                             | 71.96 MiB             | 72.35 MiB             | 1.00 [0.98-1.01]     | 5   | 8.0-8.4 | `bench/prose-tail-ram.ts` `load.pssKbEnd`        |
| harness arm: v1 same-line fast path                                                      | 572.4 ms              | 587.5 ms              | 0.95 [0.72-1.23]     | 5   | 8.0-8.4 | `bench/parse.ts` `fastpath_v1_same_line.cpuMs`   |
| **negative control:** block lexer alone over the full text (identical code in both arms) | 2657.3 ms [1861-2822] | 2602.3 ms [1930-2875] | **0.96** [0.73-1.35] | 5   | 8.0-8.4 | `bench/parse.ts` `lexer_probe_full_lex.cpuMs`    |
| worker boundary, full-text protocol, round trip per stream                               | 2903.1 ms             | 2283.7 ms             | 1.27x                | 1   | 7.9-8.1 | `bench/worker.ts` `proj-full.totalRoundTripMs`   |
| worker boundary, suffix protocol, round trip per stream                                  | 732.3 ms              | 1005.9 ms             | 0.73x                | 1   | 7.9-8.1 | `bench/worker.ts` `proj-suffix.totalRoundTripMs` |
| main thread post of the request payload (1667 deltas)                                    | 22.7 ms               | 22.4 ms               | 1.01x                | 1   | 7.9-8.1 | `bench/worker.ts` `proj-full.totalPostMs`        |

**Reading:** nothing here is a change. The negative control exercises `stream()` only, which this
revision does not touch at all, so its ratio _is_ the noise floor of the series: 0.96 with a spread of
0.73-1.35 at n=5 and load ~8. Every other row sits inside that band, including the ones that look
like a 27 % win or a 27 % loss (both boundary rows are n=1). CPU per stream is 1.01, RAM is 1.00, PSS
peak and end are equal to 0.05 %. The honest statement is: the shipped change costs and saves
nothing measurable, which is what a guard-only change should measure.

The intermediate revision `prose-tail-ab-refsfirst.*` shows what the placement of one guard is worth:
with `refs()` on every delta the same series gave 0.90 [0.71-1.04] on the projection and 0.83
[0.69-0.98] on the fast-path arm, and moving the check inside the code branch (where it is only paid
when that branch would fire) brought both back to the numbers above.

## Run A - the incremental-region variant (rejected)

| metric                                                     | baseline              | patch                 | ratio                 | n   | load     | source                                          |
| ---------------------------------------------------------- | --------------------- | --------------------- | --------------------- | --- | -------- | ----------------------------------------------- |
| markdown projection CPU per 40 KB stream                   | 2204 ms [1842-2775]   | 86 ms [67-105]        | **27.5x** [20.3-37.7] | 5   | 9.3-17.4 | `bench/parse.ts` `current_full_relex.cpuMs`     |
| projection CPU per stream, own process                     | 2777.6 ms [2148-3681] | 146.4 ms [134-315]    | **19.9x** [6.8-25.1]  | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `load.cpuMsPerStream` |
| wall clock per stream                                      | 2494.4 ms [1901-3315] | 98.0 ms [89-240]      | **25.5x** [7.9-33.8]  | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `load.wallMs`         |
| process PSS idle                                           | 36.19 MiB [35.3-45.0] | 38.35 MiB [38.1-38.6] | 0.94 [0.92-1.18]      | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `idle.pssKb`          |
| process PSS peak under streaming load                      | 63.39 MiB [62.8-71.5] | 61.04 MiB [59.8-63.1] | 1.05 [1.00-1.17]      | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `load.pssKbPeak`      |
| process PSS after the stream                               | 63.39 MiB             | 60.94 MiB             | 1.06 [1.03-1.17]      | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `load.pssKbEnd`       |
| harness arm: v1 same-line fast path                        | 505.8 ms              | 77.2 ms               | 7.6x [4.2-10.3]       | 5   | 9.3-17.4 | `bench/parse.ts` `fastpath_v1_same_line.cpuMs`  |
| **negative control:** block lexer alone over the full text | 2296.8 ms [2070-2979] | 2927.7 ms [2136-4437] | **0.97** [0.52-1.27]  | 5   | 9.3-17.4 | `bench/parse.ts` `lexer_probe_full_lex.cpuMs`   |
| worker boundary, full-text protocol, round trip per stream | 2434.0 ms             | 285.0 ms              | 8.5x                  | 1   | 9.3      | `bench/worker.ts` `proj-full.totalRoundTripMs`  |
| main thread post of the request payload (1667 deltas)      | 25.4 ms               | 15.5 ms               | 1.6x                  | 1   | 9.3      | `bench/worker.ts` `proj-full.totalPostMs`       |

**Why it was rejected.** The win is real and large - 27.5x on the core metric, every paired round
above 20x, far outside the control's 0.52-1.27 noise band - but the optimisation is not equivalent to
the full re-lex. Two independent cold reviews and my own probes reproduced three mechanisms:

1. **A construct that spans several blocks is completed by an append far below it.** A display math
   block is one `blockKatex` token only once its closing `$$` line arrives, and that token then
   starts above the blocks the previous text had: `"a\n\n$$\n# b\n\nc\n$$"` renders as one math block
   but the incremental path returned `["a\n\n", "$$\n", "# b\n\n", "c\n$$"]`. A GFM setext heading
   swallows the rule line above it: `"a\n***\nb\n==="`.
2. **An append destroys the construct a settled boundary was built on.** An empty ATX heading
   `"######"` completed to `"####### not a heading"` merges the heading into the paragraph above; a
   list marker completed by `")"` turns a paragraph into a loose list that absorbs the block above the
   blank line.
3. **A block raw is not a source offset**, so a region cannot be cut from one: the lexer normalises
   CRLF before lexing and a leading whitespace token belongs to no block, so both possible offset
   derivations duplicate blocks (`"  \na\n\na\n\nne"`, `"\r\n\r\n# H\r\n# H\r\nne"`).

The fix for (1) would have to verify a prefix of unbounded length (the merge reached 5+ blocks), the
one-block seam check that was shipped could not see it, and (3) rules out the cheaper
verified-boundary variant. The full reproductions live in the equivalence suite
(`spanningMath`, `setextSwallowsRule`, `emptyHeadingDestroyed`, `listAbsorbsParagraph`,
`leadingBlankLine`, `crlfFence` in `packages/session-ui/src/components/markdown-stream-equivalence.test.ts`).

## Limits

- **No app-level measurement.** An A/B of the real GUI process (its RAM, its CPU, the split between
  renderer and worker) would need a built bundle, which the task forbids. The probe runs the real
  `project()` code in its own process and reports that process's `/proc` counters; it is not an app
  measurement.
- **No process split.** In Bun a `Worker` is a thread in the same process, so "client vs worker PSS"
  is not separable; the harness's worker arm measures the protocol instead.
- **No start time.** `yesdocs/v2-cleanup-2026-10-13/run-bench.sh` measures the TUI ready time of a
  built binary - not reproducible here, and the change touches no startup path.
- **The baseline worktree is dirty.** `bench/prose-tail-ab.ts` copies the probe into the baseline arm,
  and the equivalence tests were copied there for the RED proof, so `.yesmem/tmp/base-checkout` no
  longer matches `cf5bf5fb91` file for file. The measured file was verified by md5 (see above); a
  re-run should recreate the worktree.
- **Correction kept in the record.** Run A's JSON was produced before this README and labels one row
  "control: v1 same-line fast path CPU (harness copy, untouched by the patch)". That label is wrong:
  that arm calls `project()` for its own fallbacks (`bench/parse.ts:24`, `:35`, `:40`), so the patch
  reaches it too. The numbers are unaffected, the reading is: a second arm, not a control. The
  runner is fixed; the negative control is the lexer probe row.
- The harness's own equivalence check compares `project()` against its own fast path, **not** against
  `stream(text, true)`, and its workload contains no `$$`, no CRLF and no setext/rule combination. It
  is not an equivalence proof for this change; the suite in `packages/session-ui` is.
