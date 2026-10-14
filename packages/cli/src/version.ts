declare const OPENCODE_VERSION: string
declare const OPENCODE_CHANNEL: string
declare const OPENCODE_ARTIFACT: string
declare const OPENCODE_UPDATE_CHANNEL: string
declare const OPENCODE_UPDATE_REPOSITORY: string

const version = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
const channel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
const artifact = typeof OPENCODE_ARTIFACT === "string" ? OPENCODE_ARTIFACT : "cli"
const updateChannel = typeof OPENCODE_UPDATE_CHANNEL === "string" ? OPENCODE_UPDATE_CHANNEL : ""
const updateRepository = typeof OPENCODE_UPDATE_REPOSITORY === "string" ? OPENCODE_UPDATE_REPOSITORY : ""

export { version as OPENCODE_VERSION, channel as OPENCODE_CHANNEL, artifact as OPENCODE_ARTIFACT }
export { updateChannel as OPENCODE_UPDATE_CHANNEL, updateRepository as OPENCODE_UPDATE_REPOSITORY }
export const OPENCODE_LOCAL = channel === "local"
// Fork builds resolve updates from the fork's GitHub prereleases instead of the
// official release service, so an official release can never replace them.
export const OPENCODE_FORK = updateChannel !== ""
