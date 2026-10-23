/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, For, on, Show } from "solid-js"
import { useData } from "../context/data"
import { useTheme, useThemes } from "../context/theme"
import { SESSION_REPLAY_WIDTH } from "../ui/layout"
import { filetype } from "../util/filetype"
import {
  clampReplayPatch,
  compactReplayPatch,
  replayFileName,
  replaySteps,
  replayTimeLabel,
  REPLAY_MAX_STEPS,
  type ReplayStep,
} from "../util/replay"
import { PatchDiff } from "./patch-diff"

/**
 * Reader for the edit history of a session: one card per completed
 * edit/write/patch call with its diff. The pane is a fixed-width column, so
 * patches are context-trimmed and clamped before they reach the renderer.
 */
export function SessionReplay(props: { sessionID: string }) {
  const data = useData()
  const theme = useTheme()
  const renderer = useRenderer()
  let scroll: ScrollBoxRenderable | undefined

  // Deriving the ledger sanitizes and bounds every patch, so it must not run
  // per streaming token. Only an appended message, a new tool part or a part
  // status change can produce a new step; text deltas touch none of them.
  const messages = createMemo(() => data.session.message.list(props.sessionID))
  const signature = createMemo(() =>
    messages()
      .map((message) =>
        message.type === "assistant"
          ? message.id + ":" + message.content.map((part) => (part.type === "tool" ? part.id + part.state.status : part.type)).join(",")
          : message.id,
      )
      .join("|"),
  )
  let ledger: { signature: string; steps: ReplayStep[] } | undefined
  const steps = createMemo(() => {
    const key = signature()
    if (ledger?.signature === key) return ledger.steps
    ledger = { signature: key, steps: replaySteps(messages()) }
    return ledger.steps
  })
  const visible = createMemo(() => {
    const all = steps()
    return all.length > REPLAY_MAX_STEPS ? all.slice(-REPLAY_MAX_STEPS) : all
  })

  // The newest edit is the interesting one: follow the tail whenever the last
  // step changes, so loading older pages (which prepends) cannot yank the pane
  // away from the user. The scrollbox measures its content one frame after it
  // mounts, so a single scroll can be a no-op.
  const follow = () => {
    let attempts = 0
    const scrollToTail = () => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
      if (scroll.scrollTop === 0 && attempts++ < 3) renderer.requestAnimationFrame(scrollToTail)
    }
    renderer.requestAnimationFrame(scrollToTail)
  }
  let followed = ""
  createEffect(() => {
    const last = steps()[steps().length - 1]
    const key = last ? `${last.tool}|${last.filePath}|${last.time}|${last.patch?.length ?? 0}` : ""
    if (key === followed) return
    followed = key
    follow()
  })
  createEffect(
    on(
      () => props.sessionID,
      () => {
        followed = ""
        if (scroll && !scroll.isDestroyed) scroll.scrollTo(0)
      },
      { defer: true },
    ),
  )

  return (
    <box
      id="session-replay"
      flexShrink={0}
      width={SESSION_REPLAY_WIDTH}
      minWidth={0}
      minHeight={0}
      flexDirection="column"
      border={["left"]}
      borderColor={theme.border.base}
    >
      <box flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={theme.text.base}>
          <b>Replay</b>
          <span style={{ fg: theme.text.muted }}>
            {" "}
            {steps().length} {steps().length === 1 ? "step" : "steps"}
          </span>
        </text>
      </box>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => (scroll = value)}
        flexGrow={1}
        minWidth={0}
        minHeight={0}
        verticalScrollbarOptions={{
          visible: true,
          trackOptions: { backgroundColor: theme.background.raised.base, foregroundColor: theme.border.base },
        }}
      >
        <For each={visible()}>{(step) => <ReplayCard step={step} total={steps().length} />}</For>
        <Show when={steps().length === 0}>
          <box paddingLeft={1} paddingTop={1}>
            <text fg={theme.text.muted}>no edits in this session</text>
          </box>
        </Show>
      </scrollbox>
    </box>
  )
}

function ReplayCard(props: { step: ReplayStep; total: number }) {
  const theme = useTheme()
  const syntax = useThemes().currentSyntax
  const name = createMemo(() => replayFileName(props.step.filePath) || "session")
  const patch = createMemo(() => {
    const raw = props.step.patch
    if (raw === undefined) return
    return compactReplayPatch(clampReplayPatch(raw))
  })

  return (
    <box
      id={`replay-step-${props.step.index}`}
      flexDirection="column"
      marginBottom={1}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.text.base} wrapMode="none">
        {props.step.index}/{props.total} {props.step.tool}
      </text>
      <text fg={theme.text.base} wrapMode="none">
        {name()}
      </text>
      <text fg={theme.text.muted} wrapMode="none">
        {replayTimeLabel(props.step.time)}
      </text>
      <Show when={patch()} fallback={<text fg={theme.text.muted}>(no diff recorded)</text>}>
        {(diff) => (
          <PatchDiff
            diff={diff()}
            view="unified"
            filetype={filetype(props.step.filePath)}
            syntaxStyle={syntax()}
            showLineNumbers={true}
            width="100%"
            wrapMode="char"
            fg={theme.text.base}
            addedBg={theme.diff.background.added}
            removedBg={theme.diff.background.removed}
            contextBg={theme.diff.background.context}
            hunkFg={theme.diff.text.hunkHeader}
            addedSignColor={theme.diff.highlight.added}
            removedSignColor={theme.diff.highlight.removed}
            lineNumberFg={theme.diff.lineNumber.text}
            lineNumberBg={theme.diff.background.context}
            addedLineNumberBg={theme.diff.lineNumber.background.added}
            removedLineNumberBg={theme.diff.lineNumber.background.removed}
          />
        )}
      </Show>
    </box>
  )
}
