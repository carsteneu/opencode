import { Workspace } from "@/control-plane/workspace"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventTable } from "@opencode-ai/core/event/sql"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { asc } from "drizzle-orm"
import { and } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { gt } from "drizzle-orm"
import { Effect, Scope } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
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
      const ownerID = yield* InstanceState.workspaceID
      yield* events.replayAll(payload, { ownerID, strictOwner: true })
      if (ctx.payload.messageDiffs) {
        if (ctx.payload.messageDiffs.sessionID !== source) return yield* new HttpApiError.BadRequest({})
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
      const instance = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const sessions = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(
          workspaceID ? eq(SessionTable.workspace_id, workspaceID) : eq(SessionTable.project_id, instance.project.id),
        )
        .all()
        .pipe(Effect.orDie)
      return yield* Effect.forEach(
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
      .handle("messageDiffs", messageDiffs)
      .handle("messageDiffManifest", messageDiffManifest)
      .handle("materializeMessageDiffs", materializeMessageDiffs)
  }),
)
