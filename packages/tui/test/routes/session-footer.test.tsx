/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { BoxRenderable, MouseEvent, Renderable, TextRenderable, type TerminalColors } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { GlobalEvent, PermissionRequest, Session } from "@opencode-ai/sdk/v2"
import { onCleanup, onMount, type ParentProps } from "solid-js"
import { ArgsProvider } from "../../src/context/args"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { AgentsStatusBlock } from "../../src/routes/session/agents-status-block"
import { Footer } from "../../src/routes/session/footer"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

const sessionID = "session"
const messageID = "message"

test("session footer labels the estimate as output only", async () => {
  await using tmp = await tmpdir()
  const harness = await mountFooter(tmp.path)

  try {
    const frame = await waitForFrame(harness.app, "out ~0 tk/s")
    expect(frame).toContain("out ~0 tk/s")
    expect(frame).not.toContain("· in ")
  } finally {
    harness.app.renderer.destroy()
  }
})

test("accepted deltas render only the token cell and stop after one zero decay", async () => {
  await using tmp = await tmpdir()
  const harness = await mountFooter(tmp.path, true, true)
  await waitForFrame(harness.app, "out ~0 tk/s")
  expect((harness.app.renderer.root as unknown as { renderList: unknown[] }).renderList.length).toBeGreaterThan(500)
  const requests = captureRequests(harness.app.renderer, true)
  const native = captureNativeRenders(harness.app.renderer)
  try {
    harness.sdk.event.emit("event", messageUpdated())
    requests.clear()

    harness.sdk.event.emit("event", textDelta("ignored", { sessionID: "other-session" }))
    harness.sdk.event.emit("event", textDelta("ignored", { messageID: "other-message" }))
    harness.sdk.event.emit("event", textDelta("ignored", { field: "metadata" }))

    expect(requests.partial).toHaveLength(0)
    expect(requests.ordinary).toHaveLength(0)

    harness.sdk.event.emit("event", textDelta("x".repeat(40)))
    await Bun.sleep(500)
    harness.sdk.event.emit("event", textDelta("x".repeat(40)))

    expect(requests.partial).toHaveLength(0)
    expect(requests.ordinary).toHaveLength(0)

    await Bun.sleep(550)

    expect(requests.ordinary).toHaveLength(0)
    expect(requests.partial).toHaveLength(1)
    expect(requests.partial[0]).toBeInstanceOf(TextRenderable)
    const activeLabel = visualText(requests.partial[0] as TextRenderable)
    const activeRate = Number(activeLabel.match(/^out ~(\d+) tk\/s$/)?.[1])
    expect(activeRate).toBeGreaterThanOrEqual(18)
    expect(activeRate).toBeLessThanOrEqual(22)
    await harness.app.renderer.idle()
    let frame = visualFrame(harness.app)
    let start = frame.indexOf(activeLabel)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(frame.slice(start, start + 14)).toBe(activeLabel.padEnd(14))
    expect(native.full).toHaveLength(0)
    expect(native.partial).toHaveLength(1)
    expect(native.partial[0].slice(-2)).toEqual([16, 1])

    requests.clear()
    native.clear()
    await Bun.sleep(2500)
    expect(requests.ordinary).toHaveLength(0)
    expect(requests.partial).toHaveLength(1)
    expect(visualText(requests.partial[0] as TextRenderable)).toBe("out ~0 tk/s")
    await harness.app.renderer.idle()
    frame = visualFrame(harness.app)
    start = frame.indexOf("out ~0 tk/s")
    expect(start).toBeGreaterThanOrEqual(0)
    expect(frame.slice(start, start + 14)).toBe("out ~0 tk/s   ")
    expect(native.full).toHaveLength(0)
    expect(native.partial).toHaveLength(1)
    expect(native.partial[0].slice(-2)).toEqual([16, 1])

    requests.clear()
    native.clear()
    await Bun.sleep(5000)
    expect(requests.partial).toHaveLength(0)
    expect(requests.ordinary).toHaveLength(0)
    expect(native.full).toHaveLength(0)
    expect(native.partial).toHaveLength(0)
  } finally {
    native.restore()
    requests.restore()
    harness.app.renderer.destroy()
  }
}, 13_000)

