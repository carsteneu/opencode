# Gren `working` — Status 2026-07-17

Konsolideret gren med alle succesfulde lokale patches oven på `dev` (`2faa228`).
Worktree: `.worktrees/working` · HEAD: `7e017ce` · 23 commits foran dev.

Formål med grenen: en fungerende, patchet opencode-build, der adresserer tre klasser af
problemer, som stadig er åbne opstrøms — **TUI-flimren**, **høj CPU-belastning under
streaming** og **hukommelseslækager fra ikke-deterministisk SSE-nedrivning**. Den
indeholder også patched.47–57-binærerne og den profilering-infrastruktur, disse patches
blev målt med.

Commits herunder er grupperet efter tema; inden for hver gruppe er rækkefølgen kronologisk.
Build-commits (`chore(opencode): build patched.N`) er kun kortlistet til sidst, da de ikke
indeholder logikændringer.

---

## 1. SSE-stabilitet og deterministisk nedrivning

**Rodproblem.** Ved sessionskift og afbrydelser hang SSE-lyttere og køer fast;
lyttertællere voksede monotont, hvilket forårsagede hukommelseslækager og stigende
CPU-belastning fra forældreløse handlere.

**`75ff364`** `fix(sse): deterministic teardown — disconnect detection, bounded queue, counters`
- 5 filer, +151/−37. Nye: `sse-counters.ts`, `sse-disconnect.ts` (omarbejdet),
  test `httpapi-sse-teardown.test.ts` (+100). Detekterer afbrydelser pålideligt,
  afgrænser køer og introducerer lyttertællere til diagnostik.

**`7703203`** Merge `yesloop/sse-orphan-fix` — tager `75ff364` og de medfølgende
  handler-ændringer (`event.ts`, `global.ts`) ind.

