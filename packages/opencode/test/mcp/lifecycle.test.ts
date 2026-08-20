import path from "node:path"
import { pathToFileURL } from "node:url"
import { expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Fiber } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"
import { MCP } from "../../src/mcp/index"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { InstanceStore } from "../../src/project/instance-store"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")

type Page<T> = { items: T[]; nextCursor?: string }

interface LifecycleServerState {
  tools: Tool[]
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  resourceTemplates: Array<{ name: string; uriTemplate: string; description?: string }>
  toolPages?: Record<string, Page<Tool>>
  promptPages?: Record<string, Page<{ name: string; description?: string }>>
  resourcePages?: Record<string, Page<{ name: string; uri: string; description?: string }>>
  resourceTemplatePages?: Record<string, Page<{ name: string; uriTemplate: string; description?: string }>>
  listToolsError?: string
  requestDelay?: number
  roots?: Array<{ uri: string; name?: string }>
  requests: string[]
  aborted: number
}

function lifecycleServer(input?: { capabilities?: ServerCapabilities; instructions?: string; requestRoots?: boolean }) {
  const capabilities = input?.capabilities ?? { tools: {}, prompts: {}, resources: {} }
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const state: LifecycleServerState = {
        tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }],
        prompts: [],
        resources: [],
        resourceTemplates: [],
        requests: [],
        aborted: 0,
      }

      const makeProtocol = async () => {
        const protocol = new Server(
          { name: "mcp-lifecycle", version: "1.0.0" },
          { capabilities, instructions: input?.instructions },
        )
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
        })

        if (capabilities.tools) {
          protocol.setRequestHandler(ListToolsRequestSchema, (request) => {
            if (state.listToolsError) throw new Error(state.listToolsError)
            const page = state.toolPages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ tools: page?.items ?? state.tools, nextCursor: page?.nextCursor })
          })
        }
        if (capabilities.prompts) {
          protocol.setRequestHandler(ListPromptsRequestSchema, (request) => {
            const page = state.promptPages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ prompts: page?.items ?? state.prompts, nextCursor: page?.nextCursor })
          })
          protocol.setRequestHandler(GetPromptRequestSchema, async () => {
            if (state.requestDelay) await Bun.sleep(state.requestDelay)
            return { messages: [{ role: "user", content: { type: "text", text: "prompt result" } }] }
          })
        }
        if (capabilities.resources) {
          protocol.setRequestHandler(ListResourcesRequestSchema, (request) => {
            const page = state.resourcePages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ resources: page?.items ?? state.resources, nextCursor: page?.nextCursor })
          })
          protocol.setRequestHandler(ListResourceTemplatesRequestSchema, (request) => {
            const page = state.resourceTemplatePages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({
              resourceTemplates: page?.items ?? state.resourceTemplates,
              nextCursor: page?.nextCursor,
            })
          })
          protocol.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            if (state.requestDelay) await Bun.sleep(state.requestDelay)
            return { contents: [{ uri: request.params.uri, text: "resource result" }] }
          })
        }

        protocol.oninitialized = () => {
          if (!input?.requestRoots) return
          if (!protocol.getClientCapabilities()?.roots) return
          void Bun.sleep(25)
            .then(() => protocol.listRoots())
            .then((result) => {
              state.roots = result.roots
            })
            .catch(() => {})
        }
        await protocol.connect(transport)
        return { protocol, transport }
      }

      let current = await makeProtocol()
      const http = Bun.serve({
        port: 0,
        fetch(request) {
          state.requests.push(request.method)
          request.signal.addEventListener("abort", () => state.aborted++)
          return current.transport.handleRequest(request)
        },
      })

      return {
        state,
        url: http.url.toString(),
        sendToolListChanged: () => current.protocol.sendToolListChanged(),
        restart: async () => {
          current = await makeProtocol()
        },
        close: async () => {
          await current.protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function hangingLifecycleServer() {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server({ name: "mcp-lifecycle-hanging", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const requests: string[] = []
      let aborted = 0
      const http = Bun.serve({
        port: 0,
        fetch(request) {
          requests.push(request.method)
          request.signal.addEventListener("abort", () => aborted++)
          return new Promise<Response>(() => {})
        },
      })
      return {
        requests,
        aborted: () => aborted,
        url: http.url.toString(),
        close: async () => {
          await protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function statusName(status: Record<string, MCPNS.Status> | MCPNS.Status, server: string) {
  if ("status" in status) return status.status
  return status[server]?.status
}

const remote = (url: string, timeout?: number) => ({ type: "remote" as const, url, oauth: false as const, timeout })

const treeNames = ["root", "child", "grandchild"] as const
const initializationServers = Array.from({ length: 8 }, (_, index) => `barrier-${index}`)
const initializationBarrier = "mcp-initialization-barrier"
const initializationMcp = Object.fromEntries(
  initializationServers.map((name) => [
    name,
    {
      type: "local" as const,
      command: [process.execPath, stdioFixture, "--barrier"],
      environment: {
        MCP_LIFECYCLE_BARRIER_DIR: initializationBarrier,
        MCP_LIFECYCLE_BARRIER_NAME: name,
      },
      timeout: 10_000,
    },
  ]),
)
const interruptedInitializationMcp = {
  "ready-stdio": {
    type: "local" as const,
    command: [process.execPath, stdioFixture],
    environment: {
      MCP_LIFECYCLE_PID_FILE: path.join(initializationBarrier, "ready.pid"),
      MCP_LIFECYCLE_LISTED_FILE: path.join(initializationBarrier, "ready.listed"),
    },
    timeout: 10_000,
  },
  ...initializationMcp,
}

function registerPidCleanup(files: string[], release?: string) {
  return Effect.addFinalizer(() =>
    Effect.tryPromise(async () => {
      if (release) {
        await Bun.write(release, "release")
        const deadline = Date.now() + 2_000
        while (
          Date.now() < deadline &&
          !(await Promise.all(files.map((file) => Bun.file(file).exists()))).every(Boolean)
        ) {
          await Bun.sleep(10)
        }
      }

      await Promise.allSettled(
        files.map(async (file) => {
          const value = Bun.file(file)
          if (!(await value.exists())) return
          process.kill(Number(await value.text()), "SIGKILL")
        }),
      )
    }).pipe(Effect.ignore),
  )
}

function readTree(directory: string) {
  return pollWithTimeout(
    Effect.promise(async () => {
      const files = treeNames.map((name) => Bun.file(path.join(directory, `${name}.pid`)))
      if (!(await Promise.all(files.map((file) => file.exists()))).every(Boolean)) return undefined
      return Promise.all(files.map(async (file) => Number(await file.text())))
    }),
    "stdio fixture did not publish its process tree",
  )
}

function processRunning(pid: number) {
  return Effect.try({
    try: () => process.kill(pid, 0),
    catch: () => undefined,
  }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
}

function waitForTreeExit(pids: number[]) {
  return pollWithTimeout(
    Effect.forEach(pids, processRunning).pipe(
      Effect.map((running) => (running.every((value) => !value) ? true : undefined)),
    ),
    "stdio fixture process tree was not terminated",
  )
}

it.instance("advertises and lists the instance directory as its root", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ requestRoots: true })
    const mcp = yield* MCP.Service
    const test = yield* TestInstance
    yield* mcp.add("roots", remote(server.url))

    const roots = yield* pollWithTimeout(
      Effect.sync(() => server.state.roots),
      "server did not receive roots",
    )
    expect(roots).toEqual([{ uri: pathToFileURL(test.directory).href }])
  }),
)

it.instance(
  "local mcp cwd resolves relative paths against instance directory",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const test = yield* TestInstance
      yield* mcp.add("rel-cwd", {
        type: "local",
        command: [process.execPath, stdioFixture],
        cwd: "plugins/sub",
      })

      expect((yield* mcp.tools())["rel-cwd_current_directory"]?.def.description).toBe(
        path.resolve(test.directory, "plugins/sub"),
      )
    }),
  { init: (directory) => Effect.promise(() => Bun.$`mkdir -p ${path.join(directory, "plugins/sub")}`.quiet()) },
)

it.instance("tools() reuses cached definitions until a protocol notification", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: { listChanged: true } } })
    const mcp = yield* MCP.Service
    yield* mcp.add("cache-server", remote(server.url))
    server.state.tools = [{ name: "next_tool", inputSchema: { type: "object", properties: {} } }]

    expect(Object.keys(yield* mcp.tools())).toEqual(["cache-server_test_tool"])
    yield* Effect.promise(server.sendToolListChanged)
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const keys = Object.keys(yield* mcp.tools())
        return keys.includes("cache-server_next_tool") ? keys : undefined
      }),
      "tool cache did not refresh",
    )
    expect(Object.keys(yield* mcp.tools())).toEqual(["cache-server_next_tool"])
  }),
)

