import { expect, test } from "bun:test"
import { locationTtl } from "../src/location-services"

test("location service TTL defaults to 60 minutes", () => {
  const saved = process.env.OPENCODE_LOCATION_TTL_MS
  delete process.env.OPENCODE_LOCATION_TTL_MS
  expect(locationTtl()).toBe("60 minutes")
  if (saved === undefined) delete process.env.OPENCODE_LOCATION_TTL_MS
  else process.env.OPENCODE_LOCATION_TTL_MS = saved
})

test("location service TTL honors OPENCODE_LOCATION_TTL_MS and falls back on invalid", () => {
  const saved = process.env.OPENCODE_LOCATION_TTL_MS
  process.env.OPENCODE_LOCATION_TTL_MS = "30000"
  expect(locationTtl()).toBe(30000)
  process.env.OPENCODE_LOCATION_TTL_MS = "not-a-number"
  expect(locationTtl()).toBe("60 minutes")
  if (saved === undefined) delete process.env.OPENCODE_LOCATION_TTL_MS
  else process.env.OPENCODE_LOCATION_TTL_MS = saved
})
