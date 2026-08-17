import { describe, expect, test } from "bun:test"
import { groupByServer } from "../../src/tool/code-mode"
import type { McpTool } from "../../src/mcp"

type CatalogEntry = {
  path: string
  key: string
  server: string
  local: string
  tool: McpTool
}

function fakeTool(id: string): { tool: McpTool; entry: CatalogEntry } {
  // groupByServer only stores the tool object keyed by entry; def/client are
  // not inspected during grouping, so minimal stubs suffice here.
  const tool = { def: { id } as unknown as McpTool["def"], client: null as unknown as McpTool["client"] } satisfies McpTool
  return { tool, entry: { path: "", key: "", server: "", local: "", tool } }
}

// Reference: the previous growing-array copy behaviour.
function referenceGroupByServer(
  mcpTools: Record<string, McpTool>,
  servers: readonly string[],
): Map<string, CatalogEntry[]> {
  const byLongest = [...servers].sort((a, b) => b.length - a.length)
  const groups = new Map<string, CatalogEntry[]>()
  for (const key of Object.keys(mcpTools).sort((a, b) => a.localeCompare(b))) {
    const server =
      byLongest.find((name) => key.startsWith(name + "_")) ?? (key.includes("_") ? key.slice(0, key.indexOf("_")) : key)
    const local = server && key.startsWith(server + "_") ? key.slice(server.length + 1) : key
    groups.set(server, [...(groups.get(server) ?? []), { path: `${server}.${local}`, key, server, local, tool: mcpTools[key]! }])
  }
  return groups
}

function makeTools(keys: string[]): Record<string, McpTool> {
  const out: Record<string, McpTool> = {}
  for (const key of keys) out[key] = fakeTool(key).tool
  return out
}

function entriesOf(map: Map<string, CatalogEntry[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [server, entries] of map) out[server] = entries.map((e) => e.key)
  return out
}

describe("code-mode.groupByServer (linear, mutable groups)", () => {
  test("matches reference grouping across servers and ordering", () => {
    const keys = ["alpha_read", "alpha_write", "beta_tool", "gamma_x", "solo"]
    const servers = ["alpha", "beta", "gamma"]
    const tools = makeTools(keys)

    const got = groupByServer(tools, servers)
    const ref = referenceGroupByServer(tools, servers)

    expect(entriesOf(got)).toEqual(entriesOf(ref))
  })

  test("longest-prefix server wins over shorter overlapping prefix", () => {
    const keys = ["git_commit", "gitlab_commit"]
    const servers = ["git", "gitlab"]
    const tools = makeTools(keys)

    const got = groupByServer(tools, servers)
    const ref = referenceGroupByServer(tools, servers)

    expect(entriesOf(got)).toEqual(entriesOf(ref))
    expect(entriesOf(got)["gitlab"]).toContain("gitlab_commit")
  })

  test("large single-server catalog is byte/result-identical and stays linear", () => {
    const server = "svc"
    const n = 16_000
    const keys = Array.from({ length: n }, (_, i) => `${server}_tool${i}`)
    const tools = makeTools(keys)

      // Compare linear vs. the quadratic reference on the same data so the
      // assertion is machine/load tolerant instead of an absolute ms bound.
      const refStart = performance.now()
      const refOut = referenceGroupByServer(tools, [server])
      const refElapsed = performance.now() - refStart

      const linStart = performance.now()
      const out = groupByServer(tools, [server])
      const linElapsed = performance.now() - linStart

      expect(out.get(server)!.length).toBe(n)
      expect(out).toEqual(refOut)
      // For 16k tools on one server, linear is ~O(n) vs reference ~O(n²); the
      // in-place-push path must be at least several times faster.
      expect(linElapsed * 4).toBeLessThan(refElapsed)
    })

  test("empty input", () => {
    expect(groupByServer({}, [])).toEqual(referenceGroupByServer({}, []))
  })
})
