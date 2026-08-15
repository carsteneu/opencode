# /skills Check (#7846) — ist der Wunsch schon gedeckt?

> [!IMPORTANT]
> Neue Worktrees und Feature-Branches immer vom aktuellen `working`-Branch abspalten — nicht von `dev` und nicht von einem zufälligen aktuellen `HEAD`.

Status: CHECK (verifiziert, 15.08.) · Ablage: `.yesmem/plan/`

## Auftrag
Upstream-Issue **#7846** (115👍, "skills command") — prüfen, ob opencode den Wunsch bereits erfüllt,
bevor man neu baut.

## Befund (verifiziert)
- **`/skills` existiert** im Run-View (`packages/opencode/src/cli/cmd/run/footer.command.tsx`):
  filtert Kommandos mit `source === "skill"`, zeigt Footer-Label `"/skills"`, Keywords z.B.
  `skill ${…}`, Empty-States "No skills found" / "Skills loading".
- **Skill-Discovery/-Quelle vorhanden:** `packages/opencode/src/skill/discovery.ts` (liest Skills,
  caching via `Global.Path.cache`); TUI-footer tippt "/skills" als Vorschlag.
- Tests decken das Verhalten ab (`opencode/test/cli/run/footer.view.test.tsx` → "/skills").
- Ausserdem gibt es `acp.directory.skill.list` (ACP-Skill-Auflistung über SDK).

## Urteil
Der Kernwunsch **"/skills" = Skills auflisten/comf/usen** ist **weitgehend gedeckt** (Kommando im
Run-View + Discovery). Es bleibt höchstens ein **UX-/Tiefen-Rest**: Entdeckbarkeit bzw. Detailansicht
eines Skills in der TUI (nicht in Plan aufgenommen — sollte nur als Folge-Idee bei Bedarf geprüft werden).

**Empfehlung:** kein eigener Bau für `/skills`; bei Bedarf nur kleine Entdeckbarkeits-Verbesserung
(z.B. Skill-Keyword-Liste im TUI-Footer zeigen). Archivierte Sessions (#6680) bleiben außen vor
(User-Entscheid: Session-Management-Thema).

## Nächste Schritte
- Kein Plan nötig. Aufnehmen als "reicht /skills?"-Erkenntnis für künftige Sessions.
