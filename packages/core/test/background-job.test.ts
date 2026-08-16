import { describe, expect } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Scope } from "effect"
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

    it.live("waitForPromotion resolves a completed job's snapshot instead of hanging", () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const job = yield* jobs.start({ type: "test", run: Effect.succeed("done") })
        yield* jobs.wait({ id: job.id })
        const info = yield* jobs.waitForPromotion(job.id).pipe(Effect.timeout("1 second"))
        expect(info?.status).toBe("completed")
      }).pipe(Effect.provide(jobsLayer)),
    )

    it.live("waitForPromotion fails gracefully when the job is missing instead of hanging", () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const outcome: { ok: boolean; message: string } = yield* jobs
          .waitForPromotion("job_does_not_exist")
          .pipe(
            Effect.timeout("1 second"),
            Effect.matchCauseEffect({
              onSuccess: (value) => Effect.succeed({ ok: true, message: JSON.stringify(value) }),
              onFailure: (cause) => Effect.succeed({ ok: false, message: String(Cause.squash(cause)) }),
            }),
          )
        // On the buggy path waitForPromotion hangs and `Effect.timeout` yields `undefined` (ok: true).
        expect(outcome.ok).toBe(false)
        expect(outcome.message).toMatch(/not found/i)
      }).pipe(Effect.provide(jobsLayer)),
    )

    it.live("waitForPromotion returns the snapshot for a promoted background job", () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const job = yield* jobs.start({ type: "test", run: Effect.never })
        yield* jobs.promote(job.id)
        const info = yield* jobs.waitForPromotion(job.id).pipe(Effect.timeout("1 second"))
        expect(info?.metadata?.background).toBe(true)
      }).pipe(Effect.provide(jobsLayer)),
    )
})
