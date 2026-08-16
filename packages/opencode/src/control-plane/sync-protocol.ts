import { EventV2 } from "@opencode-ai/core/event"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { SessionID } from "@/session/schema"

export const HISTORY_PAGE_EVENTS = 256
export const HISTORY_PAGE_BYTES = 1024 * 1024
export const HISTORY_RESPONSE_BYTES = 64 * 1024 * 1024
export const HISTORY_PATH = "/sync/history"
export const HISTORY_V2_PATH = "/sync/history/v2"

export const HistoryState = Schema.Record(Schema.String, NonNegativeInt)

export const HistoryEvent = Schema.Struct({
  id: EventV2.ID,
  aggregate_id: Schema.String,
  seq: NonNegativeInt,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})

export const HistoryManifestRequest = Schema.Struct({
  type: Schema.Literal("manifest"),
  state: HistoryState,
})

export const HistoryPageRequest = Schema.Struct({
  type: Schema.Literal("page"),
  aggregateID: SessionID,
  head: NonNegativeInt,
  after: Schema.optional(NonNegativeInt),
})

export const HistoryRequest = Schema.Union([HistoryManifestRequest, HistoryPageRequest])

export const HistoryManifestResponse = Schema.Struct({
  type: Schema.Literal("manifest"),
  aggregates: Schema.Array(
    Schema.Struct({
      aggregateID: SessionID,
      head: NonNegativeInt,
      after: Schema.optional(NonNegativeInt),
    }),
  ),
})

export const HistoryPageResponse = Schema.Struct({
  type: Schema.Literal("page"),
  aggregateID: SessionID,
  events: Schema.Array(HistoryEvent),
  next: Schema.optional(NonNegativeInt),
})

export const HistoryResponse = Schema.Union([HistoryManifestResponse, HistoryPageResponse])

export * as WorkspaceSyncProtocol from "./sync-protocol"
