/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { ConfigProvider } from "../../../src/config"
import { ThemeProvider, type ThemeError, useThemes } from "../../../src/context/theme"

const ENV = "OPENCODE_THEME"
const DRACULA_DARK_BACKGROUND = "#282a36"

async function wait(fn: () => boolean) {
  const started = Date.now()
  while (!fn()) {
    if (Date.now() - started > 2000) throw new Error("timed out waiting for the theme provider")
    await Bun.sleep(10)
  }
}

// Mounts the real ThemeProvider over the TUI test fixtures with a recorded config service, so a
// write to the config (persistence) would be observable. The config file is written because the
// provider watches its directory.
async function observe(
  input: {
    root: string
    env?: string
    config?: { name?: string; mode?: "dark" | "light" | "system" }
  },
  act?: (themes: ReturnType<typeof useThemes>) => void,
) {
  const writes: unknown[] = []
  const directory = path.join(input.root, "config")
  const configPath = path.join(directory, "cli.json")
  const contents = `${JSON.stringify({ theme: input.config }, null, 2)}\n`
  await Bun.write(configPath, contents)

  const previous = process.env[ENV]
  if (input.env === undefined) delete process.env[ENV]
  else process.env[ENV] = input.env

  let themes: ReturnType<typeof useThemes> | undefined
  const errors: ThemeError[] = []
  let unsubscribe: (() => void) | undefined

  function Probe() {
    const value = useThemes()
    themes = value
    unsubscribe = value.onError((error) => errors.push(error))
    return <text>{value.selected}</text>
  }

  const resolved = createTuiResolvedConfig({ theme: input.config })
  const info = input.config ? { theme: input.config } : {}
  const app = await testRender(
    () => (
      <ConfigProvider
        config={resolved}
        service={{
          path: configPath,
          get: async () => info,
          update: async (update) => {
            writes.push(update)
            return info
          },
        }}
      >
        <ThemeProvider mode="dark" source={emptyThemeSource}>
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 20, height: 2 },
  )
  app.renderer.start()

  try {
    await wait(() => themes?.ready === true)
    if (!themes) throw new Error("Theme provider is not mounted")
    act?.(themes)
    return {
      selected: themes.selected,
      background: themes.currentTokens().background.base.toString(),
      mode: themes.mode(),
      errors: errors.map((error) => error.name),
      writes: writes.length,
      contents: await readFile(configPath, "utf8"),
    }
  } finally {
    unsubscribe?.()
    app.renderer.destroy()
    if (previous === undefined) delete process.env[ENV]
    else process.env[ENV] = previous
  }
}

test("OPENCODE_THEME overrides the configured theme", async () => {
  await using root = await tmpdir()
  const baseline = await observe({ root: root.path })
  const overridden = await observe({ root: root.path, env: "dracula", config: { name: "catppuccin" } })

  expect(baseline.selected).toBe("opencode")
  expect(overridden.selected).toBe("dracula")
  expect(overridden.background).toBe(RGBA.fromHex(DRACULA_DARK_BACKGROUND).toString())
  expect(overridden.background).not.toBe(baseline.background)
})

test("config theme applies when no override is set", async () => {
  await using root = await tmpdir()
  const baseline = await observe({ root: root.path })
  const configured = await observe({ root: root.path, config: { name: "dracula" } })

  expect(configured.selected).toBe("dracula")
  expect(configured.background).toBe(RGBA.fromHex(DRACULA_DARK_BACKGROUND).toString())
  expect(configured.background).not.toBe(baseline.background)
  expect(configured.errors).toEqual([])
})

test("the built-in opencode theme applies when neither override nor config theme is set", async () => {
  await using root = await tmpdir()
  const plain = await observe({ root: root.path })

  expect(plain.selected).toBe("opencode")
  expect(plain.errors).toEqual([])
})

test("the system theme can be used as an override", async () => {
  await using root = await tmpdir()
  const themed = await observe({ root: root.path, env: "system", config: { name: "dracula" } })

  expect(themed.selected).toBe("system")
  expect(themed.errors).toEqual([])
  expect(themed.writes).toBe(0)
})

