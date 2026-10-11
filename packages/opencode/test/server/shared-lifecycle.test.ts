import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { installSharedLifecycle } from "../../src/server/shared/lifecycle"

describe("shared-server lifecycle", () => {
  let home: string
  let previous: string | undefined

  beforeEach(() => {
    previous = process.env.XDG_DATA_HOME
    home = mkdtempSync(path.join(tmpdir(), "ss-lifecycle-"))
    process.env.XDG_DATA_HOME = home
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })

  test("exits via onIdle once the last client stayed away past the grace", async () => {
    let clock = 1_000
    let idle = 0
    const result = await installSharedLifecycle({
      url: "http://127.0.0.1:1",
      password: "x",
      onIdle: () => {
        idle++
      },
      graceMs: 1_000,
      pollMs: 5,
      now: () => clock,
      active: () => 0,
    })
    expect(result.owned).toBe(true)
    clock += 2_000
    await Bun.sleep(50)
    expect(idle).toBe(1)
  })

  test("a present client keeps the default mode alive", async () => {
    let clock = 1_000
    let idle = 0
    await installSharedLifecycle({
      url: "http://127.0.0.1:1",
      password: "x",
      onIdle: () => {
        idle++
      },
      graceMs: 1_000,
      pollMs: 5,
      now: () => clock,
      active: () => 1,
    })
    clock += 60_000
    await Bun.sleep(50)
    expect(idle).toBe(0)
  })

  test("persistent never exits on idle, however long it lasts", async () => {
    let clock = 1_000
    let idle = 0
    const result = await installSharedLifecycle({
      url: "http://127.0.0.1:1",
      password: "x",
      persistent: true,
      onIdle: () => {
        idle++
      },
      graceMs: 1_000,
      pollMs: 5,
      now: () => clock,
      active: () => 0,
    })
    expect(result.owned).toBe(true)
    clock += 600_000
    await Bun.sleep(50)
    expect(idle).toBe(0)
  })
})
