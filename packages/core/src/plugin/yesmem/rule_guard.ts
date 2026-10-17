// rule_guard — pre-tool rule compliance hook.
//
// Fires on every tool call and evaluates it against RULES.md via a small model.
//   BLOCK:   Write/Edit/Patch violating a rule → the call is rejected (Tool.Error)
//   SUGGEST: missed skill activation → directive injected into the tool result
//   PASS:    no issue
//
// Ported from the v1 plugin's rule_guard.ts. v2 differences:
//   - arguments live on the call event (`input`), not on a separate output object
//   - tool names are the v2 set: shell (not bash), plus the file-mutating `patch`
//   - the conversation capture uses `session.hook("context")`; v1's `chat.params` fallback has no v2
//     equivalent and is dropped
//   - `config.yaml` is read without the `yaml` module: the plugin runtime provides only `effect` and
//     `@opencode/plugin`, so a third-party YAML module cannot be relied on

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { readBodyCapped } from "./http"
import { debugLog } from "./log"
import { isSkillInstalled } from "./skill_whitelist"

type GuardResult = { decision: string; violations?: string[]; suggestion?: string }

const blockableTools = new Set(["write", "edit", "patch"])
const suggestableTools = new Set(["write", "edit", "patch", "read", "shell", "grep", "glob"])
const skipTools = new Set(["skill", "subagent", "todowrite"])

const GUARD_CACHE_TTL_MS = 5000
const MAX_GUARD_RESPONSE_CHARS = 100_000
const MAX_VIOLATION_CHARS = 1000
const MAX_LOG_EXCERPT_CHARS = 300

/**
 * A capped one-line excerpt for a log line. The body comes from a remote endpoint and may carry
 * newlines, so it is JSON-quoted: a raw body could otherwise forge a second log entry.
 */
function logExcerpt(text: string): string {
  const capped = text.length > MAX_LOG_EXCERPT_CHARS ? text.substring(0, MAX_LOG_EXCERPT_CHARS) + "…" : text
  return JSON.stringify(capped)
}

// Keyed on the full text, not a 32-bit hash: the map holds a handful of entries and a hash collision would
// hand one call another call's decision.
const guardCache = new Map<string, { result: GuardResult; ts: number }>()

function guardCacheKey(rules: string, tool: string, context: string): string {
  return `${rules}\u0000${tool}\u0000${context}`
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8")
  } catch {
    return undefined
  }
}

async function loadRules(directory: string): Promise<string> {
  const content = await readText(`${directory}/RULES.md`)
  if (content === undefined) return "No RULES.md found in project root"
  const lines = content
    .split("\n")
    .filter((line) => /^\d+\.\s/.test(line))
    .join("\n")
  const skillCatalog = content.match(/## Skill Catalog\n([\s\S]*?)(?=\n## |\n# [^#]|\n---\n|$)/)
  const skillSection = skillCatalog ? skillCatalog[1] : ""
  const rules = lines + (skillSection ? "\n\n## Skill Catalog\n" + skillSection : "")
  return rules || "No numbered rules found"
}

export async function getGitBranch(directory: string): Promise<string> {
  try {
    // `.git` is a directory in a plain checkout and a `gitdir:` pointer file in a worktree. Reading it
    // as text fails on the directory, so the pointer decides only when it parses as one.
    const gitFile = (await readText(`${directory}/.git`)) ?? ""
    const match = gitFile.match(/^gitdir:\s*(.+)$/m)
    const gitDir = match ? match[1].trim() : `${directory}/.git`
    const head = (await readText(`${gitDir}/HEAD`)) ?? ""
    // Only a branch ref counts: a detached HEAD is a SHA, and calling that a feature branch would repeat
    // the false assurance YM-85 is about.
    const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head.trim())
    return branch ? branch[1] : ""
  } catch {
    return ""
  }
}

const defaultBranches = new Set(["main", "master"])

/**
 * The context line that tells the model a feature-branch rule is already satisfied. It belongs to a
 * feature branch only: on main the rule is exactly what the guard must keep suggesting (YM-85).
 */
export function featureBranchNote(branch: string): string {
  if (!branch || defaultBranches.has(branch)) return ""
  return `\nGit branch: ${branch} (feature branch rules are satisfied — no need to suggest worktree/branch skills)`
}

// ---------------------------------------------------------------------------------------------
// Guard configuration

