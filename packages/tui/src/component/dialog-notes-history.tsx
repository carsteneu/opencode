/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import type { DialogSelectOption } from "@opencode/plugin/tui/context"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo } from "solid-js"
import { useConfig } from "../config"
import { useTheme } from "../context/theme"
import { DIALOG_INSET, DialogBleed, DialogFooter, DialogHeader, DialogLayout } from "../ui/dialog"
import { datetime } from "../util/locale"
import { NOTE_ANSWER_LIMIT, type Note } from "../util/notes"
import { getScrollAcceleration } from "../util/scroll"

function firstLine(text: string) {
  return text.split("\n").find((line) => line.trim().length > 0) ?? text
}

function marker(note: Note) {
  if (note.state === "answered") return "✓"
  if (note.state === "sent") return "⋯"
  return note.done ? "☑" : "○"
}

/** List rows for the history dialog, already in reading order (see `historyNotes`). */
export function historyOptions(notes: readonly Note[]): DialogSelectOption<Note>[] {
  return notes.map((note) => {
    const description =
      note.state === "answered" && note.answer
        ? firstLine(note.answer.text)
        : note.state === "sent"
          ? "waiting for an answer"
          : undefined
    return {
      title: `${marker(note)} ${firstLine(note.text)}`,
      value: note,
      ...(description === undefined ? {} : { description }),
    }
  })
}

/** Substring match over the question *and* the captured answer; no index, the lists are short. */
export function searchNotes(query: string, options: readonly DialogSelectOption<Note>[]) {
  const needle = query.trim().toLowerCase()
  if (!needle) return options
  return options.filter((option) => {
    const note = option.value
    return `${note.text}\n${note.answer?.text ?? ""}`.toLowerCase().includes(needle)
  })
}

/** Full question and full answer as plain text: no markdown path, the stored text is verbatim. */
export function DialogNoteDetail(props: { note: Note }) {
  const theme = useTheme().surface("dialog")
  const overlay = useTheme()
  const config = useConfig().data
  const dimensions = useTerminalDimensions()
  const maxHeight = createMemo(() => Math.max(8, Math.floor(dimensions().height * 0.6)))
  const answer = () => props.note.answer
  let scroll: ScrollBoxRenderable | undefined

  return (
    <DialogLayout
      header={
        <DialogHeader
          gap={2}
          title="Prompt note"
          titleView={
            <text fg={theme.text.base} wrapMode="word" flexGrow={1} flexShrink={1} minWidth={0}>
              {props.note.text}
            </text>
          }
        />
      }
      footer={{
        actions: { secondary: [{ title: "close", key: "esc" }] },
      }}
      legacyFooter={<DialogFooter actions={{ secondary: [{ title: "close", key: "esc" }] }} />}
    >
      <DialogBleed>
        <scrollbox
          ref={(element: ScrollBoxRenderable) => (scroll = element)}
          maxHeight={maxHeight()}
          contentOptions={{ minHeight: 0 }}
          backgroundColor={overlay.background.raised.high}
          scrollbarOptions={{ visible: true }}
          scrollAcceleration={getScrollAcceleration(config)}
          onMouseDown={() => scroll?.focus()}
        >
          <box paddingLeft={DIALOG_INSET} paddingRight={DIALOG_INSET} paddingTop={1} paddingBottom={1} gap={1}>
            <text fg={theme.text.base} wrapMode="word">
              {answer()?.text ?? "no answer yet"}
            </text>
            <text fg={theme.text.faint}>
              added {datetime(props.note.created)}
              {answer() ? ` · answered ${datetime(answer()!.time)}` : ""}
              {answer()?.truncated ? ` · capped at ${NOTE_ANSWER_LIMIT} characters` : ""}
            </text>
          </box>
        </scrollbox>
      </DialogBleed>
    </DialogLayout>
  )
}

/** Opens one note as plain text: its question and its captured answer. */
export function openNoteDetail(ui: Plugin.Context["ui"], note: Note) {
  ui.dialog.show(() => <DialogNoteDetail note={note} />)
  ui.dialog.set({ size: "large", centered: true })
}

/** Opens the session's note history: a searchable list, then the full note. */
export async function openNotesHistory(ui: Plugin.Context["ui"], notes: readonly Note[]) {
  if (notes.length === 0) {
    await ui.dialog.alert({ title: "Prompt notes", message: "No notes in this session yet" })
    return
  }
  const selected = await ui.dialog.select<Note>({
    title: "Prompt notes",
    placeholder: "Search notes",
    options: historyOptions(notes),
    search: searchNotes,
  })
  if (!selected) return
  // The select dialog closes on a pick, so the detail is its own dialog.
  openNoteDetail(ui, selected)
}
