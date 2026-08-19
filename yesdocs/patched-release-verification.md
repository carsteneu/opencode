# OpenCode Patched Release: wiederholbare Gesamtprüfung

Dieses Dokument ist die kanonische Prüfliste für jeden neuen `x.y.z-patched.n`-Kandidaten. Es bündelt die
dauerhaften Invarianten aus den historischen Performance-, Stabilitäts- und Safety-Arbeiten. Historische
Messwerte bleiben in den anderen `yesdocs`-Dateien erhalten; hier stehen die wiederholbaren Gates.

Ein Kandidat ist nur freigegeben, wenn alle als **immer** markierten Gates grün sind, alle zum Diff passenden
bedingten Gates ausgeführt wurden und jeder Skip oder Ausreißer erklärt und reproduzierbar eingegrenzt ist.
Eine bloße Erhöhung von Test-Timeouts ersetzt keine Ursachenanalyse.

## 1. Unverhandelbare Regeln

1. Gepatchte Builds, lokale Installationen, Tags und Prereleases entstehen ausschließlich aus `working`.
   `dev` bleibt reine Upstream-Synchronisation.
2. Tests werden aus dem jeweiligen Paketverzeichnis gestartet, niemals aus dem Repository-Root.
3. Ein Publish läuft nur aus einem sauberen, committeten `working`. Ein Dirty-Tree-Build darf ausschließlich
   ein lokaler, klar so bezeichneter Testkandidat sein.
4. Der gepinnte OpenTUI-Quellstand, Core, Solid und die native Bibliothek bilden eine Einheit. Ein Build mit
   gemischten Versionen oder ungeprüftem Bun-Store ist ungültig.
5. Laufende Benutzer-TUIs werden für Messungen nicht attached, signalisiert, per API abgefragt oder
   neugestartet. Produkt-A/Bs verwenden eigene isolierte Prozesse, Homes, XDG-Verzeichnisse und Sessions.
6. Das Powerprofil wird vor, während jedes Messbins und nach jeder Messung protokolliert. `balanced`,
   `power-saver` und `performance` dürfen nicht roh miteinander verglichen werden. Mixed/unknown gilt nur als
   Trend, nie als absolute Referenz.
7. Gleich benannte Kennzahlen werden nur bei identischem Workload, Terminal, Warmup, Messfenster, Prozessbaum
   und Hostprofil verglichen. `100 % CPU` bedeutet einen vollständig belegten logischen Kern.
8. Große Vorschauen dürfen korrekt fehlen; abgeschnittene oder syntaktisch ungültige Patches dürfen niemals
   als Ersatz persistiert, genehmigt oder angewendet werden.
9. Jede Version erhält ein Ergebnisblatt mit Git-, Overlay-, Binary-, Test-, Mess- und Rollback-Provenienz.

## 2. Ergebnisblatt vorbereiten

Vor dem ersten Gate diese Werte festhalten:

| Feld                                | Wert              |
| ----------------------------------- | ----------------- |
| Kandidat                            | `x.y.z-patched.n` |
| Vorherige akzeptierte Version       |                   |
| Vorheriger Git-Ref                  |                   |
| Baseline-Binary / SHA-256           |                   |
| Datum/Zeitzone                      |                   |
| Branch / HEAD / Tree                |                   |
| Vorheriger Tag / Merge-Base         |                   |
| Bun / Kernel / Architektur          |                   |
| OpenTUI HEAD / Tag / Version        |                   |
| OpenTUI Core-/Solid-/Native-Hash    |                   |
| Testhost / CPU / Kerne              |                   |
| Powerprofil                         |                   |
| Buildpfad / Größe / SHA-256         |                   |
| Installationspfad / Inode / SHA-256 |                   |
| Rollbackpfad / SHA-256              |                   |
| bekannte Skips / Hostabweichungen   |                   |
| Rohdatenverzeichnis                 |                   |
| Sampler / Fake-Provider / Fixture   |                   |
| Yesmem-Learning-IDs                 |                   |

Empfohlene Shellvariablen:

```sh
export VERSION=x.y.z-patched.n
export PREVIOUS_VERSION=x.y.z-patched.m
export PREVIOUS_REF="<tag-or-commit>"
export BASELINE_ARTIFACT=/path/to/previous/opencode
export OPENTUI_ROOT=/path/to/pinned/opentui
export ARTIFACT="$PWD/packages/opencode/dist/opencode-linux-x64/bin/opencode"
export INSTALLED="$HOME/.opencode/bin/opencode"
export RESULT_ROOT="/tmp/opencode-release-$VERSION"
export PERF_SAMPLER=/path/to/hash-pinned/proc-tree-sampler
export FAKE_PROVIDER=/path/to/hash-pinned/fake-provider
export LARGE_SESSION_EXPORT=/path/to/hash-pinned/large-session-export.json
mkdir -p "$RESULT_ROOT"
```

`RESULT_ROOT` darf Rohdaten enthalten, gehört aber nicht in einen Commit.

## 3. Abdeckungsmatrix

