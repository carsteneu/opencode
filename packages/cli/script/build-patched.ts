#!/usr/bin/env bun

import { ForkRelease } from "@opencode/util/installation/fork-release"

const version = process.env.OPENCODE_VERSION
if (!version || !ForkRelease.version(version))
  throw new Error(`OPENCODE_VERSION must match x.y.z-${ForkRelease.channel}.n`)

// The build channel stays the ordinary one on purpose: it keys the database,
// the background service and the session identity, and a patched install must
// keep those when it moves to the next major line. Only the update channel
// moves, so updates come from our release channel instead of upstream.
process.env.OPENCODE_CHANNEL = "latest"
process.env.OPENCODE_UPDATE_CHANNEL = ForkRelease.channel

await import("./build")
