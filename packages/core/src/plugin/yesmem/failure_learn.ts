// tool.execute.after — learn from failures.
//
// Ported from the v1 plugin's failure_learn.ts. A failing tool call is remembered as a gotcha and matching
// known issues are attached to the error the model sees. v2 names the shell tool `shell` (v1: bash) and
// carries the error on the call event instead of an `output.state` object.

import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { YesMemRPC } from "./rpc"

const harmlessCommands = ["grep", "diff", "test", "[", "rg"]
// Snippets come from the memory store and are rendered into a model-visible error.
const MAX_SNIPPET_CHARS = 1000

function isHarmlessExit(command: string | undefined): boolean {
  if (!command) return false
  return harmlessCommands.includes(command.split(/\s+/)[0])
}

export interface ToolResultEvent {
  readonly tool?: string
  readonly id?: string
  readonly status?: string
  input?: unknown
  result?: any
  error?: any
}

export function failureLearn(rpc: YesMemRPC, directory: string) {
  async function after(event: ToolResultEvent) {
    if (event.status !== "error" || !event.error) return

    const tool = event.tool || ""
    const input = (event.input ?? {}) as Record<string, any>
    if (tool === "shell" && isHarmlessExit(input.command)) return

    const errorText = String(event.error.message ?? "")
    if (errorText.length < 10) return

    // Phase 1: learn
    const truncated = errorText.length > 200 ? errorText.substring(0, 200) : errorText
    await rpc.call("remember", {
      text: `${tool} error: ${truncated}`,
      category: "gotcha",
      source: "hook_auto_learned",
      project: directory,
    })

    // Phase 2: assist
    const search = await rpc.call("hybrid_search", {
      query: `${tool} ${truncated.substring(0, 100)}`,
      project: directory,
      limit: 3,
    })
    const results: any[] = search.ok ? (search.result?.results ?? []) : []
    if (results.length === 0) return

    const snippets = results
      .slice(0, 3)
      .map((result) => `- [${result.category}] ${result.content}`)
      .join("\n")
      .substring(0, MAX_SNIPPET_CHARS)
    event.error = new ToolError({
      message: `${errorText}\n\n[YesMem Assist] Similar known issues:\n${snippets}`,
      ...(event.error.error === undefined ? {} : { error: event.error.error }),
      ...(event.error.metadata === undefined ? {} : { metadata: event.error.metadata }),
    })
  }

  return { after }
}
