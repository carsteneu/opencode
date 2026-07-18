# OpenCode TUI Streaming-CPU: Root-Cause-Analyse

- Stand: 2026-07-18
- Untersuchter OpenCode-Stand: `working` / `7e017ce` plus lokale Änderungen
- Untersuchter OpenTUI-Stand: `main` / `a89c08e` plus lokale Änderungen
- Fixbuild: `1.18.1-patched.85` lokal gebaut und installiert; `.81` bis `.84` waren ausschließlich A/B-Builds

## Kurzfassung

Die hohe CPU-Last entsteht nicht durch das Schreiben einiger Zeichen ins Terminal. Ein gebündeltes Textdelta
löst derzeit ungefähr alle 200 ms eine Kette aus, die trotz Partial-Render regelmäßig den vollständigen
Layout- und Renderpfad aktiviert:

1. Der AI-Worker bündelt Textdeltas für höchstens 200 ms.
2. Die TUI übernimmt das neue Delta in den vollständigen, gewachsenen Part-String.
3. Solid aktualisiert das `MarkdownRenderable`.
4. Markdown aktualisiert den aktiven `CodeRenderable` und startet asynchrones Highlighting.
5. Nach erfolgreichem Highlighting ruft `CodeRenderable.startHighlight()` `updateTextInfo()` ohne Argument auf.
6. `updateTextInfo()` interpretiert das als `layoutChanged = true` und markiert Yoga immer dirty.
7. `canPartialRender()` lehnt den Partial-Frame wegen des dirty Layouts ab.
8. OpenTUI berechnet Yoga neu, läuft durch den Root-Renderbaum und präsentiert einen vollständigen Frame.

Das Profil zeigt genau die erwartete Frequenzsignatur:

- Spinnerintervall 80–100 ms: ungefähr 10–12 Partial-Frames pro Sekunde;
- AI-Worker-Delta-Coalescing 200 ms: ungefähr 5 Textupdates pro Sekunde;
- gemessen: ungefähr 10,5 Partial-Frames und 5,3–5,5 Full-Frames pro Sekunde;
- 84–94 % der Full-Frames wurden durch `layoutDirty` erzwungen.

Der wichtigste konkrete Defekt ist damit ein unvollständiger Same-line-Fix: Commit `7e01670` verhindert die
synchrone Layoutinvalidierung im `content`-Setter, aber der spätere asynchrone Highlight-Abschluss setzt das
Layout erneut pauschal auf dirty. Der zugehörige Test wartet nicht auf das Highlighting und kann diese Regression
daher nicht sehen.

## Kontrollierte Nachmessung am 2026-07-18 (`.67` bis `.79`)

Die spätere Messreihe wurde vollständig im Energiemodus `power-saver` durchgeführt. Für die vergleichbaren
Läufe galten 156×65 Terminalzellen und derselbe Prompt:

> Schreibe etwa 1200 Wörter fortlaufenden deutschen Fließtext über stabile Sortierverfahren. Keine Tools
> verwenden, kein Markdown, nur Fließtext.

Die TUIs wurden in eigenen PTYs gestartet; der Wechsel vom Reasoning- zum Text-Part wurde für die letzten
Produktionsmessungen von einem externen SSE-Leser erkannt. Die CPU-Zeit wurde danach zehn Sekunden direkt aus
`/proc/<pid>/task/*/stat` gelesen. Dieses Verfahren verändert den TUI-Prozess nicht.

### Wichtiger Messartefakt: Frame-Tracing war selbst teuer

Ein temporärer Profilpfad las pro Frame native Statistiken, serialisierte JSON und schrieb eine Trace-Zeile. Bei
statischer Textdarstellung und aktivem Spinner ergab dieser Build rund 85,4 % TUI-CPU. Derselbe Build ohne
`OPENCODE_CPU_PROFILE`, mit externer Messung, benötigte nur rund 26,3 %. Die internen Frame-Traces haben die
späten `.69`-bis-`.76`-Absolutwerte daher stark aufgebläht. Sie bleiben als Kausalbeweis für Frameanzahl und
relative Callpaths nützlich, dürfen aber nicht als Produktions-CPU interpretiert werden. Die Trace-Writer wurden
aus dem finalen Quellstand wieder entfernt.

### Instrumentationsfreie A/B-Ergebnisse

| Variante | Gesamt-CPU | Main | `HeapHelper` gesamt | Aussage |
|---|---:|---:|---:|---|
| Idle, normale UI | ca. 11,1 % | 4,4 % | 4,8 % | echte Grundlast |
| `.77`, statischer Text, Animation an | ca. 26,3 % | 12,6 % | 12,1 % | Empfang/Store plus Animation, kein wachsender Textbuffer |
| statischer Text, Animation aus | ca. 17,4 % | 6,0 % | 5,4 % | diagnostischer A/B, kein Fixvorschlag |
| `.77`, normales Markdown | ca. 47,8 % | 25,4 % | 20,4 % | vollständiger TextBuffer-Ersatz dominiert verbleibende Last |
| `.78`, append-only TextBuffer | ca. 27,8 % | 16,1 % | 11,2 % | bestätigter Produktgewinn von rund 20 Prozentpunkten |
| `.79`, experimenteller Partial-Allokationspatch | ca. 34,1 % | 18,7 % | 13,5 % | kein Gewinn nachweisbar, Patch verworfen |

Die Werte schwanken mit Modellchunking und Antwortstruktur. Trotzdem ist der `.77`→`.78`-Abstand groß und mit
dem Codepfad konsistent: Default-gestylte, append-only Prosa ersetzt nicht mehr bei jedem Delta den vollständigen
nativen TextBuffer, sondern ruft `TextBuffer.append()` nur mit dem Suffix auf. Stiländerungen, Links,
Markdown-Metazeichen und nicht append-only Änderungen fallen konservativ auf `setStyledText()` zurück.

Ein separater Code-Test spioniert beide nativen Grenzmethoden aus: Beim Prosa-Append wird genau einmal
`append(" grows")` und kein `setStyledText()` aufgerufen; beim anschließenden Farbwechsel wird genau der
vollständige Ersatzpfad genommen. Der echte `.78`-Lauf bestätigt, dass diese Abgrenzung im TUI greift.

### Marked-Blocklexer an Absatzgrenzen

Das `.73`-CPU-Profil enthielt 84 Leaf-Samples in Markeds Setext-Heading-RegEx. Der vorhandene Same-line-Fast-Path
griff innerhalb eines Absatzes, nicht aber wenn ein Providerchunk `\n\n` und den Beginn des nächsten
Prosaabsatzes enthielt. Mit dem echten `.73`-Antworttext und exakt acht beobachteten Updategrenzen benötigten die
inkrementellen Parserupdates im Median 54,9 ms. Der neue, konservative Prosa-Absatzpfad benötigte 4,9 ms
(`-91 %`) und erzeugte tokenidentisches Ergebnis zu `Lexer.lex()`.

Gegenproben erzwingen weiterhin den Blocklexer für `# Heading`, `1. item`, HTML-Blöcke und Setext-Headings. Im
finalen Stand waren 190 Markdown-/Code-/Parser-Tests grün.

### Was die tieferen A/Bs ausgeschlossen haben

- Plain `TextRenderable` statt Markdown lag unter interner Instrumentierung praktisch gleichauf mit Markdown.
  Markdown/Tree-sitter allein erklärte die Restlast nicht.
- Ein statischer Textknoten reduzierte Full Frames im 9,2-s-Fenster auf einen einzigen Frame; 71
  Spinner-Partialframes und acht Deltas benötigten gemessen nur 66 ms Frame- und 7 ms Delta-Walltime. Die damals
  beobachteten 85 % waren überwiegend das Frame-Trace-Artefakt.
- Der externe SSE-Mitschnitt eines vollständigen Laufs sah 68 `message.part.delta`-Events mit 23,7 KiB und fünf
  `message.part.updated`-Snapshots mit zusammen 18,4 KiB. Ein ungebremster Vollsnapshot pro Token ist damit
  ausgeschlossen.
- Ein isolierter Timer-A/B mit 1.000 Ticks zeigte nur 14 ms Mehrkosten für Neuarmierung gegenüber einem stabilen
  Intervall. Der Spinner-Scheduler wurde deshalb nicht als Scheinfix umgebaut und sein 80-ms-Intervall blieb
  unverändert.
- Ein experimenteller Cache/arrayfreier Partial-Renderpfad bestand zwar 158 Tests, senkte die reale CPU aber
  nicht. Er wurde wieder entfernt.
- SGR-Mausbewegungen können eine separate framefreie Hochlastphase erklären: 20.000 injizierte Mouse-Moves
  brachten eine kontrollierte TUI auf 53,8 % ohne einen Frame. Sie erklären jedoch nicht die hier gemessene
  Streaminglast ohne Input.

### Aktueller belastbarer Stand

Der größte bestätigte Gewinn der letzten Messreihe ist der native Append-Pfad: normale Streaminglast sank im
instrumentationsfreien, extern gemessenen Lauf von rund 47,8 % auf rund 27,8 % eines Kerns. Das ist keine
Taktreduktion; pro Update wird nach einem beweisbaren Präfix-/Default-Style-Check weniger Arbeit ausgeführt.
Parser-Absatzwechsel sanken im Replay zusätzlich um 91 %. Die verbleibenden ungefähr 17 Prozentpunkte über Idle
verteilen sich auf Event/Store-Verarbeitung, Animation/Partialframes und echte Layoutänderungen. Sie sind deutlich
kleiner als der beseitigte vollständige TextBuffer-Ersatz und noch nicht vollständig eliminiert.

### Nachlauf: schnelle Last und verworfener Zeichen-Batch (`.80` bis `.84`)

Ein nach dem Fix aufgenommenes, signalgesteuertes JSC-Profil bestätigte, dass bei schneller Last vor allem
native Retained-/Partial-Frames, Yoga-Layout, TextBuffer-Zeichnung und der Spinnerpfad aktiv bleiben. Die
`timeDeltas` dieses Profils sind nicht als CPU-Zeiten verwendbar: Während der Eventloop schläft, entstehen keine
Samples; der nächste Sample erhält dadurch einen langen Walltime-Abstand. Für die Callpath-Bewertung wurden
deshalb Sampleanzahlen und die unabhängigen `/proc`-Messungen verwendet.

Als konkrete Gegenprobe wurde die acht Zeichen breite Knight-Rider-Animation ohne Frequenzänderung gebündelt:
statt acht JS→Native-`drawChar`-Aufrufen sollte ein nativer Batch-Aufruf denselben Frame zeichnen. Der isolierte
Grenzbenchmark war deutlich: 100.000 Frames sanken im Median von 702 auf 189 ms (`-73 %`). In einem synthetischen
vollständigen Partial-Frame-Loop blieb davon noch ungefähr 16 % CPU-/Walltime-Gewinn übrig.

Der instrumentationsfreie Live-A/B widerlegte jedoch einen relevanten Produktgewinn. Beide Läufe nutzten
`power-saver`, 156×65 Zellen, `--pure`, DeepSeek ohne Reasoning, denselben 3.000-Wörter-Prompt und ein extern über
SSE am ersten Textdelta gestartetes Zehn-Sekunden-Fenster:

| Variante | Gesamt-CPU | Main | `HeapHelper` gesamt |
|---|---:|---:|---:|
| `.84`, acht einzelne Zeichenaufrufe | 83,4 % | 43,3 % | 35,4 % |
| `.83`, ein gebündelter Zeichenaufruf | 81,7 % | 43,1 % | 34,0 % |

Der Main-Thread blieb damit praktisch unverändert; die Differenz von 1,7 Prozentpunkten liegt in der
GC-/Lauf-zu-Lauf-Streuung. Der Batch, seine neue native ABI und der Dependency-Patch wurden vollständig entfernt.
Das ist zugleich ein wichtiger Lastbefund: Ein schneller Provider kann trotz des TextBuffer-Append-Fixes noch
deutlich höhere CPU erzeugen als der frühere GLM-Vergleich. Die Restarbeit skaliert weiterhin mit Delta-Rate,
Layoutänderungen und Allocation/GC; sie ist nicht durch die acht Zeichen des Spinners allein erklärbar.

Zusätzlich verarbeitet der Streamingpfad an mehreren Stellen den vollständigen gewachsenen Wert statt nur das
Delta. Das erzeugt vermeidbare O(n)-Arbeit pro Update, potenziell O(n²) über einen langen Block, viele kurzlebige
Objekte und entsprechend hohe JSC-GC-Last. Ein unabhängiger Parser-A/B bestätigt diesen Zusammenhang: 5.000
Ein-Zeichen-Appends über den wachsenden Absatz benötigten median 4.515 ms CPU gegenüber 134 ms für das Lexing nur
des neuen Zeichens und lösten in jedem Lauf eine JSC-Allokations-GC bei rund 29,6 MB aus.

Auch die separat beobachtete hohe Server-CPU ist reproduzierbar an den Textdelta-Zustellpfad gekoppelt, allerdings
nicht primär an die Bytezahl. Ein unabhängiger A/B im realen 200-ms-Takt zeigt: Fünf einzeln zugestellte Events pro
Sekunde wecken Effect Queue, Stream, SSE-Encoding und HTTP-Schreibpfad jeweils neu. Ein A/B mit Server und Client
in getrennten Prozessen misst dafür reproduzierbar rund 20,7 zusätzliche CPU-Prozentpunkte ausschließlich im
Serverprozess; mit In-Process-Leser sind es ungefähr 50. Ein Burst-Test hatte diese Kosten zunächst verdeckt,
weil tausende bereits gequeue-te Events in wenigen Wakeups drainen und die Fixkosten amortisieren.

## Aktuelle Live-Beobachtung

Am 2026-07-17 liefen sechs OpenCode-TUI/Server-Paare. Zwei Sessions streamten während der Messung aktiv. Für eine
aktive Session wurden über drei Intervalle folgende Werte gemessen:

