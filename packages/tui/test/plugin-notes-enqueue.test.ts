import { expect, test } from "bun:test"
import { createPluginContext, type Registry, type usePluginHost } from "../src/plugin/api"

type Host = ReturnType<typeof usePluginHost>

function setup(input: { outcome?: "resolve" | "reject"; revert?: boolean } = {}) {
  const sent: Array<{ sessionID: string; text: string }> = []
  const commits: string[] = []
  const failure = new Error("prompt rejected")
  const host = {
    app: { version: "test", channel: "test" },
    client: {
      api: { session: { revert: { commit: async ({ sessionID }: { sessionID: string }) => commits.push(sessionID) } } },
    },
    keymap: {},
    shortcuts: {},
    keymapState: {},
    sessionTabs: {},
    toast: { show: () => {} },
    route: { data: { type: "home" }, navigate: () => {} },
    data: {
      session: {
        get: (sessionID: string) => ({ id: sessionID, title: "Session", ...(input.revert ? { revert: {} } : {}) }),
        prompt: (value: { sessionID: string; text: string }) => {
          sent.push(value)
          return input.outcome === "reject" ? Promise.reject(failure) : Promise.resolve({ id: "msg_1" })
        },
      },
    },
  } as unknown as Host
  const registry: Registry = { has: () => false, set() {}, remove() {}, active: () => true }
  return {
    sent,
    commits,
    context: createPluginContext({ host, id: "test", options: undefined, owned: [], registry }),
  }
}

test("enqueue sends the note text through the data layer's prompt path and reports the message id", async () => {
  const harness = setup()
  const id = await harness.context.data.session.enqueue({
    sessionID: "ses_1",
    text: "Why does the sidebar not scroll?",
  })
  // The data layer's prompt() is what mints the id, admits the row optimistically and tracks the
  // outbox; routing through it is the whole point of the contract addition. The id is what lets a
  // caller correlate the answer that follows.
  expect(harness.sent).toEqual([{ sessionID: "ses_1", text: "Why does the sidebar not scroll?" }])
  expect(id).toBe("msg_1")
})

test("enqueue reports a rejected send instead of swallowing it", async () => {
  const harness = setup({ outcome: "reject" })
  // Checking a note off is only correct when the send really happened, so the rejection has to
  // reach the caller.
  await expect(harness.context.data.session.enqueue({ sessionID: "ses_1", text: "hello" })).rejects.toThrow(
    "prompt rejected",
  )
})

test("enqueue settles a staged revert before admitting the prompt", async () => {
  const harness = setup({ revert: true })
  await harness.context.data.session.enqueue({ sessionID: "ses_1", text: "hello" })
  // A committed revert splices every local row at or after its boundary, which would delete the row
  // this send just admitted.
  expect(harness.commits).toEqual(["ses_1"])
})

test("enqueue leaves a session without a revert alone", async () => {
  const harness = setup()
  await harness.context.data.session.enqueue({ sessionID: "ses_1", text: "hello" })
  expect(harness.commits).toEqual([])
})

test("the rest of the session surface passes through unchanged", () => {
  const harness = setup()
  expect(harness.context.data.session.get("ses_9")?.id).toBe("ses_9")
})
