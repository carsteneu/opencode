declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_UPDATE_REPOSITORY: string
  const OPENCODE_UPDATE_CHANNEL: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
export const InstallationUpdateRepository =
  typeof OPENCODE_UPDATE_REPOSITORY === "string" ? OPENCODE_UPDATE_REPOSITORY : "anomalyco/opencode"
export const InstallationUpdateChannel =
  typeof OPENCODE_UPDATE_CHANNEL === "string" ? OPENCODE_UPDATE_CHANNEL : "stable"
