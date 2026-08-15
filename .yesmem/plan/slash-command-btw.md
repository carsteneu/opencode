# Slash-Command /btw (#16992)

> [!IMPORTANT]
> Neue Worktrees und Feature-Branches immer vom aktuellen `working`-Branch abspalten — nicht von `dev` und nicht von einem zufälligen aktuellen `HEAD`.

Status: EINGEPLANT · Stand: 2026-08-15 · Kontext: Session-Kommandos/Kontext-Cluster
Ablage: `.yesmem/plan/` · Schwesterpläne: `slash-command-goal.md`, `slash-command-context.md`.

## Problem / Wunsch
Upstream-Issue **#16992** (181👍 — meistgewählt im Cluster): eine Möglichkeit, dem Modell **"nebenbei",
ohne den Haupt-Prompt umzustrukturieren**, eine Notiz zu geben — wie das bekannte `btw`-Muster
(vgl. Claude-Code-/Cursor-Umfeld).

## Abgrenzung
- `/btw` = einmalige, sofortige Beobachtung an das Modell (nicht persistent, nicht wiederholt).
- NICHT `/goal` (persistentes Session-Ziel, eigener Plan).
- NICHT normale Nachricht im Input: `/btw` injiziert als zusätzlicher Kontext-Part (z.B. ans System
  angehängt), ohne das laufende Unterhaltungsformat zu stören.

## Ist-Zustand (Anker, zu finalisieren in Phase 1)
- Slash/Input-Kommandos im Run-View: Referenz `packages/opencode/src/cli/cmd/run/footer.command.tsx`
  (zeigt, wie Befehle erkannt + im Footer aufgelistet werden).
- Prompt-Zusammenbau: `packages/opencode/src/session/prompt.ts` (`SessionPrompt.PromptInput["parts"]`
  — Teile stehen schon bereit; `/task.ts` nutzt parts ebenso).
- Es gibt bislang **kein** `/btw` (in Verifikation nicht gefunden).

## Design
- `/btw <text>`: Notiz wird als extra `part` (eigene Rolle/System-Element, gekennzeichnet "btw")
  in den Prompt eingefügt — an aktiver Generierung: wird der nächsten Turn-Injektion zugefügt; sonst
  sofort wirksam.
- Sichtbarkeit: als dezente, abgesetzte Zeile im Stream markieren (z.B. "ℹ btw: …"), damit der Nutzer
  das Verhalten versteht (Sichtbarkeit-Säule).
- Verhalten: nicht persistent, kein Repeat, kein Auto-Add.

## Umsetzungsplan (TDD)
1. **Phase 1:** Run-View-Befehlsregistrierung + `SessionPrompt.parts`-Mechanik lesen; Ort für Injection
   festlegen (System-After-Letzter-Punkt).
2. **Phase 2:** Befehl implementieren (Erkennung, Part-Erzeugung, Zustellung an nächsten Turn), Stream-Markierung.
3. Tests: `/btw` erscheint als Part im nächsten Prompt; nicht persistent; sauberes Format; keine
   Interferenz mit normalem Input; `/btw` ohne Text → Fehlerhinweis.
4. Akzeptanz: Notiz ist im Folge-Turn beim Modell; keine Format-/Prompt-Rückwirkungen; TYPECHECK grün.

## Offene Fragen
- Soll `/btw` auch **während** laufender Generierung abgebrochen/queued werden (interrupt+retry) —
  oder nur zwischen Turns? v1: zwischen Turns (einfach, sicher).
