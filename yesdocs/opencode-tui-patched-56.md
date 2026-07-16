# OpenCode TUI `1.18.1-patched.56`: Abweichungen vom Standard

Stand: 2026-07-16  
Aktiv installiert: `~/.opencode/bin/opencode`  
OpenCode-Branch: `recovered-45`  
OpenCode-Build-Commit: `4716241`  
OpenTUI-Branch: `main`  
OpenTUI-Stand: `f61d1c2`  

## Zweck und Bezugsstände

`patched.56` ist ein lokaler Performance- und Stabilitätsbuild für die OpenCode-TUI. Er ist kein einzelner
Patch, sondern kombiniert Änderungen in OpenCode und im lokalen OpenTUI-Fork.

Als „Standard“ gelten in diesem Dokument:

- OpenCode `origin/dev` am gemeinsamen Merge-Base `a27ffb2` vom 2026-07-15.
- OpenTUI v0.4.3 beziehungsweise der lokale Upstream-Stand `a0b9064`.

Der komplette OpenCode-Diff gegen `origin/dev` umfasst 37 Dateien mit ungefähr 1.708 hinzugefügten und 341
entfernten Zeilen. Der OpenTUI-Diff gegen `a0b9064` umfasst 15 Dateien mit ungefähr 797 hinzugefügten und 44
entfernten Zeilen. Ein Teil davon sind Tests und Diagnosehärtung, nicht nur Laufzeitcode.

## Kurzfassung

Gegenüber dem Standard enthält `.56` insbesondere:

1. getrennte Prozesse für TUI, lokalen TUI-Server und Modellarbeit;
2. Coalescing und Batching von Streaming-Deltas;
3. deterministischen SSE-Abbau und bereinigte Event-Subscriptions;
4. begrenztes, nachladbares Message-Window statt vollständiger langer Historien im Renderbaum;
5. einen OpenTUI-Partial-Render-Pfad für Spinner, laufenden Markdown und Codeblöcke;
6. Korrektheitsguards gegen schwarze Frames, Buffer-Desynchronisation und Backpressure;
7. O(1)-Generationsprüfung statt eines vollständigen Dirty-Tree-Scans pro Partial-Frame;
8. weniger unnötige Text-, Layout- und Code-Highlight-Invalidierungen;
9. einen neuen Fast Path für append-only Streaming innerhalb normaler Markdown-Absätze;
10. 30-fps-Kappe, vorab berechnete Spinnerframes und kontrollierte Stream-Taktung;
11. On-Demand-CPU-Profiling per Signal für weitere Untersuchungen.

Die Oberfläche und CLI-Verwendung bleiben gleich: Der Benutzer startet weiterhin `opencode` mit beliebigen
Parametern. Die Aufteilung in Prozesse und die Renderoptimierungen passieren intern.

## Laufzeitarchitektur

### Standard

Im Standard liegt ein großer Teil der TUI-, Server- und Modellarbeit in derselben Bun/JSC-Laufzeit oder ist
enger an den TUI-Prozess gekoppelt. Streaming-Deltas, Effect-Scheduling, JSON-Verarbeitung, Modellprovider und
Renderer konkurrieren dadurch stärker um Heap, GC und Eventloop-Zeit.

### `.56`

`88072db perf(tui): isolate streaming processes` führt zwei interne Grenzen ein:

- Der sichtbare TUI-Prozess bleibt für Eingabe, Solid-Reaktivität und OpenTUI-Rendering zuständig.
- Ein separater lokaler TUI-Serverprozess verarbeitet Server-, Event- und Sessionarbeit.
- Modellarbeit kann über `ai-process-client.ts`, `ai-process-worker.ts` und ein explizites IPC-Protokoll in
  einem eigenen Prozess laufen.

Die Dateien `process-server.ts`, `ai-process-client.ts`, `ai-process-worker.ts` und `ipc.ts` existieren im
Standard nicht. Buildskripte setzen die dafür notwendigen internen Defines. Das Verhalten der öffentlichen CLI
ändert sich nicht.

Wichtig: Prozessisolation senkt nicht automatisch die Summe aller CPU-Zeit. Sie verhindert vor allem, dass
Modell-/Server-GC den TUI-Eventloop blockiert, und macht Profile sowie Speicherursachen klarer zurechenbar.

