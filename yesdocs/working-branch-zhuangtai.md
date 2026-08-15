# `working` 分支 —— 2026-07-17 状态

合并分支，包含所有成功的本地补丁，基于 `dev`（`2faa228`）。
工作树：`.worktrees/working` · HEAD：`7e017ce` · 领先 dev 23 个提交。

分支目的：一个可运行的、打过补丁的 opencode 版本，解决三类上游尚未解决的问
题——**TUI 闪烁**、**流式传输下的高 CPU 负载**，以及**非确定性 SSE 拆除导致的内存
泄漏**。同时包含 patched.47–57 的二进制构建，以及用于衡量这些补丁的性能分析基础
设施。

下面的提交按主题分组；每组内部按时间顺序排列。构建产物提交（`chore(opencode):
build patched.N`）只在末尾简短列出，因为它们不包含逻辑变更。

---

## 1. SSE 稳定性与确定性拆除

**根本问题。** 在会话切换和断开连接时，SSE 监听器和队列会残留；监听器计数单调
增长，导致内存泄漏，以及由孤儿 handler 引发的持续上升的 CPU 负载。

**`75ff364`** `fix(sse): deterministic teardown — disconnect detection, bounded queue, counters`
- 5 个文件，+151/−37。新增：`sse-counters.ts`、`sse-disconnect.ts`（重写）、
  测试 `httpapi-sse-teardown.test.ts`（+100）。可靠地检测断连、约束队列、引入
  监听器计数用于诊断。

**`7703203`** 合并 `yesloop/sse-orphan-fix` —— 纳入 `75ff364` 及配套的 handler
  变更（`event.ts`、`global.ts`）。

**`c9d5600`** `fix(tui): dispose event.on subscriptions on unmount`（上游 PR #34616）
- 3 个文件（`app.tsx`、`prompt/index.tsx`、`routes/session/index.tsx`），+135/−117。
- 同一问题的 TUI 侧：`event.on` 订阅在卸载时未被释放。现在所有订阅都被干净地
  dispose。

## 2. 窗口化渲染与闪烁修复

**根本问题。** 每一个流式 token 都会触发整个消息列表的重新渲染——这造成可见的
闪烁和 CPU 峰值，在长会话中是负载的主要驱动因素。

**`04f19c5`** `fix(tui): restore windowed message rendering + scroll-up history paging`
- `routes/session/index.tsx`，+62/−1。恢复窗口化渲染：每帧只触碰可见窗口。此
  外：向上滚动到历史记录开头重新可用（此前是坏的——就是会话 `ses_09d679f8` 末
  尾那个悬而未决的回归）。

**`2f95b0a`** 合并 `fix/loadolder-consumer-restore` —— `04f19c5` 的合并提交。

## 3. Spinner 的局部渲染快速路径

**根本问题。** 提示 spinner（Knight-Rider 拖尾）运行在全帧路径上，每秒产生 30–60
次完整渲染，只为了动画化一小块矩形区域。

**`7721bd2`** `feat(tui): wire spinner to partial-render fast path`
- 3 个文件，+76/−4。新增：`ui/partial-render.ts`（+61）。spinner 被注册为
  partial-eligible，只触发对其自身区域的局部重渲染，不再触发全帧。

**`4a8190c`** `perf(tui): lower idle render cost — 30fps cap, 100ms spinner tick, precomputed spinner frames`
- 3 个文件（`app.tsx`、`prompt/index.tsx`、`ui/spinner.ts`），+41/−34。通过 30 fps
  上限、100 ms spinner tick 和预计算帧来降低 idle CPU。

**`2f6a3a5`** 合并 `yesloop/spinner-partial-render`。

## 4. SSE 增量批处理（CPU 套件）

**根本问题。** 每个传入的 SSE 增量都触发响应式清理工作和重渲染。在一个典型的模
型流上，每秒数百个增量，这引发级联失效，在快速机器上也把 CPU 推到 80–110%。

**`6771d26`** `feat: SSE delta batching in sync.tsx`（PR #36045）
- `context/sync.tsx`，+65/−27。收集传入的增量，批量 flush，而不是把每个增量单
  独穿过响应式管道。

**`243d1b6`** `feat: settle session status after stream end`（PR #36002）
- 4 个文件（`handlers/session.ts`、`run-state.ts`、2 个测试），+62/−17。在流结
  束后确定性地把会话状态置为 "settled"，让后续 UI 更新不会与悬空状态竞争。

**`0162c3c`** `fix: pendingDeltas cleanup on part removal + disposal, fix indentation`
- `run-state.ts`、`sync.tsx`，+50/−47。在部件移除和 dispose 时正确清理
  `pendingDeltas`；防止批量增量落空。

**`86eca67`** `fix: normalize indentation in sync.tsx event handlers` —— 对
  `6771d26` 引入的 handler 块的最终缩进清理。

**`249e71b`** 合并 `yesloop/pr-cpu-bundle` —— 汇总 PR #36045 / #36002。

## 5. 子进程服务器重构（流式隔离）

**根本问题。** LLM 流式传输、TUI 和服务器运行在同一进程内；流的 GC 压力（大对
象树、字符串拼接）明显加重了 TUI 渲染循环的负担——每个运行中的 opencode 实例
的堆增长到约 700 MB，并通过 GC 停顿推高 CPU。解决方案：把 LLM 流式传输移到独立
的 worker 进程中。

