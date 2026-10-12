import { fileURLToPath } from "node:url"
import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginModule } from "@opencode/core/plugin/module"
import { Tool } from "@opencode/core/tool"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Cause, Effect, Exit, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"
import { mockDaemon, type DaemonRequest } from "./opencode-yesmem-fixture"

const it = testEffect(PluginTestLayer)

const pluginDirectory = fileURLToPath(new URL("../../../../.opencode/plugin-suite/opencode-yesmem", import.meta.url))

const daemonHandler = (request: DaemonRequest) => {
  if (request.method === "search_code_index") return { result: { text: "Found 12 matches" } }
  if (request.method === "get_file_symbols") return { result: { text: "src/target.ts:1 func Target" } }
  return { result: {} }
}

const call = {
  sessionID: Session.ID.make("ses_integration"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_integration"),
}

const firstFailure = (cause: Cause.Cause<unknown>) => {
  for (const reason of cause.reasons) if (Cause.isFailReason(reason)) return reason.error
  return undefined
}

// Restored by the scenario's finalizer; kept outside the generator so the finalizer can see it.
let previousSocket: string | undefined

/**
 * Drives the plugin through the real core plugin host: the same module loader, the same hook dispatcher,
 * the same tool execution path the server uses.
 */
function scenario(filePath: string) {
  return Effect.gen(function* () {
    const ran = { value: false }
    const daemon = yield* Effect.acquireRelease(
      Effect.promise(() => mockDaemon(daemonHandler)),
      (daemon) => Effect.promise(() => daemon.close()),
    )
    previousSocket = process.env.YESMEM_SOCKET
    process.env.YESMEM_SOCKET = daemon.socketPath

    const plugins = yield* Plugin.Service
    const modules = yield* PluginModule.make().pipe(Effect.provide(Watcher.testLayer))
    const definition = yield* modules.load({ type: "add", target: pluginDirectory, options: {} })
    if ("pending" in definition || "blocked" in definition) return yield* Effect.die("plugin was not loaded")
    yield* plugins.activate([definition])

    // A tool named `read` whose executor records that it ran.
    const tools = yield* Tool.Service
    yield* tools.transform((editor) =>
      editor.add({
        name: "read",
        description: "probe",
        input: Schema.Struct({ filePath: Schema.String }),
        options: { codemode: false },
        execute: () => {
          ran.value = true
          return Effect.succeed({ content: "read by the tool" })
        },
      }),
    )

    const snapshot = yield* tools.snapshot()
    const exit = yield* Effect.exit(
      snapshot.execute({ ...call, call: { type: "tool-call", id: "call_probe", name: "read", input: { filePath } } }),
    )
    return { exit, ran }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (previousSocket === undefined) delete process.env.YESMEM_SOCKET
        else process.env.YESMEM_SOCKET = previousSocket
      }),
    ),
  )
}

it.live("a blocked call never reaches the tool and surfaces as a Tool.Error", () =>
  Effect.gen(function* () {
    const { exit, ran } = yield* scenario("src/target.ts")

    expect(Exit.isFailure(exit)).toBe(true)
    const failure = Exit.isFailure(exit) ? firstFailure(exit.cause) : undefined
    expect(failure).toBeInstanceOf(Tool.Error)
    expect((failure as Tool.Error).message).toContain("YesMem: BLOCKED read")
    // The point of a before hook: the tool itself never runs.
    expect(ran.value).toBe(false)
  }),
)

it.live("a call the plugin does not object to reaches the tool", () =>
  Effect.gen(function* () {
    const { exit, ran } = yield* scenario("README.md")

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(ran.value).toBe(true)
  }),
)