## Streaming- und Event-Datenfluss

### SSE-Delta-Batching

`6771d26` und die Folgekorrekturen sammeln schnell aufeinanderfolgende Part-Deltas in `sync.tsx`, bevor sie in
den Solid-Store geschrieben werden. Das reduziert Store-Mutationen, Effect-Scheduler-Arbeit und Renderanfragen.

Die untersuchten Fenster waren:

- 16 ms: zu viele Updates;
- 100 ms: deutliche Senkung und weiterhin flüssig;
- 250 ms: kein weiterer belastbarer Gewinn und sichtbar weniger flüssig.

Deshalb bleibt 100 ms die Daten-Coalescing-Grenze. Die Spinneranimation ist davon logisch getrennt und kann
weiterhin schneller laufen.

### Modell-Delta-Coalescing

`5eb15d7 perf(opencode): coalesce streaming deltas` coalesciert zusätzlich Modell-Textdeltas, bevor sie die
nächste Schicht erreichen. `llm-coalesce.test.ts` deckt diesen Pfad ab.

### Session-Settling

`243d1b6` stabilisiert den Sessionstatus nach Streamende. Dadurch bleiben Busy-/Spinnerzustände nicht wegen
einer verspäteten Statusfolge unnötig aktiv.

### SSE-Lifecycle

`c9d5600`, `75ff364` und der Merge `7703203` ergänzen:

- `onCleanup()` für TUI-Event-Subscriptions;
- deterministische Disconnect-Erkennung;
- begrenzte SSE-Queues statt unbeschränktem Wachstum;
- expliziten Teardown für Event- und Global-Streams;
- Diagnosezähler und Integrationstests für offene/geschlossene Streams.

Das verhindert, dass alte Sessionverbindungen nach Neustarts weiter Events, Timer oder Speicher halten. Normale
idle Sessions werden dabei nicht beendet; sie sind keine „Streuner“.

## Lange Sessions und Message-Historie

`04f19c5` stellt windowed Rendering und Scroll-up-Paging wieder her:

- zunächst werden nur die jüngsten Nachrichten gerendert;
- das Fenster wächst über eine Ladder (`10`, `30`, `50`, `100`);
- am oberen Rand werden ältere Nachrichten nachgeladen;
- Scroll-Anchor und Window-Reset verhindern Sprünge beim Sessionwechsel.

Damit bleiben sehr lange Sessions benutzbar, ohne die komplette Historie gleichzeitig als OpenTUI-Renderables
zu mounten.

Ein späterer Versuch, das 150-ms-Scroll-Polling vollständig durch Events zu ersetzen (`c4f3213`, Build `.48`),
brachte in einer gleichzeitigen A/B-Messung nur ungefähr 0,07 Prozentpunkte TUI-Gewinn und verschlechterte die
Gesamtsicht durch Servervarianz. Er wurde mit `2170548` wieder entfernt. `.56` enthält diesen Versuch nicht.

## OpenTUI-Renderer

### Render-List-Wiederverwendung

`925f9a9` cached die Renderliste und baut sie nur bei relevanten Struktur-/Viewportänderungen neu auf. Besonders
ScrollBox-Culling profitiert davon.

Formales interleaved A/B im belasteten System:

- `scrollbox_viewport_culling`: 0,303 ms → 0,082 ms;
- ungefähr 73 % weniger Zeit in diesem Mikropfad;
- andere Szenarien blieben innerhalb des Messrauschens.

### Partial-Render-API

`30d0bec` ergänzt `requestPartialRender(renderable)` und `setPartialEligible(true)`. Wenn ausschließlich
geeignete Renderables geändert wurden, zeichnet OpenTUI nur diese in den persistenten Framebuffer und überspringt
den vollständigen Root-Tree-Walk.

OpenCode aktiviert diesen Pfad über `packages/tui/src/ui/partial-render.ts` für geeignete Komponenten. Dialoge
und andere Overlayzustände können ihn sicher deaktivieren.

Partial-Frames werden zu Full-Frames hochgestuft, wenn unter anderem:

