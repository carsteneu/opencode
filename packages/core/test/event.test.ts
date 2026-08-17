import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Event } from "@opencode-ai/schema/event"
import { Session } from "@opencode-ai/schema/session"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { asc, eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location({ directory: AbsolutePath.make("project"), workspaceID: WorkspaceV2.ID.make("wrk_test") }),
  ),
)
const Message = EventV2.define({
  type: "test.message",
  schema: {
    text: Schema.String,
  },
})

const SyncMessage = EventV2.define({
  type: "test.sync",
  durable: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const SyncSent = EventV2.define({
  type: "test.sent",
  durable: {
    version: 1,
    aggregate: "messageID",
  },
  schema: {
    messageID: Schema.String,
    text: Schema.String,
  },
})

const GlobalMessage = EventV2.define({
  type: "test.global",
  schema: {
    text: Schema.String,
  },
})

const VersionedMessage = EventV2.define({
  type: "test.versioned",
  durable: {
    version: 2,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const DurableMessage = SessionV1.Event.MessageRemoved
const durableData = (sessionID: Session.ID, text: string) => ({
  sessionID,
  messageID: SessionV1.MessageID.ascending(`msg_${text}`),
})

function replayEvent(input: { aggregateID: Session.ID; seq: number; text: string; id?: EventV2.ID }) {
  return {
    id: input.id ?? EventV2.ID.create(),
    type: EventV2.versionedType(DurableMessage.type, DurableMessage.durable!.version),
    seq: input.seq,
    aggregateID: input.aggregateID,
    data: durableData(input.aggregateID, input.text),
  }
}

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, Location.node]), [[Location.node, locationLayer]]),
)
const itWithoutLocation = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))

