export type ModelWaitState = { phase: "idle" } | { phase: "waiting"; since: number } | { phase: "active"; since: number }

export type ModelWaitEvent =
  | { type: "status"; status: "busy" | "idle" | "retry"; at: number }
  | { type: "activity"; at: number }

export function nextModelWait(state: ModelWaitState, event: ModelWaitEvent): ModelWaitState {
  if (event.type === "activity") {
    if (state.phase === "waiting") return { phase: "active", since: event.at }
    return state
  }
  if (event.status !== "busy") return { phase: "idle" }
  if (state.phase === "idle") return { phase: "waiting", since: event.at }
  return state
}

/** Elapsed label for the wait cell: whole seconds, then minutes, so a per-second tick stays even. */
export function formatModelWait(elapsedMs: number) {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
}
