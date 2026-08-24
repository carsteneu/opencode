import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionRetry } from "../../src/session/retry"
import { Resume, RESUME_CONTINUE_NOTICE } from "../../src/session/resume"

describe("session.retry resume window", () => {
  test("exposes a five minute resume window", () => {
    expect(SessionRetry.RESUME_WINDOW_MS).toBe(5 * 60_000)
  })

  test("resumeRemaining reports time left until the deadline", () => {
    expect(SessionRetry.resumeRemaining(2_000_000, 1_000_000)).toBe(1_000_000)
  })

    test("resumeRemaining clamps to zero past the deadline", () => {
      expect(SessionRetry.resumeRemaining(1_000_000, 1_500_000)).toBe(0)
    })

})

const text = (value: string) => ({ type: "text" as const, text: value })
const reasoning = (value: string, metadata?: Record<string, any>) => ({
  type: "reasoning" as const,
  text: value,
  ...(metadata ? { metadata } : {}),
})
const tool = (
  callID: string,
  name: string,
  state: SessionV1.ToolState,
) => ({ type: "tool" as const, callID, tool: name, state })
const pendingTool = (callID: string, name: string) =>
  tool(callID, name, { status: "pending" as const, input: {}, raw: "" })
const runningTool = (callID: string, name: string) =>
  tool(callID, name, {
    status: "running" as const,
    input: { command: "ls" },
    time: { start: 0 },
  })
const completedTool = (callID: string, name: string, output: string, input: Record<string, any> = {}) =>
  tool(callID, name, {
    status: "completed" as const,
    input,
    output,
    title: name,
    metadata: {},
    time: { start: 0, end: 1 },
  })
const erroredTool = (callID: string, name: string, error: string) =>
  tool(callID, name, {
    status: "error" as const,
    input: {},
    error,
    time: { start: 0, end: 1 },
  })

function assertLastIsContinueNotice(messages: ModelMessage[]) {
  const last = messages.at(-1)
  expect(last).toMatchObject({ role: "user" })
  expect((last as { content: string }).content).toBe(RESUME_CONTINUE_NOTICE)
}

describe("session.resume.buildResumeMessages", () => {
  test("always appends the continue notice for the model", () => {
    const messages = Resume.buildResumeMessages([text("hello")])
    expect(messages.at(-1)).toMatchObject({ role: "user" })
    expect((messages.at(-1) as { content: string }).content).toBe(RESUME_CONTINUE_NOTICE)
  })

  test("carries committed text into a partial assistant message", () => {
    const messages = Resume.buildResumeMessages([text("hello"), text(" world")])
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: " world" },
      ],
    })
    assertLastIsContinueNotice(messages)
  })

  test("carries reasoning parts with their metadata", () => {
    const messages = Resume.buildResumeMessages([reasoning("thinking...", { anthropic: { signature: "sig" } })])
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking...", providerOptions: { anthropic: { signature: "sig" } } },
      ],
    })
    assertLastIsContinueNotice(messages)
  })

  test("keeps executed tool results and their matching call", () => {
    const messages = Resume.buildResumeMessages([
      text("let me check"),
      completedTool("call_1", "bash", "done", { command: "ls" }),
    ])
    expect(messages).toHaveLength(3)
    const assistant = messages[0] as ModelMessage & { content: Array<Record<string, unknown>> }
    expect(assistant.content).toContainEqual({ type: "text", text: "let me check" })
    expect(assistant.content).toContainEqual({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "bash",
      input: { command: "ls" },
    })
    expect(messages[1]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_1", toolName: "bash", output: { type: "text", value: "done" } }],
    })
    assertLastIsContinueNotice(messages)
  })

  test("keeps a real tool failure as an error result", () => {
    const messages = Resume.buildResumeMessages([erroredTool("call_2", "bash", "command not found")])
    const assistant = messages[0] as ModelMessage & { content: Array<Record<string, unknown>> }
    expect(assistant.content.some((part) => part.type === "tool-call" && part.toolCallId === "call_2")).toBe(true)
    expect(messages[1]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_2",
          output: { type: "error-text", value: "command not found" },
        },
      ],
    })
    assertLastIsContinueNotice(messages)
  })

  test("rewinds announced tool calls that never produced a result", () => {
    const messages = Resume.buildResumeMessages([
      text("announcing"),
      pendingTool("call_3", "bash"),
      runningTool("call_4", "edit"),
    ])
    expect(messages).toHaveLength(2)
    const assistant = messages[0] as ModelMessage & { content: Array<Record<string, unknown>> }
    expect(assistant.content).toEqual([{ type: "text", text: "announcing" }])
    expect(JSON.stringify(messages)).not.toContain("call_3")
    expect(JSON.stringify(messages)).not.toContain("call_4")
    expect(JSON.stringify(messages)).not.toContain('"tool-result"')
    assertLastIsContinueNotice(messages)
  })

  test("drops structural and non-model parts", () => {
    const messages = Resume.buildResumeMessages([
      text("result"),
      { type: "step-start", snapshot: "s1" },
      { type: "patch", hash: "h", files: ["a.ts"] },
      { type: "file", mime: "text/plain", url: "file:///x" },
    ])
    expect(messages).toHaveLength(2)
    const assistant = messages[0] as ModelMessage & { content: Array<Record<string, unknown>> }
    expect(assistant.content).toEqual([{ type: "text", text: "result" }])
    assertLastIsContinueNotice(messages)
  })

  test("produces only the notice when nothing model-facing was committed", () => {
    const messages = Resume.buildResumeMessages([])
    expect(messages).toHaveLength(1)
    assertLastIsContinueNotice(messages)
  })
})
