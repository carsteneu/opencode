# OpenCode TUI `1.18.1-patched.90`: Punkte 1 bis 5

> [!NOTE]
> Status: **ABGEARBEITET** (Bestätigung 2026-08-17) — inkl. einiger Zusatzarbeiten. Die Punkte 1-4
> sind umgesetzt; Punkt 5 (SQLite-mmap/Page-Cache) war bewusst ohne Patch.

- Stand: 2026-07-19
- Ausgangsbuild: `1.18.1-patched.89`, OpenCode `d2e431a`, OpenTUI `77e2e1e`
- Endstand OpenCode-Laufzeitcode: `ba53a9e`
- Endstand OpenTUI: `3452ce0`
- Binary-SHA-256: `361fc994a82278148f010a70d71b7bc93a0c82807a1e1d0d2627cec9c7bf2efe`
- Finales A/B-Profil: `power-saver`; alle Arme eines Vergleichs liefen im selben Profil

## Ergebnis in Kürze

Vier der fünf untersuchten Punkte ergaben echte Codeverbesserungen. Punkt 5 ergab bewusst keinen Patch: SQLite
nutzt bereits kein `mmap`, und eine kleinere Page-Cache-Grenze spart im relevanten History-Workload kaum
Prozess-RSS, macht ihn aber deutlich langsamer.

Die neuen Änderungen sind zusätzlich zum bereits direkt gemessenen Gewinn von `patched.89` gegenüber dem
offiziellen OpenCode 1.18.1 zu verstehen. Sie dürfen nicht aus unterschiedlichen Workloads arithmetisch addiert
werden:

| Vergleich                   | Workload                                  | Task-Zeit | Instruktionen | Aussage                                    |
| --------------------------- | ----------------------------------------- | --------: | ------------: | ------------------------------------------ |
| Stock 1.18.1 → `patched.89` | ein wachsender Absatz, 18.960 Bytes       |   −51,1 % |       −41,3 % | bisheriger direkter Gesamtvergleich        |
| `patched.89` → `patched.90` | ein wachsender Absatz                     |    −1,8 % |        +0,8 % | neutrale Kontrollbedingung                 |
| `patched.89` → `patched.90` | 240 stabil werdende Absätze               |    −8,8 % |        −9,0 % | neue Tail-/Delta-Arbeit greift             |
| Stock 1.18.1 → `patched.90` | 240 stabil werdende Absätze, 10.080 Bytes |   −27,9 % |       −47,3 % | direkter Endvergleich, nicht hochgerechnet |

Der Endvergleich zählt im Median aus drei frischen Sessions 14,990 → 7,905 Milliarden Instruktionen. Die
Task-Zeit fällt von 28.858 → 20.817 ms im achtsekündigen Messfenster. User-Cycles fallen von 15,463 → 8,013
Milliarden (`−48,2 %`). Mehr als 100 % CPU ist erwartbar, weil `task-clock` die parallel laufenden JSC-Threads
summiert.

Die stärkere Reduktion der Instruktionen als der Task-Zeit ist kein Widerspruch: `.90` verteilt Arbeit auf TUI,
lokalen Server und AI-Worker; Takt, Parallelität und Scheduler beeinflussen die Task-Zeit, nicht aber die Zahl
der ausgeführten Instruktionen in gleicher Weise. Der finale A/B lief deshalb zusätzlich mit
`instructions:u` und `cycles:u`.

## 1. Unnötigen TUI-Servicegraph entfernen

### Einordnung

Das ist nativer OpenCode-Code. Es ist weder ein Yesmem-Tool noch ein externes Plugin. Betroffen sind der
OpenCode-TUI-Entrypoint und der interne TUI-Pluginhost. Der Produkt-A/B lief mit `--pure`, also ohne externe
Plugins.

`AppNodeBuilder.build(...)` zieht über seinen generischen Builder Location- und weitere Services in den
statischen Importgraphen. Die TUI benötigt an diesen beiden Stellen nur die bereits deklarierte Node-Layer.
`LayerNode.compile(...)` stellt genau diese Layer bereit, ohne den Builder-Graph zu laden.

Änderung: OpenCode `617710f fix(tui): avoid loading location services`.

### Belege

Ein exakter Bundle-A/B nur an der Importgrenze ergab:

| Importpfad             |  Module | JavaScript-Bytes |
| ---------------------- | ------: | ---------------: |
| `AppNodeBuilder.build` |   2.506 |       15.860.117 |
| `LayerNode.compile`    |     483 |        3.889.740 |
| Änderung               | −80,7 % |          −75,5 % |

Ein echter gleichzeitiger Attach an denselben bereits laufenden Server, mit ansonsten identisch gebauten
Binaries, bestätigte den Effekt im Produkt:

| 30-s-Attach   |     Builder |       direkte Layer |        Änderung |
| ------------- | ----------: | ------------------: | --------------: |
| Task-Zeit     |    3.819 ms |            1.303 ms |         −65,9 % |
| User-Cycles   |  3,331 Mrd. |          1,113 Mrd. |         −66,6 % |
| Instruktionen |  2,901 Mrd. |          0,916 Mrd. |         −68,4 % |
| RSS           | 241.196 KiB | 236.872–238.884 KiB | ungefähr −1,8 % |

Damit sind sowohl die statische Ursache als auch die tatsächlich vermiedene Laufzeitarbeit belegt.

## 2. Markdown-Reconciliation auf den instabilen Tail begrenzen

OpenTUI konnte Tokens inkrementell parsen, baute danach aber bei jedem Update erneut Renderblock-Beschreibungen
für alle stabilen Tokens und lief wieder durch deren Reconciliation. `BlockState.sourceTokenEnd` merkt nun, bis
zu welchem Quelltoken ein vorhandener Renderblock reicht. Eine binäre Suche findet den vollständig stabilen
Blockpräfix; nur der instabile Tail wird gebaut und reconciled.

Änderung: OpenTUI `48969c4 fix(core): reconcile streaming markdown tail`.

### Belege

- Der neue Test instrumentiert den stabilen Token. Vor dem Patch wurde dessen `raw` beim Folgeupdate erneut
  gelesen; die Failing-first-Gegenprobe erwartete null Zugriffe und erhielt einen. Nach dem Patch bleibt der
  stabile Block vollständig unangetastet.
- Ein Benchmark mit einem echten `MarkdownRenderable`, 500 stabilen Blöcken und 500 Appends maß im Median
  1.779,8 → 682,3 µs pro Update (`−61,7 %`).
