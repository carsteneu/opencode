import { expect, test } from "bun:test"
import { createPluginContext, type Registry, type usePluginHost } from "../src/plugin/api"

type Host = ReturnType<typeof usePluginHost>

function setup(outcome: "resolve" | "reject" = "resolve") {
  const sent: Array<{ sessionID: string; text: string }> = []
  const failure = new Error("prompt rejected")
  const host = {
    app: { version: "test", channel: "test" },
    client: { api: {} },
    keymap: {},
    shortcuts: {},
    keymapState: {},
    sessionTabs: {},
    toast: { show: () => {} },
    route: { data: { type: "home" }, navigate: () => {} },
    data: {
      session: {
        get: (sessionID: string) => ({ id: sessionID, title: "Session" }),
        prompt: (input: { sessionID: string; text: string }) => {
          sent.push(input)
          return outcome === "resolve" ? Promise.resolve({ id: "msg_1" }) : Promise.reject(failure)
        },
      },
    },
  } as unknown as Host
  const registry: Registry = { has: () => false, set() {}, remove() {}, active: () => true }
  return {
    sent,
    context: createPluginContext({ host, id: "test", options: undefined, owned: [], registry }),
  }
}

test("enqueue sends the note text through the data layer's prompt path", async () => {
  const harness = setup()
  await harness.context.data.session.enqueue({ sessionID: "ses_1", text: "Why does the sidebar not scroll?" })
  // The data layer's prompt() is what mints the id, admits the row optimistically and tracks the
  // outbox; routing through it is the whole point of the contract addition.
  expect(harness.sent).toEqual([{ sessionID: "ses_1", text: "Why does the sidebar not scroll?" }])
})

test("enqueue reports a rejected send instead of swallowing it", async () => {
  const harness = setup("reject")
  // Checking a note off is only correct when the send really happened, so the rejection has to
  // reach the caller.
  await expect(harness.context.data.session.enqueue({ sessionID: "ses_1", text: "hello" })).rejects.toThrow(
    "prompt rejected",
  )
})

test("the rest of the session surface passes through unchanged", () => {
  const harness = setup()
  expect(harness.context.data.session.get("ses_9")?.id).toBe("ses_9")
})
