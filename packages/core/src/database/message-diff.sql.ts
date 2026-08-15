import { sql } from "drizzle-orm"
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import type { MessageID } from "../v1/session"
import { MessageTable } from "../session/sql"

export const MessageDiffTable = sqliteTable(
  "message_diff",
  {
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .primaryKey()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    from_snapshot: text(),
    to_snapshot: text(),
    revision: text().notNull(),
    data: text({ mode: "json" }).notNull().$type<ReadonlyArray<FileDiff.Info>>(),
  },
  (table) => [check("message_diff_message_id_not_null", sql`${table.message_id} IS NOT NULL`)],
)
