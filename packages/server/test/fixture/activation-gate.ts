import fs from "node:fs/promises"
import path from "node:path"

/**
 * Installs a local plugin whose activation blocks until `open()` runs. A
 * handler that reads its service without awaitPlugins answers while the gate is
 * still closed and therefore misses every plugin-provided entry, which makes
 * the assertion deterministic instead of racing the forked activation in the
 * supervisor (packages/core/src/plugin/supervisor.ts).
 *
 * The callers give the answer a 300ms head start before opening the gate, a
 * margin of roughly 60 times a local roundtrip. If a machine were slow enough to
 * answer later than that, a mutated handler would survive the test; the content
 * assertion stays the second discriminator, not a replacement for the window.
 *
 * The plugin needs no imports: the bare specifier a real plugin uses does not
 * resolve from a temporary directory.
 */
export async function activationGate(directory: string) {
  const marker = path.join(directory, "activation-gate.open")
  const plugin = path.join(directory, "plugins", "activation-gate")
  await fs.mkdir(plugin, { recursive: true })
  await fs.writeFile(
    path.join(plugin, "index.ts"),
    [
      "export default {",
      '  id: "activation-gate",',
      "  async setup() {",
      '    const fs = await import("node:fs/promises")',
      "    for (;;) {",
      `      const open = await fs.access(${JSON.stringify(marker)}).then(() => true, () => false)`,
      "      if (open) return",
      "      await new Promise((resolve) => setTimeout(resolve, 5))",
      "    }",
      "  },",
      "}",
      "",
    ].join("\n"),
  )
  return {
    open: () => fs.writeFile(marker, "open"),
  }
}
