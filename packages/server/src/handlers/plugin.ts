import { Plugin } from "@opencode/core/plugin"
import { PluginUpdate } from "@opencode/core/plugin/update"
import { InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { Cause, Effect, Exit, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { response } from "../location"

// The request names targets, and a client may repeat one. Two updates of the
// same package would install it twice, so only the first mention counts.
export const uniqueUpdateTargets = (targets: readonly string[]) => [...new Set(targets)]

// Each update is an independent npm install: PluginUpdate locks per target, so
// concurrency is not a correctness question here, it bounds the work a single
// request can trigger. Without a bound a request naming every plugin starts one
// full dependency resolution per package at the same time.
export const pluginUpdateConcurrency = 1

// updateFailureReason names a failed update without its cause. The text leaves
// the server in a 503, and a pretty-printed cause carries stack traces and the
// package manager's paths into the response.
export const updateFailureReason = (cause: Cause.Cause<unknown>): string => {
  switch (errorTag(Option.getOrUndefined(Cause.findErrorOption(cause)))) {
    case "NpmInstallFailedError":
      return "package install failed"
    case "LockTimeoutError":
      return "timed out waiting for the package lock"
    case "LockCompromisedError":
      return "package lock was compromised"
    default:
      return "update failed"
  }
}

function errorTag(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return undefined
  return String((error as { readonly _tag: unknown })._tag)
}

// runPluginUpdates runs every requested package update and collects one line per
// failure. Updates run to completion instead of interrupting the rest on the
// first failure.
export const runPluginUpdates = (updates: PluginUpdate.Interface, targets: readonly string[]) =>
  Effect.forEach(
    uniqueUpdateTargets(targets),
    (target) =>
      updates.update(target).pipe(
        Effect.exit,
        Effect.map((exit) => (Exit.isFailure(exit) ? [`${target}: ${updateFailureReason(exit.cause)}`] : [])),
      ),
    { concurrency: pluginUpdateConcurrency },
  ).pipe(Effect.map((results) => results.flat()))

export const PluginHandler = HttpApiBuilder.group(Api, "server.plugin", (handlers) =>
  handlers
    .handle("plugin.list", () =>
      Effect.gen(function* () {
        return yield* response(Plugin.Service.use((plugin) => plugin.list()))
      }),
    )
    .handle("plugin.check", (ctx) =>
      Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const inventory = yield* plugins.list()
        const targets = [
          ...new Set(inventory.flatMap((plugin) => (plugin.source.type === "package" ? [plugin.source.target] : []))),
        ].filter((target) => ctx.payload.target === undefined || target === ctx.payload.target)
        if (ctx.payload.target !== undefined && !targets.length)
          return yield* new InvalidRequestError({
            message: `Plugin package is not in the current server inventory: ${ctx.payload.target}`,
            field: "target",
          })
        const updates = yield* PluginUpdate.Service
        const outdated = new Map(
          yield* Effect.forEach(
            targets,
            (target) => updates.check(target, { refresh: true }).pipe(Effect.map((value) => [target, value] as const)),
            { concurrency: "unbounded" },
          ),
        )
        return yield* response(
          Effect.succeed(
            inventory.map((plugin) => {
              if (plugin.source.type !== "package" || !outdated.has(plugin.source.target)) return plugin
              return {
                ...plugin,
                source: {
                  type: "package" as const,
                  target: plugin.source.target,
                  ...(plugin.source.version ? { version: plugin.source.version } : {}),
                  ...(outdated.get(plugin.source.target) ? { outdated: true as const } : {}),
                  ...(plugin.source.updating ? { updating: true as const } : {}),
                },
              }
            }),
          ),
        )
      }),
    )
    .handle("plugin.update", (ctx) =>
      Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const inventory = new Set(
          (yield* plugins.list()).flatMap((plugin) => (plugin.source.type === "package" ? [plugin.source.target] : [])),
        )
        const unknown = ctx.payload.targets.filter((target) => !inventory.has(target))
        if (unknown.length)
          return yield* new InvalidRequestError({
            message: `Plugin packages are not in the current server inventory: ${unknown.join(", ")}`,
            field: "targets",
          })
        const updates = yield* PluginUpdate.Service
        const failures = yield* runPluginUpdates(updates, ctx.payload.targets)
        if (failures.length)
          return yield* new ServiceUnavailableError({
            message: `Failed to update plugin packages: ${failures.join("; ")}`,
            service: "plugin",
          })
      }),
    ),
)