| Prozess | CPU-Intervalle | RSS |
|---|---:|---:|
| TUI | 85,6 %, 115,5 %, 115,9 % | ca. 365 MiB |
| lokaler TUI-Server | 65,4 %, 28,5 %, 23,6 % | ca. 570 MiB |

Eine zweite aktive Session lag gleichzeitig bei 24,6–52,5 % TUI-CPU und 15,6–42,4 % Server-CPU. Die Logs
bestätigten für beide Sessions laufende Provider-Turns. Der Snapshot beweist daher keine nach Streamende hängen
gebliebene Lifecycle-Last, sondern hohe Kosten während realer Modell- und Tool-Aktivität.

Ein direkter Fünf-Sekunden-Thread-Sample zeigte für die heißeste TUI rund 19,9 Prozentpunkte in sieben
`HeapHelper`-Threads. Beim zugehörigen Server kamen rund 12,5 Prozentpunkte aus dessen `HeapHelper`-Threads. Die
JSC-CPU-Profile enthalten diese parallele GC-Arbeit nicht; sie unterschätzen daher die gesamte Prozesslast.

`BUN_JSC_forceRAMSize` war in den betroffenen Prozessen nicht gesetzt. Der bekannte Fehler einer erzwungenen
512-MiB-JSC-Grenze ist für diesen Lauf ausgeschlossen.

## Frame-Zähler als kausaler Fingerabdruck

Temporäre Partial-Render-Diagnosebuilds schrieben die Anzahl von Partial-, Full- und Bail-Frames. Die zugehörigen
CPU-Profile liefen jeweils ungefähr eine Minute:

| Build | Dauer | Partial | Partial/s | Full | Full/s | `layoutDirty` | `layoutDirty`/s | Anteil an Full |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `.53-profile` | 74,0 s | 799 | 10,8 | 449 | 6,1 | 420 | 5,7 | 93,5 % |
| `.54-profile` | 60,5 s | 641 | 10,6 | 319 | 5,3 | 269 | 4,4 | 84,3 % |
| `.55-profile` | 71,5 s | 754 | 10,5 | 390 | 5,5 | 353 | 4,9 | 90,5 % |

Diese Verteilung ist über drei Builds stabil. Sie passt direkt zu den beiden Taktgebern:

- der Prompt-Spinner läuft mit 100 ms, andere Spinner mit 80 ms;
- `ai-process-worker.ts` bündelt aufeinanderfolgende Text- oder Reasoning-Deltas mit einem 200-ms-Timer.

Nach dem Markdown-Prose-Fast-Path sank der gemessene Block-Lexer-Hotspot deutlich, aber die Full-Frame-Rate blieb
bei ungefähr fünf pro Sekunde. Damit ist belegt, dass der verbleibende Haupttreiber nicht der inzwischen
optimierte Marked-Blockparser ist, sondern die Layout-/Renderinvalidierung nach jedem gebündelten Textupdate.

## Exakte Invalidierungskette

### 1. AI-Worker: fünf Delta-Batches pro Sekunde

`packages/opencode/src/session/llm/ai-process-worker.ts` hält ein `pendingDelta` und startet einen 200-ms-Timer.
Aufeinanderfolgende Deltas desselben Typs werden zu einem String zusammengefügt. Ohne strukturelles Event erhält
der Server dadurch ungefähr fünf Delta-Nachrichten pro Sekunde.

Der Server legt anschließend noch ein `Stream.groupedWithin(64, "16 millis")` darüber. Da der Worker bereits
auf 200 ms bündelt, reduziert dieses Fenster die Frequenz im üblichen AI-Process-Pfad kaum weiter.

### 2. TUI: vollständiger Part-String statt Deltaobjekt

`packages/tui/src/context/sync.tsx` sammelt Deltas nochmals kurz und schreibt anschließend:

```ts
setStore("part", messageID, index, field, (existing ?? "") + pending.delta)
```

Das Store-Feld enthält danach immer den vollständigen bisher gestreamten Text. Die Stringverkettung kann intern
zunächst als Rope billig sein, muss aber in späteren Schritten für `trim`, Prefix-Vergleiche, Parser, Encoder und
FFI-Zugriffe wieder materialisiert oder vollständig gelesen werden.

### 3. Solid und Markdown erhalten den vollständigen Wert

`TextPart` reicht bei jedem Store-Update `props.part.text.trim()` als vollständigen Markdowninhalt weiter. Der
inkrementelle Parser vermeidet inzwischen einen vollständigen Blockparse, führt im normalen Prose-Fast-Path aber
weiterhin unter anderem folgende Arbeit aus:

- Prefix-Prüfung gegen den vorherigen Gesamtinhalt;
- Kopieren des Tokenarrays;
- Aufbau eines neuen Tail-Tokens;
- `Lexer.lexInline(text)` über den vollständigen aktuellen Paragraphen.

Das ist deutlich billiger als der frühere Block-Lexer, aber kein echter Delta-Append-Pfad.

### 4. CodeRenderable startet vollständiges Highlighting

Top-Level-Markdownblöcke werden intern als `CodeRenderable` mit `filetype="markdown"` dargestellt. Bei einer
Inhaltsänderung wird `_highlightsDirty` gesetzt. Beim nächsten Render startet `startHighlight()`:

```ts
const result = await this._treeSitterClient.highlightOnce(content, filetype)
```

`content` ist der vollständige aktive Block. Auch wenn ältere Highlight-Ergebnisse per Snapshot-ID verworfen
werden, sind Parserarbeit und viele Allokationen bis zu diesem Abbruch bereits entstanden.

Bei Markdown ist außerdem ein `onChunks`-Callback aktiv. Deshalb wird auch bei einer leeren Highlightliste ein
neuer `StyledText` gebaut und über `textBuffer.setStyledText(styledText)` vollständig in den nativen TextBuffer
geschrieben. Die vorhandene native `TextBuffer.append(text)`-API wird in diesem Markdownpfad nicht verwendet.

### 5. Der konkrete Layout-Bug

Commit `7e01670 perf(core): keep same-line streams partial` hat im synchronen `content`-Setter korrekt die
Dimensionen vor und nach dem TextBuffer-Update verglichen:

```ts
this.updateTextInfo(
  (this._width === "auto" && scrollWidth !== this.scrollWidth) ||
    (this._height === "auto" && scrollHeight !== this.scrollHeight),
)
```

Der asynchrone Highlightpfad endet dagegen weiterhin an zwei Stellen mit:

```ts
this.updateTextInfo()
```

Das gilt sowohl nach erfolgreichem Highlighting als auch im Fehler-Fallback. In
`TextBufferRenderable.updateTextInfo(layoutChanged = true)` führt der Default unmittelbar zu:

```ts
if (layoutChanged) this.yogaNode.markDirty()
this.requestRender()
```

`CodeRenderable` ist im Streamingmodus zwar partial-eligible. Das dirty Yoga-Root wird jedoch zuerst von
`canPartialRender()` geprüft. Der Partial-Pfad wird deshalb abgelehnt und der vollständige Root-Render ausgeführt.

### 6. Warum der vorhandene Test den Fehler übersieht

Der Test `CodeRenderable - same-line streaming update keeps layout clean` setzt den neuen Inhalt und prüft den
Yoga-Zustand sofort danach. Er beweist nur, dass der synchrone Setter sauber bleibt. Der Test:

- führt keinen Render aus, der das Highlighting startet;
- wartet nicht auf `highlightingDone`;
- prüft den Yoga-Zustand nicht nach dem asynchronen Highlight-Ergebnis.

Der Test deckt somit exakt die erste Hälfte von `7e01670` ab, nicht aber den realen Streaming-Lifecycle.

## Kosten eines erzwungenen Full-Frames

Wenn `layoutDirty` gesetzt ist, überspringt OpenTUI den Partial-Pfad. Der Full-Frame umfasst:

1. Yoga-Messung und Layoutberechnung;
2. Root-Render und Traversierung der sichtbaren Renderables;
3. Zeichnen aller sichtbaren Text-, Box-, Markdown- und Tool-Renderables;
4. Console-Compositing;
5. nativen Framebuffer-Diff und Terminalausgabe.

Im `.55`-TUI-Profil lagen überlappende inklusive Anteile ungefähr bei:

- Renderer-Loop: 40,9 %;
- Root-Render: 25,3 %;
- Yoga/Layout: 9,9 %;
- `flushDeltas`/Solid-Updatepfad: 9,6 %;
- nativer Renderpfad: 7,2 %;
- Partial-Frame-Pfad: 6,0 %.

Die Prozentwerte sind inklusive Call-Tree-Anteile und dürfen nicht addiert werden. Sie zeigen aber klar, dass
Render und Layout nach dem Parser-Fast-Path die dominierenden TUI-Blöcke sind.

Die Kosten eines Full-Frames wachsen mit der sichtbaren Renderbaumkomplexität. Toolblöcke, Reasoning, lange
Markdownblöcke und ein erweitertes Message-Window machen denselben unnötigen Full-Frame teurer. Das erklärt,
warum kurze isolierte Tests relativ gut aussehen, während reale Agent-Sessions mit Toolwechseln und längerer
Historie stark ansteigen.

## Auch Partial-Render ist noch kein Dirty-Region-Render

Der Partial-Pfad überspringt zwar Yoga und den Root-Tree-Walk, arbeitet aber nicht ausschließlich auf der
geänderten Region. Vor jedem Partial-Frame wird derzeit der komplette committed Framebuffer restauriert:

```ts
this.nextRenderBuffer.drawFrameBuffer(0, 0, this.currentRenderBuffer)
```

Dieser Restore ist für die Korrektheit nötig, weil der native Renderer den Next-Buffer nach dem Present leert.
Anschließend rendert OpenTUI nur die angeforderten Renderables, der native Present-Pfad diff't jedoch weiterhin
den Frame. Im `.55`-Profil war `drawFrameBuffer` allein einer der größten Self-Hotspots.

Der Partial-Pfad ist daher wesentlich billiger als ein Full-Frame, aber noch kein echter Dirty-Rectangle-Pfad.
Nach dem Layout-Fix wird dieser vollständige Buffer-Restore voraussichtlich zum nächsten relevanten Rendererhebel.

## Full-value-Reprocessing und GC

Neben der falschen Layoutinvalidierung bestehen mehrere O(n)-Schritte pro Update des wachsenden Blocks:

- Stringverkettung im TUI-Store;
- `trim()` und Prefix-Prüfungen über den Gesamtinhalt;
- vollständiges Inline-Lexing des aktiven Paragraphen;
- neue Token-, Chunk- und `StyledText`-Objekte;
- vollständiges `highlightOnce(content, filetype)`;
- vollständiges `setStyledText()` für den aktiven Block;
- Framebuffer-Restore über die gesamte Terminalfläche.

Bei `k` Updates eines bis auf Länge `n` wachsenden Blocks kann die Summe dieser linearen Schritte quadratisch
in der Blocklänge werden. Moderne JS-Engines können einzelne Stringverkettungen durch Ropes aufschieben, aber
Parser, UTF-8-Encoding und native Übergaben erzwingen später die Traversierung oder Materialisierung.

Die parallele `HeapHelper`-Last ist daher kein unabhängiges Phänomen. Ein unabhängiger A/B weist hohe
Allokationsraten sowohl dem Full-value-Parser als auch dem unnötigen Full-Root-Render zu. Weitere Beiträge aus
Solid-Updates, Tree-sitter, Chunkarrays und Frameaufbereitung sind plausibel, aber noch nicht einzeln isoliert.
Ein reines JSC-CPU-Profil zeigt die GC-Kosten nicht vollständig, weil die HeapHelper auf separaten Threads laufen.

## Server-CPU: einzeln getaktete SSE-Events statt Bytemenge

Die Rendererreparatur senkt nur die TUI-Seite. Im lokalen TUI-Server bleibt pro Delta eine weitere Pipeline:

1. JSON-Zeilenprotokoll vom AI-Worker;
2. Parse mit Reviver;
3. Effect Queue und Stream;
4. LLM-Event-Konvertierung und Session-Event;
5. SSE-Schema/JSON-Encoding;
6. HTTP/EventEmitter-Zustellung an die TUI.

Im `.55`-Serverprofil waren unter anderem Effect-Scheduler/Run-Tasks, Queue-`releaseTakers`, JSON
`stringify`/`parse`, HTTP-Handling und Schemaauswertung sichtbar. Das Profil allein sagt nicht, welcher Workload
diese generischen Laufzeitfunktionen aufruft. Der folgende getaktete A/B ordnet einen wesentlichen Teil nun
kausal dem SSE-Zustellpfad zu.

Der unabhängige Replay-A/B startet den echten HTTP-API-Layer, öffnet `/global/event` und emittiert reale
`message.part.delta`-Events. Bei 50 Events im echten Abstand von 200 ms benötigte der vollständige In-Process-Pfad
in drei Läufen 6,87–7,18 s CPU. Die identische `emit-only`-Kontrolle benötigte 1,75–2,22 s; die paarweise Differenz
lag bei 4,72–5,28 s in zehn Sekunden Eventzeit. Native Timer statt `Effect.sleep`, abgeschaltetes GC-Logging und
das Weglassen der initial erzwungenen Voll-GC reproduzierten weiterhin ungefähr 49–53 zusätzliche
CPU-Prozentpunkte. Die Messinstrumentierung ist daher nicht die Ursache.

Ein In-Process-Arm, der die HTTP-Antwort bewusst nicht liest, lag in zwei Läufen bei 3,96 und 4,82 s CPU gegenüber
0,95 und 0,96 s für `emit-only`. Weil dieser Prozess weiterhin beide Socket-Endpunkte enthält, ist das noch keine
reine Serverattribution. Der strengere A/B startete daher den echten Server und den lesenden SSE-Client in
getrennten Prozessen und maß nur `process.cpuUsage()` des Servers. Die beiden Serverläufe ergaben 0,760 und
0,712 s ohne Abonnent gegenüber 2,827 und 2,780 s mit externem Client. Die Differenz betrug in beiden Läufen
2,07 s pro zehn Sekunden Eventzeit, also rund 20,7 CPU-Prozentpunkte ausschließlich serverseitig.

