import { describe, expect, test } from "bun:test"
import { createExitGuard } from "./exit-guard"

describe("createExitGuard", () => {
  test("first press arms instead of firing", () => {
    let time = 0
    const guard = createExitGuard({ windowMs: 2000, now: () => time })
    expect(guard.press()).toBe("armed")
  })

  test("second press inside the window fires", () => {
    let time = 0
    const guard = createExitGuard({ windowMs: 2000, now: () => time })
    guard.press()
    time += 1000
    expect(guard.press()).toBe("fire")
  })

  test("press after the window expires re-arms instead of firing", () => {
    let time = 0
    const guard = createExitGuard({ windowMs: 2000, now: () => time })
    guard.press()
    time += 2500
    expect(guard.press()).toBe("armed")
  })

  test("armed() reflects whether the guard is currently armed", () => {
    let time = 0
    const guard = createExitGuard({ windowMs: 2000, now: () => time })
    expect(guard.armed()).toBe(false)
    guard.press()
    expect(guard.armed()).toBe(true)
    time += 2500
    expect(guard.armed()).toBe(false)
  })

  test("reset() disarms immediately", () => {
    let time = 0
    const guard = createExitGuard({ windowMs: 2000, now: () => time })
    guard.press()
    guard.reset()
    expect(guard.armed()).toBe(false)
    expect(guard.press()).toBe("armed")
  })
})
