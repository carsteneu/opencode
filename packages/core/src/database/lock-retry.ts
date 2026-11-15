export * as LockRetry from "./lock-retry.js"

import { Duration, Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"

// A locked statement has not run, so retrying it cannot apply anything twice.
// SQLite's busy handler would block the whole event loop for seconds instead, so
// the retry waits on a schedule that yields and other fibers keep running.
export const LOCK_RETRY_ATTEMPTS = 6

const MAX = LOCK_RETRY_ATTEMPTS

const isLock = (error: SqlError) => (error as { reason?: { _tag?: string } })?.reason?._tag === "LockTimeoutError"

// A hand-rolled loop rather than Effect.retry: retry catches the whole cause to decide, and a
// defect that races a stop has been observed to survive only as an interrupt through it. catchIf
// touches typed errors alone, so a die or an interrupt keeps its identity.
const attempt = <A>(effect: Effect.Effect<A, SqlError>, remaining: number): Effect.Effect<A, SqlError> =>
  Effect.catchIf(effect, isLock, (error) =>
    remaining <= 1
      ? Effect.fail(error)
      : Effect.sleep(Duration.millis(25 * 2 ** (MAX - remaining) * (0.5 + Math.random()))).pipe(
          Effect.andThen(attempt(effect, remaining - 1)),
        ),
  )

export const retry = <A>(effect: Effect.Effect<A, SqlError>) => attempt(effect, MAX)

const isEffect = (value: unknown): value is Effect.Effect<unknown, SqlError> =>
  typeof value === "object" && value !== null && typeof (value as { pipe?: unknown }).pipe === "function"

// The entry points that run SQL on a connection directly.
const STATEMENT_METHODS = new Set([
  "execute",
  "executeRaw",
  "executeValues",
  "executeValuesUnprepared",
  "executeUnprepared",
])

// What a statement exposes as the query itself, as opposed to its compilation and its
// stream, which must stay untouched.
const STATEMENT_RESULTS = new Set(["raw", "withoutTransform", "values", "valuesUnprepared", "unprepared"])

// A retried statement is still one statement: a transaction keeps its own ownership and
// rollback semantics, so a statement inside one is not retried on its own.
const statement = <A extends object>(self: A): A => {
  const view = self as Record<PropertyKey, unknown>
  return new Proxy(self, {
    get(target, property) {
      const value = view[property]
      if (typeof property === "string" && STATEMENT_RESULTS.has(property) && isEffect(value)) return retry(value)
      return value
    },
  })
}

export const client = (base: SqlClient.SqlClient): SqlClient.SqlClient => {
  const view = base as unknown as Record<PropertyKey, unknown>
  const wrapped: SqlClient.SqlClient = new Proxy(base, {
    // The client is itself callable: `sql`…`` builds a statement the same way.
    apply(target, _, args) {
      return statement((target as (...input: ReadonlyArray<unknown>) => object)(...args))
    },
    get(target, property) {
      if (property === "withoutTransforms") return () => wrapped
      const value = view[property]
      // `safe` is the same client with row transforms stripped; statements built on it run
      // the same SQL and deserve the same retry.
      if (property === "safe") return client(value as SqlClient.SqlClient)
      if (typeof value !== "function") return value
      // Drizzle builds every query with `client.unsafe(sql, params)` and then runs one of
      // the statement's effect properties, so the retry has to sit on the statement.
      if (property === "unsafe")
        return (...args: ReadonlyArray<unknown>) =>
          statement((value as (...input: ReadonlyArray<unknown>) => object)(...args))
      if (typeof property === "string" && STATEMENT_METHODS.has(property))
        return (...args: ReadonlyArray<unknown>) =>
          retry((value as (...input: ReadonlyArray<unknown>) => Effect.Effect<unknown, SqlError>)(...args))
      return value
    },
  })
  return wrapped
}
