import { createStore } from "solid-js/store"
import { dirname } from "node:path"
import { createMemo, For, Match, Show, Switch, type Accessor } from "solid-js"
import { Portal, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useTheme, selectedForeground } from "../../context/theme"
import type { Part, PermissionRequest } from "@opencode-ai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../ui/border"
import { useSync } from "../../context/sync"
import { useProject } from "../../context/project"
import { filetype } from "../../util/filetype"
import { Locale } from "../../util/locale"
import { webSearchProviderLabel } from "../../util/tool-display"
import { getScrollAcceleration } from "../../util/scroll"
import { useTuiConfig } from "../../config"
import { OPENCODE_BASE_MODE, useBindings, useCommandShortcut } from "../../keymap"
import { usePathFormatter } from "../../context/path-format"
import { createDiffPreview, DIFF_PREVIEW_LIMITS, formatDiffBytes } from "../../util/diff-preview"

type PermissionStage = "permission" | "always" | "reject"
type PermissionInfo = {
  icon: string
  title: string
  body?: JSX.Element
  bodyWithFullscreen?: (expanded: Accessor<boolean>) => JSX.Element
}

export function EditBody(props: { request: PermissionRequest; expanded: Accessor<boolean> }) {
  const themeState = useTheme()
  const theme = themeState.theme
  const syntax = themeState.syntax
  const config = useTuiConfig()
  const dimensions = useTerminalDimensions()

  const filepath = createMemo(() => {
    const value = props.request.metadata?.filepath
    return typeof value === "string" ? value : ""
  })
  const diff = createMemo(() => {
    const value = props.request.metadata?.diff
    return typeof value === "string" ? value : ""
  })
  const preview = createMemo(() => createDiffPreview(diff()))
  const files = createMemo(() => permissionDiffFiles(props.request.metadata?.files))
  const limited = createMemo(() => preview().limited || files().length > DIFF_PREVIEW_LIMITS.maxSetFiles)

  const view = createMemo(() => {
    const diffStyle = config.diff_style
    if (diffStyle === "stacked") return "unified"
    return dimensions().width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(filepath()))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))

  return (
    <box flexDirection="column" gap={1}>
      <Show when={diff()}>
        <scrollbox
          height="100%"
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <Switch>
            <Match when={limited() && !props.expanded()}>
              <box gap={1} paddingLeft={1}>
                <text fg={theme.warning}>
                  Large diff preview · +{preview().additions} -{preview().deletions} ·{" "}
                  {formatDiffBytes(preview().bytes)}
                </text>
                <Show when={files().length > 1}>
                  <box>
                    <For each={files().slice(0, 8)}>
                      {(file) => (
                        <text fg={theme.textMuted}>
                          {file.label} <span style={{ fg: theme.diffAdded }}>+{file.additions}</span>{" "}
                          <span style={{ fg: theme.diffRemoved }}>-{file.deletions}</span>
                        </text>
                      )}
                    </For>
                    <Show when={files().length > 8}>
                      <text fg={theme.textMuted}>… {files().length - 8} more files</text>
                    </Show>
                  </box>
                </Show>
                <text fg={theme.text}>{preview().preview}</text>
                <text fg={theme.textMuted}>Preview limited. Open fullscreen to render the complete diff.</text>
              </box>
            </Match>
            <Match when={limited() && props.expanded() && files().length > 1}>
              <box gap={1} paddingLeft={1}>
                <text fg={theme.textMuted}>Complete raw diff · {files().length} files</text>
                <text fg={theme.text}>{diff()}</text>
              </box>
            </Match>
            <Match when={files().length > 0}>
              <For each={files()}>
                {(file) => (
                  <box gap={1}>
                    <text fg={theme.textMuted} paddingLeft={1}>
                      {file.label} <span style={{ fg: theme.diffAdded }}>+{file.additions}</span>{" "}
                      <span style={{ fg: theme.diffRemoved }}>-{file.deletions}</span>
                    </text>
                    <diff
                      diff={file.patch}
                      view={view()}
                      filetype={filetype(file.filePath)}
                      syntaxStyle={syntax()}
                      showLineNumbers={true}
                      width="100%"
                      wrapMode="word"
                      fg={theme.text}
                      addedBg={theme.diffAddedBg}
                      removedBg={theme.diffRemovedBg}
                      contextBg={theme.diffContextBg}
                      addedSignColor={theme.diffHighlightAdded}
                      removedSignColor={theme.diffHighlightRemoved}
                      lineNumberFg={theme.diffLineNumber}
                      lineNumberBg={theme.diffContextBg}
                      addedLineNumberBg={theme.diffAddedLineNumberBg}
                      removedLineNumberBg={theme.diffRemovedLineNumberBg}
                    />
                  </box>
                )}
              </For>
            </Match>
            <Match when={true}>
              <diff
                diff={diff()}
                view={view()}
                filetype={ft()}
                syntaxStyle={syntax()}
                showLineNumbers={true}
                width="100%"
                wrapMode="word"
                fg={theme.text}
                addedBg={theme.diffAddedBg}
                removedBg={theme.diffRemovedBg}
                contextBg={theme.diffContextBg}
                addedSignColor={theme.diffHighlightAdded}
                removedSignColor={theme.diffHighlightRemoved}
                lineNumberFg={theme.diffLineNumber}
                lineNumberBg={theme.diffContextBg}
                addedLineNumberBg={theme.diffAddedLineNumberBg}
                removedLineNumberBg={theme.diffRemovedLineNumberBg}
              />
            </Match>
          </Switch>
        </scrollbox>
      </Show>
      <Show when={!diff()}>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>No diff provided</text>
        </box>
      </Show>
    </box>
  )
}