it.instance("instructions() returns non-empty connected server instructions with tool names", () =>
  Effect.gen(function* () {
    const guide = yield* lifecycleServer({ instructions: "Use lookup before mutate." })
    const blank = yield* lifecycleServer({ instructions: "   " })
    const mcp = yield* MCP.Service
    yield* mcp.add("guide-server", remote(guide.url))
    yield* mcp.add("blank-server", remote(blank.url))

    expect(yield* mcp.instructions()).toEqual([
      { name: "guide-server", instructions: "Use lookup before mutate.", tools: ["guide-server_test_tool"] },
    ])
    yield* mcp.disconnect("guide-server")
    expect(yield* mcp.instructions()).toEqual([])
  }),
)

it.instance("follows cursors when listing tools, prompts, resources, and templates", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.toolPages = {
      initial: { items: [{ name: "tool-one", inputSchema: { type: "object" } }], nextCursor: "tools-2" },
      "tools-2": { items: [{ name: "tool-two", inputSchema: { type: "object" } }] },
    }
    server.state.promptPages = {
      initial: { items: [{ name: "prompt-one" }], nextCursor: "prompts-2" },
      "prompts-2": { items: [{ name: "prompt-two" }] },
    }
    server.state.resourcePages = {
      initial: { items: [{ name: "resource-one", uri: "test://one" }], nextCursor: "resources-2" },
      "resources-2": { items: [{ name: "resource-two", uri: "test://two" }] },
    }
    server.state.resourceTemplatePages = {
      initial: { items: [{ name: "template-one", uriTemplate: "test://one/{id}" }], nextCursor: "templates-2" },
      "templates-2": { items: [{ name: "template-two", uriTemplate: "test://two/{id}" }] },
    }
    const mcp = yield* MCP.Service
    yield* mcp.add("paged-server", remote(server.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["paged-server_tool-one", "paged-server_tool-two"])
    expect(Object.keys(yield* mcp.prompts())).toEqual(["paged-server:prompt-one", "paged-server:prompt-two"])
    expect(Object.keys(yield* mcp.resources())).toEqual(["paged-server:test://one", "paged-server:test://two"])
    expect(Object.keys(yield* mcp.resourceTemplates())).toEqual([
      "paged-server:test://one/{id}",
      "paged-server:test://two/{id}",
    ])
  }),
)

