import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("shared", {
      type: "boolean",
      hidden: true,
      default: false,
      describe: "publish a discovery lock and end with the last client (global shared server)",
    }),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
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
