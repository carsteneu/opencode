import { describe, expect, it } from "bun:test"
import { Diagnostic } from "../../src/lsp/diagnostic"

const diag = (line: number, message = `err ${line}`) => ({
  severity: 1 as const,
  range: { start: { line, character: 0 }, end: { line, character: 1 } },
  message,
})

describe("Diagnostic.report", () => {
  it("renders every unique error up to the cap with an exact 'and N more' count", () => {
    const issues = Array.from({ length: 25 }, (_, i) => diag(i))
    const out = Diagnostic.report("file.ts", issues)
    const errorLines = out.match(/^ERROR/gm) ?? []
    expect(errorLines.length).toBe(20)
    expect(out).toContain("... and 5 more")
  })

  it("reports the exact remaining count when duplicates are removed", () => {
    // 21 unique + 1 duplicate of the first = 22 severity-1 total, 21 unique.
    const issues = [...Array.from({ length: 21 }, (_, i) => diag(i)), diag(0)]
    const out = Diagnostic.report("file.ts", issues)
    const errorLines = out.match(/^ERROR/gm) ?? []
    expect(errorLines.length).toBe(20)
    expect(out).toContain("... and 2 more")
  })

  it("emits nothing when there are no errors", () => {
    const warnings = [{ ...diag(0, "warn"), severity: 2 as const }]
    expect(Diagnostic.report("file.ts", warnings)).toBe("")
    expect(Diagnostic.report("file.ts", [])).toBe("")
  })
})
