import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { LockTimeoutError, SqlError, UnknownError } from "effect/sql/SqlError"
import { Sqlite } from "@opencode/core/database/sqlite"
import { classifyNodeSqliteError } from "@opencode/core/database/sqlite.node"

const locked = () =>
  new SqlError({
    reason: new LockTimeoutError({ cause: new Error("database is locked"), message: "database is locked", operation: "execute" }),
  })
const unrelated = () => new SqlError({ reason: new UnknownError({ cause: new Error("boom"), message: "boom" }) })

const attempts = () => {
  let count = 0
  return {
    count: () => count,
    failThen: (failures: number, value: string) =>
      Effect.suspend(() => {
        count++
        return count <= failures ? Effect.fail(locked()) : Effect.succeed(value)
      }),
    alwaysFail: () =>
      Effect.suspend(() => {
        count++
        return Effect.fail(locked())
      }),
  }
}

describe("Sqlite.retryLockedStatement", () => {
  test("retries a locked statement outside a transaction", async () => {
    const state = attempts()
    const result = await Effect.runPromise(
      Sqlite.retryLockedStatement(state.failThen(2, "ok"), { query: "SELECT 1", inTransaction: false }),
    )
    expect(result).toBe("ok")
    expect(state.count()).toBe(3)
  })

  test("retries COMMIT inside a transaction", async () => {
    const state = attempts()
    const result = await Effect.runPromise(
      Sqlite.retryLockedStatement(state.failThen(1, "committed"), { query: "COMMIT", inTransaction: true }),
    )
    expect(result).toBe("committed")
    expect(state.count()).toBe(2)
  })

  test("does not retry a plain statement inside a transaction", async () => {
    const state = attempts()
    const exit = await Effect.runPromiseExit(
      Sqlite.retryLockedStatement(state.alwaysFail(), { query: "INSERT INTO t VALUES (1)", inTransaction: true }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(state.count()).toBe(1)
  })

  test("does not retry an unrelated failure", async () => {
    let count = 0
    const exit = await Effect.runPromiseExit(
      Sqlite.retryLockedStatement(
        Effect.suspend(() => {
          count++
          return Effect.fail(unrelated())
        }),
        { query: "SELECT 1", inTransaction: false },
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(count).toBe(1)
  })

  test("gives up after the retry budget", async () => {
    const state = attempts()
    const exit = await Effect.runPromiseExit(
      Sqlite.retryLockedStatement(state.alwaysFail(), { query: "SELECT 1", inTransaction: false }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(state.count()).toBe(Sqlite.LOCK_RETRY_ATTEMPTS + 1)
  })
})

describe("classifyNodeSqliteError", () => {
  test("classifies SQLITE_BUSY and SQLITE_LOCKED by errcode", () => {
    for (const errcode of [5, 6, 5 | (1 << 8)]) {
      const reason = classifyNodeSqliteError(
        Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode }),
        "Failed to execute statement",
        "execute",
      )
      expect(reason._tag).toBe("LockTimeoutError")
    }
  })

  test("delegates non-lock errors", () => {
    const reason = classifyNodeSqliteError(
      Object.assign(new Error("no such table"), { code: "ERR_SQLITE_ERROR", errcode: 1 }),
      "Failed to execute statement",
      "execute",
    )
    expect(reason._tag).toBe("UnknownError")
  })
})
