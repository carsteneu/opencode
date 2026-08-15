# Branch `working` — Stand 2026-07-17

Konsolidierter Branch mit allen erfolgreichen lokalen Patches auf Basis von `dev` (`2faa228`).
Worktree: `.worktrees/working` · HEAD: `7e017ce` · 23 Commits über dev.

Ziel des Branches: eine lauffähige, gepatchte opencode-Version, die drei Klassen von Problemen
löst, die upstream noch offen sind — **TUI-Flackern**, **hohe CPU-Last unter Streaming**, und
**Memory Leaks durch nicht-deterministisches SSE-Teardown**. Daneben enthält er den Bau der
patched.47–57-Binaries sowie die Build- und Profiling-Infrastruktur, mit der diese Patches
vermessen wurden.

Die Commits unten sind nach Thema gruppiert; innerhalb jeder Gruppe ist die Reihenfolge
chronologisch. Build-Artefakt-Commits (`chore(opencode): build patched.N`) sind nur am Ende
kurz gelistet, da sie keine Logikänderung enthalten.

---

## 1. SSE-Stabilität und deterministisches Teardown

**Ausgangsproblem.** Bei Session-Wechsel und Disconnects blieben SSE-Listener und Queues
hängen; die Listener-Zähler stiegen monoton an und verursachten Memory Leaks sowie
wachsende CPU-Last durch verwaiste Handler.

**`75ff364`** `fix(sse): deterministic teardown — disconnect detection, bounded queue, counters`
- 5 Dateien, +151/−37. Neu: `sse-counters.ts`, `sse-disconnect.ts` (überarbeitet),
  Test `httpapi-sse-teardown.test.ts` (+100). Erkennt Disconnects zuverlässig, begrenzt
  Queues, führt Listener-Zähler zur Diagnose ein.

**`7703203`** Merge `yesloop/sse-orphan-fix` — nimmt `75ff364` und die begleitenden Handler-
Änderungen (`event.ts`, `global.ts`) auf.

