# Perf /proc Tools

Python-Werkzeuge für Live-Messungen an laufenden OpenCode-Instanzen. Alle drei
arbeiten rein passiv über `/proc` (keine Signale, kein ptrace, kein perf-attach,
kein Terminal-Input) und erfassen das Power-Profil (`powerprofilesctl`) vor, in
jedem Bin und nach der Messung — niemals absolute CPU-Prozente über Profile hinweg vergleichen.

Protokoll-Einordnung: diese Tools implementieren die Messverfahren für B01
(echtes Idle) und B03 (Live-Session) aus
[`yesdocs/patched-release-verification.md`](../../yesdocs/patched-release-verification.md).
Für B02 (deterministisches Streaming) den TUI-Harness unter
`packages/tui/test/perf/` verwenden (stream-fence/cold-start, im jeweiligen
Worktree).

## Werkzeuge

### `bench_proc.py` — Einzel-Root-Benchmark mit Phasen & DB-Korrelation

Der maßgebliche Benchmark für Idle-Messungen (B01) und aktive Phasen.

```sh
python3 script/perf/bench_proc.py --root <CLIENT_PID> --session <SESSION_ID> \
  [--duration 60] [--interval 1.0] \
  [--db ~/.local/share/opencode/opencode.db] \
  [--log ~/.local/share/opencode/log/opencode.log]
```

- Klassifiziert Prozesse in Rollen: `client`, `server` (`__opencode_tui_server__`),
  `worker` (`__opencode_ai_worker__`), `descendant:<comm>` (z. B. yesmem-MCP).
- Identity-Guard über `starttime_ticks`: PID-Reuse kann eine Serie nicht verfälschen.
- Bins mit Rollen-CPU %, RSS/PSS, Context-Switches, I/O-Deltas; Counter-Gaps werden
  protokolliert, nicht ignoriert.
- Phasen-Segmente: zerlegt das Fenster anhand Worker-Presence (`phase_key`
  `no-worker` / `worker:<ids>`) — Mittel nur innerhalb homogener Phasen bilden.
- Korreliert mit Session-DB (messages/parts im Fenster, read-only) und Log-Datei-Stats.
- `summary.warnings` enthält strukturelle Hinweise (Tree geändert, Power nicht
  stabil, Worker im angeblichen Idle, Abbruch durch Root-Tod). Warnungen ernst
  nehmen — eine Messung mit `power_profile_stable: false` ist nicht B01-tauglich.
- Ergebnis: `/tmp/opencode-proc-bench-<ts>/` mit `summary.json` (gleichzeitig auf
  stdout), `snapshots.jsonl`, `bins.jsonl`, `power.jsonl`, `workload.json`, `metadata.json`.

### `live_process_sampler.py` — Multi-Root-Sampler für Parallelinstanzen

Für Messungen über **mehrere unabhängige OpenCode-Instanzen** hinweg (z. B.
ruhige Referenzinstanz + aktive Testinstanz im selben Fenster, wie beim
.126-Praxistest).

```sh
python3 script/perf/live_process_sampler.py <PID_A,PID_B,...> <DAUER_S> <OUTPUT_DIR>
```

- 1-s-Bins, pro Bin: kompletter Prozess-Snapshot aller Trees (CPU-Ticks, RSS/PSS,
  Ctx, I/O, cmdline/exe/cwd), Host-CPU, Loadavg, Power-Profil.
- Rollen: `client`, `server`, `ai`, `yesmem`, `tool`.
- Binary-SHA256 aller Roots (nur wenn identisch) in `meta.json` — Provenienz der
  Messung ist damit Teil der Rohdaten.
- 2 s Vorlauf nach dem Hashing, damit der erste Bin nicht durch den Sampler
  selbst kontaminiert ist.

### `analyze_live_samples.py` — Auswertung der Sampler-Daten

```sh
python3 script/perf/analyze_live_samples.py <OUTPUT_DIR>
```

