import { Agent } from "@opencode/core/agent"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { awaitPlugins, response } from "../location"
import { AgentNotFoundError } from "@opencode/protocol/errors"

// Agents are registered by plugins (packages/core/src/plugin/agent.ts updates the
// default agent and adds general and explore), so a cold location must wait for
// activation before it can answer.
export const AgentHandler = HttpApiBuilder.group(Api, "server.agent", (handlers) =>
  handlers
    .handle("agent.list", () =>
      Effect.gen(function* () {
        yield* awaitPlugins
        return yield* response(Agent.Service.use((agent) => agent.list()))
      }),
    )
    .handle(
      "agent.get",
      Effect.fn(function* (ctx) {
        yield* awaitPlugins
        const agent = yield* Agent.Service.use((service) => service.get(ctx.params.agentID))
        if (!agent)
          return yield* new AgentNotFoundError({
            agentID: ctx.params.agentID,
            message: `Agent not found: ${ctx.params.agentID}`,
          })
        return yield* response(Effect.succeed(agent))
      }),
    ),
)
