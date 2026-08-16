import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Layer } from "effect"
import { stat } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

describe("opencode db events", () => {
  cliIt.live(
    "reads uncheckpointed WAL events without modifying the database",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const filename = path.join(home, "event-analysis.sqlite")
        yield* Effect.scoped(Layer.build(Database.layerFromPath(filename)))

        const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
        const guard = yield* Effect.acquireRelease(
          Effect.sync(() => new sqlite.Database(filename)),
          (connection) => Effect.sync(() => connection.close()),
        )
        guard.exec("PRAGMA foreign_keys = ON")
        guard.exec("PRAGMA journal_mode = WAL")
        guard.exec("PRAGMA wal_autocheckpoint = 0")
        guard.exec("PRAGMA wal_checkpoint(TRUNCATE)")

        const events = [
          {
            id: "evt_snapshot_0",
            seq: 0,
            type: "session.updated.1",
            data: JSON.stringify({ sessionID: "ses_wal", info: { id: "ses_wal", title: "first" } }),
          },
          {
            id: "evt_snapshot_1",
            seq: 1,
            type: "session.updated.1",
            data: JSON.stringify({ sessionID: "ses_wal", info: { id: "ses_wal", title: "second" } }),
          },
          {
            id: "evt_wal_sentinel",
            seq: 2,
            type: "test.wal-sentinel.1",
            data: JSON.stringify({ marker: "only in WAL Ω" }),
          },
        ]
        const insertSequence = guard.prepare("INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?)")
        const insertEvent = guard.prepare(
          "INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)",
        )
        guard.transaction(() => {
          insertSequence.run("ses_wal", 2)
          events.forEach((event) => insertEvent.run(event.id, "ses_wal", event.seq, event.type, event.data))
        })()

        const before = yield* Effect.promise(() => fingerprintDatabase(filename))
        expect(before.wal.size).toBeGreaterThan(0n)

        const first = yield* opencode.spawn(["db", "events", "--database", filename, "--format", "json"], {
          env: { OPENCODE_DB: filename },
        })
        opencode.expectExit(first, 0, "db events first run")
        expect(yield* Effect.promise(() => fingerprintDatabase(filename))).toEqual(before)

        const second = yield* opencode.spawn(["db", "events", "--database", filename, "--format", "json"], {
          env: { OPENCODE_DB: filename },
        })
        opencode.expectExit(second, 0, "db events second run")
        expect(yield* Effect.promise(() => fingerprintDatabase(filename))).toEqual(before)
        expect(second.stdout).toBe(first.stdout)

        expect(JSON.parse(first.stdout)).toMatchObject({
          dryRun: true,
          applySupported: false,
          total: {
            events: events.length,
            payloadBytes: events.reduce((sum, event) => sum + Buffer.byteLength(event.data), 0),
            aggregates: 1,
          },
          byType: expect.arrayContaining([expect.objectContaining({ type: "test.wal-sentinel.1", events: 1 })]),
        })
      }),
    120_000,
  )

  cliIt.live(
    "rejects relative and missing database paths without creating files",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const relative = "relative-events.sqlite"
        const relativeTarget = path.join(home, relative)
        const relativeResult = yield* opencode.spawn(["db", "events", "--database", relative, "--format", "json"], {
          env: { OPENCODE_DB: relativeTarget },
        })
        expect(relativeResult.exitCode).not.toBe(0)
        expect(relativeResult.stderr).toContain("--database must be an absolute path")
        expect(yield* Effect.promise(() => databaseFilesExist(relativeTarget))).toBe(false)

        const missing = path.join(home, "missing-events.sqlite")
        const missingResult = yield* opencode.spawn(["db", "events", "--database", missing, "--format", "json"], {
          env: { OPENCODE_DB: missing },
        })
        expect(missingResult.exitCode).not.toBe(0)
        expect(missingResult.stderr).toContain(`Database does not exist: ${missing}`)
        expect(yield* Effect.promise(() => databaseFilesExist(missing))).toBe(false)
      }),
    60_000,
  )
})

async function fingerprintDatabase(filename: string) {
  // SQLite may update transient reader marks in SHM even when the database and WAL remain read-only.
  const fingerprints = await Promise.all([fingerprint(filename), fingerprint(`${filename}-wal`)])
  return { database: fingerprints[0], wal: fingerprints[1] }
}

async function fingerprint(filename: string) {
  const metadata = await stat(filename, { bigint: true })
  const hasher = new Bun.CryptoHasher("sha256")
  return {
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    sha256: await hashStream(Bun.file(filename).stream().getReader(), hasher),
  }
}

async function hashStream(reader: ReadableStreamDefaultReader<Uint8Array>, hasher: Bun.CryptoHasher): Promise<string> {
  const chunk = await reader.read()
  if (chunk.done) return hasher.digest("hex")
  hasher.update(chunk.value)
  return hashStream(reader, hasher)
}

async function databaseFilesExist(filename: string) {
  const files = [filename, `${filename}-wal`, `${filename}-shm`]
  return (await Promise.all(files.map((file) => Bun.file(file).exists()))).some(Boolean)
}
