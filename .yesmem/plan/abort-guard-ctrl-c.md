# Ctrl+C-Abort-Guard (#2999) — versehentliches Beenden verhindern

> [!IMPORTANT]
> Neue Worktrees und Feature-Branches immer vom aktuellen `working`-Branch abspalten — nicht von `dev` und nicht von einem zufälligen aktuellen `HEAD`.

Status: EINGEPLANT · Stand: 2026-08-15 · Kontext: TUI-Problemliste, Entscheidung im Design-Gespräch
Ablage: `.yesmem/plan/` · Schwesterpläne: `subagent-agents-status-block.md`, `toast-clipboard-feature.md`.

## Problem

Upstream-Issue **#2999** (Sinngemäß: "disable Ctrl-C"/versehentliches Beenden vermeiden): In opencode
ist **`ctrl+c` auf `app_exit` gebunden** — `keybind.ts:48`:
`app_exit: keybind("ctrl+c,ctrl+d,<leader>q", "Exit the application")`.
Ein **einziger** Ctrl+C (z.B. Muskelgedächtnis, Fehlkommando, Terminal-Fokus) beendet die **komplette
App** und zerstört damit die laufende Session-Arbeit. Schaden >> Nutzen bei versehentlichem Druck.

## Entscheidung (User, 15.08.)

Kein Config-Toggle, sondern: **Abort/Exit erfordert 2–3× Drücken** — erst dann passiert es nicht
versehentlich. Erster Druck armiert + zeigt Feedback ("nochmal zum Beenden"), weiterer Druck im
Zeitfenster führt aus.

## Ist-Zustand (verifiziert)

| Was | Stelle |
|-----|--------|
| Keybind `ctrl+c` → App-Exit (1 Druck = Exit) | `packages/tui/src/config/keybind.ts:48` (`app_exit`) |
| **Mehrfach-Druck-Guard existiert bereits** für `session.interrupt` (Escape): store-Zähler `interrupt`, `>=2` löst aus, Reset nach Fenster; "again to …"-Anzeige | `packages/tui/src/component/prompt/index.tsx:~400-424` (Keybind `session.interrupt` L400; `store.interrupt` Counter L304/414-424) |
| Exit-Kontext | `packages/tui/src/context/exit.tsx` (`useExit`) |

Wichtig: **Der Guard existiert nur am Interrupt-Pfad (Escape) — nicht am Exit-Pfad (Ctrl+C).**
Der `app_exit`-Pfad ist bislang nicht durch einen Mehrfach-Guard abgesichert (der
Dispatch-Ort von `app_exit` war beim Stand der Recherche nicht final geprüft → **Phase-1-Check**).

## Design

- **Konfigurierbares N** (Default vorschlagen: **2**, d.h. 2× für Interrupt, 3× für App-Exit —
  oder einheitlich 2). User: "2 oder 3×". Vorschlag: `interrupt` = 2x, `app_exit` = 3x getrennt.
- **Verhalten:** 1. Druck → Arm + sichtbares Feedback (Statuszeile/Footer: "nochmal drücken zum
  Fortfahren/Abbruch"), Timer-Fenster (z.B. 2 s) danach Reset. N-ter Druck innerhalb Fenster → ausführen.
- **Wiederholte Nutzung des existierenden Idioms:** `prompt/index.tsx`-Muster (Zähler, `>=N`,
  Reset, "again to …"-Anzeige) wiederverwenden/verallgemeinern statt doppelt zu implementieren.
- **Keine Regression:** `ctrl+d` (auch app_exit) und `session.interrupt` (Escape) bleiben wie gehabt;
  der Guard gilt für den versehentlicheren Weg.

## Umsetzungsplan

### Phase 1 — Recherche/Ankern (klein)
1. Dispatch-Ort von `app_exit` finden (wo der Exit tatsächlich ausgelöst wird, `useExit`/Keybind-Dispatch).
2. Prüfen, ob `app_exit` schon irgendwo einen Guard hat (kein so).
3. Das `prompt/index.tsx`-Guard-Idiom in einen shared Helper extrahieren (oder direkt am Exit-Pfad nachbauen).

### Phase 2 — Umsetzung (TDD)
1. Mehrfach-Guard auf `app_exit` (Ctrl+C) anwenden: Eingabe `N`, Zähler, Fenster, Feedback.
2. Optional einheitlich auf `session.interrupt` vermeiden (dort existiert schon).
3. Tests: Einzeldruck = kein Exit; N-ter Druck im Fenster = Exit; Reset nach Fenster; `ctrl+d`/Escape unverändert.
4. Akzeptanz: versehentlicher Ctrl+C beendet nichts; beabsichtigter Mehrfach-Ctrl+C beendet; Typecheck grün.

## Offene Fragen
- N-Werte (2 vs 3; getrennt Interrupt/Exit vs einheitlich) — beim Bau mit User final absichern.
- Fensterlänge (2 s? konfigurabel?).
- Wo erscheint das "nochmal drücken"-Feedback (Footer der Session; nicht aufdringlich).

## Strategie
Kleiner, verhaltensneutraler, upstream-mergebarer Sicherheits/UX-Fix (Default verhindert Datenverlust
durch Fehl-Ctrl+C, ohne den beabsichtigten Weg zu erschweren). Kein Config-Bruch.
