# Agents-Status-Block im Stream (Subagent-Sichtbarkeit + Robustheit)

> [!IMPORTANT]
> Neue Worktrees und Feature-Branches immer vom aktuellen `working`-Branch abspalten — nicht von `dev` und nicht von einem zufälligen aktuellen `HEAD`.

Status: EINGEPLANT (Design so far) · Stand: 2026-08-15 · Kontext: Brainstorm/Design-Diskussion
Ablage: `.yesmem/plan/` (Heimat geplanter Fork-Features). Schwesterplan: `toast-clipboard-feature.md`.

---

## 1. Zielbild (woran wir uns messen)

Leitidee: **Nichts wartet unsichtbar und ewig — jeder (Sub-)Agent-Zustand ist sichtbar, kategorisiert,
zeitgebunden und löst sich selbst auf.** Daraus fünf Säulen:

1. **Explizites Status-/Lebenszyklus-Modell** — statt "läuft irgendwie":
   Jeder (Sub-)Agent hat einen benannten, beobachtbaren Zustand:
   - `queued → initializing → working → completed / failed / cancelled`
   - `working` weiter unterteilt:
     - `thinking` (Reasoning aktiv)
     - `tool:<name>` (welches Tool, seit wann — "read file.ts · 2.4s")
     - `streaming` (Tokens verarbeiten — Tokens/s, n Tokens)
     - `waiting:<grund>` — der entscheidende Punkt: Warten sichtbar machen und *benennen*
       (Provider-First-Byte? Permission? Input?)
2. **Live-Feedback im TUI (optisch)**:
   - Parent zeigt pro Subagent eine Aktivitätszeile mit Timer ("läuft seit 3:12") + aktuellem Zustand.
   - Die drei verwirrendsten Zustände klar unterscheidbar: **arbeitet** (Tokens fließen) vs
     **wartet** (nichts fließt, aber kein Fehler) vs **fertig**.
   - Kollabierbar; auf Wunsch Detail (gerade im Tool, Tokenrate, Steps n/m).
3. **Zeitbindung & Selbst-Erlösung** (das eigentliche Kern-Maxi):
   - Idle-First-Byte-Timeout (Provider schweigt) + Total-Max pro Subagent, konfigurierbar.
   - Heartbeat/Lease: jeder Fortschritt (Token/Tool) verjüngt den Lease. Kein Heartbeat seit Xs →
     "stalled" markieren + sichtbar anzeigen, nicht still weiterwarten.
   - Robuste Completion: `background.wait` bekommt Status-Re-Check/Poll-Fallback → kein Lost-Event-Hang.
   - Timeout-Auflösung definiert (retry n×, dann Fail mit Grund — nie stumm).
4. **Diagnostik als Nebenprodukt** — "wo steckt es?" ist immer sofort lesbar: Provider-Problem
   (0 Tokens seit 60s / no first byte), Permission-Wartet, Tool-Lange-Läufer, Timeout — ohne Raten.
5. **Drill-down / "Hineinspringen"** — von der Ansicht aus in die Sub-Session springen (existiert
   partiell via Keybinds), mit Status-Badge und klarem Rückweg.

### Beschlossene Design-Entscheidungen (bisher)
- **Ort:** KEINE Seitenleiste/Panel (verworfen) — der "Baum aktiver Sub-Sessions" erweitert die
  **heutige Subagent-Stelle im Stream** (`routes/session/subagent-footer.tsx` → Agents-Status-Block).
  *Kontext: Die TUI hätte die Infrastruktur gehabt (`feature-plugins/sidebar/` mit Panels `Files`,
  `Context`, `Todo`, `MCP`, `LSP`, Toggle via `sidebar.toggle`/`<leader>b`) — wir haben aber bewusst
  auf den Stream fokussiert: dort schaut der Nutzer schon hin, und der Jump-in lebt dort bereits.*
- **Ansichtsebene:** nur **Level-1** (Kinder der aktuellen Parent-Session), kein tiefer Baum in v1.
- **Fertig-Verhalten (User-Entscheid):** fertige Subs **bleiben stehen**, Status wechselt nur auf
  `✓ fertig` — nichts verschwindet (kein Layout-Jump = auch CPU-freundlich). Manuelles Einklappen
  erledigter Einträge = späterer Zusatz.
- **Sichtbarkeit:** Block **immer sichtbar**, kollabierbar auf eine Zeile ("3 Agents aktiv").
- **Interaktion:** Zeile wählen/Enter → in Sub springen (nutzt bestehende `session.child.*`-Nav).

### Referenz-Skizze (TUI-Stream, so könnte es aussehen)

