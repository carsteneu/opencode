import { NonNegativeInt } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import { SessionID } from "@/session/schema"
import { WorkspaceSyncProtocol } from "@/control-plane/sync-protocol"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/sync"
export const ReplayEvent = Schema.Struct({
  id: EventV2.ID,
  aggregateID: Schema.String,
  seq: NonNegativeInt,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})
export const ReplayPayload = Schema.Struct({
  directory: Schema.String,
  events: Schema.NonEmptyArray(ReplayEvent),
  messageDiffs: Schema.optional(MessageDiff.Snapshot),
})
export const ReplayResponse = Schema.Struct({
  sessionID: Schema.String,
})
export const SessionPayload = Schema.Struct({
  sessionID: SessionID,
})
export const HistoryPayload = WorkspaceSyncProtocol.HistoryState
export const MessageDiffManifestPayload = Schema.Array(SessionID)
export const HistoryEvent = WorkspaceSyncProtocol.HistoryEvent

export const SyncPaths = {
  start: `${root}/start`,
  replay: `${root}/replay`,
  steal: `${root}/steal`,
  history: WorkspaceSyncProtocol.HISTORY_PATH,
  historyV2: WorkspaceSyncProtocol.HISTORY_V2_PATH,
  messageDiffs: `${root}/message-diffs`,
  messageDiffManifest: `${root}/message-diffs/manifest`,
  materializeMessageDiffs: `${root}/message-diffs/materialize`,
} as const

export const SyncApi = HttpApi.make("sync")
  .add(
    HttpApiGroup.make("sync")
      .add(
        HttpApiEndpoint.post("start", SyncPaths.start, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Workspace sync started"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.start",
            summary: "Start workspace sync",
            description: "Start sync loops for workspaces in the current project that have active sessions.",
          }),
        ),
        HttpApiEndpoint.post("replay", SyncPaths.replay, {
          query: WorkspaceRoutingQuery,
          payload: ReplayPayload,
          success: described(ReplayResponse, "Replayed sync events"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.replay",
            summary: "Replay sync events",
            description: "Validate and replay a complete sync event history.",
          }),
        ),
        HttpApiEndpoint.post("steal", SyncPaths.steal, {
          query: WorkspaceRoutingQuery,
          payload: SessionPayload,
          success: described(SessionPayload, "Session stolen into workspace"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.steal",
            summary: "Steal session into workspace",
            description: "Update a session to belong to the current workspace through the sync event system.",
          }),
        ),
        HttpApiEndpoint.post("history", SyncPaths.history, {
          query: WorkspaceRoutingQuery,
          payload: HistoryPayload,
          success: described(Schema.Array(HistoryEvent), "Sync events"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.history.list",
            summary: "List sync events",
            description:
              "List sync events for all aggregates. Keys are aggregate IDs the client already knows about, values are the last known sequence ID. Events with seq > value are returned for those aggregates. Aggregates not listed in the input get their full history.",
          }),
        ),
        HttpApiEndpoint.post("historyV2", SyncPaths.historyV2, {
          query: WorkspaceRoutingQuery,
          payload: WorkspaceSyncProtocol.HistoryRequest,
          success: described(WorkspaceSyncProtocol.HistoryResponse, "Paged sync history"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.history.page",
            summary: "Page sync events",
            description: "Capture aggregate heads and page each aggregate through a fixed history snapshot.",
          }),
        ),
        HttpApiEndpoint.post("messageDiffs", SyncPaths.messageDiffs, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Array(MessageDiff.Selection),
          success: described(Schema.Array(MessageDiff.Snapshot), "Message diff snapshots"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.message-diffs.list",
            summary: "List message diff snapshots",
            description: "List authoritative side-table snapshots for workspace session synchronization.",
          }),
        ),
        HttpApiEndpoint.post("messageDiffManifest", SyncPaths.messageDiffManifest, {
          query: WorkspaceRoutingQuery,
          payload: MessageDiffManifestPayload,
          success: described(Schema.Array(MessageDiff.Manifest), "Message diff manifest"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.message-diffs.manifest",
            summary: "List message diff markers",
            description: "List lightweight revision markers for workspace side-table reconciliation.",
          }),
        ),
        HttpApiEndpoint.post("materializeMessageDiffs", SyncPaths.materializeMessageDiffs, {
          query: WorkspaceRoutingQuery,
          payload: SessionPayload,
          success: described(MessageDiff.Snapshot, "Materialized message diff snapshot"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.message-diffs.materialize",
            summary: "Materialize session message diffs",
            description: "Materialize and return a portable side-table snapshot before an explicit session warp.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "sync",
          description: "Experimental HttpApi sync routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
