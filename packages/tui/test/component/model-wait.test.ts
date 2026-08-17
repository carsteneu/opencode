import { describe, expect, test } from "bun:test"
import { nextModelWait } from "../../src/component/prompt/model-wait"

const busy = (at: number) => ({ type: "status" as const, status: "busy" as const, at })
const idle = (at: number) => ({ type: "status" as const, status: "idle" as const, at })
const retry = (at: number) => ({ type: "status" as const, status: "retry" as const, at })
const activity = (at: number) => ({ type: "activity" as const, at })

describe("nextModelWait", () => {
  test("idle + busy -> waiting with clock start", () => {
    const state = nextModelWait({ phase: "idle" }, busy(1_000))
    expect(state).toEqual({ phase: "waiting", since: 1_000 })
  })

  test("waiting + first activity -> active", () => {
    let state = nextModelWait({ phase: "idle" }, busy(1_000))
    state = nextModelWait(state, activity(4_000))
    expect(state).toEqual({ phase: "active", since: 4_000 })
  })

  test("repeated busy events do not reset the waiting clock", () => {
    let state = nextModelWait({ phase: "idle" }, busy(1_000))
    state = nextModelWait(state, busy(3_000))
    expect(state).toEqual({ phase: "waiting", since: 1_000 })
  })

  test("busy after activity stays active", () => {
    let state = nextModelWait({ phase: "idle" }, busy(1_000))
    state = nextModelWait(state, activity(2_000))
    state = nextModelWait(state, busy(5_000))
    expect(state).toEqual({ phase: "active", since: 2_000 })
  })

  test("idle resets to idle", () => {
    let state = nextModelWait({ phase: "idle" }, busy(1_000))
    state = nextModelWait(state, activity(2_000))
    state = nextModelWait(state, idle(9_000))
    expect(state).toEqual({ phase: "idle" })
  })

  test("retry hands over to idle; next busy starts a fresh waiting clock", () => {
    let state = nextModelWait({ phase: "idle" }, busy(1_000))
    state = nextModelWait(state, retry(2_000))
    expect(state).toEqual({ phase: "idle" })
    state = nextModelWait(state, busy(20_000))
    expect(state).toEqual({ phase: "waiting", since: 20_000 })
  })

  test("spurious activity while idle is ignored", () => {
    const state = nextModelWait({ phase: "idle" }, activity(1_000))
    expect(state).toEqual({ phase: "idle" })
  })

  test("activity while active is ignored", () => {
    const state = nextModelWait({ phase: "active", since: 1_000 }, activity(2_000))
    expect(state).toEqual({ phase: "active", since: 1_000 })
  })
})