test("the override leaves the configured mode untouched", async () => {
  await using root = await tmpdir()
  const light = await observe({ root: root.path, env: "dracula", config: { name: "catppuccin", mode: "light" } })

  expect(light.selected).toBe("dracula")
  expect(light.mode).toBe("light")
})

test("the override is never persisted and the configured theme returns without it", async () => {
  await using root = await tmpdir()
  const overridden = await observe({ root: root.path, env: "dracula", config: { name: "catppuccin" } })
  expect(overridden.selected).toBe("dracula")
  expect(overridden.writes).toBe(0)
  expect(overridden.contents).toBe(`${JSON.stringify({ theme: { name: "catppuccin" } }, null, 2)}\n`)

  // A second start without the flag (the env var is unset again) reads the config value.
  const restarted = await observe({ root: root.path, config: { name: "catppuccin" } })
  expect(restarted.selected).toBe("catppuccin")
  expect(restarted.writes).toBe(0)
  expect(restarted.contents).toBe(overridden.contents)
})

test("an unknown override name behaves exactly like an unknown configured name", async () => {
  await using root = await tmpdir()
  const baseline = await observe({ root: root.path })
  const unknownConfig = await observe({ root: root.path, config: { name: "does-not-exist" } })
  const unknownOverride = await observe({ root: root.path, env: "does-not-exist", config: { name: "dracula" } })

  // Measured v2 behaviour for an unknown name: the rendered theme silently falls back to the
  // built-in opencode theme, no error is reported, and `selected` keeps the requested name.
  expect(unknownConfig.background).toBe(baseline.background)
  expect(unknownConfig.selected).toBe("does-not-exist")
  expect(unknownConfig.errors).toEqual([])

  expect(unknownOverride.background).toBe(unknownConfig.background)
  expect(unknownOverride.selected).toBe(unknownConfig.selected)
  expect(unknownOverride.errors).toEqual(unknownConfig.errors)
  expect(unknownOverride.writes).toBe(0)
})

test("a name from the prototype chain behaves exactly like in the config path", async () => {
  await using root = await tmpdir()
  const baseline = await observe({ root: root.path })
  const exoticConfig = await observe({ root: root.path, config: { name: "__proto__" } })
  const exoticOverride = await observe({ root: root.path, env: "__proto__", config: { name: "dracula" } })

  // Inherited keys are truthy in every theme lookup, so such a name reaches the loader and reports
  // a theme error before falling back — with a flag exactly as with a configured name.
  expect(exoticConfig.errors).toEqual(["__proto__"])
  expect(exoticConfig.selected).toBe("opencode")
  expect(exoticConfig.background).toBe(baseline.background)
  expect(exoticOverride.background).toBe(exoticConfig.background)
  expect(exoticOverride.selected).toBe(exoticConfig.selected)
  expect(exoticOverride.errors).toEqual(exoticConfig.errors)
  expect(exoticOverride.writes).toBe(0)
})

test("the picker changes the session theme without writing the config while an override is active", async () => {
  await using root = await tmpdir()
  const picked = await observe({ root: root.path, env: "dracula", config: { name: "catppuccin" } }, (themes) => {
    expect(themes.set("gruvbox")).toBe(true)
  })

  expect(picked.selected).toBe("gruvbox")
  expect(picked.background).not.toBe(RGBA.fromHex(DRACULA_DARK_BACKGROUND).toString())
  expect(picked.writes).toBe(0)
  expect(picked.contents).toBe(`${JSON.stringify({ theme: { name: "catppuccin" } }, null, 2)}\n`)
})

test("without an override the picker keeps persisting the chosen theme", async () => {
  await using root = await tmpdir()
  const picked = await observe({ root: root.path, config: { name: "catppuccin" } }, (themes) => {
    expect(themes.set("dracula")).toBe(true)
  })

  expect(picked.selected).toBe("dracula")
  expect(picked.background).toBe(RGBA.fromHex(DRACULA_DARK_BACKGROUND).toString())
  expect(picked.writes).toBe(1)
})
