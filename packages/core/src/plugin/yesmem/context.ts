// tool.execute.before — route code navigation through the YesMem index.
//
// Ported from the v1 plugin's context.ts. v1 received `(input, output)` where input carried the tool name
// and session and output.args carried the arguments; v2 hands the whole call to the hook as one event, so
// the arguments are `event.input` and the session is `event.sessionID`.

export interface ToolEvent {
  readonly tool?: string
  readonly sessionID?: string
  input?: unknown
}

export function injectYesMemToolContext(event: ToolEvent, directory: string) {
  if (typeof event?.tool !== "string" || !event.tool.startsWith("yesmem_")) return
  const args = event.input as Record<string, unknown> | undefined
  if (!args || typeof args !== "object" || Array.isArray(args)) return

  if (typeof event.sessionID === "string" && event.sessionID) {
    args._session_id = `opencode:${event.sessionID}`
  }
  args._source_agent = "opencode"
  if (directory) args._cwd = directory
}
