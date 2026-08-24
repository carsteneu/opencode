import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { APICallError, tool, type Tool } from "ai"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { LLMMessageTransform } from "@/session/llm/message-transform"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMError, LLMEvent, TimeoutReason } from "@opencode-ai/llm"
import { Snapshot } from "@/snapshot"
import { Plugin } from "../../src/plugin"
import { Config } from "@/config/config"
import { TestConfig } from "../fixture/config"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    reset: () => Effect.void,
    summarize: () => Effect.void,
    materialize: () => Effect.void,
    materializeSession: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    hydrate: (info) => Effect.succeed(info),
    hydrateMessages: (messages) => Effect.succeed([...messages]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string, timeout = 500) =>
  Effect.gen(function* () {
    const stop = Date.now() + timeout
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  Snapshot.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)

function llmLayer(stream: Stream.Stream<LLMEvent, unknown>) {
  return Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      stream: () => stream,
    }),
  )
}

const bufferedRounds = Array.from({ length: 1_024 }, (_, index) => ({
  reasoningA: `a${index};`,
  textA: `t${index}:`,
  reasoningB: `b${index};`,
  textB: `${index}|`,
}))
const reasoningAEndMetadata = { openai: { itemId: "reasoning-a-end" } }
const reasoningBDeltaMetadata = { openai: { itemId: "reasoning-b-delta" } }
const textEndMetadata = { openai: { itemId: "text-end" } }
const bufferedDeltas = bufferedRounds.flatMap((round, index) => [
  LLMEvent.reasoningDelta({ id: "reasoning-a", text: round.reasoningA }),
  LLMEvent.textDelta({ id: "text", text: round.textA }),
  LLMEvent.reasoningDelta({
    id: "reasoning-b",
    text: round.reasoningB,
    providerMetadata: index === bufferedRounds.length - 1 ? reasoningBDeltaMetadata : undefined,
  }),
  LLMEvent.textDelta({ id: "text", text: round.textB }),
])
const bufferedDeltaText = bufferedRounds.flatMap((round) => [
  round.reasoningA,
  round.textA,
  round.reasoningB,
  round.textB,
])
const bufferedReasoningA = bufferedRounds.map((round) => round.reasoningA).join("")
const bufferedReasoningB = bufferedRounds.map((round) => round.reasoningB).join("")
const bufferedText = bufferedRounds.flatMap((round) => [round.textA, round.textB]).join("")
const bufferedEvents = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.reasoningStart({ id: "reasoning-a", providerMetadata: { openai: { itemId: "reasoning-a-start" } } }),
  LLMEvent.reasoningStart({ id: "reasoning-b", providerMetadata: { openai: { itemId: "reasoning-b-start" } } }),
  LLMEvent.textStart({ id: "text", providerMetadata: { openai: { itemId: "text-start" } } }),
  ...bufferedDeltas,
  LLMEvent.reasoningEnd({ id: "reasoning-b" }),
  LLMEvent.textEnd({ id: "text", providerMetadata: textEndMetadata }),
  LLMEvent.reasoningEnd({ id: "reasoning-a", providerMetadata: reasoningAEndMetadata }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]
const bufferedEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, llmLayer(Stream.fromIterable(bufferedEvents))],
])
const itBuffered = testEffect(bufferedEnv)

const completedText: string[] = []
const textPlugin = Layer.mock(Plugin.Service)({
  trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
    if (name !== "experimental.text.complete") return Effect.succeed(output)
    return Effect.sync(() => {
      const value = output as Output & { text: string }
      completedText.push(value.text)
      value.text = `[plugin]${value.text}`
      return output
    })
  },
  list: () => Effect.succeed([]),
  init: () => Effect.void,
})
const pluginText = ["alpha", "-", "beta", "-", "gamma"]
const pluginEvents = [
  LLMEvent.textStart({ id: "plugin-text" }),
  ...pluginText.map((text) => LLMEvent.textDelta({ id: "plugin-text", text })),
  LLMEvent.textEnd({ id: "plugin-text", providerMetadata: textEndMetadata }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]
const pluginEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, llmLayer(Stream.fromIterable(pluginEvents))],
  [Plugin.node, textPlugin],
])
const itPlugin = testEffect(pluginEnv)

const pluginFailureEvents = Layer.effect(
  EventV2Bridge.Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    let failed = false
    const publish: EventV2.Interface["publish"] = (definition, data, options) => {
      if (failed || definition.type !== SessionV1.Event.PartUpdated.type) {
        return events.publish(definition, data, options)
      }
      const event = data as typeof SessionV1.Event.PartUpdated.data.Type
      if (event.part.type !== "text" || !event.part.text.startsWith("[plugin]")) {
        return events.publish(definition, data, options)
      }
      failed = true
        return Effect.die(new Error("plugin text publication failed"))
    }
    return EventV2Bridge.Service.of({ ...events, publish })
  }),
)
const pluginFailureEventNode = LayerNode.make({
  service: EventV2Bridge.Service,
  layer: pluginFailureEvents,
  deps: [EventV2.node],
})
let pluginFailureStreams = 0
const pluginFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () => {
      pluginFailureStreams += 1
      return Stream.fromIterable(pluginEvents)
    },
  }),
)
const pluginFailureEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, pluginFailureLLM],
  [Plugin.node, textPlugin],
  [EventV2Bridge.node, pluginFailureEventNode],
])
const itPluginFailure = testEffect(pluginFailureEnv)

const interruptedText = ["partial", " ", "text"]
const interruptedReasoning = ["partial", " ", "reasoning"]
const interruptEvents = [
  LLMEvent.reasoningStart({ id: "interrupt-reasoning" }),
  LLMEvent.reasoningDelta({ id: "interrupt-reasoning", text: interruptedReasoning[0] }),
  LLMEvent.textStart({ id: "interrupt-text" }),
  LLMEvent.textDelta({ id: "interrupt-text", text: interruptedText[0] }),
  LLMEvent.reasoningDelta({ id: "interrupt-reasoning", text: interruptedReasoning[1] }),
  LLMEvent.textDelta({ id: "interrupt-text", text: interruptedText[1] }),
  LLMEvent.reasoningDelta({ id: "interrupt-reasoning", text: interruptedReasoning[2] }),
  LLMEvent.textDelta({ id: "interrupt-text", text: interruptedText[2] }),
]
const interruptEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, llmLayer(Stream.concat(Stream.fromIterable(interruptEvents), Stream.never))],
])
const itInterrupt = testEffect(interruptEnv)

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "error", value: "provider boom" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const providerErrorEnv = LayerNode.compile(root, [...replacements, [LLM.node, providerErrorLLM]])
const itProviderError = testEffect(providerErrorEnv)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "think" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "ing" }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "par" }),
        LLMEvent.textDelta({ id: "text-1", text: "tial" }),
        LLMEvent.providerError({ message: "provider boom" }),
      ),
  }),
)
const fragmentFailureEnv = LayerNode.compile(root, [...replacements, [LLM.node, fragmentFailureLLM]])
const itFragmentFailure = testEffect(fragmentFailureEnv)

const bufferedOverflowLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) =>
      input.request?.bufferEvents
        ? Stream.make(
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "replay" }),
            LLMEvent.textDelta({ id: "replay", text: "discarded replay" }),
            LLMEvent.providerError({
              message: "context_length_exceeded: replay exceeded the context window",
              classification: "context-overflow",
            }),
          )
        : Stream.make(
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "legacy" }),
            LLMEvent.textDelta({ id: "legacy", text: "legacy summary" }),
            LLMEvent.textEnd({ id: "legacy" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ),
  }),
)
const bufferedOverflowEnv = LayerNode.compile(root, [...replacements, [LLM.node, bufferedOverflowLLM]])
const itBufferedOverflow = testEffect(bufferedOverflowEnv)

const replayMismatchLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) =>
      input.request?.bufferEvents
        ? Stream.concat(
            Stream.make(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.textStart({ id: "replay" }),
              LLMEvent.textDelta({ id: "replay", text: "discarded replay" }),
            ),
            Stream.fail(new LLMMessageTransform.ReplayMismatchError("deliberate replay mismatch")),
          )
        : Stream.make(
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "legacy" }),
            LLMEvent.textDelta({ id: "legacy", text: "legacy summary" }),
            LLMEvent.textEnd({ id: "legacy" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ),
  }),
)
const replayMismatchEnv = LayerNode.compile(root, [...replacements, [LLM.node, replayMismatchLLM]])
const itReplayMismatch = testEffect(replayMismatchEnv)

const firstToolInput = '{"content":"'
const bufferedToolInput = Array.from({ length: 1_024 }, () => "é")
const finalToolInput = "x".repeat(16 * 1024)
const authoritativeToolInput = { filePath: "README.md", content: "final" }
const toolInputProgressLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.concat(
        Stream.fromIterable([
          LLMEvent.toolInputStart({ id: "call-progress", name: "write" }),
          LLMEvent.toolInputDelta({ id: "call-progress", name: "write", text: firstToolInput }),
          ...bufferedToolInput.map((text) => LLMEvent.toolInputDelta({ id: "call-progress", name: "write", text })),
          LLMEvent.toolInputStart({ id: "call-ignored", name: "read" }),
          ...bufferedToolInput.map((text) => LLMEvent.toolInputDelta({ id: "call-ignored", name: "read", text })),
        ]),
        Stream.concat(
          Stream.fromEffect(Effect.sleep("550 millis")).pipe(
            Stream.flatMap(() =>
              Stream.make(LLMEvent.toolInputDelta({ id: "call-progress", name: "write", text: finalToolInput })),
            ),
          ),
          Stream.concat(
            Stream.fromEffect(Effect.sleep("500 millis")).pipe(
              Stream.flatMap(() =>
                Stream.make(
                  LLMEvent.toolInputEnd({ id: "call-progress", name: "write" }),
                  LLMEvent.toolCall({
                    id: "call-progress",
                    name: "write",
                    input: authoritativeToolInput,
                  }),
                ),
              ),
            ),
            Stream.never,
          ),
        ),
      ),
  }),
)
const toolInputProgressEnv = LayerNode.compile(root, [...replacements, [LLM.node, toolInputProgressLLM]])
const itToolInputProgress = testEffect(toolInputProgressEnv)

  const retrySafetyCalls = {
    beforeEvent: 0,
    timeoutBeforeEvent: 0,
    timeoutAfterEvent: 0,
    partial: 0,
    partialReasoning: 0,
    buffered: 0,
    finishedStep: 0,
    abort: 0,
    fallbackPrimary: 0,
    fallback: 0,
    explicitlyNonRetryable: 0,
    rewind: 0,
    keepTool: 0,
    window: 0,
    overflow: 0,
    hang: 0,
  }
  const retrySafetyInputs: string[] = []

