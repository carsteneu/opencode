# opencode-yesmem — v2 plugin

Server-side YesMem plugin for opencode v2. This is the v2 port of the v1 plugin at
`~/.local/share/yesmem/plugins/opencode-yesmem/` (opencode v1 hook API).

Source of the port: the v1 plugin directory (index.ts + code_nav.ts + rule_guard.ts + failure_learn.ts +
auto_resolve.ts + context.ts + skill_whitelist.ts + rpc.ts + types.ts), read directly from
`~/.local/share/yesmem/plugins/opencode-yesmem/` on 2026-10-12. The v2 server-side hook surface is a
different API (`Plugin.define` + per-domain `hook()`), so `index.ts` is new; the domain modules carry the
v1 logic with v2 call sites.

## Layout

| File | Origin | Role |
|---|---|---|
| `index.ts` | new (v2 adapter) | Entrypoint. Registers every hook below through one `Plugin.define`. |
| `rpc.ts` | port of v1 `rpc.ts` | Daemon client (transport rewritten, see Deviations). |
| `types.ts` | copy of v1 `types.ts` | `RPCResponse`. |
| `context.ts` | port of v1 `context.ts` | Per-call session/cwd context for `yesmem_*` tools. |
| `code_nav.ts` | port of v1 `code_nav.ts` | Blocks shell/read navigation on files the YesMem index already covers. |
| `rule_guard.ts` | port of v1 `rule_guard.ts` | Pre-tool RULES.md compliance check (DeepSeek), BLOCK/SUGGEST. |
| `failure_learn.ts` | port of v1 `failure_learn.ts` | Error → `remember`, plus a `hybrid_search` assist note. |
| `auto_resolve.ts` | port of v1 `auto_resolve.ts` | `git commit -m` → `resolve_by_text`. |
| `skill_whitelist.ts` | copy of v1 `skill_whitelist.ts` | Installed-skill set used to filter ghost suggestions. |

`RULES.md` from the v1 directory is **project data**, not plugin source, and is not copied.

## Activation

The plugin is a **server** plugin. opencode v2 loads server plugins from the `plugins` list of a config
document; the target must be a **directory** (file targets are dropped with a warning), and
`Host.resolve` picks `index.ts` as the server entrypoint. Absolute directory paths are used as-is:

```json
{ "plugins": ["/abs/path/to/plugins/opencode-yesmem"] }
```

MCP tools come from the shared `mcp.yesmem` entry and are independent of this plugin.

## Hook mapping (v1 → v2)

| v1 hook | v2 mechanism | Notes |
|---|---|---|
| `tool.execute.before` | `ctx.tool.hook("execute.before", e)` | `e.input` and `e.tool` are mutable. Throwing `Tool.Error` is the **only** way a hook may reject a call. |
| `tool.execute.after` | `ctx.tool.hook("execute.after", e)` | `status: "completed"` exposes a mutable `e.result`; `status: "error"` a mutable `e.error`. Cannot fail. |
| `shell.env` | `ctx.shell.hook("create.before", e)` | Mutable `e.env`. |
| `session.created` | `ctx.event.subscribe()` (`session.created` → `data.sessionID`) | Also mirrors the session id into `process.env.YESMEM_SESSION_ID`. |
| `experimental.chat.messages.transform` (conversation capture only) | `ctx.session.hook("context", e)` | Read-only capture of the last messages for the guard context. |
| `chat.params` (summary-title fallback) | — | No v2 equivalent; the fallback is dropped. |

## Deviations from v1

1. **RPC transport.** v1 shelled out to `echo <json> | nc -U -N -w N <socket>` via `Bun.$`. `nc` is not
   guaranteed to exist and `Bun` is not guaranteed to be the runtime, so the socket is dialed with
   `node:net`. The wire protocol is unchanged (one JSON request line, one JSON response object).
2. **`config.yaml` parsing.** v1 used `await import("yaml")`. The plugin runtime provides only `effect` and
   `@opencode/plugin`, so a third-party YAML module cannot be relied on. `rule_guard.ts` reads the two
   fields it needs (`extraction.model`, `proxy.provider_targets`) with a dependency-free scanner.
3. **Tool names.** v2 names the shell tool `shell`, not `bash`, and adds a file-mutating `patch` tool.
   The guard and code-nav tool sets follow the v2 names.

## Known gaps (not built here)

- **Nudges.** v1's `skill_nudge`, `ledger_nudge` and `idle_reminder` ran inside
  `experimental.chat.messages.transform` and appended text to the message list. They are not ported.
  Note for whoever picks this up: the v2 session domain *does* exist and `ctx.session.hook("context")`
  exposes a mutable `messages` array (`packages/core/src/plugin/plan.ts` inserts reminders through it),
  so these three nudges are portable without any core change.
- **`chat.params`.** No v2 equivalent, so the summary-title conversation fallback is gone.
