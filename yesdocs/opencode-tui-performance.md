# OpenCode TUI Performance and Stability Patch Set

Status: 2026-07-23

This document describes an unofficial performance and stability patch set for OpenCode and OpenTUI. The work
started with a practical problem: several OpenCode sessions could consume a surprising amount of CPU while text
was streaming, and long-running sessions could retain enough memory to affect the whole workstation.

The investigation found that terminal text output itself was not the main cost. A small text delta crossed
several reactive, parser, layout, rendering, event, and process boundaries. Some of those boundaries repeatedly
processed the complete accumulated value or the complete visible UI tree. The resulting allocation rate also
made JavaScriptCore garbage collection a major part of the observed CPU load.

The patch set removes work at those boundaries. It does not rely on reducing animation frequency as the main
solution.

## Release and source state

This is a community build, not an upstream OpenCode release.

| Component | Version or commit | Source |
| --- | --- | --- |
| Current public OpenCode prerelease | `1.18.4-patched.96` | [tag](https://github.com/carsteneu/opencode/tree/1.18.4-patched.96) |
| Previous public OpenCode prerelease | `1.18.4-patched.94`, commit `54b8c2495c035e978d2e3b3a69b6b760f36c79a0` | [tag](https://github.com/carsteneu/opencode/tree/1.18.4-patched.94) |
| Currently deployed OpenCode build | `1.18.4-patched.93`, commit `0112a57387a445e77a7b8568fd75466eb9be202d` | Local historical tag |
| OpenTUI renderer in all binary builds | OpenTUI 0.4.5 plus patches, commit `75f0721104b67027155dae967b44e67173b04756` | [tag](https://github.com/carsteneu/opentui/tree/opencode-1.18.4-patched.92) |
| Current public Linux binary | `.96`, x86_64, SHA-256 `e531925bf6205828e1caea3b4e46f29fa538864fe067a83dcfe446a6bbff2307` | [release](https://github.com/carsteneu/opencode/releases/tag/1.18.4-patched.96) |
| Currently deployed Linux binary | `.93`, x86_64, SHA-256 `4e4caeab4e85867306403aba3fcf313aaa54888c74b145149cbf04b0a2a9969e` | Locally verified |

At the `.94` release tag, the OpenCode branch was 51 commits ahead of its then-current `dev` base, commit
`0a601cf334b2cf5ac4e420cb2f3a4248b4414c17`. The focused diff is 58 files with 2,821 additions and 432
deletions. That includes 14 test files and 3 historical measurement documents. The separate OpenTUI fork
changes 28 files with 1,796 additions and 96 deletions relative to OpenTUI 0.4.5.

The `.93` follow-up adds one OpenCode fix and no OpenTUI changes. It preserves the request Effect context for
the delayed response-stream finalizer. Without that bridge, `opencode run` could generate and store a complete
model response, then exit with `InstanceRef not provided` while settling the session status. This broke
headless consumers such as the Telegram integration even though model execution itself had succeeded. The
installed `.93` binary completed an independent run against a local OpenAI-compatible test provider with exit
code 0 and no `InstanceRef` error. The provider transcript is a local validation artifact and is not included
in this repository.

The `.94` prerelease contains the same OpenCode runtime changes as `.93`, adds this performance report to the
tagged source, and rebuilds the Linux binary with the `.94` version identifier. It adds no further OpenTUI
changes.

The `.95` source boundary removes patch bodies from TUI-specific message hydration and private IPC events while
retaining file, status, addition, deletion, title, and body metadata. Full patches remain available through the
existing per-message diff endpoint. It also drops durable `sync` events before private IPC because the TUI
already ignored them. Provider requests, persisted session data, and Anthropic/OpenAI cache input remain
unchanged. `.95` is a source tag and has no separate binary release.

The `.96` prerelease merges the current upstream `dev` through the fork's `dev` branch, including 41 upstream
commits added after the `.94` base. Upstream still reports version 1.18.4, so the fork suffix advances without
changing package versions. The merge includes the upstream Mistral prompt-cache fixes and Mistral SDK 3.0.51.
The existing OpenTUI artifacts were hash-checked before and after dependency installation and remained
byte-identical.

## Results at a glance

The strongest end-to-end result comes from a controlled comparison with the official OpenCode 1.18.1 binary.
Both variants processed exactly 240 provider chunks and 18,960 text bytes in the same terminal, power profile,
and eight-second measurement window.

| Metric | Stock 1.18.1 | Patched `.89` | Reduction |
| --- | ---: | ---: | ---: |
| Task time, TUI plus local server | 40,040.53 ms | 19,560.13 ms | 51.1% |
| Mean aggregate CPU during the window | 500.5% | 244.5% | 51.1% |
| User cycles | 16.208 billion | 8.490 billion | 47.6% |
| Instructions | 15.845 billion | 9.305 billion | 41.3% |
| Instructions per text byte | 835,695 | 490,793 | 41.3% |

The later `.90` build added stable Markdown tail reconciliation, explicit append provenance, cheaper history
selection, and snapshot reuse. In a separate controlled workload in which 240 paragraphs became stable, a
comparison of stock OpenCode 1.18.1 with patched `.90` produced these results:

| Metric | Stock 1.18.1 | Patched `.90` | Reduction |
| --- | ---: | ---: | ---: |
| Task time | 28,858 ms | 20,817 ms | 27.9% |
| User cycles | 15.463 billion | 8.013 billion | 48.2% |
| Instructions | 14.990 billion | 7.905 billion | 47.3% |

These two workloads are different. Their percentages must not be added or treated as measurements of the same
thing. The `.92`, `.93`, and `.94` builds retain these optimizations, but there is no controlled comparison of
these builds with stock OpenCode 1.18.4 yet.

An operational Atop sample also showed a large improvement after the `.92` deployment:

| Field sample in balanced power mode | Patched `.91` | Patched `.92` |
| --- | ---: | ---: |
| Idle sessions | 4 | 4 |
| Observation length | 60 minutes | 7 minutes |
| Mean CPU per session | 65.65% | 2.62% |
| Median CPU per session | 51.86% | 2.53% |
| Relative change in the mean |  | 96.0% lower |

Here, 100% means one fully occupied logical CPU core. The `.92` field window is much shorter. The active-session
samples also performed different work, so those data are useful operational evidence, not a controlled causal
benchmark. The active `.91` process tree averaged 179.20% over 20 full one-minute intervals. The raw `.92`
process tree averaged 15.98% over three intervals. Correcting for the worker being active for only 92 of 180
seconds and subtracting the idle baseline gives a duration-normalized `.92` estimate of 28.76%, or 83.9% lower.
This active result should be treated as directional.

## Measurement method

The controlled stock comparison used:

- An isolated 156 by 65 cell `tmux` terminal.
- An empty project and a fresh session for every run.
- Isolated `HOME` and XDG directories.
- `--pure`, so external plugins were excluded.
- A local OpenAI-compatible provider with a deterministic response.
- Exactly 240 chunks, 18,960 text bytes, and 25 ms between chunks for the growing-paragraph workload.
- An eight-second `perf stat` window beginning at the confirmed normal provider turn.
- Three fresh sessions per variant, reported as the median.
- TUI and local server CPU added for the patched build because stock 1.18.1 kept both in one process.
- The fake provider measured separately and excluded from both product totals.
- The same `power-saver` profile for both arms.

The provider control executed 46.95 million instructions for stock and 47.96 million for the patched arm, a
2.2% difference. This makes provider work unlikely to explain the measured product gap.

The `task-clock` value can exceed eight seconds because it sums CPU time across the main thread and parallel JSC
helper threads. For the same reason, aggregate CPU can exceed 100%. Instructions are especially useful here
because they are less sensitive than wall time to clock frequency and scheduling.

The Atop field sample used `/var/log/atop/atop_20260722` at 60-second resolution. Each session total includes
its TUI, local server, and AI worker when present. Both `.91` and `.92` samples used the `balanced` profile. The
raw Atop archive is a local operational artifact and is not included in this repository.

## Patch map

| Repository | Main responsibilities in this patch set |
| --- | --- |
| OpenCode | Process separation, worker lifecycle, model and UI delta coalescing, append provenance, private IPC events, bounded public SSE, windowed messages, history paging, step-boundary reuse, lazy startup services, logging, and profiling support |
| OpenTUI | Retained partial rendering, native dirty-region diffing, render-list reuse, generation guards, incremental Markdown and native text appends, same-line layout safety, highlight coalescing, and scrollbar event composition |

OpenCode decides when data can be batched, when an update is a proven append, and how much session history is
active. OpenTUI uses that information to avoid parser, layout, tree-walk, buffer, and terminal work. The measured
end-to-end gains come from both repositories together.

## What was actually expensive

### 1. Full-value work on growing text

Streaming did not stop at appending a few new characters. Multiple layers received or reconstructed the full
accumulated string. Prefix checks, trimming, token creation, inline lexing, highlighting, styled text creation,
and native buffer updates could therefore revisit old content after each delta.

For a paragraph that grows to length `n` through many small updates, repeated linear work can approach
quadratic total work. String ropes can delay some copies, but parsing, UTF-8 encoding, and native calls still
have to traverse or materialize the value.

An independent parser test made this cost visible. It ran 5,000 one-character updates in fresh Bun processes:

| Parser path | Median CPU time | Allocation-triggered GC |
| --- | ---: | ---: |
| Full growing paragraph | 4,515 ms | 3 of 3 runs at about 29.6 MB |
| New-character control | 134 ms | 0 of 3 runs |
| Patched plain-prose append path | 129 ms | 0 of 3 runs |

The 97.1% reduction in median parser CPU time applies to this synthetic plain-prose hotspot, not to the entire
application. Complex Markdown still takes the conservative parser path.

An earlier uninstrumented live comparison showed the product effect of replacing full native text-buffer
updates with verified appends. Normal Markdown streaming fell from about 47.8% to 27.8% of one CPU core under
the same `power-saver` setup. At paragraph boundaries, replaying the captured update sequence fell from 54.9 ms
to 4.9 ms, a 91% reduction, while producing the same tokens as a complete Marked parse.

The final implementation addresses this at several levels:

- OpenCode batches part-field deltas for 50 ms before updating the Solid store.
- OpenCode records only `{ fromLength, toLength, revision }` as append provenance.
- OpenTUI accepts an append hint only when the revision and both lengths prove an exact continuation.
- Any removal, replacement, stale revision, or incompatible update falls back to the complete-value path.
- OpenTUI reuses the stable Markdown block prefix and reconciles only the unstable tail.
- Safe plain prose can extend its final inline token without lexing the complete paragraph again.
- Completed text and reasoning parts leave streaming mode, so their final structure becomes stable.

A benchmark with 500 stable Markdown blocks and 500 appends reduced median update time from 1,779.8 to 682.3
microseconds, a 61.7% reduction. Supplying verified append provenance reduced update time by about 27% with
2,000 existing blocks and by about 9% with 500 blocks. The scaling is consistent with avoiding a prefix scan.

Relevant code:

- `packages/tui/src/context/sync.tsx`
- `packages/tui/src/routes/session/index.tsx`
- OpenTUI `packages/core/src/renderables/Markdown.ts`
- OpenTUI `packages/core/src/renderables/markdown-parser.ts`

### 2. False layout invalidation forced full frames

The original same-line streaming path avoided a synchronous Yoga layout invalidation, but asynchronous syntax
highlight completion called `updateTextInfo()` without an argument. Its default meant `layoutChanged = true`.
That marked Yoga dirty even when the text stayed on the same line and its dimensions did not change.

OpenTUI treats a dirty root layout as unsafe for partial rendering. It therefore recalculated layout, walked the
root tree, redrew the visible interface, and performed a complete frame presentation.

Temporary frame counters showed a stable causal fingerprint across several builds:

- About 10.5 partial frames per second, matching the spinner cadence.
- About 5.3 to 5.5 full frames per second, matching the worker's 200 ms delta cadence.
- Between 84% and 94% of full frames were rejected partial frames caused by `layoutDirty`.

An isolated intervention changed only the argumentless layout update. With 100 static nodes and 400 same-line
updates, the original path used a median 2,438 ms of CPU time and reserved 27.36 MB of additional heap capacity.
The layout-clean control used 1,296 ms of CPU time and 5.10 MB. After the fix, the production class and control
converged to 1,722 ms and 1,667 ms of CPU time, with identical 7.26 MB of additional reserved heap capacity and
no allocation-triggered GC in either arm.

The production fix compares dimensions after both synchronous and asynchronous buffer changes. Real line,
wrap, width, or height changes still dirty layout. Same-line updates remain eligible for partial rendering.

Relevant OpenTUI code:

- `packages/core/src/renderables/Code.ts`
- `packages/core/src/renderables/TextBufferRenderable.ts`
- `packages/core/src/renderables/Text.ts`

### 3. Partial rendering still copied and diffed the full screen

The first correct partial renderer restored the complete committed framebuffer before drawing a changed
renderable. This was necessary because the next buffer had been cleared after presentation, but it made every
spinner frame proportional to terminal area.

Profiles showed the full-buffer copy as a leading TUI hotspot. Native measurements later showed that comparing
cells and writing a few ANSI sequences was relatively cheap. Most per-frame cost happened before the native
partial call.

The patched OpenTUI renderer now retains the committed buffer and computes a bounded dirty rectangle from the
changed renderables. It restores ancestor opacity and clipping rules, expands for wide-character boundaries,
and asks the Zig renderer to diff only that region. It falls back to a full frame when layout, overlays, debug
state, palette changes, destroyed nodes, culling, or commit uncertainty make a partial frame unsafe.

The native proof test changes two cells but commits a one-cell region. The first partial commit reports exactly
one changed cell, the second change remains pending, and the following full commit applies it. A TypeScript test
also proves that partial rendering no longer performs the former full-buffer copy.

Other renderer changes include:

- Cached render-list reuse when structure, layout, and viewport state are unchanged.
- O(1) generation checks instead of scanning the visible tree for unrelated dirty nodes.
- Coalesced normal and partial render requests.
- Partial eligibility for streaming Markdown, code, shell output, and spinners.
- An unchanged-text fast path before styled text conversion.
- At most one in-flight streaming highlight, followed by one update for the newest content.

Execution time in the isolated `scrollbox_viewport_culling` benchmark fell from 0.303 ms to 0.082 ms, about 73%
lower. Other scenarios in that microbenchmark remained within noise.

Relevant OpenTUI code:

- `packages/core/src/Renderable.ts`
- `packages/core/src/renderer.ts`
- `packages/core/src/zig/renderer.zig`
- `packages/core/src/renderables/Code.ts`
- `packages/core/src/renderables/ScrollBox.ts`

### 4. Event delivery repeated scheduler and encoding work

The isolated AI worker already combines adjacent text and reasoning deltas for at most 200 ms. The server then
placed those already-grouped events into another 16 ms Effect grouping stage. This added a queue, scheduler
fiber, and timer without reducing event count. The worker path now skips that second grouping. In-process
provider streams retain the 16 ms and 64-item grouping because they have not already been coalesced.

The original local TUI path also sent private server events back to its parent through the public HTTP SSE
stack. A controlled two-process replay delivered 50 events at their real 200 ms spacing. The server used about
2.07 additional CPU-seconds over ten wall-clock seconds when an external SSE client was present, equivalent to
20.7 percentage points of average CPU utilization. An open but eventless connection added only about 0.22
CPU-seconds. The cost was event delivery, not merely keeping the connection open.

Private TUI server events now use the existing process IPC channel. Public SSE remains available for external
clients. Its lifecycle was hardened with:

- Deterministic disconnect detection.
- Scoped listener finalizers.
- Bounded queues with a capacity of 8,192 events.
- Reconnect and resynchronization after overflow.
- Active stream and listener counters for diagnostics.
- TUI subscription disposal during unmount and reload.

These changes close the observed paths by which stale clients retained listeners, queues, timers, and event
work after a session restart.

Relevant OpenCode code:

- `packages/opencode/src/cli/tui/process-server.ts`
- `packages/opencode/src/server/routes/instance/httpapi/sse-disconnect.ts`
- `packages/opencode/src/server/routes/instance/httpapi/sse-counters.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`
- `packages/opencode/src/session/llm.ts`

### 5. Long-lived heaps amplified allocation cost

Profiles showed that the remaining peak was often JavaScriptCore heap work rather than native terminal output.
In one balanced-power profile, only 5.35% of user cycles belonged to the native OpenTUI library. JSC work took
67.67% in the main thread and 21.55% in HeapHelper threads. Large self-costs appeared in marking, end-phase,
weak-map constraints, and function finalization.

Heap snapshots showed that 99.4% of the `FunctionExecutable` objects present in the later heap snapshot already
existed before the first prompt. Streaming was triggering collections over a large startup graph rather than
creating that graph from scratch.

The patch set attacks both lifetime and startup size:

- The visible TUI, local server, and supported model provider work run in separate processes.
- AI workers are short-lived, so their heap is returned to the operating system when a provider turn ends.
- The plugin compiler is loaded only when an external TUI plugin actually needs it.
- The TUI uses the direct node layer instead of loading a broader location service graph.
- Model catalog parsing is lazy.
- Child processes inherit the environment directly when no overrides are needed.
- A harmful inherited `BUN_JSC_forceRAMSize` value is removed from local server children.

The plugin compiler change had three independent measurements:

| Measurement | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Unminified plugin-host chunk | 3,696,602 bytes | 188,149 bytes | 94.9% |
| Cold TUI heap self size | 101,099,428 bytes | 92,683,361 bytes | 8.3% |
| Cold TUI `FunctionExecutable` count | 44,829 | 39,487 | 11.9% |

With a deterministic provider and two builds that differed only in the lazy-import change, TUI task time fell
by 20.9%, user cycles by 22.9%, and instructions by 19.8%. The unchanged server process differed by 4.5%, which
is treated as control variation rather than a server improvement.

Replacing the generic application builder with the direct node layer reduced the static import boundary from
2,506 modules and 15,860,117 JavaScript bytes to 483 modules and 3,889,740 bytes. In a simultaneous attach to
the same running server, task time fell by 65.9% and instructions by 68.4%. This is primarily a startup and
attach result, not a claim about every streaming window.

Process isolation is not a guarantee that summed CPU or RAM always decreases. Its direct benefits are better UI
responsiveness, independent garbage collection, clearer attribution, and deterministic heap release when a
worker exits. OpenTelemetry-enabled runs, unsupported providers, nonserializable provider options, and
explicitly disabled isolation use the original in-process AI SDK path.

Relevant OpenCode code:

- `packages/opencode/src/cli/cmd/tui.ts`
- `packages/opencode/src/cli/tui/process-server.ts`
- `packages/opencode/src/session/llm/ai-process-client.ts`
- `packages/opencode/src/session/llm/ai-process-worker.ts`
- `packages/opencode/src/session/llm/ipc.ts`
- `packages/opencode/src/plugin/tui/runtime.ts`
- `packages/opencode/src/cli/tui/layer.ts`
- `packages/core/src/models-dev.ts`

### 6. Long histories made every frame and update more expensive

The TUI previously allowed long sessions to mount and retain too much history at once. The patched TUI renders
the most recent messages through a window ladder of 10, 30, 50, and 100 items. Scrolling upward expands the
window while preserving the anchor. When scrolling reaches the oldest hydrated history, the TUI requests
another 50 messages with cursor pagination and deduplication. Returning to the bottom shrinks the active window
again.

The final implementation uses real scrollbar change events. An earlier attempt failed because OpenTUI replaced
the application callback with its internal sticky-scroll handler. The fork now composes both callbacks and
supports reactive option updates, so the old 150 ms polling loop is no longer required.

This bounds the active render tree for normal use. It is not a universal RSS ceiling because the synchronized
session store and other caches can still retain data.

Relevant code:

- `packages/tui/src/routes/session/index.tsx`
- `packages/tui/src/context/sync.tsx`
- OpenTUI `packages/core/src/renderables/ScrollBar.ts`
- OpenTUI `packages/core/src/renderables/ScrollBox.ts`

### 7. Tool and provider step boundaries repeated expensive work

After streaming became cheaper, short CPU peaks remained around tool and provider boundaries. Two concrete
causes were removed.

First, compacted-history selection materialized the entire session even when the relevant boundary was in the
newest page. It now scans newest-first in pages of 50 and stops at the exact boundary. A real database test with
120 old messages produced byte-identical selected-history output. The paged path took 24.57 to 30.30 ms, while
the exhaustive path took 63.68 to 67.46 ms, a local reduction of 52% to 64%.

Second, snapshot tracking had already produced an immutable target tree, but the subsequent diff step captured
the current index again. The new API diffs the completed target tree directly against the source tree. A
correctness test changes a file after the target snapshot and proves that the later change is excluded. The
tree-to-tree path took 187.26 to 190.42 ms, while the old current-index path took 235.58 to 286.17 ms, a local
reduction of 20.5% to 33.5%.

These are boundary costs. Their effect on a complete session depends on history size, repository size, and tool
frequency. They are not included as universal streaming percentages.

Relevant OpenCode code:

- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/snapshot/index.ts`

### 8. Stability work removed background and retention hazards

The patch set also includes changes whose primary goal is predictable long-running behavior:

- Session state is explicitly settled after a stream ends, preventing a stale busy state and spinner.
- Pending UI deltas are removed when a part is removed, a session is disposed, or synchronization restarts.
- Published part snapshots are shallow copies so later mutation cannot corrupt prior events.
- Invalid UTF-16 surrogate repair uses a cheap precheck before the expensive regular expression.
- On startup, logs larger than 10 MiB rotate. Up to five rotated archives are retained in addition to the current
  log. A single process can exceed the limit before its next restart.
- The logging batch window is never zero because a zero-duration loop caused idle CPU work.
- CPU profiling is opt-in through signals and is absent from normal rendering hot paths.

Temporary per-frame logging was intentionally removed. In one experiment it increased the CPU use of a static
TUI from about 26.3% to 85.4%. It was useful for causal frame counts, but its absolute CPU readings were not used
for quantitative performance conclusions.

## Provider requests, tools, and cache behavior

Rendering optimizations happen after provider output starts, so UI batching and Markdown reconciliation cannot
change the prompt sent to OpenAI or Anthropic.

For the isolated worker path, OpenCode sends the already transformed messages, provider options, headers, active
tool names, tool choice, and tool schemas over IPC. The worker reconstructs the matching AI SDK provider and
executes tools in the parent process. Tests verify exact streamed-text round-tripping in the covered test cases,
parent-side tool execution, binary IPC values, error transport, and abort cleanup.

The design preserves message and tool order through the process boundary. This work did not include a universal
byte-for-byte capture of final HTTP request bodies for every provider and SDK version, so this document does not
claim that stronger property. Provider-specific cache telemetry should be used if exact cache equivalence needs
to be demonstrated for a particular API. OpenAI and Anthropic requests that do not meet the isolation safety
checks continue through the original in-process path.

## Changes that were tested and rejected

Several plausible ideas either did not help or made the product worse:

| Experiment | Result | Decision |
| --- | --- | --- |
| In an earlier build, increase the UI delta window from 100 ms to 250 ms | No repeatable CPU gain and visibly less fluid output | Rejected |
| Cache completed assistant message JSX | No measurable gain across empty, 2-message, and 10-message histories | Reverted |
| Batch eight spinner character calls into one native call | 73% faster microbenchmark, but only 1.7 percentage points of CPU utilization in a noisy live test | Removed |
| Cache arrays in the partial renderer | Passed tests but did not lower real CPU | Removed |
| Disable JSC activity-timer garbage collection | About 7% more instructions per stream byte | Rejected |
| Reduce SQLite page cache from 64 MiB to 16 MiB | About 3 MiB lower process RSS in history paging, but about 40% slower | Rejected |
| Force SQLite `mmap_size=0` | It was already zero in both SQLite clients | No change |

The target frame rate was reduced from 60 to 30 and spinner frames are precomputed. These are useful baseline
controls, but they are not presented as the root-cause fix. Most of the measured improvement comes from removing
repeated parsing, layout, rendering, scheduling, and heap work.

## Correctness boundaries

The faster paths are deliberately narrow:

- Markdown append logic falls back for headings, lists, tables, HTML, code, style changes, replacements, and
  ambiguous prefixes.
- Native text append requires append-only, default-styled content.
- Partial rendering falls back for layout changes, overlays, debug capture, forced repaint, palette changes,
  native commit uncertainty, destroyed renderables, and culling changes.
- History paging preserves the visible scroll anchor and deduplicates server pages.
- AI process isolation requires a supported provider package and serializable provider configuration.
- Tools remain in the parent process, preserving access to the existing runtime and permission context.
- Public SSE remains available even though the private local TUI path uses IPC.

These fallbacks explain why a single growing paragraph, a multi-block Markdown response, a tool-heavy agent
run, and an idle session show different gains.

## Validation

Validation recorded for the release included:

- Full pre-push typecheck: 30 of 30 tasks successful.
- OpenCode targeted tests: 485 passed and 1 skipped.
- TUI targeted tests: 24 passed.
- OpenTUI Core targeted tests: 202 passed.
- OpenTUI Solid integration: 1 passed.
- Native Zig tests: 1,696 passed and 6 skipped.
- Linux x86_64 binary smoke test and version check.

A later read-only audit at the tagged OpenTUI commit ran a broader focused set with 493 passed, 1 skipped, 0
failed, 128 snapshots, and 1,650 assertions across seven files. The Solid Markdown content-update integration
also passed.

Tests cover append provenance, stale revision fallback, Markdown token equivalence, asynchronous highlighting,
partial commit guards, native dirty-region behavior, scrollbar callback composition, SSE teardown, history
pagination, snapshot boundaries, worker abort, and tool execution across IPC.

The `.93` follow-up additionally passed focused subprocess, HTTP session-settlement, and Effect-context tests,
plus the package typecheck. The built artifact passed its version smoke test, was byte-compared with the
installed binary, and completed the independent local-provider run described above.

The `.96` integration passed typechecks for OpenCode, TUI, Core, and LLM. Its focused validation included 418
OpenCode tests, 22 TUI tests, and 4 Mistral SDK patch tests with no failures. The Linux x86_64 binary passed its
embedded version smoke test and reports `1.18.4-patched.96`.

## Packaging and reproducibility caveat

The `.92`, `.93`, `.94`, and `.96` binaries contain the patched OpenTUI Core JavaScript, Solid integration, and
matching native `libopentui.so`.

The OpenCode lockfile still names the released OpenTUI 0.4.5 packages. A fresh `bun install` therefore resolves
stock OpenTUI 0.4.5, not the fork commit. Reproducing the measured renderer requires building the tagged OpenTUI
fork, placing its matching JavaScript and native artifacts into the OpenCode dependency tree, and then building
OpenCode without reinstalling those dependencies.

The repository now includes a guarded synchronization command for that overlay step:

```sh
bun run script/sync-opentui-overlay.ts --source=/path/to/opentui --apply
bun run script/sync-opentui-overlay.ts --source=/path/to/opentui --check
```

The command requires the OpenTUI checkout to be clean and exactly at the tagged commit. It verifies the complete
Core, Solid, and Linux x64 native artifact trees against pinned hashes, checks that the installed dependency slot
is still OpenTUI 0.4.5, and replaces only the current worktree's Bun store targets. The tagged OpenTUI artifacts
must still be built first. Build OpenCode with `--skip-install` afterward so dependency installation cannot replace
the verified overlay.

The native ABI also changed for partial-region rendering. Patched JavaScript and the matching native library
must be distributed together for every platform. The release currently provides only the tested Linux x86_64
asset.

## Limits of the conclusions

- The strongest controlled stock comparisons use OpenCode 1.18.1 and patched `.89` or `.90`, not stock 1.18.4
  and patched `.92`, `.93`, `.94`, or `.96`.
- The `.91` to `.92` Atop comparison is observational. The idle sample lengths differ, and the active workloads
  were not matched.
- CPU varies with provider chunk rate, response structure, terminal dimensions, visible tools, session length,
  background activity, and power profile.
- Microbenchmarks prove specific costs and code paths. Their percentages are not whole-application speedups.
- Process isolation improves lifetime and responsiveness but can add IPC overhead and does not guarantee lower
  aggregate resource use in every workload.
- Windowed rendering limits the mounted UI tree, not every in-memory representation of session history.

## Historical records

The following documents contain the original measurements and intermediate decisions:

- [Patched `.90` controlled results](./tui-performance-patched-90.md)
- [Patched `.56` architecture and profiling record](./opencode-tui-patched-56.md)
- [Initial CPU investigation and candidate ranking](./tui-cpu-hebel.md)

Some lower-level command transcripts and the full investigation journal remain local operational records. The
published historical documents above retain the methods, aggregate results, and decisions used by this report.

The current prerelease is available at
[OpenCode 1.18.4-patched.96](https://github.com/carsteneu/opencode/releases/tag/1.18.4-patched.96). The renderer
source is preserved in the
[OpenTUI `opencode-1.18.4-patched.92` tag](https://github.com/carsteneu/opentui/tree/opencode-1.18.4-patched.92).
The `.93` OpenCode follow-up remains the currently deployed binary. `.96` adds the TUI history payload reduction
and the current upstream integration to the public patch set.