it.instance("accepts empty cursors and rejects repeated cursors", () =>
  Effect.gen(function* () {
    const empty = yield* lifecycleServer({ capabilities: { prompts: {} } })
    empty.state.promptPages = {
      initial: { items: [{ name: "prompt-one" }], nextCursor: "" },
      "": { items: [{ name: "prompt-two" }] },
    }
    const looping = yield* lifecycleServer({ capabilities: { tools: {} } })
    looping.state.toolPages = {
      initial: { items: [], nextCursor: "repeat" },
      repeat: { items: [], nextCursor: "repeat" },
    }
    const mcp = yield* MCP.Service
    yield* mcp.add("empty-cursor", remote(empty.url))
    const result = yield* mcp.add("looping-cursor", remote(looping.url))

    expect(Object.keys(yield* mcp.prompts())).toEqual(["empty-cursor:prompt-one", "empty-cursor:prompt-two"])
    expect(statusName(result.status, "looping-cursor")).toBe("failed")
  }),
)

it.instance("disconnect removes protocol data and reconnect establishes a new session", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("reconnect-server", remote(server.url))
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("connected")

    yield* mcp.disconnect("reconnect-server")
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("disabled")
    expect(Object.keys(yield* mcp.tools())).toEqual([])
    yield* pollWithTimeout(
      Effect.sync(() => (server.state.aborted > 0 ? server.state.aborted : undefined)),
      "disconnected HTTP session was not aborted",
    )

    yield* Effect.promise(server.restart)
    yield* mcp.connect("reconnect-server")
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("connected")
    expect(Object.keys(yield* mcp.tools())).toEqual(["reconnect-server_test_tool"])
  }),
)

