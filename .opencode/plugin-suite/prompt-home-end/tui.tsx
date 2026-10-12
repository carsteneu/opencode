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
    const move = (command: "input.buffer.home" | "input.buffer.end") => () => {
      // Mirror the core edit-buffer guard (withFocusedEditor): only consume the
      // key when a live editor can actually move its buffer, otherwise let the
      // transcript jump through.
      const editor = context.renderer.currentFocusedEditor as {
        isDestroyed?: boolean
        gotoBufferHome?: unknown
      } | null
      if (!editor || editor.isDestroyed || typeof editor.gotoBufferHome !== "function") return false
      context.keymap.dispatch(command)
    }
    context.keymap.layer(() => ({
      priority: 10,
      commands: [
        { bind: "home", title: "Buffer start", group: "Prompt", run: move("input.buffer.home") },
        { bind: "end", title: "Buffer end", group: "Prompt", run: move("input.buffer.end") },
      ],
    }))
  },
})