| ID  | Verbesserungsfamilie          | Kerninvariante                                                                          | Frequenz     |
| --- | ----------------------------- | --------------------------------------------------------------------------------------- | ------------ |
| P01 | Branch, Integration, Upstream | `working` enthält den freigegebenen Stack; `dev` bleibt unverändert                     | immer        |
| P02 | OpenTUI-Overlay und ABI       | gepinntes 0.5.3-Overlay; Core, Solid, Spinner-Peers und Native passen exakt             | immer        |
| P03 | Migrationen und Generatoren   | keine Schema-, Client- oder Legacy-SDK-Drift                                            | immer        |
| P04 | Typen und Format              | alle betroffenen Paket-Typechecks, Prettier und Diff-Check grün                         | immer        |
| R01 | Prozess- und Startupgrenzen   | TUI, Server und AI-Worker getrennt; Lazy-Imports und Cleanup bleiben intakt             | immer        |
| R02 | Worker-Streaming              | 200-ms-Text-/Reasoning-/Toolinput-Coalescing, sofortiges erstes Delta, ACK/Reihenfolge  | immer        |
| R03 | Provider-Safety               | Header-/Body-/Chunk-Timeouts, Clone/Cancel, Statuspriorität und Retry-Stopp             | immer        |
| R04 | Eventtransport                | private TUI-IPC, begrenztes öffentliches SSE, Settling und Listener-Cleanup             | immer        |
| R05 | Markdown und Renderer         | Append-Provenienz, stabiler Tail, layoutsaubere Updates, Dirty-Region-Partial-Render    | immer        |
| R06 | Footer und Timer              | direkte feste PartialText-Zellen, NBSP-Clearing, kein Idle-Timer, Spinner 40 ms         | immer        |
| R07 | History und Step-Grenzen      | Fenster/Paging/Anchor, kompaktierte History, Snapshot-Reuse und Tool-Metadata-Race      | immer        |
| R08 | Diff-Budgets                  | Eingabe, Generierung, Tool-, Snapshot- und Revert-Vorschau hart begrenzt                | immer        |
| R09 | Tool- und Payload-Budgets     | Webfetch, Media, Edit-Matching, strukturierte Outputs, Spill und Notifications begrenzt | immer        |
| R10 | DB, Sync und Background       | Busy/Locked-Retry, Indizes, atomarer Replay, Workspace-Scope und Job-Konsum             | immer        |
| R11 | Bilder                        | SSRF-/Byte-/Pixel-Grenzen, Native-Lifecycle, Residency, Save- und Symlink-Safety        | immer        |
| R12 | Updater und Deployment        | Fork-Prerelease, Checksumme, exakte Version, atomarer Tausch und Rollback               | immer        |
| R13 | Logging und Profiling         | Rotation, kein Zero-Loop, keine permanente Frame-Instrumentierung                       | immer        |
| B01 | echtes Idle                   | kein Worker/Tool/I/O, keine periodischen Full-Frames, stabiler Prozessbaum              | jede Version |
| B02 | kontrolliertes Streaming      | identische Deltas; Task-clock/Cycles/Instructions pro Byte gegen Vorgänger              | jede Version |
| B03 | große Session                 | Footer/Retained-Rendering ohne periodischen Root-Render; CPU und Context-Switches       | jede Version |
| B04 | Worker-Pool                   | ein wiederverwendeter Worker, bounded lifetime und kein Provider-Reinit pro Turn        | jede Version |

## 4. Provenienz und Repository-Hygiene

### P01 – Branch und Commit

```sh
test "$(git branch --show-current)" = working
test "$("$BASELINE_ARTIFACT" --version)" = "$PREVIOUS_VERSION"
sha256sum "$BASELINE_ARTIFACT" | tee "$RESULT_ROOT/baseline-artifact.sha256"
git rev-parse HEAD
git rev-parse HEAD^{tree}
git merge-base --is-ancestor "$PREVIOUS_REF" HEAD
git rev-list --left-right --count fork/working...working
git status --short
git diff --check
git log --oneline "$PREVIOUS_REF"..HEAD
```

Für einen Publish muss `git status --short` leer sein. Bei einem lokalen Dirty-Tree-Kandidaten werden der
vollständige tracked Diff und alle ungetrackten Inhalte separat, nullbyte-sicher und mit Prüfsumme archiviert:

```sh
git status --short > "$RESULT_ROOT/git-status.txt"
git diff --binary "$PREVIOUS_REF" > "$RESULT_ROOT/tracked-source.patch"
git ls-files -z --others --exclude-standard > "$RESULT_ROOT/untracked-files.zlist"
tar --null --files-from="$RESULT_ROOT/untracked-files.zlist" -cf "$RESULT_ROOT/untracked-files.tar"
sha256sum "$RESULT_ROOT/tracked-source.patch" "$RESULT_ROOT/untracked-files.tar" \
  > "$RESULT_ROOT/source-inputs.sha256"
```

Damit ist auch ein Kandidat mit neuen Produktions-, Test- oder Dokumentationsdateien später exakt auditierbar.
Ein Testcount darf steigen; ein ungeklärter Rückgang gegenüber dem letzten akzeptierten Lauf ist ein Gate-Fehler.

Bei Cherry-picks oder neu aufgebauten Integrationsstacks zusätzlich Tree- und stabile Patch-IDs vergleichen,
damit inhaltsgleiche Commits weder fehlen noch doppelt eingespielt werden. Vor Publish muss
`fork/working...working` exakt `0 0` ergeben.

### P02 – OpenTUI und aktive Abhängigkeiten

Die aktuelle Quelle des Sync-Skripts ist verbindlich; keine Hashes aus historischen Dokumenten übernehmen.

```sh
git -C "$OPENTUI_ROOT" status --short --untracked-files=no
git -C "$OPENTUI_ROOT" ls-files --others --exclude-standard
git -C "$OPENTUI_ROOT" rev-parse HEAD
git -C "$OPENTUI_ROOT" describe --tags --always
OPENTUI_ROOT="$OPENTUI_ROOT" bun run script/sync-opentui-overlay.ts --check
```

Erwartet:

- Quellworktree tracked-clean und exakt am im Skript gepinnten Commit. Untracked Orchestrierungsmetadaten
  werden im Ergebnisblatt benannt und dürfen keine Buildquelle sein.
- Core, Solid und Linux-x64-Native jeweils `(verified)`.
- Paketversion und Dependency-Slots identisch.
- Keine Marker oder Artefakte späterer unfertiger OpenTUI-Wellen.

Aktive Auflösung aus `packages/tui` prüfen:

```sh
cd packages/tui
bun -e 'console.log(await import.meta.resolve("@opentui/core")); console.log(await import.meta.resolve("@opentui/solid")); console.log(await import.meta.resolve("opentui-spinner"))'
bun -e 'import { Renderable } from "@opentui/core"; import { SpinnerRenderable } from "opentui-spinner"; console.log(SpinnerRenderable.prototype instanceof Renderable)'
cd ../..
```

Der letzte Befehl muss `true` ausgeben. Falls Overlay, Lockfile oder OpenTUI geändert wurden, in einem
wegwerfbaren Worktree zusätzlich:

```sh
cd "$OPENTUI_ROOT"
bun install --frozen-lockfile
bun run fmt:check
bun run lint:ci
bun run test
bun run build
cd -
OPENTUI_ROOT="$OPENTUI_ROOT" bun run script/sync-opentui-overlay.ts --apply
OPENTUI_ROOT="$OPENTUI_ROOT" bun run script/sync-opentui-overlay.ts --check
```

`--apply` mutiert den lokalen Bun-Store und läuft deshalb nie unbemerkt im Hauptworktree.

### P03 – Migrationen und generierte Quellen

```sh
(cd packages/core && bun run migration --check)
./packages/sdk/js/script/build.ts
(cd packages/client && bun run check:generated)
git diff --check
```