it.instance("add() closes the old protocol session when replacing a server", () =>
  Effect.gen(function* () {
    const first = yield* lifecycleServer()
    const second = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("replace-server", remote(first.url))
    yield* mcp.add("replace-server", remote(second.url))

    yield* pollWithTimeout(
      Effect.sync(() => (first.state.aborted > 0 ? first.state.aborted : undefined)),
      "replaced HTTP session was not aborted",
    )
    expect(second.state.aborted).toBe(0)
    expect(Object.keys(yield* mcp.tools())).toEqual(["replace-server_test_tool"])
  }),
)

it.instance("one failed server does not affect another connected server", () =>
  Effect.gen(function* () {
    const good = yield* lifecycleServer()
    good.state.tools = [{ name: "good_tool", inputSchema: { type: "object" } }]
    const bad = yield* lifecycleServer()
    bad.state.listToolsError = "listTools failed"
    const mcp = yield* MCP.Service
    yield* mcp.add("good-server", remote(good.url))
    yield* mcp.add("bad-server", remote(bad.url))

    expect((yield* mcp.status())["good-server"]?.status).toBe("connected")
    expect((yield* mcp.status())["bad-server"]?.status).toBe("failed")
    expect(Object.keys(yield* mcp.tools())).toEqual(["good-server_good_tool"])
  }),
)

it.instance("falls back when output schema refs fail SDK tool discovery", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.tools = [
      {
        name: "render_screen",
        inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
        outputSchema: { type: "object", properties: { screen: { $ref: "#/$defs/ScreenInstance" } } },
      },
    ]
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("schema-server", remote(server.url))

    expect(statusName(result.status, "schema-server")).toBe("connected")
    expect(Object.keys(yield* mcp.tools())).toEqual(["schema-server_render_screen"])
  }),
)

it.instance("does not fall back for protocol tool discovery errors", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.listToolsError = "transport closed"
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("broken-server", remote(server.url))

    expect(statusName(result.status, "broken-server")).toBe("failed")
  }),
)

it.instance("disabled server is marked disabled without opening a protocol session", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("disabled-server", { ...remote(server.url), enabled: false })

    expect((yield* mcp.status())["disabled-server"]?.status).toBe("disabled")
    expect(server.state.requests).toEqual([])
  }),
)

it.instance("returns prompts and URI-keyed resources from connected servers", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.prompts = [{ name: "my-prompt", description: "A test prompt" }]
    server.state.resources = [
      { name: "same-name", uri: "file:///test.txt" },
      { name: "same-name", uri: "ui://component-state" },
    ]
    const mcp = yield* MCP.Service
    yield* mcp.add("content-server", remote(server.url))

    expect(Object.keys(yield* mcp.prompts())).toEqual(["content-server:my-prompt"])
    expect(Object.keys(yield* mcp.resources())).toEqual([
      "content-server:file:///test.txt",
      "content-server:ui://component-state",
    ])
    yield* mcp.disconnect("content-server")
    expect(yield* mcp.prompts()).toEqual({})
  }),
)

