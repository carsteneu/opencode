import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { Host } from "@opencode/plugin/host"
import {
  fakeContext,
  loadPlugin,
  mockDaemon,
  withEnv,
  withSocket,
  yesmemEntry,
  type DaemonRequest,
} from "./opencode-yesmem-fixture"

type NudgeModule = {
  parseSkillCatalog: (content: string) => Array<{ skill: string; priority: string; triggers: string[] }>
  renderLedger: (plan: string) => string | null
}

const CATALOG = `# Skills

## Skill Catalog
- id: one
  skill: myskill
  priority: LOW
  triggers: ["tdd", "test first"]
- id: two
  skill: mustskill
  priority: MUST
  triggers: ["deploy"]
`

const daemonHandler = (request: DaemonRequest) => {
  if (request.method === "get_plan") return { result: { exists: true, status: "active", plan: "Goal: ship\nOpen: review" } }
  return { result: {} }
}

/** No active plan: the ledger stays quiet, so skill/idle assertions see only their own nudge. */
const quietDaemon = (request: DaemonRequest) =>
  request.method === "get_plan" ? { result: { exists: false } } : { result: {} }

const GENERATED_CATALOG = `## Skill Catalog
# Generated from bundled, Superpowers, and user skills.
rules:
  - id: 25
    skill: generated-must
    priority: MUST
    triggers: ["spawning parallel agents"]
  - id: 26
    skill: generated-low
    priority: LOW
    triggers: ["unrelated words"]
`

async function projectWithCatalog(catalog = CATALOG) {
  const directory = await mkdtemp(path.join(tmpdir(), "yesmem-nudge-"))
  await writeFile(path.join(directory, "RULES.md"), catalog)
  return directory
}

const userTurn = (id: string, text: string) => ({ id, role: "user", content: [{ type: "text", text }] })
const assistantTurn = (id: string, text: string) => ({ id, role: "assistant", content: [{ type: "text", text }] })

const textOf = (message: any) => String(message.content[0].text)

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("timed out waiting for the nudge to react")
}

/** Stand-in for the endpoint the semantic (stage 2) skill match posts to. */
async function mockModel(reply: string) {
  const requests: any[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      requests.push(JSON.parse(body))
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ choices: [{ message: { content: reply } }] }))
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

describe("skill_nudge catalog", () => {
  test("parses the skill catalog and orders MUST first", async () => {
    const module = (await Host.load(yesmemEntry("skill_nudge.ts"))) as NudgeModule
    const entries = module.parseSkillCatalog(CATALOG)

    expect(entries.map((entry) => entry.skill)).toEqual(["mustskill", "myskill"])
    expect(entries[1]?.triggers).toEqual(["tdd", "test first"])
  })

  test("parses the generated catalogue shape (nested under rules:)", async () => {
    const module = (await Host.load(yesmemEntry("skill_nudge.ts"))) as NudgeModule
    const entries = module.parseSkillCatalog(GENERATED_CATALOG)

    expect(entries.map((entry) => entry.skill)).toEqual(["generated-must", "generated-low"])
    expect(entries[0]?.triggers).toEqual(["spawning parallel agents"])
  })
})

