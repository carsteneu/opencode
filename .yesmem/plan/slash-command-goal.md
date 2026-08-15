# Slash-Command /goal (#27167)

> [!IMPORTANT]
> Neue Worktrees und Feature-Branches immer vom aktuellen `working`-Branch abspalten — nicht von `dev` und nicht von einem zufälligen aktuellen `HEAD`.

Status: EINGEPLANT · Stand: 2026-08-15 · Kontext: Session-Kommandos/Kontext-Cluster
Ablage: `.yesmem/plan/` · Schwesterpläne: `slash-command-btw.md`, `slash-command-context.md`.

## Problem / Wunsch
Upstream-Issue **#27167** (129👍): ein persistentes **Session-Ziel** setzen, das dem Modell über die
ganze Session als wiederkehrender Kontext vorliegt (kein manuelles Wiederholen im Prompt).

## Abgrenzung
- `/goal <ziel>` = persistent für die Session; wird als Kontext-Eintrag kontinuierlich vorangestellt.
- `/btw` = einmalige Notiz (eigener Plan); `/goal` = Dauer-Auftrag.

## Ist-Zustand (Anker, zu finalisieren in Phase 1)
- Slash/Kommando-Infra im Run-View: Referenz `packages/opencode/src/cli/cmd/run/footer.command.tsx`.
- Prompt-Zusammenbau mit Teilen: `packages/opencode/src/session/prompt.ts` (`SessionPrompt.PromptInput.parts`).
- Persistenz-Mechanismen vorhanden: Session-/KV-Store bzw. Session-Metadaten (wie `thinking_mode`-KV-Muster:
  `packages/tui/src/context/thinking.ts` löst `show/hide`; analog wäre `session.goal` speicherbar).

## Design
- `/goal <text>`: speichert das Ziel in der Session-Metadaten (`goal`-Feld/KV); Überschreiben erlaubt;
  `/goal` ohne Text zeigt das aktuelle Ziel; Leerungsoption (`/goal clear` o.ä. — im Final-Küren).
- **Prompt-Wirkung:** Ziel wird als fester, hervorgehobener Kontext-Part am Anfang jeden Turn-Inhalts
  eingefügt (System-Level), sodass es die ganze Session wirkt.
- **Sichtbarkeit:** im Session-Header/Footer (`home/footer.tsx`-Bereich) als klopper Kennzeichen
  anzeigen (z.B. "🎯 <goal>"), damit klar ist, dass es aktiv ist.

## Umsetzungsplan (TDD)
1. **Phase 1:** KV/oder Session-Meta-Persistenz + Prompt-Parts-Mechanik lesen; Ort für den
   Ziel-Part-Einbau festlegen; Anzeigeplatz im Footer.
2. **Phase 2:** Befehl (set/clear/show) + Persistenz + Prompt-Einbau + Footer-Anzeige.
3. Tests: Ziel überlebt Turns (persistent in dann neuem Turn im Prompt); `/goal` oh-ne Text zeigt;
   clear entfernt; keine Wirkung ohne gesetztes Ziel; Typpcheck grün.
4. Akzeptanz: einmal `/goal X` gesetzt, ist X in jedem Folge-Prompt aktiv; UI zeigt es; kein Einfluss
   auf Sessions ohne Ziel.

## Offene Fragen
- Mehrere Ziele / Prioritäten? v1: **ein** Ziel pro Session (einfach).
- Sichtbarkeit im Stream-Header vs nur Footer — beim Bau entscheiden.