function completedTextEvents(text: string) {
  return Stream.make(
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text" }),
    LLMEvent.textDelta({ id: "text", text }),
    LLMEvent.textEnd({ id: "text" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  )
}

function timeoutFailure(phase: "headers" | "chunk") {
  return new LLMError({
    module: "Transport",
    method: "stream",
    reason: new TimeoutReason({ message: "provider idle timeout", phase, timeoutMs: 50 }),
  })
}

const retrySafetyLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
      stream: (input) => {
        retrySafetyInputs.push(JSON.stringify(input.messages))
        const prompt = JSON.stringify(input.messages)
      if (prompt.includes("retry before semantic event")) {
        retrySafetyCalls.beforeEvent += 1
        if (retrySafetyCalls.beforeEvent === 1) {
          return Stream.make(LLMEvent.providerError({ message: "service unavailable before output" }))
        }
        return completedTextEvents("recovered")
      }
      if (prompt.includes("retry timeout before semantic event")) {
        retrySafetyCalls.timeoutBeforeEvent += 1
        if (retrySafetyCalls.timeoutBeforeEvent === 1) return Stream.fail(timeoutFailure("headers"))
        return completedTextEvents("timeout recovered")
      }
      if (prompt.includes("retry timeout after partial text")) {
        retrySafetyCalls.timeoutAfterEvent += 1
        if (retrySafetyCalls.timeoutAfterEvent > 1) return completedTextEvents("duplicate")
        return Stream.concat(
          Stream.make(
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "timeout-partial" }),
            LLMEvent.textDelta({ id: "timeout-partial", text: "timeout partial" }),
          ),
          Stream.fail(timeoutFailure("chunk")),
        )
      }
      if (prompt.includes("retry after partial text")) {
        retrySafetyCalls.partial += 1
        if (retrySafetyCalls.partial > 1) return completedTextEvents("duplicate")
        return Stream.make(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "partial" }),
          LLMEvent.textDelta({ id: "partial", text: "kept partial" }),
          LLMEvent.providerError({ message: "service unavailable after output" }),
        )
      }
      if (prompt.includes("retry after partial reasoning")) {
        retrySafetyCalls.partialReasoning += 1
        if (retrySafetyCalls.partialReasoning > 1) return completedTextEvents("duplicate")
        return Stream.make(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "partial-reasoning" }),
          LLMEvent.reasoningDelta({ id: "partial-reasoning", text: "kept reasoning" }),
          LLMEvent.providerError({ message: "service unavailable after reasoning" }),
        )
      }
      if (prompt.includes("retry buffered transport")) {
        retrySafetyCalls.buffered += 1
        if (retrySafetyCalls.buffered > 1) return completedTextEvents("buffered recovery")
        return Stream.concat(
          Stream.make(
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "buffered" }),
            LLMEvent.textDelta({ id: "buffered", text: "not committed" }),
          ),
          Stream.fail(timeoutFailure("chunk")),
        )
      }
      if (prompt.includes("retry after finished step")) {
        retrySafetyCalls.finishedStep += 1
        if (retrySafetyCalls.finishedStep > 1) return completedTextEvents("duplicate")
        return Stream.make(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.providerError({ message: "service unavailable after finished step" }),
        )
      }
      if (prompt.includes("abort retry backoff")) {
        retrySafetyCalls.abort += 1
        if (retrySafetyCalls.abort > 1) return completedTextEvents("late retry")
        return Stream.make(LLMEvent.providerError({ message: "service unavailable during abort test" }))
      }
      if (prompt.includes("retry fallback independently")) {
        if (input.request?.bufferEvents) {
          retrySafetyCalls.fallbackPrimary += 1
          input.request.retry?.disable()
          return Stream.fail(new LLMMessageTransform.ReplayMismatchError("primary replay mismatch"))
        }
        retrySafetyCalls.fallback += 1
        if (retrySafetyCalls.fallback === 1) {
          return Stream.make(LLMEvent.providerError({ message: "service unavailable before fallback output" }))
        }
        return completedTextEvents("fallback recovered")
      }
          if (prompt.includes("explicit non-retryable provider error")) {
            retrySafetyCalls.explicitlyNonRetryable += 1
            if (retrySafetyCalls.explicitlyNonRetryable > 1) return completedTextEvents("duplicate")
            return Stream.make(LLMEvent.providerError({ message: "service unavailable but final", retryable: false }))
          }
          if (prompt.includes("resume non-retryable on retry")) {
            if (retrySafetyCalls.explicitlyNonRetryable === 0) {
              retrySafetyCalls.explicitlyNonRetryable += 1
              return Stream.make(
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.textStart({ id: "nr-text" }),
                LLMEvent.textDelta({ id: "nr-text", text: "partial" }),
                LLMEvent.providerError({ message: "service unavailable" }),
              )
            }
            retrySafetyCalls.explicitlyNonRetryable += 1
            return Stream.concat(
              Stream.make(
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.textStart({ id: "nr-retry" }),
                LLMEvent.textDelta({ id: "nr-retry", text: "more" }),
              ),
              Stream.make(LLMEvent.providerError({ message: "still unavailable but final", retryable: false })),
            )
          }
        if (prompt.includes("resume rewind announced tool")) {
          retrySafetyCalls.rewind += 1
          if (retrySafetyCalls.rewind > 1) return completedTextEvents("continued after rewind")
          return Stream.make(
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "rewind-text" }),
            LLMEvent.textDelta({ id: "rewind-text", text: "announcing tool" }),
            LLMEvent.toolInputStart({ id: "call-rewind", name: "bash" }),
            LLMEvent.toolCall({ id: "call-rewind", name: "bash", input: { command: "ls" } }),
            LLMEvent.providerError({ message: "service unavailable" }),
          )
        }
        if (prompt.includes("resume keeps completed tool")) {
          retrySafetyCalls.keepTool += 1
          if (retrySafetyCalls.keepTool > 1) return completedTextEvents("continued after result")
          return Stream.make(
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "keep-text" }),
            LLMEvent.textDelta({ id: "keep-text", text: "checking" }),
            LLMEvent.textEnd({ id: "keep-text" }),
            LLMEvent.toolInputStart({ id: "call-keep", name: "bash" }),
            LLMEvent.toolCall({ id: "call-keep", name: "bash", input: { command: "ls" } }),
            LLMEvent.toolResult({ id: "call-keep", name: "bash", result: { type: "text", value: "ran" } }),
            LLMEvent.providerError({ message: "service unavailable" }),
          )
        }
        if (prompt.includes("resume window exhausted test")) {
          retrySafetyCalls.window += 1
          return Stream.make(
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "win-text" }),
            LLMEvent.textDelta({ id: "win-text", text: "partial" }),
            LLMEvent.providerError({ message: "service unavailable" }),
          )
        }
        if (prompt.includes("resume overflow during retry")) {
          retrySafetyCalls.overflow += 1
          if (retrySafetyCalls.overflow === 1) {
            return Stream.make(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.textStart({ id: "ovf-text" }),
              LLMEvent.textDelta({ id: "ovf-text", text: "partial" }),
              LLMEvent.providerError({ message: "service unavailable" }),
            )
          }
          return Stream.fail(
            new APICallError({
              message: "Provider rejected request with 413",
              url: "https://example.com/v1/chat/completions",
              requestBodyValues: {},
              statusCode: 413,
              isRetryable: false,
            }),
          )
        }
        if (prompt.includes("resume escape")) {
          retrySafetyCalls.hang += 1
          if (retrySafetyCalls.hang === 1) {
            return Stream.make(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.textStart({ id: "esc-text" }),
              LLMEvent.textDelta({ id: "esc-text", text: "partial" }),
              LLMEvent.providerError({ message: "service unavailable" }),
            )
          }
          return Stream.never
        }
        return Stream.fail(new Error(`Unexpected retry safety prompt: ${prompt}`))
    },
  }),
)
const retrySafetyEnv = LayerNode.compile(root, [...replacements, [LLM.node, retrySafetyLLM]])
const itRetrySafety = testEffect(retrySafetyEnv)

