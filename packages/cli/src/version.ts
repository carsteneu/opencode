declare const OPENCODE_VERSION: string
declare const OPENCODE_CHANNEL: string
declare const OPENCODE_ARTIFACT: string
declare const OPENCODE_UPDATE_CHANNEL: string | undefined

const version = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
const channel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
const artifact = typeof OPENCODE_ARTIFACT === "string" ? OPENCODE_ARTIFACT : "cli"
// The update channel is a separate axis from the build channel: it only decides
// where updates come from, never the database, service or session identity.
const updateChannel = typeof OPENCODE_UPDATE_CHANNEL === "string" ? OPENCODE_UPDATE_CHANNEL : "stable"

export {
  version as OPENCODE_VERSION,
  channel as OPENCODE_CHANNEL,
  artifact as OPENCODE_ARTIFACT,
  updateChannel as OPENCODE_UPDATE_CHANNEL,
}
export const OPENCODE_LOCAL = channel === "local"
