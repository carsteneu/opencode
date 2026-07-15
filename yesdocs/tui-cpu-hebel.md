# TUI Streaming-CPU: Stand und verbleibende Hebel

Stand: 2026-07-13, abends. Installiertes Binary: `opencode 1.17.18-patched.7`.

## Ausgangslage und bisherige Ergebnisse

Ziel: CPU-Verbrauch der opencode-TUI beim Streamen senken. Ausgangswert war ca. 128 % CPU (patched.5, tmux 200x50, GLM-5.2, 1500-Wort-Streaming-Prompt). Aktuelle Werte je nach Szenario 27 bis 65 %.

Messmethodik (für alle A/Bs beibehalten): tmux 200x50, 1500-Wort-Streaming-Prompt, `/proc` utime+stime über 40 s, tmux pane_pid direkt messen (nicht `ps --ppid`, das erwischt den yesmem-mcp-Child). Run-zu-Run-Rauschen durch LLM-Tokenrate ist ±25 %, daher immer 3 Läufe pro Variante.

| Maßnahme | Ergebnis | Status |
|---|---|---|
| targetFps 60 auf 30 (app.tsx) | Basis-Senkung | gemerged, in patched.5 |
| SSE-Coalesce-Fenster 100 ms auf 250 ms | KEIN Gewinn (Ø128 vs Ø138 %) | verworfen, 100 ms bleibt (Learning, 2026-07-13) |
| Hebel 1: isDestroyed Feldzugriff statt Getter (opentui Renderable.ts, 5 Hot-Loop-Stellen) | Micro-Benchmark inconclusive (Rauschen 3x größer als Effekt) | installiert als patched.7 (Learning #81945) |
| Hebel 2 / Loop A: Cache fertiger Assistant-Messages (JSX-Element-Reuse) | NEGATIV: kein messbarer Gewinn (leer: 65.7 vs 65.3, 2 Msgs: 29.2 vs 31.7, 10 Msgs: 27.3 vs 27.9) | nicht installiert, Binary /tmp/opencode-patched.8, Commit a1909dd im Worktree, Empfehlung: verwerfen (Learning #81960) |

Wichtige Schlussfolgerung aus Loop A: Fertige Messages über dem Stream kosten nichts Messbares. Die CPU-Zeit steckt im Streaming-Pfad selbst und in den Per-Frame-Kosten.

## Profil-Erkenntnisse (Stand patched.5, VOR Hebel 1)

- isDestroyed-Getter: 6.4 % self (inzwischen adressiert, Wirkung unbewiesen)
- SSE-Transport + JSON.parse pro Event + serverseitige Effect-Fiber-Runtime: ca. 12 bis 15 %
- Per-Frame-Draw-Kosten: O(sichtbarer Inhalt), unabhängig von der Flush-Frequenz
- Oberhalb von ca. 10 Flushes/s ist die Flush-Anzahl NICHT mehr der Engpass

Achtung: Es existiert kein frisches Profil auf patched.7. Vor jedem weiteren Hebel wäre ein neues Profil die billigste Absicherung (ca. 15 Min.).

## Verbleibende Hebel

### 1. Frisches CPU-Profil auf patched.7

Zweck: Verifizieren, dass der isDestroyed-Frame weg ist, und die verbleibenden Hotspots mit aktuellem Binary neu ranken. Ohne das ist jede Hebel-Wahl geraten. Aufwand: ca. 15 Min. Risiko: keins.

### 2. Loop B: Markdown-/Streaming-Render-Pfad (REFRAMED, siehe unten)

Ursprüngliche Prämisse: Die streamende Message wird bei jedem Flush komplett neu geparst, Fix wäre inkrementelles Parsen nur des wachsenden letzten Blocks.

Befund vom 2026-07-13 (Code-Lektüre Fork `~/projects/opentui/packages/core/src/renderables/`): Diese Prämisse ist FALSCH, beides existiert bereits ab Upstream v0.3.3:

- `markdown-parser.ts`: `parseMarkdownIncremental` mit ParseState, Token-Reuse per raw-Prefix-Vergleich, nur der Tail wird neu gelext (trailingUnstable=2 im Streaming-Modus).
- `Markdown.ts` `updateBlocks()`: Block-Reconciliation über Token-Identität und raw-Vergleich, In-Place-Updates, nur instabile Trailing-Blöcke werden neu gebaut.
- opencode setzt `streaming={!time.completed}` bereits (session/index.tsx, Zeilen ~1652 und ~1718).

Was im Markdown-Pfad trotzdem noch kosten kann (offene Fragen, per Profiling zu klären):

- Welchen `internalBlockMode` nutzt opencode effektiv (coalesced vs top-level), und ist `updateTopLevelBlocks` (Markdown.ts:1757) genauso inkrementell wie der gelesene coalesced-Pfad?
- Neubau der 2 Trailing-Blöcke bei JEDEM Flush: wenn der wachsende letzte Block ein großer Code-Block ist, läuft Syntax-Highlighting pro Flush über den gesamten wachsenden Block.
- `applyInterBlockMargin` läuft pro Flush über alle stabilen Blöcke (O(Blockzahl), vermutlich billig).
- raw-Prefix-Vergleich ist O(Gesamtlänge) pro Flush (memcmp-artig, vermutlich billig).

Konsequenz: Loop B startet mit Profiling-Mandat statt mit fixer Implementierungs-These. Erst messen, wo die Streaming-CPU wirklich hingeht, dann gezielt fixen, dann A/B.

### 3. Per-Frame-Draw-Kosten (strukturell größter Block)

Jeder Frame zeichnet den kompletten sichtbaren Inhalt, unabhängig davon, was sich geändert hat. Dazu der viewportCulling-Walk (Render-List-Rebuild pro Frame, siehe #81769). Fixes: Dirty-Region-Tracking oder Culling-Cache keyed auf scrollTop + Children-Revision. Beides tief im opentui-Fork, großer Aufwand, dafür das größte Potenzial. Billigere Variante: targetFps beim Streamen weiter senken (30 auf 15), UX-Kosten spürbar.

### 4. SSE-/Event-Pfad

JSON.parse pro SSE-Event plus serverseitige Effect-Fiber. Optionen: Event-Batching serverseitig, Coalescing auf Serverseite verschieben. Mittlerer Aufwand, Gewinn hart gedeckelt auf die gemessenen 12 bis 15 %.

### 5. Upstream ernten statt selbst bauen

Die 55-PR-Analyse (Branch yesresearch/opencode-pr-analyse, Commit 586954b) hat fertige Performance-PRs identifiziert, u. a. Top-3-Single-Line-Wins wie #35111 (structuredClone-Entfernung), alle konfliktfrei. Auf eine neuere opencode-Version rebasen und die relevanten PRs mitnehmen. Vom User bewusst auf "wenn alles durch ist" verschoben.

### 6. Aufhören

Von ca. 128 % auf 27 bis 65 % ist der Großteil geholt. Jeder weitere Hebel kostet mehr und bringt weniger. Legitime Option, sobald Loop B durch ist.

## Offene operative Punkte

- 5 verwaiste Loop-A-Prozesse laufen noch (PIDs 2473117, 2538799, 2541835, 2547243, 2562832), Kill steht aus.
- Loop-A-Entscheid: mergen oder verwerfen (Empfehlung: verwerfen, Komplexität ohne messbaren Gewinn).
- Loop-B-Worktree gehört primär in den opentui-Fork, nicht in opencode (Markdown-Pfad liegt dort). Build und A/B über Cap `opencode_patched_build`.
