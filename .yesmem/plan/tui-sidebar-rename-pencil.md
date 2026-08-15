# Sidebar-Feature: Rename-Stift (Pencil) neben Session-Titel

> [!IMPORTANT]
> Neue Worktrees und Feature-Branches immer vom aktuellen `working`-Branch abspalten — nicht von `dev` und nicht von einem zufälligen aktuellen `HEAD`.

Status: EINGEPLANT (noch nicht umgesetzt) · Stand: 2026-08-15
Kontext: In der Sidebar soll rechts neben dem Session-Titel ein Stift-Icon stehen, das den
Rename-Dialog öffnet. Der Nutzer will Session-Umbenennen ohne `/rename`-Slash oder Ctrl+R
entdecken zu müssen. Nur in der Sidebar macht das Sinn.

## Problem

- Rename existiert bereits (Command `session.rename`, Ctrl+R, `/rename`), ist aber nur über
  Tastatur/Slash erreichbar.
- Die Sidebar-Title-Zeile hat aktuell **keinen Platz für zusätzliche Aktionen**: der
  `sidebar_title`-Slot ist `mode="single_winner"` (sidebar.tsx:50) — ein Plugin würde den Titel
  ersetzen statt daneben zu treten. Ein Pencil braucht einen Aktions-Slot *neben* dem Titel.

## Datenlage / Vorbedingungen (im Code verifiziert)

- Rename-Dialog: `DialogSessionRename` (`packages/tui/src/component/dialog-session-rename.tsx`),
  geöffnet via Command-Handler `session.rename` (index.tsx:565-572).
- Sidebar-Titel-Zeile: `packages/tui/src/routes/session/sidebar.tsx:49-56`, `pluginRuntime.Slot
  name="sidebar_title" mode="single_winner"` mit Props `{ session_id, title, share_url }`.
- Slot-Prop-Typen in `packages/plugin/src/tui.ts:475` (`sidebar_title: { session_id, title,
  share_url? }` usw.; `session_prompt_right: { session_id }` als Muster für Aktions-Slots).
- Dialog-Zugriff in TUI-Plugins: `api.ui.dialog` (siehe `command-shim`-Pfad,
  `packages/tui/src/plugin/command-shim.ts`).

## Lösung (Design)

Kleiner Kern-Eingriff + Builtin-Plugin, zwei Teile:

**Teil A — Aktions-Slot in der Sidebar-Titelzeile (Host, minimal):**
- `sidebar.tsx:49-56`: rechts neben dem Titel-`<box gap={1}>` eine zusätzliche `<box>` mit
  `pluginRuntime.Slot name="sidebar_title_actions" mode="single_winner"` ergänzen (analog
  `session_prompt_right`).
- Typ registrieren in `packages/plugin/src/tui.ts` (neben `sidebar_title`):
  `sidebar_title_actions: { session_id: string; title: string }` — Props, die der Slot an Plugins
  reicht.
- Verhalten: wenn kein Plugin den Slot füllt, rendert er `null` → keine optische Änderung für
  Bestandsnutzer (Fallback bleibt der eingebaute Titel vollständig).

**Teil B — Builtin-Plugin "Rename-Pencil":**
- Datei: `packages/tui/src/feature-plugins/sidebar/rename-button.tsx` (neu, analog `context.tsx`)
- `id: "internal:sidebar-rename"`
- Füllt `sidebar_title_actions` mit einem Icon-Button (Stift, siehe Icon-Konventionen in
  `packages/ui/src/components/icon.tsx` bzw. TUI-Entsprechung; falls unklar: Textglyph `✎`).
- `onClick` → `props.api.ui.dialog` nutzen, um `DialogSessionRename(sessionID)` anzuzeigen
  (gleicher Dialog wie Command `session.rename`), oder alternativ den Command per API triggern.
- Keybind/Hint: `title="Rename session (Ctrl+R)"` für Barrierefreiheit/Entdeckbarkeit.
- Registrierung in `packages/tui/src/feature-plugins/builtins.ts`.

## Dateien

- `packages/tui/src/routes/session/sidebar.tsx` (Teil A: `sidebar_title_actions`-Slot, minimal)
- `packages/plugin/src/tui.ts` (Teil A: Slot-Prop-Typ)
- `packages/tui/src/feature-plugins/sidebar/rename-button.tsx` (Teil B, neu)
- `packages/tui/src/feature-plugins/builtins.ts` (Teil B: import + Liste)
- Test: `packages/tui/test/` — im Rahmen des Machbaren (Slot-Prop-Type-Check;
  Dialog-Öffnen als manueller TUI-Test, kein Unit-Test narrativ nötig).

## Akzeptanzkriterien / Verifikation

1. Pencil-Icon erscheint rechts neben dem Titel in der Sidebar (nur Sidebar, nicht Home).
2. Klick auf den Pencil öffnet `DialogSessionRename`; Rename speichert korrekt (Title aktualisiert
   sich in Titelzeile und Session-Liste).
3. Ohne andere Plugins in `sidebar_title_actions` → keine sichtbare Änderung am Layout
   (Fallback-Identität der Titelzeile).
4. `bun run typecheck` grün; manueller TUI-Check: Pencil sichtbar in wide + overlay-Sidebar,
   Klick-Flow, Ctrl+R weiterhin funktioniert (kein Konflikt), keine Regression an
   title/sessionID/workspace/share-Anzeige.

## Offene Fragen / Entscheidungen

- Icon: echtes Icon aus `packages/ui`-Set vs. Textglyph `✎` (TUI-Boxen rendern Unicode—
  Vorschlag: Glyph, da TUI-Icon-Set evtl. nicht in der Sidebar-Stilsprache liegt; testen).
- Rename-Aufruf: direkt `DialogSessionRename` importieren (Builtin darf Kern-Components nutzen)
  vs. Command-API triggern (einheitlicher Pfad). Vorschlag: direkt importieren — Builtin ist Kern.
- Slot-Name: `sidebar_title_actions` (Muster-konform) vs. `sidebar_title_right`.
  Vorschlag: `sidebar_title_actions`.
- Soll der Pencil bei `parentID`-Subagent-Sessions ausgeblendet werden (Sidebar zeigt diese ja nur
  bei Haupt-Sessions — Konsistenz prüfen)? Vorschlag: mit `sidebarVisible`-Logik ausblenden.

## Strategie-Anmerkung

Ein 2-Zeilen-Slot + kleines Builtin-Plugin = minimaler, kernsitiger Eingriff. Der Slot macht die
Titelzeile zusätzlich für externe TUI-Plugins erweiterbar (positive Nebenwirkung, kein
Zwang). Rename-Logik wird nicht dupliziert, nur wiederverbunden.
