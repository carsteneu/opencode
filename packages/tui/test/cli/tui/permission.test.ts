import { expect, test } from "bun:test"
import type { PermissionRequest, ToolPart } from "@opencode-ai/sdk/v2"
import { permissionInput } from "../../../src/routes/session/permission"

const request = {
  id: "per_test",
  sessionID: "ses_test",
  permission: "bash",
  patterns: ["rm -rf build"],
  metadata: { command: "rm -rf build" },
  always: ["rm *"],
  tool: { messageID: "msg_test", callID: "call_test" },
} satisfies PermissionRequest

test("uses permission metadata while the linked tool input is pending", () => {
  const part = {
    id: "part_test",
    sessionID: "ses_test",
    messageID: "msg_test",
    type: "tool",
    callID: "call_test",
    tool: "bash",
    state: { status: "pending", input: {}, raw: '{"command":"rm -rf build"}' },
  } satisfies ToolPart

  expect(permissionInput(request, [part])).toEqual({ command: "rm -rf build" })
})

test("prefers authoritative tool input after the tool starts", () => {
  const part = {
    id: "part_test",
    sessionID: "ses_test",
    messageID: "msg_test",
    type: "tool",
    callID: "call_test",
    tool: "bash",
    state: {
      status: "running",
      input: { command: "rm -rf dist" },
      metadata: {},
      time: { start: 1 },
    },
  } satisfies ToolPart

  expect(permissionInput(request, [part])).toEqual({ command: "rm -rf dist" })
})
