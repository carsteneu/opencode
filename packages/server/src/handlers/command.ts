import { Command } from "@opencode/core/command"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { awaitPlugins, response } from "../location"

// Commands are registered by plugins (packages/core/src/plugin/command.ts adds
// init and review), so a cold location must wait for activation before it can
// answer. Without the wait the list is empty and clients cache that emptiness.
export const CommandHandler = HttpApiBuilder.group(Api, "server.command", (handlers) =>
  handlers.handle("command.list", () =>
    Effect.gen(function* () {
      yield* awaitPlugins
      return yield* response(Command.Service.use((command) => command.list()))
    }),
  ),
)