```
┌──────────────────────────────────────────────────────────────┐
│ user                                                         │
│   "Untersuch den Render-Pfad und find die CPU-Ursache."      │
├──────────────────────────────────────────────────────────────┤
│ assistant                                                    │
│   Ich schaue mir den Render-Pfad an, indem ich drei         │
│   Subagenten parallel starte.                               │
│                                                              │
│   ╭─ Agents (kollabierbar, immer sichtbar) ──────────────╮   │
│   │  explore-render        ◖ läuft        read main.rs · 3s│  │
│   │  probe-cpu             ◖ wartet       Provider · 18s   │  │
│   │  test-pipeline         ✓ fertig       (0 Treffer)      │  │
│   ╰─────────────────────────────────────────────────────╯   │
│                                                              │
│   → Ergebnis von explore-render: …                          │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Hintergrund / Recherche (warum das nötig ist)

### 2.1 Das eigentliche Problem: still wartende Subagnet-Hänger
Upstream-Issue **#11865** (OPEN, aktiv bis 07.08.2026, kein Fix): Subagenten hängen ohne Timeout/Retry,
Session bleibt blockiert. Mehrmodig:

- **Parent wird nie benachrichtigt** (häufigster): Sub ist fertig, Parent denkt "läuft noch"
  (Zitat 17.06.: *"explore agent finishes but its parent build agent thinks it is still running"*).
- **Provider-"no-first-byte"-Stall** (24.05.): Blockade im ChatGPT-Codex-Backend
  (`chatgpt.com/backend-api/codex/responses`) — kein TUI-Bug.
- **Nested-Permission-Hang**: Sub-Subagent braucht Permission, Prompt erscheint nie
  (`children()` statt `descendants()`) → hängt samt Parent-Kette. Offener Fix-PR **#24638** (nicht gemerged).
- Produktions-Beleg (16.07.): ~2000 Sessions / 775 Sub-Sessions, 207 `MessageAbortedError`,
  einzelne Sessions liefen **99–104 h**.

**Verifizierte Root Causes im Code:**

| # | Ursache | Stelle |
|---|---------|--------|
| 1 | **Kein wall-clock-Timeout irgendwo im Pfad.** | `packages/opencode/src/tool/task.ts:~323` — `Effect.raceFirst(background.wait({id}), …abort…)`: einzige Ausstiege Completion-Event ODER externer Abort, ohne Zeitlimit. `packages/core/src/session/runner/llm.ts:~142/232` — Turn wartet auf Provider-Stream, keine Deadline. `runner/max-steps.ts` begrenzt nur die **Schrittzahl**, nicht die Zeit. |
| 2 | **Lost-final-event-Race** (Parent-Notification). | `packages/opencode/src/background/job.ts` — `BackgroundJob.Service.wait` resolved über eine Jobs-Map (`InstanceState`), keyed auf Session-Status; kein Poll/Re-Check-Fallback → wird das Final-Event verpasst, resolvet nie. |
| 3 | **Provider-no-first-byte-stall.** | `runner/llm.ts:232` wartet auf das erste Event des Modell-Streams ohne Timeout. |
| 4 | **Nested-Permission-Propagation fehlt (TUI).** | `packages/tui/src/routes/session/index.tsx:~228-233` — sammelt nur `children()`, nicht `descendants()` (Fix = PR #24638). |

### 2.2 Warum Sichtbarkeit dazugehört
Der Sprung-Ins-Sub existiert als Keybinds, ist aber **versteckt** (kein sichtbarer Einstieg) und zeigt
**keinen Zustand**. Ergebnis: Man steht vor einem "läuft noch?" ohne Antwort — man kann weder Grund
noch Fortschritt sehen. Genau deshalb verbindet der Agents-Block Sichtbarkeit (2/4/5) mit der
Robustheit (3): Was man sehen kann, kann man auch diagnostizieren.

### 2.3 Abgrenzung (damit beim Bau nichts verwechselt wird)
- Der Agents-Block ist **kein** "Streaming abschalten"-Feature. `#785` ist bereits erledigt: UX über
  `/thinking` (show/hide, Default `hide`), Perf über eure Render-Fixes. Der Block zeigt **Zustand**,
  nicht das An-/Aus des Streamings.
- Clipboard (`#4283/#7048`, stummer Fehlschlag ohne `wl-copy`/`xclip`/`xsel`/OSC-52) ist ein
  eigenes Feature → `toast-clipboard-feature.md`.
- Claude Code teilt die "still wartend/kein Status"-Lücke (Benchmark, Memory `#85297`) — unser
  sichtbarer Status + echter Timeout wäre dort ein Differenzierungsmerkmal.
