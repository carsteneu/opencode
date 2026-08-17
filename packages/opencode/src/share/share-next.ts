import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import type * as SDK from "@opencode-ai/sdk/v2"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Effect, Exit, Layer, Option, Schema, Scope, Context } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Account } from "@/account/account"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionSummary } from "@/session/summary"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionID } from "@/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { and, eq, inArray } from "drizzle-orm"
import { Config } from "@/config/config"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2 } from "@opencode-ai/core/event"

const disabled = process.env["OPENCODE_DISABLE_SHARE"] === "true" || process.env["OPENCODE_DISABLE_SHARE"] === "1"

// Bounds keep a session's incremental share queue and its sync HTTP retries from
// growing/looping without limit. Read lazily (not at module load) so they are
// testable and overrideable at runtime.
const boundNumber = (key: string, fallback: number) => {
  const raw = process.env[key]
  const value = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const maxQueueItems = () => boundNumber("OPENCODE_SHARE_MAX_QUEUE_ITEMS", 100_000)
const maxQueueBytes = () => boundNumber("OPENCODE_SHARE_MAX_QUEUE_BYTES", 64 * 1024 * 1024)
const syncTimeoutMs = () => boundNumber("OPENCODE_SHARE_SYNC_TIMEOUT_MS", 30_000)
const maxSyncAttempts = () => boundNumber("OPENCODE_SHARE_MAX_ATTEMPTS", 5)

export type Api = {
  create: string
  sync: (shareID: string) => string
  remove: (shareID: string) => string
  data: (shareID: string) => string
}

export type Req = {
  headers: Record<string, string>
  api: Api
  baseUrl: string
}

const ShareSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  secret: Schema.String,
})
export type Share = typeof ShareSchema.Type

type State = {
  queue: Map<SessionID, Map<string, Data>>
  flushing: Set<SessionID>
  scope: Scope.Closeable
  shared: Map<SessionID, Share | null>
  directory: string
  reconciled: boolean
  // Sessions pending a canonical full resync (queue overflow / exhausted retries).
  dirty: Set<SessionID>
  // In-progress full resyncs, guards against dirty->full recusion.
  full: Set<SessionID>
  // Consecutive flush failures per session, for bounded retry.
  attempts: Map<SessionID, number>
}

type Data =
  | {
      type: "session"
      data: SDK.Session
    }
  | {
      type: "message"
      data: SDK.Message
    }
  | {
      type: "part"
      data: SDK.Part
    }
  | {
      type: "session_diff"
      data: SDK.SnapshotFileDiff[]
    }
  | {
      type: "model"
      data: SDK.Model[]
    }

