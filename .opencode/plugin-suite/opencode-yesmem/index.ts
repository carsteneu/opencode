// YesMem plugin for opencode v2 (server-side).
//
// Ported from the v1 plugin (~/.local/share/yesmem/plugins/opencode-yesmem/index.ts, opencode v1 hook API).
// The v2 hook surface is different, so this file is a new adapter layer; the domain modules
// (code_nav, rule_guard, failure_learn, auto_resolve, context) keep their v1 logic and are adapted in place.
// See README.md for the mapping table and the documented gaps.

import { Plugin } from "@opencode/plugin"
import { YesMemRPC } from "./rpc"

export default Plugin.define({
  id: "opencode.yesmem",
  async setup(context) {
    const directory = String(context.location.directory)
    const rpc = new YesMemRPC()

    // v1 primed the project index once per activation so the first code_nav check is fast.
    rpc
      .call("search_code_index", { pattern: "func", kind: "function", project: directory, limit: 1 })
      .catch(() => {})

    return () => {}
  },
})
