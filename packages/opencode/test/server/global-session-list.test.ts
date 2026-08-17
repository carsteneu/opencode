import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Layer } from "effect"
import { Project } from "@/project/project"
import { Session as SessionNs } from "@/session/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { sql } from "drizzle-orm"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Database.node, SessionNs.node, SessionProjector.node, Project.node, CrossSpawnSpawner.node]),
  ),
)

const withSession = (input?: Parameters<SessionNs.Interface["create"]>[0]) =>
  Effect.acquireRelease(SessionNs.use.create(input), (created) =>
    SessionNs.Service.use((session) => session.remove(created.id).pipe(Effect.ignore)),
  )

describe("session.listGlobal", () => {
  it.instance(
    "lists sessions across projects with project metadata",
    () =>
      Effect.gen(function* () {
        const first = yield* TestInstance
        const second = yield* tmpdirScoped({ git: true })

        const firstSession = yield* withSession({ title: "first-session" })
        const secondSession = yield* withSession({ title: "second-session" }).pipe(provideInstance(second))

        const sessions = yield* SessionNs.Service.use((session) => session.listGlobal({ limit: 200 }))
        const ids = sessions.map((session) => session.id)

        expect(ids).toContain(firstSession.id)
        expect(ids).toContain(secondSession.id)

        const firstProject = yield* Project.use.get(firstSession.projectID)
        const secondProject = yield* Project.use.get(secondSession.projectID)

        const firstItem = sessions.find((session) => session.id === firstSession.id)
        const secondItem = sessions.find((session) => session.id === secondSession.id)

        expect(firstItem?.project?.id).toBe(firstProject?.id)
        expect(firstItem?.project?.worktree).toBe(firstProject?.worktree)
        expect(secondItem?.project?.id).toBe(secondProject?.id)
        expect(secondItem?.project?.worktree).toBe(secondProject?.worktree)
        expect(first.directory).not.toBe(second)
      }),
    { git: true },
  )

  it.instance(
    "excludes archived sessions by default",
    () =>
      Effect.gen(function* () {
        const archived = yield* withSession({ title: "archived-session" })

        yield* SessionNs.Service.use((session) => session.setArchived({ sessionID: archived.id, time: Date.now() }))

        const sessions = yield* SessionNs.Service.use((session) => session.listGlobal({ limit: 200 }))
        const ids = sessions.map((session) => session.id)

        expect(ids).not.toContain(archived.id)

        const allSessions = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ limit: 200, archived: true }),
        )
        const allIds = allSessions.map((session) => session.id)

        expect(allIds).toContain(archived.id)
      }),
    { git: true },
  )

  it.instance(
    "supports cursor pagination",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        const first = yield* withSession({ title: "page-one" })
        const ready = yield* Deferred.make<void>()
        yield* Deferred.succeed(ready, undefined).pipe(Effect.delay("5 millis"), Effect.forkScoped)
        yield* Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting between session creates")),
          }),
        )
        const second = yield* withSession({ title: "page-two" })

        const page = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, limit: 1 }),
        )
        expect(page.length).toBe(1)
        expect(page[0].id).toBe(second.id)

        const next = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, limit: 10, cursor: page[0].time.updated }),
        )
        const ids = next.map((session) => session.id)

        expect(ids).toContain(first.id)
        expect(ids).not.toContain(second.id)
      }),
    { git: true },
  )

  it.instance(
    "uses ordered indexes for global, project, and directory lists",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "query-plan" })
        const database = yield* Database.Service
        const plans = yield* Effect.all([
          database.db.all<{ detail: string }>(sql`
            EXPLAIN QUERY PLAN
            SELECT * FROM session
            WHERE time_archived IS NULL
            ORDER BY time_updated DESC, id DESC
            LIMIT 100
          `),
          database.db.all<{ detail: string }>(sql`
            EXPLAIN QUERY PLAN
            SELECT * FROM session
            WHERE project_id = ${session.projectID}
            ORDER BY time_updated DESC
            LIMIT 100
          `),
          database.db.all<{ detail: string }>(sql`
            EXPLAIN QUERY PLAN
            SELECT * FROM session
            WHERE directory = ${test.directory}
              AND parent_id IS NULL
              AND time_archived IS NULL
            ORDER BY time_updated DESC, id DESC
            LIMIT 100
          `),
        ]).pipe(Effect.orDie)
        const details = plans.map((plan) => plan.map((row) => row.detail).join("\n"))

        expect(details[0]).toContain("session_time_updated_id_idx")
        expect(details[1]).toContain("session_project_time_updated_id_idx")
        expect(details[2]).toContain("session_directory_time_updated_id_idx")
        details.forEach((detail) => expect(detail).not.toContain("USE TEMP B-TREE"))
      }),
    { git: true },
  )
})
