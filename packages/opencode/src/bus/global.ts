import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

export const GlobalBus = new EventEmitter<{
  event: [GlobalEvent]
}>()

GlobalBus.prependListener("event", (event) => {
  if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
    event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
  }
})
