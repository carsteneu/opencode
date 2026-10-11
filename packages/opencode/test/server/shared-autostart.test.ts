import { describe, expect, test } from "bun:test"
import { shouldAutostart } from "../../src/server/shared/autostart"

describe("shared-server autostart gate", () => {
  test("absent config means on (the service is the default)", () => {
    expect(shouldAutostart(undefined)).toBe(true)
  })

  test("explicit true stays on", () => {
    expect(shouldAutostart(true)).toBe(true)
  })

  test("explicit false is the only way off", () => {
    expect(shouldAutostart(false)).toBe(false)
  })
})
