import { describe, expect, test } from "bun:test"
import type { Job } from "@opencode/core/job"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionSchema } from "@opencode/core/session/schema"
import { SubagentCompletion } from "@opencode/core/session/subagent-completion"
import { ToolOutput } from "@opencode/core/tool-output"
import { Effect } from "effect"
import { it } from "./lib/effect"

const recovery = {
  kind: "subagent" as const,
  parentSessionID: SessionSchema.ID.make("ses_deliver_parent"),
  childSessionID: SessionSchema.ID.make("ses_deliver_child"),
  agent: "explore",
  description: "Deliver report",
}

type SyntheticInput = Parameters<SubagentCompletion.SyntheticSession["synthetic"]>[0]

describe("SubagentCompletion", () => {
  it.effect("leaves the report body unchanged when no background work runs", () =>
    Effect.sync(() => {
      const child = SessionSchema.ID.make("ses_child")
      expect(SubagentCompletion.formatBody("Report body", child)).toBe("Report body")
      expect(SubagentCompletion.formatBody("Report body", child, [])).toBe("Report body")
    }),
  )

  it.effect("formats shell, image, and subagent items with descendant session context", () =>
    Effect.sync(() => {
      const child = SessionSchema.ID.make("ses_child")
      const grandchild = SessionSchema.ID.make("ses_grandchild")
      const other = SessionSchema.ID.make("ses_other")
      expect(
        SubagentCompletion.formatBody("Report body", child, [
          { kind: "shell", sessionID: child, shellID: "shell_1", command: "bun test\n  --watch" },
          { kind: "shell", sessionID: grandchild, shellID: "shell_2", command: "  echo   hi  " },
          { kind: "image", sessionID: child, path: "/tmp/chart.png", model: "openai/gpt-image-1" },
          { kind: "image", sessionID: other, path: "/tmp/other.png", model: "acme/image" },
          {
            kind: "subagent",
            sessionID: child,
            childSessionID: grandchild,
            agent: "explore",
            description: "Audit\n routes",
          },
        ]),
      ).toBe(
        [
          "Report body",
          "",
          "Background work still running:",
          "- shell (shell_1): bun test --watch",
          "- shell (shell_2, in ses_grandchild): echo hi",
          "- image (openai/gpt-image-1): /tmp/chart.png",
          "- image (acme/image, in ses_other): /tmp/other.png",
          "- subagent (explore, sessionID: ses_grandchild): Audit routes",
        ].join("\n"),
      )
    }),
  )

  it.effect("labels a completed report with pending background work as running, only in the model text", () =>
    Effect.gen(function* () {
      const notificationID = SessionMessage.ID.create()
      const sent: SyntheticInput[] = []
      const completed: SessionMessage.ID[] = []
      const sessions: SubagentCompletion.SyntheticSession = {
        synthetic: (input) =>
          Effect.sync(() => {
            sent.push(input)
            return input
          }),
      }
      const jobs = {
        completeBackground: (id: SessionMessage.ID) =>
          Effect.sync(() => {
            completed.push(id)
          }),
      } satisfies Pick<Job.Interface, "completeBackground">

      yield* SubagentCompletion.deliver(sessions, jobs, {
        status: "completed",
        output: "All green\n\nBackground work still running:\n- shell (shell_1): bun test",
        notificationID,
        recovery,
      })
      yield* SubagentCompletion.deliver(sessions, jobs, { status: "error", error: "boom", recovery })
      yield* SubagentCompletion.deliver(sessions, jobs, { status: "cancelled", recovery })
      // A running job has nothing to report and must not be acknowledged.
      yield* SubagentCompletion.deliver(sessions, jobs, { status: "running", recovery })
      yield* SubagentCompletion.deliver(sessions, jobs, { status: "completed", output: "All done", recovery })

      expect(sent).toHaveLength(4)
      expect(sent[0]?.text).toBe(
        [
          '<subagent sessionID="ses_deliver_child" state="running" description="Deliver report">',
          "All green",
          "",
          "Background work still running:",
          "- shell (shell_1): bun test",
          "</subagent>",
        ].join("\n"),
      )
      expect(sent[0]?.metadata?.state).toBe("completed")
      expect(sent[3]?.text).toBe(
        ['<subagent sessionID="ses_deliver_child" state="completed" description="Deliver report">', "All done", "</subagent>"].join(
          "\n",
        ),
      )
      expect(sent[1]?.text).toBe(
        [
          '<subagent sessionID="ses_deliver_child" state="error" description="Deliver report">',
          "boom",
          "</subagent>",
        ].join("\n"),
      )
      expect(sent[2]?.text).toBe(
        [
          '<subagent sessionID="ses_deliver_child" state="cancelled" description="Deliver report">',
          "Subagent cancelled",
          "</subagent>",
        ].join("\n"),
      )
      expect(completed).toEqual([notificationID])
    }),
  )

  it.effect("preserves a pre-formatted cancelled body so restart replay keeps running-work context", () =>
    Effect.gen(function* () {
      const notificationID = SessionMessage.ID.create()
      const sent: SyntheticInput[] = []
      const sessions: SubagentCompletion.SyntheticSession = {
        synthetic: (input) =>
          Effect.sync(() => {
            sent.push(input)
            return input
          }),
      }
      const jobs = {
        completeBackground: () => Effect.void,
      } satisfies Pick<Job.Interface, "completeBackground">
      const output = ["Subagent cancelled", "", "Background work still running:", "- shell (shell_1): bun test"].join(
        "\n",
      )

      yield* SubagentCompletion.deliver(sessions, jobs, { status: "cancelled", output, notificationID, recovery })
      yield* SubagentCompletion.deliver(sessions, jobs, { status: "cancelled", error: "Cancel failed", recovery })

      expect(sent[0]?.text).toBe(
        [
          '<subagent sessionID="ses_deliver_child" state="cancelled" description="Deliver report">',
          output,
          "</subagent>",
        ].join("\n"),
      )
      expect(sent[1]?.text).toBe(
        [
          '<subagent sessionID="ses_deliver_child" state="cancelled" description="Deliver report">',
          "Cancel failed",
          "</subagent>",
        ].join("\n"),
      )
    }),
  )
})

