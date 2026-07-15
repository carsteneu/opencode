import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Queue, Schema, Stream } from "effect"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { activeSseCount } from "../../src/server/routes/instance/httpapi/sse-counters"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    const value = yield* Queue.take(reader).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    return Schema.decodeUnknownSync(EventData)(
      JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "")),
    )
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<Uint8Array>()
    const fiber = yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader, fiber }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

describe("SSE teardown", () => {
  it.instance(
    "increments active count on connect",
    () =>
      Effect.gen(function* () {
        const before = activeSseCount()
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)

        yield* readEvent(reader)
        expect(activeSseCount()).toBe(before + 1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "decrements active count after client disconnect",
    () =>
      Effect.gen(function* () {
        const before = activeSseCount()
        const { directory } = yield* TestInstance
        const { reader, fiber } = yield* openEventStream(directory)

        yield* readEvent(reader)
        expect(activeSseCount()).toBe(before + 1)

        yield* Fiber.interrupt(fiber)
        yield* Effect.sleep("1 second")

        expect(activeSseCount()).toBe(before)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "does not accumulate across multiple connect/disconnect cycles",
    () =>
      Effect.gen(function* () {
        const before = activeSseCount()
        const { directory } = yield* TestInstance

        for (let i = 0; i < 3; i++) {
          const { reader, fiber } = yield* openEventStream(directory)
          yield* readEvent(reader)
          expect(activeSseCount()).toBe(before + 1)

          yield* Fiber.interrupt(fiber)
          yield* Effect.sleep("1 second")
          expect(activeSseCount()).toBe(before)
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
