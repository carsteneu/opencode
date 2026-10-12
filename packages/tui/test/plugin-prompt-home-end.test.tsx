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
  const dispatched: string[] = []
  let factory: (() => { priority?: number; commands?: Command[] }) | undefined
  const renderer: { currentFocusedEditor: unknown } = { currentFocusedEditor: null }
  const context = {
    renderer,
    keymap: {
      layer(value: () => { priority?: number; commands?: Command[] }) {
        factory = value
      },
      dispatch(id: string) {
        dispatched.push(id)
      },
    },
  } as unknown as Plugin.Context
  return { context, renderer, dispatched, layer: () => factory?.() }
}

describe("prompt home/end plugin", () => {
  test("loads as an external plugin module through the host loader", async () => {
    const module = (await Host.load(entry.href)) as Module
    expect(module.default.id).toBe("opencode.prompt.home-end")
    expect(typeof module.default.setup).toBe("function")
  })

  test("registers a high-priority layer that binds home/end and yields without a focused editor", async () => {
    const module = (await Host.load(entry.href)) as Module
    const h = harness()
    await module.default.setup(h.context)

    const layer = h.layer()
    expect(layer?.priority).toBe(10)
    const home = layer?.commands?.find((command) => command.bind === "home")
    const end = layer?.commands?.find((command) => command.bind === "end")
    expect(home).toBeDefined()
    expect(end).toBeDefined()

    // No focused editor: decline so session.first/session.last still navigate.
    expect(home!.run()).toBe(false)
    expect(end!.run()).toBe(false)
    expect(h.dispatched).toEqual([])

    // Focused editor: dispatch the core buffer commands.
    h.renderer.currentFocusedEditor = {}
    expect(home!.run()).toBeUndefined()
    expect(end!.run()).toBeUndefined()
    expect(h.dispatched).toEqual(["input.buffer.home", "input.buffer.end"])
  })
})