Eine zehn Sekunden offene, aber eventlose SSE-Verbindung erhöhte die CPU dagegen median nur um 0,22 s. Der
Großteil hängt damit an den einzelnen Events, nicht am bloßen Offenhalten der Verbindung.

Der Code erklärt die Frequenzabhängigkeit: `Queue.offerUnsafe()` plant bei einem wartenden Consumer über
`scheduleReleaseTaker()` einen Scheduler-Task. Weil die Queue zwischen 200-ms-Events wieder leer wird, durchläuft
jeder Batch separat `releaseTakers`, Effect Stream, `JSON.stringify`, `Sse.encode`, `encodeText` und den
HTTP-Schreibpfad. Im gepaceten Profil ist `releaseTakers` mit 667,5 ms Self-Time und 1,59 s inklusiv ein Top-Hotspot.
Eine Stufenintervention zeigt zugleich, dass die Kosten über Queue/Stream, Encoding und HTTP verteilt sind und
nicht von einer einzelnen JSON-Zeile stammen.

Die hohe Allokationsrate ist temporär: Nach einer erzwungenen Voll-GC blieb in den gemessenen Armen kein positives
Heap- oder Objektwachstum gegenüber dem Startmesspunkt. Vor der Sammlung erzeugte der vollständige Pfad jedoch
rund 27 MB zusätzliche Heap-Kapazität und 174–178 GC-Zyklen, gegenüber 22–27 Zyklen in der gepaceten
`emit-only`-Kontrolle. Das passt zum live beobachteten Server-`HeapHelper`-Anteil.

## Ursachenbewertung

### Beweismaßstab

Die Analyse unterscheidet vier Evidenzstufen:

1. **Kontrollfluss bewiesen:** Der ausgeführte Code kann nur das beschriebene Verhalten haben.
2. **Dynamisch bewiesen:** Ein isolierter Test beobachtet das Verhalten zur Laufzeit.
3. **Kausal bewiesen:** Eine gezielte Intervention nur an der verdächtigen Stelle entfernt das Verhalten.
4. **Noch nicht isoliert:** Profil und Code zeigen einen plausiblen Beitrag, aber kein kontrolliertes A/B ordnet
   dessen exakten CPU-Anteil zu.

### Beweismatrix der einzelnen Ursachenstellen

| These | Codebeweis | Laufzeitbeweis | Status |
|---|---|---|---|
| AI-Worker erzeugt höchstens alle 200 ms ein Delta-Batch | `ai-process-worker.ts:107-132` hält `pendingDelta` und setzt `setTimeout(flush, 200)` | Gemessene Full-Frame-Rate liegt stabil bei 4,4–5,7 `layoutDirty`-Bails/s | Kontrollfluss bewiesen; Zuordnung der gesamten Bail-Menge sehr stark, aber noch ohne gemeinsamen Callsite-Counter |
| TUI schreibt bei jedem Flush den vollständigen gewachsenen Part-String | `sync.tsx:188-200` setzt `(existing ?? "") + pending.delta` in den Store | `flushDeltas` liegt im `.55`-TUI-Profil bei 9,6 % inklusiv | Ausführung und Profilbeitrag bewiesen; interne Rope-/Flatten-Kosten nicht separat isoliert |
| Prose-Fast-Path lexiert den vollständigen aktuellen Paragraphen | `markdown-parser.ts:31-51` bildet `text = tail.text + appended` und ruft `Lexer.lexInline(text)` auf | Kontrolltest: 100 Ein-Zeichen-Appends erzeugten 100 `lexInline`-Aufrufe mit Längen 2 bis 101, insgesamt 5.150 verarbeitete Zeichen | Algorithmisch und dynamisch bewiesen |
| Highlighting erhält den vollständigen Block statt des Deltas | `Code.ts:startHighlight()` ruft `highlightOnce(content, filetype)` mit `_content` auf | Recording-Mock erhielt nach `"Hello" -> "Hello world"` den vollständigen String `"Hello world"` | Dynamisch bewiesen |
| Akzeptiertes Same-line-Highlight markiert Yoga fälschlich dirty | `Code.ts:433/448` ruft `updateTextInfo()` argumentlos auf; Default in `TextBufferRenderable.ts:366` ist `true` | Isolierter Test: vor Highlight clean, nach akzeptiertem Highlight dirty | Dynamisch bewiesen |
| Dieses dirty Yoga erzwingt den Full-Frame | `renderer.ts:4662` lehnt Partial bei dirty Root-Layout ab; der Loop fällt auf `root.render()` zurück | Spy-Test: Same-line-Update rendert zunächst partial; nach Highlight wird `root.render()` exakt einmal aufgerufen | Kausal bewiesen |
| Der argumentlose Highlight-Aufruf ist die konkrete Kausalstelle | Nur dieser Aufruf unterscheidet sich vom bereits dimensionssensitiven Setter in `Code.ts:144-147` | Interventionskontrolle behandelt ausschließlich `undefined` als `layoutChanged=false`: Yoga bleibt clean und `root.render()` wird nicht aufgerufen | Kausal bewiesen |
| Partial-Render kopiert den gesamten committed Framebuffer | `renderer.ts:4717` ruft `drawFrameBuffer(0, 0, currentRenderBuffer)` auf | Spy-Test beobachtete im Partial-Frame exakt diesen Full-Buffer-Aufruf; `drawFrameBuffer` ist zugleich ein `.55`-Self-Hotspot | Dynamisch bewiesen |
| Full-value-Inline-Lexing erzeugt konkrete CPU- und Allokationsmehrarbeit | `markdown-parser.ts:31-51` reicht bei jedem Append den gewachsenen Absatz erneut an `Lexer.lexInline(text)` | 3 frische Prozesse je Arm, 5.000 Updates: median 4.515 ms statt 134 ms CPU; nur der Full-value-Arm löste in 3/3 Läufen eine Allokations-GC bei rund 29,6 MB aus | Kausal bewiesen für Parserarbeit und Allokationsdruck |
| Der unnötige Full-Root-Render erzeugt konkrete CPU- und Allokationsmehrarbeit | Der einzige Eingriff im Kontrollarm ersetzt den argumentlosen Highlight-Aufruf semantisch durch `updateTextInfo(false)` | 5 frische Prozesse je Arm, 400 Updates, 100 statische Knoten: fehlerhafter Stand median 2.438 statt 1.296 ms CPU und 27,36 statt 5,10 MB zusätzliche Heap-Kapazität; Allokations-GC in 3/5 statt 0/5 Läufen | Kausal bewiesen für diese Callsite unter nichttrivialer Baumlast |
| JSC-GC ist ein wesentlicher Teil der Live-CPU | Die bewiesenen Parser- und Full-Render-Pfade allokieren; weitere Pipeline-Stufen kommen hinzu | Live: rund 19,9 CPU-Prozentpunkte in TUI-HeapHelpern und 12,5 im Server-Sample; isolierte A/Bs lösen nur in den teuren Armen Allokations-GCs aus | Live-GC-Anteil und zwei konkrete Erzeuger bewiesen; exakte Aufteilung aller Live-GCs bleibt offen |
| Getaktete SSE-Textdeltas erklären einen wesentlichen Server-CPU-Anteil | `handlers/global.ts:41-80` führt jedes Event durch bounded Queue, Effect Stream, `JSON.stringify`, SSE-Encoding und HTTP-Stream; Effect `Queue.js:1457-1463` plant für wartende Taker einen Release-Task | Externer Zwei-Prozess-A/B: Server in 2/2 Läufen rund 20,7 CPU-Prozentpunkte teurer mit SSE-Client; vollständiger In-Process-Pfad rund 50 Punkte; eventlos nur rund 2,2 Punkte Mehrlast | Kausal bewiesen für den Zustellpfad; Kosten auf mehrere nachgelagerte Stufen verteilt |

Die Prozentgruppen des Serverprofils sind eine diagnostische Klassifikation nach Leaf-Funktion beziehungsweise
Source-URL. Sie überschneiden sich nicht, sind aber keine offizielle Profilerkategorie. Erst der gepacete
Interventions-A/B erlaubt die workload-spezifische Zuordnung. Das Burst-Gegenbeispiel zeigt zugleich, dass eine
richtige Call-Tree-Beobachtung durch eine unrealistische Ereignisverteilung leicht falsch bewertet werden kann.

### Isolierte dynamische Beweistests

Für die Analyse wurde ein temporärer Test unter `/tmp/opentui-code-layout-proof.test.ts` gegen den unveränderten
OpenTUI-Stand `a89c08e` ausgeführt:

```text
3 pass
0 fail
19 expect() calls
```

Die drei Tests beweisen:

1. **Produktionsverhalten:** Ein Same-line-Update bleibt im synchronen Setter layout-clean und rendert partial.
   Nach dem akzeptierten Highlight-Ergebnis wird Yoga dirty; der Folgeframe ruft den vollständigen Root-Render
   auf.
2. **Kausale Intervention:** Wird nur der argumentlose `updateTextInfo()`-Aufruf als
   `layoutChanged=false` behandelt, bleiben Yoga und Root-Render im identischen Ablauf partial. Andere Logik,
   Inhalte und Highlight-Ergebnisse bleiben unverändert.
3. **Quadratisches Zeichenvolumen im Prose-Tail:** 100 einzelne Appends führen zu 100 vollständigen
   `lexInline`-Aufrufen über den jeweils gewachsenen Paragraphen. Die Summe beträgt 5.150 gelesene Zeichen bei
   nur 100 neuen Zeichen.

Der erste Test spioniert zusätzlich `nextRenderBuffer.drawFrameBuffer` aus und bestätigt, dass ein erfolgreicher
Partial-Frame den vollständigen `currentRenderBuffer` bei `(0, 0)` in den Next-Buffer kopiert.

### Unabhängiger CPU-/GC-A/B

Die temporären Harnesses `/tmp/opentui-gc-ab.ts` und `/tmp/run-gc-ab.ts` liefen jeden Arm in einem frischen
Bun-Prozess. Vor der Messung wurde einmal vollständig gesammelt; während des Messfensters protokollierte
`BUN_JSC_logGC=1` automatische GC-Zyklen und deren Allokationsauslöser. Gemessen wurden Prozess-CPU,
Wall-Clock, JSC-Heap und Objektzahl. Die Kontrollarme ändern jeweils nur die untersuchte Ursache.

#### Full-value-Parser gegen Delta-Kontrolle

Beide Arme führen 5.000 Ein-Zeichen-Updates aus. Der Produktionsarm ruft den echten
`parseMarkdownIncremental(state.content + "a", state, 2)` auf. Die Kontrolle lexiert mit denselben Marked-Optionen
nur das neue Zeichen. Drei frische Prozesse je Arm ergaben:

| Arm | mediane CPU | CPU-Faktor | Läufe mit Allokations-GC | gemeldete Bytes am GC-Trigger |
|---|---:|---:|---:|---:|
| wachsender Produktionsabsatz | 4.515 ms | 33,8x | 3/3 | 29,57–29,59 MB |
| Ein-Zeichen-Kontrolle | 134 ms | 1,0x | 0/3 | – |

Damit ist nicht nur die O(n²)-Zeichensumme, sondern die reale CPU- und Allokationswirkung des wachsenden
Parserinputs kausal belegt. Die Messung quantifiziert einen synthetisch langen aktiven Absatz; sie behauptet
nicht, dass der Parser allein 33,8x der gesamten Live-TUI kostet.

#### Fehlerhafter Full-Frame gegen Layout-Kontrolle

Beide Arme verwenden echten `CodeRenderable`, echten Renderer und identische akzeptierte Highlight-Ergebnisse.
Der Kontrollarm überschreibt nur `updateTextInfo(layoutChanged?: boolean)` so, dass ausschließlich der
argumentlose Aufruf `false` statt des Produktionsdefaults `true` bedeutet. Explizite Layoutänderungen bleiben
unverändert. Mit 100 statischen Textknoten und 400 Same-line-Updates ergaben fünf frische Prozesse je Arm:

| Arm | mediane CPU | mediane Wall-Clock | zusätzliche Heap-Kapazität | Läufe mit Allokations-GC |
|---|---:|---:|---:|---:|
| aktueller fehlerhafter Stand | 2.438 ms | 1.944 ms | 27,36 MB | 3/5 |
| nur argumentloser Aufruf layout-clean | 1.296 ms | 1.168 ms | 5,10 MB | 0/5 |

Der fehlerhafte Stand benötigt damit median 88,1 % mehr CPU und 66,5 % mehr Wall-Clock; seine zusätzlich
reservierte Heap-Kapazität ist 5,37x so groß. Ein Minimalbaum zeigte erwartungsgemäß weniger Trennung. Die
deutliche Trennung bei 100 Knoten entspricht der Codeeigenschaft, dass der unnötige Root-Render mit der
Renderbaumgröße teurer wird.

### Unabhängiger Server-Replay-A/B

Die temporären Harnesses `/tmp/opencode-server-delta-ab.ts` und `/tmp/run-server-delta-ab.ts` verwenden den
unveränderten OpenCode-Stand `recovered-45`. Jeder Arm startet den echten `httpApiLayer` und emittiert identische
`message.part.delta`-Objekte. Der vollständige Arm verbindet den echten `/global/event`-Stream und liest jedes
Event. Die `emit-only`-Kontrolle hat keinen SSE-Abonnenten. Weitere Arme entfernen jeweils genau eine Gruppe
nachgelagerter Stufen.

#### Warum der erste Burst-A/B ein falsches Negativergebnis lieferte

