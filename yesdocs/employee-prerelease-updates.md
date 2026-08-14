# Employee Prerelease Updates

Patched employee builds use a dedicated update feed embedded at build time:

- Repository: `carsteneu/opencode`
- Release channel: GitHub prereleases
- Accepted tags: `x.y.z-patched.n`
- Current platform: Linux x64
- Required assets: `opencode-linux-x64` and `opencode-linux-x64.sha256`

The normal OpenCode installation channel remains `latest`. Employee builds therefore continue to use the same database, sessions, and configuration as the existing patched installation.

## Update behavior

At startup, OpenCode checks the fork release list and selects the highest complete patched SemVer release. Drafts, unrelated prereleases, and releases missing either required asset are ignored.

Before replacing the executable, the updater:

1. Acquires a cross-process lock shared by concurrent OpenCode sessions.
2. Refreshes the release from GitHub without trusting a stale cache for installation.
3. Streams the binary into a temporary file beside the installed executable.
4. Verifies the published SHA-256 checksum.
5. Runs the staged binary and verifies its exact version.
6. Atomically renames it over the existing executable.

Automatic updates never move to an equal or older SemVer. With `autoupdate: true`, every newer patched release is installed, including releases whose upstream base version changes minor or major version. `autoupdate: "notify"` remains available for a pilot group.

Release discovery is cached for one hour and coordinated across local processes. An explicit `opencode upgrade` bypasses that cache.

## Building and publishing

Apply and verify the pinned OpenTUI overlay first. From `packages/opencode`, prepare the assets with:

```sh
OPENTUI_ROOT=/path/to/pinned/opentui bun run release:patched 1.18.18-patched.106
```

After the exact source is committed and merged into a clean `working` branch, publish with:

```sh
OPENTUI_ROOT=/path/to/pinned/opentui bun run release:patched 1.18.18-patched.106 --publish
```

The publishing command refuses other branches, a dirty worktree, a mismatched OpenCode base version, and a version that does not advance the current patched prerelease. It verifies the pinned OpenTUI overlay, pushes `working`, builds the fork-pinned binary, and creates the checksum. The assets are first uploaded to a draft and checked for exact names, sizes, and checksum content. The release only becomes visible as a prerelease after those checks pass.

## Initial rollout

The first updater-enabled release must be installed once through the normal employee software rollout. Existing `.104` and `.105` binaries do not contain the fork updater and cannot acquire it automatically.

Install the binary in a user-writable location such as `~/.opencode/bin/opencode`. A centrally owned `/usr/local/bin/opencode` cannot replace itself without an administrator-managed update job.

Recommended rollout:

1. Publish and manually deploy updater-enabled `.106` to a pilot group with `autoupdate: "notify"`.
2. Publish updater-enabled `.107` and verify `.106 -> .107` self-update continuity.
3. Enable `autoupdate: true` for the broader employee group.

The current artifact targets glibc-based Linux x64 systems with modern CPUs. A baseline x64 asset and platform selection must be added before rolling out to machines that cannot execute Bun's normal x64 target. Large simultaneous rollouts behind one public IP should be staggered because release discovery currently uses GitHub's unauthenticated API. A signed static channel manifest is the better next step for a larger fleet.
