import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { lockPath, pidAlive, readLock, removeLockIfOwned, serversDir, writeLock, type Lock } from "../../src/server/shared/lock"
import { installSharedLifecycle } from "../../src/server/shared/lifecycle"

const DEAD_PID = 2_147_480_000

function lock(overrides: Partial<Lock> = {}): Lock {
  return {
    pid: process.pid,
    url: "http://127.0.0.1:4711",
    password: "secret",
    version: "9.9.9",
    startedAt: "2026-10-10T00:00:00.000Z",
    ...overrides,
  }
}

describe("shared-server lock", () => {
  let home: string
  let previous: string | undefined

  beforeEach(() => {
    previous = process.env.XDG_DATA_HOME
    home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-shared-lock-"))
    process.env.XDG_DATA_HOME = home
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })

  test("writes a readable lock with mode 0600", async () => {
    const value = lock()
    expect(await writeLock(value)).toBe(true)
    expect(fs.statSync(lockPath("9.9.9")).mode & 0o777).toBe(0o600)
    expect(readLock("9.9.9")).toEqual(value)
  })

  test("keys the lock by version so upgrades never contend", async () => {
    await writeLock(lock({ version: "1.0.0", url: "http://127.0.0.1:1" }))
    await writeLock(lock({ version: "2.0.0", url: "http://127.0.0.1:2" }))
    expect(readLock("1.0.0")?.url).toBe("http://127.0.0.1:1")
    expect(readLock("2.0.0")?.url).toBe("http://127.0.0.1:2")
  })

  test("treats a missing lock as absent", () => {
    expect(readLock("9.9.9")).toBeUndefined()
  })

  test("treats a corrupt lock as absent", () => {
    fs.mkdirSync(serversDir(), { recursive: true })
    fs.writeFileSync(lockPath("9.9.9"), "{ not json")
    expect(readLock("9.9.9")).toBeUndefined()
  })

  test("refuses to steal a lock from a live pid", async () => {
    const peer = lock({ url: "http://127.0.0.1:1" })
    expect(await writeLock(peer)).toBe(true)
    expect(await writeLock(lock({ url: "http://127.0.0.1:2" }))).toBe(false)
    expect(readLock("9.9.9")).toEqual(peer)
  })

  test("reclaims a lock whose pid is dead", async () => {
    fs.mkdirSync(serversDir(), { recursive: true })
    fs.writeFileSync(lockPath("9.9.9"), JSON.stringify(lock({ pid: DEAD_PID, url: "http://127.0.0.1:1" })))
    const mine = lock({ url: "http://127.0.0.1:2" })
    expect(await writeLock(mine)).toBe(true)
    expect(readLock("9.9.9")).toEqual(mine)
  })

  test("pidAlive distinguishes a live pid from an unused one", () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(DEAD_PID)).toBe(false)
  })

  test("removes the lock only when we own it", async () => {
    await writeLock(lock())
    removeLockIfOwned("9.9.9")
    expect(readLock("9.9.9")).toBeUndefined()

    await writeLock(lock({ pid: DEAD_PID }))
    removeLockIfOwned("9.9.9")
    expect(readLock("9.9.9")).toBeDefined()
  })
})

describe("shared-server lifecycle", () => {
  let home: string
  let previous: string | undefined

  beforeEach(() => {
    previous = process.env.XDG_DATA_HOME
    home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-shared-life-"))
    process.env.XDG_DATA_HOME = home
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })

  test("does not fire while a client is attached", async () => {
    let active = 1
    let fired = false
    await installSharedLifecycle({
      url: "http://127.0.0.1:1",
      password: "p",
      graceMs: 30,
      pollMs: 10,
      active: () => active,
      onIdle: () => {
        fired = true
      },
    })
    await Bun.sleep(150)
    expect(fired).toBe(false)
    active = 0
  })

  test("fires after the grace period with no clients and removes its lock", async () => {
    let active = 0
    const idled = Promise.withResolvers<void>()
    const result = await installSharedLifecycle({
      url: "http://127.0.0.1:1",
      password: "p",
      graceMs: 40,
      pollMs: 10,
      active: () => active,
      onIdle: () => idled.resolve(),
    })
    expect(result.owned).toBe(true)
    await Promise.race([idled.promise, Bun.sleep(2_000).then(() => Promise.reject(new Error("idle never fired")))])
    expect(readLock()).toBeUndefined()
  })

  test("reports not-owned when a live peer holds the lock", async () => {
    const peer: Lock = {
      pid: process.pid,
      url: "http://127.0.0.1:1",
      password: "p",
      version: InstallationVersion,
      startedAt: "2026-10-10T00:00:00.000Z",
    }
    expect(await writeLock(peer)).toBe(true)
    const result = await installSharedLifecycle({
      url: "http://127.0.0.1:2",
      password: "q",
      graceMs: 30,
      pollMs: 10,
      active: () => 0,
      onIdle: () => {},
    })
    expect(result.owned).toBe(false)
    expect(readLock()).toEqual(peer)
  })
})
