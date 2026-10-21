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
import { lstatSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path"

const blockedCommands = ["grep", "cat", "head", "tail", "sed", "awk", "rg", "egrep", "fgrep", "find"]
const blockedTools = new Set(["read"])
const FILE_ATTEMPT_TTL_MS = 3600000 // 1h
const FILE_ATTEMPT_SWEEP_SIZE = 500
// An unindexed project stays unindexed far longer than a tool call. Probing it on every navigation cost one
// RPC per call, each with a multi-second timeout (YM-83).
const INDEX_NEGATIVE_TTL_MS = 60000
// A probe that timed out or failed in transport is not an answer: retry soon, but not on every single call
// while a first scan is still running.
const INDEX_TRANSIENT_TTL_MS = 5000
const PROBE_TIMEOUT_MS = 2000
// Every target before the first hit costs one RPC. A command is model-written, so the number of lookups
// one call may trigger is bounded.
const MAX_NAV_TARGETS = 32
const LOOKUP_TIMEOUT_MS = 2000

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

const SHELL_BOUNDARY = /[\s;&|<>()]/

// Quote positions with a valid closer, computed once per string: a naive "search ahead" per quote is
// quadratic on pathological input (a hook that blocks every tool call must not be a DoS lever).
function quoteFlags(text: string): Uint8Array {
  const flags = new Uint8Array(text.length)
  const nextBoundaryQuote: Record<string, number | undefined> = { '"': undefined, "'": undefined, "`": undefined }
  for (let i = text.length - 1; i >= 0; i--) {
    const character = text[i]
    if (character !== '"' && character !== "'" && character !== "`") continue
    const closesAtBoundary = i + 1 === text.length || SHELL_BOUNDARY.test(text[i + 1])
    if (closesAtBoundary && nextBoundaryQuote[character] !== undefined) flags[i] = 1
    if (closesAtBoundary) nextBoundaryQuote[character] = i
  }
  return flags
}

// A quote only opens at a token boundary and only when it closes at one. Otherwise it is a literal
// apostrophe (`don't`) and must not swallow the rest of the line.
function opensQuote(text: string, index: number, flags: Uint8Array): boolean {
  if (!flags[index]) return false
  return index === 0 || SHELL_BOUNDARY.test(text[index - 1])
}

function tokenize(segment: string): string[] {
  const tokens: string[] = []
  const flags = quoteFlags(segment)
  let current = ""
  let quote = ""
  for (let i = 0; i < segment.length; i++) {
    const character = segment[i]
    if (quote) {
      if (character === quote) quote = ""
      else current += character
      continue
    }
    // A backslash escapes the next character: `my\ dir` is one token.
    if (character === "\\" && i + 1 < segment.length) {
      current += segment[++i]
      continue
    }
    if ((character === '"' || character === "'" || character === "`") && opensQuote(segment, i, flags)) {
      quote = character
      continue
    }
    if (character === " " || character === "\t") {
      if (current) tokens.push(current)
      current = ""
      continue
    }
    current += character
  }
  if (current) tokens.push(current)
  return tokens
}

// splitCommandSegments breaks a shell line at its operators, so a navigation command hidden behind
// `cd x &&` or `git status;` is still seen (YM-84). Quoted text stays together — an operator inside
// quotes is a literal. Redirects split too: their operand is not a navigation target.
function splitCommandSegments(command: string): string[] {
  const segments: string[] = []
  const flags = quoteFlags(command)
  let current = ""
  let quote = ""
  for (let i = 0; i < command.length; i++) {
    const character = command[i]
    if (quote) {
      current += character
      if (character === quote) quote = ""
      continue
    }
    if (character === "\\" && i + 1 < command.length) {
      current += character + command[++i]
      continue
    }
    if ((character === '"' || character === "'" || character === "`") && opensQuote(command, i, flags)) {
      quote = character
      current += character
      continue
    }
    if (character === "\n" || character === ";" || character === "|" || character === "<" || character === ">") {
      segments.push(current)
      current = ""
      continue
    }
    if (character === "&" && command[i + 1] === "&") {
      segments.push(current)
      current = ""
      i++
      continue
    }
    current += character
  }
  segments.push(current)
  return segments.map((segment) => segment.trim()).filter(Boolean)
}

function extractFileArgs(tokens: string[]): string[] {
  const files: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const arg = tokens[i]
    if (arg.startsWith("-")) continue
    // Redirects are not navigation targets: `2>/dev/null` and `> out.txt` change where output goes.
    if (arg.includes(">") || arg.includes("<")) continue
    if (arg.includes("*") || arg.includes("?")) continue
    if (arg.includes("/") || arg.match(/\.(go|ts|js|py|rs|java|cpp|c|h|yaml|yml|toml|json|mod|sum)$/)) {
      files.push(arg)
    }
  }
  return files
}