test("transparent token cell clears its complete partial region", async () => {
  await using tmp = await tmpdir()
  const harness = await mountFooter(tmp.path)
  await waitForFrame(harness.app, "out ~0 tk/s")
  const token = findText(harness.app.renderer.root, "out ~0 tk/s")
  const internals = harness.app.renderer as unknown as RendererInternals
  const frame = visualFrame(harness.app)
  const start = frame.indexOf("out ~0 tk/s")

  try {
    expect(start).toBeGreaterThanOrEqual(0)
    token.content = "\u00a0".repeat(14)
    expect(internals.partialRequests.has(token)).toBe(true)
    expect(internals.canPartialRender()).toBe(true)
    await internals.loop()

    const cleared = visualFrame(harness.app)
    expect(cleared).not.toContain("out ~0 tk/s")
    expect(cleared.slice(start, start + 14)).toBe(" ".repeat(14))
  } finally {
    harness.app.renderer.destroy()
  }
})

test("dynamic connected footer cells request partial renders without dirtying the root", async () => {
  await using tmp = await tmpdir()
  const harness = await mountFooter(tmp.path, true)
  const permission = permissionRequest("permission-1")
  harness.sync.set("permission", sessionID, [permission])
  await waitForFrame(harness.app, "△ 1 Permission")
  await harness.app.flush()
  const requests = captureRequests(harness.app.renderer, true)
  const internals = harness.app.renderer as unknown as RendererInternals

  try {
    await expectPartial(() => harness.sync.set("vcs", { branch: "partial-footer" }), `${directory}:partial-footer`)
    await expectPartial(
      () => harness.sync.set("permission", sessionID, [permission, permissionRequest("permission-2")]),
      "△ 2 Permissions",
    )
    await expectPartial(
      () =>
        harness.sync.set("lsp", [
          { id: "one", name: "one", root: directory, status: "connected" },
          { id: "two", name: "two", root: directory, status: "connected" },
        ]),
      "• 2 LSP",
    )
    await expectPartial(() => harness.sync.set("mcp", "two", { status: "connected" }), "⊙ 2 MCP")
    await expectPartial(() => harness.sync.set("mcp", "failed", { status: "failed", error: "test" }), "⊙ 2 MCP")
  } finally {
    requests.restore()
    harness.app.renderer.destroy()
  }

  async function expectPartial(update: () => void, content: string) {
    requests.clear()
    update()
    const target = requests.partial.find((item) => item instanceof TextRenderable && visualText(item) === content)
    expect(target).toBeInstanceOf(TextRenderable)
    expect(requests.ordinary).toHaveLength(0)
    expect(target && internals.partialRequests.has(target)).toBe(true)
    expect(internals.canPartialRender()).toBe(true)
    await internals.loop()
  }
})