- Ein erster, flacherer Versuch übersprang nur Teile der Reconciliation, baute aber weiterhin alle Blöcke. Er
  brachte keinen messbaren Gewinn und wurde vor dem finalen Patch verworfen. Das grenzt die Ursache auf den
  tatsächlich vermiedenen stabilen Blockbau ein.

## 3. Explizite Streaming-Deltas bis OpenTUI weiterreichen

Auch bei einem bekannten Append prüfte der Parser bislang mit `newContent.startsWith(oldContent)` erneut den
gesamten gewachsenen Präfix. Zusätzlich summierte er wiederholt alle Token-`raw`-Längen.

OpenCode hält nun nach einem Delta-Flush nur eine kleine Provenienz
`{ fromLength, toLength, revision }`. Der Text-Part trimmt einmal, leitet bei exakt passender Provenienz nur das
sichtbare Suffix ab und reicht `{ content, appended }` an OpenTUI. Ein Vollsnapshot, eine Entfernung oder eine
nicht passende Revision löscht beziehungsweise verwirft die Provenienz; dann bleibt der sichere Vollwertpfad.
Es wird kein zweiter vollständiger Text im Provenienz-Cache gehalten.

OpenTUI akzeptiert das Suffix als vertrauenswürdiges Append, wenn die Längen exakt passen. Zusätzlich cached
`ParseState.tokenRawLength` die bereits belegte Quelllänge. Alle strukturellen oder nicht append-only Updates
fallen weiterhin auf den bisherigen Parserpfad zurück.

Änderungen:

- OpenTUI `3452ce0 fix(core): accept streaming markdown deltas`
- OpenCode `83fec44 fix(tui): forward streaming markdown deltas`

### Isolierte Belege

- Tests decken korrekte Append-Provenienz, Revisionen, Snapshot-Invalidierung, den OpenTUI-Setter und die
  Solid-Reconciler-Integration ab.
- Bei 2.000 vorhandenen Blöcken und weiteren Appends sank die Updatezeit von ungefähr 1,537–1,741 auf
  1,143–1,257 ms (`rund −27 %`). Bei nur 500 Blöcken lag der Zusatzgewinn bei ungefähr 9 %; der vermiedene
  Präfixscan skaliert erwartungsgemäß mit der Inhaltslänge.

### Produkt-A/B gegen `patched.89`

Der Harness startete jedes Mal ein leeres Projekt mit isoliertem `HOME` und XDG-Pfaden in einem echten
156×65-`tmux`, `--pure`, identischem OpenAI-kompatiblem lokalen Provider und exakt 240 Chunks im Abstand von
25 ms. `perf stat` maß acht Sekunden ab dem im Serverlog bestätigten normalen Provider-Turn. Fake-Provider und
OpenCode liefen in getrennten Prozessen.

Die Ein-Absatz-Kontrolle zeigt keine erfundene Pauschalverbesserung:

| Median aus 3 Läufen, alle OpenCode-Prozesse |       `.89` |       `.90` | Änderung |
| ------------------------------------------- | ----------: | ----------: | -------: |
| Task-Zeit                                   | 19.596,8 ms | 19.244,3 ms |   −1,8 % |
| Instruktionen                               |  7,597 Mrd. |  7,658 Mrd. |   +0,8 % |

In einem einzigen wachsenden Block gibt es keinen großen stabilen Blockpräfix, den Punkt 2 überspringen könnte.
Beide Werte liegen hier im Messrauschen.

Mit 240 separat stabil werdenden Absätzen ergibt sich dagegen:

| Median aus 3 Läufen, alle OpenCode-Prozesse |       `.89` |       `.90` | Änderung |
| ------------------------------------------- | ----------: | ----------: | -------: |
| Task-Zeit                                   | 22.834,9 ms | 20.816,9 ms |   −8,8 % |
| User-Cycles                                 |  8,703 Mrd. |  8,013 Mrd. |   −7,9 % |
| Instruktionen                               |  8,690 Mrd. |  7,905 Mrd. |   −9,0 % |

Der isolierte Renderable-Benchmark beweist die Ursache; der Produkt-A/B beweist, dass sie im echten
OpenCode-Datenpfad erreicht wird. Der `.89`→`.90`-Produktwert ist kumulativ für Punkte 1 bis 4 und wird deshalb
nicht ausschließlich Punkt 2 oder 3 zugerechnet.

## 4. Arbeit an Tool-/Provider-Schrittgrenzen reduzieren

### Kompaktierte History

`filterCompactedEffect` materialisierte bislang über `stream(sessionID)` die gesamte Session, obwohl die
relevante Compaction-/Tail-Grenze häufig in der neuesten Seite liegt. Der Scan ist nun zustandsbehaftet und lädt
50 Nachrichten pro Seite, von neu nach alt, bis die exakte Grenze gefunden ist. Die öffentliche exhaustive
Variante verwendet dieselbe Scanlogik; dadurch wird keine zweite Semantik in den Test kopiert.

Ein echter Datenbanktest mit 120 alten Nachrichten und der Grenze in der neuesten Seite erzeugt bytegleiches
Ergebnis zur vollständigen Variante. Gemessene Läufe:

- paginiert: 30,30 / 24,57 ms;
- exhaustive: 63,68 / 67,46 ms;
- Gewinn: `−52 %` bis `−64 %`.

### Snapshot-Patches

Nach einem Step-Ende erzeugte `track()` bereits einen fertigen Snapshot. `patch(from)` rief danach trotzdem
noch einmal `add()` auf und diffte gegen den aktuellen Index. `patch(from, completedSnapshot)` diffed nun direkt
zwischen den beiden unveränderlichen Trees. Das spart den zweiten Dirty-File-Capture und macht die zeitliche
Grenze zugleich genauer.

Der Korrektheitstest ändert nach dem fertigen Zielsnapshot nochmals eine Datei und beweist, dass diese spätere
Änderung nicht in den Step-Patch rutscht. Reale Timingläufe:

- Tree-zu-Tree: 187,26 / 190,42 ms;
- alter Current-Index-Pfad: 235,58 / 286,17 ms;
- Gewinn: `−20,5 %` bis `−33,5 %`.

Änderung: OpenCode `ba53a9e fix(opencode): reduce step boundary work`.

Diese Werte sind lokale Kosten genau an einer Grenze. Ihr Anteil an einer kompletten Session hängt von
Historylänge, Dateizahl und Toolfrequenz ab; sie werden nicht als pauschale Streaming-Prozentzahl ausgegeben.

## 5. SQLite-`mmap` und Page Cache

Hier wäre ein Patch kontraproduktiv gewesen.

