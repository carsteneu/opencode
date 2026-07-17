import { expect } from "bun:test"
import { LLM, LLMClient } from "@opencode-ai/ai"
import { OpenAIChat } from "@opencode-ai/ai/protocols"
import type { RequestData } from "@opencode-ai/ai/route"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Session } from "@opencode-ai/schema/session"
import { Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PluginHooks } from "@opencode-ai/core/plugin/hooks"
import { SessionModelStream } from "@opencode-ai/core/session/model-stream"
import { testEffect } from "./lib/effect"

const prepared: RequestData[] = []
const client = Layer.mock(LLMClient.Service)({
  prepare: () => Effect.die("unused"),
  generate: () => Effect.die("unused"),
  stream: (_request, options) =>
    Stream.unwrap(
      options?.transformRequest
        ? options.transformRequest({ headers: { original: "true" }, body: { remove: true } }).pipe(
            Effect.map((request) => {
              prepared.push(request)
              return Stream.empty
            }),
          )
        : Effect.die("request transform was not provided"),
    ),
})
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([PluginHooks.node, SessionModelStream.node]), [[llmClient, client]]),
)

it.effect("forwards session identity and applies request hook mutations", () =>
  Effect.gen(function* () {
    prepared.length = 0
    const hooks = yield* PluginHooks.Service
    const stream = yield* SessionModelStream.Service
    const sessionID = Session.ID.make("ses_model_stream")
    const agent = Agent.ID.make("build")
    const model = Model.Ref.make({
      providerID: Provider.ID.make("test"),
      id: Model.ID.make("catalog-model"),
    })
    yield* hooks.register("session", "request", (event) =>
      Effect.sync(() => {
        expect(event.sessionID).toBe(sessionID)
        expect(event.agent).toBe(agent)
        expect(event.model).toEqual(model)
        event.headers["x-plugin"] = "enabled"
        delete event.body.remove
      }),
    )
    yield* stream
      .stream({
        sessionID,
        agent,
        model,
        request: LLM.request({
          model: OpenAIChat.route
            .with({ endpoint: { baseURL: "https://api.openai.test/v1/" } })
            .model({ id: "api-model" }),
          prompt: "Hello",
        }),
      })
      .pipe(Stream.runDrain)

    expect(prepared).toEqual([{ headers: { original: "true", "x-plugin": "enabled" }, body: {} }])
  }),
)
