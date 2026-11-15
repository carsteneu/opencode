import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { sql } from "drizzle-orm"
import { Duration, Effect, Fiber, Ref } from "effect"
import { SqlClient } from "effect/sql"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EffectDrizzleSqlite } from "../src/database/drizzle.js"
import { LockRetry } from "../src/database/lock-retry.js"

// Wraps the client the way Database does, so the tests exercise the same seam.
const run = <A>(filename: string, effect: Effect.Effect<A, never, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const raw = yield* SqlClient.SqlClient
    return yield* effect.pipe(Effect.provideService(SqlClient.SqlClient, LockRetry.client(raw)))
  }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped, Effect.runPromise)

const locked = Effect.gen(function* () {
  const db = yield* EffectDrizzleSqlite.makeWithDefaults()
  yield* db.run(sql`pragma busy_timeout = 0`)
  return db
})

// Drizzle wraps a failed query in its own error whose cause is an Effect cause, so the
// SqlError sits two levels down: cause.reasons[].error.
const reasonOf = (error: unknown): string | undefined => {
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): string | undefined => {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return undefined
    seen.add(value)
    const candidate = value as { reason?: { _tag?: string }; reasons?: unknown; error?: unknown; cause?: unknown }
    if (candidate.reason?._tag) return candidate.reason._tag
    for (const next of [candidate.reasons, candidate.error, candidate.cause]) {
      if (Array.isArray(next)) {
        for (const entry of next) {
          const hit = visit(entry, depth + 1)
          if (hit) return hit
        }
        continue
      }
      const hit = visit(next, depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  return visit(error, 0)
}

const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), "lock-retry-"))
  const filename = join(dir, "db.sqlite")
  const holder = new Database(filename)
  holder.run("create table users (id integer primary key autoincrement, name text not null unique)")
  holder.run("pragma busy_timeout = 0")
  return {
    filename,
    holder,
    cleanup: async () => {
      if (holder.inTransaction) holder.run("rollback")
      holder.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe("LockRetry", () => {
  test("retries a locked statement and succeeds once the lock is released", async () => {
    const { filename, holder, cleanup } = await setup()
    holder.run("begin immediate")
    const release = setTimeout(() => {
      if (holder.inTransaction) holder.run("commit")
    }, 120)

    try {
      const rows = await run(
        filename,
        Effect.gen(function* () {
          const db = yield* locked
          yield* db.run(sql`insert into users (name) values ('Late')`)
          return yield* db.all<{ name: string }>(sql`select name from users`)
        }).pipe(Effect.orDie),
      )
      expect(rows).toEqual([{ name: "Late" }])
    } finally {
      clearTimeout(release)
      await cleanup()
    }
  })

  test("keeps the event loop free while the lock is held", async () => {
    const { filename, holder, cleanup } = await setup()
    holder.run("begin immediate")

    try {
      const result = await run(
        filename,
        Effect.gen(function* () {
          const db = yield* locked
          const ticks = yield* Ref.make(0)
          const counter = yield* Effect.forkChild(
            Effect.forever(Ref.update(ticks, (n) => n + 1).pipe(Effect.andThen(Effect.sleep(Duration.millis(5))))),
          )
          const error = yield* db.run(sql`insert into users (name) values ('Blocked')`).pipe(Effect.flip)
          const counted = yield* Ref.get(ticks)
          yield* Fiber.interrupt(counter)
          return { reason: reasonOf(error), counted }
        }).pipe(Effect.orDie),
      )
      // Retrying does not invent a lock, so the statement still fails in the end.
      expect(result.reason).toBe("LockTimeoutError")
      // A blocking busy handler would freeze this fiber for seconds and the counter would
      // stand still; sleeping between attempts lets it run.
      expect(result.counted).toBeGreaterThan(10)
    } finally {
      await cleanup()
    }
  })

  test("gives up inside the retry budget instead of blocking for busy_timeout", async () => {
    const { filename, holder, cleanup } = await setup()
    holder.run("begin immediate")

    try {
      const started = Date.now()
      await run(
        filename,
        Effect.gen(function* () {
          const db = yield* locked
          yield* db.run(sql`insert into users (name) values ('Never')`).pipe(Effect.flip)
        }).pipe(Effect.orDie),
      )
      const elapsed = Date.now() - started
      // Six attempts on a jittered exponential schedule from 25ms: well under the five
      // seconds a busy handler would spend, and more than one attempt.
      expect(elapsed).toBeLessThan(4000)
      expect(elapsed).toBeGreaterThan(50)
    } finally {
      await cleanup()
    }
  })

  test("does not retry errors that are not locks", async () => {
    const { filename, cleanup } = await setup()

    try {
      const started = Date.now()
      const reason = await run(
        filename,
        Effect.gen(function* () {
          const db = yield* locked
          yield* db.run(sql`insert into users (name) values ('Once')`)
          const error = yield* db.run(sql`insert into users (name) values ('Once')`).pipe(Effect.flip)
          return reasonOf(error)
        }).pipe(Effect.orDie),
      )
      expect(reason).toBe("UniqueViolation")
      expect(Date.now() - started).toBeLessThan(1000)
    } finally {
      await cleanup()
    }
  })
})
