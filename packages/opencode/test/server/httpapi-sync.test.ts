import { afterEach, describe, expect, mock } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { SyncPaths } from "../../src/server/routes/instance/httpapi/groups/sync"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { WorkspaceSyncProtocol } from "../../src/control-plane/sync-protocol"
import { Session } from "@/session/session"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import { MessageID, SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideTmpdirInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const context = Context.empty() as Context.Context<unknown>
const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, MessageDiff.node, Database.node])), httpApiLayer),
)

function appendHistoryEvents(input: {
  aggregateID: string
  start: number
  count: number
  data: (seq: number) => Record<string, unknown>
}) {
  return Database.Service.use(({ db }) =>
    Effect.gen(function* () {
      const rows = Array.from({ length: input.count }, (_, index) => {
        const seq = input.start + index
        return {
          id: EventV2.ID.make(`evt_history_${input.aggregateID}_${seq}`),
          aggregate_id: input.aggregateID,
          seq,
          type: "session.updated.1",
          data: input.data(seq),
        }
      })
      yield* db.insert(EventTable).values(rows).run().pipe(Effect.orDie)
      yield* db
        .update(EventSequenceTable)
        .set({ seq: input.start + input.count - 1 })
        .where(eq(EventSequenceTable.aggregate_id, input.aggregateID))
        .run()
        .pipe(Effect.orDie)
    }),
  )
}

