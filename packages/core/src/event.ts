export * as EventV2 from "./event"

import { Cause, Context, Effect, Layer, Option, PubSub, Queue, Schema, Stream } from "effect"
import { Event } from "@opencode-ai/schema/event"
import type { Data, Definition, Payload } from "@opencode-ai/schema/event"
import { and, asc, eq, gt, inArray } from "drizzle-orm"
import { Database } from "./database/database"
import { EventSequenceTable, EventTable } from "./event/sql"
import { Location } from "./location"
import { makeGlobalNode } from "./effect/app-node"
import { isDeepStrictEqual } from "node:util"
import { Durable } from "@opencode-ai/schema/durable-event-manifest"

export const ID = Event.ID
export type ID = import("@opencode-ai/schema/event").ID
export type { Data, Definition, Payload } from "@opencode-ai/schema/event"

export type Subscriber<D extends Definition = Definition> = (event: Payload<D>) => Effect.Effect<void>
export type Unsubscribe = Effect.Effect<void>

export const latestSequence = Effect.fn("EventV2.latestSequence")(function* (
  db: Database.Interface["db"],
  aggregateID: string,
) {
  const row = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
    .get()
    .pipe(Effect.orDie)
  return row?.seq ?? -1
})

export type SerializedEvent = {
  readonly id: ID
  readonly type: string
  readonly seq: number
  readonly aggregateID: string
  readonly data: Record<string, unknown>
}

export class InvalidDurableEventError extends Schema.TaggedErrorClass<InvalidDurableEventError>()(
  "EventV2.InvalidDurableEvent",
  {
    type: Schema.String,
    message: Schema.String,
  },
) {}

const decodeSerializedEvent = (event: SerializedEvent): Payload => {
  const definition = Durable.get(event.type)
  if (!definition?.durable) {
    throw new InvalidDurableEventError({ type: event.type, message: `Unknown durable event type ${event.type}` })
  }
  return {
    id: event.id,
    type: definition.type,
    durable: { aggregateID: event.aggregateID, seq: event.seq, version: definition.durable.version },
    data: Schema.decodeUnknownSync(definition.data)(event.data),
  }
}

export const readAggregate = Effect.fn("EventV2.readAggregate")(function* <A>(
  db: Database.Interface["db"],
  input: {
    readonly aggregateID: string
    readonly after?: number
    readonly limit: number
    readonly manifest: {
      readonly definitions: ReadonlyMap<string, Definition>
      readonly schema: Schema.Decoder<A, never>
    }
  },
) {
  const after = input.after ?? -1
  const rows = yield* db
    .select()
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, input.aggregateID),
        gt(EventTable.seq, after),
        inArray(EventTable.type, Array.from(input.manifest.definitions.keys())),
      ),
    )
    .orderBy(asc(EventTable.seq))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  const page = rows.slice(0, input.limit)
  const decode = Schema.decodeUnknownSync(input.manifest.schema)
  const events = page.map((event) =>
    decode({
      id: event.id,
      type: input.manifest.definitions.get(event.type)?.type ?? event.type,
      durable: {
        aggregateID: event.aggregate_id,
        seq: event.seq,
        version: input.manifest.definitions.get(event.type)?.durable?.version,
      },
      data: event.data,
    }),
  )
  return {
    events,
    hasMore: rows.length > input.limit,
  }
})

export class SubscriberOverflowError extends Schema.TaggedErrorClass<SubscriberOverflowError>()(
  "EventV2.SubscriberOverflow",
  { capacity: Schema.Int },
) {}

export const define = Event.define
export const versionedType = Event.versionedType

export interface PublishOptions {
  readonly id?: ID
  readonly metadata?: Record<string, unknown>
  readonly location?: Location.Ref
  /** Local operational projection committed atomically with a new durable event. Not replayed or serialized. */
  readonly commit?: (seq: number) => Effect.Effect<void>
}

