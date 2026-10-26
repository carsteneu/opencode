/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAppFixture } from "./fixture/app"
import { directory, json, type FetchHandler } from "./fixture/tui-client"

// The state file the plugin's storage key resolves to: <state>/<channel>/tui/plugin.<id>.<key>.json
const NOTES_STATE = path.join("test", "tui", "plugin.opencode.sidebar.notes.notes.json")

const session = {
  id: "ses_test",
  title: "Prompt notes",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

function server() {
  const prompts: Array<{ text: string }> = []
  const fetch: FetchHandler = async (url, request) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === "/api/session/ses_test") return json({ data: session })
    if (url.pathname === "/api/session/ses_test/message") return json({ data: [], cursor: {} })
    if (url.pathname === "/api/session/ses_test/inbox") return json({ data: [] })
    if (url.pathname === "/api/session/ses_test/prompt" && request.method === "POST") {
      const body = (await request.json()) as { text: string; id?: string }
      prompts.push({ text: body.text })
      return json({
        data: {
          id: body.id ?? "msg_1",
          sessionID: "ses_test",
          time: { created: Date.now() },
          type: "user",
          payload: { text: body.text },
          delivery: "steer",
        },
      })
    }
    return undefined
  }
  return { fetch, prompts }
}

async function boot(state: string, fetch: FetchHandler) {
  const app = await createAppFixture({
    width: 140,
    height: 40,
    state,
    config: { animations: false },
    args: { sessionID: "ses_test" },
    fetch,
  })
  await app.ready
  // The startup overlay swallows input for a moment after plugins are ready.
  await Bun.sleep(3500)
  await app.renderOnce()
  return app
}

/** ctrl+shift+n as configured for notes.add. */
async function addNote(app: Awaited<ReturnType<typeof boot>>, text: string) {
  app.mockInput.pressKey("n", { ctrl: true, shift: true })
  await app.waitForFrame((frame) => frame.includes("Add a note"))
  // The dialog focuses its textarea on the tick after it mounts.
  await Bun.sleep(30)
  await app.renderOnce()
  await app.mockInput.typeText(text)
  app.mockInput.pressEnter()
}

async function state(root: string) {
  return JSON.parse(await Bun.file(path.join(root, NOTES_STATE)).text()) as {
    notes: Record<string, Array<{ id: string; text: string; done: boolean; state: string }>>
  }
}

test("a note added through the keybinding shows up in the sidebar and survives a restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-notes-"))
  try {
    const first = server()
    const app = await boot(root, first.fetch)
    try {
      await app.waitForFrame((frame) => frame.includes("Prompt Notes"))

      await addNote(app, "why does the turn stall?")
      await app.waitForFrame(
        (frame) => frame.includes("Prompt Notes (1)") && frame.includes("why does the turn stall?"),
      )
    } finally {
      await app[Symbol.asyncDispose]()
    }

    const second = server()
    const reopened = await boot(root, second.fetch)
    try {
      // Read back from the state file, not from the session: the note is the plugin's own memory.
      await reopened.waitForFrame(
        (frame) => frame.includes("Prompt Notes (1)") && frame.includes("why does the turn stall?"),
      )
      expect((await state(root)).notes["ses_test"][0]).toMatchObject({
        text: "why does the turn stall?",
        done: false,
        state: "open",
      })
      expect(second.prompts).toEqual([])
    } finally {
      await reopened[Symbol.asyncDispose]()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

test("sending a note enqueues the prompt and checks it off", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-notes-"))
  try {
    const api = server()
    const app = await boot(root, api.fetch)
    try {
      await app.waitForFrame((frame) => frame.includes("Prompt Notes"))

      await addNote(app, "run this for me")
      await app.waitForFrame((frame) => frame.includes("run this for me"))

      const id = (await state(root)).notes["ses_test"][0].id
      const row = app.renderer.root.findDescendantById(`note-row-${id}`)
      if (!row) throw new Error("note row not rendered")
      // The actions live behind the row's hover.
      await app.mockMouse.moveTo(row.x + 1, row.y)
      await app.waitForFrame((frame) => frame.includes("▶"))
      const send = app.renderer.root.findDescendantById(`note-send-${id}`)
      if (!send) throw new Error("send action not rendered")
      await app.mockMouse.click(send.x, send.y)

      await app.waitForFrame((frame) => frame.includes("Prompt Notes (0)"))
      // One send path: the data layer's prompt(), which posts the note text as the turn's prompt.
      expect(api.prompts).toEqual([{ text: "run this for me" }])
      expect((await state(root)).notes["ses_test"][0]).toMatchObject({ done: true, state: "sent" })
    } finally {
      await app[Symbol.asyncDispose]()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