Nach dem Generatorlauf darf auf einem sauberen Release-Commit kein Restdiff entstehen. Bei Änderungen am
öffentlichen Protocol oder Server-`HttpApi` ist `packages/client` zwingend. Die generierten Client-Verzeichnisse
werden nie von Hand editiert.

### P04 – Typechecks und Format

```sh
for package in core llm schema protocol server client sdk-next opencode tui app session-ui; do
  (cd "packages/$package" && bun typecheck)
done
(cd packages/sdk/js && bun typecheck)
git diff -z --name-only --diff-filter=ACMR "$PREVIOUS_REF" -- '*.ts' '*.tsx' '*.md' '*.json' \
  | xargs -0 -r bunx prettier --check
git ls-files -z --others --exclude-standard -- '*.ts' '*.tsx' '*.md' '*.json' \
  | xargs -0 -r bunx prettier --check
git diff --check "$PREVIOUS_REF"
while IFS= read -r -d '' file; do
  code=0
  git diff --no-index --check /dev/null "$file" >/dev/null 2>&1 || code=$?
  test "$code" -le 1 || {
    git diff --no-index --check /dev/null "$file"
    exit "$code"
  }
done < <(git ls-files -z --others --exclude-standard)
```

Kein `tsc` direkt starten. Bestehende Warnungen müssen im Ergebnisblatt namentlich stehen; neue Warnungen sind
nicht automatisch akzeptiert.

## 5. Fokussierte Funktionsgates

Diese Matrix läuft vor den Vollsuiten und liefert bei einem Fehler die präzisere Zuordnung.

### Statische Cadence- und Architekturanker

Diese Werte sind bewusst verschieden und dürfen nicht bei einer vermeintlichen Optimierung vereinheitlicht
werden:

```sh
rg -n 'targetFps: 30' packages/tui/src/app.tsx
rg -n 'if \(elapsed < 100\)' packages/tui/src/context/sdk.tsx
rg -n 'deltaFlushMs = 200|deltaFlushBytes = 64 \* 1024' packages/opencode/src/session/llm/ai-process-worker.ts
rg -n 'interval=\{40\}' packages/tui/src/component/prompt/index.tsx
rg -n 'TOOL_INPUT_PROGRESS_INTERVAL = 500' packages/opencode/src/session/processor.ts
```

Erwartet: Renderer 30 fps, SDK-Publikation 100 ms, Worker 200 ms, Prompt-Spinner 40 ms,
Tool-Input-Fortschritt 500 ms. Außerdem statisch prüfen: kein 150-ms-Scrollpolling, kein permanentes
Per-Frame-Logging und kein wieder eingeführter Cache vollständiger Assistant-JSX-Bäume.

### Core: Timeouts, Diffs, Datenbank und begrenzte Tools

```sh
cd packages/core
bun test --timeout 30000 \
  test/aisdk-timeout.test.ts \
  test/sqlite-retry.test.ts \
  test/text-diff.test.ts \
  test/snapshot.test.ts \
  test/tool-edit.test.ts \
  test/tool-write.test.ts \
  test/tool-read.test.ts \
  test/tool-read-filesystem.test.ts \
  test/tool-webfetch.test.ts \
  test/tool-websearch.test.ts \
  test/background-job.test.ts \
  test/event.test.ts \
  test/event-maintenance.test.ts \
  test/config/provider.test.ts \
  test/effect/cross-spawn-spawner.test.ts \
  test/message-diff.test.ts \
  test/tool-output-store.test.ts \
  test/tool-skill.test.ts
cd ../..
```

Sollinvarianten:

- Jeder unbenutzte/unlocked Response-Body erhält einen demand-lazy Timeout; `null`, used und locked bleiben
  identisch.
- Ungelesene Clones starten keinen Timer/Cancel. Einseitiger Cancel lässt Geschwister leben; Timeout erreicht
  alle aktiven und späteren Branches als typisierten Fehler.
- `413` bleibt ContextOverflow; bekannte terminale `4xx` werden nicht künstlich retryable.
- `TextDiff.createBounded` prüft Identität vor Optionen, begrenzt UTF-16-Codeunits und logische Zeilentokens
  vor `diff@8` und liefert bei Überlauf Stats plus optional keinen Patch.
- Webfetch liest höchstens 5 MiB plus Sentinel, Mediengrenzen gelten während des Lesens, und leere gültige
  Antworten bleiben erlaubt.

### OpenCode: Worker, Retry, Snapshot, Legacy-Tools und Control Plane

```sh
cd packages/opencode
umask 022
bun test --timeout 30000 \
  test/provider/header-timeout.test.ts \
  test/server/httpapi-sse-teardown.test.ts \
  test/session/message-v2.test.ts \
  test/session/retry.test.ts \
  test/session/processor-effect.test.ts \
  test/session/llm-coalesce.test.ts \
  test/session/llm-process.test.ts \
  test/session/llm-process-pool.test.ts \
  test/session/messages-pagination.test.ts \
  test/session/compaction.test.ts \
  test/session/snapshot-tool-race.test.ts \
  test/session/revert-compact.test.ts \
  test/snapshot/snapshot.test.ts \
  test/tool/edit.test.ts \
  test/tool/write.test.ts \
  test/tool/apply_patch.test.ts \
  test/tool/shell.test.ts \
  test/tool/lsp.test.ts \
  test/tool/skill.test.ts \
  test/background/job.test.ts \
  test/cli/import.test.ts \
  test/cli/export.test.ts \
  test/cli/import-export-diff.test.ts \
  test/installation/installation.test.ts \
  test/control-plane/workspace.test.ts \
  test/control-plane/workspace-replay-batches.test.ts
cd ../..
```

Sollinvarianten:

- Nach dem sofortigen ersten Fragment werden kleine Text-/Reasoning-Deltas derselben `(type,id)` im
  200-ms-Fenster gebündelt. Toolinput verwendet dasselbe Zeitfenster, darf aber an der 64-KiB-Schwelle sowie an
  Typ-, ID-, Kontroll- und EOF-Grenzen bewusst früher flushen.
- Toolargumente verwenden `event.delta`, rekonstruieren Unicode exakt und halten die 64-KiB-UTF-8-Schwelle
  als High-Water-Mark. Ein einzelnes Providerfragment bleibt ungeteilt und darf die Schwelle überschreiten.
- Reihenfolge bleibt
  `tool-input-start -> deltas -> tool-input-end -> tool-call -> tool-result`; jeder Frame behält ACK-
  Backpressure.
