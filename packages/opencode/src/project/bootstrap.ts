import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { ShareNext } from "@/share/share-next"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Plugin hooks can mutate config downstream. Loading no longer blocks the
      // boot gate: plugin-dependent consumers (provider/tool/auth) await
      // Plugin.list(), which materializes -- and joins -- the same in-flight
      // state (InstanceState dedups by directory via ScopedCache), so they get
      // correct (possibly late) results, never stale ones.
      yield* Effect.forkDetach(
        plugin.init().pipe(Effect.catchCause((cause) => Effect.logWarning("plugin init failed", { cause }))),
      )
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. Materialize them in the background so the
      // boot gate releases as soon as config-driven answers can be served;
      // first-use callers join the same state via InstanceState dedup.
      yield* Effect.forkDetach(
        Effect.forEach(
          [lsp, shareNext, format, vcs, snapshot, project],
          (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.withSpan("InstanceBootstrap.init")),
      )
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Config.node, Format.node, LSP.node, Plugin.node, Project.node, ShareNext.node, Snapshot.node, Vcs.node],
})

export * as InstanceBootstrap from "./bootstrap"
