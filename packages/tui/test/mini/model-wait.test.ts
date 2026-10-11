import { expect, test } from "bun:test"
import { nextModelWait, type ModelWaitState } from "../../src/mini/model-wait"

test("a busy status from idle starts waiting at the event time", () => {
  expect(nextModelWait({ phase: "idle" }, { type: "status", status: "busy", at: 10 })).toEqual({
    phase: "waiting",
    since: 10,
  })
})

test("further busy statuses keep the original wait start", () => {
  expect(nextModelWait({ phase: "waiting", since: 10 }, { type: "status", status: "busy", at: 25 })).toEqual({
    phase: "waiting",
    since: 10,
  })
})

test("the first activity promotes waiting to active", () => {
  expect(nextModelWait({ phase: "waiting", since: 10 }, { type: "activity", at: 15 })).toEqual({
    phase: "active",
    since: 15,
  })
})

test("activity outside waiting is ignored", () => {
  const idle: ModelWaitState = { phase: "idle" }
  const active: ModelWaitState = { phase: "active", since: 5 }
  expect(nextModelWait(idle, { type: "activity", at: 30 })).toBe(idle)
  expect(nextModelWait(active, { type: "activity", at: 30 })).toBe(active)
})

test("idle and retry reset the machine", () => {
  for (const status of ["idle", "retry"] as const) {
    expect(nextModelWait({ phase: "active", since: 5 }, { type: "status", status, at: 40 })).toEqual({ phase: "idle" })
    expect(nextModelWait({ phase: "waiting", since: 5 }, { type: "status", status, at: 40 })).toEqual({ phase: "idle" })
  }
})

test("after a reset a fresh busy starts a new wait", () => {
  expect(nextModelWait({ phase: "idle" }, { type: "status", status: "busy", at: 50 })).toEqual({
    phase: "waiting",
    since: 50,
  })
})
