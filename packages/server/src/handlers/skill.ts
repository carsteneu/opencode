import { Skill } from "@opencode/core/skill"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { awaitPlugins, response } from "../location"

// Skills are registered by plugins (packages/core/src/plugin/skill.ts adds the
// builtin opencode and report skills), so a cold location must wait for
// activation before it can answer. The wait is also a policy boundary: the
// policy plugin removes skills that `skill.use` denies
// (packages/core/src/config/plugin/policy.ts), so answering before activation
// would list a denied skill with its content. That puts skill.list in the
// documented wait set next to model, provider, generate, voice and websearch.
export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers.handle("skill.list", () =>
    Effect.gen(function* () {
      yield* awaitPlugins
      return yield* response(Skill.Service.use((skill) => skill.list()))
    }),
  ),
)