**`c9d5600`** `fix(tui): dispose event.on subscriptions on unmount` (upstream PR #34616)
- 3 Dateien (`app.tsx`, `prompt/index.tsx`, `routes/session/index.tsx`), +135/−117.
- TUI-Seite des selben Problems: `event.on`-Subscriptions wurden bei Unmount nicht
  freigegeben. Jetzt werden alle Subscriptions sauber disposed.

## 2. Windowed Rendering und Flacker-Fix

**Ausgangsproblem.** Bei jedem gestreamten Token wurde die gesamte Message-Liste neu
gerendert — das führte zu sichtbarem Flackern und zu CPU-Spitzen, die bei langen Sessions
den Haupttreiber der Last darstellten.

**`04f19c5`** `fix(tui): restore windowed message rendering + scroll-up history paging`
- `routes/session/index.tsx`, +62/−1. Stellt Windowed Rendering wieder her: nur der
  sichtbare Fenster-Ausschnitt wird pro Frame berührt. Zusätzlich: Scroll-Up bis zum
  Anfang der Historie funktioniert (war zuvor kaputt — das war die offene Regression
  vom Ende der Session `ses_09d679f8`).

**`2f95b0a`** Merge `fix/loadolder-consumer-restore` —Merge-Commit für `04f19c5`.

## 3. Partial-Render-Fast-Path für den Spinner

**Ausgangsproblem.** Der Prompt-Spinner (Knight-Rider-Trail) lief im Full-Frame-Pfad und
erzeugte so 30–60 Full-Renders/s, nur um eine kleine rechteckige Fläche zu animieren.

**`7721bd2`** `feat(tui): wire spinner to partial-render fast path`
- 3 Dateien, +76/−4. Neu: `ui/partial-render.ts` (+61). Der Spinner wird als
  partial-eligible registriert und löst nur noch eine Teil-Rederate seiner eigenen Fläche
  aus, nicht mehr einen Full-Frame.

**`4a8190c`** `perf(tui): lower idle render cost — 30fps cap, 100ms spinner tick, precomputed spinner frames`
- 3 Dateien (`app.tsx`, `prompt/index.tsx`, `ui/spinner.ts`), +41/−34. Idle-CPU wird
  gesenkt durch einen 30-fps-Cap, einen 100 ms Spinner-Tick und vorab berechnete Frames.

**`2f6a3a5`** Merge `yesloop/spinner-partial-render`.

## 4. SSE-Delta-Batching (CPU-Bundle)

**Ausgangsproblem.** Jeder eintreffende SSE-Delta-Trigger reaktive Aufräumarbeiten und
Re-Renders. Bei einem typischen Model-Stream mit mehreren hundert Deltas pro Sekunde
führte das zu einem invalidation cascade, der die CPU auch auf schnellen Maschinen auf
80–110 % trieb.

**`6771d26`** `feat: SSE delta batching in sync.tsx` (PR #36045)
- `context/sync.tsx`, +65/−27. Sammelt eingehende Deltas und flusht sie gebündelt, statt
  jeden Delta einzeln durch die reaktive Pipeline zu reichen.

**`243d1b6`** `feat: settle session status after stream end` (PR #36002)
- 4 Dateien (`handlers/session.ts`, `run-state.ts`, 2 Tests), +62/−17. Setzt den
  Session-Status nach Stream-Ende deterministisch auf "settled", damit nachfolgende
  UI-Updates nicht gegen einen schwebenden Zustand arbeiten.

**`0162c3c`** `fix: pendingDeltas cleanup on part removal + disposal, fix indentation`
- `run-state.ts`, `sync.tsx`, +50/−47. Rämt `pendingDeltas` beim Entfernen von Parts und
  bei Disposal korrekt auf; verhindert, dass gebatchte Deltas ins Leere laufen.

**`86eca67`** `fix: normalize indentation in sync.tsx event handlers` — finale Cleanup
  der Einrückung in den in `6771d26` eingeführten Handler-Blöcken.

**`249e71b`** Merge `yesloop/pr-cpu-bundle` — fasst PR #36045 / #36002 zusammen.

## 5. Child-Prozess-Server-Refactor (Streaming-Isolation)

**Ausgangsproblem.** LLM-Streaming, TUI und Server liefen in einem Prozess; die GC-Last
des Streams (große Objektbäume, string-Konkatenation) belastete die TUI-Renderloop
sichtbar — der Heap wuchs pro laufender opencode-Instanz auf ~700 MB und trieb über
GC-Pausen die CPU. Lösung: LLM-Streaming in einen separaten Worker-Prozess auslagern.

**`88072db`** `perf(tui): isolate streaming processes`
- 20 Dateien, +751/−143. Der **architektonisch größte** Commit im Branch. Neue Dateien:
  - `packages/opencode/src/cli/tui/process-server.ts` (+164) — Server-Gerüst für den
    Child-Prozess (127.0.0.1, freier Port, Readiness-Wait, Auto-Connect).
  - `packages/opencode/src/session/llm/ai-process-client.ts` (+146) — Client-Seite der
    LLM-Kommunikation vom TUI zum Worker.
  - `packages/opencode/src/session/llm/ai-process-worker.ts` (+135) — Worker-Seite;
    führt den LLM-Stream isoliert aus.
  - `packages/opencode/src/session/llm/ipc.ts` (+22) — IPC-Protokoll.
  - `test/session/llm-process.test.ts` (+138) — Test-Coverage für den neuen Pfad.
- Begleitet von Anpassungen in `bootstrap.ts`, `cli/cmd/tui.ts` (−103, entschlackt),
  `session/llm.ts` (+57), `context/{data,sdk,sync}.tsx` und `prompt/index.tsx`.
- **Achtung — bekannter Regressionstreiber:** Dieser Commit hat versehentlich den
  `createColors`-Import und die `ColorGenerator`-Funktion in `spinnerDef` entfernt.
  Die Folge: der Spinner war einfarbig statt mit Knight-Rider-Farbverlauf. Korrigiert
  in `7e017ce` (Abschnitt 7).

## 6. LLM-Streaming-Coalesce

**`5eb15d7`** `perf(opencode): coalesce streaming deltas`
- 2 Dateien (`session/llm.ts`, `test/session/llm-coalesce.test.ts`), +70/−1. Batching
  auf LLM-Seite: mehrere eintreffende Deltas werden zu einem Flush zusammengefasst,
  bevor sie in die Streaming-Pipeline gehen. Reduziert die Anzahl reaktiver Updates
  weiter, komplementär zum SSE-Batching in Abschnitt 4.

## 7. Shell-Output und Spinner-Farbverlauf (v56 → v57)

**`56718c5`** `fix(tui): keep streaming shell output partial`
- `routes/session/index.tsx`, +15/−6. Shell-Output beim Streaming-Tool wurde auf den
  Partial-Render-Pfad gelegt (statt Full-Frame bei jedem Output-Update). Das ist die
  v56→v57-Änderung.

**`7e017ce`** `fix(tui): restore knight rider spinner color gradient` (2026-07-17)
- `component/prompt/index.tsx`, +8/−2. Holt `createColors` zurück und wiret
  `spinnerDef.color` wieder an die `ColorGenerator`-Funktion. Ohne den Generator malt
  `opentui-spinner` jeden Char mit derselben RGBA — der Trail kollabiert zu einer
  einfarbigen Block-Animation. Behebt die Regression aus `88072db`.

## 8. Tooling und Build-Infrastruktur

**`3686a04`** `sync: local patches from main workspace`
- 8 Dateien, +134/−45. Sammelt kleinere lokale Patches: `targetFps` 30,
  Spinner-Cache + 100 ms Interval, Log-Rotation, SSE-Coalesce 100 ms, Entfernen von
  `structuredClone`, `loadOlder`.

**`6b5e516`** `chore(opencode): add on-demand CPU profiling` — +26 in einer Datei.
  Aktiviert CPU-Profile auf Tastendruck statt immer-an.

**`89325cf`** `chore(opencode): enable unminified profile builds` — erlaubt lesbare
  Profile-Builds (1-Zeilen-Änderung im Build-Skript).

**`5bdc8fd`** `docs(tui): document patched 56 changes` — +457. Doku der patched.56-Stands.

**Build-Commits** (jeweils ein fertiges Binary, keine Logikänderung):
`c6e169e` (.47), `240af19` (.48), `44f976d` (.47 baseline restore),
`2af5b3c` (.49 profile), `735d786` (.50), `968bf9f` (.51), `db0c451` (.52 debug),
`c58c615` (.53 debug), `c2e66bc` (.54 profile), `926d543` (.55 profile),
`4716241` (.56), `ddac4a3` (.57).

**Reverts** (gewollte Rücknahmen, jeweils als Paar Feature → Revert in der Historie):
- `c4f3213` `perf: replace scroll polling with events` → revertiert in `2170548` +
  `44f976d` (Baseline-Reset auf .47). Die Event-basierte Variante hat die Scroll-State-
  Erkennung verschlechtert; zurück zur Polling-Variante.
- `05aa560` `perf: buffer completed assistant messages` → revertiert in `e87bc03`.
  Das Buffering hat das Rendering von abgeschlossenen Assistant-Messages optimiert,
  führte aber zu Anzeige-Problemen; zurückgenommen.

## Netto-Wirkung

- **Flackern** eliminiert — Windowed Rendering + Partial-Render-Pfad (Abschnitt 2, 3).
- **CPU deutlich gesenkt** — SSE-Batching, LLM-Coalesce, Streaming-Isolation in Child-
  Prozess, 30-fps-Cap, 100-ms-Spinner-Tick (Abschnitt 4, 5, 6, 3).
- **Memory Leaks geschlossen** — deterministisches SSE-Teardown, `event.on`-Disposal
  (Abschnitt 1).
- **Spinner-Farbverlauf** wiederhergestellt (Abschnitt 7, 2026-07-17).
- **Architektur:** LLM-Streaming läuft isoliert in einem eigenen Worker-Prozess
  (Abschnitt 5); das ist die Grundlage für weiteren Tuning.

Aktuelles Binary: **patched.57** (`ddac4a3`) **+ Spinner-Fix** (`7e017ce`).

## Verifiziert am 2026-07-17

`working` enthält den vollständigen erfolgreichen Code-Stand. Abgleich mit allen anderen
Worktrees:

- **`gc-pipeline`** (`ae5029e`): code-identisch mit `5eb15d7` in working — gleiche
  Diffstat (2 Dateien, +70/−1), gleicher Patch-Inhalt, unterschiedliche SHA nur wegen
  anderem Parent. gc-pipeline enthält **nicht** den Child-Prozess-Server-Refactor aus
  Abschnitt 5; das ist exclusive in working.
- **`yesloop-pr-cpu-bundle`**, **`yesloop-spinner-partial-render`**: 0 Commits
  außerhalb von working.
- **`yesloop-tui-buffered-messages`** (`a1909dd`, `ed869de`): Feature in working als
  `05aa560` applied und als `e87bc03` revertiert — gewollte Rücknahme.
- **`ab-bundle-merge`** (`f375f99`): nur Merge-Artefakt; inhaltlicher Patch ist in
  working via `249e71b` enthalten.
- **`yesresearch-opencode-pr-analyse`** (3 Commits): reine Dokumentation
  (Forschungs-Wiki unter `yesdocs/`, ~850 Zeilen Markdown) — bewusst separat gehalten,
  kein Code-Commit.
