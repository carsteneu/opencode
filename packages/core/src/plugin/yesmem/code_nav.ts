// tool.execute.before — keep code navigation inside YesMem's index.
//
// Ported from the v1 plugin's code_nav.ts. v1 registered the check as a `tool.execute.before` hook that
// received `(input, output)`; v2 hands the call over as one event, so this module exposes `before(event)`
// and returns the block message (index.ts turns it into a Tool.Error). Tool names follow v2: the shell tool
// is `shell`, not `bash`.
//
// v1 also carried a `dismissedSessions` map that was never written to; it is gone.

import { debugLog } from "./log"
import type { YesMemRPC } from "./rpc"

const blockedCommands = ["grep", "cat", "head", "sed", "awk", "rg", "egrep", "fgrep", "find"]
const blockedTools = new Set(["read"])
const FILE_ATTEMPT_TTL_MS = 3600000 // 1h

// Non-code basenames (no extension) that should never trigger code_nav blocking.
const NON_CODE_BASENAMES = new Set([
  "license",
  "license.txt",
  "license.md",
  "copying",
  "copying.txt",
  "copying.less",
  "notice",
  "notice.txt",
  "readme",
  "readme.txt",
  "readme.md",
  "changelog",
  "changelog.md",
  "changelog.txt",
  "authors",
  "contributors",
  "contributors.txt",
])

// Basename prefixes: Dockerfile, Makefile — accept variants like
// Dockerfile.dev, Dockerfile.prod, GNUmakefile.
const NON_CODE_BASENAME_PREFIXES = ["dockerfile", "makefile", "gnu"]

// Non-code extensions that should never trigger code_nav blocking.
const NON_CODE_EXTENSIONS = new Set([".txt", ".rst", ".md", ".log", ".lock", ".sum", ".license", ".notice"])

// isNonCodeFile returns true for files that are documentation, licensing, or
// build metadata — not source code. Exported for test coverage.
export function isNonCodeFile(rel: string): boolean {
  const lower = rel.toLowerCase()
  const base = lower.split("/").pop() || lower
  if (base.match(/^\.git/)) return true
  if (base.endsWith(".md")) return true
  if (NON_CODE_BASENAMES.has(base)) return true
  for (const prefix of NON_CODE_BASENAME_PREFIXES) {
    if (base === prefix || base.startsWith(prefix + ".")) return true
  }
  const dot = base.lastIndexOf(".")
  if (dot > 0 && NON_CODE_EXTENSIONS.has(base.slice(dot))) return true
  return false
}

function extractFileArgs(command: string): string[] {
  const parts = command.split(/\s+/)
  const files: string[] = []
  for (let i = 1; i < parts.length; i++) {
    const arg = parts[i]
    if (arg.startsWith("-")) continue
    if (arg.includes("*") || arg.includes("?")) continue
    if (arg.includes("/") || arg.match(/\.(go|ts|js|py|rs|java|cpp|c|h|yaml|yml|toml|json|mod|sum)$/)) {
      files.push(arg)
    }
  }
  return files
}

function relativePath(file: string, projectDir: string): string {
  if (!file.startsWith("/") || !projectDir) return file
  const prefix = projectDir.endsWith("/") ? projectDir : projectDir + "/"
  if (file.startsWith(prefix)) return file.slice(prefix.length)
  return file
}

function isBlockedCommand(command: string): boolean {
  return blockedCommands.includes(command.split(/\s+/)[0].toLowerCase())
}

// File paths are model- and repository-controlled; control characters would reach the terminal and the model.
function safe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
}

function suggestTool(file: string, project: string): string {
  return `get_file_symbols("${safe(file)}", "${safe(project)}") for overview, or get_code_snippet(file="${safe(file)}", project="${safe(project)}", start_line=x, end_line=y)`
}

export interface ToolCallEvent {
  readonly tool?: string
  readonly sessionID?: string
  input?: unknown
}

export function codeNavGuard(rpc: YesMemRPC, pluginDirectory: string) {
  // v1 kept one boolean for the whole process, so the first indexed project made every other project look
  // indexed too. v2 plugins are per-location, so the memo is keyed by directory.
  const indexedProjects = new Set<string>()
  const fileAttempts = new Map<string, { count: number; firstSeen: number }>()

  async function ensureIndexed(directory: string): Promise<boolean> {
    if (indexedProjects.has(directory)) return true
    const response = await rpc.call("search_code_index", {
      pattern: "func",
      kind: "function",
      project: directory,
      limit: 1,
    })
    const indexed = !!(response.ok && response.result?.text?.includes("Found"))
    if (indexed) indexedProjects.add(directory)
    return indexed
  }

  async function inGraph(file: string, directory: string, isDir: boolean): Promise<boolean> {
    if (isDir) {
      const response = await rpc.call("get_file_index", { dir: file, project: directory })
      return !!(response.ok && response.result?.text && !response.result.text.includes("No source files found"))
    }
    const response = await rpc.call("get_file_symbols", { file, project: directory })
    // The miss text is "No symbols found in X", which contains "symbol", so substring "symbol" would
    // false-positive; v1 matched the exact miss text and this keeps that.
    return !!(response.ok && response.result?.text && !response.result.text.includes("No symbols found"))
  }

  /** Two-strike with a 1h TTL: the first navigation is blocked, the retry is allowed. */
  function strike(key: string): boolean {
    const entry = fileAttempts.get(key)
    const now = Date.now()
    const attempt = entry && now - entry.firstSeen < FILE_ATTEMPT_TTL_MS ? entry.count : 0
    fileAttempts.set(key, { count: attempt + 1, firstSeen: entry && attempt > 0 ? entry.firstSeen : now })
    return attempt === 0
  }

  async function before(event: ToolCallEvent): Promise<string | undefined> {
    try {
      const tool = event.tool
      if (typeof tool !== "string") return

      const isShell = tool === "shell"
      const isRead = blockedTools.has(tool)
      if (!isShell && !isRead) return

      const directory = pluginDirectory
      const input = (event.input ?? {}) as Record<string, any>

      let targets: string[] = []
      if (isShell) {
        const command = input.command as string
        if (!command || !isBlockedCommand(command)) return
        targets = extractFileArgs(command)
        if (targets.length === 0) return
      } else {
        const target = (input.filePath || input.file_path || "") as string
        if (!target) return
        targets = [target]
      }

      if (!(await ensureIndexed(directory))) {
        debugLog("code_nav", `SKIP-NOT-INDEXED ${tool}`)
        return
      }

      let hit: string | undefined
      for (const target of targets) {
        const relative = relativePath(target, directory).replace(/\/+$/, "")
        if (isNonCodeFile(relative)) continue
        const isDir = target.endsWith("/") || !target.includes(".")
        if (await inGraph(relative, directory, isDir)) {
          hit = relative
          break
        }
      }
      if (!hit) return

      const key = isShell ? targets.map((t) => relativePath(t, directory).replace(/\/+$/, "")).join(",") : hit
      if (!strike(key)) {
        debugLog("code_nav", `ALLOW-2ND ${tool} ${safe(key)}`)
        return
      }

      debugLog("code_nav", `BLOCK-1ST ${tool} ${safe(key)}`)
      const suggestion = suggestTool(isShell ? (targets[0] ?? "") : hit, directory)
      const scope = isShell ? "shell nav on indexed file(s)" : "read on indexed file"
      return `YesMem: BLOCKED ${scope}\n  → ${suggestion}\n  If the code tools don't find what you need, run this ${tool} again.`
    } catch (error: any) {
      debugLog("code_nav", `ERROR ${error?.message || String(error)}`)
      return
    }
  }

  return { before }
}
