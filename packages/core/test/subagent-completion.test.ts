import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SubagentCompletion } from "@opencode/core/session/subagent-completion"
import { SessionSchema } from "@opencode/core/session/schema"
import { ToolOutput } from "@opencode/core/tool-output"

const recovery = {
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

  test("never claims a truncation it did not perform", () => {
    const value = `${"z".repeat(ToolOutput.MAX_BYTES - 1)}\n`
    expect(SubagentCompletion.bound(value)).toBe(value)
  })
})

describe("SubagentCompletion.deliver", () => {
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
    const text = await deliver({ status: "completed", output, recovery })
    expect(text).toContain('state="completed"')
    expect(text).toContain("lines truncated...")
    expect(text).not.toContain("line 4999")
  })

  test("passes a small completed result through unchanged", async () => {
    const text = await deliver({ status: "completed", output: "done", recovery })
    expect(text).toContain("<subagent")
    expect(text).toContain("\ndone\n")
  })
})
