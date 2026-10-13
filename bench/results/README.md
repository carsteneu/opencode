# B2 prose-tail A/B: baseline (unpatched) vs patch

Interleaved measurement of the streamed markdown projection. Two revisions of this branch were
measured, and both belong in the record:

- **Run A - the incremental-region variant** (`1182ece213`), measured 2026-10-13 18:37-18:39.
  It carried a large win and was then **rejected in review for correctness**, see below.
- **Run B - the shipped revision** (`6655623843`), measured 2026-10-13 19:45-19:48. It is a
  correctness fix without a performance claim.

## Provenance

|                         |                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| baseline branch point   | `cf5bf5fb91`, worktree `.yesmem/tmp/base-checkout`                                                                                    |
| measured baseline file  | `packages/session-ui/src/components/markdown-stream.ts`, sha256 `2569fcea2d60d6ef748154f07f51a8d47a5a1190fb9e2b39a47b1ee5e5c882cf`    |
| measured patch revision | `6655623843` (clean tree), same file, sha256 `1c58b98475cab0874c65f4978fbb282a2c024318d482048fe2fd63688d5b1922`                       |
| probe                   | `bench/prose-tail-ram.ts`, sha256 `93f676ee31a346a5e9aa475ade715b259aa36aa1da286c1cb9f9c1b96b8285d7`, copied unchanged into both arms |
| runner                  | `bun bench/prose-tail-ab.ts 5` - arms alternate inside one series (`b p b p b p b p b p`), 5 paired rounds                            |
| raw data                | `prose-tail-ab.ndjson` / `prose-tail-ab.json` (run B), `prose-tail-ab-regionpath.ndjson` / `.json` (run A)                            |
| workload                | `bench/stream.ts`, 40000 chars in 1667 deltas of 24 chars                                                                             |

The runner records both the sha256 of the file under test and the HEAD of each arm into the result
file, so a result can be tied to the code it measured. Recreate the baseline worktree with
`git worktree add --detach .yesmem/tmp/base-checkout cf5bf5fb91 && (cd .yesmem/tmp/base-checkout && bun install --frozen-lockfile)`.
Note that the baseline worktree in this session is dirty (the equivalence tests were copied in for
the RED proof); the file under test was verified by hash, the rest of that tree was not used.

## Host load

Run A ran at load **9.3-17.4**, run B at **5.06-8.50** (the fork runbook budget is <= 4), with a
second yesloop agent on the same machine. **Every absolute number below is UNVERIFIED as a
machine-independent figure**; the finding is the paired baseline/patch ratio, computed inside one
series. `n`, load range and source command are given per row.

## Run B - the shipped revision (correctness fix, no performance claim)