test("agent elapsed time renders partially only while the block is expanded", async () => {
  await using tmp = await tmpdir()
  const harness = await mountFooter(tmp.path, false, false, true)
  const now = Date.now()
  harness.sync.set("session", [
    session(sessionID, undefined, "Parent", now - 10_000),
    session("agent", sessionID, "Inspect footer (@explore subagent)", now - 5_000),
  ])
  harness.sync.set("session_status", "agent", { type: "busy" })
  await waitForFrame(harness.app, "1/1 active")
  await harness.app.renderer.idle()
  const header = findText(harness.app.renderer.root, "collapse").parent
  expect(header).toBeInstanceOf(BoxRenderable)
  if (!(header instanceof BoxRenderable)) throw new Error("missing agents header")
  const requests = captureRequests(harness.app.renderer, true)
  const native = captureNativeRenders(harness.app.renderer)

  try {
    await Bun.sleep(1050)
    expect(requests.ordinary).toHaveLength(0)
    expect(requests.partial).toHaveLength(1)
    expect(requests.partial[0]).toBeInstanceOf(TextRenderable)
    expect((requests.partial[0] as TextRenderable).width).toBe(8)
    await harness.app.renderer.idle()
    expect(native.full).toHaveLength(0)
    expect(native.partial).toHaveLength(1)
    expect(native.partial[0].slice(-2)).toEqual([10, 1])

    header.processMouseEvent(mouseUp(header))
    await harness.app.renderer.idle()
    await waitForFrame(harness.app, "expand")
    requests.clear()
    native.clear()
    await Bun.sleep(1200)
    expect(requests.ordinary).toHaveLength(0)
    expect(requests.partial).toHaveLength(0)
    expect(native.full).toHaveLength(0)
    expect(native.partial).toHaveLength(0)

      header.processMouseEvent(mouseUp(header))
      await harness.app.renderer.idle()
      await waitForFrame(harness.app, "collapse")
      requests.clear()
      native.clear()
      await Bun.sleep(1050)
      expect(requests.ordinary).toHaveLength(0)
      expect(requests.partial).toHaveLength(1)
      expect(requests.partial[0]).toBeInstanceOf(TextRenderable)
      await harness.app.renderer.idle()
      expect(native.full).toHaveLength(0)
      expect(native.partial).toHaveLength(1)
    } finally {
      native.restore()
      requests.restore()
      harness.app.renderer.destroy()
    }
  }, 8000)

  test("dismissing a done agent row hides it and persists for the parent session", async () => {
    await using tmp = await tmpdir()
    const harness = await mountFooter(tmp.path, false, false, true)
    const now = Date.now()
    harness.sync.set("session", [
      session(sessionID, undefined, "Parent", now - 10_000),
      session("agent", sessionID, "Inspect footer (@explore subagent)", now - 5_000),
    ])
    harness.sync.set("session_status", "agent", { type: "idle" })
    await waitForFrame(harness.app, "0/1 active")

    // hover the row to reveal the dismiss affordance, then click it
    const row = findText(harness.app.renderer.root, "Inspect footer").parent
    if (!(row instanceof BoxRenderable)) throw new Error("missing agents row")
    row.processMouseEvent(mouseOver(row))
    await harness.app.renderer.idle()
    const affordance = findTextOptional(harness.app.renderer.root, "✕")
    expect(affordance).toBeInstanceOf(TextRenderable)

    affordance!.processMouseEvent(mouseUp(affordance!))
    await harness.app.renderer.idle()
    await wait(() => findTextOptional(harness.app.renderer.root, "collapse") === undefined)
    expect(findTextOptional(harness.app.renderer.root, "Inspect footer")).toBeUndefined()

    // the dismissal is persisted per parent session and survives a re-open
    const started = Date.now()
    let persisted: Record<string, unknown> = {}
    while (Date.now() - started < 2000) {
      await Bun.sleep(50)
      try {
        persisted = (await Bun.file(`${tmp.path}/kv.json`).json()) as Record<string, unknown>
        if (persisted[`agentsDismissed:${sessionID}`] !== undefined) break
      } catch {
        // file not flushed yet
      }
    }
    expect(persisted[`agentsDismissed:${sessionID}`]).toEqual(["agent"])
  }, 8000)

test("an open dialog promotes token updates to the safe ordinary path", async () => {
  await using tmp = await tmpdir()
  const harness = await mountFooter(tmp.path)
  await waitForFrame(harness.app, "out ~0 tk/s")
  const token = findText(harness.app.renderer.root, "out ~0 tk/s")
  harness.dialog.replace(() => <text content="dialog" />)
  await harness.app.renderOnce()
  const requests = captureRequests(harness.app.renderer)

  try {
    token.content = "out ~1 tk/s"
    expect(requests.partial).toHaveLength(0)
    expect(requests.ordinary).toEqual([token])
  } finally {
    requests.restore()
    harness.app.renderer.destroy()
  }
})

