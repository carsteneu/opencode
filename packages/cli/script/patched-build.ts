#!/usr/bin/env bun

const version = process.env.OPENCODE_VERSION
if (!version || !/^\d+\.\d+\.\d+-v2patched\.\d+$/.test(version)) {
  throw new Error("OPENCODE_VERSION must match x.y.z-v2patched.n")
}

process.env.OPENCODE_CHANNEL = "latest"
process.env.OPENCODE_UPDATE_REPOSITORY = "carsteneu/opencode"
process.env.OPENCODE_UPDATE_CHANNEL = "v2patched"

await import("./build")