| metric                                                                                   | baseline              | patch                 | ratio                | n   | load    | source                                           |
| ---------------------------------------------------------------------------------------- | --------------------- | --------------------- | -------------------- | --- | ------- | ------------------------------------------------ |
| markdown projection CPU per 40 KB stream (median of 3 in-process runs)                   | 2130.6 ms [1592-2409] | 1900.0 ms [1593-2189] | 1.06 [0.73-1.33]     | 5   | 5.1-8.5 | `bench/parse.ts` `current_full_relex.cpuMs`      |
| projection CPU per stream, own process                                                   | 2281.8 ms [1697-2416] | 1851.0 ms [1717-2642] | 1.25 [0.64-1.33]     | 5   | 5.1-8.5 | `bench/prose-tail-ram.ts` `load.cpuMsPerStream`  |
| wall clock per stream                                                                    | 2045.9 ms [1465-2163] | 1591.6 ms [1474-2360] | 1.30 [0.62-1.39]     | 5   | 5.1-8.5 | `bench/prose-tail-ram.ts` `load.wallMs`          |
| CPU idle (400 ms window)                                                                 | 0.4 ms                | 0.2 ms                | 1.50 [1.09-1.71]     | 5   | 5.1-8.5 | `bench/prose-tail-ram.ts` `idle.idleCpuMs`       |
| process PSS idle                                                                         | 44.00 MiB [42.5-45.1] | 44.19 MiB [43.6-46.7] | 0.97 [0.94-1.03]     | 5   | 5.1-8.5 | `bench/prose-tail-ram.ts` `idle.pssKb`           |
| process PSS peak under streaming load                                                    | 71.27 MiB [70.4-71.3] | 72.01 MiB [71.3-73.5] | 0.99 [0.97-1.00]     | 5   | 5.1-8.5 | `bench/prose-tail-ram.ts` `load.pssKbPeak`       |
| process PSS after the stream                                                             | 71.27 MiB             | 72.01 MiB             | 0.99 [0.97-1.00]     | 5   | 5.1-8.5 | `bench/prose-tail-ram.ts` `load.pssKbEnd`        |
| harness arm: v1 same-line fast path                                                      | 498.5 ms [361-582]    | 465.4 ms [419-552]    | 0.97 [0.66-1.25]     | 5   | 5.1-8.5 | `bench/parse.ts` `fastpath_v1_same_line.cpuMs`   |
| **negative control:** block lexer alone over the full text (identical code in both arms) | 2360.7 ms [1702-2642] | 1983.4 ms [1723-2563] | **1.06** [0.68-1.36] | 5   | 5.1-8.5 | `bench/parse.ts` `lexer_probe_full_lex.cpuMs`    |
| worker boundary, full-text protocol, round trip per stream                               | 1793.1 ms             | 1812.3 ms             | 0.99x                | 1   | 7.4     | `bench/worker.ts` `proj-full.totalRoundTripMs`   |
| worker boundary, suffix protocol, round trip per stream                                  | 575.6 ms              | 616.6 ms              | 0.93x                | 1   | 7.4     | `bench/worker.ts` `proj-suffix.totalRoundTripMs` |
| main thread post of the request payload (1667 deltas)                                    | 17.0 ms               | 17.7 ms               | 0.96x                | 1   | 7.4     | `bench/worker.ts` `proj-full.totalPostMs`        |

**Reading:** nothing here is a change. The negative control exercises `stream()` only, which this
revision does not touch at all (the function region is byte-identical to the base), so its ratio _is_
the noise floor of the series: **1.06 with a spread of 0.68-1.36** at n=5 and load ~6. Every other row
sits inside that band - including the two rows that look like a 25-30 % win (own-process CPU and wall
clock) and the row that looks like a 6 % loss (projection CPU, 1.06, the same number the control
shows). Across the three series of this revision the control took 0.97, 1.06 and the projection 0.97,
1.01, 1.06, i.e. the ordering has no consistent direction and the spread (±35 %) swallows the
differences. RAM is identical: PSS idle 0.97, peak and end 0.99 with a spread of 0.97-1.00, i.e.
within 0.8 MiB on a 72 MiB process.

The honest statement is: the shipped change costs and saves nothing measurable, which is what a
guard-only change should measure. The worker rows are n=1 and only show that the protocol bytes did
not move (`responseBytesMedian` is identical in both arms).

The guards also bound their own cost: an earlier revision of this branch had two _quadratic_ scans in
them (a `replace(/\n+$/, "")` and a per-delta `refs()` with a line-crossing label class), found by
the security review; a fence body of 160 KB of blank lines cost 13.8 s _per delta_ against 0.1 ms on
the base, and a body of unclosed brackets ~900x. Both are linear now, and two cost-guard tests pin
them. That is the one row of this whole report where the patch was materially worse than the base,
and it is fixed.

## Run A - the incremental-region variant (rejected)

