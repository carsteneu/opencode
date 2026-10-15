import { expect, test } from "bun:test"
import { CodeRenderable, MarkdownRenderable, type CapturedFrame, type Renderable } from "@opentui/core"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const CODE = [
  "# install first",
  "npm install --save-dev vitest",
  'if [ -d "node_modules" ]; then',
  '  echo "ready"',
  "fi",
]
const UNTAGGED = ["Run the suite:", "", "```", ...CODE, "```", ""].join("\n")
const TAGGED = ["And the typed block:", "", "```ts", "const answer: number = 42", "```", ""].join("\n")

const session = {
  id: "ses_fence_language",
  title: "Fence language",
  projectID: "proj_test",
  location: { directory },
  agent: "build",
  model: { providerID: "fixture", id: "fixture" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 10 },
}

async function withSession(
  content: unknown[],
  config: Record<string, unknown>,
  marker: string,
  run: (setup: Awaited<ReturnType<typeof createAppFixture>>) => Promise<void>,
) {
  await using state = await tmpdir()
  await using setup = await createAppFixture({
    width: 100,
    height: 40,
    state: state.path,
    config: { animations: false, tabs: { enabled: false }, ...config },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({
          data: [
            {
              id: "msg_fence",
              type: "assistant",
              agent: "build",
              model: session.model,
              time: { created: 1, completed: 6 },
              content,
            },
          ],
          cursor: {},
        })
      if (
        url.pathname === `/api/session/${session.id}/inbox` ||
        url.pathname === `/api/session/${session.id}/permission`
      )
        return json({ data: [] })
      return undefined
    },
  })
  // The transcript paints in blocks, so the renderer's default 20-pass budget is not enough under load.
  await setup.waitForFrame((frame) => frame.includes(marker), { maxPasses: 400 })
  await run(setup)
}

type Setup = Awaited<ReturnType<typeof createAppFixture>>

function descendants(root: Renderable) {
  const found: Renderable[] = []
  const walk = (node: Renderable) => {
    for (const child of node.getChildren()) {
      found.push(child)
      walk(child)
    }
  }
  walk(root)
  return found
}

function insideMarkdown(node: Renderable) {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent instanceof MarkdownRenderable) return true
  return false
}

/** Fenced code blocks live as child renderables of the transcript's Markdown renderable. */
function fenceBlocks(setup: Setup) {
  return descendants(setup.renderer.root).filter(
    (node): node is CodeRenderable => node instanceof CodeRenderable && insideMarkdown(node),
  )
}

/** The reasoning block renders markdown source outside any Markdown renderable. */
function reasoningBlock(setup: Setup) {
  return descendants(setup.renderer.root).find(
    (node): node is CodeRenderable => node instanceof CodeRenderable && !insideMarkdown(node),
  )
}

function fenceBlock(setup: Setup, text: string) {
  const block = fenceBlocks(setup).find((candidate) => candidate.content.includes(text))
  if (!block) throw new Error(`no code block containing ${text} in ${fenceBlocks(setup).map((b) => b.content)}`)
  return block
}

/** Distinct foreground colours of the rendered rows of one code block — the measure for flat vs highlighted. */
function blockForegrounds(frame: CapturedFrame, chars: string[], first: string, last: string) {
  const start = chars.findIndex((line) => line.includes(first))
  const end = chars.findIndex((line) => line.trim() === last)
  if (start < 0 || end <= start) throw new Error(`code rows not found in frame: ${first} .. ${last}`)
  const colors = new Set<string>()
  for (let row = start; row <= end; row++) {
    for (const span of frame.lines[row].spans) {
      if (!span.text.trim()) continue
      colors.add(span.fg.toInts().join(","))
    }
  }
  return colors
}

async function waitForHighlight(setup: Setup, measure: () => number) {
  // The highlight arrives from a worker that also loads the bash grammar, so under load this takes seconds.
  for (let attempt = 0; attempt < 800 && measure() < 2; attempt++) await Bun.sleep(25)
}

test("an untagged fence is highlighted with the default language while a tagged fence keeps its own", async () => {
  await withSession(
    [{ type: "text", text: `${UNTAGGED}\n${TAGGED}` }],
    {},
    "const answer: number = 42",
    async (setup) => {
      expect(fenceBlock(setup, "npm install --save-dev vitest").filetype).toBe("bash")
      expect(fenceBlock(setup, "const answer: number = 42").filetype).toBe("typescript")
      // The code the reader sees is exactly the model's code — the injected tag stays in the fence line.
      expect(fenceBlock(setup, "npm install --save-dev vitest").content).toBe(CODE.join("\n"))
      expect(fenceBlock(setup, "npm install --save-dev vitest").content).not.toContain("bash")

      const measure = () =>
        blockForegrounds(setup.captureSpans(), setup.captureCharFrame().split("\n"), "install first", "fi").size
      await waitForHighlight(setup, measure)
      expect(measure()).toBeGreaterThan(1)

      // The fence line is markdown syntax and never reaches the frame, so the injected language cannot
      // leak into what the reader sees or selects.
      expect(setup.captureCharFrame()).not.toContain("bash")
      expect(setup.captureCharFrame()).not.toContain("```")
    },
  )
}, 60000)

test("keeps code blocks that already carry a language untouched", async () => {
  await withSession([{ type: "text", text: TAGGED }], {}, "const answer: number = 42", async (setup) => {
    expect(fenceBlock(setup, "const answer: number = 42").filetype).toBe("typescript")
    expect(fenceBlocks(setup).map((block) => block.filetype)).not.toContain("bash")
  })
}, 60000)