Die reale Datenbank `/home/chief/.local/share/opencode/opencode.db` war 6.734.438.400 Bytes groß. Sowohl
`sqlite3` als auch `bun:sqlite` meldeten `PRAGMA mmap_size = 0`; `/proc/<server>/maps` enthielt nur die 32-KiB-
SHM-Datei, nicht die Datenbank selbst. Ein explizites `PRAGMA mmap_size=0` hätte daher exakt den bereits aktiven
Zustand festgeschrieben und keinen RAM gespart.

Die Datenbank hatte 1.644.150 Seiten, davon 481.225 Seiten auf der Freelist, also ungefähr 1,84 GiB intern
freien Platz. Das ist eine separate mögliche Wartungsaufgabe (`VACUUM` mit ausreichend freiem Speicher und
Downtime), aber kein Beleg für laufende CPU-Last und wurde nicht ungefragt ausgeführt.

OpenCode nutzt `PRAGMA cache_size=-64000`, also ungefähr 64 MiB Page Cache. Zwei Gegenproben:

| Workload                                                                             |                         64 MiB |                               16 MiB | Ergebnis                                                           |
| ------------------------------------------------------------------------------------ | -----------------------------: | -----------------------------------: | ------------------------------------------------------------------ |
| vollständiger `part`-Tabellenscan                                                    |                 ca. 77 MiB RSS |                     ca. 23,5 MiB RSS | 16 MiB spart beim Worst-Case-Scan RAM; Laufzeit stark lastabhängig |
| wiederholtes Paging der größten Session (2.926 Messages, 10.560 Parts, 9,1 MiB JSON) | 1,59–1,68 s; ca. 115,2 MiB RSS | 2,42–2,73 s; ca. 111,7–112,0 MiB RSS | ungefähr 40 % langsamer für nur ca. 3 MiB Prozess-RSS              |

32 MiB lag beim Paging nahe am 64-MiB-Wert, war beim großen Scan aber langsamer; 4 MiB reduzierte den Scan-RSS
auf 10,4 MiB und erhöhte die Laufzeit auf 13,84 s. Für den normalen Sessionzugriff ist 64 MiB die sinnvollere
Voreinstellung. Deshalb: kein Placebo-`mmap`-Patch und keine globale Cache-Verkleinerung.

## Tests und bekannte Grenzen

- OpenCode: `bun typecheck` in `packages/opencode` und `packages/tui` grün.
- OpenCode Punkt 4: 68 ausgewählte Session-/Message-/Processor-/Race-Tests grün.
- Snapshot-Suite: 56 grün, 1 übersprungen, 0 fehlgeschlagen, 737 Assertions.
- OpenTUI-Core: 186 relevante Markdown-/Parser-/Renderable-Tests grün; die Solid-Integration für
  `contentUpdate` ist grün.
- Der neue OpenCode-Sync-Hydration-Test ist grün.
- Die vollständige TUI-Suite hatte 190 grüne, 1 übersprungenen und 3 fehlschlagende Diff-Viewer-Tests. Nach
  Anlegen des von diesen Tests erwarteten `/tmp/opencode/state/kv.json` blieben zwei leere Frame-Snapshots
  fehlerhaft. Die geänderten Sync-/Markdown-Bereiche sind grün; Diff-Viewer und Frame-Snapshots wurden von
  diesen Commits nicht verändert. Diese vorhandene Umgebungs-/Snapshot-Abweichung wird nicht als grün
  ausgegeben.
- Das fertige Binary meldet `1.18.1-patched.90`; Smoke-Test und drei echte Produkt-A/B-Paare waren erfolgreich.

## Sicherung und Reproduzierbarkeit

Der OpenCode-Tag `1.18.1-patched.90` markiert den vollständigen OpenCode-Stand einschließlich dieses Dokuments.
Die OpenTUI-Laufzeitänderungen liegen separat im lokalen OpenTUI-Repository bis Commit `3452ce0`; dort markiert
der Tag `opencode-1.18.1-patched.90` den eingebetteten Stand.

Wichtig für einen späteren Neuaufbau: `bun.lock` verweist weiterhin auf das veröffentlichte OpenTUI 0.4.3.
Für dieses lokale Produktbinary wurden `packages/core` und `packages/solid` am dokumentierten OpenTUI-Commit
gebaut und deren `dist` vor dem OpenCode-Build in die lokale 0.4.3-Paketablage übernommen. Die beiden Git-Tags,
die Commitliste und der Binary-Hash sichern daher den exakten Quell- und Produktstand; ein bloßes frisches
`bun install` ohne den getaggten OpenTUI-Build würde dessen lokale Patches nicht enthalten.

Die Installation von `.90` ersetzt nur `~/.opencode/bin/opencode`. Bereits laufende Sessions behalten ihren
gestarteten Prozess und werden nicht beendet; neu gestartete Sessions verwenden `.90`.

## Nachtrag: Performance- und Safety-Härtung ab `1.18.18-patched.112` (2026-08-17)

> [!IMPORTANT]
> Dieser Nachtrag ändert nicht den historischen Inhalt von `1.18.1-patched.90`. Tag, Binary-Hash und A/B-Werte
> der vorstehenden Abschnitte gelten ausschließlich für `.90`. Die folgenden Arbeiten entstanden später auf
> Basis von `1.18.18-patched.112` und bilden das Abschlussprotokoll der zusätzlichen Arbeitsrunde.

- Basis: `1.18.18-patched.112` (`267a7aa6dfad`)
- Code-/Test-Endstand vor diesem Dokumentationscommit: `d712c8b65c7c`
- Commitbereich: `1.18.18-patched.112..d712c8b65c7c`
- Umfang: 47 Commits; 43 `fix`-, ein `feat`-, ein `chore`- und zwei `test`-Commits
- Diffumfang einschließlich Tests, Migrationen und generierter Artefakte: 217 Dateien
- Zielbranch: `working`, per Fast-forward aus dem separat geprüften Branch `perf-integration`
- Status: **integriert und abgearbeitet**

Für diese Gesamtstrecke existiert kein einzelner Produkt-A/B. Die unten genannten Messungen belegen jeweils
einen isolierten Hotspot und dürfen weder addiert noch als pauschaler Sessionsgewinn ausgegeben werden.

### Abgearbeitete zusätzliche Arbeiten

- [x] **TUI-Transparenz und Rendergrenzen:** Tokenrate im während der Generierung sichtbaren Session-Footer
      platziert und große Diff-Darstellungen begrenzt (`812aecb6b1`, `06467835e9`).
