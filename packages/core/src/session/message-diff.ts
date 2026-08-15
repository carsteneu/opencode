export * as MessageDiff from "./message-diff"

import { and, asc, eq, inArray } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { Database } from "../database/database"
import { MessageDiffTable } from "../database/message-diff.sql"
import { makeGlobalNode } from "../effect/app-node"
import { MessageID } from "../v1/session"
import { MessageTable } from "./sql"
import { SessionSchema } from "./schema"

export interface Row {
  readonly fromSnapshot?: string
  readonly toSnapshot?: string
  readonly diffs: ReadonlyArray<FileDiff.Info>
}

export const Entry = Schema.Struct({
  messageID: MessageID,
  revision: Schema.String,
  fromSnapshot: Schema.optional(Schema.String),
  toSnapshot: Schema.optional(Schema.String),
  diffs: Schema.Array(FileDiff.Info),
})
export type Entry = Schema.Schema.Type<typeof Entry>

export const Marker = Schema.Struct({
  messageID: MessageID,
  revision: Schema.String,
})
export type Marker = Schema.Schema.Type<typeof Marker>

export const Manifest = Schema.Struct({
  sessionID: SessionSchema.ID,
  rows: Schema.Array(Marker),
})
export type Manifest = Schema.Schema.Type<typeof Manifest>

export const Selection = Schema.Struct({
  sessionID: SessionSchema.ID,
  messageIDs: Schema.optional(Schema.Array(MessageID)),
})
export type Selection = Schema.Schema.Type<typeof Selection>

export const Snapshot = Schema.Struct({
  ...Selection.fields,
  rows: Schema.Array(Entry),
})
export type Snapshot = Schema.Schema.Type<typeof Snapshot>

export interface Interface {
  readonly put: (input: {
    readonly messageID: MessageID
    readonly fromSnapshot?: string
    readonly toSnapshot?: string
    readonly diffs: ReadonlyArray<FileDiff.Info>
  }) => Effect.Effect<void>
  readonly get: (messageID: MessageID, sessionID?: SessionSchema.ID) => Effect.Effect<Row | undefined>
  readonly remove: (messageID: MessageID) => Effect.Effect<void>
  readonly copy: (input: {
    readonly fromMessageID: MessageID
    readonly toMessageID: MessageID
  }) => Effect.Effect<boolean>
  readonly list: (input: Selection) => Effect.Effect<Entry[]>
  readonly manifest: (sessionIDs: ReadonlyArray<SessionSchema.ID>) => Effect.Effect<Manifest[]>
  readonly replace: (input: Snapshot) => Effect.Effect<Array<{ messageID: MessageID; present: boolean }>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/MessageDiff") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const put: Interface["put"] = Effect.fn("MessageDiff.put")(function* (input) {
      const data = [...input.diffs]
      const revision = crypto.randomUUID()
      yield* db
        .insert(MessageDiffTable)
        .values({
          message_id: input.messageID,
          from_snapshot: input.fromSnapshot ?? null,
          to_snapshot: input.toSnapshot ?? null,
          revision,
          data,
        })
        .onConflictDoUpdate({
          target: MessageDiffTable.message_id,
          set: {
            from_snapshot: input.fromSnapshot ?? null,
            to_snapshot: input.toSnapshot ?? null,
            revision,
            data,
          },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const get: Interface["get"] = Effect.fn("MessageDiff.get")(function* (messageID, sessionID) {
      const query = db
        .select({
          from_snapshot: MessageDiffTable.from_snapshot,
          to_snapshot: MessageDiffTable.to_snapshot,
          data: MessageDiffTable.data,
        })
        .from(MessageDiffTable)
        .innerJoin(MessageTable, eq(MessageTable.id, MessageDiffTable.message_id))
      const row = yield* query
        .where(
          sessionID
            ? and(eq(MessageDiffTable.message_id, messageID), eq(MessageTable.session_id, sessionID))
            : eq(MessageDiffTable.message_id, messageID),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return {
        fromSnapshot: row.from_snapshot ?? undefined,
        toSnapshot: row.to_snapshot ?? undefined,
        diffs: [...row.data],
      }
    })

    const remove: Interface["remove"] = Effect.fn("MessageDiff.remove")(function* (messageID) {
      yield* db.delete(MessageDiffTable).where(eq(MessageDiffTable.message_id, messageID)).run().pipe(Effect.orDie)
    })

    const copy: Interface["copy"] = Effect.fn("MessageDiff.copy")(function* (input) {
      return yield* db
        .transaction(() =>
          Effect.gen(function* () {
            const source = yield* get(input.fromMessageID)
            if (!source) return false
            yield* put({
              messageID: input.toMessageID,
              fromSnapshot: source.fromSnapshot,
              toSnapshot: source.toSnapshot,
              diffs: source.diffs,
            })
            return true
          }),
        )
        .pipe(Effect.orDie)
    })

    const list: Interface["list"] = Effect.fn("MessageDiff.list")(function* (input) {
      if (input.messageIDs?.length === 0) return []
      const rows = yield* db
        .select({
          messageID: MessageDiffTable.message_id,
          revision: MessageDiffTable.revision,
          fromSnapshot: MessageDiffTable.from_snapshot,
          toSnapshot: MessageDiffTable.to_snapshot,
          diffs: MessageDiffTable.data,
        })
        .from(MessageDiffTable)
        .innerJoin(MessageTable, eq(MessageTable.id, MessageDiffTable.message_id))
        .where(
          and(
            eq(MessageTable.session_id, input.sessionID),
            input.messageIDs ? inArray(MessageDiffTable.message_id, input.messageIDs) : undefined,
          ),
        )
        .orderBy(asc(MessageDiffTable.message_id))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        messageID: row.messageID,
        revision: row.revision,
        fromSnapshot: row.fromSnapshot ?? undefined,
        toSnapshot: row.toSnapshot ?? undefined,
        diffs: [...row.diffs],
      }))
    })