**`c9d5600`** `fix(tui): dispose event.on subscriptions on unmount` (opstrøms PR #34616)
- 3 filer (`app.tsx`, `prompt/index.tsx`, `routes/session/index.tsx`), +135/−117.
- TUI-siden af samme problem: `event.on`-abonnementer blev ikke frigivet ved unmount.
  Nu bliver alle abonnementer ryddet pænt op.

## 2. Vinduesbaseret rendering og flimren-fix

**Rodproblem.** Hver streamet token rendrede hele meddelelseslisten — det forårsagede
synlig flimren og CPU-toppe, som i lange sessioner var den dominerende belastningsdriver.

**`04f19c5`** `fix(tui): restore windowed message rendering + scroll-up history paging`
- `routes/session/index.tsx`, +62/−1. Gendanner vinduesbaseret rendering: kun det
  synlige vindue røres pr. frame. Derudover: scroll op til starten af historikken
  virker igen (var i stykker — det var den åbne regression sidst i session `ses_09d679f8`).

**`2f95b0a`** Merge `fix/loadolder-consumer-restore` — merge-commit for `04f19c5`.

## 3. Delvist-renderings-hurtigsti for spinneren

**Rodproblem.** Prompt-spinneren (Knight-Rider-spor) kørte på fuld-frame-stien og
producerede 30–60 fulde renders/s, blot for at animere et lille rektangulært område.

**`7721bd2`** `feat(tui): wire spinner to partial-render fast path`
- 3 filer, +76/−4. Ny: `ui/partial-render.ts` (+61). Spinneren registreres som
  partial-eligible og udløser kun en delvis re-render af sit eget område, ikke længere
  en fuld frame.

**`4a8190c`** `perf(tui): lower idle render cost — 30fps cap, 100ms spinner tick, precomputed spinner frames`
- 3 filer (`app.tsx`, `prompt/index.tsx`, `ui/spinner.ts`), +41/−34. CPU ved idle
  reduceres via et 30 fps-loft, et 100 ms spinner-tick og forudberegnede frames.

**`2f6a3a5`** Merge `yesloop/spinner-partial-render`.

## 4. SSE-delta-batching (CPU-bundt)

**Rodproblem.** Hver indkommende SSE-delta udløste reaktivt oprydningsarbejde og
re-renders. På en typisk model-stream med flere hundrede deltas pr. sekund forårsagede
dette en invalidationskaskade, der drev CPU op på 80–110 % selv på hurtige maskiner.

**`6771d26`** `feat: SSE delta batching in sync.tsx` (PR #36045)
- `context/sync.tsx`, +65/−27. Samler indkommende deltas og flusher dem i bundter i
  stedet for at sende hver delta individuelt gennem den reaktive pipeline.

**`243d1b6`** `feat: settle session status after stream end` (PR #36002)
- 4 filer (`handlers/session.ts`, `run-state.ts`, 2 tests), +62/−17. Sætter
  sessionsstatus deterministisk til "settled" efter streamens afslutning, så efterfølgende
  UI-opdateringer ikke kappes mod en tilstand på vent.

**`0162c3c`** `fix: pendingDeltas cleanup on part removal + disposal, fix indentation`
- `run-state.ts`, `sync.tsx`, +50/−47. Rydder `pendingDeltas` korrekt ved fjernelse af
  dele og ved disposal; forhindrer batchede deltas i at løbe ud i intet.

**`86eca67`** `fix: normalize indentation in sync.tsx event handlers` — endelig
  oprydning af indrykning i de handler-blokke, der blev introduceret i `6771d26`.

**`249e71b`** Merge `yesloop/pr-cpu-bundle` — samler PR #36045 / #36002.

## 5. Barneprocess-server-refaktorering (streaming-isolation)

**Rodproblem.** LLM-streaming, TUI og server kørte i én proces; GC-trykket fra streamen
(store objekttræer, strengsammenkædning) belastede synligt TUI's rendering-loop — heapen
voksede til ~700 MB pr. kørende opencode-instans og drev CPU op gennem GC-pauser.
Løsning: flyt LLM-streaming ind i en separat worker-proces.

**`88072db`** `perf(tui): isolate streaming processes`
- 20 filer, +751/−143. Den **arkitektonisk største** commit i grenen. Nye filer:
  - `packages/opencode/src/cli/tui/process-server.ts` (+164) — server-stillads for
    barneprocessen (127.0.0.1, ledig port, readiness-vent, auto-connect).
  - `packages/opencode/src/session/llm/ai-process-client.ts` (+146) — klientsiden af
    LLM-kommunikationen fra TUI til worker.
  - `packages/opencode/src/session/llm/ai-process-worker.ts` (+135) — workersiden;
    kører LLM-streamen isoleret.
  - `packages/opencode/src/session/llm/ipc.ts` (+22) — IPC-protokol.
  - `test/session/llm-process.test.ts` (+138) — testdækning af den nye sti.
- Ledsaget af ændringer i `bootstrap.ts`, `cli/cmd/tui.ts` (−103, slimmet), `session/llm.ts`
  (+57), `context/{data,sdk,sync}.tsx` og `prompt/index.tsx`.
- **Advarsel — kendt regressionsdriver:** Denne commit fjernede ved et uheld
  `createColors`-importen og `ColorGenerator`-funktionen i `spinnerDef`. Konsekvens:
  spinneren blev monokrom i stedet for en Knight-Rider-gradient. Rettes i `7e017ce`
  (afsnit 7).

## 6. LLM-streaming-sammenlægning

**`5eb15d7`** `perf(opencode): coalesce streaming deltas`
- 2 filer (`session/llm.ts`, `test/session/llm-coalesce.test.ts`), +70/−1. Batching på
  LLM-siden: flere indkommende deltas kombineres til én flush, før de går ind i
  streaming-pipelinen. Reducerer yderligere antallet af reaktive opdateringer,
  komplementært til SSE-batching i afsnit 4.

## 7. Shell-output og spinnerens farvegradient (v56 → v57)

**`56718c5`** `fix(tui): keep streaming shell output partial`
- `routes/session/index.tsx`, +15/−6. Shell-output i streaming-værktøjet blev flyttet
  over på den delvise renderings-sti (i stedet for en fuld frame ved hver output-opdatering).
  Dette er v56→v57-ændringen.

**`7e017ce`** `fix(tui): restore knight rider spinner color gradient` (2026-07-17)
- `component/prompt/index.tsx`, +8/−2. Henter `createColors` tilbage og kobler
  `spinnerDef.color` tilbage til `ColorGenerator`-funktionen. Uden generatoren maler
  `opentui-spinner` hvert tegn med samme RGBA — sporet kollapser til en
  monokrom blok-animation. Retter regressionen fra `88072db`.

## 8. Værktøjer og build-infrastruktur

**`3686a04`** `sync: local patches from main workspace`
- 8 filer, +134/−45. Samler mindre lokale patches: `targetFps` 30, spinner-cache +
  100 ms interval, log-rotation, SSE-coalesce 100 ms, fjernelse af `structuredClone`,
  `loadOlder`.

**`6b5e516`** `chore(opencode): add on-demand CPU profiling` — +26 i én fil.
  Aktiverer CPU-profiler ved tastetryk i stedet for altid-til.

**`89325cf`** `chore(opencode): enable unminified profile builds` — tillader læsbare
  profile-builds (1-linjes ændring i build-scriptet).

**`5bdc8fd`** `docs(tui): document patched 56 changes` — +457. Dokumentation af
  patched.56-tilstanden.

**Build-commits** (hver en færdig binær, ingen logikændring):
`c6e169e` (.47), `240af19` (.48), `44f976d` (.47 baseline-gendannelse),
`2af5b3c` (.49 profile), `735d786` (.50), `968bf9f` (.51), `db0c451` (.52 debug),
`c58c615` (.53 debug), `c2e66bc` (.54 profile), `926d543` (.55 profile),
`4716241` (.56), `ddac4a3` (.57).

**Reverts** (tilsigtede tilbagerulninger, hver som et Feature → Revert-par i historikken):
- `c4f3213` `perf: replace scroll polling with events` → revertet i `2170548` +
  `44f976d` (baseline-nulstilling til .47). Den hændelsesbaserede variant forværrede
  detektion af scroll-tilstand; vendte tilbage til polling-varianten.
- `05aa560` `perf: buffer completed assistant messages` → revertet i `e87bc03`.
  Buffering optimerede rendering af fuldførte assistant-meddelelser, men forårsagede
  visningsproblemer; rullet tilbage.

## Nettovirkning

- **Flimren** elimineret — vinduesbaseret rendering + delvist-renderings-sti
  (afsnit 2, 3).
- **CPU betydeligt reduceret** — SSE-batching, LLM-coalesce, streaming-isolation i
  barneprocess, 30 fps-loft, 100 ms spinner-tick (afsnit 4, 5, 6, 3).
- **Hukommelseslækager lukket** — deterministisk SSE-nedrivning, `event.on`-disposal
  (afsnit 1).
- **Spinnerens farvegradient** gendannet (afsnit 7, 2026-07-17).
- **Arkitektur:** LLM-streaming kører isoleret i sin egen worker-proces (afsnit 5);
  dette er fundamentet for yderligere justering.

Nuværende binær: **patched.57** (`ddac4a3`) **+ spinner-fix** (`7e017ce`).

## Bekræftet 2026-07-17

`working` indeholder den fulde succesfulde kodetilstand. Krydstjek mod alle andre
worktrees:

- **`gc-pipeline`** (`ae5029e`): kode-identisk med `5eb15d7` i working — samme diffstat
  (2 filer, +70/−1), samme patch-indhold, forskellig SHA kun på grund af anden parent.
  gc-pipeline indeholder **ikke** barneprocess-server-refaktoreringen fra afsnit 5;
  det er eksklusivt for working.
- **`yesloop-pr-cpu-bundle`**, **`yesloop-spinner-partial-render`**: 0 commits uden for
  working.
- **`yesloop-tui-buffered-messages`** (`a1909dd`, `ed869de`): feature applied i working
  som `05aa560` og revertet som `e87bc03` — tilsigtet tilbagerulning.
- **`ab-bundle-merge`** (`f375f99`): kun et merge-artefakt; den indholdsmæssige patch er
  i working via `249e71b`.
- **`yesresearch-opencode-pr-analyse`** (3 commits): ren dokumentation (forsknings-wiki
  under `yesdocs/`, ~850 linjer Markdown) — bevidst holdt adskilt, ingen kode-commits.
