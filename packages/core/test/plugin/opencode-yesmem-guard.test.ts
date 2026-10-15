import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  fakeContext,
  loadPlugin,
  mockDaemon,
  withSocket,
  yesmemEntry,
  type HookResult,
} from "./opencode-yesmem-fixture"

type GuardModule = {
  parseGuardConfig: (text: string) => { model?: string; providerTargets: Record<string, string> }
}

const RULES = `# Project rules

1. Never commit directly to main.
2. Run the test suite before pushing.

## Skill Catalog
- tdd: use before implementing.
`

/** Stand-in for the DeepSeek endpoint the guard posts to. */
async function mockGuard(decision: unknown) {
  const requests: Array<{ url: string | undefined; body: any }> = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      requests.push({ url: request.url, body: JSON.parse(body) })
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }], usage: {} }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function projectWithRules() {
  const directory = await mkdtemp(path.join(tmpdir(), "yesmem-project-"))
  await writeFile(path.join(directory, "RULES.md"), RULES)
  return directory
}

async function withEnv<T>(environment: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await body()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const blocked = (result: HookResult) => {
  expect(result.failed).toBe(true)
  expect(result.error?._tag).toBe("Tool.Error")
  return String(result.error.message)
}

describe("rule_guard", () => {
  test("rejects a write that the rule check blocks, with the rules of the project it runs in", async () => {
    const daemon = await mockDaemon(() => ({ result: {} }))
    const guard = await mockGuard({ decision: "BLOCK", violations: ["Rule 1: no direct commits to main"] })
    const project = await projectWithRules()
    try {
      await withEnv({ YESMEM_GUARD_URL: guard.url, YESMEM_GUARD_KEY: "test-key" }, () =>
        withSocket(daemon.socketPath, async () => {
          const recorder = fakeContext(project)
          await loadPlugin(recorder)

          const result = await recorder.fire("tool.execute.before", {
            tool: "write",
            sessionID: "ses_guard",
            input: { filePath: "src/feature.ts", content: "x" },
          })

          expect(blocked(result)).toContain("Rule 1: no direct commits to main")
          // The guard must be asked with this project's rules and the proposed call.
          const prompt = guard.requests[0]?.body?.messages?.[0]?.content ?? ""
          expect(prompt).toContain("Never commit directly to main")
          expect(guard.requests[0]?.body?.messages?.[1]?.content).toContain("write")
        }),
      )
    } finally {
      await guard.close()
      await daemon.close()
      await rm(project, { recursive: true, force: true })
    }
  })

  test("lets a call through when the check passes", async () => {
    const daemon = await mockDaemon(() => ({ result: {} }))
    const guard = await mockGuard({ decision: "PASS" })
    const project = await projectWithRules()
    try {
      await withEnv({ YESMEM_GUARD_URL: guard.url, YESMEM_GUARD_KEY: "test-key" }, () =>
        withSocket(daemon.socketPath, async () => {
          const recorder = fakeContext(project)
          await loadPlugin(recorder)

          const result = await recorder.fire("tool.execute.before", {
            tool: "edit",
            sessionID: "ses_guard",
            input: { filePath: "src/feature.ts", oldString: "a", newString: "b" },
          })

          expect(result.failed).toBe(false)
          expect(guard.requests.length).toBe(1)
        }),
      )
    } finally {
      await guard.close()
      await daemon.close()
      await rm(project, { recursive: true, force: true })
    }
  })

  test("does not ask the guard about documentation targets", async () => {
    const daemon = await mockDaemon(() => ({ result: {} }))
    const guard = await mockGuard({ decision: "BLOCK", violations: ["Rule 1: should not fire here"] })
    const project = await projectWithRules()
    try {
      await withEnv({ YESMEM_GUARD_URL: guard.url, YESMEM_GUARD_KEY: "test-key" }, () =>
        withSocket(daemon.socketPath, async () => {
          const recorder = fakeContext(project)
          await loadPlugin(recorder)

          // Discriminating half: the same tool on a source path is checked.
          const source = await recorder.fire("tool.execute.before", {
            tool: "write",
            sessionID: "ses_guard",
            input: { filePath: "src/doc-check.ts", content: "x" },
          })
          expect(blocked(source)).toContain("should not fire here")
          expect(guard.requests.length).toBe(1)

          const docs = await recorder.fire("tool.execute.before", {
            tool: "write",
            sessionID: "ses_guard",
            input: { filePath: "docs/notes.md", content: "x" },
          })
          expect(docs.failed).toBe(false)
          expect(guard.requests.length).toBe(1)
        }),
      )
    } finally {
      await guard.close()
      await daemon.close()
      await rm(project, { recursive: true, force: true })
    }
  })

  test("injects the suggested skill into the tool result, but only for installed skills", async () => {
    const daemon = await mockDaemon(() => ({ result: {} }))
    const guard = await mockGuard({ decision: "SUGGEST", suggestion: "myskill" })
    const project = await projectWithRules()
    const skills = await mkdtemp(path.join(tmpdir(), "yesmem-skills-"))
    await mkdir(path.join(skills, "myskill"))
    await writeFile(path.join(skills, "myskill", "SKILL.md"), "# myskill")
    try {
      await withEnv(
        { YESMEM_GUARD_URL: guard.url, YESMEM_GUARD_KEY: "test-key", YESMEM_SKILL_ROOTS: skills },
        () =>
          withSocket(daemon.socketPath, async () => {
            const recorder = fakeContext(project)
            await loadPlugin(recorder)

            const before = await recorder.fire("tool.execute.before", {
              tool: "shell",
              sessionID: "ses_guard",
              id: "call_1",
              input: { command: "echo myskill" },
            })
            expect(before.failed).toBe(false)

            const after = await recorder.fire("tool.execute.after", {
              tool: "shell",
              sessionID: "ses_guard",
              id: "call_1",
              input: { command: "echo myskill" },
              status: "completed",
              result: { content: "hi" },
            })

            expect(after.failed).toBe(false)
            expect(String(after.event.result.content)).toContain("MANDATORY CHECK")
            expect(String(after.event.result.content)).toContain("myskill")
            expect(String(after.event.result.content)).toEndWith("hi")
          }),
      )
    } finally {
      await guard.close()
      await daemon.close()
      await rm(project, { recursive: true, force: true })
      await rm(skills, { recursive: true, force: true })
    }
  })

  test("drops suggestions for skills that are not installed", async () => {
    const daemon = await mockDaemon(() => ({ result: {} }))
    const ghost = `ghost-${process.pid}-${Date.now()}`
    const guard = await mockGuard({ decision: "SUGGEST", suggestion: ghost })
    const project = await projectWithRules()
    const skills = await mkdtemp(path.join(tmpdir(), "yesmem-skills-"))
    try {
      await withEnv(
        { YESMEM_GUARD_URL: guard.url, YESMEM_GUARD_KEY: "test-key", YESMEM_SKILL_ROOTS: skills },
        () =>
          withSocket(daemon.socketPath, async () => {
            const recorder = fakeContext(project)
            await loadPlugin(recorder)

            await recorder.fire("tool.execute.before", {
              tool: "shell",
              sessionID: "ses_guard",
              id: "call_2",
              input: { command: "echo ghost" },
            })
            const after = await recorder.fire("tool.execute.after", {
              tool: "shell",
              sessionID: "ses_guard",
              id: "call_2",
              input: { command: "echo ghost" },
              status: "completed",
              result: { content: "hi" },
            })

            expect(String(after.event.result.content)).toBe("hi")
          }),
      )
    } finally {
      await guard.close()
      await daemon.close()
      await rm(project, { recursive: true, force: true })
      await rm(skills, { recursive: true, force: true })
    }
  })
})

describe("rule_guard config scan", () => {
  test("reads the extraction model and provider targets without a YAML dependency", async () => {
    const module = (await import(yesmemEntry("rule_guard.ts"))) as GuardModule

    const config = module.parseGuardConfig(`# yesmem config
proxy:
  port: 9099
  provider_targets:
    privateTom: http://127.0.0.1:1234
    "quoted": https://example.test/
extraction:
  model: deepseek-v4-flash
  other: ignored
`)

    expect(config.model).toBe("deepseek-v4-flash")
    expect(config.providerTargets).toEqual({
      privateTom: "http://127.0.0.1:1234",
      quoted: "https://example.test/",
    })
  })

  test("returns nothing for a missing or unrelated document", async () => {
    const module = (await import(yesmemEntry("rule_guard.ts"))) as GuardModule
    expect(module.parseGuardConfig("")).toEqual({ providerTargets: {} })
    expect(module.parseGuardConfig("other:\n  key: value\n")).toEqual({ providerTargets: {} })
  })
})