- [x] **Dauerhafte Diff- und Datenbankkosten:** große Session-Diffs aus häufig replizierten
      Message-Payloads in eine lazy geladene Ablage verschoben, SQLite-Lock-Retries auf echte
      `BUSY`-/`LOCKED`-Fälle begrenzt, eine rein lesende Eventlog-Analyse ergänzt, Session-Listen indiziert und
      Event-Replay atomar gebündelt (`2a69b51920`, `65f156b1e0`, `48d1313612`, `d5613f567a`, `3e7cc41ddb`).
- [x] **Start- und Lifecycle-Kosten:** Dateisystemsuche erst bei Bedarf initialisiert und den lokalen
      MCP-stdio-Lifecycle einschließlich Cleanup und Abbruchpfaden gehärtet (`a108cc900c`, `75b6e82efc`).
- [x] **Streaming, Kontext und Dateioperationen:** Textakkumulation linearisiert, Provider-Cachepräfixe auch
      durch Compaction erhalten, Anthropic-Caching korrigiert, Summary-Snapshots vermieden und Read-/Search-/
      Shell-/Patch-Dateipfade gebündelt beziehungsweise begrenzt (`e5938f612f`, `5614d673e9`, `a7b57e9278`,
      `6bc1f5b0e9`, `8d5107b64a`).
- [x] **AI-Worker- und Provider-Sicherheit:** Worker-Streaming gehärtet, isolierte Worker wiederverwendet,
      automatische Retries nach bereits sichtbaren semantischen oder Tool-Nebenwirkungen unterbunden,
      Header- und Body-/Chunk-Leerlauf mit konfigurierbaren Timeouts abgesichert und frühe Tool-Metadaten
      race-sicher erhalten (`82dbf2eec7`, `9da878429d`, `42e34bcc7c`, `c85b331e80`, `8383ea8f72`,
      `2ccde7915a`).
- [x] **Snapshot- und Diff-Budgets:** Workspace-Snapshots nur für tatsächlich mutierende Tools erzeugt;
      Eingabe, Generierung und strukturierte Patch-Ausgabe begrenzt; Tool-, Snapshot- und Revert-Vorschauen
      vor teurer Vollberechnung budgetiert. Zu große Unified-Diffs werden vollständig weggelassen statt syntaktisch
      beschädigt abgeschnitten (`41f0db98e5`, `c9ea685d97`, `f750775d4b`, `7d55dc06bf`, `7248b1516d`,
      `3522724ed6`, `8a22be894c`).
- [x] **Toolausgaben und externe Inhalte:** Suffixarbeit auf den benötigten Tail beschränkt, doppelte Bild- und
      Patchdaten entfernt, Edit-Matching mit harten Arbeitsbudgets versehen, Webfetch bereits beim Lesen begrenzt
      und große strukturierte Webfetch-, LSP-, Skill-, Websearch- und Patch-Payloads kompaktiert. Gültige leere
      begrenzte Antworten bleiben erlaubt; Mediengrenzen werden während des Lesens durchgesetzt
      (`5796aeed38`, `ddb0b99419`, `e33b898930`, `24a50491e3`, `6c75f226dc`, `7558fbb62a`,
      `19d9007a55`, `b49a80930c`, `babed9be07`, `eb73e0a830`, `f1c2bf42be`, `6319618190`).
- [x] **Sync und Hintergrundarbeit:** History-Abfragen auf den relevanten Workspace begrenzt, Transfers
      paginiert und mit stabilen Grenzen versehen, Warp-Replay gebündelt, abgeschlossene Background-Jobs
      konsumiert und Benachrichtigungen begrenzt (`e6239d4153`, `74bf4fa1de`, `4c34d61f29`, `47fc4d8fc4`,
      `23a580e816`).
- [x] **Reproduzierbarkeit der Integration:** asynchrone Shell-Fixture stabilisiert, die öffentliche
      `chunkTimeout: false`-Form in den Legacy-SDK regeneriert und der Task-Metadata-Test an echte
      Provider-Bereitschaft statt an Timing gekoppelt (`9af5129453`, `c4a4d47ae9`, `d712c8b65c`).

### Isolierte Messbelege

| Hotspot                                    |                                                    Isolierter Befund |
| ------------------------------------------ | -------------------------------------------------------------------: |
| 10-MiB-Tooloutput-Suffix                   |                                                     1.163,5 → 6,1 ms |
| `read` bei tiefem Offset in 100.000 Zeilen |                                                 ungefähr 117 → 12 ms |
| 64-MiB-Webfetch mit Leselimit              |              gelesen 67,1 → 5,31 MiB; Peak-RSS 158.056 → 106.204 KiB |
| 5-MiB-Webfetch-Event                       |                                             5.294.310 → 51.418 Bytes |
| 5-MiB-Patch-Event                          |             Edit 10.486.753 → 782 Bytes; Apply 5.243.348 → 320 Bytes |
| 1-MiB-Skill-Ausgabe                        |                                             1.099.909 → 51.321 Bytes |
| 256 atomar replizierte Events              |                              190,46 → 126,16 ms; 256 → 1 Transaktion |
| Diff-Eingabe mit 1 Mio. Zeilen             |                        bis 706 ms/469 MiB → 23–28 ms/ungefähr 60 MiB |
| Snapshot-Diff-Preflight mit 1 Mio. Zeilen  |                               1,58 s/521.884 KiB → 0,03 s/48.600 KiB |
| 8-MiB-Revert-Vorschau                      |                               0,18 s/126.304 KiB → 0,11 s/60.024 KiB |
| 16-MiB-Patchgenerierung                    |                                       ungefähr 173 → 81 MiB Peak-RSS |
| Snapshot-Charakterisierung                 | 80 Captures, davon 78 identisch; ungefähr 66,9 ms pro warmem Capture |

Der Worker-Pool besitzt einen reproduzierbaren Benchmark-Harness. Da dafür noch kein belastbarer kompletter
Vorher-/Nachher-Produktlauf vorliegt, wird daraus keine Prozentverbesserung abgeleitet.

### Kompatibilität und bewusste Grenzen

- Die Message-Diff-Ablage und Session-Listen-Indizes sind additive Migrationen. Export, Import, Sync, Share,
  App, TUI und generierter SDK wurden auf den neuen lazy Diffpfad abgestimmt.
- `chunkTimeout` akzeptiert zusätzlich `false`; Provider-Header- und Stream-Timeouts können damit gezielt
  deaktiviert werden. Der Legacy-JavaScript-SDK wurde aus der Quelle regeneriert.
