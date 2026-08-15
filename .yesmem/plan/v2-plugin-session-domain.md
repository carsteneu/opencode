# v2-Plugin-System: Session-Domain als erste Brachflächen-Arbeit

> [!IMPORTANT]
> Neue Worktrees und Feature-Branches immer vom aktuellen `working`-Branch abspalten — nicht von `dev` und nicht von einem zufälligen aktuellen `HEAD`.

Status: EINGEPLANT (noch nicht umgesetzt) · Stand: 2026-08-15
Kontext: v2 ist die Ziel-Architektur (dev konvergiert auf specs/v2; dünner Core + Plugins). v1 ist
Legacy (kein neues Feature). Sidebar/TUI bleibt v1; Server-seitig ist v2 der relevante Erweiterungsweg.
Dieser Plan realisiert die erste brachliegende v2-Domain als eigene Arbeit — abgestimmt auf die
yesmem-Injektions-Erfahrung und die externen Feature-Requests.

## Referenz: Die Punkte aus der PLAN.md (upstream)

Quelle: `packages/plugin/src/v2/effect/PLAN.md` (515 Zeilen, im dev-Baum vorhanden). Die dort
beschriebene Ziel-API ist der Maßstab für jede v2-Arbeit:

1. **Authoring-Modell**: Plugin als `define({ id, effect })`; Setup registriert imperativ
   (`transform`/`hook`) statt Hooks-Objekt zurückzugeben. Config via `ctx.options`.
2. **Transform-/Hook-Split**: `transform` = replayable Domänen-Registrierung (ändert effektiven
   Zustand, Rebuild beim Registrieren/Disposen), `hook` = Live-Runtime-Interception (nicht
   replaybar). Beide nutzen die gleiche scoped Registration-Maschinerie (geordnet, disposal,
   Snapshots, Plugin-Order).
3. **Domänen-Set**: agent, catalog, command, integration, reference, skill, **session**, **tool**,
   plus `event.subscribe(type)` und `aisdk`. Compaction- und Prompt/Context-Hooks als Runtime-Hooks
   ("session prompt/context hooks as required", Migration Schritt 6).
4. **Domain-State-Model**: base state → Transform-Replay in Registration-Reihenfolge → Core-
   Finalisierung → Commit → Post-Commit-Event. Kein Cross-Domain-Transaction-API.
5. **Plugin-Order**: built-ins → models.dev → config-projectionen → provider-normalisierung →
   externe User-Plugins → Core-Finalisierung. Same-ID-Replacement behält Position.
6. **Boot-Batching**: Batch-Init, gebündeltes Rebuild je betroffener Domain, einmal pro Batch.
   Setup-Fehler schließt child scope und entfernt alle Vorher-Registrierungen.
7. **Event-Adapter** (Schritt 8, offen): SDK-Event-Discriminant-Map, `event.subscribe(type)` als
   typisierter Stream, Delegation an `EventV2.Service.subscribe`.
8. **Migrationsplan** (Schritte 1–9): öffentliche Contracts → Registration-Maschinerie → State-
   Evolution → Domänen-Transform-Hooks (inkl. Tool) → bestehende Plugins migrieren → Runtime-Hooks
   → Returned-Hooks entfernen → Event-Adapter → Verifikation. Schritt 9 (Verifikation) offen.

## Verifizierter Ist-Zustand (Code-Evidenz, diese Session)

- v2-**Host läuft**: `Plugin.node` hängt im HTTP-Server-Layer (`server.ts:224`), Host delegiert an
  `PluginV2.add` (`core/plugin/host.ts:194`), externe Ladung `internal.ts:105`. Tests grün
  (`bun test test/plugin/promise.test.ts + variant.test.ts` → 4/4 pass).
- v2-**Context exponiert heute nur 8 Domains**: agent, aisdk, catalog, command, integration,
  plugin, reference, skill (`packages/plugin/src/v2/effect/context.ts`). `promise`-API ist die
  getestete; `effect`-API ist Kanon, aber dünner abgesichert.