test("leaves inline code and fence-like prose alone", async () => {
  const text = "Use `npm install` first.\n\nA line with ``` in the middle stays prose.\n"
  await withSession([{ type: "text", text }], {}, "A line with", async (setup) => {
    expect(fenceBlocks(setup).some((block) => block.content.includes("```bash"))).toBe(false)
    expect(fenceBlocks(setup).map((block) => block.filetype)).not.toContain("bash")
    expect(setup.captureCharFrame()).toContain("A line with ``` in the middle stays prose.")
  })
}, 60000)

test("leaves fences inside a list and inside a blockquote alone", async () => {
  // A list item owns a real code block, a blockquote renders its body as markdown source. Both are left
  // as written: whether such a fence opens or closes depends on the container, which a line cannot tell us.
  const text = [
    "- steps:",
    "",
    "  ```",
    "  npm run build --list",
    "  ```",
    "",
    "> ```",
    "> npm run build --quote",
    "> ```",
    "",
  ].join("\n")
  await withSession([{ type: "text", text }], {}, "npm run build --quote", async (setup) => {
    expect(fenceBlock(setup, "npm run build --list").filetype).toBeUndefined()
    expect(fenceBlock(setup, "npm run build --list").content).toBe("npm run build --list")
    expect(fenceBlock(setup, "npm run build --quote").content).toBe("```\nnpm run build --quote\n```")
    expect(setup.captureCharFrame()).not.toContain("bash")
  })
}, 60000)

test("leaves a fence opened on a list marker alone", async () => {
  // Regression: the opener shares its line with the bullet, so tagging the closing fence would turn the
  // injected language into code content and swallow the prose behind the block.
  const text = ["- ```", "  npm run build --item", "  ```", "  tail prose", ""].join("\n")
  await withSession([{ type: "text", text }], {}, "tail prose", async (setup) => {
    expect(fenceBlocks(setup).some((block) => block.content.includes("bash"))).toBe(false)
    expect(fenceBlocks(setup).some((block) => block.content.includes("```"))).toBe(false)
    expect(setup.captureCharFrame()).toContain("tail prose")
    expect(setup.captureCharFrame()).not.toContain("bash")
  })
}, 60000)

test("honours the default language in the reasoning block without touching the rendered text", async () => {
  const reasoning = "Checking the toolchain:\n\n```\nnpm ci\n```\n"
  await withSession(
    [{ type: "reasoning", text: reasoning, time: { created: 2, completed: 5 } }],
    { session: { thinking: "show" } },
    "npm ci",
    async (setup) => {
      const block = reasoningBlock(setup)
      expect(block?.filetype).toBe("markdown")
      expect(block?.content).toBe("Checking the toolchain:\n\n```bash\nnpm ci\n```")
      // Rendered markdown conceals the whole fence line, so the frame stays free of the injected tag.
      expect(setup.captureCharFrame()).toContain("npm ci")
      expect(setup.captureCharFrame()).not.toContain("bash")
    },
  )
}, 60000)

test("keeps the reasoning source view byte-faithful in source markdown mode", async () => {
  // The reasoning block renders markdown source, so the tag would be on screen (and selectable) there.
  const reasoning = "Checking the toolchain:\n\n```\nnpm ci\n```\n"
  await withSession(
    [{ type: "reasoning", text: reasoning, time: { created: 2, completed: 5 } }],
    { session: { thinking: "show", markdown: "source" } },
    "npm ci",
    async (setup) => {
      const block = reasoningBlock(setup)
      expect(block?.content).toBe("Checking the toolchain:\n\n```\nnpm ci\n```")
      expect(setup.captureCharFrame()).toContain("```")
      expect(setup.captureCharFrame()).not.toContain("```bash")
    },
  )
}, 60000)

test("keeps the transcript free of the injected tag in source markdown mode", async () => {
  // Fence lines are markdown syntax: the transcript renders the code inside them, never the fence line.
  await withSession(
    [{ type: "text", text: UNTAGGED }],
    { session: { markdown: "source" } },
    "Run the suite:",
    async (setup) => {
      expect(fenceBlock(setup, "npm install --save-dev vitest").filetype).toBe("bash")
      expect(setup.captureCharFrame()).toContain("npm install --save-dev vitest")
      expect(setup.captureCharFrame()).not.toContain("```")
    },
  )
}, 60000)

test.each([
  { mode: "rendered", text: "Install the deps:\n```", marker: "Install the deps:" },
  { mode: "source", text: "Install the deps:\n```", marker: "Install the deps:" },
  { mode: "rendered", text: "</script>\n```", marker: "</script>" },
  { mode: "source", text: "</script>\n```", marker: "</script>" },
  { mode: "source", text: "1. ```\n  npm run build\n  ```", marker: "npm run build" },
] as const)(
  "never renders the tag for a fence line that ends the text ($mode, $text)",
  async ({ mode, text, marker }) => {
    // The renderer reads this shape as a paragraph, so the line stays visible text and must stay as written.
    await withSession([{ type: "text", text }], { session: { markdown: mode } }, marker, async (setup) => {
      expect(setup.captureCharFrame()).not.toContain("bash")
      expect(fenceBlocks(setup).some((block) => block.content.includes("bash"))).toBe(false)
    })
  },
  30000,
)
