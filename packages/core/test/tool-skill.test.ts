import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_skill_tool_test")

describe("SkillTool", () => {
  it.live("lists available skills, authorizes the selected name, and loads model-facing content", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "effect")
          const location = path.join(directory, "SKILL.md")
          const reference = path.join(directory, "reference.md")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(location, "unused"), fs.writeFile(reference, "reference")]),
          )

          const info: SkillV2.Info = {
            name: "effect",
            description: "Use Effect",
            location: AbsolutePath.make(location),
            content: "# Effect\n\nGuidance",
          }
          let current = [info]
          const assertions: PermissionV2.AssertInput[] = []
          let deny = false
          const permission = Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              assert: (input) =>
                Effect.sync(() => assertions.push(input)).pipe(
                  Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
                ),
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
            }),
          )
          const skills = Layer.succeed(
            SkillV2.Service,
            SkillV2.Service.of({
              transform: (_transform) => Effect.die("unused"),
              reload: () => Effect.die("unused"),
              sources: () => Effect.die("unused"),
              list: () => Effect.succeed(current),
            }),
          )
          const skillToolLayer = AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SkillTool.node]),
            [
              [PermissionV2.node, permission],
              [SkillV2.node, skills],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
              [Global.node, Global.layerWith({ data: tmp.path })],
            ],
          )

          return yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const definition = (yield* toolDefinitions(registry))[0]
            expect(definition).toMatchObject({
              name: "skill",
              description: SkillTool.description,
            })
            const outputSchema = definition?.outputSchema
            if (!outputSchema || typeof outputSchema !== "object" || !("properties" in outputSchema))
              return yield* Effect.die("missing skill output schema")
            const properties = outputSchema.properties
            if (!properties || typeof properties !== "object") return yield* Effect.die("missing schema properties")
            expect(Object.keys(properties)).toEqual(["name", "directory"])
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill", name: "skill", input: { name: "effect" } },
              }),
            ).toEqual({
              type: "text",
              value: SkillTool.toModelOutput(info, [reference]),
            })
            expect(SkillTool.toModelOutput(info, [reference])).toContain(`Base directory for this skill: ${directory}`)
            const settled = yield* settleTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-skill-overflow", name: "skill", input: { name: "effect" } },
            })
            expect(settled).toEqual({
              result: { type: "text", value: SkillTool.toModelOutput(info, [reference]) },
              output: {
                structured: { name: "effect", directory },
                content: [{ type: "text", text: SkillTool.toModelOutput(info, [reference]) }],
              },
            })
            expect(assertions).toMatchObject([
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
            ])
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-missing-skill", name: "skill", input: { name: "missing" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill missing" })
            deny = true
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-denied-skill", name: "skill", input: { name: "effect" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill effect" })
            deny = false
            const flat = SkillV2.Info.make({
              name: "public",
              description: "Public guidance",
              location: AbsolutePath.make(path.join(tmp.path, "public.md")),
              content: "Public",
            })
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(flat.location, "public"),
                fs.writeFile(path.join(tmp.path, "secret.md"), "secret"),
              ]),
            )
            current = [flat]
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-flat-skill", name: "skill", input: { name: "public" } },
              }),
            ).toEqual({ type: "text", value: SkillTool.toModelOutput(flat, []) })

            const marker = "SKILL-LARGE-PAYLOAD"
            const tail = "SKILL-LARGE-TAIL"
            const largeDirectory = path.join(tmp.path, "large")
            const largeLocation = path.join(largeDirectory, "SKILL.md")
            const largeReference = path.join(largeDirectory, "reference.md")
            const large = SkillV2.Info.make({
              name: "large",
              description: "Large guidance",
              location: AbsolutePath.make(largeLocation),
              content: `${marker}\n${"x".repeat(512 * 1024)}\n${tail}`,
            })
            yield* Effect.promise(() => fs.mkdir(largeDirectory, { recursive: true }))
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(largeLocation, large.content),
                fs.writeFile(largeReference, "large reference"),
              ]),
            )
            current = [large]
            const full = SkillTool.toModelOutput(large, [largeReference])
            expect(Buffer.byteLength(full)).toBeGreaterThan(ToolOutputStore.MAX_BYTES)
            const largeSettled = yield* settleTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-skill-large", name: "skill", input: { name: "large" } },
            })
            const output = largeSettled.output
            const outputPath = largeSettled.outputPaths?.[0]
            if (!output || output.content[0]?.type !== "text" || !outputPath)
              return yield* Effect.die("missing bounded skill output")
            const content = output.content[0]

            expect(output.structured).toEqual({ name: "large", directory: largeDirectory })
            expect(output.structured).not.toHaveProperty("output")
            expect(largeSettled.outputPaths).toHaveLength(1)
            expect(largeSettled.result).toEqual({ type: "text", value: content.text })
            expect(content.text).toContain(marker)
            expect(content.text).toContain(tail)
            expect(content.text).toContain("output truncated; full content saved to")
            expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
            expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe(full)

            const serialized = JSON.stringify(output)
            const legacy = JSON.stringify({
              ...output,
              structured: { name: "large", directory: largeDirectory, output: full },
            })
            expect(serialized.split(marker)).toHaveLength(2)
            expect(Buffer.byteLength(serialized)).toBeLessThan(Buffer.byteLength(legacy) / 5)
          }).pipe(Effect.provide(skillToolLayer))
        }),
      ),
    ),
  )
})
