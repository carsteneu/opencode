# Proving a change in this fork

What to run before claiming something works. This is deliberately separate from
[`upstream-merge.md`](upstream-merge.md): the merge document asks whether a merge lost work, this one asks whether
a change is actually correct. Every number below was measured on this machine; treat them as calibration, not
guarantees.

## 1. The floor: lint and typecheck

```bash
bun run check          # turbo: oxlint + tsgo across all packages, currently 35/35
```

Lint here is not cosmetic. The `anti-slop` rules forbid `unknown` parameters, anonymous-widened bindings and
`Reflect`, so a "clever" generic usually has to be rewritten before it passes. A red lint is a design signal, not
a formatting issue.

## 2. A failure count without a baseline is worthless

Run the same command on `workingv2` **first**, capture the failure names, then compare sets — never totals.
At the v2.2.5 merge the baseline had 79 failures and the merge 44; the difference was environment noise, not
progress. Set comparison answers "did I break something"; a count answers nothing.

Known failures that are **not** caused by your change:

| Test | Why |
|---|---|
| `packages/tui/test/component/dialog-shell-output.test.tsx` | also fails on `workingv2` |
| `packages/session-ui/component-tests/*.spec.ts` | collected by `bun test`, but they expect Playwright |
| watcher, network, clock tests in `packages/core` | flake under load, pass alone |

## 3. Always isolate `XDG_DATA_HOME`

```bash
mkdir -p /tmp/xdg-test && XDG_DATA_HOME=/tmp/xdg-test bun test
```

Upstream imports `global.data/auth.json` into the credential tables when it bootstraps a **fresh** database
(`478de99765`). A suite run against the real home therefore depends on the developer's credentials:
`packages/core/test/credential.test.ts` and `integration.test.ts` are 12 of 22 red on a machine with an
`auth.json`, and 22/22 green with an isolated root — on the merged tree and on pristine upstream alike. This is
missing test isolation, not a regression, and it will keep costing hours until the fork's test setup sets `XDG`.

## 4. Database-layer changes

Touching `packages/core/src/database/*` reaches everything that opens a database, so the short list is not enough.

```bash
cd packages/core
bun test test/database.test.ts test/database-drizzle.test.ts test/migration.test.ts \
         test/util/effect-flock.test.ts
XDG_DATA_HOME=/tmp/xdg-test bun test                    # full suite, ~5 min, 7000+ tests
cd ../server && XDG_DATA_HOME=/tmp/xdg-test bun test     # every route reads the DB
```

Behaviour worth pinning explicitly, because a silent change hides here:

- **Lock handling.** A locked statement must be retried cooperatively (schedule that yields), not by a blocking
  busy handler: assert that another fiber keeps running while a statement waits, that the retry succeeds once the
  lock is released, that it gives up inside its budget, and that a non-lock error is not retried. The fork's
  implementation lives in `packages/core/src/database/lock-retry.ts`, with the tests in
  `test/sqlite-lock-retry.test.ts`.
- **Transactions keep their own ownership.** A statement inside a transaction is not retried on its own; the owner
  rolls back and retries the transaction.
- **Migration resolution.** The registry must still name the fork migration ahead of upstream's, and a fresh
  database must reach the same schema as a migrated one (compare `pragma_table_info` and `sqlite_master`, not
  `dump`).

## 5. Performance, when a hot path changed

A wrapper in the statement path costs something on every query. Measure instead of assuming:

- Alternate the two variants round by round (same process, same data, warm-up first) so thermal drift hits both.
- Report the **median of three**, plus microseconds per statement — a percentage alone hides the absolute cost.
- For the lock retry's client proxy the measured delta is recorded in the commit that introduced it; re-measure
  before changing the seam (client proxy versus connection-level hook).

## 6. The gate that outranks all of the above: a real start

```bash
cd packages/cli && bun run release:patched <x.y.z-patched.n>
```

That script runs the fork's release gate itself: pin check, build, version assertions, and a PTY smoke on a fresh
XDG root (`--standalone`, ~25 s). Pass criteria: the expected version, `plugin reconciliation completed`, no crash
markers, and **zero `level=ERROR`**. A green suite with a binary that crashes on boot is a failed change; this is
the only check that exercises the packaged artifact.

Ad-hoc equivalent when the script is too heavy:

```bash
XDG_DATA_HOME=/tmp/xdg-smoke XDG_CONFIG_HOME=/tmp/xdg-smoke/c XDG_STATE_HOME=/tmp/xdg-smoke/s \
  script -qfec 'timeout 25 <binary> --standalone' /dev/null > /tmp/smoke.out 2>&1
```

Exit 124 means it ran the full 25 s — that is the expected "did not crash".

## 7. What still needs a human

Tests prove code, not features. Images in the transcript, diff expansion, notes and replay are visual: they need
a real terminal and a real session. Say so explicitly instead of letting a green suite stand in for a feature
check.
