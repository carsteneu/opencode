import { Workspace } from "@/control-plane/workspace"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { WorkspaceSyncProtocol } from "@/control-plane/sync-protocol"
import { asc } from "drizzle-orm"
import { and } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { gt } from "drizzle-orm"
import { gte } from "drizzle-orm"
import { lte } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { Effect, Scope } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { HttpServerResponse } from "effect/unstable/http"
import { InstanceHttpApi } from "../api"
import { HistoryPayload, MessageDiffManifestPayload, ReplayPayload, SessionPayload } from "../groups/sync"

export const syncHandlers = HttpApiBuilder.group(InstanceHttpApi, "sync", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const session = yield* Session.Service
    const summary = yield* SessionSummary.Service
    const prompt = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope
    const events = yield* EventV2Bridge.Service
    const messageDiff = yield* MessageDiff.Service
    const { db } = yield* Database.Service

    const historyScope = Effect.fnUntraced(function* () {
      const workspaceID = yield* InstanceState.workspaceID
      if (workspaceID) return eq(SessionTable.workspace_id, workspaceID)
      return eq(SessionTable.project_id, (yield* InstanceState.context).project.id)
    })

    const start = Effect.fn("SyncHttpApi.start")(function* () {
      yield* workspace
        .startWorkspaceSyncing((yield* InstanceState.context).project.id)
        .pipe(Effect.ignore, Effect.forkIn(scope))
      return true
    })

    const replay = Effect.fn("SyncHttpApi.replay")(function* (ctx: { payload: typeof ReplayPayload.Type }) {
      const payload: EventV2.SerializedEvent[] = ctx.payload.events.map((event) => ({
        id: event.id,
        aggregateID: event.aggregateID,
        seq: event.seq,
        type: event.type,
        data: { ...event.data },
      }))
      const source = payload[0].aggregateID
      yield* Effect.logInfo("sync replay requested", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
        directory: ctx.payload.directory,
      })
      if (ctx.payload.messageDiffs && ctx.payload.messageDiffs.sessionID !== source)
        return yield* new HttpApiError.BadRequest({})
      const ownerID = yield* InstanceState.workspaceID
      yield* events.replayAllAtomic(payload, { ownerID, strictOwner: true })
      if (ctx.payload.messageDiffs) {
        yield* messageDiff.replace(ctx.payload.messageDiffs)
      }
      yield* Effect.logInfo("sync replay complete", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
      })
      return { sessionID: source }
    })

    const steal = Effect.fn("SyncHttpApi.steal")(function* (ctx: { payload: typeof SessionPayload.Type }) {
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID) return yield* new HttpApiError.BadRequest({})

      yield* session.setWorkspace({ sessionID: ctx.payload.sessionID, workspaceID })

      yield* Effect.logInfo("sync session stolen", { sessionID: ctx.payload.sessionID, workspaceID })

      return { sessionID: ctx.payload.sessionID }
    })

    const history = Effect.fn("SyncHttpApi.history")(function* (ctx: { payload: typeof HistoryPayload.Type }) {
      const sessions = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(yield* historyScope())
        .all()
        .pipe(Effect.orDie)
      const result = yield* Effect.forEach(
        sessions,
        (session) =>
          db
            .select()
            .from(EventTable)
            .where(and(eq(EventTable.aggregate_id, session.id), gt(EventTable.seq, ctx.payload[session.id] ?? -1)))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie),
        { concurrency: 8 },
      ).pipe(Effect.map((pages) => pages.flat()))
      return HttpServerResponse.jsonUnsafe(result, { headers: { "Cache-Control": "no-transform" } })
    })

    const historyV2 = Effect.fn("SyncHttpApi.historyV2")(function* (ctx: {
      payload: typeof WorkspaceSyncProtocol.HistoryRequest.Type
    }) {
      const payload = ctx.payload
      if (payload.type === "manifest") {
        const state = payload.state
        const rows = yield* db
          .select({ aggregateID: SessionTable.id, head: EventSequenceTable.seq })
          .from(SessionTable)
          .innerJoin(EventSequenceTable, eq(EventSequenceTable.aggregate_id, SessionTable.id))
          .where(yield* historyScope())
          .orderBy(asc(SessionTable.id))
          .all()
          .pipe(Effect.orDie)
        return HttpServerResponse.jsonUnsafe(
          {
            type: "manifest" as const,
            aggregates: rows.flatMap((row) => {
              const after = state[row.aggregateID]
              if (after !== undefined && after >= row.head) return []
              return [{ aggregateID: row.aggregateID, head: row.head, ...(after === undefined ? {} : { after }) }]
            }),
          },
          { headers: { "Cache-Control": "no-transform" } },
        )
      }

      const aggregateID = payload.aggregateID
      const head = payload.head
      const after = payload.after ?? -1
      if (after >= head)
        return HttpServerResponse.jsonUnsafe(
          { type: "page" as const, aggregateID, events: [] },
          { headers: { "Cache-Control": "no-transform" } },
        )
      const page = yield* db
        .transaction(() =>
          Effect.gen(function* () {
            const exists = yield* db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(and(eq(SessionTable.id, aggregateID), yield* historyScope()))
              .get()
            if (!exists) return { events: [], hasMore: false, oversized: undefined }
            // Measure stored JSON before decoding it so a page of large events never enters the JS heap at once.
            const metadata = yield* db
              .select({
                seq: EventTable.seq,
                bytes: sql<number>`length(cast(${EventTable.data} as blob)) + length(cast(${EventTable.id} as blob)) + length(cast(${EventTable.aggregate_id} as blob)) + length(cast(${EventTable.type} as blob)) + 64`,
              })
              .from(EventTable)
              .where(
                and(eq(EventTable.aggregate_id, aggregateID), gt(EventTable.seq, after), lte(EventTable.seq, head)),
              )
              .orderBy(asc(EventTable.seq))
              .limit(WorkspaceSyncProtocol.HISTORY_PAGE_EVENTS + 1)
              .all()
            const selected = boundedHistorySequences(metadata)
            const first = selected[0]
            if (!first) return { events: [], hasMore: false, oversized: undefined }
            if (first.bytes > WorkspaceSyncProtocol.HISTORY_RESPONSE_BYTES - 64 * 1024)
              return { events: [], hasMore: false, oversized: first }
            const last = selected.at(-1)
            if (!last) return { events: [], hasMore: false, oversized: undefined }
            const events = yield* db
              .select()
              .from(EventTable)
              .where(
                and(
                  eq(EventTable.aggregate_id, aggregateID),
                  gte(EventTable.seq, first.seq),
                  lte(EventTable.seq, last.seq),
                ),
              )
              .orderBy(asc(EventTable.seq))
              .all()
            return { events, hasMore: metadata.length > selected.length, oversized: undefined }
          }),
        )
        .pipe(Effect.orDie)
      if (page.oversized) {
        yield* Effect.logWarning("sync history event exceeds response limit", {
          aggregateID,
          seq: page.oversized.seq,
          bytes: page.oversized.bytes,
        })
        return yield* new HttpApiError.BadRequest({})
      }
      const next = page.hasMore ? page.events.at(-1)?.seq : undefined
      return HttpServerResponse.jsonUnsafe(
        {
          type: "page" as const,
          aggregateID,
          events: page.events,
          ...(next === undefined ? {} : { next }),
        },
        { headers: { "Cache-Control": "no-transform" } },
      )
    })

    const messageDiffs = Effect.fn("SyncHttpApi.messageDiffs")(function* (ctx: {
      payload: ReadonlyArray<MessageDiff.Selection>
    }) {
      return yield* Effect.forEach(ctx.payload, (selection) =>
        messageDiff.list(selection).pipe(
          Effect.map((rows) => ({
            sessionID: selection.sessionID,
            messageIDs: selection.messageIDs,
            rows,
          })),
        ),
      )
    })

    const messageDiffManifest = Effect.fn("SyncHttpApi.messageDiffManifest")(function* (ctx: {
      payload: typeof MessageDiffManifestPayload.Type
    }) {
      return yield* messageDiff.manifest(ctx.payload)
    })

    const materializeMessageDiffs = Effect.fn("SyncHttpApi.materializeMessageDiffs")(function* (ctx: {
      payload: typeof SessionPayload.Type
    }) {
      yield* prompt.cancel(ctx.payload.sessionID)
      const missing = yield* summary.materializeSession(ctx.payload)
      if (missing.length) {
        yield* Effect.logWarning("session warp message diffs are unavailable", {
          sessionID: ctx.payload.sessionID,
          messageIDs: missing,
        })
        return yield* new HttpApiError.BadRequest({})
      }
      return {
        sessionID: ctx.payload.sessionID,
        rows: yield* messageDiff.list({ sessionID: ctx.payload.sessionID }),
      }
    })

    return handlers
      .handle("start", start)
      .handle("replay", replay)
      .handle("steal", steal)
      .handle("history", history)
      .handle("historyV2", historyV2)
      .handle("messageDiffs", messageDiffs)
      .handle("messageDiffManifest", messageDiffManifest)
      .handle("materializeMessageDiffs", materializeMessageDiffs)
  }),
)

function boundedHistorySequences(rows: ReadonlyArray<{ seq: number; bytes: number }>) {
  const events: { seq: number; bytes: number }[] = []
  let bytes = 2
  for (const row of rows) {
    const size = row.bytes + (events.length > 0 ? 1 : 0)
    if (events.length > 0 && bytes + size > WorkspaceSyncProtocol.HISTORY_PAGE_BYTES) break
    events.push(row)
    bytes += size
    if (events.length >= WorkspaceSyncProtocol.HISTORY_PAGE_EVENTS) break
  }
  return events
}