**`88072db`** `perf(tui): isolate streaming processes`
- 20 个文件，+751/−143。本分支中**架构上最大**的提交。新文件：
  - `packages/opencode/src/cli/tui/process-server.ts`（+164）—— 子进程的服务器
    骨架（127.0.0.1、空闲端口、就绪等待、自动连接）。
  - `packages/opencode/src/session/llm/ai-process-client.ts`（+146）—— 从 TUI 到
    worker 的 LLM 通信客户端侧。
  - `packages/opencode/src/session/llm/ai-process-worker.ts`（+135）—— worker 侧；
    隔离运行 LLM 流。
  - `packages/opencode/src/session/llm/ipc.ts`（+22）—— IPC 协议。
  - `test/session/llm-process.test.ts`（+138）—— 新路径的测试覆盖。
- 附带 `bootstrap.ts`、`cli/cmd/tui.ts`（−103，精简）、`session/llm.ts`（+57）、
  `context/{data,sdk,sync}.tsx`、`prompt/index.tsx` 的修改。
- **注意——已知的回归源：** 此提交意外删除了 `createColors` 导入以及
  `spinnerDef` 中的 `ColorGenerator` 函数。后果：spinner 变成单色，而不是
  Knight-Rider 渐变。已在 `7e017ce`（第 7 节）修复。

## 6. LLM 流式合并

**`5eb15d7`** `perf(opencode): coalesce streaming deltas`
- 2 个文件（`session/llm.ts`、`test/session/llm-coalesce.test.ts`），+70/−1。LLM
  侧的批处理：多个传入增量在进入流式管道前合并为一次 flush。进一步减少响应式
  更新数量，与第 4 节的 SSE 批处理互补。

## 7. Shell 输出与 spinner 颜色渐变（v56 → v57）

**`56718c5`** `fix(tui): keep streaming shell output partial`
- `routes/session/index.tsx`，+15/−6。流式工具中的 shell 输出被移到局部渲染路径
  （而不是每次输出更新都全帧）。这就是 v56→v57 的变更。

**`7e017ce`** `fix(tui): restore knight rider spinner color gradient`（2026-07-17）
- `component/prompt/index.tsx`，+8/−2。带回 `createColors` 并把 `spinnerDef.color`
  重新接到 `ColorGenerator` 函数。没有这个生成器，`opentui-spinner` 会用同一个
  RGBA 画每一个字符——拖尾塌缩为单色块动画。修复 `88072db` 的回归。

## 8. 工具与构建基础设施

**`3686a04`** `sync: local patches from main workspace`
- 8 个文件，+134/−45。汇集较小的本地补丁：`targetFps` 30、spinner 缓存 + 100 ms
  间隔、日志轮转、SSE 合并 100 ms、移除 `structuredClone`、`loadOlder`。

**`6b5e516`** `chore(opencode): add on-demand CPU profiling` —— 一个文件 +26。
  按键触发 CPU profile，而不是常开。

**`89325cf`** `chore(opencode): enable unminified profile builds` —— 允许可读的
  profile 构建（构建脚本中 1 行变更）。

**`5bdc8fd`** `docs(tui): document patched 56 changes` —— +457。patched.56 状态
  的文档。

**构建提交**（每个都是一份完成的二进制，无逻辑变更）：
`c6e169e`（.47）、`240af19`（.48）、`44f976d`（.47 baseline 恢复）、
`2af5b3c`（.49 profile）、`735d786`（.50）、`968bf9f`（.51）、`db0c451`（.52
debug）、`c58c615`（.53 debug）、`c2e66bc`（.54 profile）、`926d543`（.55
profile）、`4716241`（.56）、`ddac4a3`（.57）。

**回退**（有意的撤回，历史中每个都是"特性 → 回退"成对出现）：
- `c4f3213` `perf: replace scroll polling with events` → 在 `2170548` +
  `44f976d`（baseline 重置到 .47）中回退。基于事件的变体降低了滚动状态检测的
  质量；回到轮询变体。
- `05aa560` `perf: buffer completed assistant messages` → 在 `e87bc03` 中回退。
  该缓冲优化了已完成 assistant 消息的渲染，但导致显示问题；撤回。

## 净效果

- **闪烁**消除 —— 窗口化渲染 + 局部渲染路径（第 2、3 节）。
- **CPU 明显下降** —— SSE 批处理、LLM 合并、流式隔离到子进程、30 fps 上限、
  100 ms spinner tick（第 4、5、6、3 节）。
- **内存泄漏关闭** —— 确定性 SSE 拆除、`event.on` dispose（第 1 节）。
- **spinner 颜色渐变**恢复（第 7 节，2026-07-17）。
- **架构：** LLM 流式在其独立的 worker 进程中运行（第 5 节）；这是后续进一步调
  优的基础。

当前二进制：**patched.57**（`ddac4a3`）**+ spinner 修复**（`7e017ce`）。

## 2026-07-17 验证

`working` 包含完整的成功代码状态。对其余所有工作树的交叉核对：

- **`gc-pipeline`**（`ae5029e`）：代码上与 working 中的 `5eb15d7` 完全相同——
  相同 diffstat（2 文件，+70/−1）、相同补丁内容，SHA 不同仅因父提交不同。
  gc-pipeline **不**包含第 5 节的子进程服务器重构；那是 working 独有。
- **`yesloop-pr-cpu-bundle`**、**`yesloop-spinner-partial-render`**：在 working
  之外有 0 个提交。
- **`yesloop-tui-buffered-messages`**（`a1909dd`、`ed869de`）：该特性在 working
  中以 `05aa560` 应用，并以 `e87bc03` 回退——有意的撤回。
- **`ab-bundle-merge`**（`f375f99`）：仅合并产物；实质性补丁已通过 `249e71b`
  进入 working。
- **`yesresearch-opencode-pr-analyse`**（3 个提交）：纯文档（`yesdocs/` 下的研
  究 wiki，约 850 行 Markdown）——有意单独保留，不含代码提交。