describe("skill_nudge", () => {
  test("prepends the nudge when a trigger matches the user message", async () => {
    const daemon = await mockDaemon(quietDaemon)
    const project = await projectWithCatalog()
    const skills = await mkdtemp(path.join(tmpdir(), "yesmem-skills-"))
    await mkdir(path.join(skills, "mustskill"))
    await writeFile(path.join(skills, "mustskill", "SKILL.md"), "# mustskill")
    try {
      await withEnv({ YESMEM_SKILL_ROOTS: skills }, () =>
        withSocket(daemon.socketPath, async () => {
          const recorder = fakeContext(project)
          await loadPlugin(recorder)

          const messages = [userTurn("msg_1", "bitte zuerst deploy machen")]
          await recorder.fire("session.context", { sessionID: "ses_nudge", messages })

          expect(textOf(messages[0])).toStartWith("🧠 MANDATORY CHECK — activate mustskill")
          expect(textOf(messages[0])).toContain("bitte zuerst deploy machen")
        }),
      )
    } finally {
      await daemon.close()
      await rm(project, { recursive: true, force: true })
      await rm(skills, { recursive: true, force: true })
    }
  })

  test("does not nudge twice for the same message", async () => {
    const daemon = await mockDaemon(quietDaemon)
    const project = await projectWithCatalog()
    const skills = await mkdtemp(path.join(tmpdir(), "yesmem-skills-"))
    await mkdir(path.join(skills, "mustskill"))
    await writeFile(path.join(skills, "mustskill", "SKILL.md"), "# mustskill")
    try {
      await withEnv({ YESMEM_SKILL_ROOTS: skills }, () =>
        withSocket(daemon.socketPath, async () => {
          const recorder = fakeContext(project)
          await loadPlugin(recorder)

          const messages = [userTurn("msg_2", "bitte zuerst deploy machen")]
          await recorder.fire("session.context", { sessionID: "ses_nudge", messages })
          await recorder.fire("session.context", { sessionID: "ses_nudge", messages })

          expect(textOf(messages[0]).split("🧠 MANDATORY CHECK").length - 1).toBe(1)
        }),
      )
    } finally {
      await daemon.close()
      await rm(project, { recursive: true, force: true })
      await rm(skills, { recursive: true, force: true })
    }
  })

  test("skips a matched skill that is not installed and leaves the message alone", async () => {
    const daemon = await mockDaemon(quietDaemon)
    const project = await projectWithCatalog()
    const skills = await mkdtemp(path.join(tmpdir(), "yesmem-skills-"))
    try {
      await withEnv({ YESMEM_SKILL_ROOTS: skills }, () =>
        withSocket(daemon.socketPath, async () => {
          const recorder = fakeContext(project)
          await loadPlugin(recorder)

          const messages = [userTurn("msg_3", "bitte zuerst deploy machen")]
          await recorder.fire("session.context", { sessionID: "ses_nudge", messages })

          expect(textOf(messages[0])).toBe("bitte zuerst deploy machen")
        }),
      )
    } finally {
      await daemon.close()
      await rm(project, { recursive: true, force: true })
      await rm(skills, { recursive: true, force: true })
    }
  })

  test("asks the model off the critical path and reuses the cached answer later", async () => {
    const daemon = await mockDaemon(quietDaemon)
    const model = await mockModel("semantic")
    const project = await projectWithCatalog(
      `## Skill Catalog
- id: one
  skill: semantic
  priority: MUST
  triggers: ["xyzzy"]
`,
    )
    const skills = await mkdtemp(path.join(tmpdir(), "yesmem-skills-"))
    await mkdir(path.join(skills, "semantic"))
    await writeFile(path.join(skills, "semantic", "SKILL.md"), "# semantic")
    try {
      await withEnv(
        { YESMEM_SKILL_ROOTS: skills, YESMEM_GUARD_URL: model.url, YESMEM_GUARD_KEY: "test-key" },
        () =>
          withSocket(daemon.socketPath, async () => {
            const recorder = fakeContext(project)
            await loadPlugin(recorder)

            const first = [userTurn("msg_4", "bitte hilf mir dabei")]
            await recorder.fire("session.context", { sessionID: "ses_nudge", messages: first })

            // Stage 2 never nudges on the first sighting: the answer is only cached for later.
            expect(textOf(first[0])).toBe("bitte hilf mir dabei")
            await waitFor(() => model.requests.length > 0)
            expect(JSON.stringify(model.requests[0])).toContain("Skill Catalog")

            // A fresh plugin instance has an empty per-instance message memo, so the cached answer applies.
            await waitFor(async () => {
              const reloaded = fakeContext(project)
              await loadPlugin(reloaded)
              const later = [userTurn("msg_5", "bitte hilf mir dabei")]
              await reloaded.fire("session.context", { sessionID: "ses_nudge", messages: later })
              return textOf(later[0]).includes("activate semantic")
            })
          }),
      )
    } finally {
      await model.close()
      await daemon.close()
      await rm(project, { recursive: true, force: true })
      await rm(skills, { recursive: true, force: true })
    }
  })
})