it.instance("uses per-server timeouts for prompt and resource requests", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.requestDelay = 200
    const mcp = yield* MCP.Service
    yield* mcp.add("timeout-server", remote(server.url, 50))

    expect(yield* mcp.getPrompt("timeout-server", "test")).toBeUndefined()
    expect(yield* mcp.readResource("timeout-server", "test://resource")).toBeUndefined()
  }),
)

it.instance("connects resource-only, prompt-only, and tools-only servers", () =>
  Effect.gen(function* () {
    const resources = yield* lifecycleServer({ capabilities: { resources: {} } })
    resources.state.resources = [{ name: "docs", uri: "docs://readme" }]
    const prompts = yield* lifecycleServer({ capabilities: { prompts: {} } })
    prompts.state.prompts = [{ name: "review" }]
    const tools = yield* lifecycleServer({ capabilities: { tools: {} } })
    const mcp = yield* MCP.Service
    yield* mcp.add("resource-only", remote(resources.url))
    yield* mcp.add("prompt-only", remote(prompts.url))
    yield* mcp.add("tools-only", remote(tools.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["tools-only_test_tool"])
    expect(Object.keys(yield* mcp.prompts())).toEqual(["prompt-only:review"])
    expect(Object.keys(yield* mcp.resources())).toEqual(["resource-only:docs://readme"])
  }),
)

it.instance("connect and disconnect fail for unknown servers", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    for (const operation of [mcp.connect("missing"), mcp.disconnect("missing")]) {
      const exit = yield* operation.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "MCP.NotFoundError", name: "missing" })
      }
    }
    expect(yield* mcp.status()).toEqual({})
    expect(yield* mcp.tools()).toEqual({})
  }),
)

it.instance("unavailable remote server is marked failed without tools", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ port: 0, fetch: () => new Response("unavailable", { status: 503 }) })),
      (http) => Effect.promise(() => http.stop(true)),
    )
    const mcp = yield* MCP.Service
    yield* mcp.add("unavailable", remote(server.url.toString(), 500))

    expect((yield* mcp.status()).unavailable?.status).toBe("failed")
    expect(yield* mcp.tools()).toEqual({})
  }),
)

it.instance("tools() prefixes sanitized server and tool names", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.tools = [
      { name: "tool-a", inputSchema: { type: "object" } },
      { name: "tool.b", inputSchema: { type: "object" } },
    ]
    const mcp = yield* MCP.Service
    yield* mcp.add("my.special-server", remote(server.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["my_special-server_tool-a", "my_special-server_tool_b"])
  }),
)

it.instance("local stdio timeout terminates the real server process", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const pidFile = path.join(test.directory, "mcp.pid")
    yield* registerPidCleanup([pidFile])
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("hanging-stdio", {
      type: "local",
      command: [process.execPath, stdioFixture, "--hang"],
      environment: { MCP_LIFECYCLE_PID_FILE: pidFile },
      timeout: 100,
    })

    expect(statusName(result.status, "hanging-stdio")).toBe("failed")
    const pid = yield* pollWithTimeout(
      Effect.promise(async () => {
        const file = Bun.file(pidFile)
        return (await file.exists()) ? Number(await file.text()) : undefined
      }),
      "stdio fixture did not publish its pid",
    )
    yield* pollWithTimeout(
      Effect.sync(() => {
        try {
          process.kill(pid, 0)
          return undefined
        } catch {
          return true
        }
      }),
      "stdio fixture process was not terminated",
    )
  }),
)

it.instance("drains more than one MiB of local stdio stderr before initialization", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const pidFile = path.join(test.directory, "chatty.pid")
    const doneFile = path.join(test.directory, "chatty.done")
    yield* registerPidCleanup([pidFile])
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("chatty-stdio", {
      type: "local",
      command: [process.execPath, stdioFixture, "--chatty-stderr"],
      environment: {
        MCP_LIFECYCLE_PID_FILE: pidFile,
        MCP_LIFECYCLE_STDERR_DONE: doneFile,
      },
      timeout: 10_000,
    })

    expect(statusName(result.status, "chatty-stdio")).toBe("connected")
    expect(yield* Effect.promise(() => Bun.file(doneFile).exists())).toBe(true)
  }),
)

