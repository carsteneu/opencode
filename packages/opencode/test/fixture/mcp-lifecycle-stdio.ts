import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import path from "node:path"

const treeDirectory = process.env.MCP_LIFECYCLE_TREE_DIR
const pidFile = process.env.MCP_LIFECYCLE_PID_FILE

if (pidFile) await Bun.write(pidFile, String(process.pid))

if (process.argv.includes("--tree")) {
  if (!treeDirectory) throw new Error("MCP_LIFECYCLE_TREE_DIR is required")
  await Bun.write(path.join(treeDirectory, "root.pid"), String(process.pid))
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "mcp-lifecycle-child.ts")], {
    env: { ...process.env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  child.unref()
  while (!(await Bun.file(path.join(treeDirectory, "grandchild.pid")).exists())) await Bun.sleep(5)
}

if (process.argv.includes("--chatty-stderr")) {
  await new Promise<void>((resolve, reject) =>
    process.stderr.write(Buffer.alloc(2 * 1024 * 1024, "x"), (error) => (error ? reject(error) : resolve())),
  )
  if (process.env.MCP_LIFECYCLE_STDERR_DONE) await Bun.write(process.env.MCP_LIFECYCLE_STDERR_DONE, "done")
}

if (process.argv.includes("--barrier")) {
  const directory = process.env.MCP_LIFECYCLE_BARRIER_DIR
  const name = process.env.MCP_LIFECYCLE_BARRIER_NAME
  if (!directory || !name) throw new Error("MCP lifecycle barrier configuration is required")
  await Bun.write(path.join(directory, `${name}.started`), String(process.pid))
  while (!(await Bun.file(path.join(directory, "release")).exists())) await Bun.sleep(5)
}

if (process.argv.includes("--hang")) {
  if (!pidFile) throw new Error("MCP_LIFECYCLE_PID_FILE is required")
  await new Promise(() => {})
}

const server = new Server({ name: "mcp-lifecycle-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (process.argv.includes("--list-error")) throw new Error("list tools failed")
  if (process.env.MCP_LIFECYCLE_LISTED_FILE) await Bun.write(process.env.MCP_LIFECYCLE_LISTED_FILE, "listed")
  return {
    tools: [
      {
        name: "current_directory",
        description: process.cwd(),
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }
})

await server.connect(new StdioServerTransport())
