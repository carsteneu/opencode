import type { CommandModule } from "yargs"

type LazyCommandMeta = {
  command: string
  aliases?: ReadonlyArray<string>
  describe: string | false | undefined
}

/**
 * Registers a yargs command whose module (and its heavy imports) loads only at
 * dispatch time. `command`/`describe`/`aliases` are kept eager so help, strict
 * matching and the top-level command list work without importing the module,
 * while the builder and handler `await import()` the real module on first use.
 */
export function lazyCommand(meta: LazyCommandMeta, loader: () => Promise<any>): CommandModule {
  let module: CommandModule | undefined

  async function resolve() {
    return (module ??= (await loader()) as CommandModule)
  }

  return {
    command: meta.aliases?.length ? [meta.command, ...meta.aliases] : meta.command,
    describe: meta.describe,
    async builder(yargs: any) {
      const loaded = (await resolve()) as any
      if (typeof loaded.builder === "function") {
        return loaded.builder(yargs)
      }
      if (loaded.builder && typeof loaded.builder === "object") {
        for (const key of Object.keys(loaded.builder)) {
          yargs = yargs.option(key, loaded.builder[key])
        }
      }
      return yargs
    },
    async handler(args: any) {
      const loaded = (await resolve()) as any
      if (typeof loaded.handler !== "function") return
      // The real module is already loaded by the preceding builder, so this is
      // effectively free. Keep the await so side-effect ordering matches eager registration.
      return loaded.handler(args)
    },
  }
}
