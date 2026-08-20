import path from "path"
import { readJson } from "./persistence"

const THEME_MODE_KV_KEYS = ["theme_mode_lock", "theme_mode"] as const

export type LastThemeMode = "dark" | "light"

export function themeModeFromKV(kv: Record<string, unknown>): LastThemeMode | undefined {
  for (const key of THEME_MODE_KV_KEYS) {
    if (kv[key] === "dark" || kv[key] === "light") return kv[key]
  }
  return
}

/** Last known theme mode from kv.json so first paint skips the OSC round-trip. */
export async function readLastKnownThemeMode(statePath: string): Promise<LastThemeMode | undefined> {
  try {
    const kv = await readJson<Record<string, unknown>>(path.join(statePath, "kv.json"))
    return themeModeFromKV(kv)
  } catch {
    return
  }
}
