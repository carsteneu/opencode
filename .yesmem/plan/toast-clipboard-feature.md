# Toast-Feature: Kopieren-Fehlermeldung statt stummem Versagen

> [!IMPORTANT]
> Neue Worktrees und Feature-Branches immer vom aktuellen `working`-Branch abspalten — nicht von `dev` und nicht von einem zufälligen aktuellen `HEAD`.

Status: EINGEPLANT (noch nicht umgesetzt) · Stand: 2026-08-15
Kontext: Zieldiskussion v. 15.08. — Stabilität/UX verbessern als fork-freundlicher, upstream-mergebarer Beitrag.

## Problem

`opencode` Kopieren-in-Zwischenablage schlägt **still** fehl, wenn (a) das Terminal kein OSC-52 kann
UND (b) auf Linux kein Clipboard-Tool (`wl-copy`/`xclip`/`xsel`) installiert ist. Der Nutzer sieht
"Copied to clipboard" ohne Effekt — keine Rückmeldung. Betroffen: GitHub-Issues
[#4283](https://github.com/anomalyco/opencode/issues/4283) ("Copy To Clipboard is not working") und
[#7048](https://github.com/anomalyco/opencode/issues/7048) ("Copied to clipboard" tut nie was).

## Ursache (verifiziert im Code)

Datei: `packages/tui/src/clipboard.ts`

- `write(text)` macht **zwei** Versuche:
  1. `writeOsc52(text)` — Terminal-OSC-52 (base64), tmux-gewrapped. **Kein** externes Tool nötig, aber
     nur wenn das Terminal OSC-52 unterstützt/erlaubt.
  2. `await getCopyMethod()(text)` — wählt natives Tool via `copyCommand(os, wayland, has)`:
     - `darwin` → `osascript` (eingebaut)
     - `linux`+Wayland → `wl-copy` (**muss installiert sein**)
     - `linux`+X11 → `xclip -selection clipboard` oder `xsel`
     - `win32` → `powershell.exe Set-Clipboard` (eingebaut)
     - **sonst** → npm-Paket `clipboardy` — das shellt auf Linux aber selbst wieder auf genau diese
       Tools → rettet **nicht**.
- **Alle Fehler werden verschluckt:** `command()` rejectet, aber jede Aufrufstelle hat
  `.catch(() => undefined)`; `getCopyMethod()` cached in `copyMethod`. Kein Signal an die UI.

## Lösung (Design)

Fehlermeldung über den vorhandenen TUI-Toast ausgeben statt schlucken.

Toast-Infra (verifiziert): `packages/tui/src/ui/toast.tsx` — `useToast().show({ title, variant, description })`,
`variant` aus `"default" | "success" | "error" | "loading"`. Beispiel-Aufruf in
`packages/tui/src/plugin/adapters.tsx:258`.

Zu tun in `packages/tui/src/clipboard.ts`:

1. `getCopyMethod()` zusätzlich die **gewählte Methode** (und ob das Tool fehlt) zurückmelden.
   Tool-Erkennung existiert bereits: `@opencode-ai/core/util/which` (genutzt im `has`-Callback;
   liefert falsy bei fehlendem Tool, wird aktuell verworfen).
2. In `write()`: Wenn auf Linux ein nötiges Tool **fehlt** ODER der native Aufruf fehlschlägt →
   einen `useToast().show({ variant: "error", ... })` auslösen.

### Beispiel-Text der Fehlermeldung

> Titel: "Copy to clipboard failed"
> Beschreibung: "No clipboard tool found. Install `wl-clipboard` (Wayland) or `xclip`/`xsel` (X11),
> or use an OSC-52-capable terminal (kitty/ghostty/alacritty/wezterm, tmux with `set-clipboard on`)."

### Bekannte Grenze (ehrlich)

OSC-52-Erfolg ist nicht sicher erkennbar (Terminals bestätigen OSC-52-Writes nicht via ACK).
Die Fehlermeldung muss deshalb über den **Backup-Tool-Pfad** signalisiert werden — sie deckt genau
den Fall "kein OSC-52 + kein Tool" ab, das ist der relevante Schmerz. Kein Overclaim auf OSC-52-Detection.

## Dateien

- `packages/tui/src/clipboard.ts` (Hauptänderung)
- ggf. `packages/tui/src/ui/toast.tsx` (nur lesen, API existiert — kein Umbau nötig)
- ggf. Test: `packages/tui/test/clipboard.test.ts` existiert bereits (prüft `copyCommand`) → dort den
  "kein Tool → Signal/Fehler"-Fall als Test ergänzen (TDD gem. Projekt-Regeln).

## Akzeptanzkriterien / Verifikation

- Linux ohne `wl-copy`/`xclip`/`xsel`, Terminal ohne OSC-52 → Kopieren zeigt fehlende Meldung statt still zu versagen.
- Linux mit Tool, oder OSC-52-Terminal, oder macOS/Windows → unverändertes Verhalten (keine Regression).
- `packages/tui/test/clipboard.test.ts` grün (inkl. neuem Negativ-Fall).
- Build/Typcheck der TUI-Packages.

## Offene Fragen / Entscheidungen

- Soll der Toast nur bei **definitiv fehlendem Tool** erscheinen, oder auch bei **fehlgeschlagenem
  Aufruf** (stürzt `xclip` trotz vorhanden ab)? Vorschlag: beides signalisieren, da `command()` schon
  non-zero-exit erkennt.
- Englisch/Deutsch des Toast-Textes? opencode ist EN → Englisch (Vorschlag).
- Optional Folge-Idee (separat, NICHT Teil dieses Features): OSC-52-Robustheit/Config, Sidecar-Binary.

## Strategie-Anmerkung

Kleiner, verhaltensneutraler, upstream-mergebarer Beitrag — passt zur vereinbarten Fork-Strategie
(mergebar bleiben, Stabilität/UX verbessern, stabile Mainline-Dinge ziehen). Kein Eingriff in
Architektur/Plugin/V2. Option C (bun:ffi) ist verworfen (lange Diskussion, siehe Konversation + Memory #85295).