- Der 16.066-Byte-/2.009-Fragment-Gate führt das echte Parent-Tool mit exakt geparstem Objekt aus. Der
  160-KiB-Emoji-Gate bleibt byte- und stringgenau.
- Worker-Reuse reduziert Spawn und Providerinitialisierung, ohne Error-, Abort- oder Cleanup-Zustand zwischen
  Turns zu leaken.
- Retry stoppt nach sichtbarer Modell- oder Tool-Nebenwirkung. Frühe Tool-Metadaten überleben die
  Call-ID-Registrierungsrace.
- Edit/Write/Apply benutzen 256-KiB-Budgets; Apply ist kumulativ all-or-none. Permission kommt vor Mutation,
  Reject mutiert nichts, patchlose Ergebnisse behalten Pfad und Stats.
- Snapshot-Diffs prüfen Numstat und Blobgrößen vor Content, teilen ein 250-ms-Rechenbudget und sind
  all-or-none. Revert-Vorschau begrenzt stdout/stderr, endet nach 5 s und eskaliert nach 1 s auf SIGKILL;
  Revert/Undo/Restore funktionieren ohne Preview.

### TUI: Retained Rendering, Timer, History, Diffs und Bilder

```sh
cd packages/tui
bun test --timeout 30000 --max-concurrency 1 \
  test/component/model-wait.test.ts \
  test/component/partial-text.test.tsx \
  test/routes/session-footer.test.tsx \
  test/util/token-rate.test.ts \
  test/routes/agents-status.test.ts \
  test/cli/cmd/tui/register-spinner.test.ts \
  test/cli/tui/diff-viewer.test.tsx \
  test/cli/tui/diff-viewer-file-tree.test.tsx \
  test/cli/tui/permission-diff.test.tsx \
  test/cli/tui/session-diff-output.test.tsx \
  test/prompt/history.test.ts \
  test/app-lifecycle.test.tsx \
  test/cli/cmd/tui/sync-live-hydration.test.tsx \
  test/cli/tui/session-message-window.test.ts \
  test/cli/tui/permission.test.ts \
  test/cli/tui/thinking.test.ts \
  test/util/tool-input-progress.test.ts \
  test/feature-plugins/sidebar-rename.test.tsx \
  test/component/native-image.test.tsx \
  test/component/dialog-image-preview.test.tsx \
  test/cli/tui/session-image-lazy.test.tsx \
  test/util/session-image*.test.ts
cd ../..
```

Harte Renderer-Sollwerte:

- `PartialText` in einem Baum mit mehr als 520 Renderables: lang -> kurz -> leer erzeugt je genau einen
  nativen Partial-Frame, keinen Root-/Full-Frame, keine alten Glyphen und danach 5 s null Requests/Frames.
- Footer-Aktivwert und Drei-Sekunden-Decay erzeugen je genau einen nativen 16x1-Partial-Frame; anschließend 5 s
  echte Ruhe.
- Agent-Elapsed erzeugt ausgeklappt nur den 8-Zellen-Partial-Frame, eingeklappt mindestens 1,2 s überhaupt
  keinen Timer-/Renderrequest und startet beim Aufklappen wieder partiell.
- Der Prompt-Spinner bleibt absichtlich bei **40 ms**. Nicht auf 100 ms zurückstellen; frühere A/Bs zeigten
  keinen CPU-Nutzen. Optimiert wird die Arbeit pro Tick.
- Transparente feste Textzellen verwenden NBSP auch für interne Leerstellen. ASCII-Padding allein löscht
  retained Glyphen nicht sicher.
- Dialoge, Layout- oder Topologieänderungen dürfen bewusst auf sicheren Full-Render zurückfallen.
- Output-Rate bleibt eine sichtbare Schätzung `out ~N tk/s`; CJK und versteckte Toolausgabe sind bewusst nur
  grob abgebildet.
- History-Fenster, Paging, Scrollanchor und Dedup bleiben korrekt. Patchlose Dateien bleiben als Stats-Zeilen
  sichtbar.
- Bilder werden nur aus vertrauenswürdigen abgeschlossenen Quellen geladen. HTTPS, Redirects und DNS werden
  erneut validiert; Credentials, private/spezielle Adressen sowie übergroße Header, Bodies, Dimensionen und
  Pixelmengen werden abgelehnt. Residency/LRU/Leases, höchstens zwei Native-Bilder und zwei Loader,
  Cancellation/Retry, Native-Fallback sowie atomisches Originalbyte-Speichern ohne Traversal, Symlink oder
  Überschreiben bleiben begrenzt.

### Session-UI, App, Client, LLM und SDK

```sh
(cd packages/session-ui && bun test src --timeout 30000)
(cd packages/app && bun run test:unit && bun run test:browser)
(cd packages/client && bun test --timeout 30000)
(cd packages/llm && bun test --timeout 30000)
(cd packages/schema && bun test --timeout 30000)
(cd packages/protocol && bun test --timeout 30000)
(cd packages/sdk-next && bun test --timeout 30000)
(cd packages/sdk/js && bun test)
```

Besonders prüfen:

- App behandelt zur aktuellen Revision gehörende patchlose Message-Diffs als terminal, priorisiert bei
  Duplikaten aber den echten Patch und baut Pending-Sets linear statt quadratisch.
- ACP/CLI/Session-UI/TUI behalten Pfade, Locations, RawInput, Stats und Replies, führen bei fehlendem Patch aber
  keinen synthetischen `applyPatch` aus.
- SDK akzeptiert `chunkTimeout: false` und ist generatoridentisch.
- Compaction erhält Provider-Cachepräfixe; Anthropic/OpenAI-Nachrichten und Toolreihenfolge bleiben stabil.

## 6. Vollsuiten

Vor jedem installierten oder veröffentlichten Kandidaten:

```sh
(cd packages/core && bun test --timeout 30000 --max-concurrency 1)
(cd packages/llm && bun test --timeout 30000 --max-concurrency 1)
(cd packages/schema && bun test --timeout 30000 --max-concurrency 1)
(cd packages/protocol && bun test --timeout 30000 --max-concurrency 1)
(cd packages/sdk-next && bun test --timeout 30000 --max-concurrency 1)
(cd packages/opencode && umask 022 && bun test --timeout 30000 --max-concurrency 1)
(cd packages/tui && bun test --timeout 30000 --max-concurrency 1)
(cd packages/session-ui && bun test src --timeout 30000)
(cd packages/app && bun run test)
(cd packages/client && bun test --timeout 30000)
(cd packages/sdk/js && bun test)
```