// navTargets resolves every navigation segment of a shell line. File arguments are made absolute against
// the directory the line runs in (or the directory a `cd`/`pushd` moved it to), so the lookup checks the
// file the command actually names.
function navTargets(command: string, startDirectory: string): string[] {
  const targets: string[] = []
  let cwd = startDirectory
  const stack: string[] = []
  for (const segment of splitCommandSegments(command)) {
    const tokens = tokenize(segment)
    if (tokens.length === 0) continue
    const name = basename(tokens[0]).toLowerCase()
    if (name === "cd" || name === "pushd") {
      const destination = tokens.slice(1).find((token) => !token.startsWith("-"))
      if (destination) {
        if (name === "pushd") stack.push(cwd)
        cwd = absoluteFrom(cwd, destination)
      }
      continue
    }
    if (name === "popd") {
      const previous = stack.pop()
      if (previous) cwd = previous
      continue
    }
    if (!blockedCommands.includes(name)) continue
    targets.push(...extractFileArgs(tokens).map((file) => absoluteFrom(cwd, file)))
    if (targets.length >= MAX_NAV_TARGETS) return targets.slice(0, MAX_NAV_TARGETS)
  }
  return targets
}

function absoluteFrom(cwd: string, file: string): string {
  return normalize(isAbsolute(file) ? file : join(cwd, file))
}

// --- project key and path rewrite: ports of the Go hook's implementation ---
// internal/codescan.ProjectKey and internal/hooks/indexRelativePath. The plugin and the Claude Code hook
// must name the code index the same way, otherwise the same command blocks on one side and slips through
// on the other (YM-200).

function resolveGitDir(rootDir: string): string {
  const gitPath = join(rootDir, ".git")
  try {
    if (statSync(gitPath).isDirectory()) return gitPath
    const content = readFileSync(gitPath, "utf8").trim()
    if (!content.startsWith("gitdir:")) return gitPath
    const target = content.slice("gitdir:".length).trim()
    return normalize(isAbsolute(target) ? target : join(rootDir, target))
  } catch {
    return gitPath
  }
}

function enclosingGitRoot(dir: string): string {
  let current = normalize(dir)
  for (;;) {
    try {
      lstatSync(join(current, ".git"))
      return current
    } catch {}
    const parent = dirname(current)
    if (parent === current) return normalize(dir)
    current = parent
  }
}

// projectKey is the key the code index is stored under: the enclosing repository's basename, with a linked
// worktree resolving to its parent repository.
export function projectKey(dir: string): string {
  if (!dir) return ""
  const root = enclosingGitRoot(dir)
  const gitPath = join(root, ".git")
  const gitDir = resolveGitDir(root)
  if (gitDir === gitPath) return basename(root)
  const parts = gitDir.split(sep)
  for (let i = parts.length - 1; i >= 1; i--) {
    if (parts[i] === ".git") return parts[i - 1]
  }
  return basename(root)
}

