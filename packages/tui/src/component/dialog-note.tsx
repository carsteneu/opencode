/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createSignal, onMount } from "solid-js"
import { useConfig } from "../config"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogFooter, DialogHeader, DialogLayout, useDialog } from "../ui/dialog"

/**
 * A multi-line editor for one note. Unlike `DialogPrompt` it gives the text room and keeps Enter as
 * the submit key, so a newline needs Ctrl+Enter (the managed textarea's `input.newline`).
 *
 * The dialog closes itself: unlike `ui.dialog.prompt` there is no promise to settle, and a caller
 * that had to clear the dialog after every path would eventually forget one.
 */
export function DialogNote(props: {
  title: string
  value?: string
  placeholder?: string
  onConfirm: (text: string) => void
}) {
  const dialog = useDialog()
  const renderer = useRenderer()
  const theme = useTheme().surface("dialog")
  const config = useConfig().data
  const [target, setTarget] = createSignal<TextareaRenderable>()
  let textarea: TextareaRenderable

  function confirm() {
    const text = textarea.plainText
    // An empty note has nothing to come back to; keep the dialog open instead of dropping it.
    if (!text.trim()) return
    props.onConfirm(text)
    dialog.clear()
  }

  function cancel() {
    dialog.clear()
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    target,
    enabled: target() !== undefined,
    priority: 1,
    commands: [{ id: "dialog.prompt.submit", title: "Save note", group: "Dialog", run: confirm }],
  }))

  Keymap.createLayer(() => ({
    mode: "modal",
    priority: 1,
    commands: [
      {
        bind: "escape",
        title: "Close note",
        group: "Dialog",
        run: () => {
          if (renderer.getSelection()) {
            renderer.clearSelection()
            return
          }
          cancel()
        },
      },
    ],
  }))

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
      textarea.gotoLineEnd()
    }, 1)
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    textarea.focus()
  })

  return (
    <DialogLayout
      header={<DialogHeader title={props.title} onClose={cancel} />}
      footer={{
        actions: {
          secondary: [{ title: "newline", key: "ctrl+enter" }],
          primary: [{ title: "save", command: "dialog.prompt.submit", onTrigger: confirm }],
        },
      }}
      legacyFooter={
        <DialogFooter
          actions={{
            secondary: [{ title: "newline", key: "ctrl+enter" }],
            primary: [{ title: "save", command: "dialog.prompt.submit", onTrigger: confirm }],
          }}
        />
      }
    >
      <textarea
        height={5}
        wrapMode="word"
        ref={(value: TextareaRenderable) => {
          textarea = value
          setTarget(value)
        }}
        initialValue={props.value}
        placeholder={props.placeholder ?? "Enter text"}
        placeholderColor={theme.text.muted}
        textColor={theme.text.formfield.base}
        focusedTextColor={theme.text.formfield.base}
        cursorColor={theme.text.base}
        cursorStyle={config.cursor}
      />
    </DialogLayout>
  )
}
