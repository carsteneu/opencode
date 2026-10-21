/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"

// v2 binds bare Home/End to transcript navigation (session.first/session.last)
// even while the composer is focused; the input commands input.buffer.home/end
// default to "none". v1 let the focused input win: our fork restored that in
// 48fdd6cc37 (fix(tui): preserve prompt home and end keys), and v2 upstream
// resolves the same collision by leaving input.buffer.home/end unbound.
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
        plainText?: string
        gotoBufferHome?: () => void
        gotoBufferEnd?: () => void
      } | null
      if (!editor || editor.isDestroyed) return false
      const goto = editor[method]
      if (typeof goto !== "function") return false
      // An empty composer has no cursor to move, so the key belongs to transcript navigation. With text
      // in it the key always stays in the input: jumping the transcript out from under a draft would be
      // surprising, even when the cursor already sits at the edge.
      if (typeof editor.plainText === "string" && editor.plainText.length === 0) return false
      goto.call(editor)
      return true
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
