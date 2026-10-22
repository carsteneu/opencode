import { RendererControlState, type CliRenderer } from "@opentui/core"

type TitleRenderer = Pick<CliRenderer, "isDestroyed" | "controlState" | "setTerminalTitle">

// OpenTUI rejects terminal control from suspend() until resume() completes (e.g. while $EDITOR runs).
// Its native session also has phases the control state does not model: 0.6.6 throws
// "ot_session_control failed: InvalidPhase" for a title while that session is not attached. A title is
// cosmetic, so it is best effort and must never be the reason a session dies.
export function setTerminalTitle(renderer: TitleRenderer, title: string) {
  if (renderer.isDestroyed || renderer.controlState === RendererControlState.EXPLICIT_SUSPENDED) return
  try {
    renderer.setTerminalTitle(title)
  } catch {}
}

export function destroyRenderer(renderer: TitleRenderer & Pick<CliRenderer, "destroy">) {
  if (renderer.isDestroyed) return
  setTerminalTitle(renderer, "")
  renderer.destroy()
}
