import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { Command } from "effect/cli"
import { Commands } from "../src/commands/commands"
import { launchArgs } from "../src/commands/handlers/default"

type Picked = {
  model: string | undefined
  agent: string | undefined
  fork: boolean
}

async function parseRoot(args: readonly string[]) {
  const received: Picked[] = []
  const command = Commands.spec.pipe(
    Command.withHandler((input) =>
      Effect.sync(() => {
        received.push({
          model: Option.getOrUndefined(input.model),
          agent: Option.getOrUndefined(input.agent),
          fork: input.fork,
        })
      }),
    ),
  )
  await Effect.runPromise(
    Command.runWith(command, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer)),
  )
  return received
}

test("the TUI entry accepts --model provider/model", async () => {
  expect(await parseRoot(["--model", "anthropic/claude-sonnet-4"])).toEqual([
    { model: "anthropic/claude-sonnet-4", agent: undefined, fork: false },
  ])
})

test("--model keeps the short alias from v1", async () => {
  expect((await parseRoot(["-m", "zai-coding-plan/glm-5.2"]))[0]?.model).toBe("zai-coding-plan/glm-5.2")
})

test("--agent and --fork parse beside a continued session", async () => {
  expect(await parseRoot(["--agent", "build", "--fork", "--continue"])).toEqual([
    { model: undefined, agent: "build", fork: true },
  ])
})

test("a bare invocation carries no model override", async () => {
  expect(await parseRoot([])).toEqual([{ model: undefined, agent: undefined, fork: false }])
})

test("the launch arguments pass model, agent, and fork to the TUI", () => {
  expect(
    launchArgs({
      continue: false,
      session: "ses_new",
      sessionExists: false,
      prompt: Option.none(),
      model: Option.some("anthropic/claude-sonnet-4"),
      agent: Option.some("build"),
      fork: true,
      auto: false,
    }),
  ).toEqual({
    continue: false,
    sessionID: undefined,
    newSessionID: "ses_new",
    prompt: undefined,
    model: "anthropic/claude-sonnet-4",
    agent: "build",
    fork: true,
    auto: false,
  })
})

test("a continued session keeps its ID and drops the model when none was given", () => {
  expect(
    launchArgs({
      continue: true,
      session: "ses_old",
      sessionExists: true,
      prompt: Option.none(),
      model: Option.none(),
      agent: Option.none(),
      fork: false,
      auto: true,
    }),
  ).toEqual({
    continue: true,
    sessionID: "ses_old",
    newSessionID: undefined,
    prompt: undefined,
    model: undefined,
    agent: undefined,
    fork: false,
    auto: true,
  })
})