type PermissionDiffFile = {
  filePath: string
  label: string
  patch: string
  additions: number
  deletions: number
}

function permissionDiffFiles(value: unknown): PermissionDiffFile[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    if (!("patch" in entry) || typeof entry.patch !== "string") return []
    const filePath = "filePath" in entry && typeof entry.filePath === "string" ? entry.filePath : ""
    return [
      {
        filePath,
        label: "relativePath" in entry && typeof entry.relativePath === "string" ? entry.relativePath : filePath,
        patch: entry.patch,
        additions: "additions" in entry && typeof entry.additions === "number" ? entry.additions : 0,
        deletions: "deletions" in entry && typeof entry.deletions === "number" ? entry.deletions : 0,
      },
    ]
  })
}

function TextBody(props: { title: string; description?: string; icon?: string }) {
  const { theme } = useTheme()
  return (
    <>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <Show when={props.icon}>
          <text fg={theme.textMuted} flexShrink={0}>
            {props.icon}
          </text>
        </Show>
        <text fg={theme.textMuted}>{props.title}</text>
      </box>
      <Show when={props.description}>
        <box paddingLeft={1}>
          <text fg={theme.text}>{props.description}</text>
        </box>
      </Show>
    </>
  )
}

export function PermissionPrompt(props: { request: PermissionRequest; directory?: string }) {
  const sdk = useSDK()
  const project = useProject()
  const sync = useSync()
  const [store, setStore] = createStore({
    stage: "permission" as PermissionStage,
  })
  const pathFormatter = usePathFormatter()

  const session = createMemo(() => sync.data.session.find((s) => s.id === props.request.sessionID))

  const input = createMemo(() =>
    permissionInput(props.request, sync.data.part[props.request.tool?.messageID ?? ""] ?? []),
  )

  const { theme } = useTheme()

  return (
    <Switch>
      <Match when={store.stage === "always"}>
        <Prompt
          title="Always allow"
          body={
            <Switch>
              <Match when={props.request.always.length === 1 && props.request.always[0] === "*"}>
                <TextBody title={"This will allow " + props.request.permission + " until OpenCode is restarted."} />
              </Match>
              <Match when={true}>
                <box paddingLeft={1} gap={1}>
                  <text fg={theme.textMuted}>This will allow the following patterns until OpenCode is restarted</text>
                  <box>
                    <For each={props.request.always}>
                      {(pattern) => (
                        <text fg={theme.text}>
                          {"- "}
                          {pattern}
                        </text>
                      )}
                    </For>
                  </box>
                </box>
              </Match>
            </Switch>
          }
          options={{ confirm: "Confirm", cancel: "Cancel" }}
          escapeKey="cancel"
          onSelect={(option) => {
            setStore("stage", "permission")
            if (option === "cancel") return
            void sdk.client.permission.reply({
              reply: "always",
              requestID: props.request.id,
              directory: props.directory,
              workspace: project.workspace.current(),
            })
          }}
        />
      </Match>
      <Match when={store.stage === "reject"}>
        <RejectPrompt
          onConfirm={(message) => {
            void sdk.client.permission.reply({
              reply: "reject",
              requestID: props.request.id,
              directory: props.directory,
              message: message || undefined,
              workspace: project.workspace.current(),
            })
          }}
          onCancel={() => {
            setStore("stage", "permission")
          }}
        />
      </Match>
      <Match when={store.stage === "permission"}>
        {(() => {
          const info = (): PermissionInfo => {
            const permission = props.request.permission
            const data = input()

            if (permission === "edit") {
              const raw = props.request.metadata?.filepath
              const filepath = typeof raw === "string" ? raw : ""
              return {
                icon: "→",
                title: `Edit ${pathFormatter.format(filepath)}`,
                bodyWithFullscreen: (expanded) => <EditBody request={props.request} expanded={expanded} />,
              }
            }

            if (permission === "read") {
              const raw = data.filePath
              const filePath = typeof raw === "string" ? raw : ""
              return {
                icon: "→",
                title: `Read ${pathFormatter.format(filePath)}`,
                body: (
                  <Show when={filePath}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Path: " + pathFormatter.format(filePath)}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "glob") {
              const pattern = typeof data.pattern === "string" ? data.pattern : ""
              return {
                icon: "✱",
                title: `Glob "${pattern}"`,
                body: (
                  <Show when={pattern}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Pattern: " + pattern}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "grep") {
              const pattern = typeof data.pattern === "string" ? data.pattern : ""
              return {
                icon: "✱",
                title: `Grep "${pattern}"`,
                body: (
                  <Show when={pattern}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Pattern: " + pattern}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "list") {
              const raw = data.path
              const dir = typeof raw === "string" ? raw : ""
              return {
                icon: "→",
                title: `List ${pathFormatter.format(dir)}`,
                body: (
                  <Show when={dir}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Path: " + pathFormatter.format(dir)}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "bash") {
              const command = typeof data.command === "string" ? data.command : ""
              return {
                icon: "#",
                title: "Shell command",
                body: (
                  <Show when={command}>
                    <box paddingLeft={1}>
                      <text fg={theme.text}>{"$ " + command}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "task") {
              const type = typeof data.subagent_type === "string" ? data.subagent_type : "Unknown"
              const desc = typeof data.description === "string" ? data.description : ""
              return {
                icon: "#",
                title: `${Locale.titlecase(type)} Task`,
                body: (
                  <Show when={desc}>
                    <box paddingLeft={1}>
                      <text fg={theme.text}>{"◉ " + desc}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "webfetch") {
              const url = typeof data.url === "string" ? data.url : ""
              return {
                icon: "%",
                title: `WebFetch ${url}`,
                body: (
                  <Show when={url}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"URL: " + url}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "websearch") {
              const query = typeof data.query === "string" ? data.query : ""
              return {
                icon: "◈",
                title: `${webSearchProviderLabel(data.provider)} "${query}"`,
                body: (
                  <Show when={query}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Query: " + query}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "external_directory") {
              const meta = props.request.metadata ?? {}
              const parent = typeof meta["parentDir"] === "string" ? meta["parentDir"] : undefined
              const filepath = typeof meta["filepath"] === "string" ? meta["filepath"] : undefined
              const pattern = props.request.patterns?.[0]
              const derived =
                typeof pattern === "string" ? (pattern.includes("*") ? dirname(pattern) : pattern) : undefined

              const raw = parent ?? filepath ?? derived
              const dir = pathFormatter.format(raw)
              const patterns = (props.request.patterns ?? []).filter((p): p is string => typeof p === "string")

              return {
                icon: "←",
                title: `Access external directory ${dir}`,
                body: (
                  <Show when={patterns.length > 0}>
                    <box paddingLeft={1} gap={1}>
                      <text fg={theme.textMuted}>Patterns</text>
                      <box>
                        <For each={patterns}>{(p) => <text fg={theme.text}>{"- " + p}</text>}</For>
                      </box>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "doom_loop") {
              return {
                icon: "⟳",
                title: "Continue after repeated failures",
                body: (
                  <box paddingLeft={1}>
                    <text fg={theme.textMuted}>This keeps the session running despite repeated failures.</text>
                  </box>
                ),
              }
            }

            return {
              icon: "⚙",
              title: `Call tool ${permission}`,
              body: (
                <box paddingLeft={1}>
                  <text fg={theme.textMuted}>{"Tool: " + permission}</text>
                </box>
              ),
            }
          }

          const current = info()

          const header = () => (
            <box flexDirection="column" gap={0}>
              <box flexDirection="row" gap={1} flexShrink={0}>
                <text fg={theme.warning}>{"△"}</text>
                <text fg={theme.text}>Permission required</text>
              </box>
              <box flexDirection="row" gap={1} paddingLeft={2} flexShrink={0}>
                <text fg={theme.textMuted} flexShrink={0}>
                  {current.icon}
                </text>
                <text fg={theme.text}>{current.title}</text>
              </box>
            </box>
          )

          const body = (
            <Prompt
              title="Permission required"
              header={header()}
              body={current.body}
              bodyWithFullscreen={current.bodyWithFullscreen}
              options={{ once: "Allow once", always: "Allow always", reject: "Reject" }}
              escapeKey="reject"
              fullscreen
              onSelect={(option) => {
                if (option === "always") {
                  setStore("stage", "always")
                  return
                }
                if (option === "reject") {
                  if (session()?.parentID) {
                    setStore("stage", "reject")
                    return
                  }
                  void sdk.client.permission.reply({
                    reply: "reject",
                    requestID: props.request.id,
                    directory: props.directory,
                    workspace: project.workspace.current(),
                  })
                  return
                }
                void sdk.client.permission.reply({
                  reply: "once",
                  requestID: props.request.id,
                  directory: props.directory,
                  workspace: project.workspace.current(),
                })
              }}
            />
          )

          return body
        })()}
      </Match>
    </Switch>
  )
}

export function permissionInput(request: PermissionRequest, parts: Part[]) {
  const metadata = request.metadata ?? {}
  const tool = request.tool
  if (!tool) return metadata
  const part = parts.find(
    (item) => item.type === "tool" && item.callID === tool.callID && item.state.status !== "pending",
  )
  if (!part || part.type !== "tool") return metadata
  return { ...metadata, ...part.state.input }
}

function RejectPrompt(props: { onConfirm: (message: string) => void; onCancel: () => void }) {
  let input: TextareaRenderable
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)
  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    commands: [
      {
        name: "app.exit",
        title: "Cancel permission rejection",
        category: "Permission",
        run() {
          props.onCancel()
        },
      },
    ],
    bindings: [
      { key: "escape", desc: "Cancel permission rejection", group: "Permission", cmd: () => props.onCancel() },
      ...tuiConfig.keybinds.get("app.exit"),
      {
        key: "return",
        desc: "Confirm permission rejection",
        group: "Permission",
        cmd: () => props.onConfirm(input.plainText),
      },
    ],
  }))

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.error}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={theme.error}>{"△"}</text>
          <text fg={theme.text}>Reject permission</text>
        </box>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>Tell OpenCode what to do differently</text>
        </box>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
        gap={1}
      >
        <textarea
          ref={(val: TextareaRenderable) => {
            input = val
            val.traits = { status: "REJECT" }
          }}
          focused
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.primary}
          cursorStyle={tuiConfig.cursor}
        />
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>confirm</span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>cancel</span>
          </text>
        </box>
      </box>
    </box>
  )
}

function Prompt<const T extends Record<string, string>>(props: {
  title: string
  header?: JSX.Element
  body?: JSX.Element
  bodyWithFullscreen?: (expanded: Accessor<boolean>) => JSX.Element
  options: T
  escapeKey?: keyof T
  fullscreen?: boolean
  onSelect: (option: keyof T) => void
}) {
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const keys = Object.keys(props.options) as (keyof T)[]
  const [store, setStore] = createStore({
    selected: keys[0],
    expanded: false,
  })
  const narrow = createMemo(() => dimensions().width < 80)
  const fullscreenHint = useCommandShortcut("permission.prompt.fullscreen")

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    commands: [
      {
        name: "app.exit",
        title: "Reject permission",
        category: "Permission",
        run() {
          if (!props.escapeKey) return
          props.onSelect(props.escapeKey)
        },
      },
      {
        name: "permission.prompt.fullscreen",
        title: "Toggle permission fullscreen",
        category: "Permission",
        run() {
          if (!props.fullscreen) return
          setStore("expanded", (v) => !v)
        },
      },
    ],
    bindings: [
      {
        key: "left",
        desc: "Previous permission option",
        group: "Permission",
        cmd: () => {
          const idx = keys.indexOf(store.selected)
          const next = keys[(idx - 1 + keys.length) % keys.length]
          setStore("selected", next)
        },
      },
      {
        key: "h",
        desc: "Previous permission option",
        group: "Permission",
        cmd: () => {
          const idx = keys.indexOf(store.selected)
          const next = keys[(idx - 1 + keys.length) % keys.length]
          setStore("selected", next)
        },
      },
      {
        key: "right",
        desc: "Next permission option",
        group: "Permission",
        cmd: () => {
          const idx = keys.indexOf(store.selected)
          const next = keys[(idx + 1) % keys.length]
          setStore("selected", next)
        },
      },
      {
        key: "l",
        desc: "Next permission option",
        group: "Permission",
        cmd: () => {
          const idx = keys.indexOf(store.selected)
          const next = keys[(idx + 1) % keys.length]
          setStore("selected", next)
        },
      },
      {
        key: "return",
        desc: "Select permission option",
        group: "Permission",
        cmd: () => props.onSelect(store.selected),
      },
      ...(props.escapeKey
        ? [
            {
              key: "escape",
              desc: "Reject permission",
              group: "Permission",
              cmd: () => props.onSelect(props.escapeKey!),
            },
          ]
        : []),
      ...(props.escapeKey ? tuiConfig.keybinds.get("app.exit") : []),
      ...(props.fullscreen ? tuiConfig.keybinds.get("permission.prompt.fullscreen") : []),
    ],
  }))

  const hint = createMemo(() => (store.expanded ? "minimize" : "fullscreen"))
  useRenderer()

  const content = () => (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.warning}
      customBorderChars={SplitBorder.customBorderChars}
      {...(store.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" }
        : {
            top: 0,
            maxHeight: 15,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
        <Show
          when={props.header}
          fallback={
            <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
              <text fg={theme.warning}>{"△"}</text>
              <text fg={theme.text}>{props.title}</text>
            </box>
          }
        >
          <box paddingLeft={1} flexShrink={0}>
            {props.header}
          </box>
        </Show>
        {props.bodyWithFullscreen ? props.bodyWithFullscreen(() => store.expanded) : props.body}
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <For each={keys}>
            {(option) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={option === store.selected ? theme.warning : theme.backgroundMenu}
                onMouseOver={() => setStore("selected", option)}
                onMouseUp={() => {
                  setStore("selected", option)
                  props.onSelect(option)
                }}
              >
                <text fg={option === store.selected ? selectedForeground(theme, theme.warning) : theme.textMuted}>
                  {props.options[option]}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={props.fullscreen}>
            <text fg={theme.text}>
              {fullscreenHint()} <span style={{ fg: theme.textMuted }}>{hint()}</span>
            </text>
          </Show>
          <text fg={theme.text}>
            {"⇆"} <span style={{ fg: theme.textMuted }}>select</span>
          </text>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>confirm</span>
          </text>
        </box>
      </box>
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}
