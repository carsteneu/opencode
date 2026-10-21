import { Npm } from "@opencode/util/npm"
import { expect, test } from "bun:test"
import { Effect, Logger, Stream } from "effect"
import { runPluginUpdates } from "../src/handlers/plugin"

type Fake = {
  readonly calls: string[]
  readonly peak: () => number
  readonly updates: Parameters<typeof runPluginUpdates>[0]
}

// update() records every call and the highest number of concurrent installs.
// The lock inside PluginUpdate serializes per target only, so the handler is
// the only place that can keep two installs out of the shared package dir.
function fakeUpdates(options: { fail?: readonly string[] } = {}): Fake {
  const calls: string[] = []
  let inFlight = 0
  let peak = 0
  return {
    calls,
    peak: () => peak,
    updates: {
      check: () => Effect.succeed(false),
      changes: () => Stream.empty,
      update: (target: string) =>
        Effect.suspend(() => {
          calls.push(target)
          inFlight += 1
          peak = Math.max(peak, inFlight)
          return Effect.sleep("10 millis").pipe(
            Effect.ensuring(Effect.sync(() => void (inFlight -= 1))),
            Effect.andThen(
              options.fail?.includes(target)
                ? Effect.fail(new Npm.InstallFailedError({ dir: "/home/dev/.local/share/opencode/plugin", cause: new Error("npm exited 1") }))
                : Effect.void,
            ),
          )
        }),
    },
  }
}

test("runs one update per distinct target", async () => {
  const fake = fakeUpdates()
  const failures = await Effect.runPromise(runPluginUpdates(fake.updates, ["a@1.0.0", "a@1.0.0", "b@1.0.0", "a@1.0.0"]))
  expect(fake.calls.toSorted()).toEqual(["a@1.0.0", "b@1.0.0"])
  expect(failures).toEqual([])
})

test("runs package installs one at a time", async () => {
  const fake = fakeUpdates()
  await Effect.runPromise(runPluginUpdates(fake.updates, ["a@1.0.0", "b@1.0.0", "c@1.0.0"]))
  expect(fake.calls.length).toBe(3)
  expect(fake.peak()).toBe(1)
})

test("reports a failed update without the cause", async () => {
  const fake = fakeUpdates({ fail: ["a@1.0.0"] })
  const messages: unknown[] = []
  const logger = Logger.make<unknown, void>((options) => {
    messages.push({ message: options.message, cause: options.cause })
  })
  const failures = await Effect.runPromise(
    runPluginUpdates(fake.updates, ["a@1.0.0", "b@1.0.0"]).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    ),
  )
  expect(failures).toEqual(["a@1.0.0: package install failed"])
  // The 503 body leaves the server: a pretty-printed cause would carry stack
  // traces and the package manager's paths into the response.
  expect(failures.join(" ")).not.toContain("/home/dev")
  expect(failures.join(" ")).not.toContain("npm exited 1")
  // The cause itself must not be lost: it is the only diagnostic for a failed
  // install.
  expect(messages.length).toBe(1)
  expect(JSON.stringify(messages[0])).toContain("NpmInstallFailedError")
})