const snapshotCalls = { track: 0, patch: 0 }
let failSnapshotPatchOnce = false
const snapshotLayer = Layer.mock(Snapshot.Service)({
  init: () => Effect.void,
  cleanup: () => Effect.void,
  track: () =>
    Effect.sync(() => {
      snapshotCalls.track += 1
      return `snapshot-${snapshotCalls.track}`
    }),
  patch: (from, to) =>
    Effect.sync(() => {
      snapshotCalls.patch += 1
      if (failSnapshotPatchOnce) {
        failSnapshotPatchOnce = false
        throw new Error("snapshot patch publication failed")
      }
      return {
        hash: `${from}:${to}`,
        files: from === to ? [] : ["changed.ts"],
      }
    }),
  pinDiff: () => Effect.succeed(true),
  unpinDiff: () => Effect.void,
})
const snapshotEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, llmLayer(completedTextEvents("snapshot complete"))],
  [Snapshot.node, snapshotLayer],
])
const itSnapshot = testEffect(snapshotEnv)
const externalPluginEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, llmLayer(completedTextEvents("external plugin snapshot complete"))],
  [Snapshot.node, snapshotLayer],
  [
    Config.node,
    TestConfig.layer({
      get: () =>
        Effect.succeed({
          ...cfg,
          plugin_origins: [{ spec: "test-plugin", source: "/tmp/opencode.json", scope: "local" as const }],
        }),
    }),
  ],
  [
    Plugin.node,
    Layer.mock(Plugin.Service)({
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (_name, _input, output) => Effect.succeed(output),
    }),
  ],
])
const itExternalPlugin = testEffect(externalPluginEnv)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

  const runTurn = Effect.fn("test.runTurn")(function* (input: {
    dir: string
    prompt: string
    tools?: Record<string, Tool>
    request?: LLM.StreamInput["request"]
    fallbackRequest?: LLM.StreamInput["request"]
    resumeWindowMs?: number
    before?: (handle: SessionProcessor.Handle) => Effect.Effect<void>
  }) {
    const { processors, session, provider } = yield* boot()
    const chat = yield* session.create({})
    const parent = yield* user(chat.id, input.prompt)
    const msg = yield* assistant(chat.id, parent.id, path.resolve(input.dir))
    const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
    const handle = yield* processors.create({
      assistantMessage: msg,
      sessionID: chat.id,
      model: mdl,
      resumeWindowMs: input.resumeWindowMs,
    })
  if (input.before) yield* input.before(handle)
  const streamInput: LLM.StreamInput = {
    user: {
      id: parent.id,
      sessionID: chat.id,
      role: "user",
      time: parent.time,
      agent: parent.agent,
      model: { providerID: ref.providerID, modelID: ref.modelID },
    } satisfies SessionV1.User,
    sessionID: chat.id,
    model: mdl,
    agent: agent(),
    system: [],
    messages: [{ role: "user", content: input.prompt }],
    tools: input.tools ?? {},
    request: input.request,
  }
  const value = yield* handle.process(
    streamInput,
    input.fallbackRequest ? { fallback: { ...streamInput, request: input.fallbackRequest } } : undefined,
  )
  return { chat, handle, msg, parts: yield* MessageV2.parts(msg.id), value }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

itBuffered.live("session.processor buffers text and interleaved reasoning deltas without changing order", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        yield* Database.Service
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "buffer deltas")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const deltas: string[] = []
        const off = yield* events.listen((event) => {
          if (event.type !== MessageV2.Event.PartDelta.type) return Effect.void
          const data = event.data as typeof MessageV2.Event.PartDelta.data.Type
          if (data.sessionID === chat.id) deltas.push(data.delta)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "buffer deltas" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const reasoningA = reasoning.find((part) => part.text === bufferedReasoningA)
        const reasoningB = reasoning.find((part) => part.text === bufferedReasoningB)

        expect(result).toBe("continue")
        expect(deltas.join("\0")).toBe(bufferedDeltaText.join("\0"))
        expect(text?.text).toBe(bufferedText)
        expect(text?.metadata).toEqual(textEndMetadata)
        expect(reasoningA?.metadata).toEqual(reasoningAEndMetadata)
        expect(reasoningB?.metadata).toEqual(reasoningBDeltaMetadata)
        expect(parts.every((part) => !("chunks" in part))).toBe(true)
      }),
    { config: cfg },
  ),
)

itPlugin.live("session.processor materializes buffered text before the completion plugin", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        completedText.length = 0
        yield* Database.Service
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "plugin text")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "plugin text" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")
        const expected = pluginText.join("")

        expect(result).toBe("continue")
        expect(completedText).toEqual([expected])
        expect(text?.text).toBe(`[plugin]${expected}`)
        expect(text?.metadata).toEqual(textEndMetadata)
      }),
    { config: cfg },
  ),
)

itPluginFailure.live("session.processor cleanup retains transformed plugin text after publication failure", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        completedText.length = 0
        pluginFailureStreams = 0
        yield* Database.Service
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "plugin publication failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "plugin publication failure" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")
        const expected = pluginText.join("")

        expect(result).toBe("stop")
        expect(pluginFailureStreams).toBe(1)
        expect(completedText).toEqual([expected])
        expect(text?.text).toBe(`[plugin]${expected}`)
      }),
    { config: cfg },
  ),
)

itInterrupt.live("session.processor materializes buffered fragments during interrupt cleanup", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        yield* Database.Service
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const ready = yield* Deferred.make<void>()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt fragments")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        let received = 0
        const off = yield* events.listen((event) => {
          if (event.type !== MessageV2.Event.PartDelta.type) return Effect.void
          const data = event.data as typeof MessageV2.Event.PartDelta.data.Type
          if (data.sessionID !== chat.id) return Effect.void
          received++
          if (received !== interruptedText.length + interruptedReasoning.length) return Effect.void
          return Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt fragments" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* Deferred.await(ready).pipe(Effect.timeout("2 seconds"))
        yield* Fiber.interrupt(run)
        const exit = yield* Fiber.await(run)
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(text?.text).toBe(interruptedText.join(""))
        expect(reasoning?.text).toBe(interruptedReasoning.join(""))
      }),
    { config: cfg },
  ),
)

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry a reset before reasoning is committed", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry OpenAI-compatible midstream server errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(raw({ chunks: [{ error: { type: "server_error", code: "server_error", message: "xxx" } }] }))
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry midstream server error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry midstream server error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itRetrySafety.live("session.processor retries a retryable provider error before the first semantic event", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        retrySafetyCalls.beforeEvent = 0
        const result = yield* runTurn({ dir, prompt: "retry before semantic event" })

        expect(result.value).toBe("continue")
        expect(retrySafetyCalls.beforeEvent).toBe(2)
        expect(result.handle.message.error).toBeUndefined()
        expect(result.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["recovered"])
      }),
    { config: cfg },
  ),
)