Ein erster Durchsatztest schob 2.000 Events ohne Abstand in die Queue. Er maß nur 0,132 ms Differenz je Event;
selbst 2-KiB-Payloads lagen bei 0,245 ms. Diese Zahlen sind für einen bereits gefüllten Queue-Burst korrekt, aber
nicht auf fünf einzeln eintreffende Events pro Sekunde übertragbar: Der Consumer bleibt während des Bursts aktiv
und amortisiert Scheduler-, Stream- und HTTP-Fixkosten über viele Events.

Mit dem echten 200-ms-Abstand ergaben drei frische Prozesse je Arm:

| Arm | CPU für 50 Events/10 s | paarweiser SSE-Mehraufwand |
|---|---:|---:|
| `emit-only` | 1,75–2,22 s | – |
| vollständiger SSE-Pfad mit In-Process-Leser | 6,87–7,18 s | 4,72–5,28 s |

Zwei zusätzliche Kontrollen schließen Messartefakte aus:

- Mit nativen `Bun.sleep`-Timern statt `Effect.sleep` blieb die Differenz bei rund 53 CPU-Prozentpunkten.
- Ohne `BUN_JSC_logGC` und ohne initiale erzwungene Voll-GC blieb sie bei rund 49 CPU-Prozentpunkten.

#### Events, nicht die offene Verbindung

Eine zehn Sekunden offene, aber eventlose Verbindung wurde ebenfalls gegen `emit-only` gemessen:

| Arm | mediane CPU/10 s | Differenz |
|---|---:|---:|
| eventlos ohne SSE-Verbindung | 0,69 s | – |
| eventlose offene SSE-Verbindung | 0,91 s | 0,22 s |

Das reine Offenhalten erklärt damit nur rund 2,2 CPU-Prozentpunkte. Erst fünf getrennte Zustellungen pro Sekunde
erzeugen den großen Sprung.

#### Stufenintervention

Die folgenden Arme nutzen dasselbe 200-ms-Pacing. Die Bereiche stammen aus je zwei frischen Läufen mit
GC-Logging; ein separater Lauf ohne Logging zeigte dieselbe monotone Reihenfolge.

| Arm | Enthaltene Stufen | CPU/10 s | automatische GC-Zyklen |
|---|---|---:|---:|
| `emit-only` | ID/`EventEmitter` | 0,95–1,22 s | 22–27 |
| `queue-drain` | plus Effect Queue und Stream-Consumer | 1,71–2,64 s | 40–61 |
| `encoded-drain` | plus `JSON.stringify`, `Sse.encode`, `encodeText` | 2,33–3,36 s | 57–85 |
| `sse-no-read` | plus echter HTTP-SSE-Schreibpfad, kein Body-Reader | 3,96–4,82 s | 96–122 |
| vollständiger `sse`-Arm | plus In-Process-HTTP- und Stream-Leser | 6,94–6,97 s | 174–178 |

Der `sse-no-read`-Arm schließt das Body-Decoding als Hauptursache aus: Gegenüber seiner gepaarten
`emit-only`-Kontrolle bleiben 3,01–3,85 s zusätzliche CPU in zehn Sekunden. Da beide Socket-Endpunkte noch im
selben Prozess liegen, dient dieser Arm der Stufenzerlegung, nicht der finalen reinen Serverquantifizierung.

#### Externer Zwei-Prozess-Beweis

Die temporären Harnesses `/tmp/opencode-external-server-ab.ts`, `/tmp/opencode-external-client.ts` und
`/tmp/run-external-server-ab.ts` starten einen echten Bun-HTTP-Server und einen lesenden SSE-Client in getrennten
Prozessen. Nur der Server misst seine CPU. Der Kontrollserver emittiert dieselben 50 Events mit 200 ms Abstand,
hat aber keinen SSE-Abonnenten:

| Lauf | Server ohne SSE | Server mit externem SSE-Client | Differenz/10 s |
|---|---:|---:|---:|
| 1 | 0,760 s | 2,827 s | 2,067 s |
| 2 | 0,712 s | 2,780 s | 2,068 s |

Die praktisch identische Replikation weist rund 20,7 zusätzliche CPU-Prozentpunkte eindeutig dem Serverprozess
zu. Client-Parsing, TUI-Rendering und gemeinsamer Heap sind in dieser Differenz ausgeschlossen. Damit erklärt der
Zustellpfad bereits einen wesentlichen Teil der live gemessenen 20–40 % Server-CPU; vorgelagerte Modell-, Tool-
und Workerarbeit kommt noch hinzu.

Die Stufenintervention zeigt, dass sich die Last über Queue-Wakeup, Stream/SSE-Encoding und HTTP-Schreiben
verteilt; sie ist nicht allein `JSON.stringify` und auch nicht allein der Testleser.

Ein CPU-Profil desselben gepaceten Ablaufs bestätigt die Codekette. `releaseTakers` aus Effect `Queue.js:1444-1455`
hatte 667,5 ms Self-Time und 1,59 s inklusive Zeit und war ein Top-Hotspot. Im Code plant
`scheduleReleaseTaker()` über `dispatcher.scheduleTask()` genau den Wakeup, sobald ein wartender Taker vorhanden
ist. Nach dem Drainen wartet der Stream erneut, sodass das nächste 200-ms-Event dieselbe Kette wieder startet.

Vor der abschließenden Voll-GC zeigte der vollständige Arm rund 27 MB zusätzliche Heap-Kapazität. Danach blieb in
allen gemessenen Armen kein positives Heap- oder Objektwachstum gegenüber dem Startpunkt: Der Test weist hohen
temporären Allokations- und GC-Durchsatz nach, aber kein Retentionswachstum in diesem Messfenster.

Bewiesen ist der Pfad ab `GlobalBus` bis zur SSE-/HTTP-Zustellung. Worker-JSON-Parsing und vorgelagerte
Session-/Modellarbeit liegen außerhalb dieses A/B und kommen zur realen Serverlast zusätzlich hinzu.

### Direkt belegt

- Etwa fünf Full-Frames pro Sekunde bleiben über mehrere Builds stabil.
- 84–94 % dieser Full-Frames werden durch `layoutDirty` erzwungen.
- Die Full-Frame-Frequenz entspricht dem 200-ms-Delta-Takt des AI-Workers.
- `startHighlight()` ruft nach akzeptiertem Ergebnis `updateTextInfo()` mit `layoutChanged=true` auf.
- Dirty Yoga verhindert den Partial-Pfad zwingend und führt im isolierten Test zum Full-Root-Render.
- Eine Intervention ausschließlich an diesem argumentlosen Aufruf entfernt den Full-Root-Render.
- Der Prose-Fast-Path verarbeitet bei jedem Append den vollständigen aktuellen Paragraphen mit `lexInline`.
- Full-value-Lexing verursacht im isolierten A/B 33,8x die CPU der Delta-Kontrolle und überschreitet reproduzierbar
  eine rund 29,6-MB-Allokationsschwelle.
- Der durch die argumentlose Highlight-Callsite erzwungene Full-Render verursacht unter nichttrivialer Baumlast
  88,1 % mehr CPU und wesentlich mehr Heap-Kapazität als die gezielte Layout-Kontrolle.
- Der Partial-Pfad kopiert den vollständigen committed Framebuffer.
- Der vorhandene Same-line-Test wartet nicht auf das Highlighting.
- Die JSC-HeapHelper tragen während realer Streams erheblich zur Prozesslast bei.
- Der reale `GlobalBus -> Queue -> JSON/SSE -> HTTP`-Pfad verursacht bei fünf getrennten Events pro Sekunde im
  externen Zwei-Prozess-A/B reproduzierbar rund 20,7 zusätzliche CPU-Prozentpunkte im Server und starken
  temporären GC-Durchsatz.

### Sehr starke Schlussfolgerung

Der asynchrone Highlight-Abschluss ist als Erzeuger von dirty Yoga und des anschließenden Full-Root-Renders
kausal bewiesen. Noch nicht direkt gezählt ist, welcher exakte Anteil der 269–420 beobachteten `layoutDirty`-Bails
aus genau dieser Callsite stammt. Frequenz, Kontrollfluss und Interventionsbeweis sprechen dafür, dass sie den
Großteil stellt; ein Callsite-Counter muss diese Mengenbeziehung noch exakt schließen.

### Noch separat zu quantifizieren

- Wie viele Layout-Bails bleiben durch echte Zeilenumbrüche, Wraps oder neue Toolblöcke übrig?
- Wie viel CPU und GC verursacht verworfenes, bereits gestartetes Tree-sitter-Highlighting?
- Wie viel bringt ein nativer Append-Pfad gegenüber `setStyledText()`?
- Wie groß ist der Restgewinn eines Dirty-Rectangle-Presents ohne Full-Buffer-Restore?
- Welcher Anteil der verbleibenden Serverlast kommt zusätzlich aus Worker-Parsing, Modell-/Tool-Orchestrierung,
  Projekt-/Watcherarbeit oder anderen Effect-Flows?

## Implementierter Fix und Gegenmessung

Die folgenden Änderungen sind lokal umgesetzt, als `1.18.1-patched.58` gebaut und unter
`~/.opencode/bin/opencode` installiert. Bereits vor der Installation laufende Prozesse behalten ihren alten
geladenen Binary-Inode und müssen für die Gegenmessung neu gestartet werden.

### 1. Asynchrones Highlighting bleibt dimensionssensitiv

`CodeRenderable` verwendet nun nach synchronen und asynchronen TextBuffer-Änderungen denselben
`updateTextInfoAfterBufferChange(scrollWidth, scrollHeight)`-Pfad. Yoga wird nur dirty, wenn sich eine
Auto-Breite oder Auto-Höhe tatsächlich geändert hat. Das gilt für erfolgreiches Highlighting und den
Fehler-Fallback im Streamingmodus. Nicht-streamende Codeblöcke behalten ihre bisherige vollständige
Invalidierung, weil gekoppelte Renderables wie Diff-Gutters auch bei festen `100%`-Dimensionen neu messen müssen;
ein bestehender Diff-Wrapping-Regressionstest sichert diese Grenze ab.

Der bestehende Same-line-Test startet jetzt echtes asynchrones Highlighting, löst das Mock-Ergebnis auf, wartet
auf `highlightingDone` und prüft erst danach den Layoutzustand. Ein zweiter Test verändert den Text über
`onChunks` tatsächlich um eine Zeile und beweist, dass eine reale Dimensionsänderung weiterhin dirty markiert.

Der identische 100-Knoten-A/B mit 400 Updates konvergiert nach dem Fix:

| Arm | mediane CPU vorher | mediane CPU nachher | zusätzliche Heap-Kapazität nachher | Allokations-GC nachher |
|---|---:|---:|---:|---:|
| Produktionsklasse | 2.438 ms | 1.722 ms | 7,26 MB | 0/3 |
| Layout-Kontrolle | 1.296 ms | 1.667 ms | 7,26 MB | 0/3 |

Der vorherige Abstand von 88,1 % sinkt auf rund 3,3 % Messrauschen; die zuvor 5,37x auseinanderliegende
Heap-Kapazität ist praktisch identisch. Damit ist nicht nur die Regression beseitigt, sondern derselbe kausale
A/B, der sie nachgewiesen hat, nach dem Fix geschlossen.

### 2. Plain-Prose-Appends lexieren nicht mehr den Gesamtabsatz

Wenn der aktive Absatz genau ein bereits lexiertes Text-Inline-Token enthält und das Delta ausschließlich aus
Unicode-Buchstaben, Ziffern oder Leerzeichen besteht, erweitert der Parser dieses Token direkt. Sobald das Delta
ein Markdown-Metazeichen enthält, bleibt der konservative vollständige `Lexer.lexInline`-Fallback erhalten.

Zwei Regressionstests vergleichen beide Pfade mit dem vollständigen Marked-Ergebnis: Plain Prose erzeugt keinen
neuen `lexInline`-Aufruf, ` **bold**` dagegen weiterhin exakt einen. Der frühere 5.000-Update-A/B ergibt:

| Produktionsparser | mediane CPU | Allokations-GC bei ~29,6 MB |
|---|---:|---:|
| vorher | 4.515 ms | 3/3 Läufen |
| nachher | 129 ms | 0/3 Läufen |

Das sind rund 97,1 % weniger CPU für diesen bewiesenen Plain-Prose-Hotpath. Komplexe Markdown-Deltas bleiben aus
Korrektheitsgründen im bisherigen Lexerpfad.

### 3. Private lokale TUI-Events umgehen SSE

Der untersuchte Stand `recovered-45` startet die TUI-Backendlogik in einem separaten Prozess. Dieser Prozess
hatte für Steuerbefehle bereits einen bidirektionalen Bun-IPC-Kanal, leitete lokale Global Events aber trotzdem
über den öffentlichen HTTP-/SSE-Pfad zurück zur TUI.

Private lokale TUI-Server senden `GlobalBus`-Events nun über denselben IPC-Kanal. `startTuiServerProcess()` stellt
daraus ein `EventSource` für `SDKProvider` bereit; dadurch startet die lokale TUI keine `/global/event`-SSE-
Verbindung. Bei explizitem `--port`, `--hostname` oder mDNS bleibt `events` undefiniert und der öffentliche
SSE-Transport unverändert.

Der Integrationstest startet den echten privaten Kindprozess, abonniert dessen IPC-EventSource, löst über
`POST /global/dispose` ein reales `global.disposed`-Event aus und empfängt es im Elternprozess. Ein isolierter
200-ms-IPC-A/B stellte in 2/2 Läufen alle 50 Events zu und zeigte gegenüber `emit-only` keinen messbaren
Serverkind-CPU-Aufschlag. Der zuvor getrennt gemessene externe SSE-Pfad kostete unter identischem Takt dagegen in
2/2 Läufen jeweils rund 2,07 s zusätzliche Server-CPU pro zehn Sekunden.