- Die Leerlaufuhren laufen nur während eines ausstehenden rohen Transport-Reads. Downstream-Backpressure und
  lokale Toolausführung lösen deshalb keinen Provider-Timeout aus. HTTP-/WebSocket-Clones teilen Abbruch und
  Fehlerzustand, ohne einen ungelesenen Geschwisterzweig vorzeitig zu zerstören.
- Der Retry-Stopp nach sichtbaren Modell- oder Tool-Nebenwirkungen ist eine beabsichtigte Safety-Änderung:
  lieber ein klarer Fehler als ein unbemerkter doppelter Toolaufruf.
- Große Vorschauen dürfen fehlen, wenn ihr Budget überschritten wird. Der zugrunde liegende Zustand wird nicht
  durch einen abgeschnittenen und damit ungültigen Unified-Diff ersetzt. Patchlose Verbraucher zeigen
  Pfad-/Statistik-Summaries und behandeln geladene patchlose Details als terminal.
- Große Tool-Volltexte liegen nach der strukturierten Deduplizierung nur im lokalen Managed-Spill mit seiner
  bestehenden siebentägigen Aufbewahrung. Warp und dauerhafte Events transportieren den begrenzten Preview.
- Snapshot-Diff-Vorschauen besitzen ein gemeinsames 250-ms-Rechenbudget. Die Revert-Vorschau begrenzt stdout
  und stderr, endet nach fünf Sekunden und eskaliert einen nicht reagierenden Prozess nach einer weiteren
  Sekunde auf SIGKILL; Mutation, Undo und Restore hängen nicht vom optionalen Preview ab.
- Die Eventlog-Funktion ist absichtlich read-only; sie führt weder Reparatur noch `VACUUM` aus.
- Der unbeschränkte Legacy-Helfer `TextDiff.create` bleibt für nicht migrierte Fremdverbraucher bestehen; die
  hier gehärteten Core-/Toolpfade verwenden die begrenzte Variante. Das vorgelagerte Snapshot-Staging ist ein
  eigener möglicher Folgescope und wird nicht als durch die Revert-Vorschau begrenzt ausgegeben.
- Dieser Nachtrag enthält keinen neuen OpenTUI-Quellpatch. Reproduzierbare Builds benötigen weiterhin den in
  den Branch-Anweisungen festgelegten und verifizierten OpenTUI-Overlay.

### Sichere Integration

Die Integration erfolgte auf einem sauberen separaten Worktree. Der bereits auf `working` vorhandene
Worker-Patch `82dbf2eec7` war tree-identisch zum älteren Stack-Commit `221f0f2f1c` und wurde deshalb nicht
doppelt eingespielt. Die 30 nachfolgenden Performance-/Safety-Commits wurden konfliktfrei übernommen. Der
integrierte Baum unterschied sich vom geprüften Quellstack zunächst ausschließlich durch den bereits auf
`working` vorhandenen, patch-ID-identischen Shell-Fixture-Fix `9af5129453`.

Der große Changed-Test-Lauf deckte anschließend eine ältere, bereits auf `working` vorhandene Race auf:
Streaming-Coalescing konnte Tool-Metadaten vor der Registrierung des zugehörigen `callID` liefern. Der
Processor puffert diese Updater nun pro Call und serialisiert Registrierung und Read/Modify/Write. Der
Regressionstest wartet zusätzlich auf den ersten echten Provider-Request, ohne seinen Metadata-Assert zu
schwächen.

### Finale Prüfungen

- Typechecks grün: Core, LLM, Schema, Client, OpenCode, TUI, App, Session-UI und Legacy-JavaScript-SDK.
- Core: 289 grün, 0 fehlgeschlagen, 1.595 Assertions über die geänderten Testbereiche.
- LLM: 33 grün, 0 fehlgeschlagen, 127 Assertions.
- Schema: 5 grün, 0 fehlgeschlagen, 31 Assertions.
- TUI: 66 grün, 0 fehlgeschlagen, 8 Snapshots und 189 Assertions.
- App-Verbraucher: 103 grün, 0 fehlgeschlagen, 221 Assertions.
- Session-UI-Verbraucher: 3 grün, 0 fehlgeschlagen, 13 Assertions.
- Der große OpenCode-Changed-Test-Lauf erreichte 957 grüne, 4 übersprungene Tests und 6.103 Assertions. Ein
  Dateirechte-Test lief auf dem Host mit `umask` 0002 statt 0022 und ist mit `umask 022` isoliert grün. Der
  zweite Fund war die oben beschriebene Tool-Metadata-Race.
- Nach der Race-Korrektur: Regression 3/3, Processor 41/41, Task 28/28 sowie der Race-Test unter Last 5/5
  grün; OpenCode-Typecheck und `git diff --check` grün.
- `bun run migration --check` in Core ist grün; es besteht kein nicht generierter Schema-Drift.
- Der Legacy-SDK-Generator wurde nach dem Regenerationscommit ein zweites Mal ausgeführt und erzeugte keinen
  Restdiff; der SDK-Typecheck ist grün.
- Der gepinnte OpenTUI-Overlay wurde angewendet und anhand seiner erwarteten Hashes verifiziert.
- Der Web-/Astro-Produktionsbuild ist erfolgreich; die ausgegebenen Starlight-/Vite-Warnungen sind bestehende
  Konfigurations- und Chunkgrößenhinweise, keine Buildfehler.
- Dreizehn wiederverwendbare Engineering-Learnings wurden in Yesmem als `#85393` bis `#85405` gespeichert
  und anschließend jeweils per exakter ID und Versionshistorie validiert.
- Prettier der geänderten Dateien und `git diff --check` sind grün.

Damit sind die zusätzlichen Punkte technisch, durch Tests und in diesem Plan dokumentiert abgeschlossen. Ein
neuer gepatchter Release oder GitHub-Prerelease ist davon getrennte Release-Arbeit und wurde in dieser Runde
nicht ungefragt ausgeführt.

## Nachtrag: Footer-Partial-Rendering und OpenTUI 0.5.3 nach `.113` (2026-08-17)

`1.18.18-patched.113` wurde korrekt aus dem damaligen sauberen `working`-Commit `639d705bd86e` gebaut. Der
Release verwendete jedoch weiterhin den gepatchten OpenTUI-Stand 0.5.1 (`568db413e7bc`) und nicht 0.5.3. Die
starke Last war kein Mergeverlust: Der neue Tokenraten-Text wurde im großen Session-Footer jede Sekunde über
einen normalen Root-Render aktualisiert, selbst wenn der Wert dauerhaft `0` blieb. Die Kosten wuchsen dadurch
mit dem Session-Renderbaum.

### Korrigierter OpenTUI- und Footer-Vertrag