- Layout/Yoga dirty ist;
- ein normaler Renderrequest offen ist;
- Console oder Split-Capture aktiv ist;
- ein Renderable zerstört oder gecullt wurde;
- der vorige native Frame nicht sicher committed wurde;
- ein Full-Repaint angefordert ist.

### Ursache und Fix der schwarzen Frames

Der native Renderer löscht beziehungsweise recycelt den nächsten Buffer nach dem Present. Ein Partial-Frame,
der nur den Spinner in diesen leeren Buffer zeichnete, ließ den Diff deshalb den übrigen Bildschirm als leer
interpretieren. Das erzeugte schwarze Flächen und Flackern.

Der dauerhafte Fix:

- kopiert vor einem Partial-Frame den zuletzt committed `currentRenderBuffer` in den `nextRenderBuffer`;
- zeichnet erst danach die partiellen Renderables darüber;
- verfolgt mit `lastFrameCommitted`, ob Terminal und Buffer sicher synchron sind;
- erzwingt nach Native-Failure oder Backpressure einen Full-Repaint.

Die Tests in `renderer.partial-commit-guard.test.ts` prüfen diese Buffer-Semantik direkt.

### Kein O(N)-Dirty-Scan pro Partial-Frame

Die erste korrekte Partial-Version prüfte vor jedem Partial-Frame den ganzen sichtbaren Renderbaum auf andere
dirty Renderables. Dieser Guard war sicher, wurde aber im Profil selbst zum Hotspot.

`4e2fd58` ersetzt ihn durch zwei Generationen:

- `ordinaryRenderGeneration` für normale Invalidierungen;
- `committedOrdinaryRenderGeneration` für den zuletzt vollständig abgearbeiteten Stand.

Sind beide verschieden, wird in O(1) auf Full-Render zurückgefallen. Der frühere Tree-Scan ist im produktiven
Pfad nicht mehr aktiv.

### Coalescing von Code- und Renderrequests

`78b04ab`, `c8db780` und `11b6f2f` verhindern das frühere Oszillieren:

- ein normaler Request löscht einen bereits geplanten Partial-Frame nicht mehr vorschnell;
- Streaming-Code bündelt Highlight-/Renderrequests;
- laufende Codeblöcke dürfen den Partial-Pfad nutzen;
- sichere Full-Frames bleiben bei Layout- oder Strukturänderungen erhalten.

### Same-line-Layout und redundante Textarbeit

`6e9ed18` überspringt `TextRenderable.content`-Arbeit, wenn derselbe String erneut gesetzt wird. Zuvor wurde ein
String vor dem Identitätsvergleich in ein neues `StyledText` umgewandelt, wodurch identische Inhalte trotzdem
Parser-, Buffer- und Layoutarbeit auslösten.

`7e01670` trennt Textänderung von Layoutänderung besser:

- Same-line-Updates markieren Yoga nicht pauschal dirty;
- Code misst vor/nach dem Update und markiert Layout nur bei echter Auto-Dimensionsänderung;
- ein redundanter Parent-Renderrequest im Markdown-Pfad entfällt.

Dadurch können append-only Zeilen partiell bleiben. Neue Zeilen, Wraps, Höhenänderungen und Scrollbewegungen
fallen weiterhin sicher auf Full-Render zurück.

## Neuer Markdown-Fast-Path in `.56`

### Profilierter Fehler

Ein 60-Sekunden-Sourcemap-Profil zeigte den dominanten TUI-Pfad:

`flushDeltas → Solid runComputation → markdown content setter → updateBlocks → parseMarkdownIncremental → Marked`

Obwohl OpenTUI bereits Tokens inkrementell wiederverwendet, musste Marked bei jedem Delta den instabilen
Block-Tail erneut durch den vollständigen Block-Lexer schicken. Eine einzelne Block-Heading-RegEx belegte 9,0 %
der TUI-Samples.

### Implementierung

`f59dc70 perf(core): fast-path streaming prose` behandelt nur einen engen, beweisbaren Fall:

- der neue Inhalt ist ein reines Append des bisherigen Inhalts;
- der Anhang enthält keinen Zeilenumbruch;
- der letzte Token ist ein normaler Paragraph;
- `raw` und `text` sind identisch;
- der Paragraph beginnt mit einem Unicode-Buchstaben oder einer Zahl;
- die bisherigen Token decken den bisherigen Inhalt exakt ab.

