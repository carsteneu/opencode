import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { Command } from "effect/cli"
import { Commands } from "../src/commands/commands"
import { applyThemeOverride } from "../src/commands/handlers/default"

async function parseRoot(args: readonly string[]) {
  const received: (string | undefined)[] = []
  const command = Commands.spec.pipe(
    Command.withHandler((input) => Effect.sync(() => void received.push(Option.getOrUndefined(input.theme)))),
  )
  await Effect.runPromise(
    Command.runWith(command, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer)),
  )
  return received
}

test("the TUI entry accepts --theme <name>", async () => {
  expect(await parseRoot(["--theme", "dracula"])).toEqual(["dracula"])
})

test("the TUI entry starts without a theme override", async () => {
  expect(await parseRoot([])).toEqual([undefined])
})

test("--theme replaces an OPENCODE_THEME already present in the environment", () => {
  const env: Record<string, string | undefined> = { OPENCODE_THEME: "gruvbox" }
  applyThemeOverride("dracula", env)
  expect(env.OPENCODE_THEME).toBe("dracula")
})

test("without --theme the environment keeps its OPENCODE_THEME", () => {
  const env: Record<string, string | undefined> = { OPENCODE_THEME: "gruvbox" }
  applyThemeOverride(undefined, env)
  expect(env.OPENCODE_THEME).toBe("gruvbox")
})