itRetrySafety.live(
  "session.processor retries a provider header timeout before the first semantic event",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          retrySafetyCalls.timeoutBeforeEvent = 0
          const result = yield* runTurn({ dir, prompt: "retry timeout before semantic event" })

          expect(result.value).toBe("continue")
          expect(retrySafetyCalls.timeoutBeforeEvent).toBe(2)
          expect(result.handle.message.error).toBeUndefined()
          expect(result.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
            "timeout recovered",
          ])
        }),
      { config: cfg },
    ),
  10_000,
)

  itRetrySafety.live("session.processor resumes a provider chunk timeout after partial text", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          retrySafetyCalls.timeoutAfterEvent = 0
          const result = yield* runTurn({ dir, prompt: "retry timeout after partial text" })
          const text = result.parts.filter((part): part is SessionV1.TextPart => part.type === "text")

          expect(result.value).toBe("continue")
          expect(retrySafetyCalls.timeoutAfterEvent).toBe(2)
          expect(text.map((part) => part.text)).toEqual(["timeout partial", "duplicate"])
          expect(result.handle.message.error).toBeUndefined()
        }),
      { config: cfg },
    ),
  )

  itRetrySafety.live("session.processor resumes after a provider error following partial text", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          retrySafetyCalls.partial = 0
          const events = yield* EventV2Bridge.Service
          const retries: number[] = []
          const off = yield* events.listen((event) => {
            if (event.type !== SessionStatus.Event.Status.type) return Effect.void
            const data = event.data as typeof SessionStatus.Event.Status.data.Type
            if (data.status.type === "retry") retries.push(data.status.attempt)
            return Effect.void
          })
          const result = yield* runTurn({ dir, prompt: "retry after partial text" })
          yield* off
          const text = result.parts.filter((part): part is SessionV1.TextPart => part.type === "text")

          expect(result.value).toBe("continue")
          expect(retrySafetyCalls.partial).toBe(2)
          expect(retries).toEqual([2])
          expect(text.map((part) => part.text)).toEqual(["kept partial", "duplicate"])
          expect(result.handle.message.error).toBeUndefined()
        }),
      { config: cfg },
    ),
  )

  itRetrySafety.live("session.processor resumes after a provider error following committed reasoning", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          retrySafetyCalls.partialReasoning = 0
          const result = yield* runTurn({ dir, prompt: "retry after partial reasoning" })
          const reasoning = result.parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

          expect(result.value).toBe("continue")
          expect(retrySafetyCalls.partialReasoning).toBe(2)
          expect(reasoning.map((part) => part.text)).toEqual(["kept reasoning"])
          expect(result.parts.filter((part): part is SessionV1.TextPart => part.type === "text").map((part) => part.text)).toEqual([
            "duplicate",
          ])
          expect(result.handle.message.error).toBeUndefined()
        }),
      { config: cfg },
    ),
  )

itRetrySafety.live("session.processor retries buffered transport failure before uncommitted events are replayed", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        retrySafetyCalls.buffered = 0
        const result = yield* runTurn({
          dir,
          prompt: "retry buffered transport",
          request: { bufferEvents: true },
        })

        expect(result.value).toBe("continue")
        expect(retrySafetyCalls.buffered).toBe(2)
        expect(result.handle.message.error).toBeUndefined()
        expect(result.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
          "buffered recovery",
        ])
      }),
    { config: cfg },
  ),
)

itRetrySafety.live("session.processor gives fallback execution an independent retry barrier", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        retrySafetyCalls.fallbackPrimary = 0
        retrySafetyCalls.fallback = 0
        const result = yield* runTurn({
          dir,
          prompt: "retry fallback independently",
          request: { bufferEvents: true },
          fallbackRequest: {},
        })

        expect(result.value).toBe("continue")
        expect(retrySafetyCalls.fallbackPrimary).toBe(1)
        expect(retrySafetyCalls.fallback).toBe(2)
        expect(result.handle.message.error).toBeUndefined()
        expect(result.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
          "fallback recovered",
        ])
      }),
    { config: cfg },
  ),
)

