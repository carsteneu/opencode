# Perf-Cluster-Checks — was ist durch die Render-Fixes erledigt? (Checkliste)

> [!IMPORTANT]
> Neue Worktrees und Feature-Branches immer vom aktuellen `working`-Branch abspalten — nicht von `dev` und nicht von einem zufälligen aktuellen `HEAD`.

Status: CHECKLISTE (noch auszuführen) · Stand: 2026-08-15 · Kontext: TUI-Problemliste,
Hypothese: Perf-Cluster weitgehend durch die Render-/CPU-Fixes erschlagen — das soll **verifiziert** werden.

Ziel: **Basislinie setzen + Zustand der Perf-Issues gegen den aktuellen patched Build prüfen** —
nichts behaupten, alles messen und als Pass/Fail notieren (mit Datum). Resultate eintragen, damit
später nachvollziehbar ist, was erledigt ist.

Wie nutzen: pro Checkfelder ausfüllen (`Basislinie`, `Gemessen`, `Urteil`). Bei Found → eigenes
Issue/Follow-up daraus machen, nicht still verbuchen.

---

## Vorbereitung / Baseline
- Build: aktueller patched opencode (Branch/Tag + Datum eintragen).
- Umgebung: Terminal (testweise mehrere: stdin-TUI + mind. ein modernes Terminal), GPU-Größe konstant.
- Tooling: `pidstat`/`top`/`perf`, ggf. `/profile`-ähnliche TUI-Debug-Metriken; große Streaming-Antwort
  als Szenario 1, N parallel Subagenten als Szenario 2, volle Idle-Phase als Szenario 3.

## Perf-Befundlage (verifizierte Fixes — als Referenz-Erwartungswerte)

Aus der bisherigen CPU-/Render-Arbeit (Memory, gemessen) sind diese Ursachen **bereits behoben** —
die neuen Checks sollen deren Fortbestand absichern (Regression), nicht neu erfinden:

| Fix | Wirkung (gemessen) | Nachweis/Anker |
|-----|--------------------|----------------|
| **TextBuffer append statt full-replacement pro Delta** (plain Streaming-Prosa; `CodeRenderable.content`, `Code.ts:~142`) | Streaming-CPU **47,8% → 27,8% (−41,8%)**, A/B bestätigt | Memory #83988/#84732/#84500 |
| **Lazy-load Plugin-Compiler** (statt statischem Import) | behebt JSC-GC über riesigen FunctionExecutable-Heap → weitere ~20% (relativ) | #83417/#84561 |
| **Markdown-Parser-Fast-Path/Tail** (kein Re-Lexing stabilen Inhalts) | Parser-Replay **91%** schneller (54,9ms → 4,9ms); +~9% oben drauf | #84117/#84561 |
| **Spinner/Partial-Render-Interaktion → keine unnötigen Full-Frames** | Teil der Full-Frame-Beseitigung | #83837 |
| Gesamt **.91 → .92** | Idle **65,65% → 2,62%**/Session (−96%); aktive Session ~179% → **15–28%** (−84–91%) | #83556/#84572 |
| **Cumulative** (append + lazy + md-tail) | **~54%** Reduktion vom problematischen Baseline; Rest ~46% = fundamentales Rendering/Anim/Events (reale Obergrenze 28–51% vs Stock; 90% unrealistisch) | #84561/#84838 |
| Historisches A/B (Partial-Render + SSE-Delta-Batching + fps) | 92,5% → 9,4% **im A/B**, flickerte aber damals; **nicht** dem finalen Tag als Erfolg zurechnen | #82297/#85230 (Gotcha) |

---

## Checks

### 1) `#29079` — GPT-Modelle reagieren sehr langsam (51👍/118c)
- Symptom damals: besondere Latenz bei ChatGPT/Codex-Modellen im Vergleich zu anderen.
- Check: Zeit bis erstes Token + Tokenrate für eine Referenz-Antwort messen (GPT vs. Referenzmodell).
- **Pass:** Kein außergewöhnlicher Nennwert gegenüber Referenzmodell; kein Multi-Sekunden-Stall ohne Fortschritt.
- Resultat: Basislinie ____ · Gemessen ____ · Urteil [ ] Pass [ ] Fail · Datum ____

### 2) `#30086` — Hohe CPU in neueren Versionen (22/46)
- Check: CPU des TUI-Prozesses **idle** und während **Streaming** messen.
- **Pass:** Idle ≈ 0 %; Streaming begrenzt (kein dauerhafter Voll-Kern).
- Resultat: Basislinie ____ · Gemessen ____ · Urteil [ ] Pass [ ] Fail · Datum ____

