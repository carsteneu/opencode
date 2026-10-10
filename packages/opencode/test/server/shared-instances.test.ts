import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  claimIdle,
  graceMsFromEnv,
  instanceTracking,
  release,
  resetInstanceTracking,
  retain,
} from "../../src/server/shared/instances"

describe("shared-server instance unloading", () => {
  const GRACE = 1_000

  beforeEach(() => {
    resetInstanceTracking()
  })

  afterEach(() => {
    resetInstanceTracking()
    delete process.env.OPENCODE_SHARED_SERVER_INSTANCE_IDLE_MS
  })

  test("keeps a directory that still has a client", () => {
    retain("/a")
    expect(claimIdle(GRACE, 10_000)).toEqual([])
  })

  test("claims a directory once its grace elapsed", () => {
    retain("/a")
    release("/a", 1_000)
    expect(claimIdle(GRACE, 1_500)).toEqual([])
    expect(claimIdle(GRACE, 2_100)).toEqual(["/a"])
  })

  test("claims a directory exactly at the grace boundary", () => {
    retain("/a")
    release("/a", 1_000)
    expect(claimIdle(GRACE, 2_000)).toEqual(["/a"])
  })

  test("claims only once per idle episode", () => {
    retain("/a")
    release("/a", 1_000)
    expect(claimIdle(GRACE, 2_100)).toEqual(["/a"])
    expect(claimIdle(GRACE, 9_999)).toEqual([])
  })

  test("a returning client cancels the pending unload", () => {
    retain("/a")
    release("/a", 1_000)
    retain("/a")
    expect(claimIdle(GRACE, 9_999)).toEqual([])
    release("/a", 10_000)
    expect(claimIdle(GRACE, 10_100)).toEqual([])
    expect(claimIdle(GRACE, 11_100)).toEqual(["/a"])
  })

  test("counts several clients of the same directory", () => {
    retain("/a")
    retain("/a")
    release("/a", 1_000)
    expect(claimIdle(GRACE, 9_999)).toEqual([])
    release("/a", 10_000)
    expect(claimIdle(GRACE, 11_100)).toEqual(["/a"])
  })

  test("tracks directories independently", () => {
    retain("/a")
    retain("/b")
    release("/a", 1_000)
    release("/b", 5_000)
    expect(claimIdle(GRACE, 2_100)).toEqual(["/a"])
    expect(claimIdle(GRACE, 6_100)).toEqual(["/b"])
  })

  test("graceMs 0 disables unloading", () => {
    retain("/a")
    release("/a", 1_000)
    expect(claimIdle(0, 999_999)).toEqual([])
    expect(instanceTracking().idle).toEqual({ "/a": 1_000 })
  })

  test("ignores an empty directory", () => {
    retain("")
    release("", 1_000)
    expect(claimIdle(GRACE, 999_999)).toEqual([])
    expect(instanceTracking().idle).toEqual({})
  })

  test("grace comes from the environment", () => {
    expect(graceMsFromEnv()).toBe(60_000)
    process.env.OPENCODE_SHARED_SERVER_INSTANCE_IDLE_MS = "7000"
    expect(graceMsFromEnv()).toBe(7_000)
    process.env.OPENCODE_SHARED_SERVER_INSTANCE_IDLE_MS = "0"
    expect(graceMsFromEnv()).toBe(0)
    process.env.OPENCODE_SHARED_SERVER_INSTANCE_IDLE_MS = "nonsense"
    expect(graceMsFromEnv()).toBe(60_000)
  })
})