async function mountFooter(state: string, connected = false, large = false, agents = false) {
  await Bun.write(`${state}/kv.json`, "{}")
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers" && connected)
      return json({
        providers: [{ id: "test", name: "Test", source: "api", env: [], options: {}, models: {} }],
        default: {},
      })
    if (url.pathname === "/lsp" && connected)
      return json([{ id: "one", name: "one", root: directory, status: "connected" }])
    if (url.pathname === "/mcp" && connected) return json({ one: { status: "connected" } })
    return undefined
  })
  let sync!: ReturnType<typeof useSync>
  let sdk!: ReturnType<typeof useSDK>
  let dialog!: ReturnType<typeof useDialog>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSync()
    sdk = useSDK()
    dialog = useDialog()
    onMount(ready)
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))

    return (
      <Palette>
        <TestTuiContexts paths={{ state }}>
          <OpencodeKeymapProvider keymap={keymap}>
            <ArgsProvider>
              <KVProvider>
                <ToastProvider>
                  <RouteProvider initialRoute={{ type: "session", sessionID }}>
                    <TuiConfigProvider config={config}>
                      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
                        <PermissionProvider>
                          <ProjectProvider>
                            <ExitProvider exit={() => {}}>
                              <SyncProvider>
                                <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                                  <DialogProvider>
                                    <box height={agents ? 10 : large ? 43 : 3}>
                                      {large ? (
                                        <box height={40} overflow="hidden" flexShrink={0}>
                                          <box height={500} flexShrink={0}>
                                            {Array.from({ length: 500 }, (_, index) => (
                                              <text content={`history-${index}`} />
                                            ))}
                                          </box>
                                        </box>
                                      ) : null}
                                      {agents ? <AgentsStatusBlock /> : null}
                                      <box height={3} justifyContent="flex-end" flexShrink={0}>
                                        <Footer />
                                      </box>
                                    </box>
                                    <Probe />
                                  </DialogProvider>
                                </ThemeProvider>
                              </SyncProvider>
                            </ExitProvider>
                          </ProjectProvider>
                        </PermissionProvider>
                      </SDKProvider>
                    </TuiConfigProvider>
                  </RouteProvider>
                </ToastProvider>
              </KVProvider>
            </ArgsProvider>
          </OpencodeKeymapProvider>
        </TestTuiContexts>
      </Palette>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: agents ? 10 : large ? 43 : 3 })
  await mounted
  await wait(() => sync.status === "complete")
  return { app, dialog, events, sdk, sync }
}

function Palette(props: ParentProps) {
  const renderer = useRenderer()
  renderer.getPalette = async () =>
    ({
      palette: [],
      defaultForeground: null,
      defaultBackground: null,
      cursorColor: null,
      mouseForeground: null,
      mouseBackground: null,
      tekForeground: null,
      tekBackground: null,
      highlightBackground: null,
      highlightForeground: null,
    }) satisfies TerminalColors
  return props.children
}

function captureRequests(renderer: Awaited<ReturnType<typeof testRender>>["renderer"], forward = false) {
  const ordinary: Array<Renderable | undefined> = []
  const partial: Renderable[] = []
  const requestRender = renderer.requestRender
  const requestPartialRender = renderer.requestPartialRender
  renderer.requestRender = (source) => {
    ordinary.push(source)
    if (forward) requestRender.call(renderer, source)
  }
  renderer.requestPartialRender = (renderable) => {
    partial.push(renderable)
    if (forward) requestPartialRender.call(renderer, renderable)
  }
  return {
    ordinary,
    partial,
    clear() {
      ordinary.length = 0
      partial.length = 0
    },
    restore() {
      renderer.requestRender = requestRender
      renderer.requestPartialRender = requestPartialRender
    },
  }
}

