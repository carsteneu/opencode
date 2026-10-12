# B2 (append provenance) measurement harness

Measures whether streamed-markdown parsing/rendering is still a material cost in
opencode v2 now that markdown parsing is off the main thread in the GUI
(`packages/session-ui/src/components/markdown.worker.ts`), and what an append
provenance port (B2: `fromLength`/`toLength` in the delta schema) would still buy.

Branch under test: `yesloop/v2-b2-measure` (HEAD `2d657da9f1`).
Comparison baseline: base commit `4617210822` (v2.0.26), pristine worktree
`.worktrees/baseline-66ecdd4` (`66ecdd4eb1` = base + chore).

## What is measured

| script | stage | notes |
| --- | --- | --- |
| `bench/parse.ts` | worker-side markdown projection (`project()` in `packages/session-ui/src/components/markdown-stream.ts`) | in-process, so worker CPU is measured exactly; current full re-lex vs v1's same-line append fast path |
| `bench/worker.ts` | worker boundary + round trip | real `Worker`s (`echo.worker.ts`, `proj.worker.ts`, `proj-provenance.worker.ts`); main-thread post cost, response handling, end-to-end latency |
| `packages/tui/bench/markdown.ts` | TUI markdown renderable (main thread) | real `MarkdownRenderable` from `@opentui/core` via `createTestRenderer`; `content` (full value) vs `contentUpdate = {content, appended}` |
| `packages/client/bench/store.ts` | client store write | baseline per-delta write vs this branch's (B3) coalesced flush |

The TUI does **not** use the session-ui worker: `packages/tui/src/routes/session/message-parts.tsx`
passes the full text as `content` to opentui's `<markdown>` element, on the main thread.
The worker serves the GUI (`packages/app`, `desktop`, `enterprise`). Both surfaces are measured.

## Method

- Workload: `bench/stream.ts` builds a deterministic markdown-heavy document
  (headings, prose, lists, fenced code, blockquotes), sliced into fixed-size deltas.
  Default `40000` chars / 24-char deltas / 1667 deltas.
- The host load average was 6.7-14 throughout (budget in the fork runbook is ≤ 4), so
  wall-clock numbers are unreliable. The primary metric is **CPU time**
  (`process.cpuUsage()` user+system) and, for arm comparisons, the **paired same-run ratio**.
- Repeats: 5-9 runs per arm in-process, or 20 paired single-run processes for the TUI arm
  (renderable construction state does not carry between runs there).
- Raw output: `<worktree>/.yesmem/tmp/`.

## Reproduce

```sh
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
bun install --frozen-lockfile

bun bench/parse.ts 40000 24 9
bun bench/worker.ts 40000 24 7
packages/tui/bench/markdown.ts 40000 24 1 content        # one arm, one process
packages/tui/bench/markdown.ts 40000 24 1 contentUpdate
bun packages/client/bench/store.ts 40000 24 7 20
```

## Results

See the scratchpad report for `yesloop-v2-b2measure`; raw runs in `.yesmem/tmp/`
(`parse.ndjson`, `worker.json`, `tui-markdown.ndjson`, `store.json`).

**All absolute ms figures below are UNVERIFIED.** The host load average was 6.1-14 throughout
(budget ≤ 4); re-runs of the same arms drifted 2-3.5x. Only the same-run paired ratios
reproduced. Treat the ratios as the finding and the ms figures as order-of-magnitude only.

Headline (40 KB stream, 1667 deltas, CPU time):

| arm / comparison | result | paired ratio (median, spread) |
| --- | --- | --- |
| session-ui worker parse, full re-lex per delta | ~2620-3440 ms UNVERIFIED | - |
| session-ui worker parse, same-line append fast path | ~615-800 ms UNVERIFIED | 0.2-0.3 (0.2..0.3) -> -77 % |
| worker request payload, main-thread post | ~55-122 ms UNVERIFIED | 0.32 (0.23..0.68) |
| worker round trip (worker CPU/latency, not main thread) | ~3140-24300 ms UNVERIFIED | 0.34 (0.28..0.48) |
| TUI markdown renderable, `content` | 527 ms median, range 318-1120 | - |
| TUI markdown renderable, `contentUpdate.appended` | 553 ms median, range 376-903 | 1.18 (0.46..1.72) -> no benefit |
| client store write, per delta (baseline) | 1.2 ms median, spread 0.4-2.6 | - |
| client store write, coalesced (B3) | 0.1 ms median | negligible either way |

Correctness of the fast-path arm: block structure mismatches 0, `src` mismatches 0,
`raw` mismatches 2 (a trailing newline the lexer synthesizes; harmless).

### Known limits (from the cold review)

- The fast-path arm's guards are load-bearing: `previous.text.endsWith("\n")` **and**
  `tail.raw.endsWith("\n")` must both hold, and the re-healed fragment must lex to exactly one
  block, otherwise the stable prefix is wrong. An earlier version of this harness guarded only on
  the first two and produced 7 wrong `src` values.
- The workload issues one projection request per delta and awaits every response. Production
  supersedes per key with latest-wins (`markdown-worker-queue.ts`), so the real request count is
  `<= deltas`; this is a worst case.
- The round-trip figure is worker CPU/latency, not a main-thread cost. The main-thread cost is the
  post arm.
- The harness response (`{blocks}`) is smaller than production's (`{projection}` = `{text, blocks}`),
  so the response side is under-measured.
- The TUI arm does not call `.render()`, so it measures markdown reconciliation, not frame
  rendering.
- 40 KB in one message is a stress case; a typical message of 1-4 KB pays roughly
  `(4/10)^2 = 4 %` of the 0-10 KB bucket because the cost grows quadratically with length.