export interface Interface {
  readonly init: () => Effect.Effect<void, unknown>
  readonly url: () => Effect.Effect<string, unknown>
  readonly request: () => Effect.Effect<Req, unknown>
  readonly create: (sessionID: SessionID) => Effect.Effect<Share, unknown>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShareNext") {}

export const use = serviceUse(Service)

function api(resource: string): Api {
  return {
    create: `/api/${resource}`,
    sync: (shareID) => `/api/${resource}/${shareID}/sync`,
    remove: (shareID) => `/api/${resource}/${shareID}`,
    data: (shareID) => `/api/${resource}/${shareID}/data`,
  }
}

const legacyApi = api("share")
const consoleApi = api("shares")

function key(item: Data) {
  switch (item.type) {
    case "session":
      return "session"
    case "message":
      return `message/${item.data.id}`
    case "part":
      return `part/${item.data.messageID}/${item.data.id}`
    case "session_diff":
      return "session_diff"
    case "model":
      return "model"
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const account = yield* Account.Service
    const events = yield* EventV2Bridge.Service
    const cfg = yield* Config.Service
    const { db } = yield* Database.Service
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)
    const provider = yield* Provider.Service
    const session = yield* Session.Service
    const summary = yield* SessionSummary.Service
    const messageDiffs = yield* MessageDiff.Service

      function scheduleFlush(sessionID: SessionID, retry = false): Effect.Effect<void> {
        return Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          const attempt = s.attempts.get(sessionID) ?? 0
          const baseDelay = retry ? Math.min(1_000 * 2 ** attempt, 30_000) : 1_000
          // Jittered exponential backoff so a burst of failing sessions does not stampede.
          const delay = retry ? baseDelay * (0.5 + Math.random() * 0.5) : 1_000
          yield* flush(sessionID).pipe(
            Effect.delay({ milliseconds: delay }),
            Effect.catchCause((cause) => Effect.logError("share flush failed", { sessionID: sessionID, cause: cause })),
            Effect.forkIn(s.scope),
          )
        })
      }

      const queueBytes = (queue: Map<string, Data>) => {
        let bytes = 0
        for (const item of queue.values()) {
          try {
            bytes += JSON.stringify(item.data).length
          } catch {
            bytes += 1024
          }
        }
        return bytes
      }

      function sync(sessionID: SessionID, data: Data[]) {
        return Effect.gen(function* () {
          if (disabled) return
          const share = yield* getCached(sessionID)
          if (!share) return

          const s = yield* InstanceState.get(state)
          const existing = s.queue.get(sessionID)
          if (existing) {
            for (const item of data) {
              existing.set(key(item), item)
            }
            // Overflow bounds the incremental backlog: drop it and mark the session for a
            // canonical full resync instead of growing without limit.
            if (!s.full.has(sessionID) && (existing.size > maxQueueItems() || queueBytes(existing) > maxQueueBytes())) {
              s.queue.delete(sessionID)
              s.attempts.delete(sessionID)
              s.dirty.add(sessionID)
              yield* scheduleFlush(sessionID)
            }
            return
          }

          const next = new Map(data.map((item) => [key(item), item]))
          s.queue.set(sessionID, next)
          yield* scheduleFlush(sessionID)
        })
      }

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("ShareNext.state")(function* (_ctx) {
          const cache: State = {
            queue: new Map(),
            flushing: new Set(),
            scope: yield* Scope.make(),
            shared: new Map(),
            directory: _ctx.directory,
            reconciled: false,
            dirty: new Set(),
            full: new Set(),
            attempts: new Map(),
          }

          yield* Effect.addFinalizer(() =>
            Scope.close(cache.scope, Exit.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  cache.queue.clear()
                  cache.flushing.clear()
                  cache.shared.clear()
                  cache.dirty.clear()
                  cache.full.clear()
                  cache.attempts.clear()
                }),
              ),
            ),
          )

        if (disabled) return cache

        const watch = <D extends EventV2.Definition>(
          def: D,
          fn: (data: EventV2.Data<D>) => Effect.Effect<void, unknown>,
        ) =>
          events.listen((event) => {
            if (event.type !== def.type || event.location?.directory !== _ctx.directory) return Effect.void
            return fn(event.data as EventV2.Data<D>).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("share subscriber failed", { type: def.type, cause: cause }),
              ),
            )
          })

        yield* watch(Session.Event.Updated, (data) =>
          Effect.gen(function* () {
            const info = data.info
            yield* sync(info.id, [{ type: "session", data: structuredClone(info) as SDK.Session }])
          }),
        )
        yield* watch(MessageV2.Event.Updated, (data) =>
          Effect.gen(function* () {
            const info = data.info
            yield* sync(info.sessionID, [{ type: "message", data: structuredClone(info) as SDK.Message }])
            if (info.role !== "user") return
            const model = yield* provider.getModel(info.model.providerID, info.model.modelID)
            yield* sync(info.sessionID, [{ type: "model", data: [model] }])
          }),
        )
        yield* watch(Session.Event.DiffUpdated, (data) =>
          Effect.gen(function* () {
            if (!(yield* getCached(data.sessionID))) return
            const row = yield* db
              .select()
              .from(MessageTable)
              .where(and(eq(MessageTable.session_id, data.sessionID), eq(MessageTable.id, data.messageID)))
              .get()
              .pipe(Effect.orDie)
            if (!row) return
            const info = yield* summary.hydrate({
              ...row.data,
              id: row.id,
              sessionID: row.session_id,
            } as SessionV1.Info)
            yield* sync(data.sessionID, [{ type: "message", data: info as SDK.Message }])
          }),
        )
        yield* watch(MessageV2.Event.PartUpdated, (data) =>
          sync(data.part.sessionID, [{ type: "part", data: structuredClone(data.part) as SDK.Part }]),
        )
        yield* watch(Session.Event.Diff, (data) =>
          sync(data.sessionID, [{ type: "session_diff", data: structuredClone(data.diff) as SDK.SnapshotFileDiff[] }]),
        )
        yield* watch(Session.Event.Deleted, (data) => remove(data.sessionID))

        return cache
      }),
    )

    const request = Effect.fn("ShareNext.request")(function* () {
      const headers: Record<string, string> = {}
      const active = yield* account.active()
      if (Option.isNone(active) || !active.value.active_org_id) {
        const baseUrl = (yield* cfg.get()).enterprise?.url ?? "https://opncd.ai"
        return { headers, api: legacyApi, baseUrl } satisfies Req
      }

      const token = yield* account.token(active.value.id)
      if (Option.isNone(token)) {
        throw new Error("No active account token available for sharing")
      }

      headers.authorization = `Bearer ${token.value}`
      headers["x-org-id"] = active.value.active_org_id
      return { headers, api: consoleApi, baseUrl: active.value.url } satisfies Req
    })

    const get = Effect.fnUntraced(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(SessionShareTable)
        .where(eq(SessionShareTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return { id: row.id, secret: row.secret, url: row.url } satisfies Share
    })

    const getCached = Effect.fnUntraced(function* (sessionID: SessionID) {
      const s = yield* InstanceState.get(state)
      if (s.shared.has(sessionID)) {
        const cached = s.shared.get(sessionID)
        return cached === null ? undefined : cached
      }

      const share = yield* get(sessionID)
      s.shared.set(sessionID, share ?? null)
      return share
    })

      const flush: (sessionID: SessionID) => Effect.Effect<void> = Effect.fn("ShareNext.flush")(function* (
        sessionID: SessionID,
      ) {
        if (disabled) return
        const s = yield* InstanceState.get(state)
        if (s.flushing.has(sessionID)) return

        // A dirty session resyncs its canonical state instead of churning an unbounded
        // incremental backlog. full() re-enqueues everything; the recursion guard keeps a
        // too-large canonical payload from dirty-looping against the queue bound.
        if (s.dirty.has(sessionID)) {
          if (s.full.has(sessionID)) return
          s.full.add(sessionID)
          s.dirty.delete(sessionID)
          s.queue.delete(sessionID)
          s.attempts.delete(sessionID)
          yield* full(sessionID).pipe(
            Effect.catchCause((cause) => Effect.logWarning("dirty share full resync failed", { sessionID: sessionID, cause: cause })),
            Effect.ensuring(Effect.sync(() => s.full.delete(sessionID))),
          )
          return
        }

        const queued = s.queue.get(sessionID)
        if (!queued) return

        s.queue.delete(sessionID)
        s.flushing.add(sessionID)
        const requeue = () => {
          const pending = s.queue.get(sessionID)
          // Values queued while this request was in flight are newer and must win on duplicate keys.
          s.queue.set(sessionID, new Map([...queued, ...(pending ?? [])]))
        }
        const giveUp = () => {
          s.queue.delete(sessionID)
          s.dirty.add(sessionID)
        }
        const fail = (cause: unknown): Effect.Effect<boolean> =>
          Effect.gen(function* () {
            const attempt = (s.attempts.get(sessionID) ?? 0) + 1
            s.attempts.set(sessionID, attempt)
            if (attempt >= maxSyncAttempts()) {
              giveUp()
              yield* Effect.logWarning("share sync gave up after repeated failures, marking dirty", {
                sessionID: sessionID,
                attempts: attempt,
                cause: cause,
              })
              return true
            }
            requeue()
            yield* Effect.logError("share sync failed", { sessionID: sessionID, attempts: attempt, cause: cause })
            return true
          })

        yield* Effect.gen(function* () {
          const result = yield* Effect.exit(
            Effect.gen(function* () {
              const share = yield* getCached(sessionID)
              if (!share) return { sent: false as const }
              const req = yield* request()
              const res = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.sync(share.id)}`).pipe(
                HttpClientRequest.setHeaders(req.headers),
                HttpClientRequest.bodyJson({ secret: share.secret, data: Array.from(queued.values()) }),
                Effect.flatMap((r) => http.execute(r)),
                // A hung remote must not block a session's flush forever; timing out
                // interrupts the request and surfaces as a failure -> bounded retry.
                Effect.timeout(syncTimeoutMs()),
              )
              return { sent: true as const, share, res }
            }),
          )

          if (Exit.isFailure(result)) return yield* fail(result.cause)
          if (!result.value.sent) return false
          if (result.value.res.status >= 200 && result.value.res.status < 300) {
            s.attempts.delete(sessionID)
            return false
          }

          return yield* fail({ status: result.value.res.status, shareID: result.value.share.id })
        }).pipe(Effect.ensuring(Effect.sync(() => s.flushing.delete(sessionID))))

        if (!s.queue.has(sessionID)) return
        yield* scheduleFlush(sessionID, true)
      })

      const full = Effect.fn("ShareNext.full")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("full sync", { sessionID: sessionID })
      const info = yield* session.get(sessionID)
      const diffs = yield* session.diff(sessionID)
      const messages = yield* session.messages({ sessionID })
      const hydrated = yield* summary.hydrateMessages(messages)
      const models = yield* Effect.forEach(
        Array.from(
          new Map(
            messages
              .filter((msg) => msg.info.role === "user")
              .map((msg) => (msg.info as SDK.UserMessage).model)
              .map((item) => [`${item.providerID}/${item.modelID}`, item] as const),
          ).values(),
        ),
        (item) => provider.getModel(ProviderV2.ID.make(item.providerID), ModelV2.ID.make(item.modelID)),
        { concurrency: 8 },
      )

      yield* sync(sessionID, [
        { type: "session", data: info },
        ...hydrated.map((item) => ({ type: "message" as const, data: item.info })),
        ...messages.flatMap((item) => item.parts.map((part) => ({ type: "part" as const, data: part }))),
        { type: "session_diff", data: diffs },
        { type: "model", data: models },
      ])
    })

    const init = Effect.fn("ShareNext.init")(function* () {
      if (disabled) return
      const s = yield* InstanceState.get(state)
      if (s.reconciled) return

      const shares = yield* db
        .select({
          sessionID: SessionTable.id,
          id: SessionShareTable.id,
          secret: SessionShareTable.secret,
          url: SessionShareTable.url,
        })
        .from(SessionShareTable)
        .innerJoin(SessionTable, eq(SessionTable.id, SessionShareTable.session_id))
        .where(eq(SessionTable.directory, s.directory))
        .all()
        .pipe(Effect.orDie)

      yield* Effect.forEach(
        shares,
        (share) =>
          Effect.gen(function* () {
            s.shared.set(share.sessionID, { id: share.id, secret: share.secret, url: share.url })
            const diffs = yield* messageDiffs.list({ sessionID: share.sessionID })
            if (!diffs.length) return

            const rows = yield* db
              .select()
              .from(MessageTable)
              .where(
                and(
                  eq(MessageTable.session_id, share.sessionID),
                  inArray(
                    MessageTable.id,
                    diffs.map((diff) => diff.messageID),
                  ),
                ),
              )
              .all()
              .pipe(Effect.orDie)
            const messages = yield* Effect.forEach(
              rows,
              (row) =>
                summary.hydrate({
                  ...row.data,
                  id: row.id,
                  sessionID: row.session_id,
                } as SessionV1.Info),
              { concurrency: 8 },
            )
            yield* sync(
              share.sessionID,
              messages.map((message) => ({ type: "message" as const, data: message as SDK.Message })),
            )
          }),
        { concurrency: 4 },
      )
      s.reconciled = true
    })

    const url = Effect.fn("ShareNext.url")(function* () {
      return (yield* request()).baseUrl
    })

    const create = Effect.fn("ShareNext.create")(function* (sessionID: SessionID) {
      if (disabled) return { id: "", url: "", secret: "" }
      yield* Effect.logInfo("creating share", { sessionID: sessionID })
      const req = yield* request()
      const result = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.create}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ sessionID }),
        Effect.flatMap((r) => httpOk.execute(r)),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ShareSchema)),
      )
      yield* db
        .insert(SessionShareTable)
        .values({ session_id: sessionID, id: result.id, secret: result.secret, url: result.url })
        .onConflictDoUpdate({
          target: SessionShareTable.session_id,
          set: { id: result.id, secret: result.secret, url: result.url },
        })
        .run()
        .pipe(Effect.orDie)
      const s = yield* InstanceState.get(state)
      s.shared.set(sessionID, result)
      yield* full(sessionID).pipe(
        Effect.catchCause((cause) => Effect.logError("share full sync failed", { sessionID: sessionID, cause: cause })),
        Effect.forkIn(s.scope),
      )
      return result
    })

    const remove = Effect.fn("ShareNext.remove")(function* (sessionID: SessionID) {
      if (disabled) return
      yield* Effect.logInfo("removing share", { sessionID: sessionID })
      const s = yield* InstanceState.get(state)
      const share = yield* getCached(sessionID)
      if (!share) {
        s.shared.delete(sessionID)
        s.queue.delete(sessionID)
        return
      }

      const req = yield* request()
      yield* HttpClientRequest.delete(`${req.baseUrl}${req.api.remove(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: share.secret }),
        Effect.flatMap((r) => httpOk.execute(r)),
      )

      yield* db.delete(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).run().pipe(Effect.orDie)
      s.shared.delete(sessionID)
      s.queue.delete(sessionID)
    })

    return Service.of({ init, url, request, create, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Account.node,
    EventV2Bridge.node,
    Config.node,
    Database.node,
    httpClient,
    Provider.node,
    Session.node,
    SessionSummary.node,
    MessageDiff.node,
  ],
})

export * as ShareNext from "./share-next"