- **Brachflächen (geplant, aber NICHT exponiert/implementiert):**
  - `tool` — PLAN dokumentiert `ctx.tool.hook("execute.before/after")` + `ctx.tool.transform`;
    im Context/Host fehlt `tool` komplett. Core-Tool-Services existieren (`core/src/tool`,
    `tool-output-store.ts`), aber kein v2-Plugin-Zugriff.
  - `session` — PLAN listet `session` explizit als Domain; keine session-Property im Context.
  - `event` — nur Typdeklaration (`effect/event.ts`), `ctx.event.subscribe` nicht verdrahtet,
    Adapter laut PLAN Schritt 8 offen.
  - `filesystem`/`npm`/`location`/`path` — Interface-Shells, weder im Context noch im Host gebunden.
- **V1-Altlast**: `experimental.*`-Hooks (20+, u.a. `chat.messages.transform`) existieren im v1-
  Trigger-Pfad (Trigger `session/prompt.ts:1255`, `compaction.ts:350`; Typ `plugin/src/index.ts:282`),
  sind untypisiert und außerhalb des v2-Domänen-Modells.

## Externe Evidenz (Feature-Requests + Reddit)

Github-Requests, die genau an den Brachflächen hängen:
- Session-Lifecycle/Compaction (unsere Priorität): **#28695** (session lifecycle context hooks,
  persistent plugin state), **#30116** (memory-compaction awareness), **#35540** (finalization hook
  main+subagent), **#40863** (hidden/ephemeral sessions für Background-Tasks), **#28901** (per-turn
  Model-Override).
- Tool-Hooks (blockiert, zweite Stufe): #37164 (execute.before → native Permission-Approval),
  #39275 (PreToolUse/Stop-Hooks + Router), #39526 (text.delta-Streaming).
- Event/Permission: #34327 (Permission-Hook), #35408 (Model/Message-Mutation, per-provider),
  #30434 (User-Message blocken), #31051 (tui.session.select).
