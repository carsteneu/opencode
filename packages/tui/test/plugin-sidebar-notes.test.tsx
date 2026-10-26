/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { createStore, produce } from "solid-js/store"
import Plugin_ from "../src/feature-plugins/sidebar/notes"
import { NotesRuntime, SidebarNotes } from "../src/component/sidebar-notes"
import type { NotesState } from "../src/util/notes"

const SID = "ses_notes"

type Sent = { sessionID: string; text: string }
type Toast = { message: string; variant?: string }

type Options = {
  notes?: NotesState
  open?: boolean
  confirm?: boolean
  enqueue?: (input: Sent) => Promise<string>
  messages?: readonly SessionMessageInfo[]
  session?: { id: string; projectID?: string; location?: { directory: string } }
}

function harness(options: Options = {}) {
  const sent: Sent[] = []
  const toasts: Toast[] = []
  const layers: Array<{ commands?: Array<{ id?: string }> }> = []
  const state = { confirms: 0, dialogs: 0, writes: 0, selects: 0 }
  const entries = new Map<string, readonly [unknown, unknown]>()
  const color = RGBA.fromInts(200, 200, 200)
  const context = {
    theme: {
      text: {
        base: color,
        muted: color,
        faint: color,
        feedback: { success: { base: color }, error: { base: color }, warning: { base: color } },
      },
    },
    storage: {
      store(key: string, initial: { initial: object }) {
        const hit = entries.get(key)
        if (hit) return hit
        const value = key === "notes" ? structuredClone(options.notes ?? { notes: {} }) : { open: options.open ?? true }
        const [store, setStore] = createStore(structuredClone(value))
        const entry = [
          store,
          async (mutation: (draft: object) => void) => {
            state.writes += 1
            setStore(produce(mutation))
          },
        ] as const
        entries.set(key, entry)
        return entry
      },
    },
    data: {
      session: {
        get: () => options.session,
        message: { list: () => options.messages ?? [] },
        enqueue:
          options.enqueue ??
          (async (input: Sent) => {
            sent.push(input)
            return "msg_sent"
          }),
      },
    },
    keymap: {
      layer: (factory: () => { commands?: Array<{ id?: string }> }) => {
        layers.push(factory())
      },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: SID }) },
      toast: { show: (toast: Toast) => toasts.push(toast) },
      dialog: {
        show: () => {
          state.dialogs += 1
        },
        confirm: async () => {
          state.confirms += 1
          return options.confirm ?? false
        },
        select: async () => {
          state.selects += 1
          return undefined
        },
        set: () => {},
        clear: () => {},
      },
    },
  } as unknown as Plugin.Context
  return { context, sent, toasts, layers, state }
}

async function render(context: Plugin.Context, height = 20) {
  const app = await testRender(
    () => (
      <box width={38}>
        <SidebarNotes context={context} sessionID={SID} />
      </box>
    ),
    { width: 38, height },
  )
  await app.renderOnce()
  return app
}

async function settle(app: Awaited<ReturnType<typeof render>>) {
  await Bun.sleep(0)
  await app.renderOnce()
}

function node(app: Awaited<ReturnType<typeof render>>, id: string) {
  const found = app.renderer.root.findDescendantById(id)
  if (!found) throw new Error(`missing node ${id}`)
  return found
}

/** Points at the row's own gutter, then waits for the hover-only actions to appear. */
async function hover(app: Awaited<ReturnType<typeof render>>, id: string) {
  const row = node(app, id)
  await app.mockMouse.moveTo(row.x + 1, row.y)
  await app.waitForFrame((frame) => frame.includes("✎"))
}

function note(id: string, text: string, extra: Record<string, unknown> = {}) {
  return { id, text, done: false, created: 1, updated: 1, state: "open" as const, ...extra }
}

test("ships as a built-in plugin that claims the sidebar and an always-mounted slot", async () => {
  expect(Plugin_.id).toBe("opencode.sidebar.notes")
  const claims: string[] = []
  const setupContext = {
    ui: {
      slot: (value: { append: string }) => {
        claims.push(value.append)
        return () => {}
      },
    },
  } as unknown as Plugin.Context
  await Plugin_.setup(setupContext)
  // The commands and the answer capture hang off the app slot, so closing the sidebar cannot disable them.
  expect(claims).toEqual(["sidebar.content", "app"])
})

