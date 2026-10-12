// Filesystem-backed set of installed skill names.
// Used by rule_guard to filter out suggestions for skills that exist in the RULES.md catalog but are not
// actually installed. Copied from the v1 plugin unchanged apart from the header.

import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const HOME = process.env.HOME || "/home/chief"

// Roots opencode/Claude Code scan for skills. Bundled skills that were never installed live only in the
// source repo and won't appear here — exactly the ghosts we want to filter out.
// Resolved per call (not at module load) so YESMEM_SKILL_ROOTS and HOME changes are honoured.
function skillRoots(): string[] {
  const roots = [`${process.env.HOME || HOME}/.claude/skills`, `${process.env.HOME || HOME}/.agents/skills`]
  // Allow override/extensibility via env (colon-separated extra roots).
  return [...roots, ...(process.env.YESMEM_SKILL_ROOTS || "").split(":").filter(Boolean)]
}

let cachedNames: Set<string> | null = null
let cacheKey = ""

function dirMtimeSum(): string {
  let key = ""
  for (const root of skillRoots()) {
    try {
      const stat = statSync(root)
      key += `${root}:${stat.mtimeMs};`
    } catch {
      key += `${root}:-;`
    }
  }
  return key
}

function scan(): Set<string> {
  const names = new Set<string>()
  for (const root of skillRoots()) {
    let entries: string[] = []
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      try {
        statSync(join(root, entry, "SKILL.md"))
        // Lowercased dir name = skill name (opencode convention).
        names.add(entry.toLowerCase())
      } catch {}
    }
  }
  return names
}

export function loadInstalledSkills(): Set<string> {
  const key = dirMtimeSum()
  if (cachedNames && key === cacheKey) return cachedNames
  cachedNames = scan()
  cacheKey = key
  return cachedNames
}

export function isSkillInstalled(name: string): boolean {
  if (!name) return false
  return loadInstalledSkills().has(name.toLowerCase())
}

// For tests: force a rescan on next call.
export function _resetCacheForTest(): void {
  cachedNames = null
  cacheKey = ""
}