function captureNativeRenders(renderer: Awaited<ReturnType<typeof testRender>>["renderer"]) {
  const internals = renderer as unknown as {
    lib: {
      render(...args: unknown[]): number
      renderPartial(...args: unknown[]): number
    }
  }
  const full: unknown[][] = []
  const partial: unknown[][] = []
  const render = internals.lib.render
  const renderPartial = internals.lib.renderPartial
  internals.lib.render = (...args) => {
    full.push(args)
    return render.apply(internals.lib, args)
  }
  internals.lib.renderPartial = (...args) => {
    partial.push(args)
    return renderPartial.apply(internals.lib, args)
  }
  return {
    full,
    partial,
    clear() {
      full.length = 0
      partial.length = 0
    },
    restore() {
      internals.lib.render = render
      internals.lib.renderPartial = renderPartial
    },
  }
}

function findText(root: Renderable, content: string): TextRenderable {
  if (root instanceof TextRenderable && root.plainText === content) return root
  for (const child of root.getChildren()) {
    if (!(child instanceof Renderable)) continue
    const found = findTextOptional(child, content)
    if (found) return found
  }
  throw new Error(`missing text renderable: ${content}`)
}

function findTextOptional(root: Renderable, content: string): TextRenderable | undefined {
  if (root instanceof TextRenderable && visualText(root) === content) return root
  for (const child of root.getChildren()) {
    if (!(child instanceof Renderable)) continue
    const found = findTextOptional(child, content)
    if (found) return found
  }
}

function messageUpdated(): GlobalEvent {
  return global({
    id: "event-message",
    type: "message.updated",
    properties: {
      sessionID,
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        agent: "build",
        modelID: "model",
        providerID: "test",
        mode: "build",
        parentID: "user-message",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1 },
      },
    },
  })
}

function textDelta(
  delta: string,
  overrides: Partial<{ sessionID: string; messageID: string; field: string }> = {},
): GlobalEvent {
  return global({
    id: `event-delta-${overrides.sessionID ?? sessionID}-${overrides.messageID ?? messageID}-${overrides.field ?? "text"}`,
    type: "message.part.delta",
    properties: {
      sessionID: overrides.sessionID ?? sessionID,
      messageID: overrides.messageID ?? messageID,
      partID: "part",
      field: overrides.field ?? "text",
      delta,
    },
  })
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

function permissionRequest(id: string): PermissionRequest {
  return { id, sessionID, permission: "read", patterns: ["*"], metadata: {}, always: [] }
}

function session(id: string, parentID: string | undefined, title: string, created: number) {
  return {
    id,
    parentID,
    title,
    projectID: "project",
    directory,
    time: { created, updated: created },
  } as Session
}

function mouseUp(target: Renderable) {
  return new MouseEvent(target, {
    type: "up",
    button: 0,
    x: target.screenX,
    y: target.screenY,
    modifiers: { shift: false, alt: false, ctrl: false },
  })
}

function mouseOver(target: Renderable) {
  return new MouseEvent(target, {
    type: "over",
    button: 0,
    x: target.screenX,
    y: target.screenY,
    modifiers: { shift: false, alt: false, ctrl: false },
  })
}

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, value: string) {
  const started = Date.now()
  while (Date.now() - started < 2000) {
    await app.renderOnce()
    const frame = visualFrame(app)
    if (frame.includes(value)) return frame
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${value}`)
}

function visualFrame(app: Awaited<ReturnType<typeof testRender>>) {
  return app.captureCharFrame().replaceAll("\u00a0", " ")
}

function visualText(text: TextRenderable) {
  return text.plainText.replaceAll("\u00a0", " ").trimEnd()
}

async function wait(fn: () => boolean, timeout = 2000) {
  const started = Date.now()
  while (!fn()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type RendererInternals = {
  partialRequests: Set<Renderable>
  canPartialRender(): boolean
  loop(): Promise<void>
}
