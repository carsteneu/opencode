// skill_nudge — staged skill suggestion on user messages (v1: skill_nudge.ts).
//
// Stage 1: local substring match against the catalogue's trigger literals (fast, deterministic, on the
//          critical path).
// Stage 2: model fallback (semantic match) — NEVER on the critical path. Results are cached by
//          (catalogue hash, message hash) and precomputed in the background, so the dispatch hook always
//          returns promptly and a later identical message reuses the answer.
//
// The nudge is prepended to the terminal user message. Skills that are not installed are dropped
// (skill_whitelist), and a message that already carries the nudge is left alone.
//
// Disable entirely with YESMEM_SKILL_NUDGE=off (v1 had no switch for this one; the other two nudges do).

import { readFile, stat } from "node:fs/promises"
import { debugLog } from "./log"
import { findTerminalUserText, hashString, type HostMessage } from "./messages"
import { resolveGuardConfig } from "./rule_guard"
import { isSkillInstalled } from "./skill_whitelist"

const NUDGE_MARKER = "🧠 MANDATORY CHECK — activate "
const RESULT_CACHE_MAX = 128

export interface SkillEntry {
  skill: string
  priority: string
  triggers: string[]
}

const resultCache = new Map<string, string | null>()
const inFlight = new Set<string>()

function cacheSet(key: string, value: string | null) {
  resultCache.set(key, value)
  if (resultCache.size > RESULT_CACHE_MAX) {
    const oldest = resultCache.keys().next().value
    if (oldest !== undefined) resultCache.delete(oldest)
  }
}

/** YAML strings of a trigger list, with escaped quotes handled. */
export function extractYamlStrings(text: string): string[] {
  const result: string[] = []
  let inString = false
  let current = ""
  for (let i = 0; i < text.length; i++) {
    const character = text[i]
    if (!inString) {
      if (character === '"') inString = true
      continue
    }
    if (character === "\\" && i + 1 < text.length && text[i + 1] === '"') {
      current += '"'
      i++
      continue
    }
    if (character === '"') {
      const trimmed = current.trim()
      if (trimmed) result.push(trimmed.toLowerCase())
      current = ""
      inString = false
      continue
    }
    current += character
  }
  const trimmed = current.trim()
  if (trimmed) result.push(trimmed.toLowerCase())
  return result
}

/** Parses the `## Skill Catalog` section: a YAML list of {id, skill, priority, triggers[]}. */
export function parseSkillCatalog(content: string): SkillEntry[] {
  const entries: SkillEntry[] = []
  const section = content.match(/## Skill Catalog\s*\n([\s\S]*?)(?=\n## |\n---\n|$)/)
  if (!section) return entries

  // Entries may be indented (the generated catalogue nests them under `rules:`) or flush.
  for (const block of section[1].split(/\n\s*- id:\s*/)) {
    if (!block || block.trim() === "") continue
    const skill = block.match(/skill:\s*"?([^"\n]+)"?/)
    if (!skill) continue
    const priority = block.match(/priority:\s*(\S+)/)
    const triggers: string[] = []
    const triggerSection = block.match(/triggers:\s*\[([\s\S]*?)\]/)
    if (triggerSection) triggers.push(...extractYamlStrings(triggerSection[1]))
    entries.push({
      skill: skill[1].trim(),
      priority: priority ? priority[1] : "MUST",
      triggers,
    })
  }

  // MUST first, as v1 did when it parsed the catalogue.
  entries.sort((left, right) => {
    if (left.priority === right.priority) return 0
    return left.priority === "MUST" ? -1 : 1
  })
  return entries
}

function localMatch(userMessage: string, catalog: SkillEntry[]): string | null {
  const lower = userMessage.toLowerCase()
  for (const entry of catalog) for (const trigger of entry.triggers) if (lower.includes(trigger)) return entry.skill
  return null
}

let configCache: { config: Awaited<ReturnType<typeof resolveGuardConfig>>; ts: number } | null = null
const CONFIG_CACHE_TTL_MS = 300_000