Damit wird der teure SSE-Wakeup-Pfad für den normalen lokalen TUI-Fall vollständig umgangen. Externe Clients
benötigen weiterhin eine gesonderte SSE-Optimierung.

Der Build folgte dem bestehenden lokalen Verfahren: OpenTUI-`build:lib`, Spiegelung des `dist`-Verzeichnisses in
die exakte Bun-Store-Abhängigkeit des `recovered-45`-Worktrees und OpenCode-Build mit `--single --skip-install
--skip-embed-web-ui`. Build-Smoke-Test und installiertes Binary melden beide `1.18.1-patched.58`.

### 4. Live-Idle-Baseline des installierten `.58`-Builds

Am 17. Juli 2026 wurde eine nach der Installation gestartete TUI mit Session
`ses_0937de930ffeyOKT34cnOyKboi` im Idle gemessen. Der Elternprozess `1928565` und der private Serverprozess
`1928600` verwenden beide den aktuellen, nicht als gelöscht markierten Binary-Inode. Die Umgebung des
Serverkinds enthält nachweislich `"ipcEvents":true`; bei vier bereits laufenden `.57`-Serverkindern fehlt dieses
Feld und deren Binary-Inodes sind nach der Installation als gelöscht markiert.

Auch der Laufzeittransport entspricht dem neuen Codepfad: Der letzte alte SSE-Client wurde um
`12:22:14Z` als `global event disconnected` protokolliert, der `.58`-Server begann um `12:22:18Z`, und danach
erschien für ihn kein `global event connected`. Damit ist der IPC-Bypass nicht nur im Integrationstest, sondern
auch im installierten Prozess belegt.

Vier aufeinanderfolgende Fünf-Sekunden-Deltas nach dem Warm-up ergaben für TUI und Server zusammen
`12,98 %`, `10,33 %`, `10,20 %` und `8,67 %` eines CPU-Kerns, im Mittel also `10,55 %`. Ein anschließender
gleichzeitiger Vergleich mit drei alten, idle `.57`-Prozesspaaren ergab über je drei weitere Intervalle:

| Build/Prozesspaar | kombinierte CPU je Intervall | Mittelwert |
|---|---:|---:|
| `.57` A | 14,13 % / 8,43 % / 12,18 % | 11,58 % |
| `.57` B | 9,61 % / 15,49 % / 13,94 % | 13,01 % |
| `.57` C | 14,72 % / 8,43 % / 18,07 % | 13,74 % |
| `.58` | 12,16 % / 9,41 % / 13,55 % | 11,71 % |

Der Durchschnitt aller neun `.57`-Intervalle liegt bei `12,78 %`. `.58` ist im Idle damit nicht lastfrei und
nur rund 1,1 Prozentpunkte niedriger. Wegen der großen natürlichen Streuung ist das kein belastbarer Nachweis
einer allgemeinen Idle-Verbesserung; es zeigt vor allem, dass die Streaming-Intervention nicht fälschlich als
Idle-Fix bewertet werden darf.

Ein zehnsekündiges Thread-Sample ordnete den größten Idle-Anteil dem TUI-Hauptthread (`3,21 %`) und seinen
sieben JSC-`HeapHelper`-Threads (zusammen `2,82 %`) zu. Der Serverhauptthread lag im selben Fenster bei
`0,65 %`; weitere kleine Anteile verteilten sich dort auf JSC- und Watcherthreads. Native Stack-Samples eines
bereits laufenden Prozesses waren auf diesem Host nicht möglich: `perf_event_paranoid=4` blockiert `perf`, und
`ptrace` blockiert das Anhängen von `strace`. Für den entscheidenden Vergleich bleibt deshalb der deterministische
Replay-A/B maßgeblich; zusätzlich muss dieselbe `.58`-Session während eines realen Streams als
End-to-End-Gegenmessung erfasst werden.

### 5. Live-Stream-Gegenmessung von `.58`

Dieselbe Session wurde anschließend während eines realen, fünf Provider-Turns und mehrere Toolaufrufe
umfassenden Laufs gemessen. Der Lauf ist wegen Git- und Worktree-Kommandos kein reiner Text-Replay, trennt aber
die sichtbaren Spitzen klar von der Idle-Baseline.

Der erste Block aus fünf Zwei-Sekunden-Intervallen ergab für TUI und Server zusammen `122,70 %`, `118,77 %`,
`286,36 %`, `163,64 %` und `27,82 %`, im Mittel `143,86 %`. Ein zweiter Block aus zehn Ein-Sekunden-Intervallen
lag im Mittel bei `75,08 %`; dessen letzte drei Intervalle erreichten erneut `222,2 %`, `192,0 %` und `123,4 %`.
Der zweite Peak folgte unmittelbar auf den um `12:27:05Z` gestarteten Provider-Turn. Die kurz zuvor um
`12:27:02Z` ausgeführte Worktree-Umbenennung ist ein Störfaktor für benachbarte Serverarbeit, erklärt aber nicht
die wiederkehrenden Peaks nach weiteren Provider-Turns.

Im zweiten Zehn-Sekunden-Fenster entfielen `29,02 %` auf den Serverhauptthread und zusammen `18,27 %` auf seine
sieben aktiven `HeapHelper`; beim TUI waren es `14,63 %` Hauptthread und zusammen `9,36 %` `HeapHelper`. Der
kurzlebige AI-Worker war in diesen Summen nicht enthalten, die Prozesspaare bilden also eine Untergrenze. Nach
`exiting loop` fiel dieselbe Instanz wieder auf fünf Ein-Sekunden-Werte zwischen `8,7 %` und `10,7 %` kombiniert.

Damit widerlegt die Live-Messung eine zu starke Schlussfolgerung aus den isolierten Fix-A/Bs: `.58` beseitigt
die dort jeweils bewiesenen Teilursachen, aber noch nicht die reale End-to-End-Spitze. Der verbleibende Anteil
sitzt vor allem in Hauptthread- und GC-Arbeit von TUI und Server und muss mit einem neuen signalgesteuerten
CPU-Profil dieses Builds weiter zerlegt werden.

### 6. Zusätzlich geschlossener Tree-sitter-Queue-Pfad

Die Live-Analyse fand einen weiteren eigenständigen Verschwendungsweg im OpenTUI-`CodeRenderable`, der unter
anderem für aufgeklapptes Reasoning verwendet wird:

1. `ReasoningPart` übergibt den bei jedem Delta wachsenden vollständigen Markdown-Body an einen streamenden
   `CodeRenderable`.
2. Jede gerenderte Inhaltsänderung startete `highlightOnce(content, filetype)`, auch wenn das vorige Highlight
   noch nicht beendet war.
3. `TreeSitterClient.highlightOnce()` sendet für jeden Aufruf den vollständigen Inhalt als
   `ONESHOT_HIGHLIGHT` an den Worker.
4. Der Worker arbeitet die Nachrichten seriell mit `await handleOneShotHighlight(...)` ab und ruft für jede
   Nachricht `parser.parse(parseContent)` auf. Es gibt in diesem Pfad keine Stornierung veralteter Requests.
5. `CodeRenderable` verwarf ein veraltetes Ergebnis erst nach dem vollständigen Parse anhand der Snapshot-ID.

Ein neuer Regressionstest hielt das erste Highlight absichtlich offen und führte zwei weitere Streaming-
Updates mit jeweils einem Render aus. Im unveränderten Code schlug die Erwartung fehl: statt eines laufenden
Requests waren **drei** vollständige Highlights gestartet. Nach der Änderung bleibt im Streamingmodus genau ein
Highlight aktiv; wenn es veraltet endet, wird einmal der dann neueste Inhalt verarbeitet. Der bestehende
Nicht-Streaming-Test mit einem absichtlich nie auflösenden Highlight bleibt unverändert funktionsfähig.

Die kombinierte Code-/Markdown-Suite steht nach der Änderung bei `89 pass`, `1 skip`, `0 fail`; Format- und
Lintprüfung der geänderten Dateien sind sauber. Der kausale Queue-Fehler ist damit am Produktionscode und durch
eine unabhängige Lifecycle-Grenze bewiesen. Er erklärt die Live-Spitze jedoch nicht allein: Der Tree-sitter-
Worker belegte im gemischten Zehn-Sekunden-Sample nur `0,50 %`. Die Änderung verhindert reale, unnötige Arbeit,
ist aber ausdrücklich kein Ersatz für das noch fehlende aktuelle Hauptthread-/GC-Profil.

OpenTUI wurde mit dieser Änderung neu gebaut und in die exakte Abhängigkeit des `working`-Worktrees gespiegelt.
Der anschließende OpenCode-Build-Smoke-Test war erfolgreich; `1.18.1-patched.59` ist installiert. Die laufende
`.58`-Session behält erwartungsgemäß ihren nun als gelöscht markierten alten Binary-Inode.

### 7. Signalgesteuertes Live-Profil von `.59`

Ein neuer Lauf derselben Session wurde mit `OPENCODE_CPU_PROFILE` gestartet. Der ausgewertete Provider-Turn lief
von `12:42:44.646Z` bis `12:43:15.663Z`; die Profile decken den Abschnitt ab `12:43:03Z` einschließlich
`step-finish` ab. In den ersten zehn gemessenen Ein-Sekunden-Intervallen lagen TUI und Server im Mittel jeweils
bei rund `39 %`; zusammen mit dem kurzlebigen AI-Worker lag die beobachtete Summe im Mittel bei `92 %`. Einzelne
Intervalle erreichten `196 %` beziehungsweise `181 %`.

Das TUI-Profil mit 854 Mainthread-Samples weist die verbleibenden Kosten klar zu:

| TUI-Selfpfad | Samples | Anteil |
|---|---:|---:|
| `renderPartialFrame → drawFrameBuffer` | 108 | 12,6 % |
| nativer Root-`render` | 75 | 8,8 % |
| `yogaNodeCalculateLayout` | 69 | 8,1 % |
| Spinner `_advanceFrame → requestRender` | 42 | 4,9 % |
| Marked-Blocklexer, `lheading`-RegEx | 31 | 3,6 % |
| `requestPartialRender` selbst | 7 | 0,8 % |

Damit ist eine weitere wichtige Grenze bewiesen: Der Spinner läuft mit `interval={80}`, also etwa 12,5 Bildern
pro Sekunde, und gelangt korrekt in den Partial-Pfad. `renderPartialFrame()` muss vor jedem solchen Bild dennoch
den **kompletten** `currentRenderBuffer` über `drawFrameBuffer()` in den nach dem Present geleerten
`nextRenderBuffer` kopieren. Partial-Render spart deshalb den Root-Walk, aber noch nicht die O(Bildschirmfläche)-
Bufferkopie. Der aktuelle TUI-Rest ist überwiegend Draw/Layout und nicht mehr der zuvor geschlossene
Tree-sitter-Queue-Pfad.

Das Serverprofil zeigt eine andere zeitliche Form. Während der laufenden Deltas lagen die Samples relativ
gleichmäßig im Effect-Scheduler. Fast die gesamte extreme Spitze fällt in die letzten drei Profilsekunden:

- `snapshot.track()` meldete den fertigen Hash um `12:43:14.759Z`;
- der Provider-Turn endete um `12:43:15.663Z`;
- in genau diesem Fenster stieg der Server auf `135 %` und `119 %`;
- das Profil zeigt dort konzentriert `cloneObject` (95 Self-Samples), Effect-Auswertung, Child-Process-Spawns,
  JSON, HTTP-Response- und zlib-Arbeit.

Die externen Git-Kommandos des bereits synchronen Snapshot-Repositories erklären die Spitze allein nicht:
`diff-files`, `ls-files --others` und `write-tree` fanden keine Änderungen und benötigten bei direkter
Gegenmessung zusammen nur rund 0,17 Sekunden Wall-Time. Die teure Restarbeit liegt damit im umgebenden
`step-finish`-/Effect-/Clone-/Response-Pfad. Weil der produktive `.59`-Build minifiziert ist, endet der heißeste
Serverstack noch in anonymisierten Bundlefunktionen. Derselbe Stand wurde deshalb zusätzlich unminifiziert mit
Sourcemaps als `1.18.1-patched.60-profile` gebaut, per Smoke-Test geprüft und installiert; ein weiterer kurzer
Provider-Turn muss die letzte User-Callsite auflösen.

### 8. Entminifiziertes Live-Profil von `.60-profile`

Der anschließende Lauf derselben Session (`ses_0937de930ffeyOKT34cnOyKboi`) löst beide verbleibenden Pfade bis
zur Produktions-Callsite auf. Das TUI-Profil enthält 1.102 Mainthread-Samples über rund 13,5 Sekunden:

| TUI-Selfpfad | Samples | Anteil |
|---|---:|---:|
| `loop → renderPartialFrame → drawFrameBuffer` | 216 | 19,6 % |
| nativer `render` | 124 | 11,3 % |
| OpenTUI-`loop` | 55 | 5,0 % |
| Spinner-`tick` | 46 | 4,2 % |
| `markDirty` | 40 | 3,6 % |
| `isDestroyed` | 36 | 3,3 % |
| `yogaNodeCalculateLayout` | 30 | 2,7 % |

`requestRender` und `requestPartialRender` selbst belegen nur zehn beziehungsweise acht Samples. Der vollständige
Stack beweist damit, dass nicht die Darstellung eines einzelnen Spinnerzeichens teuer ist: Jeder Partial Frame
kopiert zunächst den gesamten `currentRenderBuffer` in `nextRenderBuffer`. Danach läuft
`prepareRenderFrameWithWriter()` in Zig weiterhin über `width × height` Zellen und leert am Ende wieder den
gesamten `nextRenderBuffer`. Dieser Clear erzwingt die Vollkopie im nächsten Partial Frame. Eine Reduktion des
Spinnerintervalls würde nur die Häufigkeit dieses Fehlers senken und wurde ausdrücklich nicht als Fix übernommen;
das Intervall bleibt bei 80 ms.

