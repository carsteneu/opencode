# Branch `working` — State as of 2026-07-17

Consolidated branch containing all successful local patches on top of `dev` (`2faa228`).
Worktree: `.worktrees/working` · HEAD: `7e017ce` · 23 commits ahead of dev.

Purpose of the branch: a working, patched opencode build that addresses three classes of
upstream-open problems — **TUI flicker**, **high CPU load under streaming**, and **memory
leaks from non-deterministic SSE teardown**. It also contains the patched.47–57 binary
builds and the profiling infrastructure used to measure these patches.

The commits below are grouped by theme; within each group, ordering is chronological.
Build-artifact commits (`chore(opencode): build patched.N`) are only listed briefly at the
end, since they contain no logic changes.

---

## 1. SSE stability and deterministic teardown

**Root problem.** On session switches and disconnects, SSE listeners and queues leaked;
listener counters grew monotonically, causing memory leaks and rising CPU load from
orphaned handlers.

**`75ff364`** `fix(sse): deterministic teardown — disconnect detection, bounded queue, counters`
- 5 files, +151/−37. New: `sse-counters.ts`, `sse-disconnect.ts` (reworked),
  test `httpapi-sse-teardown.test.ts` (+100). Reliably detects disconnects, bounds
  queues, introduces listener counters for diagnostics.

**`7703203`** Merge `yesloop/sse-orphan-fix` — takes in `75ff364` and the accompanying
  handler changes (`event.ts`, `global.ts`).

