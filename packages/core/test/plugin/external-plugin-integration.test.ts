// A plugin that arrives as a directory instead of a compiled-in module: the shape an installation ships its
// own plugin in (yesmem is the case). After such a plugin stops being a built-in, the core has to keep three
// things working: discovery in the config directory, resolution of the directory entrypoint, and its hooks
// running through the real tool dispatcher.

import { expect } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginSourceDirectory } from "@opencode/core/plugin/source-directory"
import { Tool } from "@opencode/core/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { ensurePluginRuntime } from "@opencode/plugin/runtime"
import { Host } from "@opencode/plugin/host"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { FSUtil } from "@opencode/util/fs-util"
import { Cause, Effect, Exit, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"
import { tmpdirScoped } from "../fixture/tmpdir"

const it = testEffect(PluginTestLayer)

const PLUGIN_ID = "probe.external"
const BLOCKED = "BLOCK_ME"

// Written to disk, so the import graph inside the file is what a real installed plugin would have.
const SOURCE = `
import { define } from "@opencode/plugin/effect/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Effect } from "effect"

export default define({
  id: ${JSON.stringify(PLUGIN_ID)},
  effect: (context) =>
    context.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        if (JSON.stringify(event.input).includes(${JSON.stringify(BLOCKED)}))
          yield* new ToolError({ message: "blocked by the external plugin" })
      }),
    ),
})
`

const call = {
  sessionID: Session.ID.make("ses_external"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_external"),
}

const firstFailure = (cause: Cause.Cause<unknown>) => {
  for (const reason of cause.reasons) if (Cause.isFailReason(reason)) return reason.error
  return undefined
}

/** Installs the plugin under <config>/plugins/<name>/index.ts, the layout discovery expects. */
function install() {
  return Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const directory = path.join(root.path, "plugins", "probe")
    yield* Effect.promise(async () => {
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, "index.ts"), SOURCE)
    })
    return { root: root.path, directory }
  })
}

function execution(input: Record<string, unknown>) {
  return Effect.gen(function* () {
    const ran = { value: false }
    const tools = yield* Tool.Service
    yield* tools.transform((editor) =>
      editor.add({
        name: "probe",
        description: "probe",
        input: Schema.Struct({ value: Schema.String }),
        options: { codemode: false },
        execute: () => {
          ran.value = true
          return Effect.succeed({ content: "executed" })
        },
      }),
    )
    const snapshot = yield* tools.snapshot()
    const exit = yield* Effect.exit(
      snapshot.execute({ ...call, call: { type: "tool-call", id: "call_probe", name: "probe", input } }),
    )
    return { exit, ran }
  })
}

/** Discovery, entrypoint resolution and loading, all from the installed directory. */
function loading(directory: string) {
  return Effect.gen(function* () {
    ensurePluginRuntime()
    const fs = yield* FSUtil.Service
    const discovered = yield* PluginSourceDirectory.discover(fs, path.dirname(path.dirname(directory)))
    expect(discovered).toContain(directory)

    const entry = Host.resolve({ directory }).server
    expect(entry).toBeDefined()
    const module = (yield* Effect.promise(() => Host.load(entry!))) as {
      default: { id: string; effect: (context: unknown) => Effect.Effect<unknown, never, never> }
    }
    expect(module.default.id).toBe(PLUGIN_ID)
    return module.default
  })
}

it.live("a plugin installed as a directory is discovered, loaded and blocks a tool call", () =>
  Effect.gen(function* () {
    const { directory } = yield* install()
    const plugin = yield* loading(directory)
    const plugins = yield* Plugin.Service
    yield* plugins.activate([{ ...plugin, revision: "test", source: { type: "local", path: directory } }])

    const { exit, ran } = yield* execution({ value: BLOCKED })

    expect(Exit.isFailure(exit)).toBe(true)
    const failure = Exit.isFailure(exit) ? firstFailure(exit.cause) : undefined
    expect(failure).toBeInstanceOf(ToolError)
    expect((failure as ToolError).message).toBe("blocked by the external plugin")
    // The point of a before hook: the tool itself never runs.
    expect(ran.value).toBe(false)
  }),
)

it.live("a call the installed plugin does not object to reaches the tool", () =>
  Effect.gen(function* () {
    const { directory } = yield* install()
    const plugin = yield* loading(directory)
    const plugins = yield* Plugin.Service
    yield* plugins.activate([{ ...plugin, revision: "test", source: { type: "local", path: directory } }])

    const { exit, ran } = yield* execution({ value: "harmless" })

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(ran.value).toBe(true)
  }),
)
