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
import { debugLog } from "./log"
import { isSkillInstalled } from "./skill_whitelist"

type GuardResult = { decision: string; violations?: string[]; suggestion?: string }

const blockableTools = new Set(["write", "edit", "patch"])
const suggestableTools = new Set(["write", "edit", "patch", "read", "shell", "grep", "glob"])
const skipTools = new Set(["skill", "subagent", "todowrite"])

const GUARD_CACHE_TTL_MS = 5000
const MAX_GUARD_RESPONSE_CHARS = 100_000
const MAX_VIOLATION_CHARS = 1000

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

async function getGitBranch(directory: string): Promise<string> {
  try {
    const gitFile = (await readText(`${directory}/.git`)) ?? ""
    const match = gitFile.match(/^gitdir:\s*(.+)$/m)
    const gitDir = match ? match[1].trim() : `${directory}/.git`
    const head = (await readText(`${gitDir}/HEAD`)) ?? ""
    return head.trim().replace(/^ref: refs\/heads\//, "")
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------------------------
// Guard configuration

/**
 * Reads the two `config.yaml` values the guard needs. v1 used the `yaml` module; that module is not
 * available to the plugin runtime, so this scans the document instead. Only these shapes are understood:
 *
 *   extraction:
 *     model: <name>
 *   proxy:
 *     provider_targets:
 *       <model>: <url>
 */
export function parseGuardConfig(text: string): { model?: string; providerTargets: Record<string, string> } {
  const providerTargets: Record<string, string> = {}
  let model: string | undefined
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
    if (section === "extraction" && key === "model" && value) {
      model = unquote(value)
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

  return { ...(model === undefined ? {} : { model }), providerTargets }
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
  let model = config.model || "deepseek-v4-flash"
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
    const raw = (await response.text()).substring(0, MAX_GUARD_RESPONSE_CHARS)
    const elapsed = Date.now() - started
    const message = (JSON.parse(raw) as any)?.choices?.[0]?.message
    const content: string = message?.content || ""

    if (!content) {
      debugLog("guard", `[${elapsed}ms] EMPTY-CONTENT — PASS`)
      const result: GuardResult = { decision: "PASS" }
      guardCache.set(cacheKey, { result, ts: Date.now() })
      return result
    }

    const parsed = JSON.parse(content) as GuardResult
    guardCache.set(cacheKey, { result: parsed, ts: Date.now() })
    if (parsed.decision === "BLOCK" && parsed.violations?.length) {
      debugLog("guard", `[${elapsed}ms] BLOCKED ${parsed.violations.join("; ")}`)
      return parsed
    }
    if (parsed.decision === "SUGGEST" && parsed.suggestion) {
      debugLog("guard", `[${elapsed}ms] SUGGEST ${parsed.suggestion}`)
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
        context += `\nGit branch: ${gitBranch} (feature branch rules are satisfied — no need to suggest worktree/branch skills)`
      }

      const canBlock = blockableTools.has(toolName)
      const result = await guardCheck(rulesCache, toolName, context, canBlock)
      if (result.decision === "BLOCK" && canBlock) {
        // The text comes from a model whose prompt embeds repository content; it reaches the model again.
        return `Rule check blocked this call: ${(result.violations || []).join("; ").substring(0, MAX_VIOLATION_CHARS)}`
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
