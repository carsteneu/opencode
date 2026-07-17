import type { RequestData } from "@opencode-ai/ai/route"
import type { Agent } from "@opencode-ai/schema/agent"
import type { Model } from "@opencode-ai/schema/model"
import type { Session } from "@opencode-ai/schema/session"

export type RequestValue = RequestData["body"][string]

export type RequestBody = RequestData["body"]

export interface SessionRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  headers: Record<string, string>
  body: RequestBody
}
