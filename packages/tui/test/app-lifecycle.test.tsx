import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { pathToFileURL } from "node:url"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"
import { tmpdir } from "./fixture/fixture"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

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
    await wait(() => {
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

test("pasted local documents become independently counted data URL attachments", async () => {
  await using tmp = await tmpdir()
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = {
    id: "attachment-test",
    title: "Attachment test",
    slug: "attachment-test",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
  const model = {
    id: "model",
    providerID: "test",
    api: { id: "model", url: "http://test", npm: "test" },
    name: "Test model",
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 100_000, output: 4_096 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
  let promptBody: unknown
  let findRequests = 0
  const calls = createFetch((url, request) => {
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "api", env: [], options: {}, models: { model } }],
        default: { test: "model" },
      })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    if (url.pathname === "/api/fs/find") {
      findRequests++
      return json({
        location: { directory: tmp.path, project: { id: "project", directory: tmp.path } },
        data: [{ path: "context.txt", type: "file" }],
      })
    }
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${session.id}`) return json(session)
    if (url.pathname === `/session/${session.id}/message` && request.method === "POST") {
      void request.json().then((value) => {
        promptBody = value
      })
      return json({})
    }
    if (url.pathname === `/session/${session.id}/message`) return json([])
    if (url.pathname === `/session/${session.id}/todo` || url.pathname === `/session/${session.id}/diff`)
      return json([])
    return undefined
  })
  const attachments = [
    { name: "report.docx", bytes: new Uint8Array([80, 75, 3, 4]), marker: "[File 1]" },
    { name: "spec.pdf", bytes: new Uint8Array([37, 80, 68, 70]), marker: "[PDF 1]" },
    { name: "diagram.png", bytes: new Uint8Array([137, 80, 78, 71]), marker: "[Image 1]" },
    { name: "notes.odt", bytes: new Uint8Array([80, 75, 3, 4]), marker: "[File 2]" },
  ]
  const originalWrite = process.stdout.write.bind(process.stdout)
  let api: TuiPluginApi | undefined
  let stopSlots: (() => void) | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = (() => true) as typeof process.stdout.write
  await Promise.all([
    Bun.write(`${tmp.path}/context.txt`, "reference only"),
    ...attachments.map((item) => Bun.write(`${tmp.path}/${item.name}`, item.bytes)),
  ])

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
            started()
          },
          async dispose() {
            stopSlots?.()
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await wait(
      () => api?.route.current.name === "session" && setup.renderer.currentFocusedEditor instanceof TextareaRenderable,
    )
    const editor = setup.renderer.currentFocusedEditor
    if (!(editor instanceof TextareaRenderable)) throw new Error("Expected the session prompt textarea")

    await setup.mockInput.typeText("@context")
    await wait(() => findRequests > 0)
    // waitForFrame snapshots the same committed frame while rendering is idle and can
    // starve the async autocomplete pipeline; poll with yields instead.
    await wait(() => setup.captureCharFrame().includes("context.t"))
    api?.keymap.dispatchCommand("prompt.autocomplete.select")
    await wait(() => editor.plainText === "@context.txt ")

    for (const attachment of attachments) {
      setup.renderer.keyInput.processPaste(new TextEncoder().encode(`${tmp.path}/${attachment.name}`))
      await wait(() => editor.plainText.endsWith(`${attachment.marker} `))
    }

    expect(editor.plainText).toBe("@context.txt [File 1] [PDF 1] [Image 1] [File 2] ")
    api?.keymap.dispatchCommand("prompt.submit")
    await wait(() => promptBody !== undefined)

    expect(promptBody).toMatchObject({
      parts: [
        { type: "text", text: "@context.txt [File 1] [PDF 1] [Image 1] [File 2] " },
        {
          type: "file",
          mime: "text/plain",
          filename: "context.txt",
          url: pathToFileURL(`${tmp.path}/context.txt`).href,
        },
        ...attachments.map((item) => ({
          type: "file",
          filename: item.name,
          url: `data:${Bun.file(`${tmp.path}/${item.name}`).type};base64,${Buffer.from(item.bytes).toString("base64")}`,
        })),
      ],
    })

    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 15_000)