Für jeden Lauf Anzahl Tests, Assertions, Snapshots, Skips, Dauer und Hostlast notieren. Ein Test, der nur unter
Parallel-Volllast an ein bekanntes Readiness-Limit stößt, wird seriell mit unverändertem Produktassert
wiederholt und als Harnessbefund dokumentiert. Ein echter Produktfehler wird nicht als Lastflake abgetan.

Wenn OpenTUI oder sein Overlay geändert wurde, sind `bun run test`, `bun run build`, `bun run fmt:check` und
`bun run lint:ci` im OpenTUI-Root zusätzlich Pflicht; damit laufen Core-JS, Native Zig, Solid und die übrigen
Workspace-Pakete.

## 7. Manuelle Smoke-Matrix

Die Smokes laufen mit dem Kandidaten in isoliertem `HOME`/XDG und `--pure`, nicht in einer bestehenden
Benutzersession.

| ID  | Szenario                                                           | Erwartung                                                                                     |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| S01 | neue leere Session, 60 s warten                                    | kein AI-Worker, kein Busy, keine Terminal-/Storagewrites, keine periodischen Frames           |
| S02 | lange Plain-Text-Antwort                                           | flüssige Appends, keine alten Glyphen, finale Tokens exakt                                    |
| S03 | Markdown mit Heading/Liste/Tabelle/Code                            | konservativer Fallback korrekt; kein beschädigtes Markdown                                    |
| S04 | Reasoning, direkte Tool-Calls, mehrere Providerturns               | Model-Wait endet bei erster Ausgabe; Tool-/Statusreihenfolge korrekt                          |
| S05 | großes Write/Edit mit Permission Allow/Reject                      | Fortschritt begrenzt; Allow einmal, Reject ohne Mutation                                      |
| S06 | absichtlich gestallter JSON-/Eventstream                           | typisierter Timeout, Transport-Cancel, richtige Retry-/413-Priorität                          |
| S07 | Diff über 256 KiB                                                  | Patch fehlt vollständig, Pfad/Stats bleiben; kein Teilpatch                                   |
| S08 | Snapshot-/Revert-Vorschau über Budget                              | Preview fehlt, Review lädt nicht endlos; Revert und Unrevert exakt                            |
| S09 | lange Session, nach oben scrollen und zurück                       | Paging ohne Duplikate, Anchor stabil, aktives Fenster schrumpft unten                         |
| S10 | Bild laden, scrollen, busy/idle, speichern                         | höchstens zwei resident, sichere Quelle, Originalbytes atomar gespeichert                     |
| S11 | externer SSE-Client trennt/reconnectet                             | Listener/Queue bereinigt, Resync nach Overflow, private TUI bleibt IPC                        |
| S12 | zwei parallele Sessions/Subagents                                  | keine fremden Footer-/Tokenupdates, unabhängige Worker und Sessionzustände                    |
| S13 | Start ohne externe Plugins, danach Plugin/MCP öffnen und schließen | Compiler/Model/Filesystem-Suche bleiben lazy; MCP-stdio und Kinder werden vollständig beendet |

Für S06 bis S08 bevorzugt die vorhandenen automatisierten Fixtures verwenden. Manuelle Fehlerprovokation darf
keine reale Benutzerdatei, Session oder Providerabrechnung berühren.

## 8. Performance-Protokoll

Für B01 bis B03 existiert derzeit noch kein einzelner eingecheckter End-to-end-Harness. Deshalb darf ein Gate
nur dann `PASS` erhalten, wenn `PERF_SAMPLER`, `FAKE_PROVIDER`, `LARGE_SESSION_EXPORT`, ihre SHA-256-Werte,
Konfigurationen und die vollständige Invocation im Ergebnisverzeichnis archiviert sind. Fehlt einer dieser
Belege, lautet der Status `INCOMPLETE` statt einer aus freier Prosa abgeleiteten Freigabe. Ein künftiger
eingecheckter Harness ersetzt diese Übergangsregel.

### Gemeinsame Messregeln

- Baseline ist die unmittelbar vorherige akzeptierte Version, nicht der bekannte `.113`-Ausreißer.
- A/B-Arme seriell in A-B-B-A-Reihenfolge; mindestens drei frische Sessionpaare für Streamtests.
- Gleiche Binary-Architektur, Terminalgröße, Affinität, Sessiondaten, Fake-Provider und Warmup.
- Vor jedem Bin, in jedem Bin und danach `powerprofilesctl get` protokollieren.
- Keine Builds, Volltests, Indexer oder anderen Benchmarks parallel.
- Prozessbäume anhand `PID + /proc/PID/stat starttime` verfolgen; kurzlebige Worker und Tools dynamisch
  zuordnen. Nur die initiale PID zu messen ist ungültig.
- Rohdaten aufbewahren: CPU-Ticks, RSS/PSS, Context-Switches, I/O, Prozessrollen, Hostbusy, Load, Profil und
  Sessionstatus.
- Kandidat und Baseline dürfen erst verglichen werden, wenn Workload und Profil exakt übereinstimmen.
- Vor dem Lauf `test -x "$PERF_SAMPLER"`, `test -x "$FAKE_PROVIDER"`,
  `test -f "$LARGE_SESSION_EXPORT"` sowie `sha256sum` für alle drei und beide Binaries protokollieren.

### B01 – echtes Idle

1. Kandidat mit alter, vollständig geladener Session in isoliertem 200x50-Terminal starten.
2. Mindestens 20 s warm werden lassen.
3. Sicherstellen: Status idle, kein AI-Worker, kein Toolkind, keine DB-/PTY-Schreibaktivität.
4. Mindestens 60 s in 1-s-Bins messen; Profil in jedem Bin speichern.
5. Mittel, Median, p95, Maximum, Client/Server/MCP-Anteil, RSS/PSS und Context-Switches ausgeben.

Harte Fehler:

- periodischer nativer Full-/Root-Frame ohne sichtbare Änderung,
- dauerhaft laufender Footer-/Agent-Timer nach Decay/Collapse,
- AI-Worker oder Tool im angeblichen Idle,
- kontinuierliche Writes.

Historischer Kontext, **keine universellen Grenzwerte**:

