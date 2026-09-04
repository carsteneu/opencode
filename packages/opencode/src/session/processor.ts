import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Duration, Effect, Exit, Layer, Context, Scope, Schema, Semaphore } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { Resume } from "./resume"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { isContextOverflow, Usage, type LLMEvent } from "@opencode-ai/llm"

const DOOM_LOOP_THRESHOLD = 3
const TOOL_INPUT_PROGRESS_INTERVAL = 500
const TOOL_INPUT_PROGRESS_IDLE_INTERVAL = 2_000
const TOOL_INPUT_PROGRESS_BYTES = 16 * 1024
const TOOL_INPUT_PROGRESS_TOOLS = new Set(["write", "edit", "apply_patch"])
export type Result = "compact" | "stop" | "continue"

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly summarySnapshot?: string
  readonly nextSnapshot: string | undefined
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly executeTool: (
    mutatesWorkspace: boolean,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly process: (streamInput: LLM.StreamInput, options?: { fallback?: LLM.StreamInput }) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
  initialSnapshot?: string
  summarySnapshot?: string
  resumeWindowMs?: number
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

type ToolCallUpdate = (part: SessionV1.ToolPart) => SessionV1.ToolPart

type ToolInputProgress = {
  received: number
  published: number
  publishedAt: number
}

type BufferedPart<Part extends SessionV1.TextPart | SessionV1.ReasoningPart> = {
  part: Part
  chunks: string[]
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  pendingToolCallUpdates: Record<string, ToolCallUpdate[]>
  toolInputProgress: Record<string, ToolInputProgress>
  shouldBreak: boolean
  closing: boolean
  mutated: boolean
  completedSnapshot: string | undefined
  patchPublished: boolean
  snapshot: string | undefined
  summarySnapshot: string | undefined
  stepStart: SessionV1.StepStartPart | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: BufferedPart<SessionV1.TextPart> | undefined
  reasoningMap: Record<string, BufferedPart<SessionV1.ReasoningPart>>
  nextSnapshot: string | undefined
  silentOverflow: boolean
  silentToolError: boolean
  bufferEvents: boolean
  discardAttempt: boolean
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // External hooks can change files during message/system transforms without executing a tool.
      const externalPlugins = ((yield* config.get()).plugin_origins?.length ?? 0) > 0
      const initialSnapshot =
        input.assistantMessage.summary || !externalPlugins
          ? undefined
          : (input.initialSnapshot ?? (yield* snapshot.track()))
      const snapshotLock = Semaphore.makeUnsafe(1)
      const toolCallLock = Semaphore.makeUnsafe(1)
      let activeTools = 0
      let toolsIdle: Deferred.Deferred<void> | undefined
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        pendingToolCallUpdates: {},
        toolInputProgress: {},
        shouldBreak: false,
        closing: false,
        mutated: !input.assistantMessage.summary && externalPlugins,
        completedSnapshot: undefined,
        patchPublished: false,
        snapshot: initialSnapshot,
        summarySnapshot: input.assistantMessage.summary ? undefined : (input.summarySnapshot ?? initialSnapshot),
        stepStart: undefined,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
        nextSnapshot: input.assistantMessage.summary ? undefined : input.initialSnapshot,
        silentOverflow: false,
        silentToolError: false,
        bufferEvents: false,
        discardAttempt: false,
      }
      let aborted = false

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const releaseTool = snapshotLock.withPermits(1)(
        Effect.gen(function* () {
          activeTools -= 1
          if (activeTools > 0 || !toolsIdle) return
          const idle = toolsIdle
          toolsIdle = undefined
          yield* Deferred.succeed(idle, undefined).pipe(Effect.ignore)
        }),
      )

      // Register before the Effect bridge starts: native runtimes may emit step-finish while the
      // separately scheduled tool fiber is still running.
      const executeTool: Handle["executeTool"] = (mutatesWorkspace) => (effect) => {
        if (ctx.closing) return Effect.interrupt
        activeTools += 1
        toolsIdle ??= Deferred.makeUnsafe<void>()
        const track = !ctx.assistantMessage.summary && (mutatesWorkspace || externalPlugins)
        return Effect.gen(function* () {
          if (track) {
            yield* snapshotLock.withPermits(1)(
              Effect.gen(function* () {
                if (ctx.closing) return yield* Effect.interrupt
                if (ctx.mutated) return
                const started = ctx.nextSnapshot ?? (yield* snapshot.track())
                ctx.mutated = true
                ctx.completedSnapshot = undefined
                ctx.patchPublished = false
                ctx.snapshot = started
                ctx.summarySnapshot ??= started
                if (!started || !ctx.stepStart || ctx.stepStart.snapshot === started) return
                ctx.stepStart = { ...ctx.stepStart, snapshot: started }
                yield* session.updatePart(ctx.stepStart)
              }),
            )
          }
          return yield* effect
        }).pipe(Effect.ensuring(releaseTool))
      }

      const awaitTools = Effect.gen(function* () {
        while (toolsIdle) yield* Deferred.await(toolsIdle)
      })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        delete ctx.pendingToolCallUpdates[toolCallID]
        delete ctx.toolInputProgress[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          delete ctx.toolInputProgress[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: ToolCallUpdate,
      ) {
        return yield* toolCallLock.withPermits(1)(
          Effect.gen(function* () {
            if (!ctx.toolcalls[toolCallID]) {
              ctx.pendingToolCallUpdates[toolCallID] = [...(ctx.pendingToolCallUpdates[toolCallID] ?? []), update]
              return undefined
            }
            const match = yield* readToolCall(toolCallID)
            if (!match) return undefined
            const part = yield* session.updatePart(update(match.part))
            ctx.toolcalls[toolCallID] = {
              ...match.call,
              partID: part.id,
              messageID: part.messageID,
              sessionID: part.sessionID,
            }
            return part
          }),
        )
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            // Keep metadata streamed while running so failures retain progress detail (e.g. execute's child calls).
            metadata: match.part.state.metadata,
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        const current = ctx.reasoningMap[reasoningID]
        if (!current) return
        current.part.text = current.chunks.join("")
        current.part.time = { ...current.part.time, end: Date.now() }
        yield* session.updatePart({ ...current.part })
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        return yield* toolCallLock.withPermits(1)(
          Effect.gen(function* () {
            if (ctx.toolcalls[input.id] && !input.providerExecuted) return undefined
            const existing = yield* readToolCall(input.id)
            if (existing) {
              if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
              const part = yield* session.updatePart({
                ...existing.part,
                metadata: { ...existing.part.metadata, providerExecuted: true },
              })
              ctx.toolcalls[input.id] = {
                ...existing.call,
                partID: part.id,
                messageID: part.messageID,
                sessionID: part.sessionID,
              }
              return { call: ctx.toolcalls[input.id], part }
            }
            const pending: SessionV1.ToolPart = yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "tool",
              tool: input.name,
              callID: input.id,
              state: { status: "pending", input: {}, raw: "" },
              metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
            } satisfies SessionV1.ToolPart)
            ctx.toolcalls[input.id] = {
              done: yield* Deferred.make<void>(),
              partID: pending.id,
              messageID: pending.messageID,
              sessionID: pending.sessionID,
            }
            const updates = ctx.pendingToolCallUpdates[input.id]
            delete ctx.pendingToolCallUpdates[input.id]
            const part = updates?.length
              ? yield* session.updatePart(updates.reduce((current, update) => update(current), pending))
              : pending
            return { call: ctx.toolcalls[input.id], part }
          }),
        )
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              part: {
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "reasoning",
                text: "",
                time: { start: Date.now() },
                metadata: value.providerMetadata,
              },
              chunks: [],
            }
            yield* session.updatePart({ ...ctx.reasoningMap[value.id].part })
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            {
              const current = ctx.reasoningMap[value.id]
              if (!current) return
              current.chunks.push(value.text)
              if (value.providerMetadata) current.part.metadata = value.providerMetadata
              yield* session.updatePartDelta({
                sessionID: current.part.sessionID,
                messageID: current.part.messageID,
                partID: current.part.id,
                field: "text",
                delta: value.text,
              })
            }
            return

          case "reasoning-end": {
            const current = ctx.reasoningMap[value.id]
            if (value.providerMetadata && current) current.part.metadata = value.providerMetadata
            yield* finishReasoning(value.id)
            return
          }

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            delete ctx.toolInputProgress[value.id]
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            if (!ctx.toolcalls[value.id]) yield* ensureToolCall(value)
            if (!value.text || !TOOL_INPUT_PROGRESS_TOOLS.has(value.name)) return
            {
              const progress = ctx.toolInputProgress[value.id] ?? { received: 0, published: 0, publishedAt: 0 }
              ctx.toolInputProgress[value.id] ??= progress
              progress.received += Buffer.byteLength(value.text, "utf8")
              const now = Date.now()
              const elapsed = now - progress.publishedAt
              const growth = progress.received - progress.published
              if (
                progress.publishedAt &&
                (elapsed < TOOL_INPUT_PROGRESS_INTERVAL ||
                  (elapsed < TOOL_INPUT_PROGRESS_IDLE_INTERVAL && growth < TOOL_INPUT_PROGRESS_BYTES))
              ) {
                return
              }
              progress.published = progress.received
              progress.publishedAt = now
              yield* updateToolCall(value.id, (match) => {
                if (match.state.status !== "pending") return match
                return { ...match, state: { ...match.state, received: progress.received } }
              })
            }
            return

          case "tool-input-end": {
            yield* ensureToolCall(value)
            delete ctx.toolInputProgress[value.id]
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            delete ctx.toolInputProgress[value.id]
            const input = isRecord(value.input) ? value.input : { value: value.input }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            yield* snapshotLock.withPermits(1)(
              Effect.gen(function* () {
                ctx.stepStart = {
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  snapshot: ctx.snapshot ?? ctx.nextSnapshot,
                  type: "step-start",
                }
                yield* session.updatePart(ctx.stepStart)
              }),
            )
            return

          case "step-finish": {
            yield* awaitTools
            const snapshots = yield* snapshotLock.withPermits(1)(
              Effect.gen(function* () {
                const started = ctx.snapshot
                const mutated = ctx.mutated
                const completed = mutated ? yield* snapshot.track() : ctx.nextSnapshot
                if (mutated) {
                  ctx.completedSnapshot = completed
                  ctx.patchPublished = false
                }
                return { started, completed, mutated }
              }),
            )
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            // Anthropic reports thinking blocks it removed before the model saw the
            // prompt. Prefix mismatches mean opencode changed history behind a signed
            // block; log them so the churn can be tracked down.
            const dropped = isRecord(value.providerMetadata?.anthropic)
              ? value.providerMetadata.anthropic.inputTransformations
              : undefined
            if (Array.isArray(dropped) && dropped.length > 0) {
              yield* Effect.logWarning("thinking blocks dropped by provider", {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                model: ctx.model.id,
                transformations: JSON.stringify(dropped),
              })
            }
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: snapshots.completed,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            const patch =
              snapshots.started && snapshots.completed && snapshots.started !== snapshots.completed
                ? yield* snapshot.patch(snapshots.started, snapshots.completed)
                : undefined
            if (patch?.files.length) {
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            if (snapshots.mutated) {
              yield* snapshotLock.withPermits(1)(
                Effect.sync(() => {
                  if (ctx.snapshot === snapshots.started && ctx.completedSnapshot === snapshots.completed) {
                    ctx.patchPublished = true
                  }
                }),
              )
            }
            if (!ctx.assistantMessage.summary) {
              if (patch?.files.length) {
                yield* summary
                  .summarize({
                    sessionID: ctx.sessionID,
                    messageID: ctx.assistantMessage.parentID,
                  })
                  .pipe(Effect.ignore)
              }
              if (isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })) {
                ctx.needsCompaction = true
              }
            }
            yield* snapshotLock.withPermits(1)(
              Effect.gen(function* () {
                if (
                  snapshots.mutated &&
                  (ctx.snapshot !== snapshots.started || ctx.completedSnapshot !== snapshots.completed)
                ) {
                  return yield* Effect.die(new Error("Workspace snapshot state changed while finishing a step"))
                }
                ctx.nextSnapshot = snapshots.completed
                ctx.mutated = false
                ctx.completedSnapshot = undefined
                ctx.patchPublished = false
                ctx.snapshot = undefined
                ctx.stepStart = undefined
              }),
            )
            return
          }

          case "text-start":
            ctx.currentText = {
              part: {
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "text",
                text: "",
                time: { start: Date.now() },
                metadata: value.providerMetadata,
              },
              chunks: [],
            }
            yield* session.updatePart({ ...ctx.currentText.part })
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.chunks.push(value.text)
            if (value.providerMetadata) ctx.currentText.part.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.part.sessionID,
              messageID: ctx.currentText.part.messageID,
              partID: ctx.currentText.part.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            ctx.currentText.part.text = ctx.currentText.chunks.join("")
            ctx.currentText.chunks = [ctx.currentText.part.text]
            ctx.currentText.part.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.part.id,
              },
              { text: ctx.currentText.part.text },
            )).text
            ctx.currentText.chunks = [ctx.currentText.part.text]
            {
              const end = Date.now()
              ctx.currentText.part.time = { start: ctx.currentText.part.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.part.metadata = value.providerMetadata
            yield* session.updatePart({ ...ctx.currentText.part })
            ctx.currentText = undefined
            return

          case "finish":
            return
        }
      })

        // Commits buffered text/reasoning deltas as parts. Shared by cleanup
        // (final materialization) and the resume loop (before building the next
        // resume request so partial content becomes history).
        const flushBufferedContent = Effect.fn("SessionProcessor.flushBufferedContent")(function* () {
          if (ctx.currentText) {
            const end = Date.now()
            ctx.currentText.part.text = ctx.currentText.chunks.join("")
            ctx.currentText.part.time = { start: ctx.currentText.part.time?.start ?? end, end }
            yield* session.updatePart({ ...ctx.currentText.part })
            ctx.currentText = undefined
          }

          for (const current of Object.values(ctx.reasoningMap)) {
            const end = Date.now()
            current.part.text = current.chunks.join("")
            yield* session.updatePart({
              ...current.part,
              time: { start: current.part.time.start ?? end, end },
            })
          }
          ctx.reasoningMap = {}
        })

        const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        yield* snapshotLock.withPermits(1)(
          Effect.sync(() => {
            ctx.closing = true
          }),
        )
        yield* awaitTools.pipe(
          Effect.timeout("5 seconds"),
          Effect.catchTag("TimeoutError", () =>
            Effect.logWarning("timed out waiting for active tools before snapshot cleanup", {
              active: activeTools,
              sessionID: ctx.sessionID,
              messageID: ctx.assistantMessage.id,
            }),
          ),
        )
        const snapshots = yield* snapshotLock.withPermits(1)(
          Effect.gen(function* () {
            if (ctx.assistantMessage.summary || !ctx.mutated) return
            const started = ctx.snapshot
            const completed = yield* snapshot.track()
            const patchPublished = ctx.patchPublished && ctx.completedSnapshot === completed
            if (completed) ctx.nextSnapshot = completed
            ctx.mutated = false
            ctx.completedSnapshot = undefined
            ctx.patchPublished = false
            ctx.snapshot = undefined
            ctx.stepStart = undefined
            return { started, completed, patchPublished }
          }),
        )
        const patch =
          !snapshots?.patchPublished &&
          snapshots?.started &&
          snapshots.completed &&
          snapshots.started !== snapshots.completed
            ? yield* snapshot.patch(snapshots.started, snapshots.completed)
            : undefined
        if (patch?.files.length) {
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: ctx.assistantMessage.id,
            sessionID: ctx.sessionID,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          })
        }
        if (snapshots?.completed && ctx.summarySnapshot && ctx.summarySnapshot !== snapshots.completed) {
          yield* snapshot.pinDiff({
            sessionID: ctx.sessionID,
            messageID: ctx.assistantMessage.parentID,
            from: ctx.summarySnapshot,
            to: snapshots.completed,
          })
        }

          yield* flushBufferedContent()

          yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.pendingToolCallUpdates = {}
        ctx.toolInputProgress = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        const silentReplayMismatch = ctx.bufferEvents && LLM.isReplayMismatch(e)
        const silentToolError =
          ctx.silentToolError &&
          e instanceof Error &&
          e.message.startsWith("Tool call not allowed while generating summary:")
        const error = parse(e)
        const silentOverflow = ctx.silentOverflow && SessionV1.ContextOverflowError.isInstance(error)
        if (!silentReplayMismatch && !silentToolError && !silentOverflow)
          yield* Effect.logError("process", {
            "session.id": input.sessionID,
            messageID: input.assistantMessage.id,
            error: errorMessage(e),
            stack: e instanceof Error ? e.stack : undefined,
          })
        if (silentReplayMismatch) {
          ctx.assistantMessage.error = error
          ctx.discardAttempt = true
          return
        }
        if (silentToolError) {
          ctx.assistantMessage.error = error
          ctx.discardAttempt = ctx.bufferEvents
          return
        }
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          ctx.discardAttempt = ctx.bufferEvents && silentOverflow
          if (!silentOverflow) yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const attempt = Effect.fn("SessionProcessor.attempt")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.silentOverflow = streamInput.request?.silentOverflow === true
        ctx.silentToolError = streamInput.request?.silentToolError === true
        ctx.bufferEvents = streamInput.request?.bufferEvents === true
        ctx.discardAttempt = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
          const retry = { safe: true }
          let outputProduced = false
          let resumeBlocked = false
          const disableRetry = () => {
            retry.safe = false
            if (!outputProduced) resumeBlocked = true
          }

          const runCore = (runInput: LLM.StreamInput) =>
            Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            yield* status.set(ctx.sessionID, { type: "busy" })
              const stream = llm.stream({
                ...runInput,
                request: {
                  ...runInput.request,
                  retry: { disable: disableRetry },
                },
              })
            const source = ctx.bufferEvents
              ? yield* Effect.gen(function* () {
                  const buffered = [...(yield* Stream.runCollect(stream))]
                  const overflow = buffered.find(
                    (event) =>
                      event.type === "provider-error" &&
                      (event.classification === "context-overflow" || isContextOverflow(event.message)),
                  )
                  if (overflow) {
                    ctx.needsCompaction = true
                    ctx.discardAttempt = true
                    return Stream.empty
                  }
                  const tool = buffered.find((event) => event.type.startsWith("tool-") && "name" in event)
                  if (ctx.assistantMessage.summary && tool && "name" in tool) {
                    throw new Error(`Tool call not allowed while generating summary: ${tool.name}`)
                  }
                  return Stream.fromIterable(buffered)
                })
              : stream

            yield* source.pipe(
                Stream.tap((event) =>
                  Effect.sync(() => {
                    if (event.type !== "provider-error" || event.retryable === false) {
                      outputProduced = true
                      retry.safe = false
                      if (event.type === "provider-error") resumeBlocked = true
                    }
                  }).pipe(Effect.andThen(handleEvent(event))),
                ),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
            )
          }).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
              Effect.retry(
                SessionRetry.policy({
                  provider: input.model.providerID,
                  parse,
                  canRetry: () => retry.safe,
                  set: (info) => {
                    return status.set(ctx.sessionID, {
                      type: "retry",
                      attempt: info.attempt,
                      message: info.message,
                      action: info.action,
                      next: info.next,
                    })
                  },
                }),
              ),
            )

            const resumable = (error: SessionRetry.Err) => {
              if (
                error === undefined ||
                !outputProduced ||
                resumeBlocked ||
                ctx.assistantMessage.summary ||
                ctx.bufferEvents ||
                streamInput.request?.replay
              )
                return false
              const retryable = SessionRetry.retryable(error, input.model.providerID)
              return retryable !== undefined && !retryable.action
            }

            const buildResumeInput = Effect.fnUntraced(function* () {
              const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
                Effect.provideService(Database.Service, database),
              )
              return {
                ...streamInput,
                messages: [...streamInput.messages, ...Resume.buildResumeMessages(parts)],
                request: {},
              }
            })

          const resumeLoop = Effect.fnUntraced(function* (error: SessionRetry.Err, cause: unknown) {
            const deadline = Date.now() + (input.resumeWindowMs ?? SessionRetry.RESUME_WINDOW_MS)
            let lastError = error
            let lastCause = cause
            let attempts = 0
            while (true) {
              attempts += 1
              const remaining = SessionRetry.resumeRemaining(deadline, Date.now())
              if (remaining <= 0) {
                yield* Effect.logWarning("resume window exhausted; ending turn", {
                  "session.id": ctx.sessionID,
                  messageID: input.assistantMessage.id,
                  attempts: attempts - 1,
                })
                return yield* halt(lastCause)
              }
              // The pristine run counts as attempt 1, so a resume attempt reports
              // attempts + 1. Every resume attempt backs off with the same policy
              // as the pristine path (Retry-After respected), capped to what the
              // resume window still allows.
                const wait = Math.max(
                  250,
                  Math.min(
                    SessionRetry.delay(
                      attempts,
                      SessionV1.APIError.isInstance(lastError) ? lastError : undefined,
                    ),
                    remaining,
                  ),
                )
              const message =
                SessionRetry.retryable(lastError, input.model.providerID)?.message ?? errorMessage(lastCause)
              yield* status.set(ctx.sessionID, {
                type: "retry",
                attempt: attempts + 1,
                message,
                next: Date.now() + wait,
              })
              if (wait > 0) yield* Effect.sleep(Duration.millis(wait))
              yield* flushBufferedContent()
              const resumeInput = yield* buildResumeInput()
              const exited = yield* runCore(resumeInput).pipe(Effect.exit)
              if (Exit.isSuccess(exited)) return
              if (Cause.hasInterruptsOnly(exited.cause)) return yield* Effect.interrupt
              const failure = Cause.squash(exited.cause)
              const parsed = parse(failure)
                const retryable = SessionRetry.retryable(parsed, input.model.providerID)
                if (!retryable || retryable.action || resumeBlocked || ctx.needsCompaction)
                  return yield* halt(failure)
              lastError = parsed
              lastCause = failure
            }
          })

          const failed = Effect.fnUntraced(function* (cause: unknown) {
            const error = parse(cause)
            if (resumable(error)) return yield* resumeLoop(error, cause)
            return yield* halt(cause)
          })

          return yield* Effect.gen(function* () {
            yield* runCore(streamInput).pipe(Effect.catch(failed))
            if (ctx.needsCompaction) return "compact"
            if (ctx.discardAttempt || ctx.blocked || ctx.assistantMessage.error) return "stop"
            return "continue"
          })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (
        streamInput: LLM.StreamInput,
        options?: { fallback?: LLM.StreamInput },
      ) {
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const run = (input: LLM.StreamInput) =>
              restore(attempt(input)).pipe(
                Effect.onInterrupt(() =>
                  Effect.gen(function* () {
                    aborted = true
                    if (!ctx.assistantMessage.error) {
                      yield* halt(new DOMException("Aborted", "AbortError"))
                    }
                  }),
                ),
              )
            const result = yield* run(streamInput)
            if (!ctx.discardAttempt || !options?.fallback) return result

            ctx.assistantMessage.error = undefined
            ctx.assistantMessage.finish = undefined
            ctx.assistantMessage.cost = 0
            ctx.assistantMessage.tokens = {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            }
            delete ctx.assistantMessage.time.completed
            ctx.blocked = false
            ctx.nextSnapshot = undefined
            return yield* run(options.fallback)
          }).pipe(Effect.ensuring(cleanup())),
        )
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        get summarySnapshot() {
          return ctx.summarySnapshot
        },
        get nextSnapshot() {
          return ctx.nextSnapshot
        },
        updateToolCall,
        completeToolCall,
        executeTool,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Config.node,
    Snapshot.node,
    Agent.node,
    LLM.node,
    Permission.node,
    Plugin.node,
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    Database.node,
  ],
})

export * as SessionProcessor from "./processor"
