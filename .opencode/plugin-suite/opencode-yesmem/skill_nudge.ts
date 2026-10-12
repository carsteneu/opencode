// skill_nudge — staged skill suggestion on user messages (v1: skill_nudge.ts).
//
// Stage 1: local substring match against the catalogue's trigger literals (fast, deterministic, on the
//          critical path).
// Stage 2: model fallback (semantic match) — NEVER on the critical path. Results are cached by
//          (catalogue hash, message text) and precomputed in the background, so the dispatch hook always
//          returns promptly and a later identical message reuses the answer.
//
// The nudge is prepended to the terminal user message. Skills that are not installed are dropped
// (skill_whitelist), the skill name must look like a skill name before it is injected, and a message that
// already carries the nudge is left alone.
//
// Disable entirely with YESMEM_SKILL_NUDGE=off (v1 had no switch for this one; the other two nudges do).

import { readFile, stat } from "node:fs/promises"
import { debugLog } from "./log"
import { findTerminalUserText, hashString, type HostMessage } from "./messages"
import { resolveGuardConfig } from "./rule_guard"
import { isSkillInstalled } from "./skill_whitelist"

const NUDGE_MARKER = "🧠 MANDATORY CHECK — activate "
const RESULT_CACHE_MAX = 128
const MAX_CATALOG_BYTES = 256 * 1024
const MAX_CATALOG_ENTRIES = 200
const MAX_CATALOG_TEXT_CHARS = 32_000
const MAX_MODEL_RESPONSE_CHARS = 100_000

/**
 * A skill name reaches the model inside the user's message, so it may only look like a name. The whitelist
 * check is not enough: a directory name may legally contain a newline or a `<system-reminder>` frame
 * (YESMEM_SKILL_ROOTS can point anywhere).
 */
export function isValidSkillName(name: unknown): boolean {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

export interface SkillEntry {
  skill: string
  priority: string
  triggers: string[]
}

const resultCache = new Map<string, string | null>()
const inFlight = new Set<string>()

/**
 * Drops the per-process caches. The caches exist to avoid repeated provider calls within one server lifetime;
 * a fresh process (or a test that must not inherit another run's answers) starts empty.
 */
export function _resetCaches() {
  resultCache.clear()
  inFlight.clear()
  configCache = null
}

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

  // MUST first, as v1 did when it parsed the catalogue. Bounded: the catalogue is repo content.
  entries.sort((left, right) => {
    if (left.priority === right.priority) return 0
    return left.priority === "MUST" ? -1 : 1
  })
  return entries.slice(0, MAX_CATALOG_ENTRIES)
}

function localMatch(userMessage: string, catalog: SkillEntry[]): string | null {
  const lower = userMessage.toLowerCase()
  for (const entry of catalog) for (const trigger of entry.triggers) if (lower.includes(trigger)) return entry.skill
  return null
}

let configCache: { key: string; config: Awaited<ReturnType<typeof resolveGuardConfig>>; ts: number } | null = null
const CONFIG_CACHE_TTL_MS = 300_000

// Keyed on the inputs the resolution depends on: a cached endpoint must not survive an override change.
function configKey() {
  return [
    process.env.YESMEM_GUARD_URL,
    process.env.YESMEM_GUARD_KEY,
    process.env.YESMEM_GUARD_MODEL,
    process.env.YESMEM_GUARD_NPM,
    process.env.HOME,
  ].join("|")
}

async function guardConfig() {
  const key = configKey()
  if (configCache && configCache.key === key && Date.now() - configCache.ts < CONFIG_CACHE_TTL_MS)
    return configCache.config
  const config = await resolveGuardConfig()
  configCache = { key, config, ts: Date.now() }
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
    // Bound the body: the timeout limits time, not bytes.
    const raw = (await response.text()).substring(0, MAX_MODEL_RESPONSE_CHARS)
    const content = (JSON.parse(raw) as any)?.choices?.[0]?.message?.content || ""
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
  let catalogText = ""
  let catalogHash = ""
  let loadedPath: string | null = null
  let loadedMtime = -1
  let lastPrecomputed: string | null = null

  async function loadCatalog() {
    const read = async (candidate: string) => {
      const info = await stat(candidate)
      // The catalogue is repo content and this runs on the request path.
      if (info.size > MAX_CATALOG_BYTES) {
        debugLog("skill_nudge", `catalog too large (${info.size} bytes), ignored: ${candidate}`)
        return
      }
      const parsed = parseSkillCatalog(await readFile(candidate, "utf8"))
      catalog = parsed
      catalogText = parsed
        .map((entry) => `- ${entry.skill} (${entry.priority}): ${entry.triggers.join(", ")}`)
        .join("\n")
        .substring(0, MAX_CATALOG_TEXT_CHARS)
      catalogHash = hashString(catalogText)
      loadedPath = candidate
      loadedMtime = info.mtimeMs
      debugLog("skill_nudge", `loaded ${parsed.length} skills from ${candidate}`)
    }

    // Re-stat the file that was loaded first: a different candidate with a coincidentally equal mtime must
    // not shadow a changed catalogue.
    if (loadedPath) {
      try {
        const info = await stat(loadedPath)
        if (info.mtimeMs === loadedMtime) return
        await read(loadedPath)
        return
      } catch {
        loadedPath = null
      }
    }
    for (const candidate of catalogPaths) {
      try {
        await read(candidate)
        return
      } catch {}
    }
  }

  async function context(event: ContextEvent) {
    try {
      if (process.env.YESMEM_SKILL_NUDGE === "off") return
      const hit = findTerminalUserText(event.messages)
      if (!hit) return
      // The guard's own directive carries the same phrase; never stack nudges.
      if (hit.text.includes("MANDATORY CHECK — activate ")) return

      await loadCatalog()
      if (!catalog || catalog.length === 0) return

      let matched = localMatch(hit.text, catalog)
      if (!matched) {
        // The key holds the full text: a 32-bit hash would hand one message another message's answer.
        const key = `${catalogHash}\u0000${hit.text}`
        const cached = resultCache.get(key)
        if (cached === undefined) {
          // Cache miss: start the background match once per distinct text, never nudge on the first sighting.
          if (hit.text !== lastPrecomputed) {
            lastPrecomputed = hit.text
            precompute(key, hit.text, catalogText)
          }
          return
        }
        matched = cached
      }
      if (!matched) return
      if (!isValidSkillName(matched)) {
        debugLog("skill_nudge", `reject malformed skill name: ${JSON.stringify(matched).substring(0, 80)}`)
        return
      }
      if (!isSkillInstalled(matched)) {
        debugLog("skill_nudge", `skip ghost skill: ${matched}`)
        return
      }

      hit.part.text = `${NUDGE_MARKER}${matched} (use Skill tool)\n\n${hit.part.text ?? ""}`
      debugLog("skill_nudge", `nudged: ${matched}`)
    } catch (error: any) {
      debugLog("skill_nudge", `ERR: ${error?.message || String(error)}`)
    }
  }

  return { context }
}