| Version | Profil                            | Workload                      | Mittel / Median eines Kerns |
| ------- | --------------------------------- | ----------------------------- | --------------------------- |
| `.92`   | balanced, historisch dokumentiert | 4 echte Idle-Sessions, 7 min  | 2,62 % / 2,53 %             |
| `.120`  | balanced, pro Bin verifiziert     | eine echte Idle-Session, 50 s | 3,18 % / 2,00 %             |

Der einzelne `.120`-GC/Page-in-Ausreißer bleibt im Rohmittel enthalten. Für Freigaben zählt ein kontrolliertes
gegenwärtiges A/B, nicht das Herausschneiden unbequemer Bins.

### B02 – deterministisches Streaming

Referenzharness:

- isoliertes 156x65-Terminal,
- frische Session und leeres Projekt je Arm,
- `--pure`,
- lokaler OpenAI-kompatibler Fake-Provider,
- 240 Chunks mit exakt protokollierter Bytezahl und 25 ms Abstand,
- 8-s-Messfenster ab bestätigtem normalem Providerturn,
- mindestens drei Paare, Median berichten,
- Provider separat messen und aus Produktsummen ausschließen.

Primärmetriken: `task-clock`, Cycles, Instructions, Instructions/Textbyte, Context-Switches, Wallclock und
TUI+Server+Worker-CPU. Die historischen 18.960-Byte- und 10.080-Byte-Workloads sind verschieden und dürfen
nicht vermischt werden.

Standard-Untersuchungsschwelle: Eine reproduzierbare Verschlechterung von mehr als 10 % in Instructions/Byte,
Task-clock oder Context-Switches gegenüber der direkten Baseline stoppt die Freigabe bis zur Erklärung. Dies
ist eine Triage-Schwelle, kein plattformübergreifendes Leistungsversprechen.

Werkzeuge für die B-Protokolle liegen im Repo: `script/perf/bench_proc.py` (B01/B03-Einzelinstanz mit
Phasen-Segmenten und DB-Korrelation), `script/perf/live_process_sampler.py` + `script/perf/analyze_live_samples.py`
(Multi-Root/Parallelinstanzen). Nutzung und Regeln: `script/perf/README.md`. Rohdaten bleiben in `/tmp`,
nur Zusammenfassungen sind zu dokumentieren.

### B03 – große Session und Retained Rendering

Referenzfixture: 241 Messages, 1.767 Parts, 6,15-MB-Export, 200x50-Terminal, 20 s Warmup und ungefähr 30,5 s
Sampling je A-B-B-A-Arm. Profil künftig zwingend protokollieren; der historische `.113 -> korrigiert`-Lauf
hatte unbekannten Modus und belegt deshalb nur den relativen Effekt.

Zusätzlich zum Prozess-A/B muss der native Gate zeigen:

- Aktivwert und Decay je exakt ein 16x1-Partial-Frame,
- null Full-/Root-Frames,
- danach 5 s null Requests und null Frames.

### B04 – AI-Worker-Pool

```sh
cd packages/opencode
bun run script/bench-ai-process-pool.ts 20 | tee "$RESULT_ROOT/ai-process-pool.json"
cd ../..
```

Erwartet: gepoolter Arm verwendet einen Worker und eine Providerinitialisierung, beendet ihn beim Pool-Close
und zeigt keinen Zustandsleak. Warm-Median, p95, Spawnreduktion und Poolstats werden gespeichert; absolute
Millisekunden sind hostabhängig.

### Optionale vertiefte App-Messung

```sh
cd packages/app
PLAYWRIGHT_WORKERS=1 bun run test:bench
cd ../..
```

Die App-Benchmarks berichten Metriken, setzen aber absichtlich keine maschinenabhängigen Budgets. Bei App- oder
Timeline-Änderungen Roh-`BENCHMARK`-JSON und optional Chrome-Traces archivieren.

## 9. Build- und Binary-Provenienz

Vor dem Build Overlay erneut prüfen:

```sh
OPENTUI_ROOT="$OPENTUI_ROOT" bun run script/sync-opentui-overlay.ts --check
cd packages/opencode
OPENCODE_VERSION="$VERSION" bun run build:patched --single --skip-install
cd ../..
```

Danach:

```sh
test "$("$ARTIFACT" --version)" = "$VERSION"
sha256sum "$ARTIFACT"
stat -c '%s %a %y %d:%i %n' "$ARTIFACT"
OPENTUI_ROOT="$OPENTUI_ROOT" bun run script/sync-opentui-overlay.ts --check
git status --short
git diff --check
```

Pflichtbelege:

- exakte eingebettete Version,
- Größe, Modus, SHA-256 und Buildzeit,
- Git-HEAD/Tree und kompletter Dirty-Diff oder sauberer Commit,
- OpenTUI-Quellcommit und drei Overlay-Hashes vor und nach dem Build,
- Linux-x64-Smoke erfolgreich.

Für einen Publish denselben Commit und dieselbe Version zweimal in getrennten sauberen Worktrees bauen und
Hashes vergleichen. Abweichungen vor der Freigabe erklären; keine unbekannte Binärnondeterministik akzeptieren.

## 10. Lokale atomare Installation und Rollback

Vorher alle laufenden OpenCode-Root-PIDs mit Starttime und Exe-Inode protokollieren. Das Ersetzen des Pfads
startet sie nicht neu; bereits laufende Prozesse behalten ihre alte gelöschte Inode. Neu gestartete Prozesse
und später gespawnte Worker verwenden dagegen den neuen Pfad, wodurch vorübergehend ein gemischter Prozessbaum
entstehen kann.

Beispiel für die Installation:

```sh
old_version="$("$INSTALLED" --version)"
old_hash="$(sha256sum "$INSTALLED" | cut -d' ' -f1)"
backup="$HOME/.opencode/bin/opencode-$old_version.bak"
test ! -e "$backup"

backup_tmp="$(mktemp "$HOME/.opencode/bin/.opencode-backup.XXXXXX")"
install_tmp="$(mktemp "$HOME/.opencode/bin/.opencode-install.XXXXXX")"
install -m 0755 "$INSTALLED" "$backup_tmp"
test "$(sha256sum "$backup_tmp" | cut -d' ' -f1)" = "$old_hash"
mv -fT "$backup_tmp" "$backup"

install -m 0755 "$ARTIFACT" "$install_tmp"
test "$("$install_tmp" --version)" = "$VERSION"
test "$(sha256sum "$install_tmp" | cut -d' ' -f1)" = "$(sha256sum "$ARTIFACT" | cut -d' ' -f1)"
mv -fT "$install_tmp" "$INSTALLED"
sync -f "$INSTALLED"
```

