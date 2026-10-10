import { InstanceStore } from "@/project/instance-store"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { claimIdle, graceMsFromEnv, instanceTracking } from "./instances"

// Unloads the instance of a project directory once no client holds it any more,
// so a long-lived shared server does not accumulate one instance per project that
// has ever been opened.
//
// It runs inside the server layer graph on purpose. Building the sweep as a second
// runtime (for example through AppRuntime) would resolve a different InstanceStore
// with an empty cache and silently dispose nothing — verified the hard way.
//
// The service exists to carry the background fiber's scope; the work itself is the
// layer's build.

export interface Interface {
  readonly tracking: () => Effect.Effect<ReturnType<typeof instanceTracking>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SharedUnload") {}

const POLL = Duration.seconds(5)

const layer: Layer.Layer<Service, never, InstanceStore.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const graceMs = graceMsFromEnv()
    if (graceMs > 0) {
      yield* Effect.repeat(
        Effect.gen(function* () {
          for (const directory of claimIdle(graceMs)) {
            yield* store
              .disposeDirectory(directory)
              .pipe(Effect.catchCause((cause) => Effect.logWarning("instance unload failed", { directory, cause })))
          }
        }),
        Schedule.spaced(POLL),
      ).pipe(Effect.forkScoped)
    }
    return Service.of({ tracking: () => Effect.sync(instanceTracking) })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [InstanceStore.node] })

export * as SharedUnload from "./unload"
