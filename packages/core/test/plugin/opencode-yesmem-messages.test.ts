import { describe, expect, test } from "bun:test"
import { yesmemEntry } from "./opencode-yesmem-fixture"

type MessagesModule = {
  isHumanUserMessage: (message: any) => boolean
  humanUserMessages: (messages: any[]) => any[]
  countUserTurns: (messages: any[]) => number
  findTerminalUserText: (messages: any[]) => { text: string; part: any; message: any } | undefined
  patchTarget: (message: any) => any
}

const module = (await import(yesmemEntry("messages.ts"))) as MessagesModule

// Frames below are copied from the core that builds them
// (packages/core/src/session/runner/to-llm-message.ts, packages/core/src/skill.ts).
const human = (id: string, text: string, metadata: any = { agents: ["build"] }) => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
  metadata,
})
const synthetic = (id: string, text: string) => ({ id, role: "user", content: [{ type: "text", text }] })
const shell = (id: string) => ({
  id,
  role: "user",
  content: [{ type: "text", text: "The following shell command was executed by the user:\n\nCommand:\nls\n\nOutput:\nx" }],
  metadata: {},
})
const compaction = (id: string) => ({
  id,
  role: "user",
  content: [{ type: "text", text: "<conversation-checkpoint>\n<summary>…</summary>" }],
  metadata: {},
})
const locationSwitch = (id: string) => ({
  id,
  role: "user",
  content: [{ type: "text", text: "The working directory has been changed to /tmp." }],
  metadata: {},
})
const inlinedSkill = (id: string) => ({
  id,
  role: "user",
  content: [{ type: "text", text: '<skill_content name="tdd">\n# Skill: tdd\n</skill_content>' }],
  metadata: {},
})

describe("human turn classification", () => {
  test("recognises the frames the core lowers to user-role messages", () => {
    expect(module.isHumanUserMessage(human("msg_a", "please fix the bug"))).toBe(true)
    expect(module.isHumanUserMessage(synthetic("msg_b", "Plan mode is active."))).toBe(false)
    expect(module.isHumanUserMessage(shell("msg_c"))).toBe(false)
    expect(module.isHumanUserMessage(compaction("msg_d"))).toBe(false)
    expect(module.isHumanUserMessage(locationSwitch("msg_e"))).toBe(false)
    expect(module.isHumanUserMessage(inlinedSkill("msg_f"))).toBe(false)
    expect(module.isHumanUserMessage({ id: "msg_g", role: "assistant", content: [{ type: "text", text: "hi" }] })).toBe(
      false,
    )
  })

  test("drops a message that reuses an earlier id (skill activation) but keeps the human one", () => {
    // Session.skill publishes its event with the id of the triggering message, so the appended skill message
    // carries the same id as the human message it belongs to.
    const messages = [
      human("msg_h1", "activate tdd please"),
      { id: "msg_h1", role: "user", content: [{ type: "text", text: "# Test Driven Development\n…" }], metadata: {} },
    ]

    expect(module.humanUserMessages(messages).length).toBe(1)
    expect(module.findTerminalUserText(messages)?.text).toBe("activate tdd please")
  })

  test("counts turns across non-human user-role messages", () => {
    expect(module.countUserTurns([human("msg_c1", "a"), shell("msg_c2"), human("msg_c3", "b")])).toBe(2)
    expect(module.countUserTurns([human("msg_c4", "a"), synthetic("msg_c5", "reminder"), human("msg_c6", "b")])).toBe(2)
    expect(module.countUserTurns([])).toBe(0)
    expect(module.countUserTurns(undefined as any)).toBe(0)
  })

  test("patches the last part that has text and never walks back into history", () => {
    const withEmptyTail = {
      id: "msg_t1",
      role: "user",
      content: [
        { type: "text", text: "the real request" },
        { type: "text", text: "", },
      ],
      metadata: {},
    }
    expect(module.patchTarget(withEmptyTail)?.text).toBe("the real request")

    // A terminal human message without any text yields no patch target instead of patching an older message.
    const emptyOnly = { id: "msg_t2", role: "user", content: [{ type: "text", text: "" }], metadata: {} }
    expect(
      module.findTerminalUserText([human("msg_t3", "older request"), emptyOnly]),
    ).toBeUndefined()
  })
})
