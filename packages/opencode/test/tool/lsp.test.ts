import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { LspTool } from "../../src/tool/lsp"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const workspaceSymbolQueries: string[] = []
const responses = { result: [] as LSP.Symbol[] }

afterEach(async () => {
  responses.result = []
  workspaceSymbolQueries.length = 0
  await disposeAllInstances()
})

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

const symbol = (name: string) =>
  ({
    name,
    kind: 12,
    location: {
      uri: "file:///test.ts",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
    },
  }) satisfies LSP.Symbol

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(true),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.sync(() => responses.result),
    definition: () => Effect.sync(() => responses.result),
    references: () => Effect.sync(() => responses.result),
    implementation: () => Effect.sync(() => responses.result),
    documentSymbol: () => Effect.sync(() => responses.result),
    workspaceSymbol: (query) =>
      Effect.sync(() => {
        workspaceSymbolQueries.push(query)
        return responses.result
      }),
    prepareCallHierarchy: () => Effect.sync(() => responses.result),
    incomingCalls: () => Effect.sync(() => responses.result),
    outgoingCalls: () => Effect.sync(() => responses.result),
  }),
)

const it = testEffect(
  LayerNode.compile(LayerNode.group([Agent.node, FSUtil.node, CrossSpawnSpawner.node, Truncate.node, LSP.node]), [
    [LSP.node, lsp],
  ]),
)

const init = Effect.fn("LspToolTest.init")(function* () {
  const info = yield* LspTool
  return yield* info.init()
})

const run = Effect.fn("LspToolTest.run")(function* (
  args: Tool.InferParameters<typeof LspTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const put = Effect.fn("LspToolTest.put")(function* (file: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, "export const x = 1\n")
})

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

describe("tool.lsp", () => {
  describe("permission metadata", () => {
    it.instance(
      "keeps cursor details for position-based operations",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          const positioned = operations.filter(
            (operation) => operation !== "documentSymbol" && operation !== "workspaceSymbol",
          )
          for (const operation of positioned) {
            const result = yield* run({ operation, filePath: file, line: 3, character: 7 }, next)
            expect(result.title).toBe(`${operation} test.ts:3:7`)
          }

          expect(items).toHaveLength(positioned.length)
          expect(items.map((item) => item.metadata)).toEqual(
            positioned.map((operation) => ({ operation, filePath: file, line: 3, character: 7 })),
          )
        }),
      { git: true },
    )

    it.instance(
      "omits cursor details for documentSymbol",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          const result = yield* run({ operation: "documentSymbol", filePath: file, line: 3, character: 7 }, next)
          const req = items.find((item) => item.permission === "lsp")

          expect(req).toBeDefined()
          expect(req!.metadata).toEqual({
            operation: "documentSymbol",
            filePath: file,
          })
          expect(result.title).toBe("documentSymbol test.ts")
        }),
      { git: true },
    )

    it.instance(
      "omits file and cursor details for workspaceSymbol",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          workspaceSymbolQueries.length = 0
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          const result = yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7 }, next)
          const req = items.find((item) => item.permission === "lsp")

          expect(req).toBeDefined()
          expect(req!.metadata).toEqual({
            operation: "workspaceSymbol",
          })
          expect(result.title).toBe("workspaceSymbol")
        }),
      { git: true },
    )

    it.instance(
      "passes workspaceSymbol query to LSP",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          workspaceSymbolQueries.length = 0
          const file = path.join(dir, "test.ts")
          yield* put(file)

          yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7, query: "TestSymbol" })
          yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7 })

          expect(workspaceSymbolQueries).toEqual(["TestSymbol", ""])
        }),
      { git: true },
    )
  })

  it.instance(
    "keeps empty and pretty JSON output for every operation without retaining the result in metadata",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* put(file)

        for (const operation of operations) {
          responses.result = []
          const empty = yield* run({ operation, filePath: file, line: 3, character: 7 })
          expect(empty.output).toBe(`No results found for ${operation}`)
          expect(empty.metadata).toEqual({ truncated: false })

          responses.result = [symbol(`symbol-${operation}`)]
          const found = yield* run({ operation, filePath: file, line: 3, character: 7 })
          expect(found.output).toBe(JSON.stringify(responses.result, null, 2))
          expect(found.metadata).toEqual({ truncated: false })
        }
      }),
    { git: true },
  )

  it.instance(
    "spills one complete large result while serializing its marker only once",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "test.ts")
        yield* put(file)
        const marker = "LSP-LARGE-RESULT-MARKER"
        responses.result = [symbol(marker), symbol("x".repeat(Truncate.MAX_BYTES * 2))]
        const full = JSON.stringify(responses.result, null, 2)

        const result = yield* run({ operation: "goToDefinition", filePath: file, line: 3, character: 7 })
        const outputPath = "outputPath" in result.metadata ? result.metadata.outputPath : undefined
        if (typeof outputPath !== "string") return yield* Effect.die("missing LSP output path")
        expect(result.metadata).toEqual({ truncated: true, outputPath })
        expect(result.metadata).not.toHaveProperty("result")
        expect(result.output).toContain(marker)
        expect(result.output).toContain("bytes truncated")
        expect(result.output).toContain(outputPath)
        const fs = yield* FSUtil.Service
        expect(yield* fs.readFileString(outputPath)).toBe(full)

        const serialized = JSON.stringify(result)
        const legacy = JSON.stringify({ ...result, metadata: { ...result.metadata, result: responses.result } })
        expect(serialized.split(marker)).toHaveLength(2)
        expect(Buffer.byteLength(serialized)).toBeLessThan(Buffer.byteLength(legacy) / 10)
      }),
    { git: true },
  )
})
