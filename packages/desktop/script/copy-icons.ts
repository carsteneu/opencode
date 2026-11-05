import { $ } from "bun"
import { resolveChannel } from "./utils"

const arg = process.argv[2]

const channel = arg === "dev" || arg === "beta" || arg === "prod" || arg === "special" ? arg : resolveChannel()

// The fork channel ships the production artwork until it has a set of its own.
const src = `./icons/${channel === "special" ? "prod" : channel}`

const dest = "resources/icons"

await $`rm -rf ${dest}`

await $`cp -R ${src} ${dest}`

console.log(`Copied ${channel} icons from ${src} to ${dest}`)