- **`#42657`** (Multi-Subagent-Lag, 97% CPU Render-Thread) wird **über diesen Plan** angegangen:
  Phase 1 macht die Last sichtbar (Block + Perf-Design-Constraint), Phase 2 begrenzt die Wartezeiten
  (Timeout/Lease). **Baseline** für Multi-Subagent-CPU vor Phase 1 aufnehmen (siehe `perf-cluster-check.md`).

---

## 3. Ist-Zustand (verifizierte Code-Stellen)

| Was | Datei | Details |
|-----|-------|---------|
| Aktueller Subagent-Nav-Strip (der **zu erweiternde Ort**) | `packages/tui/src/routes/session/subagent-footer.tsx` | Prev/Next-Arrows + Parent-Switch; nur Navigation, kein Status. |
| Session-Ansicht: Keybinds, children-Filter, Sichtbarkeit, Handler | `packages/tui/src/routes/session/index.tsx` | Keybinds L140-143 (`session.child.first/parent/next/previous`); `children` L207-210 (Filter `parentID`); `visible` L235 (Footer nur ohne Parent/Permissions/Questions); `childSessionHandler` L516f. |
| Data-Fluss live | `routes/session/index.tsx` | subscribed auf `session.status` + `message.part.updated`; `sync.session.sync(id)` bei Session-Wechsel (→ Reinspringen ist live). |
| Subagent-Dialog(e) | `packages/tui/src/routes/session/dialog-subagent.tsx`, `packages/tui/src/component/dialog-agent.tsx` | existierende Auswahl-/Info-Dialoge. |
| Keybind-Definitionen | `packages/tui/src/config/keybind.ts` | `session.parent` (Default `up`), `session.child.next/previous/first`. |
| "fertig"-Benachrichtigungskonzept | `packages/tui/src/feature-plugins/system/notifications.ts` | `subagent_done`-Typ (bei parentID) vs `done`; Sound gemappt in `packages/tui/src/attention.ts`. |
| Parent-Chain (Breadcrumb-/Rückweg-Quelle) | `packages/app/src/utils/session-route.ts` (+ `context/server-session.ts`) | lösen Parent-Kette hoch, inkl. Cycle-Guard ("Session parent cycle") — Kandidat für Breadcrumb/Unterpfad im Block. |
| Core-Wartepfad (für Phase 2) | `task.ts:~323`, `background/job.ts`, `core/src/session/runner/llm.ts`, `runner/max-steps.ts` | siehe Root-Cause-Tabelle. |
| Staus-Eventquelle | `SessionV1` (Statusfeld, evtl. enum) + `session.status`-Event | **Beim Bau zu finalisieren:** welche Statuswerte existieren (`running/pending/completed/…`) und was sie für `waiting`-Klassifikation hergeben. |

---

## 4. Design: der Agents-Status-Block

**Position/Verhalten:** erweitert `subagent-footer.tsx`; **immer sichtbar**, kollabierbar auf
eine Zeile mit Count ("3 Agents aktiv"); listet die **Level-1-Kinder** der aktuellen Parent-Session.

**Zeile pro Sub:** `Name · Status-Token · Detail`
- Status-Token: `◖ läuft` · `◖ wartet:` + Grund (Provider-first-byte / Permission / Input) ·
  `✓ fertig` (+ kurz Ergebnis) · `✕ fehlgeschlagen` (+ Grund)
- Detail: Tool + Dauer ("read main.rs · 3s") bzw. Wartezeit ("Provider · 18s")
- `fertig` bleibt stehen (Entscheidung), kollabierbar (später: manuelles Einklappen erledigter).

**Interaktion:** Zeile fokussieren + Enter → Jump-in (bestehende `session.child.*`/`session.parent`
-Mechanik); wieder Enter/Escape zurück.

**Datenfluss (v1, rein TUI):**
- Quelle: `sync.data.session` (Kinder via `parentID`, wie `index.tsx:207-210`)
- Live: `session.status`-Event → Status aktualisieren; `message.part.*` → Tool-/Detail-Felder
- Timing lokal (Timer startet bei Status-Wechsel; kein Backend nötig)
- **Warnung/Lease (v1-limitiert):** "läuft vs wartet" zunächst über verfügbare Events
  (`message.part.updated` = wo möglich "arbeitet"; sonst Standard "läuft").
  Echte `waiting:<provider>`-Klassifikation braucht Runner-Info → **Phase 2** (Core).