// indexRelativePath rewrites an absolute path into a path relative to the working directory. Paths that
// cannot be expressed relative to it stay untouched.
export function indexRelativePath(cwd: string, file: string): string {
  if (!cwd || !isAbsolute(file)) return file
  const rel = relative(cwd, file)
  if (rel === ".." || rel.startsWith(".." + sep)) return file
  // filepath.Rel returns "." for an equal path; node:path returns "".
  return rel || "."
}

// File paths are model- and repository-controlled; control characters would reach the terminal and the model.
// Quotes, line/paragraph separators and bidi overrides are stripped too: the path is embedded in a quoted
// pseudo-call inside the block message, and a repository can hold a file whose name closes that quote.
function safe(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/["`]/g, "")
}

function suggestTool(file: string, project: string): string {
  return `get_file_symbols("${safe(file)}", "${safe(project)}") for overview, or get_code_snippet(file="${safe(file)}", project="${safe(project)}", start_line=x, end_line=y)`
}

export interface ToolCallEvent {
  readonly tool?: string
  readonly sessionID?: string
  input?: unknown
}

export function codeNavGuard(rpc: YesMemRPC, pluginDirectory: string, now: () => number = Date.now) {
  // The index key is constant for the life of the instance; resolving it per tool call walked the directory
  // tree and read .git for nothing.
  const project = projectKey(pluginDirectory) || pluginDirectory
  // Per directory: the probe answer, when it was obtained, and how long it stays valid. v1 kept one boolean
  // for the whole process, so the first indexed project made every other project look indexed too.
  const indexState = new Map<string, { indexed: boolean; checkedAt: number; ttlMs: number }>()
  // Two-strike memory is per hook instance and per session: a block in one session must not pre-consume
  // another session's retry.
  const fileAttempts = new Map<string, { count: number; firstSeen: number }>()

  async function ensureIndexed(directory: string): Promise<boolean> {
    const known = indexState.get(directory)
    if (known) {
      if (known.indexed) return true
      if (now() - known.checkedAt < known.ttlMs) return false
    }
    const response = await rpc.call(
      "search_code_index",
      { pattern: "func", kind: "function", project, project_dir: directory, _cwd: directory, limit: 1 },
      { timeoutMs: PROBE_TIMEOUT_MS },
    )
    if (!response.ok) {
      // A missing index ("no code index available") is stable enough to remember for a while. A transport
      // failure or a timeout is no answer at all: retry soon, but not on every single call while a first
      // scan is still running.
      const noIndex = /no code index/i.test(String(response.error ?? ""))
      indexState.set(directory, {
        indexed: false,
        checkedAt: now(),
        ttlMs: noIndex ? INDEX_NEGATIVE_TTL_MS : INDEX_TRANSIENT_TTL_MS,
      })
      return false
    }
    // An answer without an error means the index exists — a miss inside it is normal text
    // ("No matches found for pattern: ..."), not a missing index.
    indexState.set(directory, { indexed: true, checkedAt: now(), ttlMs: 0 })
    return true
  }

  async function inGraph(file: string, project: string, directory: string, isDir: boolean): Promise<boolean> {
    // project names the code index, project_dir fixes the file root: the daemon resolves a project key to
    // the parent repository, so without project_dir a worktree file would be looked up in the main checkout.
    if (isDir) {
      const response = await rpc.call(
        "get_file_index",
        { dir: file, project, project_dir: directory, _cwd: directory },
        { timeoutMs: LOOKUP_TIMEOUT_MS },
      )
      return !!(response.ok && response.result?.text && !response.result.text.includes("No source files found"))
    }
    const response = await rpc.call(
      "get_file_symbols",
      { file, project, project_dir: directory, _cwd: directory },
      { timeoutMs: LOOKUP_TIMEOUT_MS },
    )
    // The miss text is "No symbols found in X", which contains "symbol", so substring "symbol" would
    // false-positive; v1 matched the exact miss text and this keeps that.
    return !!(response.ok && response.result?.text && !response.result.text.includes("No symbols found"))
  }

  /** Two-strike with a 1h TTL: the first navigation is blocked, the retry is allowed. */
  function strike(key: string): boolean {
    const entry = fileAttempts.get(key)
    const stamp = now()
    const attempt = entry && stamp - entry.firstSeen < FILE_ATTEMPT_TTL_MS ? entry.count : 0
    if (fileAttempts.size > FILE_ATTEMPT_SWEEP_SIZE) {
      for (const [candidate, value] of fileAttempts)
        if (stamp - value.firstSeen >= FILE_ATTEMPT_TTL_MS) fileAttempts.delete(candidate)
      // Still too many inside the TTL: drop the oldest, insertion order is age order.
      for (const candidate of fileAttempts.keys()) {
        if (fileAttempts.size <= FILE_ATTEMPT_SWEEP_SIZE) break
        fileAttempts.delete(candidate)
      }
    }
    fileAttempts.set(key, { count: attempt + 1, firstSeen: attempt > 0 && entry ? entry.firstSeen : stamp })
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
        if (!command) return
        // The v2 shell tool takes its working directory as a parameter and asks the model not to `cd`.
        const start =
          typeof input.workdir === "string" && input.workdir ? absoluteFrom(directory, input.workdir) : directory
        targets = navTargets(command, start)
      } else {
        // v2 names the read target `path`.
        const target = (input.path || input.filePath || input.file_path || "") as string
        if (!target) return
        targets = [target]
      }
      if (targets.length === 0) return

      if (!(await ensureIndexed(directory))) {
        debugLog("code_nav", `SKIP-NOT-INDEXED ${tool}`)
        return
      }

      let hit: string | undefined
      const candidates: string[] = []
      for (const target of targets) {
        const relative = indexRelativePath(directory, target).replace(/\/+$/, "")
        // Only paths inside the project are indexed: an absolute or escaping path (a redirect operand,
        // `cd /tmp && cat x.go`) cannot match, and it must not leak into the command key.
        if (relative.startsWith("/") || relative === ".." || relative.startsWith(".." + sep)) continue
        // NUL separates the key's parts; a path containing it would collide with another command's key.
        if (relative.includes("\u0000")) continue
        if (isNonCodeFile(relative)) continue
        // Every target is part of the command's identity, but only an indexed one can block it.
        candidates.push(relative)
        if (hit) continue
        const isDir = target.endsWith("/") || !relative.includes(".")
        if (await inGraph(relative, project, directory, isDir)) hit = relative
      }
      if (!hit) return

      // The key is the session, the tool and the command's target set: sessions of one plugin instance are
      // independent, a retry of read is not a retry of grep, and a different command is a first strike of
      // its own even when it shares the leading file. NUL cannot appear in a path, so the set cannot collide
      // with another command's.
      const key = `${event.sessionID ?? ""}\u0000${tool}\u0000${candidates.join("\u0000")}`
      if (!strike(key)) {
        debugLog("code_nav", `ALLOW-2ND ${tool} ${safe(key)}`)
        return
      }

      debugLog("code_nav", `BLOCK-1ST ${tool} ${safe(key)}`)
      // The advice names the absolute project directory, not the index key: the daemon resolves a bare key
      // through the session history and would hand the model the main checkout instead of this worktree.
      const suggestion = suggestTool(hit, directory)
      const scope = isShell ? "shell nav on indexed file(s)" : "read on indexed file"
      return `YesMem: BLOCKED ${scope}\n  → ${suggestion}\n  If the code tools don't find what you need, run this ${tool} again.`
    } catch (error: any) {
      debugLog("code_nav", `ERROR ${error?.message || String(error)}`)
      return
    }
  }

  return {
    before,
    /**
     * Warms the index cache for this project. The activation effect uses it instead of its own call, so the
     * priming question and the guard's probe are the same request in the same shape.
     */
    prime: () => ensureIndexed(pluginDirectory),
  }
}
