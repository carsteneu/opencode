import { Formatter, Logger, type LogLevel } from "effect"
import fs from "fs"
import path from "path"
import { Global } from "../global"
import { runID } from "./shared"

const MAX_LOG_BYTES = 10 * 1024 * 1024
const MAX_ROTATED_FILES = 5

function rotate(file: string) {
  // Best-effort startup rotation; must never block or fail logger creation.
  try {
    if (fs.statSync(file).size < MAX_LOG_BYTES) return
    const dir = path.dirname(file)
    const base = path.basename(file, ".log")
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    fs.renameSync(file, path.join(dir, `${base}-${stamp}.log`))
    const archives = fs
      .readdirSync(dir)
      .filter((entry) => entry.startsWith(`${base}-`) && entry.endsWith(".log"))
      .sort()
    for (const entry of archives.slice(0, Math.max(0, archives.length - MAX_ROTATED_FILES))) {
      fs.unlinkSync(path.join(dir, entry))
    }
  } catch {}
}

function formatter(id: string = runID) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ")
  })
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

export function fileLogger(file = path.join(Global.Path.log, "opencode.log"), id: string = runID) {
  rotate(file)
  // Do not set batchWindow to 0; it causes high idle CPU usage.
  return Logger.toFile(formatter(id), file, { flag: "a" })
}

const stderrLogger = Logger.make((options) => process.stderr.write(formatter().log(options) + "\n"))

export function minimumLogLevel() {
  const value = process.env.OPENCODE_LOG_LEVEL?.toUpperCase()
  const levels = {
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>
  return value && value in levels ? levels[value as keyof typeof levels] : levels.INFO
}

export function loggers() {
  return process.env.OPENCODE_PRINT_LOGS === "1" ? [fileLogger(), stderrLogger] : [fileLogger()]
}

export * as Logging from "./logging"
