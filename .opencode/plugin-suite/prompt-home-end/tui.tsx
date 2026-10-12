/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"

// v2 binds bare Home/End to transcript navigation (session.first/session.last)
// even while the composer is focused; the input commands input.buffer.home/end
// default to "none". v1 let the focused input win (see fork commit 48fdd6cc37).
// This plugin restores the v1 binding: with an editor focused, Home/End move the
// buffer cursor, and a higher layer priority keeps session.first/last from
// consuming the key. With no editor focused the command returns false, so the
// transcript jump still fires.
export default Plugin.define({
  id: "opencode.prompt.home-end",
  setup(context) {
    const move = (method: "gotoBufferHome" | "gotoBufferEnd") => () => {
      // Move the focused editor's buffer directly (the same handler the core
      // input.buffer.home/end commands run). Dispatching the command id instead
      // would report the key as handled even when the command is unreachable,
      // leaving Home/End dead; this only consumes the key when it can act.
      const editor = context.renderer.currentFocusedEditor as {
        isDestroyed?: boolean
        gotoBufferHome?: () => void
        gotoBufferEnd?: () => void
      } | null
      if (!editor || editor.isDestroyed) return false
      const goto = editor[method]
      if (typeof goto !== "function") return false
      goto.call(editor)
    }
    context.keymap.layer(() => ({
      priority: 10,
      commands: [
        { bind: "home", title: "Buffer start", group: "Prompt", run: move("gotoBufferHome") },
        { bind: "end", title: "Buffer end", group: "Prompt", run: move("gotoBufferEnd") },
      ],
    }))
  },
})
