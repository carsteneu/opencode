import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import type { RuntimeFlags } from "@/effect/runtime-flags"

export type InternalTuiPlugin = BuiltinTuiPlugin

export async function internalTuiPlugins(
  flags: Pick<RuntimeFlags.Info, "experimentalEventSystem">,
): Promise<InternalTuiPlugin[]> {
  const { createBuiltinPlugins } = await import("@opencode-ai/tui/builtins")
  return createBuiltinPlugins({
    experimentalEventSystem: flags.experimentalEventSystem,
  })
}