Nachher:

```sh
command -v opencode
opencode --version
sha256sum "$ARTIFACT" "$INSTALLED" "$backup"
cmp -s "$ARTIFACT" "$INSTALLED"
stat -c '%s %a %y %d:%i %n' "$ARTIFACT" "$INSTALLED" "$backup"
```

Rollback verwendet dasselbe Staging-/Versions-/Hashverfahren in Gegenrichtung. Das Backup nie ungeprüft
direkt über das Ziel kopieren.

## 11. Prerelease und Updater

Assets ohne Veröffentlichung vorbereiten:

```sh
cd packages/opencode
OPENTUI_ROOT="$OPENTUI_ROOT" bun run release:patched "$VERSION"
cd ../..
```

Erwartet: `dist/patched-release/opencode-linux-x64` plus
`dist/patched-release/opencode-linux-x64.sha256`, exakte Version und Hash.

Erst nach Commit, sauberem `working` und vollständigem Ergebnisblatt:

```sh
cd packages/opencode
OPENTUI_ROOT="$OPENTUI_ROOT" bun run release:patched "$VERSION" --publish
cd ../..
```

Das Skript muss falschen Branch, Dirty Tree, falsche Basisversion, nicht steigende Version, falsches Overlay,
abweichenden Remote-HEAD und inkonsistente Draft-Assets ablehnen. Es veröffentlicht erst nach Download und
Vergleich der hochgeladenen Checksumme.

Post-Publish:

- Tag/Release-Target entspricht exakt `working`-HEAD.
- Release ist Prerelease, nicht Draft.
- Nur `opencode-linux-x64` und passende `.sha256` sind erforderlich und stimmen in Name, Größe und Inhalt.
- Updater ignoriert Drafts, unvollständige Releases, gleiche oder ältere SemVer.
- Staged Binary wird gestreamt, checksum- und versionsgeprüft und atomar ersetzt.
- Ein Pilot mit `autoupdate: "notify"` prüft Upgradepfad und Rollback, bevor `true` breit ausgerollt wird.

## 12. Intentionaler Vertrag und bekannte Restscope

Diese Punkte sind keine Regression:

- Prompt-Spinner `40 ms`; frühere Entscheidungen verlangen Arbeit pro Tick statt langsamere Animation.
- SDK-Queue `100 ms`, Worker-Delta-Fenster `200 ms` und TUI-Microtask-Merge sind verschiedene Schichten.
- Das verworfene 250-ms-UI-Deltafenster und ein Cache vollständiger Assistant-JSX-Bäume werden nicht
  wieder eingeführt; beide brachten keinen belastbaren Produktgewinn.
- SQLite `mmap_size` bleibt 0 und der 64-MiB-Page-Cache bleibt erhalten. Der getestete kleinere Cache senkte
  RSS kaum, machte History-Paging aber deutlich langsamer.
- Prozessisolation verspricht bessere Responsivität, Attribution und Heap-Freigabe, nicht automatisch weniger
  summierte RSS oder CPU in jedem Workload.
- Seltene Layout-, Dialog- und Topologieänderungen dürfen Full-Render auslösen.
- `tool-input-delta` nutzt eine 64-KiB-High-Water-Schwelle, keinen absoluten Split großer Providerfragmente.
- Tokenrate ist eine mit `~` markierte Zeichenschätzung, keine Provider-Usage-Messung.
- Große Diff-/Snapshot-/Revert-Vorschau darf vollständig fehlen; Mutation und Restore bleiben korrekt.

Weiter zu beobachten:

- Tool-Input-Fortschritt kann bei großen Write/Edit/Apply-Argumenten bis zu zwei dauerhafte Updates pro Sekunde
  erzeugen; bisher kein dauerhafter Haupttreiber.
- `lastTaskForChild` hat an strukturellen Agentübergängen noch O(Children x Parent-Parts), nicht pro Textdelta.
- Der Legacy-Helfer `TextDiff.create` bleibt für Fremdverbraucher unbeschränkt.
- Revert-Preview begrenzt nicht das vorgelagerte Snapshot-Staging.
- Model-Wait besitzt keinen eigenen vollständigen Prompt-Native-Harness; der gemeinsame `PartialText`-Pfad
  und die Zustandslogik sind separat gegated.
- Der native Releasevertrag ist derzeit Linux x64.
- Der gepinnte OpenTUI-0.5.3-Port ist freigegeben; spätere unfertige Fastpatch-/Yesloop-Wellen sind nicht Teil
  des Overlays.
- Dauerhaftes Per-Frame-Tracing bleibt verboten; frühere Instrumentierung vervielfachte selbst die Idle-CPU.

## 13. Abschlussprotokoll pro Version

Diese Tabelle als Kopie am Ende des Release-Artefakts oder in einem neuen Ergebnisdokument ausfüllen:

| Gate                      | Status | Ergebnis / Zähler | Rohbeleg / Pfad | Reviewer |
| ------------------------- | ------ | ----------------- | --------------- | -------- |
| P01 Branch/Integration    |        |                   |                 |          |
| P02 OpenTUI/ABI           |        |                   |                 |          |
| P03 Migration/Generatoren |        |                   |                 |          |
| P04 Typecheck/Format      |        |                   |                 |          |
| R01 Prozess/Startup       |        |                   |                 |          |
| R02 Worker-Streaming      |        |                   |                 |          |
| R03 Provider-Safety       |        |                   |                 |          |
| R04 Eventtransport        |        |                   |                 |          |
| R05 Renderer/Markdown     |        |                   |                 |          |
| R06 Footer/Timer          |        |                   |                 |          |
| R07 History/Snapshot      |        |                   |                 |          |
| R08 Diff-Budgets          |        |                   |                 |          |
| R09 Tool/Payload-Budgets  |        |                   |                 |          |
| R10 DB/Sync/Background    |        |                   |                 |          |
| R11 Bilder                |        |                   |                 |          |
| R12 Updater/Deployment    |        |                   |                 |          |
| R13 Logging/Profiling     |        |                   |                 |          |
| Vollsuiten                |        |                   |                 |          |
| B01 Idle                  |        |                   |                 |          |
| B02 Streaming             |        |                   |                 |          |
| B03 Large Session         |        |                   |                 |          |
| B04 Worker-Pool           |        |                   |                 |          |
| Build/Hash                |        |                   |                 |          |
| Rollback                  |        |                   |                 |          |

Freigabeentscheidung:

