import path from "node:path"

const directory = process.env.MCP_LIFECYCLE_TREE_DIR
if (!directory) throw new Error("MCP_LIFECYCLE_TREE_DIR is required")

const grandchild = process.argv.includes("--grandchild")
const name = grandchild ? "grandchild" : "child"

if (grandchild) {
  process.on("SIGTERM", () => {
    void Bun.write(path.join(directory, "grandchild.term"), "received")
  })
}

await Bun.write(path.join(directory, `${name}.pid`), String(process.pid))

if (!grandchild) {
  const child = Bun.spawn([process.execPath, import.meta.path, "--grandchild"], {
    env: { ...process.env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  child.unref()
}

await new Promise(() => {})
