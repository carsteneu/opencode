# Sidebar-Feature: Letzte Nutzer-Eingabe anzeigen

> [!IMPORTANT]
> Neue Worktrees und Feature-Branches immer vom aktuellen `working`-Branch abspalten — nicht von `dev` und nicht von einem zufälligen aktuellen `HEAD`.

Status: EINGEPLANT (noch nicht umgesetzt) · Stand: 2026-08-15
Kontext: Nutzer verliert oft den Überblick, was er zuletzt konkret getippt hat, und muss im Verlauf
scrollen. Lösung: eine Sidebar-Sektion, die die letzte abgeschickte User-Message dynamisch anzeigt
(gekürzt). Als internes Builtin-Feature-Plugin im Kern — kein External-Plugin-Pfad nötig.

## Problem

- In langen Sessions ist die letzte eigene Eingabe aus dem sichtbaren Fenster gescrollt.
- Der Nutzer will sie ständig griffbereit sehen, ohne `session.undo` zu öffnen oder zu scrollen.
- Anzeige der rohen Nachricht (lange Prompts) ist in der 42px-Sidebar unlesbar → Kürzung nötig.

## Datenlage / Vorbedingungen (im Code verifiziert)

- Plugin-API bietet Session-Zugriff: `api.state.session.messages(sessionID)` und
  `api.state.session.get(sessionID)` — gleiches Muster wie das Builtin
  `packages/tui/src/feature-plugins/sidebar/context.tsx` (dort `msg().findLast(...)`).
- Extraktions-Muster für "letzte User-Message, echte Textparts" existiert bereits:
  `packages/tui/src/routes/session/index.tsx:679` (`findLast((x) => x.role === "user")`) und
  `index.tsx:902` (Parts filtern: `part.type === "text" && !part.synthetic`).
- Builtin-Plugins sind Kern-Code unter `packages/tui/src/feature-plugins/` und werden über
  `packages/tui/src/feature-plugins/builtins.ts` (Liste in `createBuiltinPlugins()`) registriert.

## Lösung (Design)

Neue Builtin-Sidebar-Sektion analog zu `context.tsx`:

- Datei: `packages/tui/src/feature-plugins/sidebar/last-input.tsx` (neu)
- `id: "internal:sidebar-last-input"`
- Registriert `sidebar_content(...)`-Slot mit `order` (Steuerung der Position unter den Sidebar-
  Sektionen, analog `context.tsx`).
- Datenfluss im `View(props: { api, session_id })`:
  1. `createMemo(() => props.api.state.session.messages(props.session_id))`
  2. `findLast(m => m.role === "user" && m.parts.some(p => p.type === "text" && !p.synthetic))`
  3. Text-Parts konkatenieren (synthetic raus), Whitespace normalisieren
  4. Auf `MAX_CHARS = 220` kürzen mit `…` am Ende (einheitliche Konstante; Word-Boundary-schonend)
  5. Kein Text → "—" oder leer lassen (keine leere Sektion, `if (!text) return` optional)
- Rendering: Überschrift `<b>Last input</b>` (fg text) + Textzeile (fg textMuted), mehrzeilig
  (Sidebar erlaubt Wrap) mit `wrap="word"`, alles ohne Kern-Eingriff außerhalb der Plugin-Datei.
- Struktur & Konventionen: identisch zu `context.tsx` (imports aus `@opencode-ai/plugin/tui`,
  `BuiltinTuiPlugin`-Wrapping am Dateiende).

## Dateien

- `packages/tui/src/feature-plugins/sidebar/last-input.tsx` (neu, Hauptarbeit)
- `packages/tui/src/feature-plugins/builtins.ts` — `LastInput` importieren + Liste ergänzen
- Test: `packages/tui/test/` — die Text-Extraktion + Truncate als reine Unit-Funktion
  (siehe Akzeptanz); die Sidebar-Render-Schicht per TUI-Test/Manuell.

## Akzeptanzkriterien / Verifikation

1. Sidebar zeigt nach einer abgeschickten Nachricht die letzte User-Message (gekürzt mit `…`
   ab ~220 Zeichen, Intact-Word-Grenze).
2. Nur echte Textparts (kein `synthetic`, kein Tool-/Attachment-Only-Eintrag) fließen ein.
3. Leere/keine Eingabe → Sektion zeigt Platzhalter oder bleibt neutral (kein Crash).
4. Truncate/Extraktions-Logik als Unit-Tests grün (`bun test`), die Truncate-Konstante zentral.
5. `bun run typecheck` grün; manueller TUI-Check: Session mit langer + kurzer Eingabe,
   Sidebar-Varianten (wide/overlay), keine Regression an bestehenden Sidebar-Sektionen.

## Offene Fragen / Entscheidungen

- `MAX_CHARS`: 200 vs. 250 — Vorschlag 220 (User: "im Zweifel 200–250 ... gekürzt").
- Sektion immer zeigen (mit Leer-Wert) vs. nur wenn letzte Eingabe existiert? Vorschlag: nur bei
  vorhandener Eingabe anzeigen (Sidebar-Platz sparen) — aber auf Wunsch auch mit Platzhalter.
- Sollen **Sub-Agent-Messages** (`parentID`/kind) mit rein? Vorschlag: nur Haupt-Session-User-
  Messages, keine Sub-Agent-Eingaben (entspricht "meine letzte Eingabe").
- Eigener Slot vs. Reihenfolge-Position: reine `order`-Steuerung genügt (kein neuer Slot).

## Strategie-Anmerkung

Kleiner, verhaltensneutraler, kernsitiger Zusatz — kein External-Plugin, kein SEA-Loader-Risiko,
kein Plugin-Persistenz-Thema. Passt zur Fork-Strategie (Stabilität/UX verbessern, mergebar
bleiben). Die Truncate-Konstante + Extraktions-Funktion bewusst als testbare Units von der
Render-Schicht getrennt (TDD-günstig).