- Config-Ebene: #42332 (Plugin per-Agent), #34799 (Registration nach Location-Boot).
- Reddit (r/opencode, 1vo5erx): Klage "kein dynamischer Kontext pro Prompt" ist via v1-
  `chat.messages.transform` möglich — aber unauffindbar/hässlich (oVerde: "API surface is hot
  garbage"). Das dokumentierte Nutzerbedürfnis deckt sich mit dem, was wir im Proxy schon bauen.

## Our reason for "session zuerst" (yesmem-Erfahrung)

Aus dem yesmem-Memory (Injection-Kämpfe):
- **Cache-Breakpoint-Disziplin**: Alle Proxy-Injektionen gehen via `appendToLastUserMessage` in die
  letzte User-Message, nach dem Cache-Breakpoint (#49669, #49640, #49387). Injektion in den
  System-Block/ frühe Messages invalidiert den Prompt-Cache (#50962). → Jede v2-
  Messages-Transform muss dieselbe Invariante halten: **nur späte/letzte Messages mutieren**.
- **Trigger-Problem (ungelöst, Kern)**: Doc-Injection wurde gebaut und abgeschaltet
  ("correct ≠ useful"; #46390) — die Schwierigkeit ist nicht die Mechanik, sondern "was/wann
  injizieren". Ein bloßer Messages-Hook löst das nicht.
- **Wert**: Session-Lifecycle-/Compaction-Hooks geben plattformseitige Trigger-Signale
  (SessionStart, Compaction, Turn-Boundaries), die unsere Trigger-Lücke schließen können —
  strategisch wertvoller als die reine Messages-Injektions-Mechanik.

## Lösung (Design — erste eigene v2-Arbeit)

Ziel: `session`-Domain im v2-Plugin-Context etablieren, die zwei Fähigkeiten liefert:
1. **Lifecycle-Hooks** (SessionStart, SessionEnd, Subagent-Abschluss bei identifizierbaren
   Sessions) → pluginseitiger Zustand pro Session + Injektion an definierten Punkten.
2. **Messages-Transform** — bewusst **als Runtime-Hook mit Cache-Breakpoint-Regel**, nicht als
   freier Messages-Mutation.

Konkret (skizziert):
- `packages/plugin/src/v2/effect/session.ts` (neu): `session.hook("start"|"end"|"messages.pre")`
  + optionale `SessionDraft`-Editors analog zu bestehenden Domains. Der `PluginContext` (effect/
  promise) bekommt `readonly session: SessionHooks`.
- Host (`packages/core/src/plugin/host.ts`): `session`-Eintrag, verdrahtet auf Session-Dienste
  (`SessionV2`/`MessageV2`), plus Rebuild/Registration-Maschinerie analog zu agent/skill.
- **Cache-Invariante im Vertrag**: `session.hook("messages.pre", cb)`-Callback erhält Zugriff auf
  die berechnete Message-Liste und einen `appendSystemBlock`/`appendToLast`-Helfer (Proxy-Muster),
  aber kein freies `messages.push` auf frühe Nachrichten. Das ist der registrierte
  Design-Entscheid gegen die orginären PLAN-Formulierung.

Hinweis: Schritt 1 ist die **Design-Klärung gegen die offenen PRs** (#42485/#42466 für den
SEA-Import-HELPER nur als Referenz; hier relevanter: wie weit Session-Dienste im core-Host
existieren) — TDD, kein Umschreiben.

## Dateien (geplant)

- `packages/plugin/src/v2/effect/session.ts` (neu) — Session-Contracts (`SessionHooks`,
  `SessionDraft`).
- `packages/plugin/src/v2/effect/context.ts` — `readonly session` ergänzen.
- `packages/plugin/src/v2/promise/` — Session-Types re-exportieren (Promise-Spiegel).
- `packages/core/src/plugin/host.ts` — `session` anbinden (Service-Verdrahtung + Rebuild).
- `packages/core/test/plugin/` — `session.test.ts` (neue, TDD zuerst).
- Nicht berührt: `tool`, `event`, `filesystem` etc. bleiben separate Folgearbeiten.

## Akzeptanzkriterien / Verifikation (TDD gem. Projekt-Regeln)

1. `session.hook("start", cb)`-Registrierung in einem Test-Plugin invertiert eine Observable
   (vgl. `promise.test.ts`-Muster): grün.
2. `session.hook("messages.pre", cb)` mutiert NUR die letzte User-Message (Assertion: vorherige
   Messages unverändert, letzte erweitert) — belegt die Cache-Breakpoint-Invariante.
3. Dispose/Scope-Close entfernt die Registrierung; Rebuild-Verhalten analog zu agent/skill.
4. `bun test packages/core/test/plugin/` grün (inkl. bestehender 4 Tests) + `bun run typecheck`.
5. Kein Regression auf `editorial.*`-v1-Pfad (experimental-Hooks bleiben unberührt).

## Abgrenzung / Nicht-Ziel (Folgearbeiten, je eigenes Ticket)

- **tool-Domain** (#37164/#39275/#39526) — zweite Brachfläche, SEPARAT.
- **event.subscribe-Adapter** (PLAN Schritt 8) — SEPARAT.
- **SEA-sicherer Plugin-Import** (v1-TUI, #42481) — eigener Plan
  (`tui-plugin-layer-sea-safe-import.md`).
- **Legacy-Loader-Härtung** (#42451) — Server-v1-Crash, SEPARAT.

## Offene Fragen / Entscheidungen

- Welche konkret Session-Lifecycle-Ereignisse (persistente Sessions? Umschalten? Compaction?) sind
  im aktuellen dev-Session-Modell observabel — Vorab-Sondierung nötig (TDU: erst Code lesen).
- `effect`- oder `promise`-API als primärer Test-Spiegel? Vorschlag: beides, wie bestehende
  Domänen (promise-getestet, effect-Kanon).
- Injektions-Helfer (appendToLast) im v2-Vertrag ja/nein — oder bewusst nur Zugriff auf die
  vollständige Nachrichtenliste mit dokumentierter Invariante? Vorschlag: Vertrag + Dokumentation
  der Invariante, kein versteckter Helfer.

## Strategie-Anmerkung

Diese Arbeit ist die erste konkrete Eigengestaltung der v2-Welt in unserem Fork. Sie liefert den
plattformseitigen Trigger für yesmem (Session-Lifecycle statt Heuristik), adressiert eine
dokumentierte Upstream-Brachfläche (#28695/#30116 extern belegt) und hält die 
Cache-Breakpoint-Disziplin aus unserem Proxy-Abenteuer. Merge-Risiko: v2 ist Beta/hohe
Änderungsrate; deshalb strikt als kleine, eigenständige Domain bauen und die Contracts so nah wie
möglich an der PLAN.md-Konvention halten (singular, dotted hook names).