Das entminifizierte Serverprofil enthält 1.858 Samples über rund 13,7 Sekunden. Die bislang anonyme
`cloneObject`-Spitze ist jetzt exakt:

`cross-spawn-spawner.ts:364 → env() in Zeile 109 → cloneObject`

`cloneObject` belegt 162 Self-Samples; `normalizeSpawnArguments` weitere 45. Daneben erscheinen `toLLMEvents`
mit 36, Queue-Finalisierung mit 33, `makeFileInfo` mit 33 und `snapshot/index.ts:172` mit 29 Samples. Der Peak
liegt wiederum am Turnende: `snapshot.track()` endete um `12:51:06.028Z`, der nächste Loop-Schritt begann um
`12:51:07.125Z`; in den stärksten Intervallen lagen TUI und Server bei `137,6 % / 122,5 %`, danach der Server bei
`127,8 %` und `138,1 %`. Die direkten Git-Kommandos bleiben schnell. Teuer ist die wiederholte Vorbereitung der
Spawns: `extendEnv: true` kopierte selbst ohne ein einziges Env-Override für jeden Git-Subprozess das vollständige
`process.env`-Objekt. Zusätzlich ermittelte `snapshot.sync()` den unveränderlichen Git-Exclude-Pfad wiederholt neu
und schrieb identischen Inhalt erneut.

### 9. Strukturelle Korrekturen nach dem `.60`-Profil

Der OpenTUI-Present-Pfad wurde ohne Taktreduktion umgebaut:

- Full Frames leeren den Arbeitsbuffer vor dem Root-Render und committen ihn anschließend als persistenten
  Ausgangszustand.
- Partial Frames überschreiben nur ihre Renderable-Fläche; die bildschirmgroße
  `drawFrameBuffer(current → next)`-Kopie entfällt vollständig.
- TypeScript bildet aus den Partial-Renderables ein begrenztes Dirty-Rechteck. Links und rechts wird je eine
  Zelle für Wide-Character-Start-/Continuation-Zellen ergänzt.
- Der direkte Partial-Aufruf rekonstruiert die Ancestor-Opacity und alle Scroll-/Overflow-Scissors des normalen
  Root-Passes; das Dirty-Rechteck wird auf die tatsächlich sichtbare Schnittmenge begrenzt.
- Zig diffed bei Partial Frames ausschließlich dieses Rechteck. Force-Repaints, Palettewechsel und das native
  Debug-Overlay fallen konservativ auf den Full Diff zurück.
- Ein Partial Frame übernimmt kein nur teilweise aufgebautes Mouse-Hit-Grid. Das bestehende vollständige Grid
  bleibt aktiv; der temporäre Next-Grid wird verworfen.
- Die bisherige direkte Native-`render()`-Semantik bleibt erhalten und leert weiterhin ihren Arbeitsbuffer. Nur
  der TypeScript-Renderer verwendet explizit den retained Commit, damit CJK-Graphem-Spans externer Native-Caller
  nicht regressieren.

Der unabhängige Native-Test verändert zwei Zellen, ruft für eine davon `renderPartial(..., 1, 1)` auf und prüft
die echten Renderstatistiken: Im Partial Commit wird exakt eine Zelle aktualisiert; die zweite bleibt pending und
wird erst vom folgenden Full Diff aktualisiert. Ein weiterer Full Diff ist danach ein No-op. Der TypeScript-Test
beweist zusätzlich, dass `renderPartialFrame()` keine Full-Buffer-Kopie mehr aufruft und das erwartete begrenzte
Rechteck liefert. Ein verschachtelter Renderable-Test beweist zusätzlich die Wiederherstellung von Opacity und
Scissor samt sichtbarer Schnittmenge. Ergebnis: 92/92 betroffene Renderable-/Renderer-Tests und 1.679/1.679
aktive Zig-Tests bestanden; drei Zig-Tests sind projektspezifisch übersprungen.

Serverseitig vermeidet `cross-spawn-spawner` den Env-Clone jetzt, wenn keine Overrides vorliegen; `env: undefined`
lässt den Child Process das Parent-Environment nativ erben. `snapshot` cached den invarianten Exclude-Dateipfad
pro Instanz und überspringt identische Exclude-Schreibvorgänge, liest die reale Datei aber weiterhin vor jedem
Vergleich. Die Cross-Spawn-Suite besteht mit 25/25 Tests; die isolierten Snapshot-No-change- und
Exclude-change-Fälle sowie `bun typecheck` in `packages/core`, `packages/opencode` und `packages/tui` sind grün.

OpenTUI-Library und native Release-Library wurden in die exakte Bun-Store-Abhängigkeit des `working`-Worktrees
gespiegelt. Der daraus erstellte unminifizierte Build `1.18.1-patched.61-profile` bestand den Smoke-Test und ist
installiert. Die laufende `.60`-Session behält ihren gelöschten alten Inode; eine neue `.61`-Session ist für den
abschließenden Live-A/B erforderlich.

### 10. Erste Live-Gegenmessung von `.61-profile`

Die neu gestartete TUI (`2031555`) und ihr Serverkind (`2031586`) verwenden beide nachweislich den installierten
`.61`-Inode `50107811`; die wiederaufgenommene Session ist erneut `ses_0937de930ffeyOKT34cnOyKboi`. In den ersten
15 Ein-Sekunden-Intervallen lag das Prozesspaar im Mittel bei `32,3 %`, meist zwischen `11 %` und `55 %`, mit
einem Maximum von `81 %`. Das ist deutlich unter der `.60`-Spitze von rund `260 %` für TUI und Server zusammen,
ist wegen unterschiedlicher Providerabschnitte aber noch kein kontrolliertes Gesamt-A/B.

Das anschließend signalisierte Profil über rund zwölf Sekunden bestätigt die gezielten Interventionen direkt:

- TUI: nur 237 Mainthread-Samples statt 1.102 im `.60`-Fenster; kein einziges Sample mehr in der entfernten
  `drawFrameBuffer(current → next)`-Vollkopie. Der native `renderPartial` belegt neun, `renderRetained` acht
  Samples. In `.60` belegten Full-Buffer-Copy und nativer Full-Screen-Render zusammen 340 Samples.
- Server: `cloneObject` fällt von 162 auf null Samples, `normalizeSpawnArguments` von 45 auf zwei. Der
  Snapshot-Code und Cross-Spawn erscheinen nur noch vereinzelt in den direkten Match-Zählern.

Das Prozesspaar erreichte im Profilfenster dennoch kurz `197 %`, davon `116 %` im Server. Dieser Peak gehört
nicht mehr zum entfernten UI-Present- oder Env-Clone-Pfad. Das Server-Calltree zeigt jetzt vor allem
Effect-Kontext-/Queue-Auswertung, Snapshot-`track()`-Orchestrierung und echte Child-Process-Spawns sowie
Provider-Message-Normalisierung. Um `13:35:56Z` begann ein weiterer Step mit Snapshot-Track und Providerstart.
Um `13:36:05Z` löste das Stoppen des TUI-Profils selbst ein globales Dispose und damit `Aborted` aus: `SIGUSR2`
ist im Diagnose-Bootstrap als Profiler-Stop belegt, wird in `cli/cmd/tui.ts` aber gleichzeitig als Reload-Signal
registriert. Anschließend bootete die Location erneut. Dieses Fenster ist deshalb als vollständiger
Turn-End-to-End-Vergleich nicht sauber; die Profil-Daten vor dem Stop bleiben gültig. Nach dem Abbruch lagen fünf
Sekunden Thread-Sampling bei `7,2 %` für die TUI und `1,6 %` für den Server. Für die Bewertung der verbleibenden
kurzen Server-/GC-Spitze ist ein weiterer nicht abgebrochener Provider-Turn ohne TUI-`SIGUSR2` erforderlich.

### 11. Sauberer `.61`-Turn und verbleibende Step-Grenze

Der folgende Turn lief ohne Signale oder Reload durch fünf Provider-Steps. Während normaler Provider-Streams
lag die vollständige Kette aus TUI, Server und aktivem AI-Worker über 25 aufeinanderfolgende Sekunden zwischen
`16 %` und `39 %`; ein späteres Idle-Fenster lag zwischen `3 %` und `11 %`. Der frühere permanente
Full-Buffer-/Full-Diff-Hotpath ist damit auch im ungestörten Lauf nicht mehr sichtbar.

Zwei andere, zeitlich getrennte Spitzen bleiben:

1. Ein reiner TUI-Burst erreichte für vier Sekunden `80–119 %`, während Server und AI-Worker niedrig blieben.
   Er liegt innerhalb eines langen Text-/Reasoning-Streams und muss mit dem nun profiler-sicheren Build separat
   aufgezeichnet werden. Er ist nicht die entfernte Bufferkopie; deren Symbol fehlt in allen `.61`-Profilen.
2. Step-/Tool-Wechsel erreichten erneut `218–230 %`. Thread-Deltas weisen dabei sowohl im TUI- als auch im
   Serverprozess ungefähr die Hälfte dem Mainthread und einen großen weiteren Anteil JSC-`HeapHelper`n zu.

Das 165,6-sekündige Serverprofil ordnet die Step-Grenze exakt zu. Die stärksten Profilsekunden enthalten 351 bis
477 Mainthread-Samples. Sichtbar sind Effect-Queue-/Kontextarbeit, `makeFileInfo`, echte `spawn`-/
`normalizeSpawnArguments`-Aufrufe, Provider-Normalisierung und Snapshot-Orchestrierung. Der entfernte
Env-`cloneObject`-Pfad erscheint im gesamten langen Profil nur noch einmal statt 162-mal im kurzen `.60`-Profil.

Die Logs beweisen außerdem vier redundante Snapshot-Paare. Nach jedem Tool-Step wird der fertige Hash erzeugt
und 0,4 bis 0,9 Sekunden später vor dem nächsten Provider mit identischem Hash erneut vollständig aufgenommen:

- `13:41:25.084Z` / `13:41:25.754Z`
- `13:41:47.466Z` / `13:41:48.174Z`
- `13:43:22.547Z` / `13:43:23.436Z`
- `13:43:43.587Z` / `13:43:44.342Z`

Der abgeschlossene Step-Snapshot wird deshalb jetzt explizit als Pre-Tool-Snapshot an den unmittelbar folgenden
Processor weitergereicht. Subtask-, Compaction- und Overflow-Grenzen verwerfen ihn konservativ. Damit bleibt die
wichtige Regel erhalten, dass ein Snapshot vor möglicher interner Tool-Ausführung existiert, ohne denselben
Workspacezustand direkt nochmals zu scannen. Der verschachtelte `Effect.gen`-Trace im heißen `track()`-Lock wurde
zusätzlich durch eine benannte ungetracete Lock-Grenze ersetzt.

Die vollständige Snapshot-Suite steht bei 56 aktiven Tests grün und einem projektspezifisch übersprungenen Test;
der reale Instant-Tool-Race-Test bestätigt weiterhin einen nichtleeren Session-Diff. Weitere 53 aktive
Compaction-/Usage-Tests sind grün, und `bun typecheck` in `packages/opencode` besteht vollständig. Der
Profiler-Stop/Reload-Signalkonflikt ist ebenfalls getrennt: Im Profilmodus registriert die TUI keinen zweiten
`SIGUSR2`-Reloadhandler mehr. Der finale Diagnosebuild `1.18.1-patched.62-profile` ist gebaut, per Smoke-Test
geprüft und installiert.

### 12. Sauberes `.62`-Profil: Textstream, Tool-Expansion und doppelter Runtime-Boot

Der profiler-sichere `.62`-Turn lief regulär bis zum Ende. Die Profile umfassen 64,9 Sekunden TUI und 64,4
Sekunden Server. Damit lassen sich die zuvor vermischten Kosten erstmals sauber trennen:

- Während des normalen Provider-Textstreams bleibt die TUI überwiegend im einstelligen bis niedrigen
  zweistelligen Samplebereich pro Sekunde. Der frühere permanente Full-Buffer-Copy-Pfad ist weiterhin nicht
  zurückgekehrt.
- Am ersten Tool-/Step-Übergang fallen in derselben Profilsekunde 267 TUI- und 518 Server-Samples an; am finalen
  Übergang sind es 101 beziehungsweise 355. Die hohe Restlast ist damit eine Boundary-Spitze und keine
  unvermeidliche Dauerlast der Textdarstellung.
- Die Snapshot-Weitergabe funktioniert live: Nach `tracking` um `18:54:18.360Z` startet Step 1 um
  `18:54:18.678Z` und der nächste Provider um `18:54:18.768Z`, ohne einen zweiten identischen Pre-Step-Track.

Der größte TUI-Peak ist bis zum konkreten Payload belegt. Der betroffene `write`-Toolpart ist 10.864 Byte groß;
10.448 Byte davon sind der vollständige Dateiinhalt. Obwohl keine Diagnose vorliegt, enthält die Metadata
`diagnostics: {}`. Die bisherige Bedingung `props.metadata.diagnostics !== undefined` wählt deshalb immer den
Blockpfad. Dieser baut die gesamte Datei als `CodeRenderable` auf und startet Syntax-Highlighting. Das Profil
zeigt exakt `flushDeltas -> Write -> CodeRenderable -> textBufferSetStyledText/tree-sitter -> Yoga/Layout`.
Der eigentliche Textpart dieses Steps enthält dagegen nur 85 Zeichen.

Die Bedingung prüft nun die bereits normalisierten und validierten Diagnosen und erzeugt den vollständigen
Codeblock nur, wenn für die geschriebene Datei mindestens eine echte Diagnose vorliegt. Ein fehlerfreier Write
bleibt eine kompakte Zeile. Damit entfällt für den aufgezeichneten Fall die komplette 10-KiB-Code-/Highlight-
Pipeline; Diagnosefälle behalten Inhalt, Zeilennummern und Fehlermeldungen.

