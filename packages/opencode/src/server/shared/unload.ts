import { InstanceStore } from "@/project/instance-store"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { attached, claimIdle, graceMsFromEnv, rearm } from "./instances"

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

export interface Interface {}

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
            // The claim happens before the dispose, and the dispose awaits the
            // store, so a window can re-attach in between. Re-check before
            // tearing anything down — a returning client must keep its instance.
            if (attached(directory)) continue
            yield* store.disposeDirectory(directory).pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning("instance unload failed", { directory, cause })
                  // claimIdle already dropped the directory; without re-arming a
                  // transient failure would keep the instance resident forever.
                  rearm(directory)
                }),
              ),
            )
          }
        }),
        Schedule.spaced(POLL),
      ).pipe(Effect.forkScoped)
    }
    return Service.of({})
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [InstanceStore.node] })

export * as SharedUnload from "./unload"
