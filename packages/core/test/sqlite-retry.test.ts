import { expect } from "bun:test"
import { Deferred, Duration, Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import { SqlError } from "effect/unstable/sql"
import { Sqlite } from "@opencode-ai/core/database/sqlite"
import { it } from "./lib/effect"

const locked = new SqlError.SqlError({
  reason: new SqlError.LockTimeoutError({ cause: new Error("database is locked") }),
})

it.effect("retries only six times when a SQLite lock remains held", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const result = yield* Sqlite.retryLockedStatement(
      Ref.update(attempts, (value) => value + 1).pipe(Effect.andThen(Effect.fail(locked))),
      { query: "INSERT INTO item VALUES (1)", inTransaction: false },
    ).pipe(Effect.flip, Effect.forkChild)

    yield* Effect.yieldNow
    yield* TestClock.adjust(Duration.seconds(3))

    expect(yield* Ref.get(attempts)).toBe(7)
    expect(yield* Fiber.join(result)).toBe(locked)
  }),
)

it.effect("does not retry non-lock SQLite errors", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const failure = new SqlError.SqlError({
      reason: new SqlError.UnknownError({ cause: new Error("invalid statement") }),
    })
    const result = yield* Sqlite.retryLockedStatement(
      Ref.update(attempts, (value) => value + 1).pipe(Effect.andThen(Effect.fail(failure))),
      { query: "INSERT INTO item VALUES (1)", inTransaction: false },
    ).pipe(Effect.flip)

    expect(yield* Ref.get(attempts)).toBe(1)
    expect(result).toBe(failure)
  }),
)

it.effect("does not retry a locked statement inside an explicit transaction", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const result = yield* Sqlite.retryLockedStatement(
      Ref.update(attempts, (value) => value + 1).pipe(Effect.andThen(Effect.fail(locked))),
      { query: "UPDATE item SET value = 1", inTransaction: true },
    ).pipe(Effect.flip)

    expect(yield* Ref.get(attempts)).toBe(1)
    expect(result).toBe(locked)
  }),
)

it.effect("retries a locked commit while its transaction remains active", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const result = yield* Sqlite.retryLockedStatement(
      Ref.update(attempts, (value) => value + 1).pipe(Effect.andThen(Effect.fail(locked))),
      { query: "COMMIT", inTransaction: true },
    ).pipe(Effect.flip, Effect.forkChild)

    yield* Effect.yieldNow
    yield* TestClock.adjust(Duration.seconds(3))

    expect(yield* Ref.get(attempts)).toBe(7)
    expect(yield* Fiber.join(result)).toBe(locked)
  }),
)

it.effect("interrupts a cooperative SQLite retry during backoff", () =>
  Effect.gen(function* () {
    const attempted = yield* Deferred.make<void>()
    const attempts = yield* Ref.make(0)
    const retry = yield* Sqlite.retryLockedStatement(
      Ref.update(attempts, (value) => value + 1).pipe(
        Effect.andThen(Deferred.succeed(attempted, undefined)),
        Effect.andThen(Effect.fail(locked)),
      ),
      { query: "INSERT INTO item VALUES (1)", inTransaction: false },
    ).pipe(Effect.forkChild)

    yield* Deferred.await(attempted)
    yield* Fiber.interrupt(retry)
    yield* TestClock.adjust(Duration.seconds(3))

    expect(yield* Ref.get(attempts)).toBe(1)
  }),
)
