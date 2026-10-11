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
