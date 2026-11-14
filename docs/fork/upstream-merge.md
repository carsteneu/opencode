# Upstream merge — how this fork takes a new upstream release

Applies to the `workingv2` line in this repository. Upstream is `origin` (`sst/opencode`, redirecting to
`anomalyco/opencode`); the fork is `fork` (`carsteneu/opencode`).

Every number below was measured during a real merge; the running example is v2.2.5 (981 commits, 3881 files,
57 conflicts, 02./03.11.2026) with the v2.3.0 outlook (890 commits, 6404 files, 0 new migrations).
Read this before starting; follow it in order. `PROJECT_RULES.md` rule 15 makes the first two steps mandatory.

## Phase 0 — Preconditions

```bash
git -C /home/chief/projects/opencode status --porcelain      # must be empty
git rev-parse --abbrev-ref HEAD                              # workingv2
git fetch fork && git rev-list --left-right --count fork/workingv2...HEAD   # 0  0
git fetch origin --tags
```

`workingv2` does not move during the merge. The merge happens in a worktree on its own branch.

## Phase 1 — Measure the delta before touching anything

```bash
git rev-list --count <old-tag>..<new-tag>
git diff --stat <old-tag> <new-tag> | tail -1
git diff --name-only --diff-filter=A <old-tag> <new-tag> -- packages/core/src/database/migration | wc -l
git diff <old-tag> <new-tag> -- CHANGELOG.md | grep '^+' | grep -E '^#### ' | grep -viE 'improvements|bug fixes'
```

Three answers decide the shape of the work:

| Answer | Consequence |
|---|---|
| New migrations = **0** | No DB rehearsal, no snapshot. (v2.2.5→v2.3.0: 0) |
| New migrations > 0 | Plan the upgrade rehearsal from Phase 5, and take a DB snapshot first |
| Breaking changes listed | Check each against fork-owned code before merging, not after |

Then the conflict forecast — the files both sides changed:

```bash
comm -12 <(git diff --name-only <old-tag> HEAD | sort) \
         <(git diff --name-only <old-tag> <new-tag> | sort) | wc -l
```

v2.2.5→v2.3.0: fork delta 315 files, overlap 86. The overlap is where the time goes; the rest is
upstream's own code and is not the review target.

## Phase 2 — Worktree and branch

```bash
cd /home/chief/projects/opencode
git worktree add -b upstream-<target> .worktrees/upstream-<target> workingv2
cd .worktrees/upstream-<target>
git merge-base HEAD <new-tag>          # note it: the proof suite needs it
```

## Phase 3 — Merge

```bash
git merge --no-ff <new-tag>
```

`--no-ff` is mandatory (rule 6: no squashing). Never rebase: the fork is published and tagged, a rebase
forces a push and breaks tags. Never merge a moving branch (rule 9) — only the release tag.

## Phase 4 — Resolve by class, not by file

Order matters; later steps build on earlier ones.

1. **`package.json`** (v2.2.5: 42 files, nearly all version-only) — take upstream, then re-apply the fork's
   additions: remove the three `@opentui/*` lines from `overrides` (the v2 line runs stock OpenTUI, guarded
   by `script/check-opentui-pin.ts`), keep the `check:opentui-pin` script, keep
   `build:patched`/`release:patched` in `packages/cli`, keep `marked` in `packages/tui` when its markdown
   code imports it.
2. **`bun.lock`** — `git checkout --theirs -- bun.lock`, then `bun install`. Never hand-merge.
3. **Generated files** — take upstream, then regenerate:
   - `packages/core/{schema.json,src/database/migration.gen.ts,schema.gen.ts}`:
     `cd packages/core && bun run migration`. **Trap:** the generator re-emits the fork's indexes (defined in
     `packages/core/src/session/sql.ts`) as a new migration, because upstream's snapshot does not know them.
     Delete the generated file, run again, expect `No schema changes, nothing to migrate`, then check that
     the fork migration `session_list_indexes` is still in the registry ahead of upstream's.
   - `packages/client/src/effect/api/api.ts` and `packages/client/src/promise/generated/types.ts`:
     `cd packages/client && bun run generate`. The diff must be tiny (fork events such as
     `session.tool.input.progress` come back). Never hand-edit generated surfaces (rule 10).
   - `services/www/openapi.json` and `public/openapi.json`: upstream generates and gitignores them — accept
     the deletion.
4. **`AGENTS.md`** — upstream tracks it, this fork does not. Resolve with `git rm AGENTS.md`; upstream's copy
   is never committed.
