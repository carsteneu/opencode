#!/usr/bin/env bun

const version = process.env.OPENCODE_VERSION
if (!version || !/^\d+\.\d+\.\d+-patched\.\d+$/.test(version)) {
  throw new Error("OPENCODE_VERSION must match x.y.z-patched.n")
}

process.env.OPENCODE_CHANNEL = "latest"
process.env.OPENCODE_UPDATE_REPOSITORY = "carsteneu/opencode"
process.env.OPENCODE_UPDATE_CHANNEL = "patched"

await import("./build")