it.instance(
  "initializes no more than four configured MCP servers concurrently",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const directory = path.join(test.directory, initializationBarrier)
      const files = initializationServers.map((name) => path.join(directory, `${name}.started`))
      const release = path.join(directory, "release")
      yield* registerPidCleanup(files, release)
        const mcp = yield* MCP.Service
        const loading = yield* Effect.forkScoped(mcp.clients())

        const firstWave = yield* pollWithTimeout(
        Effect.promise(async () => {
          const count = (await Promise.all(files.map((file) => Bun.file(file).exists()))).filter(Boolean).length
          return count >= 4 ? count : undefined
        }),
        "configured MCP servers did not reach the initialization barrier",
      )
      expect(firstWave).toBe(4)

      const overflow = yield* pollWithTimeout(
        Effect.promise(async () => {
          const count = (await Promise.all(files.map((file) => Bun.file(file).exists()))).filter(Boolean).length
          return count > 4 ? count : undefined
        }),
        "unused",
      ).pipe(Effect.timeoutOption("750 millis"))
      expect(overflow._tag).toBe("None")

        yield* Effect.promise(() => Bun.write(release, "release"))
        const clients = yield* Fiber.join(loading)
        expect(initializationServers.every((name) => clients[name] !== undefined)).toBe(true)
      }),
  {
    config: {
      mcp: initializationMcp,
    },
    init: (directory) =>
      Effect.promise(() => Bun.$`mkdir -p ${path.join(directory, initializationBarrier)}`.quiet()).pipe(Effect.asVoid),
  },
  30_000,
)

it.instance(
  "instance disposal during MCP initialization stops connected and starting servers",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const directory = path.join(test.directory, initializationBarrier)
      const barrierFiles = initializationServers.map((name) => path.join(directory, `${name}.started`))
      const readyPid = path.join(directory, "ready.pid")
      const readyListed = path.join(directory, "ready.listed")
      const files = [readyPid, ...barrierFiles]
      yield* registerPidCleanup(files)
        const mcp = yield* MCP.Service
        const loading = yield* Effect.forkScoped(mcp.tools())
        const pids = yield* pollWithTimeout(
        Effect.promise(async () => {
          if (!(await Bun.file(readyListed).exists())) return undefined
          const started = await Promise.all(
            barrierFiles.map(async (file) => {
              const value = Bun.file(file)
              return (await value.exists()) ? Number(await value.text()) : undefined
            }),
          )
          const running = started.filter((pid): pid is number => pid !== undefined)
          if (running.length < 4) return undefined
          return [Number(await Bun.file(readyPid).text()), ...running]
        }),
        "configured MCP servers did not reach connected and starting states",
      )
      expect(pids).toHaveLength(5)

      yield* InstanceStore.Service.use((store) => store.disposeDirectory(test.directory))

      yield* waitForTreeExit(pids)
      expect(Exit.isFailure(yield* Fiber.await(loading))).toBe(true)
    }),
  {
    config: { mcp: interruptedInitializationMcp },
    init: (directory) =>
      Effect.promise(() => Bun.$`mkdir -p ${path.join(directory, initializationBarrier)}`.quiet()).pipe(Effect.asVoid),
  },
  20_000,
)

