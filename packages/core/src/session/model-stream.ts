export * as SessionModelStream from "./model-stream"

import { LLMClient, type LLMError, type LLMEvent, type LLMRequest } from "@opencode-ai/ai"
import type { Agent } from "@opencode-ai/schema/agent"
import type { Model } from "@opencode-ai/schema/model"
import type { Session } from "@opencode-ai/schema/session"
import { Context, Effect, Layer, Stream } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { PluginHooks } from "../plugin/hooks"

export interface Input {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly request: LLMRequest
}

export interface Interface {
  readonly stream: (input: Input) => Stream.Stream<LLMEvent, LLMError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionModelStream") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const llm = yield* LLMClient.Service
    return Service.of({
      stream: (input) => {
        if (!hooks.has("session", "request")) return llm.stream(input.request)
        return llm.stream(input.request, {
          transformRequest: (request) =>
            hooks
              .trigger("session", "request", {
                sessionID: input.sessionID,
                agent: input.agent,
                model: input.model,
                headers: request.headers,
                body: request.body,
              })
              .pipe(Effect.map((event) => ({ headers: event.headers, body: event.body }))),
        })
      },
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [PluginHooks.node, llmClient] })