Dann bleibt der Blocktyp garantiert ein Paragraph. OpenTUI aktualisiert nur den letzten Paragraph-Token und
führt `Lexer.lexInline` aus. Der teure Block-Lexer wird übersprungen.

Für Überschriften, Listen, Tabellen, HTML, Code, ambige Markdown-Präfixe, Zeilenumbrüche und strukturelle
Änderungen bleibt der konservative Standardpfad unverändert. Insbesondere wurde `trailingUnstable=2` nicht
pauschal reduziert, weil das fortgesetzte Listen und Tabellen falsch tokenisieren kann.

### Beleg

Synthetischer, token-identischer Prose-Stream:

- vom Block-Lexer verarbeitete Zeichen: 89.969 → 34.418 (−62 %);
- Laufzeit: 224,8 ms → 93,7 ms (−58 %);
- Endtokens identisch zum vollständigen Marked-Parse.

Echtes 60-Sekunden-Streamprofil, `.54-profile` gegen `.55-profile`:

| Profilanteil | vorher | mit Fast Path |
|---|---:|---:|
| Markdown gesamt | 9,8 % | 1,8 % |
| Block-Heading-RegEx | 9,0 % | 1,1 % |
| Session-Updatepfad | 16,5 % | 6,8 % |
| Solid gesamt | 34,1 % | 26,4 % |
| Yoga | 8,6 % | 9,7 % |
| Spinner | 6,7 % | 6,2 % |

Der Energiemodus wechselte zwischen älteren und neueren Läufen auf `power-saver`; deshalb sind absolute
Zeit-/CPU-Werte dieser Profile nicht direkt gegeneinander auszuspielen. Die starke Verschiebung der Anteile und
der konkrete Stackrückgang belegen dennoch, dass der adressierte Lexerpfad tatsächlich abgefangen wird.

## Spinner und Framerate

Der Standardtakt wurde in `4a8190c` verändert:

- Ziel-Framerate von 60 auf 30 fps;
- Spinnerframes werden vorab berechnet;
- der frühere unnötige 50-ms-Komponenten-Churn wurde zunächst auf 100 ms reduziert;
- Spinner verwenden den Partial-Pfad, sodass ein schneller optischer Takt nicht automatisch einen vollständigen
  TUI-Tree-Walk auslöst.

Mehrere Versuche, Spinner und Markdown aggressiver oder vollständig getrennt zu zeichnen, erzeugten schwarze
Flächen. Enthalten ist nur die Variante mit persistentem Buffer-Restore und Commit-Guards, die in langen
Sessions ohne Flackern bestätigt wurde.

## Speicher und Garbage Collection

### Beobachtungen

- aktive Instanzen lagen anfangs häufig bei 650–900 MB RSS;
- HeapHelper-Threads dominierten viele heißen Thread-Samples;
- ein gesetztes `BUN_JSC_forceRAMSize=536870912` verursachte reproduzierbar extreme Idle-GC-Last;
- der TUI-Server entfernt diese Variable deshalb aus Kindprozess-Umgebungen;
- produktive Prozesse müssen ebenfalls ohne diese Variable gestartet werden.

`.56` enthält keine pauschale Heapbegrenzung. Der Fix reduziert Allokations- und Parser-Churn und isoliert
Heaps, ersetzt aber keine vollständige Heap-Retention-Analyse.

`models.dev` erzeugt außerdem einen messbaren Startup-Peak durch Schema-/Katalogaufbau. Ein verzögertes
Idle-Profil zeigte, dass dies kein dauerhafter Idle-Hotspot ist.

## Weitere enthaltene Änderungen

- Entfernung eines teuren `structuredClone`-Pfads aus früheren lokalen Patches.
- Logrotation beziehungsweise Begrenzung lokaler Beobachtungslogs.
- kleinere SDK-/Datenkontext-Anpassungen für die Prozessgrenzen.
- `OPENCODE_CPU_PROFILE=/pfad/{pid}.cpuprofile` aktiviert On-Demand-Profiling:
  - `SIGUSR1` startet das Profil;
  - `SIGUSR2` stoppt und schreibt es.