if (process.platform !== "win32") {
  it.instance(
    "stdio setup failure terminates a real process tree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const files = treeNames.map((name) => path.join(test.directory, `${name}.pid`))
        yield* registerPidCleanup(files)
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("tree-setup-failure", {
          type: "local",
          command: [process.execPath, stdioFixture, "--tree", "--hang"],
          environment: {
            MCP_LIFECYCLE_TREE_DIR: test.directory,
            MCP_LIFECYCLE_PID_FILE: files[0],
          },
          timeout: 3_000,
        })
        const pids = yield* readTree(test.directory)

        expect(statusName(result.status, "tree-setup-failure")).toBe("failed")
        yield* waitForTreeExit(pids)
      }),
    20_000,
  )

  it.instance(
    "stdio tool discovery failure terminates a real process tree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* registerPidCleanup(treeNames.map((name) => path.join(test.directory, `${name}.pid`)))
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("tree-defs-failure", {
          type: "local",
          command: [process.execPath, stdioFixture, "--tree", "--list-error"],
          environment: { MCP_LIFECYCLE_TREE_DIR: test.directory },
        })
        const pids = yield* readTree(test.directory)

        expect(statusName(result.status, "tree-defs-failure")).toBe("failed")
        yield* waitForTreeExit(pids)
      }),
    20_000,
  )

  it.instance(
    "disconnect terminates a real stdio process tree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* registerPidCleanup(treeNames.map((name) => path.join(test.directory, `${name}.pid`)))
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("tree-disconnect", {
          type: "local",
          command: [process.execPath, stdioFixture, "--tree"],
          environment: { MCP_LIFECYCLE_TREE_DIR: test.directory },
        })
        const pids = yield* readTree(test.directory)
        expect(statusName(result.status, "tree-disconnect")).toBe("connected")
        expect(yield* Effect.forEach(pids, processRunning)).toEqual([true, true, true])

        yield* mcp.disconnect("tree-disconnect")

        yield* waitForTreeExit(pids)
        expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, "grandchild.term")).exists())).toBe(true)
      }),
    20_000,
  )

  it.instance(
    "replacement terminates only the old stdio process tree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const nextPid = path.join(test.directory, "replacement.pid")
        yield* registerPidCleanup([...treeNames.map((name) => path.join(test.directory, `${name}.pid`)), nextPid])
        const mcp = yield* MCP.Service
        yield* mcp.add("tree-replacement", {
          type: "local",
          command: [process.execPath, stdioFixture, "--tree"],
          environment: { MCP_LIFECYCLE_TREE_DIR: test.directory },
        })
        const pids = yield* readTree(test.directory)

        const result = yield* mcp.add("tree-replacement", {
          type: "local",
          command: [process.execPath, stdioFixture],
          environment: { MCP_LIFECYCLE_PID_FILE: nextPid },
        })

        expect(statusName(result.status, "tree-replacement")).toBe("connected")
        yield* waitForTreeExit(pids)
        expect(Object.keys(yield* mcp.tools())).toEqual(["tree-replacement_current_directory"])
      }),
    20_000,
  )

  it.instance(
    "instance disposal terminates a real stdio process tree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* registerPidCleanup(treeNames.map((name) => path.join(test.directory, `${name}.pid`)))
        const mcp = yield* MCP.Service
        yield* mcp.add("tree-dispose", {
          type: "local",
          command: [process.execPath, stdioFixture, "--tree"],
          environment: { MCP_LIFECYCLE_TREE_DIR: test.directory },
        })
        const pids = yield* readTree(test.directory)

        yield* InstanceStore.Service.use((store) => store.disposeDirectory(test.directory))

        yield* waitForTreeExit(pids)
      }),
    20_000,
  )
}

it.instance("remote timeout aborts both real HTTP transport attempts", () =>
  Effect.gen(function* () {
    const server = yield* hangingLifecycleServer()
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("hanging-remote", remote(server.url, 100))

    expect(statusName(result.status, "hanging-remote")).toBe("failed")
    yield* pollWithTimeout(
      Effect.sync(() => (server.aborted() >= 2 ? server.aborted() : undefined)),
      "remote transport requests were not aborted",
    )
    expect(server.requests).toEqual(["POST", "GET"])
  }),
)

it.live("McpOAuthCallback.cancelPending rejects the pending callback", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => McpOAuthCallback.waitForCallback("abc123hexstate", "my-mcp-server")),
    (callback) =>
      Effect.gen(function* () {
        McpOAuthCallback.cancelPending("my-mcp-server")
        const exit = yield* Effect.tryPromise({
          try: () => callback,
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    () => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore),
  ),
)
