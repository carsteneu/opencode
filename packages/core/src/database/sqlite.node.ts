import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { LockRetry } from "./lock-retry.js"

export const supportsTuningPragmas = true

// Foreign keys default ON in node:sqlite and can be toggled per connection.
export const supportsForeignKeyToggle = true

// Opening the database can only fail on a broken file or a lock held past
// busyTimeout; Database.layer treats both as fatal. Locked statements are retried
// cooperatively instead, so the busy handler never runs (see LockRetry).
export const sqliteLayer = (config: SqliteClient.SqliteClientConfig): Layer.Layer<SqlClient.SqlClient> =>
  Layer.provide(
    Layer.effect(SqlClient.SqlClient, Effect.map(SqlClient.SqlClient, LockRetry.client)),
    Layer.orDie(SqliteClient.layer(config)),
  )

// node:sqlite has no error class: SQLite failures are an Error marked ERR_SQLITE_ERROR that carries SQLite's extended
// result code in errcode.
const decodeDriverError = Schema.decodeUnknownOption(
  Schema.Struct({ code: Schema.Literal("ERR_SQLITE_ERROR"), errcode: Schema.Number }),
)

export const resultCode = (cause: unknown) =>
  decodeDriverError(cause).pipe(
    Option.map((error) => error.errcode),
    Option.getOrUndefined,
  )