async function guardConfig() {
  if (configCache && Date.now() - configCache.ts < CONFIG_CACHE_TTL_MS) return configCache.config
  const config = await resolveGuardConfig()
  configCache = { config, ts: Date.now() }
  return config
}

async function modelMatch(userMessage: string, catalogText: string): Promise<string | null> {
  const config = await guardConfig()
  if (!config?.apiKey) return null

  const systemPrompt =
    `You evaluate user messages against a skill catalog. ` +
    `If the user's intent matches a skill, respond with ONLY the skill name. ` +
    `If no skill matches, respond with "NONE". No explanation. No formatting.\n\n## Skill Catalog\n${catalogText}`
  const userPrompt = `User message: "${userMessage.substring(0, 2000)}"`

  try {
    const response = await fetch(`${config.apiUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 64,
      }),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    })
    if (!response.ok) {
      debugLog("skill_nudge", `model err ${response.status}`)
      return null
    }
    const content = ((await response.json()) as any)?.choices?.[0]?.message?.content || ""
    const trimmed = String(content).trim()
    return trimmed && trimmed !== "NONE" ? trimmed : null
  } catch (error: any) {
    debugLog("skill_nudge", `model err: ${error?.message || String(error)}`)
    return null
  }
}

function precompute(key: string, userMessage: string, catalogText: string) {
  if (inFlight.has(key)) return
  inFlight.add(key)
  modelMatch(userMessage, catalogText)
    .then((skill) => {
      cacheSet(key, skill)
      debugLog("skill_nudge", `cached ${key}=${skill ?? "NONE"}`)
    })
    .catch(() => {})
    .finally(() => inFlight.delete(key))
}

export interface ContextEvent {
  readonly sessionID?: string
  messages?: HostMessage[]
}

/**
 * @param catalogPaths candidate `RULES.md` locations in priority order (env override, plugin directory,
 * project directory). The first readable one wins.
 */
export function skillNudge(catalogPaths: readonly string[]) {
  let catalog: SkillEntry[] | null = null
  let catalogMtime = -1
  let catalogText = ""
  let catalogHash = ""
  let lastMessageHash = ""

  async function loadCatalog() {
    for (const candidate of catalogPaths) {
      try {
        const info = await stat(candidate)
        if (catalog && info.mtimeMs === catalogMtime) return
        const content = await readFile(candidate, "utf8")
        catalog = parseSkillCatalog(content)
        catalogMtime = info.mtimeMs
        catalogText = catalog.map((entry) => `- ${entry.skill} (${entry.priority}): ${entry.triggers.join(", ")}`).join("\n")
        catalogHash = hashString(catalogText)
        debugLog("skill_nudge", `loaded ${catalog.length} skills from ${candidate}`)
        return
      } catch {}
    }
  }

  async function context(event: ContextEvent) {
    try {
      if (process.env.YESMEM_SKILL_NUDGE === "off") return
      const hit = findTerminalUserText(event.messages)
      if (!hit) return
      // The guard's own directive already carries this marker; never stack nudges.
      if (hit.text.includes(NUDGE_MARKER)) return

      const hash = hashString(hit.text)
      if (hash === lastMessageHash) return
      lastMessageHash = hash

      await loadCatalog()
      if (!catalog || catalog.length === 0) return

      let matched = localMatch(hit.text, catalog)
      if (!matched) {
        const key = `${catalogHash}:${hash}`
        const cached = resultCache.get(key)
        // undefined = miss (start the background match), null = cached "no match", string = cached skill
        if (cached === undefined) {
          precompute(key, hit.text, catalogText)
          return
        }
        matched = cached
      }
      if (!matched) return
      if (!isSkillInstalled(matched)) {
        debugLog("skill_nudge", `skip ghost skill: ${matched}`)
        return
      }

      hit.part.text = `${NUDGE_MARKER}${matched} (use Skill tool)\n\n${hit.text}`
      debugLog("skill_nudge", `nudged: ${matched}`)
    } catch (error: any) {
      debugLog("skill_nudge", `ERR: ${error?.message || String(error)}`)
    }
  }

  return { context }
}
