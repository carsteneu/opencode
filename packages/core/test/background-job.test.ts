import { describe, expect } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { it } from "./lib/effect"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("consumes immediately completed jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({ type: "test", run: Effect.succeed("done") })

      expect(yield* jobs.wait({ id: job.id, consume: true })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
      expect(yield* jobs.get(job.id)).toBeUndefined()
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("gives preattached consuming waiters the same terminal snapshot", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const release = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Deferred.await(release).pipe(Effect.as("done")),
      })
      const first = yield* jobs.wait({ id: job.id, consume: true }).pipe(Effect.forkChild)
      const second = yield* jobs.wait({ id: job.id, consume: true }).pipe(Effect.forkChild)

      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)], { concurrency: "unbounded" })

      expect(results).toEqual([
        {
          timedOut: false,
          info: expect.objectContaining({ id: job.id, status: "completed", output: "done" }),
        },
        {
          timedOut: false,
          info: expect.objectContaining({ id: job.id, status: "completed", output: "done" }),
        },
      ])
      expect(yield* jobs.get(job.id)).toBeUndefined()
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("does not consume running jobs when a consuming wait times out", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const release = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Deferred.await(release).pipe(Effect.as("done")),
      })

      expect(yield* jobs.wait({ id: job.id, timeout: 0, consume: true })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })
      expect(yield* jobs.wait({ id: job.id, timeout: 1, consume: true })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })
      expect((yield* jobs.get(job.id))?.status).toBe("running")

      yield* Deferred.succeed(release, undefined)
      expect((yield* jobs.wait({ id: job.id, consume: true })).info?.output).toBe("done")
      expect(yield* jobs.get(job.id)).toBeUndefined()
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("keeps terminal jobs when a consuming predicate declines their snapshot", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        metadata: { background: true },
        run: Effect.succeed("done"),
      })

      const result = yield* jobs.wait({
        id: job.id,
        consume: (info) => info.metadata?.background !== true,
      })

      expect(result.info).toMatchObject({ status: "completed", output: "done", metadata: { background: true } })
      expect((yield* jobs.get(job.id))?.status).toBe("completed")
      yield* jobs.wait({ id: job.id, consume: true })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("does not let stale consumers remove a replacement with the same id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const release = yield* Deferred.make<void>()
      const firstAttached = yield* Deferred.make<void>()
      const secondAttached = yield* Deferred.make<void>()
      const id = "job_reused"
      yield* jobs.start({
        id,
        type: "test",
        run: Deferred.await(release).pipe(Effect.as("old")),
      })
      const first = yield* Deferred.succeed(firstAttached, undefined).pipe(
        Effect.andThen(jobs.wait({ id, consume: true })),
        Effect.tap(() => jobs.start({ id, type: "test", run: Effect.never })),
        Effect.forkChild,
      )
      const second = yield* Deferred.succeed(secondAttached, undefined).pipe(
        Effect.andThen(jobs.wait({ id, consume: true })),
        Effect.forkChild,
      )

      yield* Effect.all([Deferred.await(firstAttached), Deferred.await(secondAttached)])
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)], { concurrency: "unbounded" })

      expect(results.map((result) => result.info?.output)).toEqual(["old", "old"])
      expect((yield* jobs.get(id))?.status).toBe("running")
      yield* jobs.cancel(id)
      yield* jobs.wait({ id, consume: true })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("consumes cancelled jobs without stranding preattached waiters", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({ type: "test", run: Effect.never })
      const waiting = yield* jobs.wait({ id: job.id }).pipe(Effect.forkChild)

      yield* Effect.yieldNow
      const consumed = yield* jobs.cancel(job.id, { consume: true })
      const preattached = yield* Fiber.join(waiting)

      expect(consumed?.status).toBe("cancelled")
      expect(preattached.info?.status).toBe("cancelled")
      expect(yield* jobs.get(job.id)).toBeUndefined()
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("does not let stale cancel cleanup remove a replacement with the same id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const interrupted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const id = "job_cancel_reused"
      yield* jobs.start({
        id,
        type: "test",
        run: Effect.never.pipe(
          Effect.ensuring(Deferred.succeed(interrupted, undefined).pipe(Effect.andThen(Deferred.await(release)))),
        ),
      })
      const cancelling = yield* jobs.cancel(id, { consume: true }).pipe(Effect.forkChild)

      yield* Deferred.await(interrupted)
      expect(yield* jobs.get(id)).toBeUndefined()
      yield* jobs.start({ id, type: "replacement", run: Effect.never })
      yield* Deferred.succeed(release, undefined)

      expect((yield* Fiber.join(cancelling))?.status).toBe("cancelled")
      expect(yield* jobs.get(id)).toMatchObject({ status: "running", type: "replacement" })
      yield* jobs.cancel(id, { consume: true })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("does not cancel a replacement when the expected snapshot belongs to the old generation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const id = "job_cancel_expected"
      const old = yield* jobs.start({ id, type: "old", run: Effect.succeed("old output") })

      expect((yield* jobs.wait({ id })).info?.output).toBe("old output")
      const replacement = yield* jobs.start({ id, type: "replacement", run: Effect.never })

      expect(yield* jobs.cancel(id, { consume: true, expected: old })).toBeUndefined()
      expect(yield* jobs.get(id)).toMatchObject({ status: "running", type: "replacement" })
      expect(yield* jobs.cancel(id, { consume: true, expected: replacement })).toMatchObject({
        status: "cancelled",
        type: "replacement",
      })
      expect(yield* jobs.get(id)).toBeUndefined()
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("does not retain many unique jobs after consuming their results", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 250 }), (_, index) =>
        Effect.gen(function* () {
          const job = yield* jobs.start({
            id: `job_consumed_${index}`,
            type: "test",
            run: Effect.succeed(`done-${index}`),
          })
          expect((yield* jobs.wait({ id: job.id, consume: true })).info?.output).toBe(`done-${index}`)
        }),
      )

      expect(yield* jobs.list()).toEqual([])
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )
})
