# TUI-Plugin-Schicht überarbeiten — Roadmap (5 Schritte)

> [!IMPORTANT]
> Neue Worktrees und Feature-Branches immer vom aktuellen `working`-Branch abspalten — nicht von `dev` und nicht von einem zufälligen aktuellen `HEAD`.

Status: EINGEPLANT (noch nicht umgesetzt) · Stand: 2026-08-15
Kontext: Sidebar-Vorhaben wird über die TUI-Plugin-Schnittstelle realisiert (nicht per Fork). Vor
ungenutzter Feature-Entwicklung wird die TUI-Plugin-Schicht selbst gehärtet, damit alles Weitere
auf tragfähigem Grund steht. Server-Plugins sind hier ABSICHTLICH AUSGEKLAMMERT (separate
Themen: #42451, v2-Session-Domain).

## Zielbild

Die TUI-Plugin-Schicht soll den kompletten Lebenszyklus eines Plugins zuverlässig bedienen:
**Laden (Step 1) → Fehler sichtbar machen (Step 2) → Aktivierung persistent (Step 3) →
Schnittstelle erweiterbar & haltbar (Step 4) → optional zukunftssicher (Step 5).**
Jeder Schritt ist eigenständig anwendbar, aber die Reihenfolge ist aufgebaut: Step 1 ist die
Voraussetzung für alles Weitere.

---

## Step 1 — SEA-sichere Plugin-Ladung (#42481) · [DETAIL AUSFÜHRLICH]

### Problem (im Code verifiziert)

- Datei: `packages/opencode/src/plugin/loader.ts`
- `load(row)` (Zeilen 136–145) macht `mod = await import(row.entry)` (Zeile 139).
- In einem **Node-SEA/SEB-Binary** versagt natives `import()` einer `file://`-URL/externen
  Quelle zuverlässig mit `ERR_UNKNOWN_BUILTIN_MODULE` — Datei-Plugins lassen sich nicht laden.
- Derselbe `PluginLoader.loadExternal`-Pfad serviert sowohl **Server-Plugins** (loader.ts:208)
  als auch **TUI-Plugins** (`packages/opencode/src/plugin/tui/runtime.ts:677` → `loadExternal`).
  → Ein Fix hier hilft beiden Pfaden gleichzeitig (bei TUI das Ziel, Server profitieren mit).
- Unsere TUI-Runtime verarbeitet `file://`-Roots bereits (`resolveRoot`, runtime.ts:235–243),
  aber das Modul-Import selbst bleibt direktes natives `import()`.

### Technische Referenz

- Bug: [#42481](https://github.com/anomalyco/opencode/issues/42481) (open, Label `2.0`).
  - Fix-PR #42466 (closed) und #42485 (open): Umstellung auf ein gemeinsames,
    runtime-sicheres Import-Helper.
  - Ansatz: `importModule` aus `@opencode-ai/util/runtime-import` — **vm-basiert auf Node**,
    dynamisches `import()` auf Bun.
- In unserem Fork existiert **kein** `importModule`/`runtime-import`-Helper (Suche leer).
  → Wir müssen den Helper selbst anlegen oder eine äquivalente SEA-sichere Fallback-Logik bauen.
- Runtime-Detection-Muster ist etabliert: `typeof Bun === "undefined"` (z.B.
  `plugin/index.ts:163`, `plugin/openai/ws.ts:86`).

### Lösung (Design)

In `packages/opencode/src/plugin/loader.ts` den Modul-Import hinter eine kleine Funktion legen:

```ts
// loader.ts (skizziert)
async function importPluginModule(entry: string): Promise<unknown> {
  // Bun: natives dynamisches import() (bestehendes, performantes Verhalten).
  if (typeof Bun !== "undefined") return await import(entry)
  // Node/SEA: vm-basierter Fallback, der externe Datei-Module ohne natives
  // file://-import() laden kann (umgeht ERR_UNKNOWN_BUILTIN_MODULE).
  return importViaVm(entry)
}
```

- `load(row)` ruft künftig `importPluginModule(row.entry)` statt rohem `await import(row.entry)`.
- `importViaVm`-Helper platziert in `packages/util/src/runtime-import.ts` (gemeinsames Paket,
  analog zur vorgeschlagenen `runtime-import`-Struktur der Fix-PRs) — branchenweit
  wiederverwendbar.
- Verhalten unter Bun bleibt unverändert (keine Performance-Regression — der vm-Pfad wird nur
  unter Node/SEA aktiv); der Plugin-Compiler bleibt lazy-loaded (unser Fork-Standart, #84172).

### Akzeptanzkriterien Step 1 (TDD)

1. Test zuerst: `importPluginModule` lädt ein lokales `.ts`/`.js`-Plugin und liefert das
   erwartete Exportobjekt (benannt + default).
2. Unter Bun (`bun .` / laufende TUI) laden lokale TUI-Plugins unverändert & performant
   (Regression: bestehende Plugin-Tests + manueller lokaler Plugin-Load).
3. vm-Pfad lädt eine lokale `file://`-Plugin-Datei ohne `ERR_UNKNOWN_BUILTIN_MODULE`
   (Build-Simulationsfall).
4. `bun run typecheck` / Build der betroffenen Packages grün.

---

## Step 2 — Fehler-Sichtbarkeit beim Laden (#42379)

### Problem

Plugin-Load-Fehler laufen aktuell nur ins Dev-/`console`-Log oder werden verschluckt; im
Desktop- und Produktiv-Kontext sind sie unsichtbar. Referenz: PR #42379 (open), Issue #41817.

### Lösung

- `publishPluginError` (bzw. die TUI-/Loader-Fehlerpfade) zusätzlich auf **stderr** schreiben,
  damit Load-Fehler im Binary/Desktop sichtbar werden.
- Einheitlicher Fehlerpfad für TUI-Plugin-Load (Loader `report.error`, `onPluginError` in
  `packages/tui/src/plugin/slots.tsx` nutzt bereits `console.error` — auf stderr + TUI-Toast
  heben).
- Kontext anreichern: `{ path, target, retry, error }` (Felder existieren in loader.ts schon).

### Akzeptanzkriterien Step 2

1. Ein fehlschlagendes Plugin produziert eine sichtbare stderr-Zeile mit Pfad + Grund
   (nicht nur `console.debug`).
2. TUI zeigt Load-Fehler als Toast oder Statuszeile, wenn ein Plugin fehlschlägt.
3. Erfolgsfälle (regelkonforme Plugins) erzeugen keine zusätzliche Ausgabe (kein Noise).

---

## Step 3 — Aktivierungs-Persistenz (#42417)

### Problem

`/plugins` (/PluginManager)-Toggles mutieren nur die Laufzeit-Registrierung; deaktivierte
Plugins werden bei Hot-Reload/Neustart wieder aktiviert. Wahl ist nicht dauerhaft. Referenz:
Issue #42417 (open, Label `tui`), PR #42410 (open).

### Lösung

- Zustandsrequests aus der Laufzeit herausziehen und persistieren (analog `plugin_enabled`-KV,
  das `runtime.ts` nutzt — `KV_KEY = "plugin_enabled"` bei runtime.ts:123).
- Das Plugin-Manager-UI (`feature-plugins/system/plugins.tsx`) speichert Aktivierungs-Wahl
  persistent und wendet sie beim nächsten Start an.
- Konsistenz: `applyInitialPluginEnabledState` (runtime.ts:667) soll die persistierte Map
  als Quelle nutzen statt Defaults.

### Akzeptanzkriterien Step 3

1. Ein deaktiviertes Plugin bleibt nach `bun .`-Neustart deaktiviert.
2. `/plugins`-Toggle reflektiert den persistenten Zustand (Hot-Reload überlebt).
3. Bestehendes Verhalten für Nutzer ohne Wahl unverändert (Default alle aktiv wie heute).

---

## Step 4 — Slot-/API-Ausbau: erweiterbare Titelzeile & Platz für Plugin-Actions

### Problem (im Code verifiziert)

- `sidebar_title` ist `mode="single_winner"` (sidebar.tsx:50, Props in tui.ts:475): ein Plugin
  KANN den Titel nur **ersetzen**, nicht daneben treten. Kein Platz für Plugin-Actions
  (z.B. Rename-Pencil) in der Titelzeile.
- Sidebar-Inhalt ist 42px schmal (`contentWidth = width - (sidebarVisible ? 42 : 0) - 4`,
  index.tsx:332) — lange Inhalte (z.B. "letzte Eingabe") unlesbar ohne Kürzung.

### Lösung

- **Neuer `sidebar_title_actions`-Slot** rechts neben dem Titel in `sidebar.tsx` (Muster
  `session_prompt_right`), Prop-Typ in `tui.ts` registrieren. Ohne geladenes Plugin → `null`,
  kein sichtbarer Effekt. Konkret bereits umgesetzt durch den Plan
  `.yesmem/plan/tui-sidebar-rename-pencil.md` (Pencil) — dieser Step ist der generalisierte
  Überbau für beliebig mehr solcher Aktions-Slots.
- **Muster für weitere Slots** an anderen knaplen Stellen (z.B. `session_prompt`, `home_prompt`)
  nach Bedarf, je Feature.
- **TUI-typisierte API-Typen** für die neuen Slots in `packages/plugin/src/tui.ts` pflegen;
  die `experimental.*`-Shims in der TUI (`api.command` command-shim) NICHT erweitern, sondern
  schrittweise ersetzen.

### Akzeptanzkriterien Step 4

1. Plugin kann Action-Icon in der Titelzeile darstellen ohne den Titel zu ersetzen.
2. Ohne Plugin im Aktions-Slot: Titelzeile identisch zu heute (Fallback-Identität).
3. Slot-Prop-Typen dokumentiert und typisiert; keine neuen `experimental.*`-Shims.
4. Pencil-Feature (Rename-Dialog) läuft über diesen Slot (Integrationstest).

---

## Step 5 — Optionale Perspektive: v2-TUI-Pfad

### Problem

TUI hängt komplett auf v1-Slots/Feature-Plugins; es gibt kein v2-Pendant für TUI-Erweiterung
(nur server-seitig in `packages/core`). Mainline konvergiert auf v2 — langfristig droht die TUI
von der Ziel-Architektur abgehängt zu werden.

### Lösung (nur Sondierung, KEIN bauen hier)

- Bestandsaufnahme, ob/wo upstream ein v2-TUI-Plugin-Pfad entsteht; unsere Slots so halten,
  dass ein späterer Adapter möglich bleibt (kein Umbau jetzt).
- Diese Session-Struktur (Feature-Plugins + Slots) mit Skelett-Backwards-Compat begleiten;
  Entscheid für/gegen Investment in Step 5 erst nach Step 1–4 und nach Upstream-Lage.

### Akzeptanzkriterien Step 5

1. Sondierungs-Doku existiert (Bestandsaufnahme + Empfehlung, ob/wan v2-TUI).
2. Kein Code-Abbruch an bestehenden v1-Slots in Step 1–4 (Bewusst/Review-Kriterium).

---

## Abgrenzung / Nicht-Ziel global

- **Server-Plugins** sind ausgeklammert: Legacy-Loader-Härtung **#42451** und
  **v2-Session-Domain** (`.yesmem/plan/v2-plugin-session-domain.md`) sind separate Pläne.
- **Sidebar-Features** (Last-Input, Rename-Pencil) sind eigene Pläne, nutzen aber Step 4.
- Kein Umbau bestehender v1-`experimental.*`-Hooks (nur Ersatz wo Step 4 betroffen).

## Reihenfolge-Entscheidung

Step 1 zuerst (Fundament: ohne SEA-festes Laden ist jede weitere TUI-Plugin-Arbeit im Binary
undeproybar). Dann Step 2 (Fehler) vor Step 3 (Persistenz) — sichtbares Scheitern ist
günstiger als persistiertes Scheitern. Step 4 parallel zur Sidebar-Feature-Entwicklung. Step 5
nur nach Sondierung.

## Offene Fragen / Entscheidungen

- **Helper-Pfad Step 1:** `packages/util/src/runtime-import.ts` (gemeinsames Paket) vs.
  `packages/opencode/src/util/`. Vorschlag: `packages/util`.
- **vm-Setup Step 1:** PRs #42485/#42466 als Referenz lesen, deren vm-Implementierung
  übernehmen/stabilisieren statt neu erfinden.
- **Step 3 Speicherort:** `plugin_enabled`-KV erweitern vs. neue persistente Tabelle —
  Vorschlag: bestehender KV-Kanal (minimal Change).
- **Step 4 Slots:** nur `sidebar_title_actions`, oder sofort weitere (heutiger Bedarf: einer).
- **Step 5:** Investment ja/nein — erst nach Sondierung entscheiden (User/Strategie).

## Strategie-Anmerkung

Kleine, je eigenständig mergebare Beiträge — passend zur Fork-Strategie (mergebar bleiben,
Stabilität/Developer-Experience verbessern). Step 1 ist die größte technische Hürde (vm),
Steps 2–4 sind klein. Vor jedem Schritt die zugehörigen offenen PRs/Issues (#42481/#42417/
#42379) prüfen — ggf. direkt übernehmen statt nachbauen.