**Perf-Design-Constraint (v1, Pflicht):** Der Block muss **render-arm** bleiben. Lektion aus der
CPU-Root-Cause: der *wachsende Antwort-Text* (Markdown/Code) ist der Full-Frame-Trigger — der Block
darf das nicht replizieren:
- Sekunden-Timer dürfen **nicht** den ganzen Block neu rendern, nur die betroffene Zeile (Fläche geändert).
- Keine durchlaufende Spinner-Animation über alle Zeilen; Zeit/Dauer sparsam (z.B. ganze Sekunden).
- Delta-/Teil-Render nutzen (gleiche Muster wie eure bestehenden Render-Fixes), nicht pro-Tick-Vollrender.

---

## 5. Umsetzungsplan (Phasen)

### Phase 1 — TUI: Agents-Status-Block (eigenständig, kleiner, mergebar)
1. `subagent-footer.tsx` zum Agents-Block erweitern: kompakte Liste der Kinder mit Status-Token.
2. Sichtbarkeit/Kollaps: immer sichtbar + eine-Zeile-Ansicht; Count.
3. Live-Update aus `session.status` + `message.part.updated` (Level-1).
4. Interaktion: Zeile → Enter → Jump-in (bestehende Nav), Rückweg via Parent-Keybind.
5. Zustand "fertig bleibt stehen".
6. **Tests (TDD):** Komponenten-/Unit-Test für Status-Ableitung & Kollaps-State; Regression auf die
   bestehende Keybind-Nav.
7. Akzeptanz: Bei laufenden Subs erscheint der Block live; fertige bleiben `✓` sichtbar; Jump-in funktioniert;
   keine Regression der bestehenden parent/child-Keybinds; Typcheck grün.

### Phase 2 — Core: Status-Verfeinerung + Selbst-Erlösung (größer, optional getrennt)
1. **Konfigurierbare Timeouts** (idle/first-byte pro Subagent, optional Provider): `task.ts`-Wait + `runner/llm.ts`
   mit Deadlines (z.B. `Config`-Schlüssel; Default konservativ, verhaltensneutral).
2. **Heartbeat/Lease:** Fortschrittsereignisse (Token/Tool) verjüngen; kein Fortschritt seit X → `stalled`,
   sichtbar im Block (Pillar 4).
3. **Robuste Completion:** `background/job.ts`-wait mit Status-Re-Check/Poll-Fallback (Lost-Event überbrücken);
   Auflösung definiert (retry n× → `failed` + Grund).
4. Status-Enum/`waiting`-Klassifikation finalisieren (aus `SessionV1`/Runner-Daten).
5. Akzeptanz: Zeitlimit X greift; `stalled` erscheint; Lost-Event-Hang ist per Fallback aufgelöst; Tests.

### Phase 3 — (optional) Nested
- PR **#24638** re-validieren/übernehmen (descendants-Permissions, "show full subtask tree") +
  optional Tiefen-Nav/Voll-Baum. Orientierung für den Voll-Baum existiert bereits im Desktop/WEB
  (`app/src/context/server-session.ts` + `session-route.ts` lösen den Parent-Pfad; `SessionV1.parentID`).

**Reihenfolge-Empfehlung:** Phase 1 zuerst (liefert sofort den sichtbaren Nutzen, eigenständig);
Phase 2 als zweiter, sauber abgegrenzter Schub (ergeben die Selbst-Erlösung darunter); Phase 3 bei Bedarf.

---

## 6. Offene Fragen (beim Bau zu klären)
- Exakter `SessionV1.status`-Wertebereich + Mapping auf Tokens ("läuft/wartet/fertig").
- Wo liegt die Konfig für Timeouts (Config-Schema, Defaults) — und bleibt das Feature verhaltensneutral?
- Wie unterscheiden wir "wartet auf Provider" von "langsames Tool" zuverlässig (Reader-Delta vs. Uhr)?
- Skalierung: lange Sessions → unbegrenzte Liste? (v1 akzeptiert; manueller Collapse als späterer Zusatz).
- Wird der Block auch bei **0 laufenden/durchgeführten Subs** angezeigt (leer)? → Entscheidung laut
  User: immer sichtbar (auch kollabiert).

## 7. Strategie / Notizen
- **Mergebar halten:** Phase 1 ist TUI-only, verhaltensneutral für Nicht-Subagent-Nutzer, als upstream-PR
  vertretbar ("always-visible Agents overview + status"). Keine Architektur-/Config-Brüche.
- **Kein Scope-Drift:** keine Sidebar/Panels (verworfen), kein Voll-Baum in v1, Clipboard-Thema bleibt
  eigenes Feature (`toast-clipboard-feature.md`).
- **Bewusste Benchmarks:** Claude Code zeigt ähnliche Hänger/Silent-States; ein sichtbarer Status + Echt-Timeout
  wäre hier ein Differenzierungsmerkmal (siehe Memory #85297).
