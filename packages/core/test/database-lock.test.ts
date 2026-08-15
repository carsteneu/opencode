import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { Service, layerFromPath } from "@opencode-ai/core/database/database"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { isSqlError } from "effect/unstable/sql/SqlError"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"

const acquireHolder = (filename: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const holder = new Database(filename)
      holder.run("PRAGMA busy_timeout = 0")
      holder.run("BEGIN IMMEDIATE")
      return holder
    }),
    (holder) =>
      Effect.sync(() => {
        if (holder.inTransaction) holder.run("ROLLBACK")
        holder.close()
      }),
  )

describe("SQLite lock retry", () => {
  test("keeps the event loop responsive and writes exactly once after the lock releases", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "locked.sqlite")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Service
        yield* db.run("CREATE TABLE lock_probe (value TEXT NOT NULL)")
        const holder = yield* acquireHolder(filename)
        const completed = yield* Deferred.make<void>()
        const started = performance.now()
        const insert = yield* db
          .run("INSERT INTO lock_probe (value) VALUES ('after-release')")
          .pipe(Effect.ensuring(Deferred.succeed(completed, undefined)), Effect.forkChild)

        yield* Effect.yieldNow
        yield* Effect.sleep("50 millis")

        expect(performance.now() - started).toBeLessThan(1_000)
        expect(yield* Deferred.isDone(completed)).toBe(false)
        expect(yield* db.all("PRAGMA busy_timeout")).toEqual([{ timeout: 0 }])

        holder.run("ROLLBACK")
        yield* Fiber.join(insert)

        expect(yield* db.all("SELECT value FROM lock_probe")).toEqual([{ value: "after-release" }])
      }).pipe(Effect.provide(layerFromPath(filename)), Effect.scoped),
    )
  }, 10_000)

  test("interrupts a pending retry promptly and leaves the connection usable", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "locked.sqlite")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Service
        yield* db.run("CREATE TABLE lock_probe (value TEXT NOT NULL)")
        const holder = yield* acquireHolder(filename)
        const completed = yield* Deferred.make<void>()
        const insert = yield* db
          .run("INSERT INTO lock_probe (value) VALUES ('interrupted')")
          .pipe(Effect.ensuring(Deferred.succeed(completed, undefined)), Effect.forkChild)

        yield* Effect.yieldNow
        yield* Effect.sleep("50 millis")
        expect(yield* Deferred.isDone(completed)).toBe(false)

        const started = performance.now()
        yield* Fiber.interrupt(insert)
        expect(performance.now() - started).toBeLessThan(500)

        holder.run("ROLLBACK")
        yield* db.run("INSERT INTO lock_probe (value) VALUES ('after-interrupt')")

        expect(yield* db.all("SELECT value FROM lock_probe")).toEqual([{ value: "after-interrupt" }])
      }).pipe(Effect.provide(layerFromPath(filename)), Effect.scoped),
    )
  }, 10_000)

  test("retries a locked transaction begin without rerunning its body", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "locked.sqlite")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Service
        yield* db.run("CREATE TABLE lock_probe (value TEXT NOT NULL)")
        const holder = yield* acquireHolder(filename)
        const bodyRuns = yield* Ref.make(0)
        const completed = yield* Deferred.make<void>()
        const transaction = yield* db
          .transaction(
            (tx) =>
              Ref.update(bodyRuns, (count) => count + 1).pipe(
                Effect.andThen(tx.run("INSERT INTO lock_probe (value) VALUES ('transaction')")),
              ),
            { behavior: "immediate" },
          )
          .pipe(Effect.ensuring(Deferred.succeed(completed, undefined)), Effect.forkChild)

        yield* Effect.yieldNow
        yield* Effect.sleep("50 millis")
        expect(yield* Deferred.isDone(completed)).toBe(false)
        expect(yield* Ref.get(bodyRuns)).toBe(0)

        holder.run("ROLLBACK")
        yield* Fiber.join(transaction)

        expect(yield* Ref.get(bodyRuns)).toBe(1)
        expect(yield* db.all("SELECT value FROM lock_probe")).toEqual([{ value: "transaction" }])
      }).pipe(Effect.provide(layerFromPath(filename)), Effect.scoped),
    )
  }, 10_000)

  test("rolls back a stale transaction snapshot without retrying its body statement", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "locked.sqlite")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Service
        yield* db.run("CREATE TABLE lock_probe (value INTEGER NOT NULL)")
        yield* db.run("INSERT INTO lock_probe (value) VALUES (0)")
        const writer = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(filename)),
          (connection) => Effect.sync(() => connection.close()),
        )
        writer.run("PRAGMA busy_timeout = 0")

        const started = performance.now()
        const error = yield* db
          .transaction((tx) =>
            tx
              .all("SELECT value FROM lock_probe")
              .pipe(
                Effect.andThen(Effect.sync(() => writer.run("UPDATE lock_probe SET value = 1"))),
                Effect.andThen(db.$client.unsafe("UPDATE lock_probe SET value = 2").values),
              ),
          )
          .pipe(Effect.flip)
        expect(performance.now() - started).toBeLessThan(500)
        if (!isSqlError(error)) throw new Error("Expected SqlError")
        expect(error.reason._tag).toBe("LockTimeoutError")
        expect(yield* db.all("SELECT value FROM lock_probe")).toEqual([{ value: 1 }])
      }).pipe(Effect.provide(layerFromPath(filename)), Effect.scoped),
    )
  }, 10_000)

  test("bounds exhausted retries and preserves the lock error", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "locked.sqlite")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Service
        yield* db.run("CREATE TABLE lock_probe (value TEXT NOT NULL)")
        const holder = yield* acquireHolder(filename)
        const started = performance.now()
        const error = yield* db.$client
          .unsafe("INSERT INTO lock_probe (value) VALUES ('blocked')")
          .values.pipe(Effect.flip)
        const elapsed = performance.now() - started

        if (!isSqlError(error)) throw new Error("Expected SqlError")
        expect(error.reason._tag).toBe("LockTimeoutError")
        expect(elapsed).toBeLessThan(4_000)

        holder.run("ROLLBACK")
        expect(yield* db.all("SELECT value FROM lock_probe")).toEqual([])
      }).pipe(Effect.provide(layerFromPath(filename)), Effect.scoped),
    )
  }, 10_000)
})