- [x] Als OpenTUI-Basis dient ausschließlich der bereits portierte und vollständig geprüfte 0.5.3-Stand
      `2cd44364513f59a7a5937ef257042ddb0fca4fb7`. Er vereinigt den bisherigen Patchstand mit Upstream 0.5.3;
      spätere unfertige Optimierungswellen sind ausdrücklich nicht enthalten.
- [x] Der Overlay-Guard pinnt Commit, Upstream-Tag und beide Mergebasen sowie Core-, Solid- und
      Native-Pakethashes. Ein frischer Frozen-Lockfile-Install löst auch den aktiven Spinner-Peerpfad auf
      OpenTUI 0.5.3 auf.
- [x] Die Anzeige lautet bewusst nur `out ~N tk/s`. Laufende Provider-Usage existiert nicht; deshalb wird der
      Output grob aus kumulierten Text-Deltas mit ungefähr vier Zeichen pro Token geschätzt. Session,
      Assistant-Message und Deltafeld werden strikt gefiltert.
- [x] Tokenrate, Pfad/Branch, Welcome-, Permission-, LSP- und MCP-Werte aktualisieren ihren festen
      `TextRenderable` direkt. Dynamische JSX-Textknoten werden vermieden, weil sie den Root-Renderer
      invalidieren. Feste Breiten halten Yoga sauber.
- [x] Transparente Footer-Zellen verwenden NBSP für sichtbare Leerstellen und Padding. Normale Spaces löschen
      beim retained Partial-Render keine alten Glyphen zuverlässig; NBSP verhindert Artefakte bei Übergängen
      wie `100 -> 0` ohne einen deckenden Hintergrund zu erzwingen.
- [x] Der Tokenzähler besitzt keinen permanenten 1-Hz-Timer mehr. Nach Aktivität laufen nur One-Shot-Updates
      bis zum Drei-Sekunden-Decay; anschließend wird einmal `0` gerendert und der Footer bleibt vollständig
      inaktiv.
- [x] Seltene Strukturänderungen wie Connect/Disconnect oder das Ein-/Ausblenden optionaler Felder dürfen
      weiterhin sicher auf einen normalen Full-Render zurückfallen. Laufende Inhalts- und Farbänderungen
      bleiben Partial-Renderings.

### Large-Session-A/B

Die Systemmessung verwendete dieselbe importierte große Session mit 241 Messages, 1.767 Parts und 6,15 MB
Export, ein 200x50-Terminal, `--pure`, feste CPU-Affinität sowie je 20 Sekunden Warmup und ungefähr 30,5
Sekunden Sampling. Die Reihenfolge war A-B-B-A, um Reihenfolge- und Hostlasteffekte zu begrenzen. Der Host war
weiterhin stark ausgelastet; die Werte sind deshalb als vorsichtiger Produktvergleich und nicht als
Mikrobenchmark zu lesen.

| Build                            | CPU eines Kerns, Lauf 1 |  Lauf 2 |  Mittel | Kontextwechsel pro 30 s |
| -------------------------------- | ----------------------: | ------: | ------: | ----------------------: |
| `.113`, SHA `a29110a7...`        |                 7,343 % | 6,755 % | 7,049 % |                     631 |
| Korrektur-A/B, SHA `446ed312...` |                 1,998 % | 2,318 % | 2,158 % |                     193 |

Damit benötigt der korrigierte Client in diesem Large-Session-Idle-Szenario im Mittel **69,4 % weniger CPU**
beziehungsweise **3,27-mal weniger CPU**; die Kontextwechsel sinken ebenfalls um 69,4 %. Die Terminalwrites
waren in beiden Varianten nahezu null, daher belegt der separate Rendergate den kausalen Pfad: In einem Baum
mit mehr als 500 Renderables erzeugen Aktivwert und Decay jeweils exakt einen nativen 16x1-Partial-Frame und
keinen Full-/Root-Frame; während der folgenden fünf Sekunden entstehen weder Renderrequests noch Frames.

### Prüf- und Auslieferungsstatus

- Footer-, Tokenraten- und Spinner-Regressionssuiten: 22/22 grün; der Footer-Test enthält den großen
  Renderbaum, transparentes Long-to-short-Clearing, Dialog-Fallback und fünf Sekunden echten Idle.
- Typechecks in Core, TUI und OpenCode sowie Overlay-Check, Prettier und `git diff --check` sind grün.
- OpenTUI-Partial-Renderer-Quelltests: 92 grün, 1 bestehender Skip. Die breite TUI-Suite erreichte 353 grüne,
  1 übersprungenen Test; ein durch gemeinsam benutzten `/tmp`-State gestörter Test war isoliert 3/3 grün.
- Wegen der bereits vorhandenen Zwischenversionen `.115` bis `.119` trägt der finale lokale Testbuild die
  Version `1.18.18-patched.120`. Er hat SHA-256
  `d9215b6dee9c5c810a8df497824812c4f0588e390d6f0c8685deb5f37703a6cf` und wurde atomar als
  `~/.opencode/bin/opencode` installiert. `.113` bleibt unter
  `~/.opencode/bin/opencode-1.18.18-patched.113.bak` als hashverifiziertes Rollback erhalten. Laufende Prozesse
  behalten ihre alte Inode; neu gestartete Prozesse verwenden `.120`. Ein Tag, Release oder GitHub-Prerelease
  wurde nicht erstellt. Der vorangehende interne A/B-Messbuild enthielt denselben Produktcode; sein
  abweichender Hash entstand vor allem durch die eingebettete Zwischenversionskennung.
- Die wiederverwendbaren Erkenntnisse zu OpenTUI-Provenienz, Token-Datenquelle, transparentem
  Partial-Rendering, activity-scoped Timern und dem Versionssprung sind zusätzlich als Yesmem-Learnings
  `#85430` bis `#85433` sowie im aktuellen Deployment-Eintrag `#85435` gespeichert; `#85435` ersetzt den
  vor der lokalen Installation angelegten Zwischenstand `#85434`.

## Nachtrag: aktive Yesloop-Skalierung und Worker-Coalescing nach `.120` (2026-08-18)

Vier gleichzeitig laufende `.120`-Yesloops wurden ohne Attach, Signal, Request oder Neustart ausschließlich
über ihre bestehenden Prozessbäume gemessen. Alle liefen im verifizierten `balanced`-Profil. Drei Loops waren
aktiv, ein vierter wartete in einem offenen Providerstream. Über 75 Sekunden verbrauchten die vier Bäume im
Mittel 5,60 Kerne; die drei aktiven Loops davon 5,54 Kerne. Client und Server beanspruchten gemeinsam 3,69
Kerne, AI-Worker 1,11 Kerne und absichtlich gestartete Build-/Testprozesse 0,81 Kerne. Der wartende vierte
Loop lag nur bei 0,066 Kernen. Die Last war damit arbeitskorreliert und nicht der bereits behobene permanente
Footer-Idle-Render, unter schnellen Streams aber dennoch unnötig hoch.

