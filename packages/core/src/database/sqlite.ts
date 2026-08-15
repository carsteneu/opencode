export * as Sqlite from "./sqlite"

import { Context, Duration, Effect, Schedule } from "effect"
import type { drizzle } from "drizzle-orm/bun-sqlite"
import type { SqlError } from "effect/unstable/sql/SqlError"

export type DrizzleClient = ReturnType<typeof drizzle>
export class Native extends Context.Service<Native, unknown>()("@opencode-ai/core/database/SqliteNative") {}
export class Drizzle extends Context.Service<Drizzle, DrizzleClient>()("@opencode-ai/core/database/SqliteDrizzle") {}

const lockedStatementSchedule = Schedule.exponential(Duration.millis(25)).pipe(Schedule.jittered)

// Native SQLite busy handlers block the JavaScript event loop. A BUSY/LOCKED
// statement has not completed, so retry only that statement and keep whole
// transactions under their existing ownership and rollback semantics.
function retryLocked<A, R>(effect: Effect.Effect<A, SqlError, R>) {
  return effect.pipe(
    Effect.retry({
      schedule: lockedStatementSchedule,
      times: 6,
      while: (error) => error.reason._tag === "LockTimeoutError",
    }),
  )
}

export function retryLockedStatement<A, R>(
  effect: Effect.Effect<A, SqlError, R>,
  input: { readonly query: string; readonly inTransaction: boolean },
) {
  if (!input.inTransaction || /^\s*(?:COMMIT|END)(?:\s+TRANSACTION)?\s*;?\s*$/i.test(input.query)) {
    return retryLocked(effect)
  }
  return effect
}
