import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session/session"

describe("compactSummaryDiffs", () => {
  test("stores metadata without patch text", () => {
    const result = Session.compactSummaryDiffs([
      {
        file: "src/app.ts",
        patch: "Index: src/app.ts\n" + "x".repeat(50_000),
        additions: 12,
        deletions: 3,
        status: "modified",
      },
    ])

    expect(result).toEqual([
      {
        file: "src/app.ts",
        additions: 12,
        deletions: 3,
        status: "modified",
      },
    ])
    expect("patch" in result[0]!).toBe(false)
  })

  test("bounds durable payload growth independently of patch size", () => {
    const input = Array.from({ length: 40 }, (_, index) => ({
      file: `src/file-${index}.ts`,
      patch: "P".repeat(200_000),
      additions: 10,
      deletions: 2,
      status: "modified" as const,
    }))
    const before = JSON.stringify(input).length
    const after = JSON.stringify(Session.compactSummaryDiffs(input)).length

    expect(before).toBeGreaterThan(5_000_000)
    expect(after).toBeLessThan(10_000)
    expect(after).toBeLessThan(before / 1_000)
  })

  test("retains metadata for generated and vendor paths", () => {
    const result = Session.compactSummaryDiffs([
      {
        file: "packages/app/node_modules/example/index.js",
        patch: "large patch",
        additions: 1,
        deletions: 0,
        status: "modified",
      },
    ])

    expect(result).toEqual([
      {
        file: "packages/app/node_modules/example/index.js",
        additions: 1,
        deletions: 0,
        status: "modified",
      },
    ])
  })
})