### 3) `#11112` — oft "Preparing write…" hängen (46/80)
- Check: Großes Write/Rewrite (Datei > 1000 Zeilen) — Tritt "Preparing write…" auf? Wie lange?
- **Pass:** Kein indefiniter Stall; Verarbeitung unter Grenze (messen). Hinweis: ähnliches Gebiet wie
  `#19604` (Write-Tool / große Dateien) — dort evtl. gemeinsame Root-Cause.
- Resultat: Basislinie ____ · Gemessen ____ · Urteil [ ] Pass [ ] Fail · Datum ____

### 4) `#42657` — Multi-Subagent-Lag, 97% CPU auf Render-Thread
- Szenario: 3+ parallele Subagenten (task-Tool) laufen lassen; CPU des Render-Threads messen.
- **Pass:** Render-CPU begrenzt; keine Frame-Hänger.
- Anmerkung: Wird zusätzlich **durch den Agents-Status-Plan validiert** (Phase 1 block +
  Perf-Design-Constraint; Timeout-Phase 2) — hier **explizit** gegenmessen (Baseline vor Phase 1 = Referenz).
- Resultat: Basislinie ____ · Gemessen ____ · Urteil [ ] Pass [ ] Fail · Datum ____

### 5) Regression TextBuffer-Append (Streaming-Prosa)
- Szenario: langer Streaming-Text (plain prose), Deltas einladen → CPU/Instruktionen pro gestreamten Byte.
- **Pass:** Niveau wie erwartet (≈27,8% CPU im Power-Saver-A/B bzw. deutlich unterm Voll-Rebuild);
  keinerlei Rückfall auf O(n) Full-Copy pro Delta (im Code: `append`-Pfad genutzt).
- Resultat: ____ · Datum ____

### 6) Regression Lazy-Compiler / Startup-GC
- Szenario: Start des TUI + sofortige große Streaming-Antwort; GC-Stalls / Heap-Größe beobachten.
- **Pass:** Kein anfänglicher JSC-Heapsprung durch statische Plugin-Compiler-Importe; GC während Streaming unauffällig.
- Resultat: ____ · Datum ____

### 7) Markdown-Fast-Path (langer Codeblock / Tail)
- Szenario: sehr langer Code/Markdown-Block per Stream; Parser-Arbeit auf Suffix begrenzt, kein Re-Lexing stabilen Inhalts.
- **Pass:** Parser-Replay im erwarten Bereich (Referenz: 54,9ms → 4,9ms lokal); Tail-Append ohne Vollparse.
- Resultat: ____ · Datum ____

### 8) Full-Frame-Freiheit / Spinner-Interaktion
- Szenario: Spinner + partielle Updates + wachsender Text gleichzeitig.
- **Pass:** Es werden keine unnötigen Full-Frames angefordert (nur tatsächlich geänderte Fläche);
  Frame-Rate stabil, keine Escape-Flatter.
- Resultat: ____ · Datum ____

### 9) Thinking-Hide ↔ Render-Pfad (separater, offener Perf-Punkt)
- Szenario: Modell mit Reasoning; `thinking` auf `hide`. Misst TUI-CPU mit verborgenem Reasoning.
- **Pass/Frage-markiert:** Klärung nötig, ob `hide` den Reasoning-Block wirklich vom Renderpfad abkoppelt
  (sonst kein Render-Gewinn trotz Hide) — das ist ein **eigener, offener Perf-Punkt**, NICHT über
  `#785` abgedeckt.
- Resultat: ____ · Datum ____

### 10) RAM-Footprint / lange Sessions + viele Instanzen
- Szenario: 1 Session über lange Dauer (viele Tokens/Messages) + mehrere parallele TUI-Instanzen/Sessions.
- **Pass:** RSS bleibt begrenzt (kein sichtbarer Leak über Stunden); mehrere Instanzen gefährden nicht
  das Host-System (Kontext: frühere OOM-/Ressourcen-Warnungen bei vielen TUIs).
- Resultat: ____ · Datum ____

---

## Protokoll-Hinweise
- **Methodik:** Roh-CPU% ist über Power-Modi unzuverlässig (Frequency/Scheduler/GC skalieren nicht
  linear). Robuste Metrik laut bisheriger Arbeit: **Instruktionen pro Einheit Arbeit**
  (z.B. `perf stat -e instructions` / gemessen pro gestreamten Byte) — bitte für Vergleiche nutzen.
- **Regressionen:** Neue Fixes (z.B. Agents-Block Phase 1) dürfen die Referenzwerte aus der
  Perf-Befundlage nicht verschlechtern → vor/nach messen. Erst **Basislinie** aufnehmen, dann gegenhalten.
- Erst **Basislinie** für Szenario 2 (Multi-Subagent) vor Phase-1-Arbeit am Agents-Block aufnehmen —
  sonst fehlt die Referenz für Regressionsaussagen.
- Alle Urteile mit Datum + Build-Tag; nichts ohne Messung als "Pass" markieren (Prinzip Beweislast).