- `OPENCODE_PROFILE_BUILD=1` plus `--sourcemaps` erzeugt unminifizierte Diagnosebuilds. Das produktive `.56`
  ist wieder minifiziert.

## Bewusst nicht enthaltene Experimente

### Cache abgeschlossener Assistant-Nachrichten

Die Commits `05aa560` beziehungsweise historisch `ed869de/a1909dd` cached JSX abgeschlossener Nachrichten.
Der Versuch wurde in `.53/.54` erneut profiliert und anschließend mit `e87bc03` entfernt.

Frühere A/B-Werte:

- leere Historie: 65,7 vs. 65,3;
- zwei Nachrichten: 29,2 vs. 31,7;
- zehn Nachrichten: 27,3 vs. 27,9.

Aktuell sank Solid mit Cache ebenfalls nicht. Die vermeintlich heiße `InlineTool`-Zeile war eine irreführende
Sourcemap-Zuordnung; der vollständige Stack führte zum aktiven Markdown-Setter. Der Cache brachte keinen Gewinn
und hätte Stale-State-Risiken eingeführt.

### 250-ms-Streamingfenster

Weniger flüssig, kein zusätzlicher belastbarer CPU-Gewinn. Nicht enthalten.

### Scroll-Polling durch Events ersetzen

Zu kleiner TUI-Gewinn und keine Verbesserung der Gesamtsicht. Revertiert, nicht enthalten.

### Unsichere Partial-/Overlay-Varianten

Varianten ohne Buffer-Restore oder mit unzureichenden Commit-/Layout-Guards verursachten schwarze Flächen und
Flackern. Sie sind nicht enthalten.

### Permanente Diagnoseinstrumentierung

`OTUI_PARTIAL_DEBUG` wurde für `.52` bis `.55-profile` temporär eingebaut. Die Zähler belegten je nach Phase
hohe Partial-Anteile und null native Fehler. Die Instrumentierung wurde vor `.56` mit `f61d1c2` vollständig
entfernt.

## Aktuelle Messwerte

Alle Werte sind Momentaufnahmen; Provider-Tokenrate, Sessioninhalt, Terminalgröße, Hintergrundlast und
Energiemodus beeinflussen sie stark.

### `.56`, `power-saver`, eine lange Session

- Settled idle, 30 Sekunden:
  - TUI 2,97 %;
  - Server 2,63 %;
  - gesamt 5,60 %.
- laufender Stream, erstes Anlauffenster:
  - gesamt 11,06 %.
- laufender Stream, folgendes belastetes 30-Sekunden-Fenster:
  - TUI 15,53 %;
  - Server 20,86 %;
  - gesamt 36,39 %.

Zum Vergleich lag ein realer `.50`-Stream unter `balanced` bei ungefähr 60 % gesamt. Dieser Vergleich ist wegen
des unterschiedlichen Energiemodus und Providers nur richtungsweisend. Zu Beginn der gesamten Untersuchung
lagen einzelne Standard-/Altinstanzen häufig bei 66–96 % TUI-CPU; zusätzlich liefen mehrere Server-/GC-Heaps.

### Partial-Diagnose

Ein kontrollierter `.52-debug`-Stream erreichte zwischenzeitlich 802 Partial- zu 84 Full-Frames (90,5 %
Partial) bei nur 20 Layout-Bails und null Native-Failures. Der längere Lauf endete bei 2.385 Partial- und 260
Full-Frames, 139 Layout-Bails und ebenfalls null Native-Failures.

## Tests und Verifikation

Für den finalen Markdown-Fix:

- 22 Parser-Tests grün;
- 161 Markdown-, Streaming-, Tabellen-, Listen-, Code- und Flicker-Tests grün;
- 8 Partial-Commit-Guard-Tests grün;
- TUI-Typecheck grün;
- OpenTUI-Lint und Formatcheck grün;
- mehrere lange visuelle Streams ohne schwarze Flächen oder Flackern;
- Sourcemap-CPU-Profil vor/nach dem Fix;
- produktiver Idle- und Streamtest mit `.56`.

Die TUI-Gesamtsuite lief beim Message-Cache-Zwischenstand mit 191 Tests grün und einem vorbestehenden Skip.
Warnungen über eine fehlende temporäre `/tmp/opencode/state/kv.json` waren nicht testfatal.

