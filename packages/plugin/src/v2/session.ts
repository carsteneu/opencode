import type { Agent } from "@opencode-ai/schema/agent"
import type { Model } from "@opencode-ai/schema/model"
import type { Session } from "@opencode-ai/schema/session"

export type RequestValue =
  | null
  | boolean
  | number
  | string
  | Array<RequestValue>
  | { [key: string]: RequestValue }

export type RequestBody = Record<string, RequestValue>

export interface SessionRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  headers: Record<string, string>
  body: RequestBody
}