describe("ledger_nudge", () => {
  test("appends the active plan to the terminal user message", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/ledger")
        await loadPlugin(recorder)

        const messages = [userTurn("msg_l1", "weiter"), assistantTurn("msg_l2", "ok")]
        await recorder.fire("session.context", { sessionID: "ses_ledger", messages })

        expect(textOf(messages[0])).toStartWith("weiter")
        expect(textOf(messages[0])).toContain("[yesmem-ledger v1]")
        expect(textOf(messages[0])).toContain("Goal: ship")
        expect(textOf(messages[0])).toContain("[/yesmem-ledger]")
        expect(daemon.hooked().some((request) => request.method === "get_plan")).toBe(true)
      })
    } finally {
      await daemon.close()
    }
  })

  test("patches a given message only once", async () => {
    const daemon = await mockDaemon(daemonHandler)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/ledger2")
        await loadPlugin(recorder)

        const messages = [userTurn("msg_l3", "weiter")]
        await recorder.fire("session.context", { sessionID: "ses_ledger", messages })
        await recorder.fire("session.context", { sessionID: "ses_ledger", messages })

        expect(textOf(messages[0]).split("[yesmem-ledger v1]").length - 1).toBe(1)
      })
    } finally {
      await daemon.close()
    }
  })

  test("stays off with YESMEM_LEDGER=off and without an active plan", async () => {
    const daemon = await mockDaemon((request) =>
      request.method === "get_plan" ? { result: { exists: false } } : { result: {} },
    )
    try {
      await withEnv({ YESMEM_LEDGER: "off" }, () =>
        withSocket(daemon.socketPath, async () => {
          const recorder = fakeContext("/workspace/ledger3")
          await loadPlugin(recorder)

          const messages = [userTurn("msg_l4", "weiter")]
          await recorder.fire("session.context", { sessionID: "ses_ledger", messages })
          expect(textOf(messages[0])).toBe("weiter")
          expect(daemon.hooked().some((request) => request.method === "get_plan")).toBe(false)
        }),
      )

      // With the flag back on but no active plan, nothing is appended either.
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/ledger4")
        await loadPlugin(recorder)

        const messages = [userTurn("msg_l5", "weiter")]
        await recorder.fire("session.context", { sessionID: "ses_ledger", messages })
        expect(textOf(messages[0])).toBe("weiter")
        expect(daemon.hooked().some((request) => request.method === "get_plan")).toBe(true)
      })
    } finally {
      await daemon.close()
    }
  })

  test("renders a bounded ledger", async () => {
    const module = (await Host.load(yesmemEntry("ledger_nudge.ts"))) as NudgeModule
    expect(module.renderLedger("")).toBeNull()
    expect(module.renderLedger("   ")).toBeNull()

    const rendered = module.renderLedger(Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n"))
    expect(rendered).toContain("line 0")
    expect(rendered).toContain("ledger truncated")
    expect(rendered?.split("\n").length).toBeLessThan(50)
  })
})

describe("idle_reminder", () => {
  test("reminds on every third real user turn", async () => {
    const daemon = await mockDaemon(quietDaemon)
    try {
      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/idle")
        await loadPlugin(recorder)

        const two = [userTurn("msg_i1", "a"), assistantTurn("msg_i2", "b"), userTurn("msg_i3", "c")]
        await recorder.fire("session.context", { sessionID: "ses_idle", messages: two })
        expect(textOf(two[2])).toBe("c")

        const three = [
          userTurn("msg_i4", "a"),
          assistantTurn("msg_i5", "b"),
          userTurn("msg_i6", "c"),
          assistantTurn("msg_i7", "d"),
          userTurn("msg_i8", "e"),
        ]
        await recorder.fire("session.context", { sessionID: "ses_idle", messages: three })
        expect(textOf(three[4])).toContain("[yesmem-idle]")
        expect(textOf(three[4])).toStartWith("e")
      })
    } finally {
      await daemon.close()
    }
  })

  test("does not repeat the reminder and can be switched off", async () => {
    const daemon = await mockDaemon(quietDaemon)
    try {
      await withEnv({ YESMEM_IDLE: "off" }, () =>
        withSocket(daemon.socketPath, async () => {
          const recorder = fakeContext("/workspace/idle2")
          await loadPlugin(recorder)

          const messages = [
            userTurn("msg_j1", "a"),
            userTurn("msg_j2", "b"),
            userTurn("msg_j3", "c"),
          ]
          await recorder.fire("session.context", { sessionID: "ses_idle", messages })
          expect(textOf(messages[2])).toBe("c")
        }),
      )

      await withSocket(daemon.socketPath, async () => {
        const recorder = fakeContext("/workspace/idle3")
        await loadPlugin(recorder)

        const messages = [userTurn("msg_k1", "a"), userTurn("msg_k2", "b"), userTurn("msg_k3", "c")]
        await recorder.fire("session.context", { sessionID: "ses_idle", messages })
        await recorder.fire("session.context", { sessionID: "ses_idle", messages })

        expect(textOf(messages[2]).split("[yesmem-idle]").length - 1).toBe(1)
      })
    } finally {
      await daemon.close()
    }
  })
})
