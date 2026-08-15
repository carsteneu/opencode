# Tokens/Sekunde im Footer (#5374)

> [!IMPORTANT]
> Neue Worktrees und Feature-Branches immer vom aktuellen `working`-Branch abspalten — nicht von `dev` und nicht von einem zufälligen aktuellen `HEAD`.

Status: UMGESETZT (2026-08-15, YesLoop agent-20260815-02) · Cherry-pick nach `working`: 000f81a796 + f3d15d366d + 4d16ffaa4d, Tests grün (274 pass/0 fail auf working) · Stand: 2026-08-15 · Kontext: Session-Kommandos/Kontext-Cluster, kleine UX-Wins
Ablage: `.yesmem/plan/` · Synergie: `subagent-agents-status-block.md` (Statusmodell `streaming → Tokens/s`).

## Problem / Wunsch
Upstream-Issue **#5374** (97👍): Nutzer wollen während der Generierung **Tokens/s** (+ n Tokens)
sehen — Live-Feedback zur Generierung, wie aus anderen Tools bekannt.

## Entscheidung (User, 15.08.)
Anzeige-Ort: **der TUI-Footer, wo auch Pfad/Branch steht** — verifiziert:
`packages/tui/src/feature-plugins/home/footer.tsx` (rendert directory + vcs branch).

## Ist-Zustand (verifiziert)
- Footer mit Pfad/Branch: `packages/tui/src/feature-plugins/home/footer.tsx`.
- Tokens/Streaming-Daten verfügbar über `message.part.*`-Events (Delta-Stream) und Message-Metadaten
  (`msg.info.tokens`, cost/token-Werte in der Session-Ansicht → `routes/session/index.tsx` rechnet
  bereits Cost; Token-Werte sind da).
- **Perf-Vorgabe (aus der CPU-Arbeit):** sparsame Aktualisierung — kein Hochfrequenz-Redraw.
  Sekunden-granular reichen (nicht pro Event).

## Design
- Anzeige im bestehenden Footer (pfad/branch-kompatibel): während eines laufenden `streaming` anzeigen
  `▸ 42 tok/s · 1.2k tok` (kollaps-sicher; ausblenden bei Idle/Ende).
- **Berechnung:** Token-Diff zwischen zwei `message.part`-Deltas geteilt durch verstrichene Zeit;
  gleitender Mittelwert über kurzes Fenster (2–5 s) gegen Zappeln.
- **Perf-Constraint (Pflicht):** nur die betroffene Footer-Teilstelle updaten, Sekunden-Takt,
  keine Vollredraws (gleiche Lektion wie Agents-Block/Render-Churn).
- **Synergie:** gleiche Token-Metrik nutzt später das Statusmodell des Agents-Blocks (`streaming →
  Tokens/s, n Tokens`) — diese Implementierung als geteilte, kleine Token-Rate-Quelle bauen
  (nicht doppelt).

## Umsetzungsplan
1. **Phase 1 (Recherche):** `home/footer.tsx` lesen; Hook/Component für Footer-Element identifizieren;
   wo `message.part.*`-Deltas in der TUI ankommen (bestehender Stream-Hook) nutzbar machen.
2. **Phase 2 (Umsetzung, TDD):** kleine Token-Rate-Quelle (gleitender Mittelwert) + Footer-Cell;
   nur-Show während streaming; Tests (Rate-Berechnung, Ausblenden, keine Loop-Instabilität).
3. **Akzeptanz:** Tokens/s sichtbar während Generierung; verschwindet im Idle; CPU-neutral
   (nur Delta/Teil-Updates, Sekunden-Takt); Idle/Kein-Stream → nichts.

## Offene Fragen
- Genau Anzeigeformat & wo im Footer (rechts? neben branch?). — beim Bau mit User final küren.
- Quelle der Token-Zahl: `message.part`-Deltas reichen (Streaming) — bei Nicht-Streaming n/A.
