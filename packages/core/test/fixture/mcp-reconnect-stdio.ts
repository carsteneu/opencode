import { Server } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"

// A stdio MCP server whose availability a test can drive from the outside: it leaves immediately
// while its marker file is missing, and can be told to leave again right after answering one
// `tools/list`, which is how a flapping server is reproduced.
const marker = process.env.MCP_RECONNECT_MARKER
const pidFile = process.env.MCP_RECONNECT_PID_FILE

if (pidFile) await Bun.write(pidFile, String(process.pid))
if (marker && !(await Bun.file(marker).exists())) process.exit(1)

const server = new Server({ name: "mcp-reconnect-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler("tools/list", () => {
  const exitAfter = process.env.MCP_RECONNECT_EXIT_AFTER_LIST
  if (exitAfter) setTimeout(() => process.exit(0), Number(exitAfter))
  return Promise.resolve({
    tools: [
      { name: "current_directory", description: process.cwd(), inputSchema: { type: "object", properties: {} } },
    ],
  })
})

await server.connect(new StdioServerTransport())