    const manifest: Interface["manifest"] = Effect.fn("MessageDiff.manifest")(function* (sessionIDs) {
      if (!sessionIDs.length) return []
      const rows = yield* db
        .select({
          sessionID: MessageTable.session_id,
          messageID: MessageDiffTable.message_id,
          revision: MessageDiffTable.revision,
        })
        .from(MessageDiffTable)
        .innerJoin(MessageTable, eq(MessageTable.id, MessageDiffTable.message_id))
        .where(inArray(MessageTable.session_id, sessionIDs))
        .orderBy(asc(MessageTable.session_id), asc(MessageDiffTable.message_id))
        .all()
        .pipe(Effect.orDie)
      const grouped = Map.groupBy(rows, (row) => row.sessionID)
      return sessionIDs.map((sessionID) => ({
        sessionID,
        rows: (grouped.get(sessionID) ?? []).map((row) => ({ messageID: row.messageID, revision: row.revision })),
      }))
    })

    const replace: Interface["replace"] = Effect.fn("MessageDiff.replace")(function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (input.messageIDs?.length === 0) {
              if (input.rows.length) return yield* Effect.die("A targeted empty selection cannot contain diff rows")
              return []
            }
            const messages = yield* tx
              .select({ id: MessageTable.id })
              .from(MessageTable)
              .where(
                and(
                  eq(MessageTable.session_id, input.sessionID),
                  input.messageIDs ? inArray(MessageTable.id, input.messageIDs) : undefined,
                ),
              )
              .all()
            const valid = new Set(messages.map((message) => message.id))
            if (input.rows.some((row) => !valid.has(row.messageID)))
              return yield* Effect.die("A message diff row does not belong to the selected session")

            const previous = messages.length
              ? yield* tx
                  .select({ id: MessageDiffTable.message_id })
                  .from(MessageDiffTable)
                  .where(
                    inArray(
                      MessageDiffTable.message_id,
                      messages.map((message) => message.id),
                    ),
                  )
                  .all()
              : []
            if (messages.length)
              yield* tx
                .delete(MessageDiffTable)
                .where(
                  inArray(
                    MessageDiffTable.message_id,
                    messages.map((message) => message.id),
                  ),
                )
                .run()
            if (input.rows.length)
              yield* tx
                .insert(MessageDiffTable)
                .values(
                  input.rows.map((row) => ({
                    message_id: row.messageID,
                    from_snapshot: row.fromSnapshot ?? null,
                    to_snapshot: row.toSnapshot ?? null,
                    revision: row.revision,
                    data: [...row.diffs],
                  })),
                )
                .run()
            const present = new Set(input.rows.map((row) => row.messageID))
            return [...new Set([...previous.map((row) => row.id), ...present])].map((messageID) => ({
              messageID,
              present: present.has(messageID),
            }))
          }),
        )
        .pipe(Effect.orDie)
    })

    return Service.of({ put, get, remove, copy, list, manifest, replace })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