itRetrySafety.live("session.processor cancellation during retry backoff prevents the next provider call", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        retrySafetyCalls.abort = 0
        const { processors, session, provider } = yield* boot()
        const status = yield* SessionStatus.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort retry backoff")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort retry backoff" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          status.get(chat.id).pipe(Effect.map((value) => (value.type === "retry" ? value : undefined))),
          "timed out waiting for retry backoff",
          1_000,
        )
        yield* Fiber.interrupt(run)
        yield* Effect.sleep("50 millis")

        expect(Exit.isFailure(yield* Fiber.await(run))).toBe(true)
        expect(retrySafetyCalls.abort).toBe(1)
        expect((yield* status.get(chat.id)).type).toBe("idle")
        expect(handle.message.error?.name).toBe("MessageAbortedError")
      }),
    { config: cfg },
  ),
)

  itRetrySafety.live("session.processor continues after a retryable failure trailing a completed step", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          retrySafetyCalls.finishedStep = 0
          const result = yield* runTurn({ dir, prompt: "retry after finished step" })

          expect(result.value).toBe("continue")
          expect(retrySafetyCalls.finishedStep).toBe(2)
          expect(result.handle.message.error).toBeUndefined()
          expect(result.parts.filter((part) => part.type === "step-start")).toHaveLength(2)
          expect(result.parts.filter((part) => part.type === "step-finish")).toHaveLength(2)
        }),
      { config: cfg },
    ),
  )

    itRetrySafety.live("session.processor honors an explicitly non-retryable provider error", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            retrySafetyCalls.explicitlyNonRetryable = 0
            const result = yield* runTurn({ dir, prompt: "explicit non-retryable provider error" })

            expect(result.value).toBe("stop")
            expect(retrySafetyCalls.explicitlyNonRetryable).toBe(1)
            expect(result.handle.message.error).toBeDefined()
            expect(result.parts.filter((part) => part.type === "text")).toHaveLength(0)
          }),
        { config: cfg },
      ),
    )

    itRetrySafety.live("session.processor ends the turn when a resume attempt reports a non-retryable provider error", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            retrySafetyCalls.explicitlyNonRetryable = 0
            const result = yield* runTurn({ dir, prompt: "resume non-retryable on retry" })

            expect(retrySafetyCalls.explicitlyNonRetryable).toBe(2)
            expect(result.value).toBe("stop")
            expect(result.handle.message.error).toBeDefined()
          }),
        { config: cfg },
      ),
    )


  itRetrySafety.live("session.processor rewinds an announced tool call on resume", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          retrySafetyCalls.rewind = 0
          retrySafetyInputs.length = 0
          const result = yield* runTurn({ dir, prompt: "resume rewind announced tool" })

          expect(result.value).toBe("continue")
          expect(retrySafetyCalls.rewind).toBe(2)
          expect(result.handle.message.error).toBeUndefined()
          const resume = retrySafetyInputs[1]!
          expect(resume).not.toContain("call-rewind")
          expect(resume).toContain("announcing tool")
          expect(resume).toContain("Continue from where it ends")
        }),
      { config: cfg },
    ),
  )

  itRetrySafety.live("session.processor keeps an executed tool result on resume", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          retrySafetyCalls.keepTool = 0
          retrySafetyInputs.length = 0
          const result = yield* runTurn({ dir, prompt: "resume keeps completed tool" })

          expect(result.value).toBe("continue")
          expect(retrySafetyCalls.keepTool).toBe(2)
          expect(result.handle.message.error).toBeUndefined()
          const resume = retrySafetyInputs[1]!
          expect(resume).toContain("call-keep")
          expect(resume).toContain("tool-result")
          expect(resume).toContain("ran")
        }),
      { config: cfg },
    ),
  )

  itRetrySafety.live("session.processor ends the turn when the resume window is exhausted", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          retrySafetyCalls.window = 0
          const result = yield* runTurn({ dir, prompt: "resume window exhausted test", resumeWindowMs: 120 })

          expect(result.value).toBe("stop")
          expect(retrySafetyCalls.window).toBeGreaterThanOrEqual(2)
          expect(result.handle.message.error).toBeDefined()
          expect(
            result.parts.some((part): part is SessionV1.TextPart => part.type === "text" && part.text === "partial"),
          ).toBe(true)
        }),
      { config: cfg },
    ),
  )

  itRetrySafety.live("session.processor requests compaction instead of resuming after a context overflow", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          retrySafetyCalls.overflow = 0
          const result = yield* runTurn({ dir, prompt: "resume overflow during retry" })

          expect(result.value).toBe("compact")
          expect(retrySafetyCalls.overflow).toBe(2)
        }),
      { config: cfg },
    ),
  )

  itRetrySafety.live("session.processor aborts immediately when cancelled during resume", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          retrySafetyCalls.hang = 0
          const { processors, session, provider } = yield* boot()
          const status = yield* SessionStatus.Service
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "resume escape")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
            resumeWindowMs: 300,
          })
          const run = yield* handle
            .process({
              user: {
                id: parent.id,
                sessionID: chat.id,
                role: "user",
                time: parent.time,
                agent: parent.agent,
                model: { providerID: ref.providerID, modelID: ref.modelID },
              } satisfies SessionV1.User,
              sessionID: chat.id,
              model: mdl,
              agent: agent(),
              system: [],
              messages: [{ role: "user", content: "resume escape" }],
              tools: {},
            })
            .pipe(Effect.forkChild)

          yield* waitFor(
            status.get(chat.id).pipe(Effect.map((value) => (value.type === "retry" ? value : undefined))),
            "timed out waiting for resume backoff",
            2_000,
          )
          yield* waitFor(
            Effect.sync(() => (retrySafetyCalls.hang >= 2 ? true : undefined)),
            "resume attempt never started",
            5_000,
          )
          yield* Effect.sleep("20 millis") // let the resume stream settle into hanging before interrupting
          yield* Fiber.interrupt(run)
          yield* Effect.sleep("50 millis")

          expect(Exit.isFailure(yield* Fiber.await(run))).toBe(true)
          expect(retrySafetyCalls.hang).toBe(2)
          expect((yield* status.get(chat.id)).type).toBe("idle")
        }),
      { config: cfg },
    ),
  )

itSnapshot.live("session.processor skips workspace snapshots for text-only and read-only turns", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        snapshotCalls.track = 0
        snapshotCalls.patch = 0

        const text = yield* runTurn({ dir, prompt: "text-only snapshot test" })
        const read = yield* runTurn({
          dir,
          prompt: "read-only snapshot test",
          before: (handle) => Effect.void.pipe(handle.executeTool(false)),
        })
        const lateTool = yield* Effect.exit(Effect.void.pipe(read.handle.executeTool(false)))

        expect(text.handle.message.error).toBeUndefined()
        expect(text.value).toBe("continue")
        expect(read.value).toBe("continue")
        expect(Exit.isFailure(lateTool) && Cause.hasInterruptsOnly(lateTool.cause)).toBe(true)
        expect(snapshotCalls).toEqual({ track: 0, patch: 0 })
        expect(
          [...text.parts, ...read.parts]
            .filter((part) => part.type === "step-start" || part.type === "step-finish")
            .every((part) => part.snapshot === undefined),
        ).toBe(true)
      }),
    { config: cfg },
  ),
)

itExternalPlugin.live("session.processor keeps an eager boundary for external plugin hooks", () =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      snapshotCalls.track = 0
      snapshotCalls.patch = 0

      const result = yield* runTurn({ dir, prompt: "external plugin snapshot test" })
      const start = result.parts.find((part): part is SessionV1.StepStartPart => part.type === "step-start")
      const finish = result.parts.find((part): part is SessionV1.StepFinishPart => part.type === "step-finish")

      expect(result.handle.message.error).toBeUndefined()
      expect(result.value).toBe("continue")
      expect(snapshotCalls).toEqual({ track: 2, patch: 1 })
      expect(start?.snapshot).toBe("snapshot-1")
      expect(finish?.snapshot).toBe("snapshot-2")
    }),
  ),
)

itSnapshot.live("session.processor captures one shared boundary before concurrent mutating tools", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        snapshotCalls.track = 0
        snapshotCalls.patch = 0

        const result = yield* runTurn({
          dir,
          prompt: "mutating snapshot test",
          before: (handle) => {
            const execute = handle.executeTool(true)
            return Effect.all(
              Array.from({ length: 32 }, () => Effect.void.pipe(execute)),
              {
                concurrency: "unbounded",
              },
            ).pipe(Effect.asVoid)
          },
        })
        const start = result.parts.find((part): part is SessionV1.StepStartPart => part.type === "step-start")
        const finish = result.parts.find((part): part is SessionV1.StepFinishPart => part.type === "step-finish")

        expect(result.handle.message.error).toBeUndefined()
        expect(result.value).toBe("continue")
        expect(snapshotCalls).toEqual({ track: 2, patch: 1 })
        expect(start?.snapshot).toBe("snapshot-1")
        expect(finish?.snapshot).toBe("snapshot-2")
        expect(result.handle.summarySnapshot).toBe("snapshot-1")
        expect(result.handle.nextSnapshot).toBe("snapshot-2")
      }),
    { config: cfg },
  ),
)

