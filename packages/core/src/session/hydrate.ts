export * as SessionHydrate from "./hydrate"

import { Effect, Schema } from "effect"
import { inArray } from "drizzle-orm"
import { Database } from "../database/database"
import { SessionMessage } from "./message"
import { SessionMessageContentTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const decodeContent = Schema.decodeUnknownSync(SessionMessage.AssistantContent)

/**
 * Loads every assistant content segment for the given messages, ordered by its
 * creation sequence so segments reassemble in append order. The write path
 * stores each content item (text/tool/reasoning) in its own row keyed by
 * (message_id, item_id), so a single event only rewrites one segment instead
 * of the whole growing assistant projection.
 */
export function contentByMessage(
  db: DatabaseService,
  messageIDs: readonly SessionMessage.ID[],
): Effect.Effect<Map<string, SessionMessage.AssistantContent[]>> {
  return Effect.gen(function* () {
    const content = new Map<string, SessionMessage.AssistantContent[]>()
    const ids = Array.from(new Set(messageIDs))
    if (ids.length === 0) return content
    const rows = yield* db
      .select()
      .from(SessionMessageContentTable)
      .where(inArray(SessionMessageContentTable.message_id, ids))
      .orderBy(SessionMessageContentTable.seq)
      .all()
      .pipe(Effect.orDie)
    for (const row of rows) {
      const item = decodeContent(row.data)
      const list = content.get(row.message_id)
      if (list) list.push(item)
      else content.set(row.message_id, [item])
    }
    return content
  })
}

export function withContent(
  message: SessionMessage.Message,
  content: readonly SessionMessage.AssistantContent[] | undefined,
): SessionMessage.Message {
  return message.type === "assistant" ? { ...message, content: content ?? [] } : message
}

/**
 * Decodes a batch of message rows, hydrating assistant content segments in a
 * single query. Preserves row order.
 */
export function hydrateRows<T extends { readonly id: string; readonly type: string }, E>(
  db: DatabaseService,
  rows: readonly T[],
  decode: (row: T) => Effect.Effect<SessionMessage.Message, E>,
): Effect.Effect<SessionMessage.Message[], E> {
  return Effect.gen(function* () {
    const content = yield* contentByMessage(
      db,
      rows.filter((row) => row.type === "assistant").map((row) => row.id) as SessionMessage.ID[],
    )
    return yield* Effect.forEach(rows, (row) =>
      decode(row).pipe(Effect.map((message) => withContent(message, content.get(row.id)))),
    )
  })
}