**`c9d5600`** `fix(tui): dispose event.on subscriptions on unmount` (upstream PR #34616)
- 3 files (`app.tsx`, `prompt/index.tsx`, `routes/session/index.tsx`), +135/−117.
- TUI side of the same problem: `event.on` subscriptions were not released on unmount.
  All subscriptions are now disposed cleanly.

## 2. Windowed rendering and flicker fix

**Root problem.** Every streamed token re-rendered the entire message list — this caused
visible flicker and CPU spikes that, in long sessions, were the dominant load driver.

**`04f19c5`** `fix(tui): restore windowed message rendering + scroll-up history paging`
- `routes/session/index.tsx`, +62/−1. Restores windowed rendering: only the visible
  window is touched per frame. Additionally: scroll-up to the beginning of the history
  works again (was previously broken — the open regression from the end of session
  `ses_09d679f8`).

**`2f95b0a`** Merge `fix/loadolder-consumer-restore` — merge commit for `04f19c5`.

## 3. Partial-render fast path for the spinner

**Root problem.** The prompt spinner (Knight-Rider trail) ran on the full-frame path and
produced 30–60 full renders/s, just to animate a small rectangular area.

**`7721bd2`** `feat(tui): wire spinner to partial-render fast path`
- 3 files, +76/−4. New: `ui/partial-render.ts` (+61). The spinner is registered as
  partial-eligible and triggers only a partial re-render of its own area, no longer a
  full frame.

**`4a8190c`** `perf(tui): lower idle render cost — 30fps cap, 100ms spinner tick, precomputed spinner frames`
- 3 files (`app.tsx`, `prompt/index.tsx`, `ui/spinner.ts`), +41/−34. Idle CPU is reduced
  via a 30 fps cap, a 100 ms spinner tick, and precomputed frames.

**`2f6a3a5`** Merge `yesloop/spinner-partial-render`.

## 4. SSE delta batching (CPU bundle)

**Root problem.** Each incoming SSE delta triggered reactive cleanup work and re-renders.
On a typical model stream with several hundred deltas per second, this caused an
invalidation cascade that drove CPU to 80–110 % even on fast machines.

**`6771d26`** `feat: SSE delta batching in sync.tsx` (PR #36045)
- `context/sync.tsx`, +65/−27. Collects incoming deltas and flushes them in batches
  instead of passing each delta through the reactive pipeline individually.

**`243d1b6`** `feat: settle session status after stream end` (PR #36002)
- 4 files (`handlers/session.ts`, `run-state.ts`, 2 tests), +62/−17. Deterministically
  sets session status to "settled" after stream end, so that subsequent UI updates do
  not race against a pending state.

**`0162c3c`** `fix: pendingDeltas cleanup on part removal + disposal, fix indentation`
- `run-state.ts`, `sync.tsx`, +50/−47. Cleans `pendingDeltas` correctly on part removal
  and disposal; prevents batched deltas from running into the void.

**`86eca67`** `fix: normalize indentation in sync.tsx event handlers` — final cleanup
  of indentation in the handler blocks introduced in `6771d26`.

**`249e71b`** Merge `yesloop/pr-cpu-bundle` — bundles PR #36045 / #36002.

## 5. Child-process server refactor (streaming isolation)

**Root problem.** LLM streaming, TUI, and server ran in one process; the GC pressure of
the stream (large object trees, string concatenation) visibly burdened the TUI render
loop — the heap grew to ~700 MB per running opencode instance and drove CPU through GC
pauses. Solution: move LLM streaming into a separate worker process.

**`88072db`** `perf(tui): isolate streaming processes`
- 20 files, +751/−143. The **architecturally largest** commit in the branch. New files:
  - `packages/opencode/src/cli/tui/process-server.ts` (+164) — server scaffold for the
    child process (127.0.0.1, free port, readiness wait, auto-connect).
  - `packages/opencode/src/session/llm/ai-process-client.ts` (+146) — client side of
    LLM communication from the TUI to the worker.
  - `packages/opencode/src/session/llm/ai-process-worker.ts` (+135) — worker side;
    runs the LLM stream in isolation.
  - `packages/opencode/src/session/llm/ipc.ts` (+22) — IPC protocol.
  - `test/session/llm-process.test.ts` (+138) — test coverage for the new path.
- Accompanied by changes in `bootstrap.ts`, `cli/cmd/tui.ts` (−103, slimmed down),
  `session/llm.ts` (+57), `context/{data,sdk,sync}.tsx`, and `prompt/index.tsx`.
- **Caution — known regression driver:** This commit accidentally dropped the
  `createColors` import and the `ColorGenerator` function in `spinnerDef`. The
  consequence: the spinner was monochrome instead of a Knight-Rider gradient. Fixed in
  `7e017ce` (section 7).

## 6. LLM streaming coalesce

**`5eb15d7`** `perf(opencode): coalesce streaming deltas`
- 2 files (`session/llm.ts`, `test/session/llm-coalesce.test.ts`), +70/−1. Batching on
  the LLM side: several incoming deltas are combined into one flush before they enter
  the streaming pipeline. Further reduces the number of reactive updates, complementary
  to the SSE batching in section 4.

## 7. Shell output and spinner color gradient (v56 → v57)

**`56718c5`** `fix(tui): keep streaming shell output partial`
- `routes/session/index.tsx`, +15/−6. Shell output in the streaming tool was moved onto
  the partial-render path (instead of a full frame on every output update). This is the
  v56→v57 change.

**`7e017ce`** `fix(tui): restore knight rider spinner color gradient` (2026-07-17)
- `component/prompt/index.tsx`, +8/−2. Brings back `createColors` and wires
  `spinnerDef.color` back to the `ColorGenerator` function. Without the generator,
  `opentui-spinner` paints every character with the same RGBA — the trail collapses
  into a single-color block animation. Fixes the regression from `88072db`.

## 8. Tooling and build infrastructure

**`3686a04`** `sync: local patches from main workspace`
- 8 files, +134/−45. Collects smaller local patches: `targetFps` 30, spinner cache +
  100 ms interval, log rotation, SSE coalesce 100 ms, removal of `structuredClone`,
  `loadOlder`.

**`6b5e516`** `chore(opencode): add on-demand CPU profiling` — +26 in one file.
  Enables CPU profiles on keypress instead of always-on.

**`89325cf`** `chore(opencode): enable unminified profile builds` — allows readable
  profile builds (1-line change in the build script).

**`5bdc8fd`** `docs(tui): document patched 56 changes` — +457. Documentation of the
  patched.56 state.

**Build commits** (each a finished binary, no logic change):
`c6e169e` (.47), `240af19` (.48), `44f976d` (.47 baseline restore),
`2af5b3c` (.49 profile), `735d786` (.50), `968bf9f` (.51), `db0c451` (.52 debug),
`c58c615` (.53 debug), `c2e66bc` (.54 profile), `926d543` (.55 profile),
`4716241` (.56), `ddac4a3` (.57).

**Reverts** (intended rollbacks, each as a Feature → Revert pair in the history):
- `c4f3213` `perf: replace scroll polling with events` → reverted in `2170548` +
  `44f976d` (baseline reset to .47). The event-based variant degraded scroll-state
  detection; returned to the polling variant.
- `05aa560` `perf: buffer completed assistant messages` → reverted in `e87bc03`.
  The buffering optimized rendering of completed assistant messages but caused display
  issues; rolled back.

## Net effect

- **Flicker** eliminated — windowed rendering + partial-render path (sections 2, 3).
- **CPU significantly reduced** — SSE batching, LLM coalesce, streaming isolation into
  child process, 30 fps cap, 100 ms spinner tick (sections 4, 5, 6, 3).
- **Memory leaks closed** — deterministic SSE teardown, `event.on` disposal (section 1).
- **Spinner color gradient** restored (section 7, 2026-07-17).
- **Architecture:** LLM streaming runs isolated in its own worker process (section 5);
  this is the foundation for further tuning.

Current binary: **patched.57** (`ddac4a3`) **+ spinner fix** (`7e017ce`).

## Verified on 2026-07-17

`working` contains the complete successful code state. Cross-check against all other
worktrees:

- **`gc-pipeline`** (`ae5029e`): code-identical to `5eb15d7` in working — same diffstat
  (2 files, +70/−1), same patch content, different SHA only due to different parent.
  gc-pipeline does **not** contain the child-process server refactor from section 5;
  that is exclusive to working.
- **`yesloop-pr-cpu-bundle`**, **`yesloop-spinner-partial-render`**: 0 commits outside
  working.
- **`yesloop-tui-buffered-messages`** (`a1909dd`, `ed869de`): feature applied in working
  as `05aa560` and reverted as `e87bc03` — intended rollback.
- **`ab-bundle-merge`** (`f375f99`): merge artifact only; the substantive patch is in
  working via `249e71b`.
- **`yesresearch-opencode-pr-analyse`** (3 commits): pure documentation (research wiki
  under `yesdocs/`, ~850 lines of Markdown) — kept separate by design, no code commits.
