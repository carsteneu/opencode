import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Event } from "../src/event"
import { EventManifest } from "../src/event-manifest"

test("registers compacted checkpoints only for durable readers", () => {
  const marker = {
    id: Event.ID.create(),
    type: Event.Compacted.type,
    durable: { aggregateID: "session", seq: 4, version: 1 },
    data: {
      aggregateID: "session",
      supersededType: "message.updated.1",
      supersededBy: Event.ID.create(),
    },
  }

  expect(Schema.decodeUnknownSync(Event.Compacted)(marker)).toEqual(marker)
  expect(EventManifest.Durable.get("event.compacted.1")).toBe(Event.Compacted)
  expect(EventManifest.Definitions).not.toContain(Event.Compacted)
  expect(EventManifest.Latest.has(Event.Compacted.type)).toBe(false)
})
