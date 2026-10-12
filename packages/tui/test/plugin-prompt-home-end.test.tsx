/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { Host } from "@opencode/plugin/host"
import type { Plugin } from "@opencode/plugin/tui"
import "../src/plugin/runtime-plugin-support.bun"

const entry = new URL("../../../.opencode/plugin-suite/prompt-home-end/tui.tsx", import.meta.url)

type Module = { default: Plugin.Definition }

type Command = {
  bind?: string
  run: () => void | false
  title?: string
}

function harness() {
  const calls: string[] = []
  let factory: (() => { priority?: number; commands?: Command[] }) | undefined
  const renderer: { currentFocusedEditor: unknown } = { currentFocusedEditor: null }
  const context = {
    renderer,
    keymap: {
      layer(value: () => { priority?: number; commands?: Command[] }) {
        factory = value
      },
    },
  } as unknown as Plugin.Context
  return { context, renderer, calls, layer: () => factory?.() }
}

describe("prompt home/end plugin", () => {
  test("loads as an external plugin module through the host loader", async () => {
    const module = (await Host.load(entry.href)) as Module
    expect(module.default.id).toBe("opencode.prompt.home-end")
    expect(typeof module.default.setup).toBe("function")
  })

  test("registers a high-priority layer that moves a live editor buffer and yields otherwise", async () => {
    const module = (await Host.load(entry.href)) as Module
    const h = harness()
    await module.default.setup(h.context)

    const layer = h.layer()
    expect(layer?.priority).toBe(10)
    const home = layer?.commands?.find((command) => command.bind === "home")
    const end = layer?.commands?.find((command) => command.bind === "end")
    expect(home).toBeDefined()
    expect(end).toBeDefined()

    // No editor: decline so session.first/session.last still navigate.
    expect(home!.run()).toBe(false)
    expect(end!.run()).toBe(false)
    // A destroyed editor, or one without the buffer methods, also declines.
    h.renderer.currentFocusedEditor = {}
    expect(home!.run()).toBe(false)
    h.renderer.currentFocusedEditor = { gotoBufferHome: () => {}, isDestroyed: true }
    expect(home!.run()).toBe(false)
    expect(h.calls).toEqual([])

    // Live editor: move its buffer directly.
    h.renderer.currentFocusedEditor = {
      gotoBufferHome: () => h.calls.push("home"),
      gotoBufferEnd: () => h.calls.push("end"),
    }
    expect(home!.run()).toBeUndefined()
    expect(end!.run()).toBeUndefined()
    expect(h.calls).toEqual(["home", "end"])
  })
})
