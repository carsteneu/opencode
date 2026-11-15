# Fork notes

This is a personal fork of [anomalyco/opencode](https://github.com/anomalyco/opencode) on the v2 line. It tracks
upstream and carries a handful of additions on top. Upstream's own documentation still applies;
this file only records what is different here.

Current base: upstream **2.3.0**.

## Taking a new upstream release

Two documents describe the working agreement: [`docs/fork/upstream-merge.md`](docs/fork/upstream-merge.md) for
taking a new upstream release, and [`docs/fork/testing.md`](docs/fork/testing.md) for what has to be proven
before a change counts as working (baseline sets, isolated `XDG_DATA_HOME`, the database matrix, the
packaged-binary smoke gate).

The merge procedure: measure the delta first, merge the release tag `--no-ff` in its own worktree, resolve
conflicts by class, prove the result with the file-set and delta checks, then fast-forward `workingv2` and push
the branch before the tag.

## Install and update

Releases come from `carsteneu/opencode`, not from upstream. The fork publishes into the release
channel `patched`, built from `workingv2`.

```
opencode upgrade
```

That reads the fork channel and installs the newest prerequisite from it. `packages/util/src/installation/fork-release.ts`
is the single place that defines repository, channel, tag pattern and asset names; the updater and
the build script both read it, so they cannot drift apart.

After the binary changes, restart the background service:

```
opencode service restart
```

`opencode run` talks to that service, not to the binary on disk. Without the restart a fresh session
still runs the old code. The restart also ends every agent currently running, so do it between
tasks, not in the middle of one.

Only Linux x64 is built: one asset, `opencode-linux-x64`, plus a `.sha256` sidecar. There is no
macOS or Windows build, and the updater reports no update on other platforms rather than failing.

## What this fork adds

| Area | Behaviour |
| --- | --- |
| Prompt notes | A sidebar block per session for questions that do not belong in the transcript: `alt+n` adds, `alt+s` parks what is typed in the prompt, `▤` opens a captured answer, `▶` sends, `✎` edits, `✖` deletes. `notes.history` opens a searchable list; more than eight notes collapse behind a row that opens it |
| Prompt parking | The footer button and `alt+s` take the composer's text as an open note and empty the field |
| Sidebar | Draggable at its left edge, 32 to 72 columns, width survives a restart |
| Image previews | Images in a session render inline and stay visible while a turn streams |
| Replay pane | Shows the steps of a turn with their diffs |
| Todo list | `todowrite` is on by default. `"experimental": { "todo": false }` in `opencode.json` turns it off |
| Exit | `/exit` and the palette's exit command leave at once; `ctrl+c` keeps its two-press guard |

Fork-only scripts live in `packages/cli/package.json`: `build:patched` and `release:patched`. They do
not exist upstream, so a manifest merge must never replace that file wholesale.

## Release ritual

1. `workingv2` clean and in sync with `fork/workingv2`.
2. `bun run check` green.
3. Tag `2.3.0-patched.N` on the merge commit, push the tag.
4. CI builds `opencode-linux-x64` and publishes a prerelease.
5. Verify the download against the `.sha256` sidecar before installing it.

Versions in the `patched` channel are ordered by version, not by date, and every release is a
prerelease.

## Known quirks

`packages/tui/test/app-lifecycle.test.tsx` has two tests that fail under full-suite load and pass
when run alone, including on a clean upstream tree. Treat a failure there as environmental until it
reproduces in isolation.

The `experimental` keys are core configuration and belong in `~/.config/opencode/opencode.json`;
`cli.json` only accepts TUI keys.
