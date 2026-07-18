import { run as runTui, type TuiInput } from "@opencode-ai/tui"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(LayerNode.compile(Global.node)))
}
