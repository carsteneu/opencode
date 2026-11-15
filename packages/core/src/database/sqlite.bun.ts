import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { LockRetry } from "./lock-retry.js"

export const supportsTuningPragmas = true

// Foreign keys default OFF and can be toggled per connection.
export const supportsForeignKeyToggle = true

// Opening the database can only fail on a broken file or a lock held past
// busyTimeout; Database.layer treats both as fatal. Locked statements are retried
// cooperatively instead, so the busy handler never runs (see LockRetry).
export const sqliteLayer = (config: SqliteClient.SqliteClientConfig): Layer.Layer<SqlClient.SqlClient> =>
  Layer.provide(
    Layer.effect(SqlClient.SqlClient, Effect.map(SqlClient.SqlClient, LockRetry.client)),
    Layer.orDie(SqliteClient.layer(config)),
  )
