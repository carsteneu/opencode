import { describe, expect, test } from "bun:test"
import { Marked } from "marked"
import { DEFAULT_FENCE_LANGUAGE, withDefaultFenceLanguage } from "../../src/util/markdown-fence"

type AnyToken = { type: string; text?: string; lang?: string; raw: string }

const markdown = new Marked()

function codeBlocks(source: string) {
  const found: AnyToken[] = []
  for (const token of tokensOf(source)) if (token.type === "code") found.push(token)
  return found
}

function tokensOf(source: string) {
  const found: AnyToken[] = []
  markdown.walkTokens(markdown.lexer(source, { gfm: true }), (token) => {
    found.push(token as AnyToken)
  })
  return found
}

describe("util.markdown-fence", () => {
  test("tags a top-level backtick fence that carries no language", () => {
    expect(withDefaultFenceLanguage("```\nnpm install\n```")).toBe("```bash\nnpm install\n```")
    expect(DEFAULT_FENCE_LANGUAGE).toBe("bash")
  })

  test("tags an unterminated fence so a streaming tail highlights too", () => {
    expect(withDefaultFenceLanguage("hello\n\n```\nnpm ins")).toBe("hello\n\n```bash\nnpm ins")
  })

  test("treats a whitespace-only info string as untagged", () => {
    expect(withDefaultFenceLanguage("```   \nls\n```   ")).toBe("```bash\nls\n```   ")
  })

  test("tags an indented top-level fence and keeps the indentation", () => {
    expect(withDefaultFenceLanguage("  ```\n  ls\n  ```")).toBe("  ```bash\n  ls\n  ```")
  })

  test("leaves a fence that already names a language alone", () => {
    const source = "```ts\nconst x = 1\n```"
    expect(withDefaultFenceLanguage(source)).toBe(source)
  })

  test("tags only the opener of a balanced pair", () => {
    expect(withDefaultFenceLanguage("```\na\n```\n\n```\nb\n```")).toBe("```bash\na\n```\n\n```bash\nb\n```")
  })

  test("leaves the closing fence of a longer fence alone", () => {
    const source = "`````\n```\ninner\n`````\n\n```\nouter\n```"
    expect(withDefaultFenceLanguage(source)).toBe("`````bash\n```\ninner\n`````\n\n```bash\nouter\n```")
  })

  test("leaves inline code and fence-like prose alone", () => {
    for (const source of ["use `npm install` and ``` not a fence ``` here", "``` is a fence marker\n\nparagraph"]) {
      expect(withDefaultFenceLanguage(source)).toBe(source)
    }
  })

  test("tags an unterminated opener as soon as a line follows it", () => {
    expect(withDefaultFenceLanguage("do this:\n```\nnpm ins")).toBe("do this:\n```bash\nnpm ins")
  })

  test("leaves a fence that continues a container line alone", () => {
    // The renderer reads the container as still open, so the line after it belongs to that block there.
    for (const source of [
      "* \n  ```\n``` \ntail-prose",
      "- \n  ```\n  npm ci\n``` \ntail-prose\n",
      "-\n    ```\n</div>\n```\t\n",
      ">> text\n> ```\ncode\n  ```\n",
    ]) {
      expect(withDefaultFenceLanguage(source)).toBe(source)
    }
  })

  test("tags a fence that follows a container with a blank line between", () => {
    expect(withDefaultFenceLanguage("> quoted\n\n```\nls\n```")).toBe("> quoted\n\n```bash\nls\n```")
  })

  test("leaves a fence line that ends the text alone", () => {
    // The renderer lexes with a different markdown version: a fence line without a line terminator is a
    // code block here and a paragraph there, so nothing may be appended to it.
    for (const source of [
      "text\n```",
      "</script>\n```",
      "Install the deps:\n```",
      "- ```\nnpm run build\n```",
      "1. ```\n  npm run build\n  ```",
      "```js `x`\ncode\n```",
    ]) {
      expect(withDefaultFenceLanguage(source)).toBe(source)
    }
  })

  test("leaves an indented code block alone", () => {
    const source = "para\n\n    ```\n    ls\n    ```"
    expect(withDefaultFenceLanguage(source)).toBe(source)
  })

  test("leaves a fence opened on a list marker alone", () => {
    // The opener shares its line with the bullet, so the closing fence must not be mistaken for one.
    for (const source of [
      "- ```\n  npm run build\n  ```\n",
      "- ```\n  npm run build\n  ```\n  echo done\n",
      "1. ```\n   npm run build\n   ```\n",
    ]) {
      expect(withDefaultFenceLanguage(source)).toBe(source)
    }
  })

  test("leaves an indented fence inside a list item alone", () => {
    const source = "- item\n\n  ```\n  npm ci\n  ```\n"
    expect(withDefaultFenceLanguage(source)).toBe(source)
  })

  test("leaves fences inside a blockquote alone", () => {
    for (const source of ["> ```\n> npm ci\n> ```\n", ">> ```\n>> npm ci\n>> ```\n"]) {
      expect(withDefaultFenceLanguage(source)).toBe(source)
    }
  })

  test("leaves a fence inside a raw HTML block alone", () => {
    const source = "<div>\n```\nnpm install\n```\n</div>\n\nprose\n"
    expect(withDefaultFenceLanguage(source)).toBe(source)
  })

  test("leaves tilde fences alone", () => {
    for (const source of ["~~~\nls\n~~~", "~~~\n```\nls\n```\n~~~", "```text\n~~~\nls\n~~~\n```"]) {
      expect(withDefaultFenceLanguage(source)).toBe(source)
    }
  })

  test("stays stable when applied twice", () => {
    const once = withDefaultFenceLanguage("```\nls\n```\n\n```ts\nx\n```\n\n- ```\n  rs\n  ```\n")
    expect(withDefaultFenceLanguage(once)).toBe(once)
  })

  test("leaves text whose token raws do not map back onto it unchanged", () => {
    // markdown rewrites line endings in the token raws, so their offsets cannot be trusted there. A lone
    // carriage return is the sharp case: the rewrite used to land inside the block instead of on its line.
    for (const source of ["```\r\nls\r\n```", "```\rcode\n```", "```\rcode\r```", "```\rc\r```\r"]) {
      expect(withDefaultFenceLanguage(source)).toBe(source)
    }
  })

  test("leaves text above the parsing ceiling unchanged", () => {
    const source = "text\n\n```\n" + "x".repeat(70 * 1024) + "\n```\n"
    expect(withDefaultFenceLanguage(source)).toBe(source)
  })

  test("survives input that overflows the markdown lexer", () => {
    // Deeply nested containers overflow the lexer's stack; the transcript still has to render.
    for (const source of [`\`\`\`\nx\n\`\`\`\n${">".repeat(20000)}\n`, `\`\`\`\nx\n\`\`\`\n${">\n".repeat(8000)}`]) {
      expect(withDefaultFenceLanguage(source).length).toBeGreaterThan(0)
    }
  })

  test("returns fence-free text and the empty string unchanged", () => {
    for (const source of ["", "just prose\nwith `inline` code\n", "~~~\nls\n~~~\n"]) {
      expect(withDefaultFenceLanguage(source)).toBe(source)
    }
  })

  test("accepts an explicit language", () => {
    expect(withDefaultFenceLanguage("```\nls\n```", "sh")).toBe("```sh\nls\n```")
  })

  test("never changes what a code block contains", () => {
    const corpus = [
      "```\nls\n```",
      "```ts\nconst x = 1\n```",
      "text\n\n```\na\n```\n\ntext\n\n```\nb\n```",
      "> ```\n> ls\n> ```",
      "- item\n\n  ```\n  ls\n  ```",
      "- ```\n  ls\n  ```\n  echo done\n",
      "```\n```\n```\n```",
      "`````\n```\nnested\n`````",
      "~~~\n```\nls\n```\n~~~",
      "```text\n~~~\nls\n~~~\n```",
      "````\n```\n````",
      "    ```\n    ls\n    ```",
      "a `inline` b\n\n```\nls\n```",
      "```\nunterminated",
      "```js `x`\ncode\n```",
      "<div>\n```\nls\n```\n</div>\n",
      "  ```\n  indented opener\n  ```\n",
      "text\n```",
      "</script>\n```",
      "- ```\nls\n```",
      "1. ```\n  ls\n  ```",
    ]
    for (const source of corpus) {
      const before = codeBlocks(source)
      const after = codeBlocks(withDefaultFenceLanguage(source))
      expect(after.map((block) => block.text)).toEqual(before.map((block) => block.text))
    }
  })

  test("gives every tagged top-level block the default language and no container block a language", () => {
    const source = "```\nls\n```\n\n> ```\n> ls\n> ```\n\n- item\n\n  ```\n  ls\n  ```\n"
    const blocks = codeBlocks(withDefaultFenceLanguage(source))
    expect(blocks.map((block) => block.lang)).toEqual(["bash", "", ""])
  })

  test("never puts the language anywhere but on a fence opener line", () => {
    const alphabet = [
      "prose",
      "",
      "```",
      "```ts",
      "~~~",
      "> ```",
      ">> ```",
      "- ```",
      "1. ```",
      "- ",
      "* ",
      "1. ",
      "> ",
      "  ```",
      "    ```",
      "``` ",
      "</div>",
      "<div>",
      "code",
      "  code",
      "tail",
    ]
    const inputs: string[] = []
    for (const first of alphabet)
      for (const second of alphabet)
        for (const third of alphabet) {
          inputs.push(`${first}\n${second}\n${third}`)
        }
    let seed = 42
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let index = 0; index < 3000; index++) {
      const lines: string[] = []
      const depth = 4 + Math.floor(random() * 4)
      for (let line = 0; line < depth; line++) lines.push(alphabet[Math.floor(random() * alphabet.length)]!)
      inputs.push(lines.join("\n"))
    }

    const violations: string[] = []
    let rewritten = 0
    for (const source of inputs) {
      const result = withDefaultFenceLanguage(source)
      if (result === source) continue
      rewritten++
      // The rewrite may only add the language to fence openers: never more than one per line of input.
      if (result.length - source.length > source.split("\n").length * DEFAULT_FENCE_LANGUAGE.length) {
        violations.push(`${JSON.stringify(source)} grew by ${result.length - source.length}`)
      }
      // The language may only ever sit on the first line of a code block's raw. Anywhere else it is
      // visible or copyable text, or worse, part of the code itself.
      for (const token of tokensOf(result)) {
        if (!token.raw.includes("```" + DEFAULT_FENCE_LANGUAGE)) continue
        if (token.type !== "code" || !(token.raw.split("\n")[0] ?? "").includes(DEFAULT_FENCE_LANGUAGE)) {
          violations.push(`${JSON.stringify(source)} => ${token.type} ${JSON.stringify(token.raw)}`)
        }
      }
      const before = codeBlocks(source).map((block) => block.text)
      const after = codeBlocks(result).map((block) => block.text)
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        violations.push(
          `${JSON.stringify(source)} changed code blocks ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
        )
      }
    }

    expect(violations).toEqual([])
    // Guards the guard: the corpus has to produce rewrites, otherwise the assertions above are vacuous.
    expect(rewritten).toBeGreaterThan(100)
  })
})