Liest `meta.json` (inkl. `clk_tck` — nichts hartkodiert) und `samples.jsonl`,
gibt pro Tree aus: Rollen-CPU %, Ctx/s, Read/Write B/s, RSS/PSS avg/max/end,
Bin-Min/Median/Max und Signatur-Segmente (Phasen konstanter Tree-Komposition).
`signature_changed`-Bins markieren Prozess-Spawns — aktive Phasen abgrenzen.

## Regeln

- **Rohdaten nach `/tmp`** (flüchtig, bewusst): `samples.jsonl` & Co. sind
  Wegwerf-Daten. Persistente Zusammenfassungen, Tabellen, Entscheidungen gehören
  in `yesdocs/` oder Learnings — niemals Binaries, Branches oder Reports in `/tmp`
  erzeugen (Pin #53).
- **Attribution vor Glauben**: Fremde Zusammenfassungen (auch von Agenten) anhand
  der Rohdaten nachrechnen — Instanz-Zuordnung über `meta.json.roots`, nicht über
  Annahmen (beim .126-Praxistest meldete eine Auswertung versehentlich nur eine
  von zwei Instanzen als "die" Messung).
- **Phasen nutzen**: Ganzzahlenfenster-Mittel sind über Worker-Phasen hinweg
  unbrauchbar; `segments`/`phase_key` zuerst prüfen.
- **Power-Profil** in jedem Bin prüfen; gemischte Profile disqualifizieren
  absolute Vergleiche (B-Protokoll-Regel der Runbooks).

### `ab-server-boot.sh` + `boot-timeline.py` — Server-Boot A/B (Bootstrap-Phase)

Interleaved A/B server boot measurement between two checkouts (base vs candidate levers).

```sh
# two worktrees needed: base (pre-change) and candidate
script/perf/ab-server-boot.sh .worktrees/tmp-server-base/packages/opencode packages/opencode /tmp/ab-server 3
python3 script/perf/boot-timeline.py /tmp/ab-server A B
```

- Boots `bun src/bootstrap.ts` per run in tmux (fresh XDG_DATA_HOME + unique port per run, primer run warms plugin installs in both trees first, results interleaved A/B/A/B order)
- Produces `*.tty`, `*.frame`, `*.log` per run; boot-timeline.py extracts `boot->wb` (bootstrapping → first watcher backend = total boot window) and `init_gap` (plugin-init marker → watcher backend)
- opencode.log lines are not strictly time-ordered (client/server interleave) — extractor takes earliest timestamp per marker, negative deltas dropped
- Variants: each side is a packages/opencode dir (dev: `bun src/bootstrap.ts`) OR a compiled binary (runs `<binary> --port N` from repo root via AB_BOOT_CWD). Enables installed-vs-fresh binary A/B
- Metrics per run (boot-timeline.py): TTFD (`OPENCODE_SHOW_TTFD=1`), boot->wb, init_gap, mcp_gap (loc->unav); medians per tag
- Safety: only its own tmux sessions (`abm-*`) and temp dirs are touched; no broad process kills (see process-kill rule from Learning #85668)

### `ab-ghostty-boot.sh` — A/B im echten Terminal (Ghostty)

Misst TTFD so, wie der Nutzer es sieht — inkl. OSC-10/11-Theme-Detection, die der tmux-Harness stummschaltet.

```sh
script/perf/ab-ghostty-boot.sh ~/.opencode/bin/opencode \
  packages/opencode/dist/local-only/1.18.18-patched.130-serverstartup/opencode /tmp/ab-gh 3
```

- Öffnet pro Run ein echtes Ghostty-Fenster (`ghostty -e script -qfec 'timeout 12 <binary>' out.io`): opencode läuft auf echter pty-Kette, OSC-Antworten fließen durch
- Cleanup rein timeout-basiert (Regel: keine pattern-kills); öffnet 2×runs Fenster nacheinander (~9 s pro Run)
- Befund 20.08. (.128 vs .130, n=3 interleaved): tmux-Harness zeigte TTFD −910ms — in Ghostty DASSELBE Median (3610 vs 3843ms, Rauschen). Der Theme-Wait-Hebel zahlt nur in OSC-stummen Terminals; echte Nutzer-Terminals (Ghostty) hatten die 1s-Strafe nie