| metric                                                     | baseline              | patch                 | ratio                 | n   | load     | source                                           |
| ---------------------------------------------------------- | --------------------- | --------------------- | --------------------- | --- | -------- | ------------------------------------------------ |
| markdown projection CPU per 40 KB stream                   | 2204 ms [1842-2775]   | 86 ms [67-105]        | **27.5x** [20.3-37.7] | 5   | 9.3-17.4 | `bench/parse.ts` `current_full_relex.cpuMs`      |
| projection CPU per stream, own process                     | 2777.6 ms [2148-3681] | 146.4 ms [134-315]    | **19.9x** [6.8-25.1]  | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `load.cpuMsPerStream`  |
| wall clock per stream                                      | 2494.4 ms [1901-3315] | 98.0 ms [89-240]      | **25.5x** [7.9-33.8]  | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `load.wallMs`          |
| CPU idle (400 ms window)                                   | 0.5 ms                | 2.4 ms                | 0.19 [0.17-1.36]      | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `idle.idleCpuMs`       |
| process PSS idle                                           | 36.19 MiB [35.3-45.0] | 38.35 MiB [38.1-38.6] | 0.94 [0.92-1.18]      | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `idle.pssKb`           |
| process PSS peak under streaming load                      | 63.39 MiB [62.8-71.5] | 61.04 MiB [59.8-63.1] | 1.05 [1.00-1.17]      | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `load.pssKbPeak`       |
| process PSS after the stream                               | 63.39 MiB             | 60.94 MiB             | 1.06 [1.03-1.17]      | 5   | 9.3-17.4 | `bench/prose-tail-ram.ts` `load.pssKbEnd`        |
| harness arm: v1 same-line fast path                        | 505.8 ms              | 77.2 ms               | 7.6x [4.2-10.3]       | 5   | 9.3-17.4 | `bench/parse.ts` `fastpath_v1_same_line.cpuMs`   |
| **negative control:** block lexer alone over the full text | 2296.8 ms [2070-2979] | 2927.7 ms [2136-4437] | **0.97** [0.52-1.27]  | 5   | 9.3-17.4 | `bench/parse.ts` `lexer_probe_full_lex.cpuMs`    |
| worker boundary, full-text protocol, round trip per stream | 2434.0 ms             | 285.0 ms              | 8.5x                  | 1   | 9.3      | `bench/worker.ts` `proj-full.totalRoundTripMs`   |
| worker boundary, suffix protocol, round trip per stream    | 706.7 ms              | 268.6 ms              | 2.6x                  | 1   | 9.3      | `bench/worker.ts` `proj-suffix.totalRoundTripMs` |
| main thread post of the request payload (1667 deltas)      | 25.4 ms               | 15.5 ms               | 1.6x                  | 1   | 9.3      | `bench/worker.ts` `proj-full.totalPostMs`        |

**Why it was rejected.** The win is real and large - 27.5x on the core metric, every paired round
above 20x, far outside the control's 0.52-1.27 noise band - but the optimisation is not equivalent to
the full re-lex. Two independent cold reviews and my own probes reproduced three mechanisms:

1. **A construct that spans several blocks is completed by an append far below it.** A display math
   block is one `blockKatex` token only once its closing `$$` line arrives, and that token then
   starts above the blocks the previous text had: `"a\n\n$$\n# b\n\nc\n$$"` renders as one math block
   but the incremental path returned `["a\n\n", "$$\n", "# b\n\n", "c\n$$"]`. A GFM setext heading
   swallows the rule line above it: `"a\n***\nb\n==="`. The merge was measured to reach five blocks
   back, so no fixed lookback window can see it.
2. **An append destroys the construct a settled boundary was built on.** An empty ATX heading
   `"######"` completed to `"####### not a heading"` merges the heading into the paragraph above; a
   list marker completed by `")"` turns a paragraph into a loose list that absorbs the block above the
   blank line.
3. **A block raw is not a source offset**, so no region can be cut from one: the lexer normalises
   CRLF before lexing and a leading whitespace token belongs to no block, so both possible offset
   derivations duplicate blocks (`"  \na\n\na\n\nne"`, `"\r\n\r\n# H\r\n# H\r\nne"`).

(1) and (2) rule out trusting a settled boundary; (3) rules out deriving one from the raws. A
verified-boundary variant would need a tracked offset, i.e. a new field on the `Projection` the
worker posts, which the task forbids. The reproductions live in the equivalence suite
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
- **The `fastpath_v1_same_line` row is not a control.** That arm calls `project()` for its own
  fallbacks (`bench/parse.ts:24`, `:35`, `:40`), so the patch reaches it too. The negative control is
  the `lexer_probe_full_lex` row, which calls `stream()` only - a function this branch leaves
  byte-identical to the base (verified by diffing the function region).
- **`rawMismatches: 2` is not this change's doing.** It appears in every arm and every round of all
  runs, the baseline included, because `bench/parse.ts` is unchanged from the base commit and compares
  `project()` against its own fast path (`bench/parse.ts:120-137`) rather than against
  `stream(text, true)`. The two mismatches are the lexer's tail-whitespace normalisation. That check
  is therefore not an equivalence proof for this change; the suite in `packages/session-ui` is.
