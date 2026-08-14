import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("session prompt handles boundary keys and app.exit prints the epilogue", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = {
    id: "dummy",
    title: "Demo session",
    slug: "dummy",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "api", env: [], options: {}, models: {} }],
        default: {},
      })
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${session.id}`) return json(session)
    if (url.pathname === `/session/${session.id}/message`) return json([])
    if (url.pathname === `/session/${session.id}/todo` || url.pathname === `/session/${session.id}/diff`)
      return json([])
    return undefined
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  const dispatches: Array<[string, string]> = []
  let stdout = ""
  let api: TuiPluginApi | undefined
  let stopDispatch: (() => void) | undefined
  let stopSlots: (() => void) | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            stopSlots = input.runtime.setupSlots(input.api).dispose
            stopDispatch = input.api.keymap.on("dispatch", (event) => {
              if (typeof event.command === "string") dispatches.push([event.phase, event.command])
            })
            started()
          },
          async dispose() {
            stopSlots?.()
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    const tui = api
    if (!tui) throw new Error("Expected the TUI plugin API")

    const commands = ["session.first", "session.last", "input.buffer.home", "input.buffer.end"]
    await setup.waitFor(() => {
      if (tui.route.current.name !== "session") return false
      if (!(setup.renderer.currentFocusedEditor instanceof TextareaRenderable)) return false
      return [...tui.keymap.getCommandBindings({ visibility: "active", commands }).values()].every(
        (items) => items.length > 0,
      )
    })
    const editor = setup.renderer.currentFocusedEditor
    if (!(editor instanceof TextareaRenderable)) throw new Error("Expected the session prompt textarea")

    const pressKey = (name: string, ctrl = false, meta = false) =>
      setup.renderer.keyInput.processParsedKey({
        name,
        ctrl,
        meta,
        shift: false,
        option: false,
        sequence: name,
        number: false,
        raw: name,
        eventType: "press",
        source: "raw",
      })
    const trace = () =>
      dispatches.filter(([, command]) =>
        ["session.first", "session.last", "input.buffer.home", "input.buffer.end"].includes(command),
      )

    editor.setText("ABC\nDEF")
    editor.cursorOffset = 3
    dispatches.length = 0
    pressKey("home")
    expect(trace()).toEqual([
      ["binding-reject", "session.first"],
      ["binding-execute", "input.buffer.home"],
    ])
    expect(editor.cursorOffset).toBe(0)

    editor.cursorOffset = 3
    dispatches.length = 0
    pressKey("end")
    expect(trace()).toEqual([
      ["binding-reject", "session.last"],
      ["binding-execute", "input.buffer.end"],
    ])
    expect(editor.cursorOffset).toBe(editor.plainText.length)

    dispatches.length = 0
    pressKey("g", true)
    expect(trace()).toEqual([["binding-execute", "session.first"]])

    dispatches.length = 0
    pressKey("g", true, true)
    expect(trace()).toEqual([["binding-execute", "session.last"]])

    editor.blur()
    dispatches.length = 0
    pressKey("home")
    expect(trace()).toEqual([["binding-execute", "session.first"]])

    editor.blur()
    dispatches.length = 0
    pressKey("end")
    expect(trace()).toEqual([["binding-execute", "session.last"]])

    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    stopDispatch?.()
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
