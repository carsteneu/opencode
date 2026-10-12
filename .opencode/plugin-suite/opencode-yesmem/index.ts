// YesMem plugin for opencode v2 (server-side).
//
// Ported from the v1 plugin (~/.local/share/yesmem/plugins/opencode-yesmem/index.ts, opencode v1 hook API).
// The v2 hook surface is different, so this file is a new adapter layer; the domain modules
// (code_nav, rule_guard, failure_learn, auto_resolve, context) keep their v1 logic and are adapted in place.
//
// This uses the Effect plugin API on purpose: `execute.before` is the only hook a plugin may fail, and the
// session runner only turns a genuine `Tool.Error` into a model-visible tool failure
// (packages/core/src/session/runner/step.ts catches `Tool.Error` by tag). Through the promise adapter a
// thrown value becomes a defect instead, which the runner does not recover.
//
// See README.md for the mapping table and the documented gaps.

import { Plugin } from "@opencode/plugin/effect"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Effect } from "effect"
import { codeNavGuard, type ToolCallEvent } from "./code_nav"
import { injectYesMemToolContext } from "./context"
import { ruleGuard, type ToolResultEvent } from "./rule_guard"
import { YesMemRPC } from "./rpc"

export default Plugin.define({
  id: "opencode.yesmem",
  effect: (context) =>
    Effect.gen(function* () {
      const directory = String(context.location.directory)
      const rpc = new YesMemRPC()
      const codeNav = codeNavGuard(rpc, directory)
      const guard = ruleGuard(directory)

      // v1 primed the project index once per activation so the first code_nav check is fast.
      // `call` resolves instead of rejecting, so it is safe to wrap in Effect.promise.
      yield* Effect.promise(() =>
        rpc.call("search_code_index", { pattern: "func", kind: "function", project: directory, limit: 1 }),
      )

      // Returns the message the call must be rejected with, or undefined to let it run.
      async function before(event: ToolCallEvent): Promise<string | undefined> {
        const blocked = await codeNav.before(event)
        if (blocked) return blocked
        const violation = await guard.before(event)
        if (violation) return violation
        // Session and cwd context rides on every yesmem_ tool call.
        injectYesMemToolContext(event, directory)
        return undefined
      }

      // A before hook may fail; a rejected promise would be a defect, so the async work is lifted into the
      // error channel and only an intentional block becomes a Tool.Error.
      const reject = (evaluate: () => Promise<string | undefined>) =>
        Effect.tryPromise({ try: evaluate, catch: () => undefined })

      yield* context.tool.hook("execute.before", (event) =>
        Effect.gen(function* () {
          const message = yield* reject(() => before(event))
          if (message) return yield* new ToolError({ message })
        }),
      )

      yield* context.tool.hook("execute.after", (event) =>
        Effect.sync(() => guard.after(event as ToolResultEvent)),
      )

      // Read-only conversation capture for the guard context. The three message-mutating nudges of the v1
      // plugin are deliberately not ported (see README).
      yield* context.session.hook("context", (event) =>
        Effect.sync(() => guard.capture((event as { messages: ReadonlyArray<any> }).messages)),
      )
    }),
})
