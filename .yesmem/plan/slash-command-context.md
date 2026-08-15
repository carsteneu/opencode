# Slash-Command /context (#6152)

> [!IMPORTANT]
> Neue Worktrees und Feature-Branches immer vom aktuellen `working`-Branch abspalten — nicht von `dev` und nicht von einem zufälligen aktuellen `HEAD`.

Status: EINGEPLANT · Stand: 2026-08-15 · Kontext: Session-Kommandos/Kontext-Cluster
Ablage: `.yesmem/plan/` · Schwesterpläne: `slash-command-btw.md`, `slash-command-goal.md`.

## Problem / Wunsch
Upstream-Issue **#6152** (130👍): Kontext-/**Token-Auslastung** der Session anzeigen — wie das bekannte
`/context`-Muster (welches Modell, wie viele Tokens/Anfragen, wie viel Kontextfenster belegt).

## Wert / Synergie
- Direkter Nutzerwert (verbrauchte Tokens verstehen).
- Stützt die **Diagnostik-Säule** (`subagent-agents-status-block.md`, Pillar 4): "wo steckt es?" +
  "was kostet es?".

## Ist-Zustand (Anker, zu finalisieren in Phase 1)
- Token-/Kosten-Daten sind verfügbar: `routes/session/index.tsx` rechnet bereits `cost` aus
  (`msg.info.tokens`, Token-Werte); Session-Engines führen Token-Zählungen. Backend-/SDK-Anfragen
  existieren für Message-Metadaten.
- Slash/Kommando-Infra im Run-View: Referenz `packages/opencode/src/cli/cmd/run/footer.command.tsx`.
- Konsumentenseite: `/context` ist der Medium-Aufwand im Cluster (braucht Aggregation).

## Design
- `/context`: zeigt eine kompakte Session-Statistik, z.B.:
  Modell · Kontextfenster (max) · genutzt (n/nk) · Tokens gesamt · geschätzte Kosten (evo. je Rolle).
- Detail-Sicht kollabierbar/in Ausgabe; auf Wunsch je Nachricht (größter Anteil).
- Quelle: vorhandene Token-/Cost-Metriken aggregieren (keine neue Messung nötig — nur Zusammenfassung).

## Umsetzungsplan (TDD)
1. **Phase 1:** Nachvollziehen, wo Token-/Cost-Werte je Message enden (Session-Ansicht rechnet sie schon);
   API/Funktion für Aggregation über die Session definieren.
2. **Phase 2:** Befehl implementieren + formatierten Bericht als Kommando-Ausgabe (Run-View-Muster);
   optional TUI-Panel/Overview.
3. Tests: Zahlenstimmen gegen bekannte Stichprobe; leerfall (keine Daten); großes Fenster korrekt;
   Typecheck grün.
4. Akzeptanz: `/context` liefert eine korrekte, kompakte Auswertung für die aktuelle Session.

## Offene Fragen
- Nur TUI, oder auch CLI-Run-View? (v1: Run-View-Command wie `/skills`-Muster; optional später beides).
- Form: Tabellen-Einzeiler vs ausführlicher Report — beim Bau küren.
