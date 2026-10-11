import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .option("shared", {
        type: "boolean",
        hidden: true,
        default: false,
        describe: "publish a discovery lock and end with the last client (global shared server)",
      })
      .option("persistent", {
        type: "boolean",
        hidden: true,
        default: false,
        describe: "internal: autostart-service mode — stay up without clients, gated by sharedServerAutostart",
      }),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (args.shared && args.persistent) {
      // The autostart service runs unconditionally at login; the config key is
      // the live switch. Check it before binding anything so a disabled service
      // costs one process start and nothing else.
      const { Config } = yield* Effect.promise(() => import("@/config/config"))
      const { AppRuntime } = yield* Effect.promise(() => import("@/effect/app-runtime"))
      const { shouldAutostart } = yield* Effect.promise(() => import("../../server/shared/autostart"))
      const global = yield* Effect.promise(() => AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal())))
      if (!shouldAutostart(global.sharedServerAutostart)) {
        console.log("[serve --shared --persistent] disabled by sharedServerAutostart=false; exiting")
        process.exit(0)
      }
    }
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!process.env.OPENCODE_SERVER_PASSWORD) {
      // A shared server is auto-discovered and auto-attached by every window, so
      // it must never be published unauthenticated (spec §3.4). The TUI's spawn
      // always sets a random password; a manual `serve --shared` must too.
      if (args.shared) {
        console.error("[serve --shared] OPENCODE_SERVER_PASSWORD is required; refusing to publish an unsecured shared server.")
        process.exit(1)
      }
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))

    if (args.shared) {
      const { installSharedLifecycle } = yield* Effect.promise(() => import("../../server/shared/lifecycle"))
      const { ServerAuth } = yield* Effect.promise(() => import("../../server/auth"))
      const result = yield* Effect.promise(() =>
        installSharedLifecycle({
          url: server.url.origin,
          password: process.env.OPENCODE_SERVER_PASSWORD ?? "",
          persistent: args.persistent,
          onIdle: async () => {
            // Reuse the existing disposal path so open instances are torn down
            // exactly like an explicit /global/dispose.
            await fetch(new URL("/global/dispose", server.url), {
              method: "POST",
              headers: ServerAuth.headers(),
            }).catch(() => {})
            await server.stop(true)
            process.exit(0)
          },
        }),
      )
      // A healthy peer won the race — this process has no role.
      if (!result.owned) process.exit(0)

      const { removeLockIfOwned } = yield* Effect.promise(() => import("../../server/shared/lock"))
      const cleanup = () => {
        removeLockIfOwned()
        process.exit(0)
      }
      process.on("SIGTERM", cleanup)
      process.on("SIGINT", cleanup)
    }

    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