## Build und Installation

OpenTUI muss zuerst gebaut und in die exakte Bun-Store-Abhängigkeit des OpenCode-Worktrees kopiert werden. Danach
wird OpenCode gebaut. Ein versehentliches `bun install` aus einem Worktree mit absolut verlinktem
`packages/opencode/node_modules` kann den Hauptcheckout-Paketbaum inkonsistent machen; deshalb wird im Build
`--skip-install` verwendet.

Vereinfachter Ablauf:

```bash
cd /home/chief/projects/opentui/packages/core
bun run build:lib

rsync -a --delete \
  /home/chief/projects/opentui/packages/core/dist/ \
  /home/chief/projects/opencode/.worktrees/recovered-45/node_modules/.bun/@opentui+core@0.4.3+2240c214a0f33214/node_modules/@opentui/core/

cd /home/chief/projects/opencode/.worktrees/recovered-45
OPENCODE_VERSION=1.18.1-patched.56 \
  bun run packages/opencode/script/build.ts --single --skip-install --skip-embed-web-ui

install -m 755 \
  packages/opencode/dist/opencode-linux-x64/bin/opencode \
  /home/chief/.opencode/bin/opencode
```

Prüfung:

```bash
/home/chief/.opencode/bin/opencode --version
# 1.18.1-patched.56
```

Bereits laufende Sessions behalten den alten geladenen Binary-Inode. Nur neu gestartete Sessions verwenden die
neu installierte Version.

## Bekannte Grenzen und nächste Schritte

1. `power-saver` und `balanced` dürfen bei absoluten A/B-CPU-Zahlen nicht vermischt werden.
2. Provider-Tokenrate muss für faire Vergleiche normalisiert oder durch mehrere interleaved Läufe gemittelt
   werden.
3. Listen, Tabellen und Codeblöcke benötigen weiterhin den konservativen Markdown-Blockparser; der neue Fast
   Path optimiert absichtlich nur normale Same-line-Prosa.
4. Yoga/Layout liegt im neuen Profil bei ungefähr 10 % und ist nun ein größerer relativer Restblock.
5. Der Serverprozess bleibt mit Effect-Scheduler, JSON-Parse/-Stringify und Eventverarbeitung ein wesentlicher
   Teil der Gesamtlast.
6. RSS bleibt pro Session hoch. Prozessisolation und weniger Churn helfen, lösen aber mögliche Retention großer
   Session-Historien nicht vollständig.
7. Vor weiteren Änderungen sollte `.56` mehrere Tage produktiv auf Markdown-Korrektheit, Listen, Tabellen,
   Codeblöcke, Flackern, Idle-GC und lange Streams beobachtet werden.

## Relevante Commitgruppen

### OpenCode

- `3686a04`: ursprüngliches lokales Performance-Bundle;
- `6771d26`, `243d1b6`: SSE-Batching und Session-Settling;
- `4a8190c`, `7721bd2`: TUI-Takt und Spinner-Partial-Wiring;
- `04f19c5`: windowed Messages und History-Paging;
- `c9d5600`, `75ff364`: Listener- und SSE-Lifecycle;
- `88072db`: Prozessisolation;
- `5eb15d7`: Modell-Delta-Coalescing;
- `6b5e516`: On-Demand-CPU-Profiling;
- `e87bc03`: Entfernung des erneut falsifizierten Message-Caches;
- `4716241`: finaler `.56`-Buildmarker.

### OpenTUI

- `925f9a9`: Render-List-Reuse;
- `30d0bec`, `984c3eb`: Partial-Render-API und Guard-Korrektheit;
- `46bb3ca`: Buffer-/Commit-Desync-Guard;
- `78b04ab`: Request-Coalescing;
- `c8db780`, `11b6f2f`: Streaming-Code-Coalescing und Partial-Eignung;
- `4e2fd58`: O(1)-Generationsguard statt Dirty-Tree-Scan;
- `6e9ed18`: identischen Text überspringen;
- `7e01670`: Same-line-Streams ohne unnötiges Yoga-dirty;
- `f59dc70`: Markdown-Prose-Fast-Path;
- `f61d1c2`: Entfernung der temporären Partial-Diagnose.