/**
 * Reads the config.yaml values the guard needs. v1 used the `yaml` module; that module is not
 * available to the plugin runtime, so this scans the document instead. Only these shapes are understood:
 *
 *   rule_guard:
 *     model: <name>
 *   proxy:
 *     provider_targets:
 *       <model>: <url>
 *
 * The guard has its own model key on purpose: the extraction model is tuned for long transcripts and may
 * answer only in its reasoning channel, which left the guard judging nothing (YM-78).
 */
export function parseGuardConfig(text: string): { ruleGuardModel?: string; providerTargets: Record<string, string> } {
  const providerTargets: Record<string, string> = {}
  let ruleGuardModel: string | undefined
  let section: string | undefined
  let subsectionIndent = -1
  let inProviderTargets = false

  const unquote = (value: string) => value.replace(/^["']|["']$/g, "").trim()

  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const indent = raw.length - raw.trimStart().length
    const match = /^([A-Za-z0-9_.\-"']+):\s*(.*)$/.exec(line)
    if (!match) continue
    const key = unquote(match[1])
    const value = match[2]

    if (indent === 0) {
      section = key
      inProviderTargets = false
      subsectionIndent = -1
      continue
    }
    if (section === "rule_guard" && key === "model" && value) {
      ruleGuardModel = unquote(value)
      continue
    }
    if (section !== "proxy") continue
    if (key === "provider_targets" && !value) {
      inProviderTargets = true
      subsectionIndent = indent
      continue
    }
    if (inProviderTargets && indent > subsectionIndent && value) providerTargets[key] = unquote(value)
  }

  return { ...(ruleGuardModel === undefined ? {} : { ruleGuardModel }), providerTargets }
}

const FIRST_PARTY_DEFAULTS: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  groq: "https://api.groq.com",
  mistral: "https://api.mistral.ai",
}

const OPENAI_COMPAT_NPMS = new Set(["@ai-sdk/openai-compatible", "@ai-sdk/openai", "@ai-sdk/mistral"])

async function readJson(file: string): Promise<Record<string, any>> {
  const text = await readText(file)
  if (text === undefined) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export async function resolveGuardConfig(): Promise<{ model: string; apiUrl: string; apiKey: string; npm: string }> {
  // Explicit overrides win: without them the guard can only be pointed at the user's real provider.
  const overrideUrl = process.env.YESMEM_GUARD_URL
  if (overrideUrl) {
    return {
      model: process.env.YESMEM_GUARD_MODEL || "deepseek-v4-flash",
      apiUrl: overrideUrl.replace(/\/+$/, ""),
      apiKey: process.env.YESMEM_GUARD_KEY || "",
      npm: process.env.YESMEM_GUARD_NPM || "",
    }
  }

  const home = process.env.HOME || homedir()
  const config = parseGuardConfig((await readText(`${home}/.claude/yesmem/config.yaml`)) ?? "")
  // Not extraction.model: that one may be a reasoning model, and its empty answers made the guard pass
  // every call without judging it (YM-78).
  const model = config.ruleGuardModel || "deepseek-v4-flash"
  const providerTargets = config.providerTargets

  const models = await readJson(`${home}/.cache/opencode/models.json`)
  const auth = await readJson(`${home}/.local/share/opencode/auth.json`)

  let apiUrl = "https://api.deepseek.com"
  let apiKey = ""
  let npm = ""
  let fallbackApiUrl = ""
  let fallbackApiKey = ""

  for (const [providerId, provider] of Object.entries(models)) {
    const entry = provider as any
    if (!entry?.models?.[model]) continue
    const key = auth[providerId]?.key || ""
    const url = entry.api || FIRST_PARTY_DEFAULTS[providerId] || ""
    if (key) {
      apiUrl = url
      apiKey = key
      npm = entry.npm || ""
      break
    }
    if (!fallbackApiKey) {
      fallbackApiUrl = url
      fallbackApiKey = key
    }
  }

  if (!apiKey && fallbackApiUrl) {
    apiUrl = fallbackApiUrl
    apiKey = fallbackApiKey
  }

  // Private/gateway models (e.g. privateTom) are usually not in models.json: they are served by a custom
  // upstream from config.yaml and authenticated with the opencode "gateway" auth key.
  if (!apiKey) {
    let target = providerTargets[model] || ""
    if (!target) {
      const flat = Object.keys(providerTargets).find((key) => key.toLowerCase() === model.toLowerCase())
      target = flat ? providerTargets[flat] : ""
    }
    if (target) {
      apiUrl = target.replace(/\/+$/, "")
      apiKey = auth.gateway?.key || ""
      npm = "@ai-sdk/openai-compatible"
    }
  }

  return { model, apiUrl, apiKey, npm }
}

// ---------------------------------------------------------------------------------------------
// Guard decision

/**
 * Logs model and endpoint host once per change. The host, never the key: the guard's answer changes with
 * both, and a silent switch between providers is otherwise invisible in the log.
 */
let lastResolution = ""
function logResolution(config: { model: string; apiUrl: string; npm: string }) {
  let host = config.apiUrl
  try {
    host = new URL(config.apiUrl).host
  } catch {}
  const resolution = `${config.model} via ${host}`
  if (resolution === lastResolution) return
  lastResolution = resolution
  debugLog("guard", `RESOLVED model=${config.model} host=${host} npm=${config.npm || "-"}`)
}

async function guardCheck(
  rules: string,
  tool: string,
  context: string,
  canBlock: boolean,
  retried = false,
): Promise<GuardResult> {
  const now = Date.now()
  for (const [key, entry] of guardCache) if (now - entry.ts >= GUARD_CACHE_TTL_MS) guardCache.delete(key)
  const cacheKey = guardCacheKey(rules, tool, context)
  const cached = guardCache.get(cacheKey)
  if (cached) return cached.result

  const config = await resolveGuardConfig()
  if (!config.apiKey || !config.apiUrl) {
    debugLog("guard", `NO-KEY url=${config.apiUrl} key=${config.apiKey ? "yes" : "no"}`)
    return { decision: "PASS" }
  }
  // The endpoint and the credential change with the model. Say it once per resolution, host only, so a
  // model switch (rule_guard.model) is visible in the log instead of being inferred from errors.
  logResolution(config)

  const blockOption = canBlock
    ? `- BLOCK: call violates a rule → {"decision":"BLOCK","violations":["Rule X: reason"]}\n`
    : ""
  const systemPrompt =
    `Output ONLY this JSON format. Do NOT reason, explain, or think. Just output the JSON.\n\n` +
    `RULES:\n${rules}\n\n` +
    `Formats:\n` +
    blockOption +
    `- {"decision":"SUGGEST","suggestion":"skill: short reason max 60 chars"}\n` +
    `- {"decision":"PASS"}\n\n` +
    `For SUGGEST: use exact skill name from rules. Evaluate all Skill Catalog entries against context.`
  const userPrompt = `PROPOSED TOOL CALL: ${tool}\nCONTEXT: ${context}`

  try {
    const started = Date.now()
    const body: Record<string, any> = {
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 4096,
    }
    if (OPENAI_COMPAT_NPMS.has(config.npm)) {
      body.response_format = { type: "json_object" }
      body.thinking = { type: "disabled" }
    }

    const response = await fetch(`${config.apiUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
      // The endpoint may be redirected by an override URL; a redirect would replay the prompt elsewhere.
      redirect: "error",
    })
    const raw = await readBodyCapped(response, MAX_GUARD_RESPONSE_CHARS)
    const elapsed = Date.now() - started
    // Every abnormal answer is logged with status, model and body excerpt. Without that the guard passed
    // silently for days and the cause was unreadable (YM-78).
    if (!response.ok) {
      debugLog("guard", `[${elapsed}ms] HTTP-ERROR status=${response.status} model=${config.model} body=${logExcerpt(raw)}`)
      return { decision: "PASS" }
    }
    let payload: any
    try {
      payload = JSON.parse(raw)
    } catch {
      debugLog("guard", `[${elapsed}ms] NON-JSON status=${response.status} model=${config.model} body=${logExcerpt(raw)}`)
      return { decision: "PASS" }
    }
    const message = payload?.choices?.[0]?.message
    const content: string = message?.content || ""

    if (!content) {
      debugLog(
        "guard",
        `[${elapsed}ms] EMPTY-CONTENT status=${response.status} model=${config.model} finish=${message?.finish_reason ?? "?"} body=${logExcerpt(raw)}`,
      )
      const result: GuardResult = { decision: "PASS" }
      guardCache.set(cacheKey, { result, ts: Date.now() })
      return result
    }

    const parsed = (() => {
      try {
        return JSON.parse(content) as GuardResult
      } catch {
        return undefined
      }
    })()
    if (!parsed) {
      // Prose instead of JSON is the same class as an empty answer: the guard did not judge, and the reply
      // says why. Retrying costs a second request and hides the reason.
      debugLog(
        "guard",
        `[${elapsed}ms] NON-JSON-ANSWER status=${response.status} model=${config.model} content=${logExcerpt(content)}`,
      )
      return { decision: "PASS" }
    }
    guardCache.set(cacheKey, { result: parsed, ts: Date.now() })
    if (parsed.decision === "BLOCK" && parsed.violations?.length) {
      debugLog(
        "guard",
        `[${elapsed}ms] ${canBlock ? "BLOCKED" : "BLOCK-IGNORED (tool cannot be blocked)"} ${logExcerpt(parsed.violations.join("; "))}`,
      )
      return parsed
    }
    if (parsed.decision === "SUGGEST" && parsed.suggestion) {
      debugLog("guard", `[${elapsed}ms] SUGGEST ${logExcerpt(parsed.suggestion)}`)
      return parsed
    }
    debugLog("guard", `[${elapsed}ms] PASS`)
    return { decision: "PASS" }
  } catch (error: any) {
    const aborted = error?.name === "AbortError" || error?.name === "TimeoutError"
    // A timeout is not retried: the caller has already waited the full budget.
    if (!retried && !aborted) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      return guardCheck(rules, tool, context, canBlock, true)
    }
    debugLog("guard", `check failed: ${error?.message || String(error)}`)
    return { decision: "PASS" }
  }
}

/**
 * Rule numbers a BLOCK may cite: only rules the loaded catalogue actually contains. Without this filter a
 * model-invented rule number blocks a call (the audit saw "Rule 42", which does not exist). A citation may
 * read "Rule 2", "Rule #2" or "Rules 2 and 4"; everything else in the text is ignored.
 */
export function existingCitedRules(rules: string, violations: string[]): number[] {
  const known = new Set<number>()
  for (const line of rules.split("\n")) {
    const match = /^(\d+)\.\s/.exec(line.trim())
    if (match) known.add(Number(match[1]))
  }
  const cited = new Set<number>()
  for (const violation of violations) {
    for (const number of citedRuleNumbers(violation)) if (known.has(number)) cited.add(number)
  }
  return [...cited]
}

/** The numbers a violation cites: right after "rule"/"rules" (optionally "#") and in a following list. */
function citedRuleNumbers(violation: string): number[] {
  const numbers: number[] = []
  for (const segment of violation.split(/\brule(?:s)?\b/i).slice(1)) {
    const head = /^[\s#]*(\d+(?:\s*(?:,\s*|\s+and\s+|&\s*)\s*#?\d+)*)/.exec(segment)
    if (!head) continue
    for (const number of head[1].match(/\d+/g) ?? []) numbers.push(Number(number))
  }
  return numbers
}

function detectUserIntent(message: string, tool: string, args: Record<string, any>): boolean {
  if (!message) return false
  const lower = message.toLowerCase()
  const command = (args?.command || "").toLowerCase()
  for (const verb of ["commit", "push", "deploy", "do it", "mach ", "tu es", "mach es", "fire and forget"]) {
    if (!lower.includes(verb)) continue
    if (tool === "shell" && command && lower.includes(command)) return true
    if (tool !== "shell" && verb.length > 3) return true
  }
  return false
}

// ---------------------------------------------------------------------------------------------
// Hooks

export interface ToolCallEvent {
  readonly tool?: string
  readonly sessionID?: string
  readonly id?: string
  input?: unknown
}

export interface ToolResultEvent {
  readonly tool?: string
  readonly id?: string
  readonly status?: string
  result?: any
  error?: any
}

export function ruleGuard(directory: string) {
  let rulesCache = ""
  let rulesLoaded = false
  let gitBranch = ""
  let recentConversation: string[] = []
  const suggestions = new Map<string, { suggestion: string; level: string }>()

  /** Read-only capture of the recent conversation for the guard context. */
  function capture(messages: ReadonlyArray<any>) {
    try {
      const collected: string[] = []
      for (let i = messages.length - 1; i >= 0 && collected.length < 6; i--) {
        const message = messages[i]
        const role = message?.role
        if (role !== "user" && role !== "assistant") continue
        const parts = message?.content
        if (!Array.isArray(parts)) continue
        const text = parts
          .filter((part: any) => part?.type === "text" && part.text)
          .map((part: any) => part.text)
          .join("\n")
        if (text) collected.unshift(`[${role}]: ${text.substring(0, 500)}`)
      }
      if (collected.length > 0) recentConversation = collected
    } catch {}
  }

  async function before(event: ToolCallEvent): Promise<string | undefined> {
    try {
      if (!rulesLoaded) {
        rulesCache = await loadRules(directory)
        gitBranch = await getGitBranch(directory)
        rulesLoaded = true
        debugLog(
          "guard",
          `loaded ${rulesCache.split("\n").length} rules ~${Math.round(rulesCache.length / 4)} sys-tok branch=${gitBranch || "?"}`,
        )
        // "nothing to judge" must be distinguishable from "the guard is broken" (YM-78).
        if (!rulesCache || rulesCache.startsWith("No ")) debugLog("guard", `SKIP-NORULES ${rulesCache}`)
      }
      if (!rulesCache || rulesCache.startsWith("No ")) return

      const toolName = (event.tool || "").toString().toLowerCase()
      const args = (event.input ?? {}) as Record<string, any>
      if (skipTools.has(toolName)) return
      if (!suggestableTools.has(toolName)) return

      const filePath = args?.filePath || args?.file_path || args?.path || ""
      if (filePath && (filePath.endsWith("RULES.md") || filePath.endsWith("rule_guard.ts"))) return

      const docExtensions = /\.(md|txt|rst|pdf)(\*|$|,)/
      const isDocTarget =
        docExtensions.test(filePath) ||
        (toolName === "grep" && docExtensions.test(args?.include || "")) ||
        (toolName === "glob" && docExtensions.test(args?.pattern || ""))
      if (isDocTarget) {
        debugLog("guard", `SKIP-DOC tool=${toolName} filePath=${filePath}`)
        return
      }

      let context = `Tool: ${toolName}, Args: ${JSON.stringify(args).substring(0, 300)}`
      if (recentConversation.length > 0) {
        context += `\nRecent conversation:\n${recentConversation.join("\n")}`
        const lastUser = recentConversation.filter((line) => line.startsWith("[user]:")).pop() || ""
        if (detectUserIntent(lastUser, toolName, args)) {
          context +=
            `\nNOTE: The user explicitly requested this action. Rules about user-decision (auto-commit, deployment, destructive ops) should yield to explicit user instruction.`
        }
      }
      if (filePath && filePath.endsWith("_test.go")) {
        context += `\nNOTE: This is a test file ("_test.go"). Writing test files before implementation IS TDD-compliant — do not BLOCK under TDD/test-first rules.`
      }
      if (gitBranch) {
        context += featureBranchNote(gitBranch)
      }

      const canBlock = blockableTools.has(toolName)
      const result = await guardCheck(rulesCache, toolName, context, canBlock)
      if (result.decision === "BLOCK" && canBlock) {
        const violations = result.violations || []
        // A model-invented rule number may not block a call; only a rule the catalogue holds counts.
        if (existingCitedRules(rulesCache, violations).length === 0) {
          debugLog("guard", `DOWNGRADE no existing rule cited: ${logExcerpt(violations.join("; "))}`)
          return
        }
        // The text comes from a model whose prompt embeds repository content; it reaches the model again.
        return `Rule check blocked this call: ${violations.join("; ").substring(0, MAX_VIOLATION_CHARS)}`
      }
      if (result.decision === "SUGGEST") {
        const suggestion = result.suggestion || ""
        if (suggestion && !isSkillInstalled(suggestion)) {
          debugLog("guard", `SKIP ghost skill: ${suggestion}`)
          return
        }
        if (event.id) {
          suggestions.set(event.id, { suggestion, level: toolName === "shell" ? "MANDATORY" : "REQUIRED" })
        }
      }
      return
    } catch (error: any) {
      debugLog("guard", `CRASH ${error?.message || String(error)}`)
      return
    }
  }

  /** Injects a pending skill directive into the tool result (or its error). */
  function after(event: ToolResultEvent) {
    try {
      if (!event.id) return
      const entry = suggestions.get(event.id)
      if (!entry) return
      suggestions.delete(event.id)
      const prefix =
        entry.level === "MANDATORY"
          ? `[guard] ⚠️ MANDATORY CHECK — activate ${entry.suggestion} (use Skill tool)\n\n`
          : `[guard] ACTION REQUIRED: activate ${entry.suggestion} — use Skill tool now.\n\n`

      if (event.status === "error" && event.error) {
        event.error = new ToolError({
          message: prefix + (event.error.message || ""),
          ...(event.error.error === undefined ? {} : { error: event.error.error }),
          ...(event.error.metadata === undefined ? {} : { metadata: event.error.metadata }),
        })
        return
      }
      if (!event.result) return
      const content = event.result.content
      if (Array.isArray(content)) event.result.content = [{ type: "text", text: prefix }, ...content]
      else event.result.content = prefix + (typeof content === "string" ? content : "")
    } catch (error: any) {
      debugLog("guard", `AFTER-CRASH ${error?.message || String(error)}`)
    }
  }

  return { before, after, capture }
}