itSnapshot.live("session.processor waits for a mutating tool before capturing the step end", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        snapshotCalls.track = 0
        snapshotCalls.patch = 0
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const finished = yield* Deferred.make<void>()

        const run = yield* runTurn({
          dir,
          prompt: "delayed mutation snapshot test",
          before: (handle) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              handle.executeTool(true),
              Effect.forkChild,
              Effect.asVoid,
            ),
        }).pipe(
          Effect.tap(() => Deferred.succeed(finished, undefined)),
          Effect.forkChild,
        )

        yield* Deferred.await(started)
        yield* Effect.sleep("50 millis")
        expect(yield* Deferred.isDone(finished)).toBe(false)
        expect(snapshotCalls).toEqual({ track: 1, patch: 0 })

        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(run)
        expect(result.handle.message.error).toBeUndefined()
        expect(result.value).toBe("continue")
        expect(snapshotCalls).toEqual({ track: 2, patch: 1 })
      }),
    { config: cfg },
  ),
)

itSnapshot.live("session.processor retains a pending snapshot when step persistence fails", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        snapshotCalls.track = 0
        snapshotCalls.patch = 0
        failSnapshotPatchOnce = true

        const result = yield* runTurn({
          dir,
          prompt: "failed step snapshot test",
          before: (handle) => Effect.void.pipe(handle.executeTool(true)),
        })

        expect(result.value).toBe("stop")
        expect(result.handle.message.error).toBeDefined()
        expect(snapshotCalls).toEqual({ track: 3, patch: 2 })
        expect(result.parts.some((part) => part.type === "patch" && part.files.includes("changed.ts"))).toBe(true)
        expect(result.handle.summarySnapshot).toBe("snapshot-1")
        expect(result.handle.nextSnapshot).toBe("snapshot-3")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            failSnapshotPatchOnce = false
          }),
        ),
      ),
    { config: cfg },
  ),
)

it.live("session.processor closes retry before early AI SDK tool hooks and execution", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const marker = path.join(dir, "mutation-marker.txt")
        const calls = {
          inputStart: 0,
          inputDelta: 0,
          inputAvailable: 0,
          approval: 0,
          execute: 0,
          modelOutput: 0,
        }
        const receivers = {
          inputStart: [] as unknown[],
          inputDelta: [] as unknown[],
          inputAvailable: [] as unknown[],
          approval: [] as unknown[],
          execute: [] as unknown[],
          modelOutput: [] as unknown[],
        }
        yield* llm.push(reply().toolThenServerError("mutate", { value: "once" }))
        yield* llm.text("duplicate retry")

        const mutate = tool({
          description: "Mutate once",
          inputSchema: z.object({ value: z.string() }),
          onInputStart: function (this: unknown) {
            calls.inputStart += 1
            receivers.inputStart.push(this)
          },
          onInputDelta: function (this: unknown) {
            calls.inputDelta += 1
            receivers.inputDelta.push(this)
          },
          onInputAvailable: function (this: unknown) {
            calls.inputAvailable += 1
            receivers.inputAvailable.push(this)
          },
          needsApproval: function (this: unknown) {
            calls.approval += 1
            receivers.approval.push(this)
            return false
          },
          execute: async function (this: unknown) {
            calls.execute += 1
            receivers.execute.push(this)
            const file = Bun.file(marker)
            await Bun.write(marker, `${(await file.exists()) ? await file.text() : ""}once\n`)
            return { title: "mutated", output: "once", metadata: {} }
          },
          toModelOutput: function (this: unknown, { output }) {
            calls.modelOutput += 1
            receivers.modelOutput.push(this)
            return { type: "text" as const, value: output.output }
          },
        })

        const result = yield* runTurn({
          dir,
          prompt: "execute one mutating tool before provider failure",
          tools: { mutate },
        })

        expect(result.value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("once\n")
        expect(calls).toEqual({
          inputStart: 1,
          inputDelta: 1,
          inputAvailable: 1,
          approval: 1,
          execute: 1,
          modelOutput: 1,
        })
        expect(Object.values(receivers).every((items) => items.length === 1 && items[0] === mutate)).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor never retries requests containing provider tools even when local execution is blocked", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        let executed = 0
        yield* llm.error(503, { error: { message: "provider tool request unavailable" } })
        yield* llm.text("duplicate retry")

        const result = yield* runTurn({
          dir,
          prompt: "provider-defined server tool",
          request: { toolExecution: "blocked" },
          tools: {
            remote: tool({
              type: "provider",
              id: "test.remote",
              args: { mode: "server" },
              inputSchema: z.object({}),
              execute: async () => {
                executed += 1
                return { output: "remote" }
              },
            }),
          },
        })

        expect(result.value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(executed).toBe(0)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry network_error finish reasons", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            chunks: [
              {
                id: "chatcmpl-network-error",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "network_error" }],
              },
            ],
          }),
        )
        yield* llm.text("after retry")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry network error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry network error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after retry")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itToolInputProgress.live("session.processor effect tests throttle tool input progress without retaining content", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "large write")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const published: number[] = []
        let ignoredUpdates = 0
        const off = yield* events.listen((event) => {
          if (event.type !== MessageV2.Event.PartUpdated.type) return Effect.void
          const part = (event.data as typeof MessageV2.Event.PartUpdated.data.Type).part
          if (part.type !== "tool" || part.state.status !== "pending") return Effect.void
          if (part.callID === "call-ignored") {
            ignoredUpdates += 1
            return Effect.void
          }
          if (part.callID !== "call-progress") return Effect.void
          published.push(part.state.received ?? 0)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "large write" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* Effect.sleep("550 millis")
        const expected = Buffer.byteLength(firstToolInput + bufferedToolInput.join("") + finalToolInput, "utf8")
        const part = yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) =>
              parts.find(
                (item): item is SessionV1.ToolPart =>
                  item.type === "tool" && item.state.status === "pending" && item.state.received === expected,
              ),
            ),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for throttled tool input progress",
          2_000,
        )
        expect(part.state.status).toBe("pending")
        if (part.state.status !== "pending") return
        expect(part.state.raw).toBe("")
        expect(part.state.input).toEqual({})
        expect(published).toEqual([0, Buffer.byteLength(firstToolInput, "utf8"), expected])
        expect(ignoredUpdates).toBe(1)

        yield* Effect.sleep("100 millis")
        const running = yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) =>
              parts.find(
                (item): item is SessionV1.ToolPart =>
                  item.type === "tool" && item.callID === "call-progress" && item.state.status === "running",
              ),
            ),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for authoritative tool call input",
          2_000,
        )
        yield* off
        yield* Fiber.interrupt(run)

        expect(running.state.status).toBe("running")
        if (running.state.status !== "running") return
        expect(running.state.input).toEqual(authoritativeToolInput)
        expect("received" in running.state).toBe(false)
      }),
    { config: cfg },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests pin interrupted later step diff from the turn start", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()
        const snapshot = yield* Snapshot.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "two step interrupt")
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user" as const, content: "two step interrupt" }],
          tools: {},
        }

        yield* llm.text("first step complete")
        const firstMessage = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const first = yield* processors.create({
          assistantMessage: firstMessage,
          sessionID: chat.id,
          model: mdl,
        })
        yield* Effect.promise(() => Bun.write(path.join(dir, "first-step.txt"), "first step\n")).pipe(
          first.executeTool(true),
        )
        expect(yield* first.process(input)).toBe("continue")
        if (!first.nextSnapshot) throw new Error("Expected completed first-step snapshot")
        if (!first.summarySnapshot) throw new Error("Expected turn-start snapshot")
        const turnStart = first.summarySnapshot

        yield* llm.hang
        const secondMessage = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const second = yield* processors.create({
          assistantMessage: secondMessage,
          sessionID: chat.id,
          model: mdl,
          initialSnapshot: first.nextSnapshot,
          summarySnapshot: turnStart,
        })
        const run = yield* second.process(input).pipe(Effect.forkChild)

        yield* llm.wait(2)
        yield* waitFor(
          MessageV2.parts(secondMessage.id).pipe(
            Effect.map((parts) => parts.find((part) => part.type === "step-start")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for the later step to start",
          2_000,
        )
        const mutation = yield* Effect.promise(() =>
          Bun.write(path.join(dir, "interrupted-step.txt"), "interrupted step\n"),
        ).pipe(second.executeTool(true), Effect.forkChild)
        const updatedStart = yield* waitFor(
          MessageV2.parts(secondMessage.id).pipe(
            Effect.map((parts) =>
              parts.find((part): part is SessionV1.StepStartPart => part.type === "step-start" && !!part.snapshot),
            ),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for the mutating step snapshot",
          2_000,
        )
        expect(updatedStart.snapshot).toBe(first.nextSnapshot)
        yield* Fiber.join(mutation)
        yield* Fiber.interrupt(run)
        expect(Exit.isFailure(yield* Fiber.await(run))).toBe(true)

        if (!second.nextSnapshot) throw new Error("Expected interrupted-step end snapshot")
        const diff = yield* snapshot.diffPinned({
          sessionID: chat.id,
          messageID: parent.id,
          from: turnStart,
          to: second.nextSnapshot,
        })
        const files = new Map(diff?.map((item) => [item.file, item]))

        expect(second.summarySnapshot).toBe(turnStart)
        expect(files.get("first-step.txt")?.patch).toContain("+first step")
        expect(files.get("interrupted-step.txt")?.patch).toContain("+interrupted step")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(MessageV2.Event.Updated.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

itFragmentFailure.live("session.processor effect tests retain partial legacy parts without v2 events", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        expect(parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "partial" }),
            expect.objectContaining({ type: "reasoning", text: "thinking" }),
          ]),
        )
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(Session.Event.Error.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

itBufferedOverflow.live("session.processor discards buffered native overflow events before fallback", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "native overflow fallback")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        msg.summary = true
        msg.finish = undefined
        yield* session.updateMessage(msg)
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user" as const, content: "native overflow fallback" }],
          tools: {},
        } satisfies LLM.StreamInput

        expect(
          yield* handle.process(
            {
              ...input,
              request: { bufferEvents: true, silentOverflow: true },
            },
            { fallback: input },
          ),
        ).toBe("continue")
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "text" && part.text === "discarded replay")).toBe(false)
        expect(parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["legacy summary"])
        expect(seen).not.toContain(MessageV2.Event.PartRemoved.type)
        expect(seen).not.toContain(Session.Event.Error.type)
        expect(handle.message.error).toBeUndefined()
        expect(handle.message.time.completed).toBeDefined()
      }),
    { config: cfg },
  ),
)

