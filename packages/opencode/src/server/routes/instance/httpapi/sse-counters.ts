import { Effect } from "effect"
import { GlobalBus } from "@/bus/global"

export interface SseStats {
  active: number
  listeners: number
}

let activeConnections = 0

export function sseConnect(): Effect.Effect<SseStats> {
  return Effect.sync(() => {
    activeConnections++
    return stats()
  })
}

export function sseDisconnect(): Effect.Effect<SseStats> {
  return Effect.sync(() => {
    activeConnections = Math.max(0, activeConnections - 1)
    return stats()
  })
}

function stats(): SseStats {
  return {
    active: activeConnections,
    listeners: GlobalBus.listenerCount("event"),
  }
}