type DurableCommitInput = {
  readonly seq: number
  readonly aggregateID: string
  readonly ownerID?: string
  readonly strictOwner?: boolean
}

type PreparedDurableEvent = {
  readonly durable: NonNullable<Definition["durable"]>
  readonly aggregateID: string
  readonly projectors: Subscriber[]
}

export interface Interface {
  readonly publish: <D extends Definition>(
    definition: D,
    data: Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Payload<D>>
  readonly subscribe: <D extends Definition>(definition: D) => Stream.Stream<Payload<D>>
  readonly all: () => Stream.Stream<Payload>
  readonly durable: (input: { readonly aggregateID: string; readonly after?: number }) => Stream.Stream<Payload>
  /** @deprecated Use `all()` and consume the returned stream. */
  readonly listen: (
    listener: Subscriber,
    options?: { readonly sync?: boolean },
  ) => Effect.Effect<Unsubscribe>
  readonly project: <D extends Definition>(definition: D, projector: Subscriber<D>) => Effect.Effect<void>
  readonly replay: (
    event: SerializedEvent,
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<void>
  readonly replayAll: (
    events: SerializedEvent[],
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<string | undefined>
  /**
   * Sync-only replay that commits event rows, sequence state, and projector database writes in one transaction.
   * Projector side effects outside the transaction cannot be rolled back. This does not publish replayed events.
   */
  readonly replayAllAtomic: (
    events: SerializedEvent[],
    options?: { readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<string | undefined>
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Event") {}

export const allBounded = (events: Interface, capacity: number) =>
  Effect.gen(function* () {
    const queue = yield* Queue.dropping<Payload, SubscriberOverflowError>(capacity)
    const unsubscribe = yield* events.listen((event) =>
      Queue.offer(queue, event).pipe(
        Effect.flatMap((accepted) =>
          accepted ? Effect.void : Queue.fail(queue, new SubscriberOverflowError({ capacity })).pipe(Effect.asVoid),
        ),
      ),
    )
    yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid))
    return Stream.fromQueue(queue)
  })

export interface LayerOptions {
  readonly beforeAggregateRead?: (aggregateID: string) => Effect.Effect<void>
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const pubsub = {
        all: yield* PubSub.unbounded<Payload>(),
        durable: new Map<string, Set<PubSub.PubSub<void>>>(),
        typed: new Map<string, PubSub.PubSub<Payload>>(),
      }
      const projectors = new Map<string, Subscriber[]>()
      // TODO: Bind durable projectors to exact type+version before supporting incompatible historical payloads.
      const listeners = new Array<Subscriber>()
      // Observer-like listeners are drained off the publisher fiber through a bounded ordered
      // mailbox; unlike sync listeners they may drop under overload (see notify/listen below).
      const observers = new Array<Subscriber>()
      const OBSERVER_CAPACITY = 1024
      const observerQueue = yield* Queue.dropping<Payload>(OBSERVER_CAPACITY)
      const DURABLE_PAGE = 100
      const { db } = yield* Database.Service

      const getOrCreate = (definition: Definition) =>
        Effect.gen(function* () {
          const existing = pubsub.typed.get(definition.type)
          if (existing) return existing
          const created = yield* PubSub.unbounded<Payload>()
          pubsub.typed.set(definition.type, created)
          return created
        })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* PubSub.shutdown(pubsub.all)
          yield* Effect.forEach(
            pubsub.durable.values(),
            (pubsubs) => Effect.forEach(pubsubs, PubSub.shutdown, { discard: true }),
            { discard: true },
          )
          yield* Effect.forEach(pubsub.typed.values(), PubSub.shutdown, { discard: true })
          yield* Queue.shutdown(observerQueue)
        }),
      )

      function prepareDurableEvent(definition: Definition, event: Payload, input?: DurableCommitInput) {
        return Effect.gen(function* () {
          const durable = definition?.durable
          if (!durable) return
          const aggregateID = (event.data as Record<string, unknown>)[durable.aggregate]
          if (typeof aggregateID !== "string") {
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: event.type,
                message: `Expected string aggregate field ${durable.aggregate}`,
              }),
            )
          }
          if (input && input.aggregateID !== aggregateID) {
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: event.type,
                message: `Aggregate mismatch: expected ${input.aggregateID}, got ${aggregateID}`,
              }),
            )
          }
          return { durable, aggregateID, projectors: projectors.get(event.type) ?? [] }
        })
      }

      function commitDurableEventInTransaction(
        definition: Definition,
        event: Payload,
        prepared: PreparedDurableEvent,
        input?: DurableCommitInput,
        commit?: (seq: number) => Effect.Effect<void>,
      ) {
        return Effect.gen(function* () {
          const row = yield* db
            .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
            .from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, prepared.aggregateID))
            .get()
            .pipe(Effect.orDie)
          const latest = row?.seq ?? -1
          const encoded = Schema.encodeUnknownSync(definition.data)(event.data) as Record<string, unknown>
          if (input?.strictOwner && row?.ownerID && row.ownerID !== input.ownerID) {
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: event.type,
                message: `Replay owner mismatch for aggregate ${prepared.aggregateID}: expected ${row.ownerID}, got ${input.ownerID ?? "none"}`,
              }),
            )
          }
          if (input && input.seq <= latest) {
            const stored = yield* db
              .select()
              .from(EventTable)
              .where(and(eq(EventTable.aggregate_id, prepared.aggregateID), eq(EventTable.seq, input.seq)))
              .get()
              .pipe(Effect.orDie)
            if (
              stored?.id === event.id &&
              stored.type === versionedType(definition.type, prepared.durable.version) &&
              isDeepStrictEqual(stored.data, encoded)
            ) {
              if (input.ownerID && row?.ownerID == null) {
                yield* db
                  .update(EventSequenceTable)
                  .set({ owner_id: input.ownerID })
                  .where(eq(EventSequenceTable.aggregate_id, prepared.aggregateID))
                  .run()
                  .pipe(Effect.orDie)
              }
              return
            }
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: event.type,
                message: `Replay diverged at aggregate ${prepared.aggregateID} sequence ${input.seq}`,
              }),
            )
          }
          if (input && row?.ownerID && row.ownerID !== input.ownerID) return
          const seq = input?.seq ?? latest + 1
          if (input && seq !== latest + 1) {
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: event.type,
                message: `Sequence mismatch for aggregate ${prepared.aggregateID}: expected ${latest + 1}, got ${seq}`,
              }),
            )
          }
          const stored = input
            ? yield* db
                .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
                .from(EventTable)
                .where(eq(EventTable.id, event.id))
                .get()
                .pipe(Effect.orDie)
            : undefined
          if (stored)
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: event.type,
                message: `Event ${event.id} already exists at aggregate ${stored.aggregateID} sequence ${stored.seq}`,
              }),
            )
          const committed = {
            ...event,
            durable: { aggregateID: prepared.aggregateID, seq, version: prepared.durable.version },
          } as Payload
          for (const projector of prepared.projectors) {
            yield* projector(committed)
          }
          if (commit) yield* commit(seq)
          yield* db
            .insert(EventSequenceTable)
            .values([{ aggregate_id: prepared.aggregateID, seq, owner_id: input?.ownerID }])
            .onConflictDoUpdate({
              target: EventSequenceTable.aggregate_id,
              set: {
                seq,
                ...(input?.ownerID && row?.ownerID == null ? { owner_id: input.ownerID } : {}),
              },
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(EventTable)
            .values([
              {
                id: event.id,
                aggregate_id: prepared.aggregateID,
                seq,
                type: versionedType(definition.type, prepared.durable.version),
                data: encoded,
              },
            ])
            .run()
            .pipe(
              // Fresh publishes omit the event-id lookup above, so a duplicate id surfaces here
              // as an insert conflict. Re-check by id (the same authoritative check the
              // removed pre-SELECT performed) to reproduce the replay error message; any other
              // insert failure is die'd unchanged.
              Effect.catch((error) =>
                Effect.gen(function* () {
                  const existing = yield* db
                    .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
                    .from(EventTable)
                    .where(eq(EventTable.id, event.id))
                    .get()
                    .pipe(Effect.orDie)
                  if (existing)
                    return yield* Effect.die(
                      new InvalidDurableEventError({
                        type: event.type,
                        message: `Event ${event.id} already exists at aggregate ${existing.aggregateID} sequence ${existing.seq}`,
                      }),
                    )
                  return yield* Effect.die(error)
                }),
              ),
              Effect.orDie,
            )
          return { aggregateID: prepared.aggregateID, seq }
        })
      }

      function wakeDurable(aggregateID: string) {
        return Effect.forEach(pubsub.durable.get(aggregateID) ?? [], (wake) => PubSub.publish(wake, undefined), {
          discard: true,
        })
      }

      function commitDurableEvent(
        definition: Definition,
        event: Payload,
        input?: DurableCommitInput,
        commit?: (seq: number) => Effect.Effect<void>,
      ) {
        return Effect.gen(function* () {
          const prepared = yield* prepareDurableEvent(definition, event, input)
          if (!prepared) return
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const committed = yield* db
                .transaction(() => commitDurableEventInTransaction(definition, event, prepared, input, commit), {
                  behavior: "immediate",
                })
                .pipe(Effect.orDie)
              if (committed) yield* wakeDurable(committed.aggregateID)
              return committed
            }),
          )
        })
      }

      function publishEvent<D extends Definition>(definition: D, event: Payload<D>, commit?: PublishOptions["commit"]) {
        return Effect.gen(function* () {
          if (!definition?.durable && commit)
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: event.type,
                message: "Local commit hooks require a durable event",
              }),
            )
          if (definition?.durable) {
            const committed = yield* commitDurableEvent(definition, event as Payload, undefined, commit)
            if (committed) {
              event = {
                ...event,
                durable: {
                  aggregateID: committed.aggregateID,
                  seq: committed.seq,
                  version: definition.durable.version,
                },
              }
              yield* notify(event as Payload, true)
              return event
            }
          }
          yield* notify(event as Payload, false)
          return event
        })
      }

      const observe = (event: Payload, observer: (event: Payload) => Effect.Effect<void>) =>
        Effect.suspend(() => observer(event)).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logError("Event listener failed", { eventID: event.id, eventType: event.type, cause }),
          ),
        )

      function notify(event: Payload, isolateListeners: boolean) {
        return Effect.gen(function* () {
          if (event.type === Event.Compacted.type) return
          yield* Effect.forEach(
            listeners,
            (listener) => (isolateListeners ? observe(event, listener) : listener(event)),
            { discard: true },
          )
          // Observer listeners are enqueued and drained off the publisher fiber; a full mailbox drops.
          yield* Queue.offer(observerQueue, event).pipe(
            Effect.flatMap((accepted) =>
              accepted ? Effect.void : Effect.logWarning("Event observer mailbox overflow; event dropped"),
            ),
          )
          const typed = pubsub.typed.get(event.type)
          if (typed) yield* PubSub.publish(typed, event)
          yield* PubSub.publish(pubsub.all, event)
        })
      }

      yield* Queue.take(observerQueue)
        .pipe(
          Effect.flatMap((event) =>
            Effect.forEach(observers, (observer) => observe(event, observer), { discard: true }),
          ),
          Effect.forever,
        )
        .pipe(Effect.forkScoped)

      function publish<D extends Definition>(definition: D, data: Data<D>, options?: PublishOptions) {
        return Effect.gen(function* () {
          const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
          const location =
            options?.location ??
            (serviceLocation
              ? { directory: serviceLocation.directory, workspaceID: serviceLocation.workspaceID }
              : undefined)
          return yield* publishEvent(
            definition,
            {
              id: options?.id ?? ID.create(),
              ...(options?.metadata ? { metadata: options.metadata } : {}),
              type: definition.type,
              ...(location ? { location } : {}),
              data,
            } as Payload<D>,
            options?.commit,
          )
        })
      }

      function replay(
        event: SerializedEvent,
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const definition = Durable.get(event.type)
          if (!definition?.durable) {
            yield* Effect.die(
              new InvalidDurableEventError({ type: event.type, message: `Unknown durable event type ${event.type}` }),
            )
          } else {
            const payload = {
              id: event.id,
              type: definition.type,
              data: Schema.decodeUnknownSync(definition.data)(event.data),
            } as Payload
            const committed = yield* commitDurableEvent(definition, payload, {
              seq: event.seq,
              aggregateID: event.aggregateID,
              ownerID: options?.ownerID,
              strictOwner: options?.strictOwner,
            })
            if (committed && options?.publish) {
              yield* notify(
                {
                  ...payload,
                  durable: {
                    aggregateID: committed.aggregateID,
                    seq: committed.seq,
                    version: definition.durable.version,
                  },
                },
                true,
              )
            }
          }
        })
      }

      function validateReplayAll(events: SerializedEvent[]) {
        return Effect.gen(function* () {
          const source = events[0]?.aggregateID
          if (!source) return undefined
          if (events.some((event) => event.aggregateID !== source)) {
            yield* Effect.die(
              new InvalidDurableEventError({
                type: events[0]?.type ?? "unknown",
                message: "Replay events must belong to the same aggregate",
              }),
            )
          }
          const start = events[0]?.seq ?? 0
          for (const [index, event] of events.entries()) {
            const seq = start + index
            if (event.seq !== seq) {
              yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: `Replay sequence mismatch at index ${index}: expected ${seq}, got ${event.seq}`,
                }),
              )
            }
          }
          return source
        })
      }

      function replayAll(
        events: SerializedEvent[],
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const source = yield* validateReplayAll(events)
          if (!source) return undefined
          for (const event of events) {
            yield* replay(event, options)
          }
          return source
        })
      }

      function replayAllAtomic(
        events: SerializedEvent[],
        options?: { readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const source = yield* validateReplayAll(events)
          if (!source) return undefined

          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const inserted = yield* db
                .transaction(
                  () =>
                    Effect.gen(function* () {
                      let inserted = false
                      for (const event of events) {
                        const definition = Durable.get(event.type)
                        if (!definition?.durable) {
                          return yield* Effect.die(
                            new InvalidDurableEventError({
                              type: event.type,
                              message: `Unknown durable event type ${event.type}`,
                            }),
                          )
                        }
                        const payload = {
                          id: event.id,
                          type: definition.type,
                          data: Schema.decodeUnknownSync(definition.data)(event.data),
                        } as Payload
                        const input = {
                          seq: event.seq,
                          aggregateID: event.aggregateID,
                          ownerID: options?.ownerID,
                          strictOwner: options?.strictOwner,
                        }
                        const prepared = yield* prepareDurableEvent(definition, payload, input)
                        if (!prepared) continue
                        const committed = yield* commitDurableEventInTransaction(definition, payload, prepared, input)
                        if (committed) inserted = true
                      }
                      return inserted
                    }),
                  { behavior: "immediate" },
                )
                .pipe(Effect.orDie)
              if (inserted) yield* wakeDurable(source)
              return source
            }),
          )
        })
      }

      function remove(aggregateID: string) {
        return db
          .transaction(() =>
            Effect.gen(function* () {
              yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run()
              yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run()
            }),
          )
          .pipe(Effect.orDie)
      }

      function claim(aggregateID: string, ownerID: string) {
        return db
          .update(EventSequenceTable)
          .set({ owner_id: ownerID })
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .run()
          .pipe(Effect.orDie)
      }

      const subscribe = <D extends Definition>(definition: D): Stream.Stream<Payload<D>> =>
        Stream.unwrap(getOrCreate(definition).pipe(Effect.map((pubsub) => Stream.fromPubSub(pubsub)))).pipe(
          Stream.map((event) => event as Payload<D>),
        )

      const streamAll = (): Stream.Stream<Payload> => Stream.fromPubSub(pubsub.all)

      const readAfter = (aggregateID: string, after: number, limit: number) =>
        (options?.beforeAggregateRead?.(aggregateID) ?? Effect.void).pipe(
          Effect.andThen(
            db
              .select()
              .from(EventTable)
              .where(and(eq(EventTable.aggregate_id, aggregateID), gt(EventTable.seq, after)))
              .orderBy(asc(EventTable.seq))
              .limit(limit + 1)
              .all(),
          ),
          Effect.orDie,
          Effect.map((rows) => {
            const page = rows.slice(0, limit)
            return {
              events: page.map((event) =>
                decodeSerializedEvent({
                  id: event.id,
                  aggregateID: event.aggregate_id,
                  seq: event.seq,
                  type: event.type,
                  data: event.data,
                }),
              ),
              hasMore: rows.length > limit,
            }
          }),
        )

      const subscribeDurable = (aggregateID: string) =>
        Effect.gen(function* () {
          const wake = yield* PubSub.sliding<void>(1)
          const subscription = yield* PubSub.subscribe(wake)
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const wakes = pubsub.durable.get(aggregateID) ?? new Set()
              wakes.add(wake)
              pubsub.durable.set(aggregateID, wakes)
            }),
            () =>
              Effect.sync(() => {
                const wakes = pubsub.durable.get(aggregateID)
                wakes?.delete(wake)
                if (wakes?.size === 0) pubsub.durable.delete(aggregateID)
              }).pipe(Effect.andThen(PubSub.shutdown(wake))),
          )
          return subscription
        })

      const durable = (input: { readonly aggregateID: string; readonly after?: number }): Stream.Stream<Payload> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const wakes = yield* subscribeDurable(input.aggregateID)
            let sequence = input.after ?? -1
            // Bounded, lazily-paginated reads so large aggregates stream incrementally instead of
            // loading all remaining events in one query.
            const pageStream = (startSeq: number): Stream.Stream<Payload> =>
              Stream.paginate(startSeq, (after) =>
                readAfter(input.aggregateID, after, DURABLE_PAGE).pipe(
                  Effect.tap(({ events }) =>
                    Effect.sync(() => {
                      sequence = events.at(-1)?.durable?.seq ?? sequence
                    }),
                  ),
                  Effect.map(({ events }) =>
                    events.length === 0
                      ? ([events, Option.none<number>()] as const)
                      : ([events, Option.some(events.at(-1)!.durable!.seq)] as const),
                  ),
                ),
              )
            const historical = pageStream(input.after ?? -1)
            const live = Stream.fromSubscription(wakes).pipe(Stream.flatMap(() => pageStream(sequence)))
            return Stream.concat(historical, live)
          }),
        )

      const listen = (listener: Subscriber, options?: { readonly sync?: boolean }): Effect.Effect<Unsubscribe> => {
        const sync = options?.sync !== false
        return Effect.sync(() => {
          const target = sync ? listeners : observers
          target.push(listener)
          return Effect.sync(() => {
            const index = target.indexOf(listener)
            if (index >= 0) target.splice(index, 1)
          })
        })
      }

      const project = <D extends Definition>(definition: D, projector: Subscriber<D>): Effect.Effect<void> =>
        Effect.sync(() => {
          const list = projectors.get(definition.type) ?? []
          list.push((event) => projector(event as Payload<D>))
          projectors.set(definition.type, list)
        })

      return Service.of({
        publish,
        subscribe,
        all: streamAll,
        durable,
        listen,
        project,
        replay,
        replayAll,
        replayAllAtomic,
        remove,
        claim,
      })
    }),
  )

const layer = layerWith()
export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Database.node] })