itReplayMismatch.live("session.processor discards a typed replay mismatch before one clean fallback lifecycle", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "typed replay mismatch fallback")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        msg.summary = true
        msg.finish = undefined
        yield* session.updateMessage(msg)
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: Array<{ type: string; data: unknown }> = []
        const off = yield* events.listen((event) => {
          seen.push({ type: event.type, data: structuredClone(event.data) })
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user" as const, content: "typed replay mismatch fallback" }],
          tools: {},
        } satisfies LLM.StreamInput

        expect(
          yield* handle.process(
            {
              ...input,
              request: { bufferEvents: true },
            },
            { fallback: input },
          ),
        ).toBe("continue")
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const completed = seen.filter((event) => {
          if (event.type !== MessageV2.Event.Updated.type) return false
          const data = event.data as typeof SessionV1.Event.MessageUpdated.data.Type
          return data.info.id === msg.id && data.info.role === "assistant" && data.info.time.completed !== undefined
        })
        const failed = seen.filter((event) => {
          if (event.type !== MessageV2.Event.Updated.type) return false
          const data = event.data as typeof SessionV1.Event.MessageUpdated.data.Type
          return data.info.id === msg.id && data.info.role === "assistant" && data.info.error !== undefined
        })
        const removals = seen.filter((event) => event.type === MessageV2.Event.PartRemoved.type)
        const errors = seen.filter((event) => event.type === Session.Event.Error.type)
        const completedIndex = seen.findIndex((event) => completed.includes(event))
        const lastPartIndex = seen.findLastIndex((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type) {
            const data = event.data as typeof SessionV1.Event.PartUpdated.data.Type
            return data.part.messageID === msg.id
          }
          if (event.type !== MessageV2.Event.PartDelta.type) return false
          const data = event.data as typeof SessionV1.Event.PartDelta.data.Type
          return data.messageID === msg.id
        })
        expect(parts.some((part) => part.type === "text" && part.text === "discarded replay")).toBe(false)
        expect(parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["legacy summary"])
        expect(completed).toHaveLength(1)
        expect(completedIndex).toBeGreaterThan(lastPartIndex)
        expect(failed).toEqual([])
        expect(removals).toEqual([])
        expect(errors).toEqual([])
        expect(handle.message.error).toBeUndefined()
        expect(handle.message.time.completed).toBeDefined()
      }),
    { config: cfg },
  ),
)
