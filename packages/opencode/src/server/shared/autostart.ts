import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readLock, probeHealth } from "./lock"

// The systemd user service starts this process unconditionally at login, so the
// on/off switch has to live in the config, not in the unit: absent means on
// (the service is the default, opting out is the exception), and flipping the
// key takes effect the next time the service starts — nothing to uninstall.

export function shouldAutostart(sharedServerAutostart: boolean | undefined): boolean {
  return sharedServerAutostart !== false
}

export const UNIT_NAME = "opencode-shared-server.service"

export function autostartPaths(home: string = os.homedir()) {
  return {
    unit: path.join(home, ".config/systemd/user", UNIT_NAME),
    envFile: path.join(home, ".local/share/opencode/servers", "shared-server.env"),
  }
}

export function unitContent(input: { execPath: string; envFile: string }) {
  return `[Unit]
Description=opencode shared server (resident; disable via sharedServerAutostart=false)

[Service]
EnvironmentFile=${input.envFile}
ExecStart=${input.execPath} serve --shared --hostname 127.0.0.1 --persistent
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`
}

/**
 * Restart when the binary on disk is newer than the running service — i.e. an
 * update landed after the service started. Without this, an updated install
 * keeps the old resident forever while new windows spawn their own on-demand
 * servers next to it.
 */
export function shouldRestartService(serviceStartedAtMs: number | undefined, binaryMtimeMs: number | undefined): boolean {
  if (serviceStartedAtMs === undefined || binaryMtimeMs === undefined) return false
  return binaryMtimeMs > serviceStartedAtMs
}

// Process start time in wall-clock ms, read from /proc — the same source
// systemctl's ActiveEnterTimestamp would give, without locale parsing.
function processStartMs(pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const end = stat.lastIndexOf(")")
    const fields = stat.slice(end + 2).split(" ")
    const starttimeTicks = Number(fields[19])
    if (!Number.isFinite(starttimeTicks)) return undefined
    const uptimeSec = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0])
    const nowMs = Date.now()
    return nowMs - Math.round((uptimeSec - starttimeTicks / 100) * 1000)
  } catch {
    return undefined
  }
}

async function systemctl(args: string[]): Promise<{ code: number; out: string; err: string } | undefined> {
  try {
    const child = Bun.spawn(["systemctl", "--user", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code: exitCode, out: stdout.trim(), err: stderr.trim() }
  } catch {
    return undefined
  }
}

function ensureEnvFile(envFile: string): boolean {
  if (fs.existsSync(envFile)) return false
  fs.mkdirSync(path.dirname(envFile), { recursive: true })
  fs.writeFileSync(envFile, `OPENCODE_SERVER_PASSWORD=${randomBytes(24).toString("hex")}\n`, { mode: 0o600 })
  fs.chmodSync(envFile, 0o600)
  return true
}

function writeUnitIfChanged(unit: string, content: string): boolean {
  if (fs.existsSync(unit) && fs.readFileSync(unit, "utf8") === content) return false
  fs.mkdirSync(path.dirname(unit), { recursive: true })
  fs.writeFileSync(unit, content)
  return true
}

async function serviceMainPid(): Promise<number | undefined> {
  const show = await systemctl(["show", UNIT_NAME, "-p", "MainPID", "--value"])
  if (!show || show.code !== 0) return undefined
  const pid = Number(show.out)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

export type InstallReport = {
  supported: boolean
  reason?: string
  envFileWritten: boolean
  unitWritten: boolean
  enabled: boolean
  restarted: boolean
  started: boolean
  mainPid?: number
}

/**
 * Idempotently installs the autostart service: password file, unit, enable, and
 * a restart/start when the running service predates the current binary. Safe to
 * call on every shared-mode TUI start — when everything is current it costs one
 * lock read and two systemctl queries and touches nothing.
 */
export async function installAutostart(options: { timeoutMs?: number } = {}): Promise<InstallReport> {
  const report: InstallReport = {
    supported: true,
    envFileWritten: false,
    unitWritten: false,
    enabled: false,
    restarted: false,
    started: false,
  }
  // Running from source (bun + script): there is no installable binary path.
  if (process.argv[1]?.match(/\.[cm]?[jt]s$/)) {
    return { ...report, supported: false, reason: "development entry" }
  }
  if (process.platform !== "linux") {
    return { ...report, supported: false, reason: `platform ${process.platform}` }
  }
  const probe = await systemctl(["is-enabled", UNIT_NAME])
  if (probe === undefined) {
    return { ...report, supported: false, reason: "no user systemd" }
  }

  const paths = autostartPaths()
  report.envFileWritten = ensureEnvFile(paths.envFile)
  const content = unitContent({ execPath: process.execPath, envFile: paths.envFile })
  report.unitWritten = writeUnitIfChanged(paths.unit, content)
  if (report.unitWritten) await systemctl(["daemon-reload"])

  const enable = await systemctl(["enable", UNIT_NAME])
  report.enabled = enable !== undefined && enable.code === 0

  const active = await systemctl(["is-active", UNIT_NAME])
  const mainPid = await serviceMainPid()
  report.mainPid = mainPid

  if (active?.out === "active" && mainPid !== undefined) {
    let binaryMtimeMs: number | undefined
    try {
      binaryMtimeMs = fs.statSync(process.execPath).mtimeMs
    } catch {
      binaryMtimeMs = undefined
    }
    if (shouldRestartService(processStartMs(mainPid), binaryMtimeMs)) {
      const restart = await systemctl(["try-restart", UNIT_NAME])
      report.restarted = restart !== undefined && restart.code === 0
    }
  } else if (active?.out === "inactive" || active?.out === "failed") {
    const start = await systemctl(["start", UNIT_NAME])
    report.started = start !== undefined && start.code === 0
  }

  if (report.restarted || report.started) await waitUntilHealthy(options.timeoutMs ?? 8_000)
  return report
}

async function waitUntilHealthy(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = readLock()
    if (lock) {
      const health = await probeHealth(lock.url, lock.password)
      if (health && health.version === lock.version) return
    }
    await Bun.sleep(100)
  }
}

/** The gated entry the shared-mode TUI start calls: config off means no-op. */
export async function ensureAutostart(): Promise<void> {
  try {
    const { Config } = await import("@/config/config")
    const { AppRuntime } = await import("@/effect/app-runtime")
    const global = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
    if (!shouldAutostart(global.sharedServerAutostart)) return
    await installAutostart()
  } catch {
    // Autostart is an optimization; the finder's fallback covers its absence.
  }
}

export async function statusAutostart(): Promise<Record<string, unknown>> {
  const paths = autostartPaths()
  const [enabled, active, mainPid] = await Promise.all([
    systemctl(["is-enabled", UNIT_NAME]),
    systemctl(["is-active", UNIT_NAME]),
    serviceMainPid(),
  ])
  const lock = readLock()
  return {
    supported: process.platform === "linux" && enabled !== undefined,
    unit: fs.existsSync(paths.unit) ? paths.unit : undefined,
    envFile: fs.existsSync(paths.envFile) ? paths.envFile : undefined,
    enabled: enabled?.out,
    active: active?.out,
    mainPid,
    lock: lock ? { url: lock.url, version: lock.version } : undefined,
  }
}

export async function removeAutostart(): Promise<void> {
  await systemctl(["disable", "--now", UNIT_NAME])
  const paths = autostartPaths()
  for (const file of [paths.unit, paths.envFile]) {
    try {
      fs.unlinkSync(file)
    } catch {}
  }
  await systemctl(["daemon-reload"])
}

export * as SharedAutostart from "./autostart"
