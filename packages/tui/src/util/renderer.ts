import { RendererControlState, type CliRenderer } from "@opentui/core"

type TitleRenderer = Pick<CliRenderer, "isDestroyed" | "controlState" | "setTerminalTitle">

// OpenTUI rejects terminal control unless the renderer's session is running: from suspend() until resume()
// completes (e.g. while $EDITOR runs), and in a renderer that was never started (test renderers). A title
// is cosmetic, so every other phase is a skip rather than a failure.
export function setTerminalTitle(renderer: TitleRenderer, title: string) {
  if (renderer.isDestroyed) return
  if (
    renderer.controlState !== RendererControlState.AUTO_STARTED &&
    renderer.controlState !== RendererControlState.EXPLICIT_STARTED
  )
    return
  // The native session has phases the control state does not model: 0.6.6 rejects a title while that
  // session is not attached ("ot_session_control failed: InvalidPhase"). A title is cosmetic, so it must
  // never be the reason a session dies.
  try {
    renderer.setTerminalTitle(title)
  } catch {}
}

export function destroyRenderer(renderer: TitleRenderer & Pick<CliRenderer, "destroy">) {
  if (renderer.isDestroyed) return
  setTerminalTitle(renderer, "")
  renderer.destroy()
}
