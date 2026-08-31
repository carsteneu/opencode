---
name: patched-releases
description: Use when building, publishing, or bumping patched OpenCode releases (1.x.y-patched.N), migrating the OpenTUI asset pin, fixing self-update/upgrade-channel issues, or when release:patched / sync-opentui-overlay / build-patched-matrix fail.
---

# Patched Releases (OpenCode Fork)

## Overview

Fork releases are `x.y.z-patched.n` prereleases published on `carsteneu/opencode`.
Two pipeline paths exist for x64 Linux; cross-platform builds use CI.

## Non-Negotiables

- **Version base must be ≥ upstream `sst/opencode` stable.** Semver treats
  `1.18.25-patched.N` < `1.18.25`, so an outdated base lets the official
  release outrank the fork and the self-update swaps the binary. Bump the base
  with upstream.
- `packages/opencode` `version` field must equal the release base.
- Patched builds are only ever **built via `build:patched`** (sets
  `OPENCODE_UPDATE_CHANNEL=patched`). Plain `script/build.ts` builds get the
  stable channel and the updater replaces them with official builds.
- Upgrades from patched builds to non-patched targets are refused in
  `Installation.upgrade` (`canUpgradeToTarget`, installation/index.ts).
- Never publish via local rebuild while a CI/native mismatch is unresolved —
  the pin hashes exist to catch exactly that.

## Path A: CI (any platform, preferred)

1. Restore/keep `.github/workflows/build-patched-matrix.yml` on `working` (it
   lives on the fork default branch `dev`; cherry-pick from
   `fork/yesloop/multi-platform-build` if missing) and keep its
   `opentui_ref` default at the pinned opentui commit.
2. Dispatch: `gh workflow run build-patched-matrix.yml --ref working -f
   version=<ver> -f publish=true`
3. GitHub resolves `workflow_dispatch` **by filename only against the default
   branch** — the file must exist on `dev` too, or dispatch and the
   filename-API both 404. Raw-API workaround dispatches by workflow ID.
4. CI creates a **draft** release with binaries + checksums (checksum
   round-trip verified in-pipeline). Publish it:
   `gh release edit <ver> --repo carsteneu/opencode --draft=false`
   (drafts are invisible to the self-update channel).

## Path B: Local Linux-only

`bun run release:patched <version> --publish` from `packages/opencode`.
Requirements: branch `working`, clean tree, `OPENTUI_ROOT` pointing at a
**built** opentui worktree at the pin commit (checkout alone lacks
`packages/core/dist`), `sync-opentui-overlay --check` green, Ghostty smoke
passed.

## OpenTUI Pin Migration (new opentui fork release)

1. Worktree at the new tag: `git worktree add … <tag>`.
2. Download the 4 release tarballs (core, core-linux-x64, keymap, solid) from
   `carsteneu/opentui` and extract (strip `package/`) into their
   dist/node_modules slots. Do **not** rebuild locally — zig native bytes are
   not reproducible across environments; only the GitHub CI tarball bytes
   match the recorded hashes.
3. Update constants in `script/sync-opentui-overlay.ts`: commit, tag, patch
   base (= `git merge-base <old> <new>`), version, and the 4 hashes
   (verified: core/solid/keymap hash-identical across environments; native
   changes with toolchain).
4. Update the catalog URLs in root `package.json` to the new tag, `bun
   install`, re-run `sync-opentui-overlay --check` until "Pinned OpenTUI
   overlay verified".
5. Commit, push, then run the release (Path A or B).

## Gotchas

- `cat`-style hash mismatch on `native` after a clean checkout is the missing
  dist build, not a pin drift — install/extract first, verify version at
  `packages/core/node_modules/@opentui/core-linux-x64/package.json`.
- Fork default branch is `dev`; `working` is the release branch. Fork must be
  fetched (`git fetch fork dev`) before comparing.
- After publishing: restart running TUIs (old binaries keep pre-fence
  update behavior), verify with `opencode --version`.
- Perf doctrine lives in `script/perf/AGENTS.md`; interactive boot A/B runs
  `script/perf/ab-server-boot-sampled.sh` (CPU-normalized, TUI quit needs
  double Ctrl-C).
