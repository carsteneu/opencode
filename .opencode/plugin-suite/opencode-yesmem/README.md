# opencode-yesmem — v2 plugin

Server-side YesMem plugin for opencode v2. This is the v2 port of the v1 plugin at
`~/.local/share/yesmem/plugins/opencode-yesmem/` (opencode v1 hook API).

Source of the port: the v1 plugin directory (index.ts + code_nav.ts + rule_guard.ts + failure_learn.ts +
auto_resolve.ts + context.ts + skill_whitelist.ts + rpc.ts + types.ts), read directly from
`~/.local/share/yesmem/plugins/opencode-yesmem/` on 2026-10-12. The v2 hook surface is a different API
(`Plugin.define` + per-domain `hook()`), so `index.ts` is new; the domain modules carry the v1 logic with v2
call sites.

## Layout

| File | Origin | Role |
|---|---|---|
| `index.ts` | new (v2 adapter) | Entrypoint. Registers every hook through one `Plugin.define`. |
| `rpc.ts` | port of v1 `rpc.ts` | Daemon client (transport rewritten, see Deviations). |
| `types.ts` | copy of v1 `types.ts` | `RPCResponse`. |
| `context.ts` | port of v1 `context.ts` | Per-call session/cwd context for `yesmem_*` tools. |
| `code_nav.ts` | port of v1 `code_nav.ts` | Blocks shell/read navigation on files the YesMem index covers. |
| `rule_guard.ts` | port of v1 `rule_guard.ts` | Pre-tool RULES.md check (small model), BLOCK/SUGGEST. |
| `failure_learn.ts` | port of v1 `failure_learn.ts` | Error → `remember`, plus a `hybrid_search` assist note. |
| `auto_resolve.ts` | port of v1 `auto_resolve.ts` | `git commit -m` → `resolve_by_text`. |
| `session.ts` | new | Session tracking + `register_pid` (v1 used the `session.created` hook). |
| `shell.ts` | port of v1 `shell.env` | Exports the yesmem environment to spawned shells. |
| `skill_whitelist.ts` | copy of v1 `skill_whitelist.ts` | Installed-skill set used to filter ghost suggestions. |
| `log.ts` | new | v1 duplicated this logger in four modules. |

`RULES.md` from the v1 directory is **project data**, not plugin source, and is not copied.

## Activation

The plugin is a **server** plugin. opencode v2 loads server plugins from the `plugins` list of a config
document; the target must be a **directory** (file targets are dropped with a warning), and `Host.resolve`
picks `index.ts` as the server entrypoint. Absolute directory paths are used as-is:

```json
{ "plugins": ["/abs/path/to/plugins/opencode-yesmem"] }
```

MCP tools come from the shared `mcp.yesmem` entry and are independent of this plugin.

## Why the Effect plugin API

The plugin is an **Effect** plugin (`@opencode/plugin/effect`), not a Promise plugin, because of how a
blocked call has to fail:

- `execute.before` is the only hook a plugin may fail, and the session runner recovers it by tag
  (`packages/core/src/session/runner/step.ts` catches `Tool.Error`) and turns it into a model-visible tool
  failure.
- The Promise adapter wraps hook callbacks in `Effect.promise`, whose contract is "the promise must not
  reject" — a throw becomes a **defect**, which the runner does not recover.

So a real `Tool.Error` is required. It is imported from `@opencode/plugin/promise/tool`, which re-exports the
same `@opencode/schema/tool` class the core uses.

Every other hook still runs plain async code, lifted with `Effect.tryPromise` inside `index.ts`.

## Hook mapping (v1 → v2)

| v1 hook | v2 mechanism | Notes |
|---|---|---|
| `tool.execute.before` | `ctx.tool.hook("execute.before", e)` | `e.input` and `e.tool` are mutable; failing with `Tool.Error` rejects the call. code_nav runs first, then rule_guard, then the tool-context injection. |
| `tool.execute.after` | `ctx.tool.hook("execute.after", e)` | `status: "completed"` exposes a mutable `e.result`; `status: "error"` a mutable `e.error`. rule_guard's directive is injected first, then failure_learn, then auto_resolve. |
| `shell.env` | `ctx.shell.hook("create.before", e)` | Mutable `e.env`. |
| `session.created` | `ctx.event.subscribe()` → `session.created`, `data.sessionID` | Registers the process with the daemon; mirrors the id into `process.env.YESMEM_SESSION_ID`. |
| `experimental.chat.messages.transform` (conversation capture only) | `ctx.session.hook("context", e)` | Read-only capture of the last messages for the guard context. |
| `chat.params` (summary-title fallback) | — | No v2 equivalent; the fallback is dropped. |

## Deviations from v1

1. **RPC transport.** v1 shelled out to `echo <json> | nc -U -N -w N <socket>` via `Bun.$`. `nc` is not
   guaranteed to exist and `Bun` is not guaranteed to be the runtime, so the socket is dialed with
   `node:net`. The wire protocol is unchanged (one JSON request line, one JSON response object).
2. **`config.yaml` parsing.** v1 used `await import("yaml")`. The plugin runtime provides only `effect` and
   `@opencode/plugin`, so a third-party YAML module cannot be relied on. `rule_guard.ts` reads the two
   fields it needs (`extraction.model`, `proxy.provider_targets`) with a dependency-free scanner.
3. **Guard endpoint overrides.** `YESMEM_GUARD_URL`, `YESMEM_GUARD_KEY`, `YESMEM_GUARD_MODEL` and
   `YESMEM_GUARD_NPM` short-circuit the provider resolution. Without them the guard can only ever talk to the
   provider resolved from the user's `config.yaml`/`models.json`/`auth.json`, which is untestable.
4. **Tool names and sets.** v2 names the shell tool `shell` (not `bash`) and adds a file-mutating `patch`
   tool. blockable = `write`/`edit`/`patch`; suggestable adds `patch`; `task` is now `subagent`.
5. **Indexed-project memo.** v1 kept one process-wide boolean, so the first indexed project made every later
   project look indexed. The memo is keyed by directory.
6. **`log.ts`.** v1 duplicated the file logger in every module. The log file is `plugin-v2.log`, so a running
   v1 plugin keeps its own.

## Known gaps (not built here)

- **Nudges.** v1's `skill_nudge`, `ledger_nudge` and `idle_reminder` appended text to the outgoing message
  list through `experimental.chat.messages.transform`. They are **not** ported. Note for a follow-up: the v2
  session domain does exist and `ctx.session.hook("context")` exposes a mutable `messages` array
  (`packages/core/src/plugin/plan.ts` inserts reminders through it), so these three nudges are portable
  without any core change. What is missing is a scope decision, not an API.
- **`chat.params`.** No v2 equivalent, so the summary-title conversation fallback is gone.
- **`code_nav` and the dedicated `grep`/`glob` tools.** v1 blocked shell commands and the `read` tool only;
  v2's separate `grep`/`glob` tools are not covered, matching v1's behaviour rather than extending it.

## Tests

`packages/core/test/plugin/opencode-yesmem*.test.ts`, run from `packages/core`:

```
bun run test plugin/opencode-yesmem
```

The plugin files live outside every tsconfig project (deliberate, as for the other plugin-suite entries), so
the tests load them through the real host loader and call the registered hook callbacks directly. The
integration test additionally drives the plugin through the real core plugin host (`PluginModule` +
`Tool.Service` snapshot), which is what proves a block rejects the call before the tool runs.

The daemon is always a local mock socket pointed to by `YESMEM_SOCKET`; no live daemon, config directory or
provider is touched.