Tmux war nicht beteiligt: Sämtliche gefundenen tmux-Sockets waren verwaist und es lief kein tmux-Server. Die
OpenCode-TUIs liefen unter Yesmem-/Terminal-Relays; die CPU-Zeit entstand direkt in Bun-Hauptthreads sowie
JIT-/HeapHelper-Threads von Client und Server. Die PTY-Datenrate war klein und physische Client-I/O blieb null.

Der konkrete Rückfall lag in `packages/opencode/src/session/llm/ai-process-worker.ts`: Commit `82dbf2eec7`
hatte das zuvor bewährte Delta-Fenster von 200 auf 50 ms reduziert. Damit waren während schneller Streams bis
zu 20 statt 5 Worker-IPC-/ACK-/Event-Wakeups pro Sekunde möglich, obwohl die nachfolgende TUI-SDK-Pipeline
ohnehin nur im 100-ms-Takt sichtbar aktualisiert. Das erste Delta war bereits unabhängig vom Timer sofort;
auch Tool-, Fehler- und andere Kontrollereignisse erzwingen weiterhin einen sofortigen Flush.

### Korrektur und Gates

- [x] `deltaFlushMs` ist wieder 200 ms. Inhalt, Reihenfolge, ACK-Backpressure, sofortiges erstes Delta und
      sofortige Kontrollereignisse bleiben unverändert; nur nachfolgende gleichartige Streaming-Deltas werden
      wieder mit höchstens 5 Hz gebündelt.
- [x] Dasselbe Fenster gilt nun auch für benachbarte `tool-input-delta`-Fragmente derselben Call-ID. Der
      AI-SDK-Rohtext wird dabei korrekt über `event.delta` statt `event.text` zusammengesetzt. Das erste
      Fragment bleibt sofort sichtbar, Typ-, ID- und Kontrollgrenzen flushen weiterhin strikt geordnet, und
      eine 64-KiB-UTF-8-High-Water-Schwelle begrenzt die Akkumulation je ACK-Frame. Ein einzelnes
      Providerfragment bleibt ungeteilt; ein gebündelter Frame kann die Schwelle deshalb höchstens um dieses
      eine Fragment überschreiten.
- [x] Der Coalescing-Test normalisiert seine zulässige Framezahl auf die tatsächlich beobachtete
      Providerdauer. Mit 50 ms scheitert der scharfe Gate reproduzierbar mit 21 Frames bei höchstens 10; mit
      200 ms ist er grün.
- [x] Der EOF-/ACK-Test verwendet explizite Provider-Gates und beweist weiterhin die Reihenfolge
      `A bestätigt -> B unbestätigt -> C dahinter gepuffert -> stdin geschlossen`, ohne sich auf den früheren
      50-ms-Takt zu verlassen.
- [x] Die vollständige Worker-Datei ist 25/25 grün; zusammen mit der vollständigen Worker-Pool-Suite sind
      60/60 Tests und 424 Assertions grün. Ein
      erster Lauf traf unter den vier Volllast-Loops bei 5,055 Sekunden das bestehende 5-Sekunden-Harnesslimit;
      derselbe Fall und danach die gesamte Suite liefen mit 15-Sekunden-Testbudget vollständig grün.
- [x] OpenCode-Typecheck, Prettier, Overlay-Guard für den gepatchten OpenTUI-0.5.3-Stand und
      `git diff --check` sind grün. Ein unabhängiger Read-only-Review fand keinen Semantik- oder Race-Blocker.

### Weitere Regressionsprüfung

Der anschließende systematische Cadence-/Render-/Event-Audit fand zwei weitere echte Root-Render-Rückfälle
und einen zweiten Worker-Hotpath:

- Die neuen Model-Wait- und Agent-Laufzeitzähler hatten zwar `usePartialRender` am umgebenden
  `TextRenderable`, aktualisierten aber dynamische Solid-Textkinder. Deren `RootTextNodeRenderable` ruft in
  OpenTUI direkt `ctx.requestRender()` auf und umgeht damit die Partial-Berechtigung des Parents. Beide
  Laufzeiten verwenden nun die gemeinsame feste `PartialText`-Zelle, die `TextRenderable.content` direkt
  setzt. Der Agent-Timer läuft zusätzlich nur bei ausgeklapptem Block.
- Der echte 16.066-Byte-Write-Replay bestand aus 2.009 tokenähnlichen Tool-Argumentfragmenten. Der bisherige
  Worker erzeugte daraus 2.017 Frames und serielle ACKs. Im zeitverteilten Replay reduzierte die sichere
  Bündelung dies auf 63 Frames; Parent-CPU sank von 5,756 auf 1,184 Sekunden, Wallclock von 12,26 auf 10,85
  Sekunden. Inhalt, geparstes Toolobjekt und Kontrollreihenfolge blieben exakt.
- Ein separater 160-KiB-Emoji-Gate beweist UTF-8-korrekte Rekonstruktion und im geprüften 512-Byte-Fragmentfall
  maximal 64 KiB je gebündeltem Frame. Ein 16-KiB-/2.009-Fragment-Gate beweist sofortiges erstes Fragment,
  echte Parent-Toolausführung und
  `tool-input-start -> deltas -> tool-input-end -> tool-call -> tool-result`.
- Der gemeinsame `PartialText`-Renderer ist in einem Baum mit mehr als 520 Renderables gegated: StyledText
  lang -> kurz -> leer erzeugt jeweils genau einen nativen Partial-Frame, keinen Full-/Root-Frame und keine
  alten transparenten Glyphen; anschließend entstehen fünf Sekunden lang keinerlei Renderrequests. Der
  Agent-Zähler stoppt eingeklappt vollständig und startet ausgeklappt wieder ausschließlich partiell.

Der Prompt-Spinner bleibt dagegen **bewusst bei 40 ms**. Frühere A/B-Messungen zeigten keinen Nutzen einer
Frequenzreduktion; die gespeicherten Entscheidungen `#83990` und `#84601` verlangen deshalb ausdrücklich,
die Arbeit pro Tick statt die sichtbare Animationsgeschwindigkeit zu optimieren. `.105` stellte genau diesen
Spinner absichtlich von 100 auf 40 ms zurück. Der Audit hatte diesen historischen Vertrag zunächst übersehen;
der vorübergehende lokale Rückbau wurde vor dem finalen Teststand vollständig entfernt.

