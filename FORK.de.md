# Hinweise zum Fork

Dies ist ein persönlicher Fork von [sst/opencode](https://github.com/sst/opencode) auf der v2-Linie. Er folgt dem Upstream und ergänzt ihn an wenigen Stellen. Upstreams eigene Dokumentation gilt weiter; diese Datei hält nur fest, was hier anders ist.

Aktuelle Basis: Upstream **2.1.4**.

## Installation und Aktualisierung

Die Releases kommen von `carsteneu/opencode`, nicht vom Upstream. Der Fork veröffentlicht im Release-Kanal `patched`, gebaut aus `workingv2`.

```
opencode upgrade
```

Der Befehl liest den Release-Kanal `patched` des Forks und installiert die neueste Vorabversion daraus. `packages/util/src/installation/fork-release.ts` ist die einzige Stelle, die Repository, Kanal, Tag-Muster und Asset-Namen festlegt; Updater und Build-Skript lesen sie beide, sodass sie nicht auseinanderlaufen können.

Nach einem Wechsel des Binaries muss der Hintergrunddienst neu starten:

```
opencode service restart
```

`opencode run` spricht mit diesem Dienst, nicht mit dem Binary auf der Platte. Ohne den Neustart läuft eine neue Sitzung weiterhin mit dem alten Code. Der Neustart beendet zugleich jeden laufenden Agenten, gehört also zwischen zwei Aufgaben und nicht mitten in eine Aufgabe.

Gebaut wird ausschließlich für Linux x64. Es entsteht genau ein Asset (`opencode-linux-x64`) samt `.sha256`-Datei. Für macOS und Windows gibt es keinen Build; der Updater meldet dort kein Update, statt zu scheitern.

## Was dieser Fork ergänzt

| Bereich | Verhalten |
| --- | --- |
| Prompt-Notizen | Ein Block je Sitzung in der Seitenleiste für Fragen, die nicht in den Verlauf gehören |
| Prompt parken | Der Knopf im Footer und `alt+s` nehmen den Text aus der Eingabe als offene Notiz und leeren das Feld |
| Seitenleiste | An der linken Kante ziehbar, 32 bis 72 Spalten, die Breite überlebt einen Neustart |
| Bildvorschau | Bilder einer Sitzung werden direkt dargestellt und bleiben sichtbar, während ein Turn läuft |
| Replay-Bereich | Zeigt die Schritte eines Turns mit ihren Änderungen |
| Todo-Liste | `todowrite` ist standardmäßig an. `"experimental": { "todo": false }` in `opencode.json` schaltet es ab |
| Beenden | `/exit` und der Befehl aus der Palette beenden sofort; `ctrl+c` behält seine Zwei-Druck-Sperre |

In einer Notiz bedeutet `alt+n` anlegen und `alt+s` den Text aus der Eingabe parken; am Zeilenanfang öffnet `▤` eine eingefangene Antwort, `▶` sendet, `✎` bearbeitet und `✖` löscht. `notes.history` öffnet eine durchsuchbare Liste, in der ab acht Notizen die übrigen hinter einer Zeile liegen, die dorthin führt.

Skripte, die nur der Fork kennt, stehen in `packages/cli/package.json`: `build:patched` und `release:patched`. Sie existieren upstream nicht; ein Merge darf diese Datei deshalb nie als Ganzes ersetzen.

## Ablauf einer Veröffentlichung

1. `workingv2` ist sauber und deckungsgleich mit `fork/workingv2`.
2. `bun run check` läuft grün.
3. Das Tag `2.1.4-patched.N` sitzt auf dem Merge-Commit und wird übertragen.
4. Die CI baut `opencode-linux-x64` und veröffentlicht eine Vorabversion.
5. Der Download wird gegen die `.sha256`-Datei geprüft, bevor er installiert wird.

Versionen im Kanal `patched` sind nach Version geordnet und nicht nach Datum; jede Veröffentlichung ist eine Vorabversion.

## Bekannte Eigenheiten

`packages/tui/test/app-lifecycle.test.tsx` enthält zwei Tests, die unter Last der vollen Suite scheitern und einzeln durchlaufen, auch auf einem reinen Upstream-Baum. Ein Ausfall dort gilt als Umgebungsfrage, solange er sich nicht einzeln reproduzieren lässt.

Die `experimental`-Schlüssel sind Core-Konfiguration und gehören in `~/.config/opencode/opencode.json`; `cli.json` nimmt nur TUI-Schlüssel an.