Parallel beweisen die Startup-Logs einen zweiten Architekturfehler:

- `18:53:15.611Z`: erster Instance-Boot über den HTTP-Server;
- `18:53:16.921Z`: zweiter Boot derselben Directory über `checkUpgrade -> InstanceRuntime.load`;
- `18:54:16.027Z` und `18:54:17.878Z`: die beiden daraus entstandenen Snapshot-Cleanup-Schleifen führen
  jeweils `git gc --prune=7.days` aus.

Der Upgrade-Check und der Prozess-Server verwendeten damit neben dem aktiven HTTP-Servicegraph einen zweiten
vollständigen `AppRuntime` mit eigener Instance, Config, Plugin-, Watcher- und Snapshot-Lebensdauer. Der Fix lädt
die globale Autoupdate-Einstellung über den bereits laufenden Server und übergibt nur diesen Wert an den
Upgrade-Check. Reload disponiert den tatsächlich aktiven HTTP-InstanceStore; Shutdown schließt dessen Scope und
initialisiert keinen separaten Runtimegraphen mehr.

Die gezielten TUI-Prozesstests stehen bei 11/11, die Inline-Tool-/Layouttests bei 17/17, und beide betroffenen
Package-Typechecks sind grün. Im nächsten Live-Build müssen genau ein Instance-Boot, genau ein Cleanup-Timer und
das Ausbleiben des vollständigen Write-Codeblocks ohne Diagnosen bestätigt werden.

### 13. `.63`-Live-A/B

Der `.63-profile`-Turn wurde mit demselben Sessiontyp erneut vollständig erfasst. Das TUI-Profil umfasst 93,5
Sekunden, das Serverprofil 90,4 Sekunden. Startup und Cleanup bestätigen den Runtime-Fix:

- genau ein `creating instance` um `19:08:54.990Z`;
- kein zweiter Config-/Plugin-/Snapshot-Boot nach dem verzögerten Upgrade-Check;
- genau ein `cleanup prune=7.days` um `19:09:55.471Z`.

Im normalen Streamfenster vor Cleanup und Toolgrenze liegen die Mainthread-Profile im Mittel bei 17 TUI- und
20,8 Server-Samples pro Sekunde, entsprechend ungefähr 1,7 beziehungsweise 2,1 Prozent eines Kerns. Im langen
Idle-Fenster sinken sie auf 2,4 beziehungsweise 0,7 Samples pro Sekunde.

Der Write-Fall ist direkt vergleichbar: Der neue Toolpart enthält 11.782 Byte, davon 11.364 Byte Input. Trotzdem
fehlen am Write-Übergang `CodeRenderable`, `createMarkdownCodeRenderable` und `treeSitterToTextChunks`
vollständig. `textBufferSetStyledText` fällt dort von 20 auf ein einzelnes Sample. Der höchste TUI-Sekundenwert
sinkt gegenüber `.62` von 267 auf 132 Samples. Damit ist kausal bestätigt, dass die Diagnoseprüfung den
vollständigen Datei-/Highlightpfad tatsächlich entfernt und nicht nur zeitlich verschoben hat.

Die Server-Step-Grenze bleibt mit 520 gegenüber zuvor 518 Samples praktisch unverändert. Sie ist damit getrennt
vom TUI-Rendering und vom doppelten Cleanup. Das Profil ordnet sie vor allem der Aufnahme und Normalisierung der
nächsten Provider-Historie, SQLite-Projektion, Dateisystemarbeit und echten Child-Process-Übergängen zu.

Ein konkreter vermeidbarer Anteil ist `sanitizeSurrogates`: Der Code wendete einen komplexen Lookaround-Replace
auf jeden Text der vollständigen Historie an, auch wenn der String kein einziges UTF-16-Surrogate enthält. Im
Profil belegt der Regex 38 Samples. Ein unabhängiger Replay mit 12,5 KiB ASCII benötigt für 10.000 Durchläufe
9.961 ms im alten Pfad und 297 ms mit einem einfachen vorgeschalteten Surrogate-Test, bei identischem Verhalten
für ASCII, gültige Emoji-Paare und einzelne kaputte Surrogate. Dieser ASCII-Fast-Path ist umgesetzt; die gesamte
Provider-Transform-Suite steht bei 346/346 Tests.

Außerdem wechseln Text- und Reasoning-Markdown nach dem jeweiligen Abschluss jetzt aus dem Streamingmodus.
OpenTUI hält im Streamingmodus absichtlich die letzten Blöcke semantisch instabil; die bisherigen hart codierten
`streaming={true}` ließen auch abgeschlossene Nachrichten dauerhaft in diesem Zustand. Der Abschluss ist nun an
`message.time.completed` beziehungsweise `part.time.end` gebunden.

### 14. `.64`: korrigierte Prozessmessung, nativer Einzel-Ausreißer und doppeltes Effect-Batching

Der `.64-profile`-Turn wurde mit einer 156×66-Zellen-TUI vollständig erfasst. Das TUI-Profil umfasst 58,0
Sekunden und 487 Mainthread-Samples, das Serverprofil 54,8 Sekunden und 1.510 Samples. Die ergänzende
`/proc`-Messung summiert alle Threads der drei beteiligten Prozesse statt nur gleichnamige Threads. Im normalen
Stream liegt diese Summe meist zwischen 13 und 30 Prozent eines Kerns. Die großen verbleibenden Werte sind klar
an Tool-/Provider-Grenzen gebunden: 239 Prozent kurz am Write-Übergang und 162 Prozent am finalen Übergang über
TUI, Server und Worker zusammen; danach fällt der Lauf auf 2 bis 10 Prozent Idle-Summe zurück.

Der Surrogate-Fast-Path greift live. Der komplexe Lookaround-Regex fällt im gesamten Serverprofil von 38 auf vier
Samples und am vergleichbaren Write-Übergang von 38 auf drei. Die Server-Mainthread-Samples der zwei
Write-Sekunden sinken von 820 in `.63` auf 716 in `.64`; die entsprechenden TUI-Samples von 213 auf 180. Das
bestätigt die vorherige isolierte Gegenprobe, ohne zu behaupten, dass der Regex die gesamte Step-Grenze erklärt.

Im normalen Textstream existiert genau ein besonderer TUI-Frame: 43 aufeinanderfolgende Profiler-Samples liegen
zwischen 12,194479 und 12,241514 Sekunden ausschließlich im nativen
`renderPartial (libopentui-*.so)`-Aufruf. Der Frame dauert damit mindestens 47,035 ms. Im gesamten restlichen
Profil gibt es keinen zweiten solchen nativen Cluster. Markdown-Parsing, Tree-sitter, Yoga und Solid-Auswertung
sind während dieses Intervalls nicht auf dem Stack. Der Aufruf umfasst nativ sowohl Zell-Diff/ANSI-Erzeugung als
auch den auf Linux synchronen `stdout`-Write, weshalb das CPU-Profil diese beiden Anteile allein nicht trennt.

Eine unabhängige Native-Gegenprobe grenzt den Zellvergleich stark ein. Bei exakt 156×66 Zellen benötigt ein
Partial-Diff über die gesamte Fläche mit nur einer geänderten Zelle im Mittel 0,270 ms End-to-End, davon 255 µs
im nativen Renderteil. Selbst 10.296 tatsächlich geänderte Zellen brauchen mit Memory-Output im Mittel 0,719 ms,
davon 685 µs Render- und 25 µs Write-Zeit. Der 47-ms-Live-Ausreißer wird daher nicht durch die bloße Anzahl der
verglichenen Zellen erklärt. Noch offen ist die direkte Trennung zwischen realem TTY-Write/Backpressure und
einem einmaligen Force-/Palette-Repaint; `ptrace` ist auf dem Host gesperrt und wurde nicht umgangen.

Für die normale Serverlast zeigt `.64` einen anderen, wiederkehrenden und am Code beweisbaren Doppelpfad. Die
periodischen Profilspitzen enthalten den Effect-Stack `Stream.aggregateWithin -> Schedule -> Queue`. Der
AI-Worker bündelt angrenzende Text-/Reasoning-Deltas aber bereits vor IPC und sendet höchstens nach 200 ms ein
gebündeltes Delta. Der Server legte jedes dieser bereits gebündelten Events anschließend nochmals in
`Stream.groupedWithin(64, "16 millis")`. Dadurch entstanden eine zweite Queue, Schedule-Fiber und Timer, ohne
die Eventanzahl des Worker-Pfads weiter zu reduzieren.

Der Worker-Pfad überspringt diese zweite Gruppierung jetzt und führt nur noch die notwendige AISDK-zu-LLMEvent-
Normalisierung aus. Direkte, nicht isolierte Provider-Streams behalten `groupedWithin` und `coalesceDeltas`.
Damit wird kein Takt abgesenkt; eine redundante Scheduling-Schicht entfällt. Die Worker-/Coalescing-Suite steht
bei 7/7 Tests, und `bun typecheck` in `packages/opencode` ist grün. Ein erneutes Live-Profil muss zeigen, dass der
`aggregateWithin`-Stack im Server-Worker-Pfad tatsächlich verschwindet.

Der Profilbuild schreibt zusätzlich je tatsächlich abgeschlossenem TUI-Frame `cells`, `render_us` und
`stdout_us` in `<cpuprofile>.render.jsonl`. Diese Sonde wird ausschließlich bei gesetztem
`OPENCODE_CPU_PROFILE` aktiviert. Damit lässt sich ein erneuter langer Native-Frame ohne `ptrace` direkt in
Zell-Diff/ANSI-Erzeugung und synchronen TTY-Write aufteilen. Build `1.18.1-patched.65-profile` enthält beide
Änderungen, bestand den Binary-Smoke-Test und ist atomar installiert; bereits laufende `.64`-Prozesse verwenden
weiter ihren alten Inode.

**Messmodus ab `.65`: Energiesparmodus.** `powerprofilesctl get` meldet `power-saver`, alle 16 logischen CPUs
verwenden den Governor `powersave`. Absolute Laufzeiten und CPU-Prozentwerte dürfen deshalb nicht ungekennzeichnet
gegen die vorherigen `.64`-Werte verglichen werden. Der `.65`-Nachweis stützt sich zuerst auf verschwindende
Callstacks, Event-/Frameanzahl, geänderte Zellen und die Trennung `render_us`/`stdout_us`. Ein numerisches
Performance-A/B benötigt anschließend zwei Läufe im identischen Power-Profil.

### 15. `.65` im Energiesparmodus: Native-Pfad entlastet, zwei Animationen und Scroll-Poll bewiesen

Der `.65`-Lauf wurde im bestätigten `power-saver`-Profil mit TUI, Server und isoliertem AI-Worker gemessen. Das
TUI-Profil umfasst 50,1 Sekunden und 3.600 Mainthread-Samples, das Serverprofil 50,0 Sekunden und 1.269 Samples.
Der Worker beendete sich vor dem Stop-Signal; für ihn liegt deshalb nur die `/proc`-Zeitreihe vor.

Die neue Frame-Sonde trennt den zuvor unklaren Native-Aufruf eindeutig. In normalen Animationsframes mit einer
geänderten Zelle benötigt der native Renderteil im Mittel 35 µs und der synchrone `stdout`-Write 73 µs. Bei acht
beziehungsweise neun geänderten Zellen sind es 42/102 µs und 74/83 µs. Der beobachtete hohe TUI-Verbrauch liegt
damit vor `renderPartial`; weder Zell-Diff noch Terminal-Write erklären ihn. Selbst während 14 bis 20 Frames pro
Sekunde werden nur ungefähr 2 bis 6 KiB pro Sekunde an das Terminal geschrieben.

Das TUI-Profil benennt die regelmäßigen JS-Pfade:

- 819 Samples im globalen Spinner-Scheduler `tick`;
- 304 Samples im nativen `height`-Getter, davon 303 unter demselben root-level Timer-Callback;
- 210 `requestRender`-Samples direkt unter `_advanceFrame -> tick`;
- 371 Effect-Callbacks und 347 Scheduler-Drains;
- nur 63 Samples im eigentlichen nativen `renderPartial`-Aufruf.

Die Frame-Daten beweisen zwei gleichzeitig laufende Animationen: 253 Frames ändern genau eine Zelle, während
702 Frames acht oder neun Zellen ändern. Am Code entsprechen sie dem 80-ms-Inline-Spinner im offenen Reasoning-
Header und dem 100-ms-Knight-Rider-Spinner im globalen Promptstatus. Das ist eine separate mögliche
Optimierungsgrenze; die vorliegende Änderung senkt deren Takt nicht.

Der 150-ms-Scroll-Poll ist ebenfalls direkt bewiesen: In 50,1 Sekunden wären nominell rund 334 Aufrufe zu
erwarten; das Profil enthält 303 teure `scroll.height`-Samples exakt unter seinem Timer-Callback. Der Poll liest
auch ohne Scrollbewegung fortlaufend `scrollHeight`, `height` und `scrollTop`.

Der frühere Versuch, diesen Poll durch `verticalScrollbarOptions.onChange` zu ersetzen, konnte nicht
funktionieren: `ScrollBoxRenderable` nahm den User-Callback entgegen, überschrieb ihn im Konstruktor aber mit dem
internen Translate-/Sticky-Handler. Auch spätere Options-Updates konnten `_onChange` nicht aktualisieren. Dadurch
erreichte kein Scrollereignis die Window-/`loadOlder`-Logik; der anschließende Revert war korrekt, seine Ursache
aber bisher unbekannt.

OpenTUI verkettet den internen Handler und den User-Callback jetzt in dieser Reihenfolge und unterstützt dieselbe
Kette auch für reaktive Options-Updates. Ein Regressionstest bestätigt Position und bereits angewendetes
`translateY` sowohl beim Konstruktor- als auch beim Setter-Callback. Darauf aufbauend verwendet die TUI wieder
echte Scrolländerungen für Expand, `loadOlder` und Shrink und entfernt den periodischen Timer vollständig.
55/55 betroffene OpenTUI-Tests, 17/17 TUI-Inline-/Layouttests, 8/8 Theme-Tests und beide Typechecks sind grün.