- [ ] alle Pflichtgates grün
- [ ] keine ungeklärten Skips, Testcount-Rückgänge oder Flakes
- [ ] kein unaufgeklärter Performance-Rückgang
- [ ] Binary, Overlay und Git-Provenienz vollständig
- [ ] Backup und Rollback hashverifiziert
- [ ] Dokumentation und Yesmem-Learnings aktualisiert
- [ ] mindestens ein unabhängiger Reviewer bestätigt den eingefrorenen Stand

## 14. Historische Referenzen

- `yesdocs/opencode-tui-performance.md`: Basispatchset, kontrollierte Streaming-A/Bs, Renderer, Events,
  History, Bilder und ältere Releasebelege.
- `yesdocs/tui-performance-patched-90.md`: Punkte 1–5, Safety-/Budget-Stack ab `.112`,
  OpenTUI-0.5.3-/Footer- und Worker-Nachträge bis `.122`.
- `yesdocs/tui-streaming-cpu-root-cause.md`: Profile, Gegenbeweise und verworfene Experimente.
- `yesdocs/employee-prerelease-updates.md`: Fork-Prerelease- und Updatervertrag.

Historische CPU-Zahlen belegen frühere Ursachen, ersetzen aber nie das direkte, profilgleiche A/B des aktuellen
Kandidaten.

## 15. Freigabestand `1.18.18-patched.122`

Der erste lokal installierte Dirty-Tree-Kandidat hatte SHA-256 `a07a9271...`. Der breite Gate-Lauf fand
danach eine doppelte CLI-JSON-Fehlerausgabe, ein verpasstes frühes ACP-stdin-EOF und zwei veraltete
Testfixtures. Nach Korrektur und getrennten Conventional Commits wurde `.122` neu gebaut und atomar lokal
ersetzt. Der unveröffentlichte Versionsname blieb zulässig, weil weder Tag noch Release existierten.

| Feld             | `.122`-Freigabestand                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------- |
| OpenTUI          | gepatchtes 0.5.3, Commit `2cd44364513f59a7a5937ef257042ddb0fca4fb7`                          |
| Core-Hash        | `ea25ad97c266d36b994697e5b6a57a1dfce7b0543b2e118e52ad39c7a9e1cd78`                           |
| Solid-Hash       | `ba9ffd6b55ea9f2785a01cc3b072bd3587116442607f5f19d20b383d75d16179`                           |
| Native-Hash      | `cfae310ac456004ef63788fdf2c715a95f330d0fdaab86f147dda5eeaeaab707`                           |
| Binary           | 192.891.008 Byte, SHA-256 `79a99c3c924e6ca5b4056366303c151e250cc9edfced04da631a3d6c133db7fc` |
| Installation     | `~/.opencode/bin/opencode`, bytegleich zum Build                                             |
| Rollback         | `.120`, SHA-256 `d9215b6dee9c5c810a8df497824812c4f0588e390d6f0c8685deb5f37703a6cf`           |
| Worker-Gates     | 25/25; Worker plus Pool 60/60 mit 424 Assertions                                             |
| Worker-Pool B04  | 20 Turns; 1 Spawn, 19 Reuses, 1 Providerinitialisierung, sauber retired                      |
| TUI fokussiert   | 51/51 mit 170 Assertions                                                                     |
| TUI vollständig  | 356 grün, 1 bestehender Skip, 0 Fehler, 1.024 Assertions, 8 Snapshots                        |
| Paket-Vollsuiten | Core 1.188; LLM 308; Schema 16; Protocol 2; Client 16; SDK-next 5; Session-UI 84; SDK-JS 1   |
| App vollständig  | 741 Unit- und 41 Browser-Tests, 0 Fehler                                                     |
| Statische Gates  | alle Paket-Typechecks, Migrationen/Generatoren, Overlay, Prettier und Diff-Check grün        |
| Yesmem           | `#85483` Runbook; `#85477` Gesamtstand; `#85476` PartialText-Muster                          |

Die Zwei-Worktree-Prüfung erklärte eine bekannte Bun-1.3.14-Pfadabhängigkeit statt unbekannter
Binärnondeterministik. Wiederholte Builds im kanonischen Hauptpfad waren bytegleich bei `79a99c3c...`; zwei
gleich lange temporäre Worktree-Pfade waren jeweils in sich stabil, erzeugten aber `d4aa7503...` und
`665dcebb...`. Bun bettet absolute Dependency-Pfade in sein Modularchiv ein und leitet daraus interne
Chunknamen ab. Größe, Build-ID, Version, Overlay sowie die ELF-Sektionen `.text`, `.rodata`, `.data` und
`.dynsym` waren zwischen den temporären Builds bytegleich. Für Release und Checksumme gilt deshalb allein der
erneut reproduzierte Build aus dem kanonischen `working`-Pfad; die Cross-Path-Abweichung ist erklärt und kein
Source- oder Native-Drift.

Der OpenCode-Volltest lieferte 3.584 grüne Tests sowie sieben Befunde unter hoher Hostlast. Ein Umask-Fall
bestand mit `umask 022`; zwei 25-ms-Kill-Fixtures waren isoliert, gemeinsam und CPU-gepinnt 41/41 grün. Die
vier übrigen Fälle waren die korrigierten CLI-/ACP-/Fixturebefunde und bestanden danach in ihren vollständigen
Dateien. Es bleibt kein reproduzierter Produktfehler aus diesem Lauf offen.

Die vier laufenden TUI-Roots wurden bei beiden atomaren Installationen nicht berührt und blieben auf ihrer
ursprünglichen `.120`-Inode. Der separate `closed-test`-Mergestack ist nicht Teil dieses Freigabestands: Er war
nur als eigener Kandidat autorisiert und enthält zusätzlich einen später ausdrücklich ausgeschlossenen
OpenTUI-Wave-2-Pfad.

B01 bis B03 bleiben `INCOMPLETE`, nicht `PASS`: Es fehlt ein eingecheckter oder vollständig hasharchivierter
End-to-end-Sampler samt Fake-Provider und Large-Session-Invocation. Die vorhandenen Worker-Replays, nativen
Partial-Render-Gates und das historische A-B-B-A ersetzen diesen Beleg nicht. Eine Veröffentlichung auf
expliziten Benutzerauftrag akzeptiert diese dokumentierte Harnesslücke als Release-Ausnahme; künftige
Versionen sollen zuerst die drei reproduzierbaren Harnesses erhalten.
