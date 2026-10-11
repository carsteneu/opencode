import { describe, expect, test } from "bun:test"
import { shouldAutostart, shouldRestartService, unitContent, autostartPaths, UNIT_NAME } from "../../src/server/shared/autostart"

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

describe("shared-server autostart unit", () => {
  test("launches through a login shell with the installed binary, password file and persistent flag", () => {
    const content = unitContent({ execPath: "/home/u/.opencode/bin/opencode", envFile: "/home/u/.local/share/opencode/servers/shared-server.env" })
    expect(content).toContain("ExecStart=/bin/bash -ilc 'exec /home/u/.opencode/bin/opencode serve --shared --hostname 127.0.0.1 --persistent'")
    expect(content).toContain("EnvironmentFile=/home/u/.local/share/opencode/servers/shared-server.env")
    expect(content).toContain("Restart=on-failure")
    expect(content).toContain("WantedBy=default.target")
  })

  test("lives in the user systemd directory", () => {
    expect(autostartPaths("/home/u").unit.endsWith(`.config/systemd/user/${UNIT_NAME}`)).toBe(true)
  })
})

describe("shared-server autostart staleness", () => {
  test("restarts when the binary is newer than the running service", () => {
    expect(shouldRestartService(1_000, 2_000)).toBe(true)
  })

  test("no restart when the service predates or matches the binary", () => {
    expect(shouldRestartService(2_000, 1_000)).toBe(false)
    expect(shouldRestartService(1_000, 1_000)).toBe(false)
  })

  test("missing data never restarts", () => {
    expect(shouldRestartService(undefined, 1_000)).toBe(false)
    expect(shouldRestartService(1_000, undefined)).toBe(false)
    expect(shouldRestartService(undefined, undefined)).toBe(false)
  })
})