5. **Upstream rewrites a module the fork patched** — upstream wins, and the fork's tests move to the new
   contract, with the reason in the commit. Example: v2.2.5 replaced `markdown-stream.ts` with the patchmark
   engine, which made the fork's in-place tail extension obsolete.
6. **TUI files carrying fork features** — `packages/tui/src/routes/session/index.tsx` is the recurring hot
   spot. Keep the fork features (image bands, diff-set summary, `BoundedDiff`, notes/replay wiring), take
   upstream's layout and prop changes. Never `git checkout --ours -- <directory>`: a directory-wide `--ours`
   once dropped upstream's additive workflow steps, and local tests could not see it (only CI could).
7. **Imports and additive changes** — union, never drop a side. Typecheck finds unused imports, not forgotten
   functions.

## Phase 5 — Prove it

1. **Conflict markers:** `git grep -nE '^(<<<<<<< |>>>>>>> )'`. Git is German-localised here — the merge
   prints `KONFLIKT`, not `CONFLICT`.
2. **Set intersections** (no direction merged silently wrong):
   upstream-deleted ∩ fork-modified, fork-deleted ∩ upstream-modified, add/add.
3. **Tree integrity:** `git ls-tree -r --name-only` for both parents, the merge base and the merge. A file
   present in **both** parents but missing from the merge is a real resolution drop. v2.2.5: 7470/7470
   present, 0 drops.
4. **Delta-of-deltas** for every fork-touched file: the fork delta before the merge versus after. Identical
   deltas prove neither loss nor double insertion.
5. **Fork features survive** — adapt the list per merge: `lowersDocument`, `isOfficeMediaType`,
   `session.tool.input.progress` plus its client union, the fork migration in the registry, image bands,
   apply-patch summary, `BoundedDiff`, notes/replay, `build:patched`/`release:patched`,
   `check:opentui-pin`, `.github/workflows/build-patched-v2.yml`,
   `packages/util/src/installation/fork-release.ts`, `AGENTS.md` still deleted.
6. `bun run check` from the repo root — Turbo lint + typecheck, currently 35/35.
7. **Tests per package, always against a baseline.** Run the same packages on `workingv2` first and compare
   the failure lists. Without a baseline the number is worthless: at v2.2.5 the baseline had 79 failures and
   the merge 44, and the difference was environment noise, not progress.
   Known non-merge failures: `packages/tui/test/component/dialog-shell-output.test.tsx` also fails on
   `workingv2`; `component-tests/*.spec.ts` are collected by `bun test` but expect Playwright; watcher,
   network and clock tests fail under load and pass alone.
8. **Migration rehearsal** only when Phase 1 reported new migrations: copy the real database into its own
   XDG root, start there, then compare migration count, session/message counts, `pragma quick_check`, and the
   table diff between a fresh and a migrated database. v2.2.5: 34 843 sessions / 476 641 messages intact.
9. **Smoke gate** (always): fresh XDG root, PTY, `--standalone`, ~25 s. Expect no crash markers, the exact
   version, `plugin reconciliation completed`, and **zero `level=ERROR`**. `bun run release:patched <version>`
   performs this gate itself.

## Phase 6 — Land it

- Merge commit explains each resolution class; "resolved conflicts" is not an explanation.
- Move `workingv2` with a **fast-forward onto the reviewed commit** (`git merge --ff-only <sha>`). The rule
  guard refuses a merge from a moving branch, and a fast-forward onto an immutable commit is the compliant
  form.
- Remove the worktree and the branch afterwards.
- Tag **annotated, on `workingv2`**, then `git push fork workingv2`, then `git push fork <tag>`. The tag push
  starts `build-patched-v2` and publishes on its own.
- Locally: replace the binary atomically (`cp` to `.new`, `chmod`, `mv`), keep the previous one as
  `opencode.backup-<date>-<version>`, and restart the service — that is when migrations go live.

## Traps, collected

| Trap | What happens |
|---|---|
| German git locale | Conflicts read `KONFLIKT`; an English grep finds nothing |
| Migration generator | Re-emits fork indexes as a duplicate migration → drop it and regenerate |
| Generated client | Loses fork events silently; `bun run generate` restores them in a 4-line diff |
| Directory-wide `--ours` | Drops upstream's additive edits (workflow steps); only CI catches it |
| Moving branch | `git merge upstream-225` is refused; fast-forward onto a commit instead |
| Rule guard on push | Push/tag need an explicit request in the session, not a quoted one |
| Baseline-free tests | Any failure count is uninterpretable without `workingv2` as reference |
| Non-zero exits in shell | `grep`/`test` return 1 legitimately; a failing command is not necessarily a real failure |