Auch der Server-Fix aus `.65` ist im Profil sichtbar: In den ersten 42 Sekunden liegen fast alle Sekunden bei
null bis drei Server-Mainthread-Samples, und der frühere periodische `Stream.aggregateWithin`-Stack fehlt. Erst
der finale Tool-/Provider-Übergang dominiert die letzten Profilsekunden. Die redundante zweite
`groupedWithin`-Schicht des Worker-Pfads ist damit live entfernt.

Der Profilstop hatte noch eine diagnostische Nebenwirkung: Ein zweiter `SIGUSR2`-Listener im ThemeProvider löste
beim Stop gleichzeitig Theme-, Palette- und Layoutarbeit aus. Im Profilmodus wird nun auch dieser Listener nicht
registriert. Build `1.18.1-patched.66-profile` enthält Scroll-Callback, eventgetriebenes Windowing und den sauberen
Profiler-Stop, bestand den Smoke-Test und ist atomar installiert.

### 16. `.66`: echter CPU-Wert ohne Aufnahme und Partial-Frame-Gegenbeweis

Der `.66`-Lauf liefert erstmals eine zehnsekündige `/proc`-Zeitreihe, bevor `SIGUSR1` den CPU-Profiler gestartet
hat. Im weiterhin aktiven Energiesparmodus liegen die Mittelwerte bei 89,2 % TUI, 13,6 % Server und 1,9 %
AI-Worker. Gleichzeitig entstehen nur 94 Frames, also 9,4 Frames pro Sekunde.

Die Frame-Sonde widerlegt auch hier Full-Render und Terminalausgabe als Erklärung: In einem direkt passenden
Elfsekundenfenster sind 86 von 88 Frames reine Acht-Zellen-Partial-Frames; zwei weitere ändern keine Zelle. Der
native Renderteil benötigt im Mittel 29,3 µs, der synchrone Write 68,4 µs. Es gibt in diesem Fenster keinen
vollständigen nativen Repaint und nur wenige KiB Terminalausgabe pro Sekunde. Trotzdem verbraucht der TUI-Prozess
nahezu einen Kern. Die verbleibende Last entsteht folglich parallel beziehungsweise vor dem bestätigten
Partial-Present-Pfad.

Nach Ende des Streams benötigt dieselbe TUI ohne einen einzigen Frame noch rund 7 % CPU: etwa 3,2 % im
Mainthread und zusammen rund 3 % in den HeapHelper-Threads. Das führte zu einem weiteren Messfehler im
Profilbootstrap. Bei gesetztem `OPENCODE_CPU_PROFILE` wurde die Inspector-Session bereits beim Prozessstart
verbunden und `Profiler.enable` dauerhaft ausgeführt, obwohl die eigentliche Aufnahme erst mit `SIGUSR1` begann.
Damit war das vermeintliche „ohne Aufnahme“-Fenster noch nicht vollständig frei von Profiler-Infrastruktur.

Ab `.67-profile` wird die Inspector-Session erst bei `SIGUSR1` erzeugt, verbunden und aktiviert. Nach
`SIGUSR2` wird sie gestoppt, deaktiviert und getrennt. Der Paket-Typecheck und Binary-Smoke-Test sind grün;
`1.18.1-patched.67-profile` ist atomar installiert. Der nächste Lauf muss zuerst Idle und Stream ohne Signal
messen, danach dieselbe Phase gezielt profilieren und insbesondere Mainthread, HeapHelper und Worker getrennt
korrelieren.

## Empfohlene Fixreihenfolge

### Phase 1: Asynchrones Highlighting layoutbewusst machen

**Status: umgesetzt und per Interventions-A/B bestätigt.**

Vor jeder Änderung des nativen TextBuffers im Highlight-Ergebnis:

1. `scrollWidth` und `scrollHeight` erfassen;
2. `setStyledText()` beziehungsweise `setText()` ausführen;
3. nur dann `updateTextInfo(true)` aufrufen, wenn eine Auto-Dimension tatsächlich geändert wurde;
4. andernfalls `updateTextInfo(false)` verwenden.

Dies muss für den Erfolgs- und Fehlerpfad identisch gelten. Ein kleiner gemeinsamer Helper wäre hier gerechtfertigt,
weil er eine echte Korrektheitsgrenze kapselt und drei auseinanderlaufende Implementierungen verhindert.

Erwartete Wirkung: Same-line- und reine Style-Updates bleiben partial. Full-Frames entstehen nur noch bei echten
Höhen-/Breitenänderungen, Strukturwechseln oder anderen normalen Invalidierungen.

### Phase 2: Tests auf den vollständigen asynchronen Lifecycle erweitern

**Status: Same-line- und echte `onChunks`-Dimensionsänderung sowie Single-Flight für veraltete Streaming-
Highlights umgesetzt; Fehler- und Conceal-Sonderfälle bleiben als zusätzliche Härtung offen.**

Erforderliche Regressionstests:

- Same-line-Update, Render starten, `highlightingDone` abwarten, Yoga bleibt clean;
- neue Zeile oder Wrap ändert die Höhe, Yoga wird dirty;
- Conceal-/Chunk-Transformation ändert sichtbare Dimensionen, Yoga wird dirty;
- leere Highlightliste mit `onChunks` bleibt bei identischen Dimensionen clean;
- Highlightfehler/Fallback bleibt bei identischen Dimensionen clean;
- veraltetes Highlight-Ergebnis erzeugt weder Layout- noch Full-Render-Churn.

### Phase 3: Highlighting während des Streams reduzieren

Für normalen Markdown-Prosetext liegt bereits ein synchron erzeugtes `initialStyledText` vor. Tree-sitter sollte
während schnell laufender Deltas entweder:

- debounced werden;
- erst nach einer kurzen Ruhephase laufen;
- oder bei beweisbar einfacher Prosa bis zum Abschluss der Nachricht entfallen.

Der finale stabile Parse muss beim Abschluss der Nachricht erfolgen. Aktuell setzt `TextPart` `streaming={true}`
hart. Das sollte gesondert gegen `streaming={!props.message.time.completed}` geprüft werden, damit abgeschlossene
Nachrichten tatsächlich in den stabilen Modus wechseln.

### Phase 4: Echten Append-Pfad entwickeln

**Status: sicherer Plain-Prose-Inline-Append umgesetzt; strukturelle Markdown- und native TextBuffer-Appends
bleiben offen.**

Für beweisbar append-only Text sollte die Pipeline Delta und Gesamtwert trennen:

- Store behält den kanonischen Gesamtwert;
- Renderer erhält zusätzlich das Append-Delta;
- einfacher Text kann `TextBuffer.append()` nutzen;
- Markdown reparst nur den semantisch instabilen Tail;
- bei Markdown-Metazeichen, Newline oder Strukturwechsel erfolgt ein konservativer Full-Value-Fallback.

### Phase 5: Partial-Present auf Dirty Regions begrenzen

**Status: strukturell umgesetzt, durch TypeScript-/Native-Diff-Tests und `.64` live bestätigt. Ein einmaliger
47-ms-Native-Ausreißer ist als eigener TTY-/Force-Repaint-Fall isoliert.**

Nach Stabilisierung der Layoutinvalidierung:

- effektive Bounding-Rects der Partial-Renderables werden verwendet;
- der committed Buffer bleibt persistent, daher ist keine Region- oder Full-Buffer-Restaurierung mehr nötig;
- der native Partial-Diff ist auf das Dirty-Rechteck begrenzt;
- Force-/Palette-/Overlay-Fälle fallen konservativ auf Full Diff zurück, Wide Characters erhalten Randzellen;
- das vollständige Hit-Grid bleibt über Partial Frames erhalten.

### Phase 6: SSE-Wakeup-Pfad reparieren und extern verifizieren

**Status: für private lokale TUI-Verbindungen durch IPC umgangen; redundantes Effect-`groupedWithin` im
AI-Worker-Pfad entfernt und in `.65` live bestätigt. Der öffentliche SSE-Pfad bleibt offen.**

Der gepacete A/B rechtfertigt eine gezielte Serveroptimierung. Zu prüfen sind, jeweils mit identischem Replay:

- mehrere logische Textdeltas ohne zusätzliche Latenz möglichst in einem Scheduler-/HTTP-Write drainen;
- Effect-Queue/Stream-Wakeup gegen einen direkten, backpressure-sicheren SSE-Writer vergleichen;
- generisches SSE-Encoding gegenüber einem vorserialisierten Delta-Fast-Path messen;
- Server und externen Client in getrennten Prozessen messen, damit deren CPU eindeutig getrennt bleibt;
- Overflow-, Disconnect-, Heartbeat- und Eventreihenfolge unverändert durch Regressionstests absichern.

Die Optimierung darf nicht allein auf einen Burstbenchmark gestützt werden. Primär ist ein 200-ms-Pacing, weil
genau das den Produktionszustand „Queue leer, Consumer wartet, nächstes Event weckt neu“ reproduziert.

## Verifikationsplan

Für den nächsten Fixbuild temporär folgende Zähler ergänzen:

- `highlightCompleted`;
- `highlightLayoutChangedTrue`;
- `highlightLayoutChangedFalse`;
- `layoutDirtyBail`;
- `partialFrame`;
- `fullFrame`;
- optional verarbeitete Bytes je Parser-/TextBuffer-Stufe.

Messung nicht mit einem variablen Live-Provider beginnen, sondern einen aufgezeichneten Delta-Stream mit festen
Zeitpunkten replayen. Terminalgröße, Message-Historie und Energiemodus müssen identisch sein.

Primäre Erfolgskriterien:

1. Same-line-Highlight-Abschlüsse erzeugen kein dirty Yoga.
2. `layoutDirty` folgt echten Größenänderungen statt dem festen 200-ms-Takt.
3. Full-Frame-Rate sinkt bei normaler Prosa deutlich unter einen Frame pro Sekunde, abgesehen von tatsächlichen
   Wraps, Newlines und Strukturänderungen.
4. Partial-Frames bleiben ohne schwarze Flächen oder Flackern korrekt.
5. TUI-Main-Thread und HeapHelper-CPU sinken beide.
6. Der serverseitige `sse-no-read`-Arm sinkt deutlich; ein externer Client bestätigt die Trennung von Server- und
   TUI-Kosten.

## Schlussfolgerung

Die hohe Streaming-CPU ist kein unvermeidlicher Preis einer Terminal-UI. Der aktuelle Stack verwandelt ungefähr
fünf kleine Textupdates pro Sekunde in fünf vollständige Layout-/Renderdurchläufe. Ursache ist vor allem der
asynchrone Highlightpfad, der die bereits implementierte Same-line-Optimierung durch pauschales Yoga-dirty wieder
aufhebt. Full-value-Verarbeitung und GC verstärken die Wirkung; unabhängige A/Bs belegen beide Beiträge.

Der separate Serverprozess hat einen zweiten, ebenfalls kausal belegten Frequenzfehler: Fünf einzeln getaktete
Events pro Sekunde starten den Effect-/SSE-/HTTP-Zustellpfad fünfmal neu. Der reale A/B erklärt bereits ohne
Client-CPU rund 20,7 Server-CPU-Prozentpunkte und reproduziert starken GC-Durchsatz. Der zunächst billige
Burst-Replay war kein Gegenbeweis, sondern amortisierte genau die zu untersuchenden Wakeup-Fixkosten.

Die Profile bis `.64-profile` trennen die verbleibende Last jetzt bis zu konkreten Produktions-Callsites. Im TUI
war der größte einzelne Pfad die bildschirmgroße Bufferkopie vor jedem Partial Frame, gefolgt vom weiterhin
vollflächigen nativen Diff/Clear. Serverseitig lag die Step-Finish-Spitze unter anderem im unnötigen Env-Clone je
Git-Spawn und in wiederholter Snapshot-Metadatenarbeit. Diese Pfade sind seit `.61-profile` strukturell
beseitigt; der Spinner bleibt unverändert bei 80 ms. Der saubere Fünf-Step-Lauf bestätigt normale
Streaminglast von meist 16–39 %, zeigt aber noch eine separate reine TUI-Spitze sowie teure Step-Grenzen. Die
unmittelbar doppelten identischen Snapshot-Aufnahmen und der Profiler-/Reload-Signalkonflikt sind deshalb in
`.62-profile` zusätzlich behoben. Das saubere `.62`-Profil bestätigt die Snapshot-Weitergabe und ordnet die
verbleibende TUI-Spitze nicht dem kleinen Textdelta, sondern der unnötigen vollständigen Darstellung eines
10-KiB-Write-Payloads zu. Außerdem liefen durch den Upgrade-Check zwei vollständige Instance-Servicegraphen mit
zwei stündlichen Snapshot-Cleanups. Beide Pfade sind strukturell entfernt; als letzter Schritt fehlt das Live-A/B
des neuen Builds mit genau einem Runtime-Boot und einem kompakten diagnosefreien Write.

Dieses Live-A/B ist mit `.63`/`.64` inzwischen erfolgt: Es existiert nur noch ein Instance-Boot, diagnosefreie
11-KiB-Write-Payloads erzeugen keinen vollständigen Code-/Tree-sitter-Pfad mehr, und der Surrogate-Regex ist im
ASCII-Fall nahezu verschwunden. `.64` isoliert zusätzlich einen einzigen 47-ms-Native-Frame, widerlegt den
Zellscan als dessen alleinige Ursache und weist im normalen Serverstream die redundante zweite
`groupedWithin`-Schicht nach. Letztere ist jetzt entfernt; der nächste Build dient der Live-Verifikation dieses
konkreten Scheduling-Fixes und der direkten Messung des verbleibenden TTY-/Force-Repaint-Ausreißers.
