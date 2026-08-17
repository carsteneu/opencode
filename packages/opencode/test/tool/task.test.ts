import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function waitForRemoval(jobs: BackgroundJob.Interface, id: string) {
  return pollWithTimeout(
    jobs.get(id).pipe(Effect.map((info) => (info ? undefined : true))),
    `background job ${id} was not consumed`,
    "1 second",
  )
}

function promptText(input: SessionPrompt.PromptInput) {
  const part = input.parts[0]
  if (part?.type !== "text") throw new Error("expected injected text part")
  return part.text
}

function largeTaskOutput(label: string) {
  return Array.from(
    { length: Truncate.MAX_LINES + 200 },
    (_, index) => `${label}-${index.toString().padStart(4, "0")}-${"x".repeat(40)}`,
  ).join("\n")
}

function savedOutputPath(text: string) {
  const prefix = "Full output saved to: "
  const start = text.indexOf(prefix)
  if (start === -1) throw new Error("truncation path missing from injected output")
  return text.slice(start + prefix.length).split("\n")[0]
}

function cleanupSavedOutput(path: string) {
  return Effect.addFinalizer(() => Effect.tryPromise(() => Bun.file(path).delete()).pipe(Effect.ignore))
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(result.output).toContain("resumed")
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
      expect(yield* jobs.get(child.id)).toBeUndefined()
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value.output).toContain("cancelled")
      expect(yield* jobs.get(input.sessionID)).toBeUndefined()
    }),
  )

  it.instance(
    "interrupting foreground execution cancels and consumes the task job",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const ready = yield* Deferred.make<SessionID>()
        const cancelled = yield* Deferred.make<SessionID>()
        const promptOps: TaskPromptOps = {
          cancel: (sessionID) => Deferred.succeed(cancelled, sessionID).pipe(Effect.asVoid),
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) => Deferred.succeed(ready, input.sessionID).pipe(Effect.andThen(Effect.never)),
        }
        const fiber = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.forkChild)

        const childID = yield* Deferred.await(ready)
        yield* Effect.yieldNow
        const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        expect(yield* Deferred.await(cancelled).pipe(Effect.timeout("1 second"))).toBe(childID)
        yield* Fiber.join(interruption)
        const exit = yield* Fiber.await(fiber)

        expect(Exit.hasInterrupts(exit)).toBe(true)
        expect(yield* jobs.get(childID)).toBeUndefined()
      }),
    10_000,
  )

  it.instance("reports failed foreground tasks and consumes their terminal jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const started = yield* Deferred.make<SessionID>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Deferred.succeed(started, input.sessionID).pipe(Effect.andThen(Effect.die(new Error("task exploded")))),
      }

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("task exploded")
      const childID = yield* Deferred.await(started)
      expect(yield* jobs.get(childID)).toBeUndefined()
    }),
  )

  it.instance("returns the old foreground result when the task id is restarted during cleanup", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const scope = yield* Scope.Scope
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "reused child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const release = yield* Deferred.make<void>()
      const watching = yield* Deferred.make<void>()
      const ready = yield* Deferred.make<void>()
      const replaced = yield* Deferred.make<void>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(watching, undefined).pipe(
              Effect.andThen(jobs.wait({ id: input.sessionID })),
              Effect.flatMap((result) =>
                result.info?.output === "old output"
                  ? jobs.start({ id: input.sessionID, type: "replacement", run: Effect.never })
                  : Effect.fail(new Error("replacement observer missed the old result")),
              ),
              Effect.tap(() => Deferred.succeed(replaced, undefined)),
              Effect.forkIn(scope, { startImmediately: true }),
            )
            yield* Deferred.await(watching)
            yield* Effect.yieldNow
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(release)
            return reply(input, "old output")
          }),
      }
      const execution = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(execution).pipe(Effect.timeout("1 second"))
      yield* Deferred.await(replaced).pipe(Effect.timeout("1 second"))

      expect(result.output).toContain("old output")
      expect(result.metadata.background).toBeUndefined()
      expect(yield* jobs.get(child.id)).toMatchObject({ status: "running", type: "replacement" })
      yield* jobs.cancel(child.id, { consume: true })
    }),
  )

  it.instance(
    "interrupting an old foreground task does not cancel its replacement",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const sessions = yield* Session.Service
        const scope = yield* Scope.Scope
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "interrupted old child" })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const release = yield* Deferred.make<void>()
        const watching = yield* Deferred.make<void>()
        const ready = yield* Deferred.make<void>()
        const interrupt = yield* Deferred.make<Effect.Effect<void>>()
        const replaced = yield* Deferred.make<BackgroundJob.Info>()
        const replacementCancelled = yield* Deferred.make<void>()
        const abort = new AbortController()
        const promptOps: TaskPromptOps = {
          ...stubOps(),
          cancel: (sessionID) =>
            jobs.get(sessionID).pipe(
              Effect.flatMap((current) =>
                current?.type === "replacement" ? Deferred.succeed(replacementCancelled, undefined) : Effect.void,
              ),
              Effect.asVoid,
            ),
          prompt: (input) =>
            Effect.gen(function* () {
              yield* Effect.gen(function* () {
                yield* Deferred.succeed(watching, undefined)
                const old = yield* jobs.wait({ id: input.sessionID })
                if (old.info?.output !== "old output") {
                  return yield* Effect.die(new Error("replacement observer missed the old result"))
                }
                const replacement = yield* jobs.start({
                  id: input.sessionID,
                  type: "replacement",
                  run: Effect.never,
                })
                yield* Deferred.succeed(replaced, replacement)
                abort.abort()
                const stop = yield* Deferred.await(interrupt)
                yield* stop
              }).pipe(Effect.forkIn(scope, { startImmediately: true }))
              yield* Deferred.await(watching)
              yield* Effect.yieldNow
              yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(release)
              return reply(input, "old output")
            }),
        }
        const execution = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              task_id: child.id,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: abort.signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.forkChild)

        yield* Deferred.succeed(interrupt, Fiber.interrupt(execution))
        yield* Deferred.await(ready)
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        const replacement = yield* Deferred.await(replaced).pipe(Effect.timeout("1 second"))
        const exit = yield* Fiber.await(execution).pipe(Effect.timeout("1 second"))

        expect(Exit.hasInterrupts(exit)).toBe(true)
        expect(yield* jobs.get(child.id)).toMatchObject({ status: "running", type: "replacement" })
        yield* Effect.sleep("20 millis")
        expect(yield* Deferred.isDone(replacementCancelled)).toBe(false)
        yield* jobs.cancel(child.id, { consume: true, expected: replacement })
      }),
    10_000,
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("promotes a running foreground task and bounds its large notification", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const output = largeTaskOutput("promoted-output")
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      const childReply = yield* Deferred.make<SessionV1.WithParts>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            const result = reply(input, output)
            yield* Deferred.succeed(childReply, result)
            return result
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      const waiting = yield* jobs.wait({ id: result.metadata.sessionId }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(done, undefined)
      expect((yield* Fiber.join(waiting)).info).toMatchObject({ status: "completed", output })
      const canonical = yield* Deferred.await(childReply)
      expect(canonical.parts.findLast((part) => part.type === "text")?.text).toBe(output)
      const notification = yield* Deferred.await(injected)
      const text = promptText(notification)
      const path = savedOutputPath(text)
      yield* cleanupSavedOutput(path)
      expect(notification.parts[0]).toMatchObject({ type: "text", synthetic: true })
      expect(text.startsWith(`<task id="${result.metadata.sessionId}" state="completed">\n`)).toBe(true)
      expect(text).toContain("<summary>Background task completed: inspect bug</summary>")
      expect(text).toContain("<task_result>\npromoted-output-0000-")
      expect(text.endsWith("</task_result>\n</task>")).toBe(true)
      expect(text).not.toContain(output.slice(output.lastIndexOf("\n") + 1))
      expect(text).toContain("bytes truncated")
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(Buffer.byteLength(output, "utf-8"))
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(Truncate.MAX_BYTES + 1024)
      expect(path.startsWith(Truncate.DIR)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path).text())).toBe(output)
      expect(yield* jobs.get(result.metadata.sessionId)).toBeUndefined()
      expect(runs).toBe(1)
    }),
  )

  it.instance("delivers immediate completion when promotion races foreground settlement", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Deferred.await(done)),
            Effect.as(reply(input, "raced done")),
          )
        },
      }

      const execution = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      yield* Effect.yieldNow
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      yield* jobs.promote(job.id).pipe(Effect.andThen(Deferred.succeed(done, undefined)))
      const result = yield* Fiber.join(execution)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      const notification = yield* Deferred.await(injected)
      expect(notification.parts[0]).toMatchObject({
        type: "text",
        synthetic: true,
      })
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("raced done")
      expect(yield* jobs.get(result.metadata.sessionId)).toBeUndefined()
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      const waiting = yield* jobs.wait({ id: started.metadata.sessionId }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      second.resolve()
      const waited = yield* Fiber.join(waiting)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
      expect(yield* jobs.get(started.metadata.sessionId)).toBeUndefined()
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const release = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Deferred.await(release).pipe(Effect.as(reply(input, "background done")))
        },
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waiting = yield* jobs.wait({ id: result.metadata.sessionId }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(waiting)).info).toMatchObject({ status: "completed", output: "background done" })
      const notification = yield* Deferred.await(injected)
      expect(notification.parts[0]).toMatchObject({
        type: "text",
        synthetic: true,
      })
      expect(promptText(notification)).toBe(
        [
          `<task id="${result.metadata.sessionId}" state="completed">`,
          "<summary>Background task completed: inspect bug</summary>",
          "<task_result>",
          "background done",
          "</task_result>",
          "</task>",
        ].join("\n"),
      )
      expect(yield* jobs.get(result.metadata.sessionId)).toBeUndefined()
    }),
  )

  background.instance("large background completion keeps canonical output and bounds the parent injection", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const output = largeTaskOutput("completed-output")
      const release = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      const childReply = yield* Deferred.make<SessionV1.WithParts>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            yield* Deferred.await(release)
            const result = reply(input, output)
            yield* Deferred.succeed(childReply, result)
            return result
          })
        },
      }

      expect(Buffer.byteLength(output, "utf-8")).toBeGreaterThan(Truncate.MAX_BYTES)
      const result = yield* def.execute(
        {
          description: "inspect large result",
          prompt: "produce a large result",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waiting = yield* jobs.wait({ id: result.metadata.sessionId }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      const waited = yield* Fiber.join(waiting)
      expect(waited.info).toMatchObject({ status: "completed", output })
      const canonical = yield* Deferred.await(childReply)
      expect(canonical.parts.findLast((part) => part.type === "text")?.text).toBe(output)

      const notification = yield* Deferred.await(injected)
      const text = promptText(notification)
      const path = savedOutputPath(text)
      yield* cleanupSavedOutput(path)
      expect(notification.parts[0]).toMatchObject({ type: "text", synthetic: true })
      expect(text.startsWith(`<task id="${result.metadata.sessionId}" state="completed">\n`)).toBe(true)
      expect(text).toContain("<summary>Background task completed: inspect large result</summary>")
      expect(text).toContain("<task_result>\ncompleted-output-0000-")
      expect(text.endsWith("</task_result>\n</task>")).toBe(true)
      expect(text).not.toContain(output.slice(output.lastIndexOf("\n") + 1))
      expect(text).toContain("bytes truncated")
      expect(text).toContain("Task tool")
      expect(text).toContain("explore agent")
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(Buffer.byteLength(output, "utf-8"))
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(Truncate.MAX_BYTES + 1024)
      expect(path.startsWith(Truncate.DIR)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path).text())).toBe(output)
      expect(yield* jobs.get(result.metadata.sessionId)).toBeUndefined()
    }),
  )

  background.instance("background task failures inject an error and consume the terminal job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const release = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Deferred.await(release).pipe(Effect.andThen(Effect.die(new Error("background exploded"))))
        },
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waiting = yield* jobs.wait({ id: result.metadata.sessionId }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(waiting)).info).toMatchObject({ status: "error", error: "background exploded" })
      const notification = yield* Deferred.await(injected)
      expect(notification.parts[0]).toMatchObject({
        type: "text",
        synthetic: true,
      })
      expect(promptText(notification)).toBe(
        [
          `<task id="${result.metadata.sessionId}" state="error">`,
          "<summary>Background task failed: inspect bug</summary>",
          "<task_error>",
          "background exploded",
          "</task_error>",
          "</task>",
        ].join("\n"),
      )
      expect(yield* jobs.get(result.metadata.sessionId)).toBeUndefined()
    }),
  )

  background.instance(
    "large background errors stay canonical and clean up when parent injection fails",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const error = largeTaskOutput("background-error")
        const release = yield* Deferred.make<void>()
        const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
        const promptOps: TaskPromptOps = {
          ...stubOps(),
          prompt: (input) => {
            if (input.sessionID === chat.id) {
              return Deferred.succeed(injected, input).pipe(
                Effect.andThen(Effect.die(new Error("parent injection failed"))),
              )
            }
            return Deferred.await(release).pipe(Effect.andThen(Effect.die(new Error(error))))
          },
        }

        expect(Buffer.byteLength(error, "utf-8")).toBeGreaterThan(Truncate.MAX_BYTES)
        const result = yield* def.execute(
          {
            description: "inspect large failure",
            prompt: "produce a large error",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const waiting = yield* jobs.wait({ id: result.metadata.sessionId }).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        const waited = yield* Fiber.join(waiting)
        expect(waited.info).toMatchObject({ status: "error", error })

        const notification = yield* Deferred.await(injected)
        const text = promptText(notification)
        const path = savedOutputPath(text)
        yield* cleanupSavedOutput(path)
        expect(notification.parts[0]).toMatchObject({ type: "text", synthetic: true })
        expect(text.startsWith(`<task id="${result.metadata.sessionId}" state="error">\n`)).toBe(true)
        expect(text).toContain("<summary>Background task failed: inspect large failure</summary>")
        expect(text).toContain("<task_error>\nbackground-error-0000-")
        expect(text.endsWith("</task_error>\n</task>")).toBe(true)
        expect(text).not.toContain(error.slice(error.lastIndexOf("\n") + 1))
        expect(text).toContain("bytes truncated")
        expect(text).toContain("Use Grep")
        expect(text).not.toContain("Task tool")
        expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(Buffer.byteLength(error, "utf-8"))
        expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(Truncate.MAX_BYTES + 1024)
        expect(path.startsWith(Truncate.DIR)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path).exists())).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path).text())).toBe(error)
        expect(yield* jobs.get(result.metadata.sessionId)).toBeUndefined()
      }),
    {
      config: {
        permission: {
          task: "deny",
        },
      },
    },
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const release = yield* Deferred.make<void>()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id
                  ? Effect.never
                  : Deferred.await(release).pipe(Effect.as(reply(input, "background done"))),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waiting = yield* jobs.wait({ id: result.metadata.sessionId }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(waiting)).info).toMatchObject({ status: "completed", output: "background done" })
      yield* waitForRemoval(jobs, result.metadata.sessionId)
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waiting = yield* jobs.wait({ id: result.metadata.sessionId }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* sessions.remove(chat.id)
      expect((yield* Fiber.join(waiting)).info?.status).toBe("cancelled")
      yield* waitForRemoval(jobs, result.metadata.sessionId)
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waiting = yield* jobs.wait({ id: result.metadata.sessionId }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* sessions.remove(result.metadata.sessionId)
      expect((yield* Fiber.join(waiting)).info?.status).toBe("cancelled")
      yield* waitForRemoval(jobs, result.metadata.sessionId)
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waiting = yield* jobs.wait({ id: result.metadata.sessionId }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* runState.cancel(chat.id)
      expect((yield* Fiber.join(waiting)).info?.status).toBe("cancelled")
      yield* waitForRemoval(jobs, result.metadata.sessionId)
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )
})
