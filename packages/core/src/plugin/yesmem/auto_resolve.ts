// tool.execute.after — resolve open yesmem tasks from a commit message.
//
// Ported from the v1 plugin's auto_resolve.ts. v2 names the shell tool `shell` (v1: bash) and the command
// lives on the call event.

import { debugLog } from "./log"
import type { YesMemRPC } from "./rpc"
import type { ToolResultEvent } from "./failure_learn"

export function autoResolve(rpc: YesMemRPC, directory: string) {
  async function after(event: ToolResultEvent) {
    if (event.tool !== "shell") return
    // A rejected commit (hook failure, nothing staged) must not resolve anything. v1 had no status check.
    if (event.status !== "completed") return
    const command = (event.input as Record<string, any> | undefined)?.command as string | undefined
    if (!command?.startsWith("git commit")) return

    const match = command.match(/-m\s*["']([^"']+)["']/)
    const message = match?.[1] || ""
    if (!message) return

    const response = await rpc.call("resolve_by_text", { text: message, project: directory })
    if (response.ok && response.result?.resolved > 0) {
      debugLog("auto_resolve", `resolved via commit: ${message.substring(0, 80)}`)
    }
  }

  return { after }
}