test("the always-mounted runtime owns the four notes commands", async () => {
  const h = harness()
  const app = await testRender(() => <NotesRuntime context={h.context} />, { width: 40, height: 6 })
  try {
    await app.renderOnce()
    expect(h.layers.at(-1)?.commands?.map((command) => command.id)).toEqual([
      "notes.add",
      "notes.history",
      "notes.toggle",
      "notes.clear_done",
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("the header counts open notes and lists them newest first", async () => {
  const h = harness({
    notes: {
      notes: {
        [SID]: [
          note("b", "second question", { created: 20 }),
          note("a", "first question", { created: 10 }),
          note("c", "already done", { created: 30, done: true }),
        ],
      },
    },
  })
  const app = await render(h.context)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Prompt Notes (2)")
    // Newest first, checked-off last: the oldest open note sits at the bottom.
    expect(frame.indexOf("second question")).toBeLessThan(frame.indexOf("first question"))
    expect(frame.indexOf("first question")).toBeLessThan(frame.indexOf("already done"))
  } finally {
    app.renderer.destroy()
  }
})

test("a long list keeps the newest rows and hands the rest to the history", async () => {
  const many = Array.from({ length: 12 }, (_, index) => note(`n${index}`, `note ${index}`, { created: 100 + index }))
  const h = harness({ notes: { notes: { [SID]: many } } })
  const app = await render(h.context, 40)
  try {
    const frame = app.captureCharFrame()
    // Newest first: rows 11..4 are visible, 3 and older are behind the overflow row.
    expect(frame).toContain("note 11")
    expect(frame).toContain("note 4")
    expect(frame).not.toContain("note 3")
    expect(frame).toContain("⋮ 4 more → history")

    const overflow = node(app, "notes-overflow")
    await app.mockMouse.click(overflow.x, overflow.y)
    await settle(app)
    expect(h.state.selects).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("a long note stays one row and offers the view icon without an answer", async () => {
  const long = "This is a very long note that keeps going and going so the sidebar must not grow with it at all."
  const h = harness({ notes: { notes: { [SID]: [note("a", long, { created: 10 })] } } })
  const app = await render(h.context, 20)
  try {
    const frame = app.captureCharFrame()
    const row = frame.split("\n").find((line) => line.includes("○")) ?? ""
    // The icons sit in the row without hovering: a long note must not push them out.
    expect(row).toContain("▤")
    expect(row).toContain("▶")
    // The visible text is a prefix of the note: clipped at the end, never from the middle.
    const shown = row.slice(row.indexOf("○") + 1).split("▤")[0]!.trim()
    expect(shown.length).toBeGreaterThan(0)
    expect(long.startsWith(shown)).toBe(true)
    expect(frame).not.toContain("must not grow with it")

    // The full text stays reachable: the view icon appears even though there is no answer yet.
    await hover(app, "note-row-a")
    const view = node(app, "note-view-a")
    await app.mockMouse.click(view.x, view.y)
    await settle(app)
    expect(h.state.dialogs).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("an empty session shows a placeholder instead of an empty list", async () => {
  const app = await render(harness().context)
  try {
    expect(app.captureCharFrame()).toContain("Prompt Notes (0)")
    expect(app.captureCharFrame()).toContain("No notes yet")
  } finally {
    app.renderer.destroy()
  }
})

test("the checkbox checks a note off", async () => {
  const h = harness({ notes: { notes: { [SID]: [note("a", "check me")] } } })
  const app = await render(h.context)
  try {
    const check = node(app, "note-check-a")
    await app.mockMouse.click(check.x, check.y)
    await settle(app)
    expect(app.captureCharFrame()).toContain("Prompt Notes (0)")
    const store = h.context.storage.store("notes", { initial: { notes: {} } })[0] as unknown as NotesState
    expect(store.notes[SID][0].done).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("sending enqueues the question and only then checks the note off", async () => {
  const h = harness({ notes: { notes: { [SID]: [note("a", "why does it stall?")] } } })
  const app = await render(h.context)
  try {
    await hover(app, "note-row-a")
    const send = node(app, "note-send-a")
    await app.mockMouse.click(send.x, send.y)
    await settle(app)
    expect(h.sent).toEqual([{ sessionID: SID, text: "why does it stall?" }])
    const store = h.context.storage.store("notes", { initial: { notes: {} } })[0] as unknown as NotesState
    expect(store.notes[SID][0]).toMatchObject({ done: true, state: "sent", sentID: "msg_sent" })
  } finally {
    app.renderer.destroy()
  }
})

test("a rejected send leaves the note unchecked and reports the failure", async () => {
  const h = harness({
    notes: { notes: { [SID]: [note("a", "send me")] } },
    enqueue: () => Promise.reject(new Error("server said no")),
  })
  const app = await render(h.context)
  try {
    await hover(app, "note-row-a")
    const send = node(app, "note-send-a")
    await app.mockMouse.click(send.x, send.y)
    await settle(app)
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0]).toMatchObject({ variant: "error" })
    expect(h.toasts[0].message).toContain("server said no")
    const store = h.context.storage.store("notes", { initial: { notes: {} } })[0] as unknown as NotesState
    expect(store.notes[SID][0]).toMatchObject({ done: false, state: "open" })
  } finally {
    app.renderer.destroy()
  }
})

test("deleting asks before removing anything", async () => {
  const kept = harness({ notes: { notes: { [SID]: [note("a", "keep me")] } }, confirm: false })
  const keptApp = await render(kept.context)
  const removed = harness({ notes: { notes: { [SID]: [note("a", "drop me")] } }, confirm: true })
  const removedApp = await render(removed.context)
  try {
    await hover(keptApp, "note-row-a")
    const keepButton = node(keptApp, "note-delete-a")
    await keptApp.mockMouse.click(keepButton.x, keepButton.y)
    await settle(keptApp)
    expect(kept.state.confirms).toBe(1)
    expect(keptApp.captureCharFrame()).toContain("keep me")

    await hover(removedApp, "note-row-a")
    const dropButton = node(removedApp, "note-delete-a")
    await removedApp.mockMouse.click(dropButton.x, dropButton.y)
    await settle(removedApp)
    expect(removedApp.captureCharFrame()).toContain("No notes yet")
  } finally {
    keptApp.renderer.destroy()
    removedApp.renderer.destroy()
  }
})

test("a collapsed block hides its rows and keeps the count visible", async () => {
  const app = await render(harness({ notes: { notes: { [SID]: [note("a", "hidden text")] } }, open: false }).context)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Prompt Notes (1)")
    expect(frame).not.toContain("hidden text")
  } finally {
    app.renderer.destroy()
  }
})

test("an answered note keeps the answer out of the row and opens it from the view icon", async () => {
  const h = harness({
    notes: {
      notes: {
        [SID]: [
          note("a", "what is the cap?", {
            done: true,
            state: "answered",
            sentAt: 5,
            answer: { text: "First line of the answer.\nSecond line of it.", messageID: "msg_1", time: 9 },
          }),
        ],
      },
    },
  })
  const app = await render(h.context)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("what is the cap?")
    // The row carries the question only: an answer inline made the list unreadable.
    expect(frame).not.toContain("First line of the answer.")

    await hover(app, "note-row-a")
    const view = node(app, "note-view-a")
    await app.mockMouse.click(view.x, view.y)
    await settle(app)
    // The harness dialog is a counter: rendering of the detail is covered in plugin-notes-dialogs.
    expect(h.state.dialogs).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("a second click while the send is in flight does not post the prompt twice", async () => {
  let calls = 0
  let release: (id: string) => void = () => {}
  const pending = new Promise<string>((resolve) => (release = resolve))
  const h = harness({
    notes: { notes: { [SID]: [note("a", "send me once")] } },
    enqueue: () => {
      calls += 1
      return pending
    },
  })
  const app = await render(h.context)
  try {
    await hover(app, "note-row-a")
    const send = node(app, "note-send-a")
    await app.mockMouse.click(send.x, send.y)
    await app.mockMouse.click(send.x, send.y)
    await settle(app)
    // The first send is still awaiting the server; the second click is dropped.
    expect(calls).toBe(1)

    release("msg_sent")
    await settle(app)
    const store = h.context.storage.store("notes", { initial: { notes: {} } })[0] as unknown as NotesState
    expect(store.notes[SID][0]).toMatchObject({ done: true, state: "sent", sentID: "msg_sent" })
  } finally {
    app.renderer.destroy()
  }
})

test("the always-mounted runtime writes the answer of a sent note onto it", async () => {
  const h = harness({
    notes: {
      notes: {
        [SID]: [note("a", "why the stall?", { done: true, state: "sent", sentAt: 5, sentID: "msg_note" })],
      },
    },
    messages: [
      { id: "msg_note", type: "user", time: { created: 10 }, text: "why the stall?" },
      {
        id: "msg_step",
        type: "assistant",
        time: { created: 20, completed: 30 },
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool", text: "read" },
        ],
      },
      {
        id: "msg_answer",
        type: "assistant",
        time: { created: 40, completed: 50 },
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
        content: [{ type: "text", text: "Because the box has no height." }],
      },
    ] as unknown as SessionMessageInfo[],
  })
  const app = await testRender(() => <NotesRuntime context={h.context} />, { width: 40, height: 6 })
  try {
    await settle(app)
    const store = h.context.storage.store("notes", { initial: { notes: {} } })[0] as unknown as NotesState
    // The intermediate tool step is skipped; the answer after it is stored, once.
    expect(store.notes[SID][0]).toMatchObject({
      state: "answered",
      answer: { text: "Because the box has no height.", messageID: "msg_answer" },
    })
    expect(h.state.writes).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