Tool-Input-Fortschrittsanzeigen erzeugen nur bei großen `write`-/`edit`-/`apply_patch`-Argumenten bis zu zwei
dauerhafte Updates pro Sekunde. Über die vier gesamten Yesloop-Historien waren es 158 von 6.309 Part-Updates
(2,5 Prozent bzw. 3,8 pro aggregierter Loop-Stunde); dies ist ein begrenzter späterer UI-Folgescope, nicht die
Ursache der anhaltenden Last. Gleiches gilt für Snapshot-Diff-Invalidierung an Step-Grenzen und die nur bei
strukturellen Agent-/Toolübergängen laufende Agentenzeilen-Ableitung.

Zum Abschluss der read-only Ursachenanalyse blieb die installierte Datei zunächst
`1.18.18-patched.120` mit SHA-256 `d9215b6d...`; alle beobachteten TUIs behielten ihre ursprüngliche Startzeit
und `.120`-Inode. Bis zur anschließend dokumentierten `.122`-Installation erfolgte ausdrücklich kein
Deployment oder Neustart. Eine End-to-end-CPU-A/B-Messung des Fixes benötigt einen separat gestarteten
Kandidaten bei identischem Replay; aus dem laufenden Altprozess darf keine Verbesserungszahl abgeleitet werden.

### Lokale Installation `.122`

Der erste lokale Dirty-Tree-Kandidat hatte SHA-256
`a07a9271a2b21bfadbfe99c35c6e81bf97e97aba8565be706ec5a62169966c2e`. Der anschließende breite
Release-Gate fand zusätzlich zwei echte Lifecycle-Randfehler und zwei veraltete Testfixtures: Der
non-interaktive JSON-Run konnte denselben Fehler aus Sessionevent und Promptantwort doppelt ausgeben; ACP
konnte ein sehr frühes stdin-EOF zwischen zwei Listenerregistrierungen verpassen. Beide Produktpfade wurden
behoben. Der PartUpdated-Test hält nun den absichtlichen No-Clone-Vertrag fest, und die Remote-Workspace-
Fixture beantwortet den V2-Probe korrekt mit 404, bevor der Legacy-Fallback greift.

Nach diesen Korrekturen wurde derselbe noch unveröffentlichte Versionsname erneut mit
`OPENCODE_VERSION=1.18.18-patched.122 bun run build:patched --single --skip-install` gebaut. Das finale lokale
Artefakt liegt unter `packages/opencode/dist/opencode-linux-x64/bin/opencode`, meldet
`1.18.18-patched.122`, ist 192.891.008 Byte groß und hat SHA-256
`79a99c3c924e6ca5b4056366303c151e250cc9edfced04da631a3d6c133db7fc`. Der zuvor kurz erzeugte
`.121`-Zwischenbuild und der erste `.122`-Kandidat sind damit ersetzt; zu diesem Dokumentationsstand besitzt
`.122` noch keinen Tag oder GitHub-Release.

Zusätzlich zu den Worker-Gates sind die fokussierte TUI-Matrix mit 51/51 Tests und 170 Assertions sowie die
vollständige serielle TUI-Suite mit 356 grünen Tests, einem bestehenden Skip, 1.024 Assertions und acht
Snapshots grün. Die Paket-Vollsuiten bestanden in Core 1.188, LLM 308 mit 30 expliziten Provider-Skips,
Schema 16, Protocol 2, Client 16, SDK-next 5, Session-UI 84, SDK-JS 1 sowie App 741 Unit- und 41
Browser-Tests. Sämtliche Paket-Typechecks, Migration-/Generator-Drift, Overlay-Guard, Prettier und
`git diff --check` sind grün.

Der serielle OpenCode-Volltest bestand 3.584 Tests und legte unter hoher Hostlast sieben Befunde offen. Der
Umask-Fall war mit `umask 022` grün; zwei 25-ms-TERM-Kill-Fixtures waren isoliert, gemeinsam und CPU-gepinnt
insgesamt 41/41 grün. Die übrigen vier Befunde waren die oben korrigierten Produkt-/Fixturefälle und liefen
danach in ihren vollständigen Dateien grün. Der Worker-Pool-Benchmark über 20 Turns verwendete im gepoolten
Arm genau einen Prozess und eine Providerinitialisierung, reuse-te ihn 19-mal und beendete ihn beim Close.

Das finale Artefakt wurde atomar als `~/.opencode/bin/opencode` installiert; Build und Installation sind
bytegleich. `1.18.18-patched.120` bleibt unter
`~/.opencode/bin/opencode-1.18.18-patched.120.bak` mit SHA-256
`d9215b6dee9c5c810a8df497824812c4f0588e390d6f0c8685deb5f37703a6cf` als geprüftes Rollback erhalten. Die
vier während der Analyse laufenden TUI-Wurzeln wurden weder signalisiert, attached, angefragt noch
neugestartet und verwenden weiterhin ihre ursprüngliche `.120`-Inode; neue Prozesse lösen den installierten
`.122`-Pfad auf.

Die End-to-end-Gates B01 bis B03 des neuen Runbooks bleiben bewusst `INCOMPLETE`, weil die historischen
Sampler-/Provider-/Fixture-Invocations nicht vollständig reproduzierbar archiviert sind. Dieser fehlende
Harnessbeleg wird nicht als erfundenes `PASS` ausgegeben; die Freigabe stützt sich hier auf die nativen
Rendergates, das frühere kontrollierte A-B-B-A und die vollständig dokumentierten Funktionssuiten.

Die abschließende Yesmem-Notiz `#85477` ersetzt die Zwischenstände `#85475` und `#85462` und hält Worker-
Coalescing, Messwerte, Gates, den absichtlich unveränderten 40-ms-Spinner sowie Installation und Rollback fest.
Das wiederverwendbare OpenTUI-Muster für direkte `TextRenderable.content`-Updates, feste Breiten und
NBSP-Clearing ist separat unter `#85476` dokumentiert.

Die verbindliche, versionsunabhängige Prüfreihenfolge für künftige Kandidaten, lokale Installationen und
Prereleases steht in `yesdocs/patched-release-verification.md`. Sie trennt stabile Funktionsgates von
profilgleichen Performance-A/Bs und verlangt bei Dirty-Testbuilds ausdrücklich auch die Archivierung aller
ungetrackten Quellen. Diese Entscheidung ist als Yesmem-Learning `#85483` hinterlegt.