const boundRecovery = {
  kind: "subagent" as const,
  parentSessionID: SessionSchema.ID.make("ses_parent"),
  childSessionID: SessionSchema.ID.make("ses_child"),
  agent: "general",
  description: "Review",
}

describe("SubagentCompletion.bound", () => {
  test("leaves a completion inside the limits unchanged", () => {
    const value = "Review complete\nNo issues found."
    expect(SubagentCompletion.bound(value)).toBe(value)
  })

  test("keeps the head and notes the dropped lines", () => {
    const value = Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join("\n")
    const bounded = SubagentCompletion.bound(value)
    expect(bounded.startsWith("line 0\n")).toBe(true)
    expect(bounded).toContain(`line ${ToolOutput.MAX_LINES - 1}`)
    expect(bounded).not.toContain(`line ${ToolOutput.MAX_LINES}\n`)
    expect(bounded).toContain(`...${5_000 - ToolOutput.MAX_LINES} lines truncated...`)
  })

  test("stops on the byte limit when few lines are long", () => {
    const value = Array.from(
      { length: 2_000 },
      (_, index) => `${String(index).padStart(4, "0")} ${"y".repeat(96)}`,
    ).join("\n")
    const bounded = SubagentCompletion.bound(value)
    expect(bounded).toContain("0000 ")
    expect(bounded).not.toContain("1999 ")
    expect(bounded).toContain("lines truncated...")
    // Only the head is kept, so the retained lines stay within the byte budget.
    expect(bounded.split("\n\n...")[0]!.length).toBeLessThanOrEqual(ToolOutput.MAX_BYTES)
  })

  test("keeps the beginning of one line longer than the whole byte budget and reports the bytes", () => {
    const value = "z".repeat(ToolOutput.MAX_BYTES * 2)
    const bounded = SubagentCompletion.bound(value)
    // The body is not empty: a clipped first line still tells the parent something.
    expect(bounded.startsWith("zzz")).toBe(true)
    expect(bounded).toContain(`...${ToolOutput.MAX_BYTES} bytes truncated...`)
    expect(bounded.split("\n\n...")[0]!.length).toBeLessThanOrEqual(ToolOutput.MAX_BYTES)
  })

  test("never claims a truncation it did not perform", () => {
    const value = `${"z".repeat(ToolOutput.MAX_BYTES - 1)}\n`
    expect(SubagentCompletion.bound(value)).toBe(value)
  })
})

describe("SubagentCompletion.deliver bounding", () => {
  const deliver = (input: Parameters<typeof SubagentCompletion.deliver>[2]) => {
    const notifications: string[] = []
    const sessions = {
      synthetic: (value: { text: string }) =>
        Effect.sync(() => {
          notifications.push(value.text)
        }),
    }
    const jobs = { completeBackground: () => Effect.void }
    return Effect.runPromise(
      SubagentCompletion.deliver(sessions as never, jobs as never, input).pipe(
        Effect.map(() => notifications[0] ?? ""),
      ),
    )
  }

  test("bounds an oversized completed result inside the notification", async () => {
    const output = Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join("\n")
    const text = await deliver({ status: "completed", output, recovery: boundRecovery })
    expect(text).toContain('state="completed"')
    expect(text).toContain("lines truncated...")
    expect(text).not.toContain("line 4999")
  })

  test("passes a small completed result through unchanged", async () => {
    const text = await deliver({ status: "completed", output: "done", recovery: boundRecovery })
    expect(text).toContain("<subagent")
    expect(text).toContain("\ndone\n")
  })
})