afterEach(async () => {
  mock.restore()
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("sync HttpApi", () => {
  it.instance(
    "serves sync routes",
    () =>
      Effect.gen(function* () {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync" })
        const messageID = MessageID.ascending()
        yield* Session.use.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
          summary: {
            diffs: [{ file: "sync.ts", patch: "portable patch", additions: 1, deletions: 0, status: "modified" }],
          },
        } satisfies SessionV1.User)

        const started = yield* requestInDirectory(SyncPaths.start, tmp.directory, { method: "POST", headers })
        expect(started.status).toBe(200)
        expect(yield* started.json).toBe(true)

        const history = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(history.status).toBe(200)
        const rows = (yield* history.json) as Array<{
          id: string
          aggregate_id: string
          seq: number
          type: string
          data: Record<string, unknown>
        }>
        expect(rows.map((row) => row.aggregate_id)).toContain(session.id)

        const manifestResponse = yield* requestInDirectory(SyncPaths.messageDiffManifest, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify([session.id]),
        })
        expect(manifestResponse.status).toBe(200)
        const manifest = (yield* manifestResponse.json) as MessageDiff.Manifest[]
        expect(manifest).toEqual([{ sessionID: session.id, rows: [{ messageID, revision: expect.any(String) }] }])
        expect(manifest[0]?.rows[0]?.revision).not.toBe("")

        const messageDiffResponse = yield* requestInDirectory(SyncPaths.messageDiffs, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify([{ sessionID: session.id, messageIDs: [messageID] }]),
        })
        expect(messageDiffResponse.status).toBe(200)
        const snapshots = (yield* messageDiffResponse.json) as MessageDiff.Snapshot[]
        expect(snapshots[0]?.rows[0]).toMatchObject({
          messageID,
          revision: manifest[0]?.rows[0]?.revision,
          diffs: [{ file: "sync.ts", patch: "portable patch" }],
        })
        const materializedResponse = yield* requestInDirectory(SyncPaths.materializeMessageDiffs, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(materializedResponse.status).toBe(200)
        expect(yield* materializedResponse.json).toEqual({ sessionID: session.id, rows: snapshots[0]?.rows })
        const messageDiff = yield* MessageDiff.Service
        yield* messageDiff.remove(messageID)

        const replayed = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: rows
              .filter((row) => row.aggregate_id === session.id)
              .map((row) => ({
                id: row.id,
                aggregateID: row.aggregate_id,
                seq: row.seq,
                type: row.type,
                data: row.data,
              })),
            messageDiffs: snapshots[0],
          }),
        })
        expect(replayed.status).toBe(200)
        expect(yield* replayed.json).toEqual({ sessionID: session.id })
        expect(yield* messageDiff.get(messageID, session.id)).toMatchObject({
          diffs: [{ file: "sync.ts", patch: "portable patch" }],
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live("scopes history routes to the current project and accepts large fence maps", () =>
    Effect.gen(function* () {
      const foreign = yield* provideTmpdirInstance(
        () => Session.use.create({ title: "foreign history" }).pipe(Effect.map((session) => session.id)),
        { git: true, config: { formatter: false, lsp: false } },
      )

      yield* provideTmpdirInstance(
        (directory) =>
          Effect.gen(function* () {
            const local = yield* Session.use.create({ title: "local history" })
            const response = yield* requestInDirectory(SyncPaths.history, directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(
                Object.fromEntries(Array.from({ length: 1_100 }, (_, index) => [`unknown-${index}`, 0])),
              ),
            })

            expect(response.status).toBe(200)
            const rows = (yield* response.json) as Array<{ aggregate_id: string }>
            expect(rows.some((row) => row.aggregate_id === local.id)).toBe(true)
            expect(rows.some((row) => row.aggregate_id === foreign)).toBe(false)

            const manifestResponse = yield* requestInDirectory(SyncPaths.historyV2, directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                type: "manifest",
                state: Object.fromEntries(Array.from({ length: 1_100 }, (_, index) => [`unknown-${index}`, 0])),
              }),
            })
            expect(manifestResponse.status).toBe(200)
            const manifest = (yield* manifestResponse.json) as {
              type: "manifest"
              aggregates: Array<{ aggregateID: string }>
            }
            expect(manifest.aggregates.some((item) => item.aggregateID === local.id)).toBe(true)
            expect(manifest.aggregates.some((item) => item.aggregateID === foreign)).toBe(false)
          }),
        { git: true, config: { formatter: false, lsp: false } },
      )
    }),
  )

  it.instance(
    "freezes manifest heads and applies fences across pages",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* Session.use.create({ title: "frozen history" })
        const headers = { "content-type": "application/json", "accept-encoding": "gzip" }
        const requestHistory = (body: unknown) =>
          requestInDirectory(SyncPaths.historyV2, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          })

        const firstResponse = yield* requestHistory({ type: "manifest", state: {} })
        expect(firstResponse.status).toBe(200)
        const first = (yield* firstResponse.json) as typeof WorkspaceSyncProtocol.HistoryManifestResponse.Type
        expect(first).toEqual({
          type: "manifest",
          aggregates: [{ aggregateID: session.id, head: 0 }],
        })

        yield* Session.use.setTitle({ sessionID: session.id, title: "published after manifest" })

        const frozenResponse = yield* requestHistory({
          type: "page",
          aggregateID: session.id,
          head: first.aggregates[0]?.head,
        })
        expect(frozenResponse.status).toBe(200)
        expect(frozenResponse.headers["cache-control"]).toContain("no-transform")
        expect(frozenResponse.headers["content-encoding"]).toBeUndefined()
        const frozen = (yield* frozenResponse.json) as typeof WorkspaceSyncProtocol.HistoryPageResponse.Type
        expect(frozen.aggregateID).toBe(session.id)
        expect(frozen.events.map((event) => event.seq)).toEqual([0])
        expect(frozen.next).toBeUndefined()

        const nextManifestResponse = yield* requestHistory({ type: "manifest", state: { [session.id]: 0 } })
        const nextManifest =
          (yield* nextManifestResponse.json) as typeof WorkspaceSyncProtocol.HistoryManifestResponse.Type
        expect(nextManifest).toEqual({
          type: "manifest",
          aggregates: [{ aggregateID: session.id, head: 1, after: 0 }],
        })

        const nextPageResponse = yield* requestHistory({
          type: "page",
          aggregateID: session.id,
          head: 1,
          after: 0,
        })
        const nextPage = (yield* nextPageResponse.json) as typeof WorkspaceSyncProtocol.HistoryPageResponse.Type
        expect(nextPage.events.map((event) => event.seq)).toEqual([1])
        expect(nextPage.next).toBeUndefined()

        const caughtUpResponse = yield* requestHistory({ type: "manifest", state: { [session.id]: 1 } })
        expect(yield* caughtUpResponse.json).toEqual({ type: "manifest", aggregates: [] })

        const removed = yield* Session.use.create({ title: "removed after manifest" })
        const removedManifestResponse = yield* requestHistory({ type: "manifest", state: { [session.id]: 1 } })
        const removedManifest =
          (yield* removedManifestResponse.json) as typeof WorkspaceSyncProtocol.HistoryManifestResponse.Type
        expect(removedManifest.aggregates).toEqual([{ aggregateID: removed.id, head: 0 }])
        yield* Session.use.remove(removed.id)
        const removedPageResponse = yield* requestHistory({
          type: "page",
          aggregateID: removed.id,
          head: 0,
        })
        expect(removedPageResponse.status).toBe(200)
        expect(yield* removedPageResponse.json).toEqual({
          type: "page",
          aggregateID: removed.id,
          events: [],
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "caps history pages by event count",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* Session.use.create({ title: "count bounded history" })
        yield* appendHistoryEvents({
          aggregateID: session.id,
          start: 1,
          count: WorkspaceSyncProtocol.HISTORY_PAGE_EVENTS + 1,
          data: (seq) => ({ seq }),
        })
        const headers = { "content-type": "application/json" }
        const firstResponse = yield* requestInDirectory(SyncPaths.historyV2, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            type: "page",
            aggregateID: session.id,
            head: WorkspaceSyncProtocol.HISTORY_PAGE_EVENTS + 1,
            after: 0,
          }),
        })
        const first = (yield* firstResponse.json) as typeof WorkspaceSyncProtocol.HistoryPageResponse.Type
        expect(first.events).toHaveLength(WorkspaceSyncProtocol.HISTORY_PAGE_EVENTS)
        expect(first.events.at(0)?.seq).toBe(1)
        expect(first.events.at(-1)?.seq).toBe(WorkspaceSyncProtocol.HISTORY_PAGE_EVENTS)
        expect(first.next).toBe(WorkspaceSyncProtocol.HISTORY_PAGE_EVENTS)

        const secondResponse = yield* requestInDirectory(SyncPaths.historyV2, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            type: "page",
            aggregateID: session.id,
            head: WorkspaceSyncProtocol.HISTORY_PAGE_EVENTS + 1,
            after: first.next,
          }),
        })
        const second = (yield* secondResponse.json) as typeof WorkspaceSyncProtocol.HistoryPageResponse.Type
        expect(second.events.map((event) => event.seq)).toEqual([WorkspaceSyncProtocol.HISTORY_PAGE_EVENTS + 1])
        expect(second.next).toBeUndefined()
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the history page range query on the aggregate sequence index",
    () =>
      Effect.gen(function* () {
        const session = yield* Session.use.create({ title: "history query plan" })
        const { db } = yield* Database.Service
        const plan = yield* db
          .all<{ detail: string }>(
            sql`
            EXPLAIN QUERY PLAN
            SELECT *
            FROM event
            WHERE aggregate_id = ${session.id}
              AND seq > ${0}
              AND seq <= ${WorkspaceSyncProtocol.HISTORY_PAGE_EVENTS}
            ORDER BY seq
            LIMIT ${WorkspaceSyncProtocol.HISTORY_PAGE_EVENTS + 1}
          `,
          )
          .pipe(Effect.orDie)
        const details = plan.map((row) => row.detail).join("\n")
        expect(details).toContain("event_aggregate_seq_idx")
        expect(details).not.toContain("USE TEMP B-TREE")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "caps history pages by encoded bytes while allowing one oversize event",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* Session.use.create({ title: "byte bounded history" })
        yield* appendHistoryEvents({
          aggregateID: session.id,
          start: 1,
          count: 4,
          data: (seq) => ({
            blob:
              seq === 3
                ? "x".repeat(WorkspaceSyncProtocol.HISTORY_PAGE_BYTES + 1024)
                : "x".repeat(seq < 3 ? Math.floor(WorkspaceSyncProtocol.HISTORY_PAGE_BYTES * 0.6) : 1),
          }),
        })
        const requestHistory = (after: number) =>
          requestInDirectory(SyncPaths.historyV2, tmp.directory, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "page", aggregateID: session.id, head: 4, after }),
          })

        const first = (yield* (yield* requestHistory(0)).json) as typeof WorkspaceSyncProtocol.HistoryPageResponse.Type
        expect(first.events.map((event) => event.seq)).toEqual([1])
        expect(first.next).toBe(1)
        expect(new TextEncoder().encode(JSON.stringify(first.events)).byteLength).toBeLessThanOrEqual(
          WorkspaceSyncProtocol.HISTORY_PAGE_BYTES,
        )

        const second = (yield* (yield* requestHistory(1)).json) as typeof WorkspaceSyncProtocol.HistoryPageResponse.Type
        expect(second.events.map((event) => event.seq)).toEqual([2])
        expect(second.next).toBe(2)

        const oversize = (yield* (yield* requestHistory(2))
          .json) as typeof WorkspaceSyncProtocol.HistoryPageResponse.Type
        expect(oversize.events.map((event) => event.seq)).toEqual([3])
        expect(oversize.next).toBe(3)
        expect(new TextEncoder().encode(JSON.stringify(oversize.events)).byteLength).toBeGreaterThan(
          WorkspaceSyncProtocol.HISTORY_PAGE_BYTES,
        )

        const last = (yield* (yield* requestHistory(3)).json) as typeof WorkspaceSyncProtocol.HistoryPageResponse.Type
        expect(last.events.map((event) => event.seq)).toEqual([4])
        expect(last.next).toBeUndefined()
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "validates seq values",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const cases = [
          {
            path: SyncPaths.history,
            body: { aggregate: -1 },
          },
          {
            path: SyncPaths.history,
            body: { aggregate: 1.5 },
          },
          {
            path: SyncPaths.historyV2,
            body: { type: "manifest", state: { aggregate: -1 } },
          },
          {
            path: SyncPaths.historyV2,
            body: { type: "page", aggregateID: "aggregate", head: 0 },
          },
          {
            path: SyncPaths.historyV2,
            body: { type: "page", aggregateID: "ses_invalid", head: -1 },
          },
          {
            path: SyncPaths.historyV2,
            body: { type: "page", aggregateID: "ses_invalid", head: 1, after: 1.5 },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: -1, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 1.5, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 0, type: "session.created", data: {} }],
            },
          },
        ]

        for (const item of cases) {
          const response = yield* requestInDirectory(item.path, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify(item.body),
          })
          expect(response.status).toBe(400)
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance.skip(
    "returns structured validation errors",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${SyncPaths.history}`, {
              method: "POST",
              headers: { "x-opencode-directory": tmp.directory, "content-type": "application/json" },
              body: JSON.stringify({ aggregate: -1 }),
            }),
            context,
          ),
        )

        expect(response.status).toBe(400)
        expect(response.headers.get("content-type") ?? "").toContain("application/json")
        const body = (yield* Effect.promise(() => response.json())) as Record<string, unknown>
        expect(body.success).toBe(false)
        expect(Array.isArray(body.error) || Array.isArray(body.errors)).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