describe("EventV2", () => {
  it.effect("publishes events with the current location", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const fiber = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })
      const received = Array.from(yield* Fiber.join(fiber))

      expect(received).toEqual([event])
      expect(event.type).toBe("test.message")
      expect(event).not.toHaveProperty("version")
      expect(event.data).toEqual({ text: "hello" })
      expect(event.location).toEqual({
        directory: AbsolutePath.make("project"),
        workspaceID: WorkspaceV2.ID.make("wrk_test"),
      })
    }),
  )

  itWithoutLocation.effect("omits location when no location is available", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const event = yield* events.publish(GlobalMessage, { text: "hello" })

      expect(event).not.toHaveProperty("location")
      expect(event.type).toBe("test.global")
    }),
  )

  it.effect("publishes definition version", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const event = yield* events.publish(VersionedMessage, { id: "one", text: "hello" })

      expect(event.type).toBe("test.versioned")
      expect(event.durable?.version).toBe(2)
    }),
  )

  it.effect("selects the latest durable definition independent of declaration order", () =>
    Effect.sync(() => {
      const latest = EventV2.define({
        type: "test.out-of-order",
        durable: { version: 2, aggregate: "id" },
        schema: { id: Schema.String },
      })
      const historical = EventV2.define({
        type: "test.out-of-order",
        durable: { version: 1, aggregate: "id" },
        schema: { id: Schema.String },
      })

      expect(Event.latest([latest, historical]).get("test.out-of-order")).toBe(latest)
      expect(Event.latest([historical, latest]).get("test.out-of-order")).toBe(latest)
    }),
  )

  it.effect("publishes to typed and wildcard subscriptions", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const typed = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const wildcard = yield* events.all().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })

      expect(Array.from(yield* Fiber.join(typed))).toEqual([event])
      expect(Array.from(yield* Fiber.join(wildcard))).toEqual([event])
    }),
  )

  it.effect("runs projectors inline", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      const event = yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* events.publish(SyncMessage, { id: "one", text: "after unsubscribe" })

      expect(received[0]).toEqual(event)
      expect(received[1]?.data).toEqual({ id: "one", text: "after unsubscribe" })
    }),
  )

  it.effect("commits local operational state inside a new durable event transaction", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      const aggregateID = EventV2.ID.create()
      yield* events.project(SyncMessage, () => Effect.sync(() => received.push("projector")))

      yield* events.publish(
        SyncMessage,
        { id: aggregateID, text: "hello" },
        { commit: (seq) => Effect.sync(() => received.push(`commit:${seq}`)) },
      )

      expect(received).toEqual(["projector", "commit:0"])
    }),
  )

  it.effect("rolls back the durable event and projector when the local commit fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      yield* db.run("CREATE TABLE IF NOT EXISTS event_commit_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM event_commit_probe")
      yield* events.project(SyncMessage, () =>
        db.run("INSERT INTO event_commit_probe (value) VALUES ('projected')").pipe(Effect.orDie, Effect.asVoid),
      )

      const exit = yield* events
        .publish(SyncMessage, { id: aggregateID, text: "hello" }, { commit: () => Effect.die("commit failed") })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("commit failed")
      expect(yield* db.all("SELECT value FROM event_commit_probe")).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
    }),
  )

  it.effect("rejects local commit hooks on live-only events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const exit = yield* events.publish(Message, { text: "hello" }, { commit: () => Effect.void }).pipe(Effect.exit)

      expect(String(exit)).toContain("Local commit hooks require a durable event")
    }),
  )

  it.effect("runs projectors before publishing to streams", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      const fiber = yield* events.all().pipe(
        Stream.take(1),
        Stream.runForEach(() => Effect.sync(() => received.push("stream"))),
        Effect.forkScoped,
      )
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      yield* Effect.yieldNow
      yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* Fiber.join(fiber)

      expect(received).toEqual([SyncMessage.type, "stream"])
    }),
  )

  it.effect("runs listeners inline after projectors", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      yield* events.project(SyncMessage, () =>
        Effect.sync(() => {
          received.push("projector")
        }),
      )
      const unsubscribe = yield* events.listen(() =>
        Effect.sync(() => {
          received.push("listener")
        }),
      )

      yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* unsubscribe
      yield* events.publish(SyncMessage, { id: "one", text: "after unsubscribe" })

      expect(received).toEqual(["projector", "listener", "projector"])
    }),
  )

  it.effect("isolates observer defects after durable events commit", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      yield* events.listen(() => {
        throw new Error("listener defect")
      })
      yield* events.listen((event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      const event = yield* events.publish(SyncMessage, { id: "one", text: "hello" })

      expect(received).toEqual([SyncMessage.type])
      expect(event.durable?.seq).toBeNumber()
    }),
  )

  it.effect("delivers sync listeners inline and exactly-once", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<number>()
      yield* events.listen((event) =>
        Effect.sync(() => {
          received.push(event.durable!.seq)
        }),
      )
      for (let index = 0; index < 5; index++) {
        yield* events.publish(SyncMessage, { id: "agg-inline", text: String(index) })
      }
      expect(received).toEqual([0, 1, 2, 3, 4])
    }),
  )

  it.effect("delivers observer listeners asynchronously and in order", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<number>()
      yield* events.listen(
        (event) =>
          Effect.sync(() => {
            received.push(event.durable!.seq)
          }),
        { sync: false },
      )
      for (let index = 0; index < 5; index++) {
        yield* events.publish(SyncMessage, { id: "agg-obs", text: String(index) })
      }
      const drained = yield* Effect.gen(function* () {
        let i = 0
        while (received.length < 5 && i < 2000) {
          i++
          yield* Effect.yieldNow
        }
        return received
      })
      expect(drained).toEqual([0, 1, 2, 3, 4])
    }),
  )

  it.effect("drops observer events under mailbox overflow but never drops sync listeners", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const syncReceived = new Array<string>()
      const observerReceived = new Array<string>()
      const expected = ["seed", ...Array.from({ length: 1100 }, (_, index) => String(index))]

      yield* events.listen(
        () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.asVoid,
            Effect.andThen(Deferred.await(release)),
          ),
        { sync: false },
      )
      yield* events.listen((event) =>
        Effect.sync(() => {
          syncReceived.push((event.data as { text: string }).text)
        }),
      )
      yield* events.listen(
        (event) =>
          Effect.sync(() => {
            observerReceived.push((event.data as { text: string }).text)
          }),
        { sync: false },
      )

      yield* events.publish(Message, { text: "seed" })
      yield* Deferred.await(started)
      for (let index = 0; index < 1100; index++) {
        yield* events.publish(Message, { text: String(index) })
      }
      yield* Deferred.succeed(release, undefined)
      for (let i = 0; i < 2000; i++) {
        yield* Effect.yieldNow
      }

      expect(syncReceived).toHaveLength(expected.length)
      expect(observerReceived.length).toBeLessThan(syncReceived.length)
      expect(observerReceived).toEqual(expected.slice(0, observerReceived.length))
    }),
  )

  it.effect("notifies global listeners only after a durable event is committed", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const observed = new Array<{ id: string; seq: number }>()
      yield* events.listen((event) =>
        event.type !== SyncMessage.type
          ? Effect.void
          : db
              .select({ id: EventTable.id, seq: EventTable.seq })
              .from(EventTable)
              .where(eq(EventTable.id, event.id))
              .get()
              .pipe(
                Effect.orDie,
                Effect.tap((row) =>
                  Effect.sync(() => {
                    if (row) observed.push(row)
                  }),
                ),
                Effect.asVoid,
              ),
      )

      const event = yield* events.publish(SyncMessage, { id: aggregateID, text: "committed" })
      if (!event.durable) throw new Error("Expected durable event metadata")

      expect(observed).toEqual([{ id: event.id, seq: event.durable.seq }])
    }),
  )

  it.effect("ends only an overflowing bounded subscriber without blocking other listeners", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const consuming = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const slowStream = yield* EventV2.allBounded(events, 1)
      const fastStream = yield* EventV2.allBounded(events, 8)
      const slow = yield* slowStream.pipe(
        Stream.runForEach(() => Deferred.succeed(consuming, undefined).pipe(Effect.andThen(Deferred.await(release)))),
        Effect.forkScoped,
      )
      const fast = yield* fastStream.pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)

      yield* events.publish(Message, { text: "one" })
      yield* Deferred.await(consuming)
      yield* events.publish(Message, { text: "two" })
      yield* events.publish(Message, { text: "overflow" })
      const last = yield* events.publish(Message, { text: "still delivered" })
      yield* Deferred.succeed(release, undefined)

      const slowExit = yield* Fiber.await(slow)
      expect(Exit.findErrorOption(slowExit).pipe(Option.getOrUndefined)).toBeInstanceOf(EventV2.SubscriberOverflowError)
      expect(Array.from(yield* Fiber.join(fast))).toEqual([
        expect.objectContaining({ data: { text: "one" } }),
        expect.objectContaining({ data: { text: "two" } }),
        expect.objectContaining({ data: { text: "overflow" } }),
        last,
      ])
    }),
  )

  it.effect("preserves observer interruption", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.listen(() => Effect.interrupt)

      const exit = yield* events.publish(SyncMessage, { id: "interrupted", text: "hello" }).pipe(Effect.exit)
      const committed = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, "interrupted"))
        .get()
        .pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBeTrue()
      expect(committed).toBeDefined()
    }),
  )

  it.effect("keeps live-only listener defects fail-fast", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const defect = new Error("listener defect")
      yield* events.listen(() => Effect.die(defect))

      expect(yield* events.publish(Message, { text: "hello" }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("inserts durable event rows on publish", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "first" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.type).toBe(EventV2.versionedType(SyncMessage.type, 1))
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect("increments durable event seq per aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "first" })
      yield* events.publish(SyncMessage, { id: aggregateID, text: "second" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1])
    }),
  )

  it.effect("rejects a durable publish reusing an already-stored event id", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const eventID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "first" }, { id: eventID })

      const exit = yield* events
        .publish(SyncMessage, { id: aggregateID, text: "second" }, { id: eventID })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("already exists")
    }),
  )

  it.effect("paginates durable aggregate reads in bounded pages", () =>
    Effect.gen(function* () {
      const reads: number[] = []
      const eventLayer = EventV2.layerWith({
        beforeAggregateRead: () =>
          Effect.sync(() => {
            reads.push(reads.length + 1)
          }),
      }).pipe(Layer.provide(LayerNode.compile(Database.node)))
      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const aggregateID = Session.ID.create()
        const count = 250
        for (let index = 0; index < count; index++) {
          yield* events.publish(DurableMessage, durableData(aggregateID, String(index)))
        }
        const collected = yield* events.durable({ aggregateID }).pipe(Stream.take(count), Stream.runCollect)
        expect(collected).toHaveLength(count)
        expect(reads.length).toBeGreaterThan(1)
      }).pipe(Effect.provide(Layer.merge(LayerNode.compile(Database.node), eventLayer)))
    }),
  )

  it.effect("replays durable aggregate events after a sequence and tails new events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "zero"))
      yield* events.publish(DurableMessage, durableData(aggregateID, "one"))
      const fiber = yield* events
        .durable({ aggregateID, after: 0 })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publish(DurableMessage, durableData(aggregateID, "two"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
        [1, durableData(aggregateID, "one")],
        [2, durableData(aggregateID, "two")],
      ])
    }),
  )

  it.effect("catches durable aggregate events published during replay handoff", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "zero"))
      const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)

      yield* events.publish(DurableMessage, durableData(aggregateID, "one"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
        [0, durableData(aggregateID, "zero")],
        [1, durableData(aggregateID, "one")],
      ])
    }),
  )

  it.effect("retains a durable wake committed while historical replay is paused", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>()
      const continueRead = yield* Deferred.make<void>()
      let pause = true
      const eventLayer = EventV2.layerWith({
        beforeAggregateRead: () =>
          pause
            ? Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Deferred.await(continueRead)))
            : Effect.void,
      }).pipe(Layer.provide(LayerNode.compile(Database.node)))

      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const aggregateID = Session.ID.create()
        const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Deferred.await(readStarted)

        pause = false
        yield* events.publish(DurableMessage, durableData(aggregateID, "during handoff"))
        yield* Deferred.succeed(continueRead, undefined)

        expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual([
          [0, durableData(aggregateID, "during handoff")],
        ])
      }).pipe(Effect.provide(Layer.merge(LayerNode.compile(Database.node), eventLayer)))
    }),
  )

  it.effect("coalesces durable aggregate wakes while draining every committed event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const count = 64
      const fiber = yield* events
        .durable({ aggregateID })
        .pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      for (let index = 0; index < count; index++) {
        yield* events.publish(DurableMessage, durableData(aggregateID, String(index)))
      }

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.durable?.seq, event.data])).toEqual(
        Array.from({ length: count }, (_, index) => [index, durableData(aggregateID, String(index))]),
      )
    }),
  )

  it.effect("omits live-only events from durable aggregate streams", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publish(Message, { text: "live only" })
      yield* events.publish(DurableMessage, durableData(aggregateID, "durable"))

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => event.type)).toEqual([DurableMessage.type])
    }),
  )

  it.effect("uses custom sync aggregate field", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncSent, { messageID: aggregateID, text: "sent" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect("replays durable events through projectors", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "hello"),
      })

      expect(received[0]?.type).toBe(DurableMessage.type)
      expect(received[0]?.data).toEqual(durableData(aggregateID, "hello"))
    }),
  )

  it.effect("replay inserts external event rows", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect(
    "replay rejects an envelope aggregate that differs from its payload without mutating the payload aggregate",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const envelopeAggregateID = Session.ID.create()
        const payloadAggregateID = Session.ID.create()
        const received = new Array<EventV2.Payload>()
        yield* events.publish(DurableMessage, durableData(payloadAggregateID, "seed"))
        yield* events.project(DurableMessage, (event) =>
          Effect.sync(() => {
            received.push(event)
          }),
        )

        const exit = yield* events
          .replay({
            id: EventV2.ID.create(),
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: 1,
            aggregateID: envelopeAggregateID,
            data: durableData(payloadAggregateID, "replayed"),
          })
          .pipe(Effect.exit)
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, payloadAggregateID))
          .all()
          .pipe(Effect.orDie)
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, payloadAggregateID))
          .get()
          .pipe(Effect.orDie)

        expect(String(exit)).toContain("Aggregate mismatch")
        expect(received).toHaveLength(0)
        expect(rows).toHaveLength(1)
        expect(sequence).toEqual({ seq: 0 })
      }),
  )

  it.effect("replay defects on sequence mismatch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "first"),
      })
      const exit = yield* events
        .replay({
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 5,
          aggregateID,
          data: durableData(aggregateID, "bad"),
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Sequence mismatch")
    }),
  )

  it.effect("replay decodes synchronized transformed values before projection", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const received = new Array<typeof SessionEvent.ContextUpdated.Type>()
      yield* events.project(SessionEvent.ContextUpdated, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SessionEvent.ContextUpdated.type, 1),
        seq: 0,
        aggregateID,
        data: { sessionID: aggregateID, messageID: "msg_context", timestamp: 0, text: "context" },
      })

      expect(received[0]?.data.timestamp).toEqual(DateTime.makeUnsafe(0))
    }),
  )

  it.effect("replay defects on unknown event type", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const exit = yield* events
        .replay({
          id: EventV2.ID.create(),
          type: "unknown.event.1",
          seq: 0,
          aggregateID: EventV2.ID.create(),
          data: {},
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Unknown durable event type")
    }),
  )

  it.effect("replayAll validates contiguous aggregate events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const source = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "one"),
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "two"),
        },
      ])

      expect(source).toBe(aggregateID)
    }),
  )

  it.effect("replayAll accepts later chunks after the first batch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      const one = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "one"),
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "two"),
        },
      ])
      const two = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 2,
          aggregateID,
          data: durableData(aggregateID, "three"),
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 3,
          aggregateID,
          data: durableData(aggregateID, "four"),
        },
      ])
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(one).toBe(aggregateID)
      expect(two).toBe(aggregateID)
      expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3])
    }),
  )

  it.effect("replayAll keeps its committed prefix when a later event fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      yield* db.run("CREATE TABLE IF NOT EXISTS event_replay_prefix_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM event_replay_prefix_probe")
      yield* events.project(DurableMessage, () =>
        db.run("INSERT INTO event_replay_prefix_probe (value) VALUES ('committed')").pipe(Effect.orDie, Effect.asVoid),
      )
      const first = replayEvent({ aggregateID, seq: 0, text: "committed" })

      const exit = yield* events
        .replayAll(
          [
            first,
            {
              id: EventV2.ID.create(),
              type: "unknown.replay.1",
              seq: 1,
              aggregateID,
              data: {},
            },
          ],
          { ownerID: "owner-prefix", strictOwner: true },
        )
        .pipe(Effect.exit)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(String(exit)).toContain("Unknown durable event type")
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all().pipe(Effect.orDie),
      ).toMatchObject([{ id: first.id, seq: 0 }])
      expect(sequence).toEqual({ seq: 0, ownerID: "owner-prefix" })
      expect(yield* db.all("SELECT value FROM event_replay_prefix_probe")).toEqual([{ value: "committed" }])
    }),
  )

  it.effect("replayAllAtomic rolls back events, sequence ownership, and projectors on a late failure", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const published = yield* events.publish(DurableMessage, durableData(aggregateID, "seed"))
      const seed = {
        id: published.id,
        type: EventV2.versionedType(DurableMessage.type, DurableMessage.durable!.version),
        seq: published.durable!.seq,
        aggregateID,
        data: published.data,
      }
      yield* db.run("CREATE TABLE IF NOT EXISTS event_atomic_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM event_atomic_probe")
      const projected = replayEvent({ aggregateID, seq: 1, text: "projected" })
      const bad = replayEvent({ aggregateID, seq: 2, text: "bad" })
      yield* events.project(DurableMessage, (event) =>
        db
          .run("INSERT INTO event_atomic_probe (value) VALUES ('projected')")
          .pipe(Effect.orDie, Effect.andThen(event.id === bad.id ? Effect.die("late projector failure") : Effect.void)),
      )

      const exit = yield* events
        .replayAllAtomic([seed, projected, bad], { ownerID: "owner-atomic", strictOwner: true })
        .pipe(Effect.exit)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(String(exit)).toContain("late projector failure")
      expect(rows.map((row) => [row.id, row.seq])).toEqual([[seed.id, 0]])
      expect(sequence).toEqual({ seq: 0, ownerID: null })
      expect(yield* db.all("SELECT value FROM event_atomic_probe")).toEqual([])
    }),
  )

  it.effect("replayAllAtomic validates empty, single-aggregate, and contiguous batches before writing", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const foreignID = Session.ID.create()

      expect(yield* events.replayAllAtomic([])).toBeUndefined()
      const mixed = yield* events
        .replayAllAtomic([
          replayEvent({ aggregateID, seq: 0, text: "zero" }),
          replayEvent({ aggregateID: foreignID, seq: 1, text: "foreign" }),
        ])
        .pipe(Effect.exit)
      const gap = yield* events
        .replayAllAtomic([
          replayEvent({ aggregateID, seq: 0, text: "zero" }),
          replayEvent({ aggregateID, seq: 2, text: "gap" }),
        ])
        .pipe(Effect.exit)

      expect(String(mixed)).toContain("same aggregate")
      expect(String(gap)).toContain("Replay sequence mismatch")
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, foreignID)).all()).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
    }),
  )

  it.effect("replayAllAtomic accepts an exact stale prefix and commits only the new suffix", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const projected = new Array<string>()
      const zero = replayEvent({ aggregateID, seq: 0, text: "zero" })
      const one = replayEvent({ aggregateID, seq: 1, text: "one" })
      const two = replayEvent({ aggregateID, seq: 2, text: "two" })
      yield* events.project(DurableMessage, (event) => Effect.sync(() => projected.push(event.data.messageID)))

      const first = yield* events.replayAllAtomic([zero, one], { ownerID: "owner-a", strictOwner: true })
      const second = yield* events.replayAllAtomic([zero, one, two], { ownerID: "owner-a", strictOwner: true })
      const stale = yield* events.replayAllAtomic([zero, one, two], { ownerID: "owner-a", strictOwner: true })
      const rows = yield* db
        .select({ seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect([first, second, stale]).toEqual([aggregateID, aggregateID, aggregateID])
      expect(rows.map((row) => row.seq)).toEqual([0, 1, 2])
      expect(sequence).toEqual({ seq: 2, ownerID: "owner-a" })
      expect(projected).toEqual(["zero", "one", "two"].map((text) => SessionV1.MessageID.ascending(`msg_${text}`)))
    }),
  )

  it.effect("replayAllAtomic rolls back a new suffix on divergent stale data or a duplicate event ID", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const zero = replayEvent({ aggregateID, seq: 0, text: "zero" })
      const one = replayEvent({ aggregateID, seq: 1, text: "one" })
      const two = replayEvent({ aggregateID, seq: 2, text: "two" })
      yield* events.replayAllAtomic([zero, one])

      const divergent = yield* events
        .replayAllAtomic([zero, { ...one, data: durableData(aggregateID, "divergent") }, two])
        .pipe(Effect.exit)
      const duplicate = yield* events
        .replayAllAtomic([zero, one, two, replayEvent({ aggregateID, seq: 3, text: "duplicate", id: zero.id })])
        .pipe(Effect.exit)
      const rows = yield* db
        .select({ id: EventTable.id, seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)

      expect(String(divergent)).toContain("Replay diverged")
      expect(String(duplicate)).toContain(`Event ${zero.id} already exists`)
      expect(rows).toEqual([
        { id: zero.id, seq: 0 },
        { id: one.id, seq: 1 },
      ])
      expect(
        yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ seq: 1 })
    }),
  )

  it.effect("replayAllAtomic strictly fences a stale prefix before it can append for another owner", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const zero = replayEvent({ aggregateID, seq: 0, text: "zero" })
      const one = replayEvent({ aggregateID, seq: 1, text: "one" })
      yield* events.replayAllAtomic([zero], { ownerID: "owner-a", strictOwner: true })

      const exit = yield* events
        .replayAllAtomic([zero, one], { ownerID: "owner-b", strictOwner: true })
        .pipe(Effect.exit)
      const rows = yield* db
        .select({ seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(String(exit)).toContain("Replay owner mismatch")
      expect(rows).toEqual([{ seq: 0 }])
      expect(sequence).toEqual({ seq: 0, ownerID: "owner-a" })
    }),
  )

  it.effect("replayAllAtomic keeps concurrent writers behind the complete immediate transaction", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const zero = replayEvent({ aggregateID, seq: 0, text: "zero" })
      const one = replayEvent({ aggregateID, seq: 1, text: "one" })
      yield* events.project(DurableMessage, (event) =>
        event.id === zero.id
          ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      )

      const replay = yield* events.replayAllAtomic([zero, one]).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      const publish = yield* events
        .publish(DurableMessage, durableData(aggregateID, "concurrent"))
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      expect(publish.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(replay)).toBe(aggregateID)
      expect((yield* Fiber.join(publish)).durable?.seq).toBe(2)
      expect(
        (yield* db
          .select({ seq: EventTable.seq })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, aggregateID))
          .orderBy(asc(EventTable.seq))
          .all()
          .pipe(Effect.orDie)).map((row) => row.seq),
      ).toEqual([0, 1, 2])
    }),
  )

  it.effect("replayAllAtomic wakes durable readers once after commit and never publishes general notifications", () =>
    Effect.gen(function* () {
      const initialRead = yield* Deferred.make<void>()
      let reads = 0
      const eventLayer = EventV2.layerWith({
        beforeAggregateRead: () =>
          Effect.sync(() => ++reads).pipe(
            Effect.flatMap((count) => (count === 1 ? Deferred.succeed(initialRead, undefined) : Effect.void)),
          ),
      }).pipe(Layer.provide(LayerNode.compile(Database.node)))

      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const aggregateID = Session.ID.create()
        const zero = replayEvent({ aggregateID, seq: 0, text: "zero" })
        const one = replayEvent({ aggregateID, seq: 1, text: "one" })
        const two = replayEvent({ aggregateID, seq: 2, text: "two" })
        const received = new Array<EventV2.Payload>()
        yield* events.replayAllAtomic([zero, one, two], { ownerID: "owner-a", strictOwner: true })
        yield* events.listen((event) => Effect.sync(() => received.push(event)))
        const typed = yield* events.subscribe(DurableMessage).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        const all = yield* events.all().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        const durable = yield* events
          .durable({ aggregateID, after: 2 })
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
        yield* Deferred.await(initialRead)
        yield* Effect.yieldNow
        const rolledBack = replayEvent({ aggregateID, seq: 3, text: "rolled back" })
        const fail = replayEvent({ aggregateID, seq: 4, text: "fail" })
        yield* events.project(DurableMessage, (event) =>
          event.id === fail.id ? Effect.die("wake rollback") : Effect.void,
        )

        expect(yield* events.replayAllAtomic([])).toBeUndefined()
        yield* events.replayAllAtomic([zero, one, two], { ownerID: "owner-a", strictOwner: true })
        const failed = yield* events
          .replayAllAtomic([zero, one, two, rolledBack, fail], { ownerID: "owner-a", strictOwner: true })
          .pipe(Effect.exit)
        yield* Effect.yieldNow

        expect(String(failed)).toContain("wake rollback")
        expect(reads).toBe(1)
        yield* events.replayAllAtomic(
          [
            zero,
            one,
            two,
            replayEvent({ aggregateID, seq: 3, text: "three" }),
            replayEvent({ aggregateID, seq: 4, text: "four" }),
          ],
          { ownerID: "owner-a", strictOwner: true },
        )

        expect(Array.from(yield* Fiber.join(durable)).map((event) => event.durable?.seq)).toEqual([3, 4])
        expect(reads).toBe(2)
        expect(received).toEqual([])
        expect(typed.pollUnsafe()).toBeUndefined()
        expect(all.pollUnsafe()).toBeUndefined()
      }).pipe(Effect.provide(Layer.merge(LayerNode.compile(Database.node), eventLayer)))
    }),
  )

  it.effect("replays compacted checkpoints as no-ops before the next aggregate event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const aggregateID = Session.ID.create()
      const compactedID = EventV2.ID.create()
      const nextID = EventV2.ID.create()
      const projected = new Array<EventV2.ID>()
      const published = new Array<string>()
      const compacted = {
        id: compactedID,
        type: EventV2.versionedType(Event.Compacted.type, Event.Compacted.durable!.version),
        seq: 0,
        aggregateID,
        data: {
          aggregateID,
          supersededType: "message.updated.1",
          supersededBy: nextID,
        },
      }
      const next = {
        id: nextID,
        type: EventV2.versionedType(DurableMessage.type, DurableMessage.durable!.version),
        seq: 1,
        aggregateID,
        data: durableData(aggregateID, "after-compacted"),
      }
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          projected.push(event.id)
        }),
      )
      yield* events.listen((event) =>
        Effect.sync(() => {
          published.push(event.type)
        }),
      )

      yield* events.replay(compacted, { publish: true })
      yield* events.replay(next, { publish: true })

      const rows = yield* database.db
        .select({
          id: EventTable.id,
          aggregateID: EventTable.aggregate_id,
          seq: EventTable.seq,
          type: EventTable.type,
          data: EventTable.data,
        })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const history = Array.from(yield* events.durable({ aggregateID }).pipe(Stream.take(2), Stream.runCollect))

      expect(projected).toEqual([nextID])
      expect(published).toEqual([DurableMessage.type])
      expect(rows).toEqual([compacted, next])
      expect(
        history.map((event) => ({ id: event.id, aggregateID: event.durable?.aggregateID, seq: event.durable?.seq })),
      ).toEqual([
        { id: compactedID, aggregateID, seq: 0 },
        { id: nextID, aggregateID, seq: 1 },
      ])
    }),
  )

  it.effect("claim fences replay owners", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "seed"))
      yield* events.claim(aggregateID, "owner-a")
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "ignored"),
        },
        { ownerID: "owner-b" },
      )

      expect(received).toHaveLength(0)
    }),
  )

  it.effect("strict owner fences exact replay", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const id = EventV2.ID.create()
      const replayed = {
        id,
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "owned"),
      }
      yield* events.replay(replayed, { ownerID: "owner-a" })

      const exit = yield* events.replay(replayed, { ownerID: "owner-b", strictOwner: true }).pipe(Effect.exit)

      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("exact replay claims an unowned aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const published = yield* events.publish(DurableMessage, durableData(aggregateID, "owned"))
      const replayed = {
        id: published.id,
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: published.durable!.seq,
        aggregateID,
        data: published.data,
      }

      yield* events.replay(replayed, { ownerID: "owner-a", strictOwner: true })
      const row = yield* db
        .select({ ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row?.ownerID).toBe("owner-a")
      const exit = yield* events
        .replay(
          { ...replayed, id: EventV2.ID.create(), seq: 1, data: durableData(aggregateID, "conflict") },
          { ownerID: "owner-b", strictOwner: true },
        )
        .pipe(Effect.exit)
      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("replay with owner claims an unowned sequence", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "owned"),
        },
        { ownerID: "owner-1" },
      )
      const row = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({ seq: 0, ownerID: "owner-1" })
    }),
  )

  it.effect("replay claims an existing unowned sequence before fencing a different owner", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "local"))

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "claimed"),
        },
        { ownerID: "owner-1" },
      )
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 2,
          aggregateID,
          data: durableData(aggregateID, "fenced"),
        },
        { ownerID: "owner-2" },
      )
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1])
      expect(sequence).toEqual({ seq: 1, ownerID: "owner-1" })
    }),
  )

  it.effect("strict replay rejects an owner conflict instead of silently skipping it", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "claimed"),
        },
        { ownerID: "owner-1" },
      )

      const exit = yield* events
        .replay(
          {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(DurableMessage.type, 1),
            seq: 1,
            aggregateID,
            data: durableData(aggregateID, "conflict"),
          },
          { ownerID: "owner-2", strictOwner: true },
        )
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("publishes accepted replay with its durable sequence and suppresses stale replay", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      const replayed = {
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      }

      yield* events.replay(replayed, { publish: true })
      yield* events.replay(replayed, { publish: true })

      expect(received).toMatchObject([{ id: replayed.id, durable: { seq: 0, version: 1 }, data: replayed.data }])
    }),
  )

  it.effect("rejects divergent stale replay without publishing it", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      const replayed = {
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "original"),
      }
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      yield* events.replay(replayed, { publish: true })

      const exit = yield* events
        .replay({ ...replayed, data: durableData(aggregateID, "divergent") }, { publish: true })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Replay diverged")
      expect(received).toHaveLength(1)
    }),
  )

  it.effect("rejects an event ID reused at another aggregate position", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const id = EventV2.ID.create()
      yield* events.replay({
        id,
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "first"),
      })

      const exit = yield* events
        .replay({
          id,
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "second"),
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain(`Event ${id} already exists`)
    }),
  )

  it.effect("replay from a different owner leaves claimed sequence unchanged", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()
      const received = new Array<EventV2.Payload>()
      yield* events.listen((event) => Effect.sync(() => received.push(event)))

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 0,
          aggregateID,
          data: durableData(aggregateID, "first"),
        },
        { ownerID: "owner-1" },
      )
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(DurableMessage.type, 1),
          seq: 1,
          aggregateID,
          data: durableData(aggregateID, "ignored"),
        },
        { ownerID: "owner-2", publish: true },
      )
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(sequence).toEqual({ seq: 0, ownerID: "owner-1" })
      expect(received).toHaveLength(0)
    }),
  )

  it.effect("claim updates the event sequence owner", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "claimed" })
      yield* events.claim(aggregateID, "owner-1")
      yield* events.claim(aggregateID, "owner-2")
      const row = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({ seq: 0, ownerID: "owner-2" })
    }),
  )

  it.effect("remove clears durable event sequence", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "seed"))
      yield* events.remove(aggregateID)
      yield* events.project(DurableMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(DurableMessage.type, 1),
        seq: 0,
        aggregateID,
        data: durableData(aggregateID, "replayed"),
      })

      expect(received[0]?.data).toEqual(durableData(aggregateID, "replayed"))
    }),
  )
})
