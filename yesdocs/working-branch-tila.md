# Haara `working` — Tilanne 2026-07-17

Yhdistetty haara, joka sisältää kaikki onnistuneet paikalliset korjaukset `dev`-haaran
(`2faa228`) päällä.
Worktree: `.worktrees/working` · HEAD: `7e017ce` · 23 committiä devin edellä.

Haaran tarkoitus: toimiva, paikattu opencode-versio, joka ratkaisee kolme ylävirrassa
yhä auki olevaa ongelmaa — **TUI-välkyntä**, **suuri CPU-kuorma suoratoiston aikana** ja
**muistivuodot epädeterministisestä SSE-purkamisesta**. Se sisältää myös patched.47–57-
binäärit ja profilointi-infrastruktuurin, jolla nämä korjaukset mitattiin.

Alla olevat commitit on ryhmitelty teeman mukaan; kunkin ryhmän sisällä järjestys on
kronologinen. Build-commitit (`chore(opencode): build patched.N`) on lueteltu vain lyhyesti
lopussa, koska ne eivät sisällä logiikkamuutoksia.

---

## 1. SSE-vakaus ja deterministinen purkaminen

**Juuriongelma.** Istunnon vaihdoissa ja yhteyksien katkoissa SSE-kuuntelijat ja jonot
jäivät roikkumaan; kuuntelijalaskurit kasvoivat monotonisesti, mikä aiheutti muistivuotoja
ja nousevaa CPU-kuormaa orvoista handlereista.

**`75ff364`** `fix(sse): deterministic teardown — disconnect detection, bounded queue, counters`
- 5 tiedostoa, +151/−37. Uudet: `sse-counters.ts`, `sse-disconnect.ts` (uusittu),
  testi `httpapi-sse-teardown.test.ts` (+100). Tunnistaa katkokset luotettavasti,
  rajoittaa jonot ja tuo kuuntelijalaskurit diagnostiikkaa varten.

**`7703203`** Merge `yesloop/sse-orphan-fix` — ottaa sisään `75ff364`:n ja siihen
  liittyvät handler-muutokset (`event.ts`, `global.ts`).

**`c9d5600`** `fix(tui): dispose event.on subscriptions on unmount` (ylivirta-PR #34616)
- 3 tiedostoa (`app.tsx`, `prompt/index.tsx`, `routes/session/index.tsx`), +135/−117.
- Saman ongelman TUI-puoli: `event.on`-tilauksia ei vapautettu unmountin yhteydessä.
  Nyt kaikki tilaukset disposoidaan puhtaasti.

## 2. Ikkunoitu renderöinti ja välynnän korjaus

**Juuriongelma.** Jokainen suoratoistettu token renderöi koko viestilistan uudelleen —
tämä aiheutti näkyvää välkyntää ja CPU-piikkejä, jotka pitkissä istunnoissa olivat
kuorman pääasiallinen ajuri.

**`04f19c5`** `fix(tui): restore windowed message rendering + scroll-up history paging`
- `routes/session/index.tsx`, +62/−1. Palauttaa ikkunoidun renderöinnin: vain näkyvä
  ikkuna kosketaan per ruutu. Lisäksi: ylösvilleitys historian alkuun toimii jälleen
  (oli rikki — tämä oli avoin regressio istunnon `ses_09d679f8` lopussa).

**`2f95b0a`** Merge `fix/loadolder-consumer-restore` — merge-commit `04f19c5`:lle.

## 3. Spinnerin osittais-renderöinnin nopea polku

**Juuriongelma.** Promptin spinner (Knight-Rider-jälki) pyöri täyden ruudun polulla ja
tuotti 30–60 täyttä renderöintiä/s, vain pienen suorakulmaisen alueen animoimiseksi.

**`7721bd2`** `feat(tui): wire spinner to partial-render fast path`
- 3 tiedostoa, +76/−4. Uusi: `ui/partial-render.ts` (+61). Spinner rekisteröidään
  partial-eligible-na ja laukaisee vain oman alueensa osittaisen uudelleenrenderöinnin,
  ei enää täyttä ruutua.

**`4a8190c`** `perf(tui): lower idle render cost — 30fps cap, 100ms spinner tick, precomputed spinner frames`
- 3 tiedostoa (`app.tsx`, `prompt/index.tsx`, `ui/spinner.ts`), +41/−34. Idle-CPU:ta
  alennetaan 30 fps -katolla, 100 ms spinnerin tickillä ja esilasketuilla frameilla.

**`2f6a3a5`** Merge `yesloop/spinner-partial-render`.

## 4. SSE-delta-batchaus (CPU-nippu)

**Juuriongelma.** Jokainen sisääntuleva SSE-delta laukaisi reaktiivista siivoustyötä ja
uudelleenrenderöintejä. Tyypillisessä mallisuoratoistossa, jossa tulee useita satoja
deltaeja sekunnissa, tämä aiheutti invalidointikaskaadin, joka ajoi CPU:n 80–110 %:iin
jopa nopeilla koneilla.

**`6771d26`** `feat: SSE delta batching in sync.tsx` (PR #36045)
- `context/sync.tsx`, +65/−27. Kerää sisääntulevat deltat ja flushaa ne erissä sen
  sijaan, että jokainen delta menisi yksitellen reaktiivisen putken läpi.

**`243d1b6`** `feat: settle session status after stream end` (PR #36002)
- 4 tiedostoa (`handlers/session.ts`, `run-state.ts`, 2 testiä), +62/−17. Asettaa
  istunnon tilan deterministisesti "settled"-tilaan suoratoiston päätyttyä, jotta
  myöhemmät käyttöliittymäpäivitykset eivät kilpaile roikkuvan tilan kanssa.

**`0162c3c`** `fix: pendingDeltas cleanup on part removal + disposal, fix indentation`
- `run-state.ts`, `sync.tsx`, +50/−47. Siivoaa `pendingDeltas`-kentän oikein osien
  poistossa ja disposalissa; estää batchatut deltat katoamasta tyhjyyteen.

**`86eca67`** `fix: normalize indentation in sync.tsx event handlers` — lopullinen
  sisennyksen siistiminen handler-lohkoissa, jotka `6771d26` toi sisään.

**`249e71b`** Merge `yesloop/pr-cpu-bundle` — niputtaa PR #36045 / #36002.

## 5. Lapsiprosessipalvelimen refaktorointi (suoratoiston eristäminen)

**Juuriongelma.** LLM-suoratoisto, TUI ja palvelin pyörivät yhdessä prosessissa; suoratoiston
GC-paine (suuret oliopuut, merkkijonojen ketjutus) kuormitti selvästi TUI:n
renderöintilooppia — heap kasvoi noin 700 MB:iin per käynnissä oleva opencode-instanssi
ja ajoi CPU:ta GC-taukojen kautta. Ratkaisu: siirrä LLM-suoratoisto erilliseen
worker-prosessiin.

**`88072db`** `perf(tui): isolate streaming processes`
- 20 tiedostoa, +751/−143. Haaran **arkkitehtuurisesti suurin** commit. Uudet tiedostot:
  - `packages/opencode/src/cli/tui/process-server.ts` (+164) — palvelinteline
    lapsiprosessille (127.0.0.1, vapaa portti, readiness-odotus, auto-connect).
  - `packages/opencode/src/session/llm/ai-process-client.ts` (+146) — LLM-viestinnän
    asiakaspuoli TUI:sta workeriin.
  - `packages/opencode/src/session/llm/ai-process-worker.ts` (+135) — worker-puoli;
    suorittaa LLM-suoratoiston eristettynä.
  - `packages/opencode/src/session/llm/ipc.ts` (+22) — IPC-protokolla.
  - `test/session/llm-process.test.ts` (+138) — testikattavuus uudelle polulle.
- Mukana muutoksia tiedostoissa `bootstrap.ts`, `cli/cmd/tui.ts` (−103, kevennetty),
  `session/llm.ts` (+57), `context/{data,sdk,sync}.tsx` ja `prompt/index.tsx`.
- **Varoitus — tunnettu regressiolähde:** Tämä commit pudotti vahingossa `createColors`-
  importin ja `ColorGenerator`-funktion `spinnerDef`:stä. Seurauksena spinner muuttui
  yksiväriseksi Knight-Rider-gradientin sijaan. Korjattu commitissa `7e017ce`
  (kohta 7).

## 6. LLM-suoratoiston coalesce

**`5eb15d7`** `perf(opencode): coalesce streaming deltas`
- 2 tiedostoa (`session/llm.ts`, `test/session/llm-coalesce.test.ts`), +70/−1. Batchaus
  LLM-puolella: useita sisääntulevia deltaeja yhdistetään yhdeksi flushiksi ennen kuin
  ne menevät suoratoistoputkeen. Vähentää reaktiivisten päivitysten määrää edelleen,
  täydentää kohdan 4 SSE-batchausta.

## 7. Shell-tuloste ja spinnerin värigradientti (v56 → v57)

**`56718c5`** `fix(tui): keep streaming shell output partial`
- `routes/session/index.tsx`, +15/−6. Suoratoistotyökalun shell-tuloste siirrettiin
  osittaisen renderöinnin polulle (täyden ruudun sijaan jokaisella tulostepäivityksellä).
  Tämä on v56→v57-muutos.

**`7e017ce`** `fix(tui): restore knight rider spinner color gradient` (2026-07-17)
- `component/prompt/index.tsx`, +8/−2. Palauttaa `createColors`:n ja kytkee
  `spinnerDef.color`:n takaisin `ColorGenerator`-funktioon. Ilman generoijaa
  `opentui-spinner` maalaa jokaisen merkin samalla RGBA:lla — jälki romahtaa
  yksiväriseksi lohkoanimaatioksi. Korjaa `88072db`:n regression.

## 8. Työkalut ja build-infrastruktuuri

**`3686a04`** `sync: local patches from main workspace`
- 8 tiedostoa, +134/−45. Kokoaa pienempiä paikallisia korjauksia: `targetFps` 30,
  spinner-välimuisti + 100 ms intervalli, lokikierto, SSE-coalesce 100 ms,
  `structuredClone`:n poisto, `loadOlder`.

**`6b5e516`** `chore(opencode): add on-demand CPU profiling` — +26 yhdessä tiedostossa.
  Ottaa CPU-profilit käyttöön näppäimen painalluksesta always-onin sijaan.

**`89325cf`** `chore(opencode): enable unminified profile builds` — sallii luettavat
  profile-buildit (1 rivin muutos build-skriptissä).

**`5bdc8fd`** `docs(tui): document patched 56 changes` — +457. patched.56-tilan
  dokumentointi.

**Build-commitit** (kukin valmis binääri, ei logiikkamuutosta):
`c6e169e` (.47), `240af19` (.48), `44f976d` (.47 baseline-palautus),
`2af5b3c` (.49 profile), `735d786` (.50), `968bf9f` (.51), `db0c451` (.52 debug),
`c58c615` (.53 debug), `c2e66bc` (.54 profile), `926d543` (.55 profile),
`4716241` (.56), `ddac4a3` (.57).

**Revertit** (tarkoitukselliset peruutukset, kukin Ominaisuus → Revert -parina
historiassa):
- `c4f3213` `perf: replace scroll polling with events` → revertoitu commitissa
  `2170548` + `44f976d` (baseline-palautus .47:ään). Tapahtumapohjainen variantti
  heikensi vieritystilatunnistusta; palattiin polling-varianttiin.
- `05aa560` `perf: buffer completed assistant messages` → revertoitu commitissa
  `e87bc03`. Puskurointi optimoi valmiiden assistant-viestien renderöintiä, mutta
  aiheutti näyttöongelmia; peruttiin.

## Nettovaikutus

- **Välkyntä** eliminoitu — ikkunoitu renderöinti + osittaisen renderöinnin polku
  (kohdat 2, 3).
- **CPU merkittävästi alentunut** — SSE-batchaus, LLM-coalesce, suoratoiston eristäminen
  lapsiprosessiin, 30 fps -katto, 100 ms spinnerin tick (kohdat 4, 5, 6, 3).
- **Muistivuodot suljettu** — deterministinen SSE-purkaminen, `event.on`-disposal
  (kohta 1).
- **Spinnerin värigradientti** palautettu (kohta 7, 2026-07-17).
- **Arkkitehtuuri:** LLM-suoratoisto pyörii eristettynä omassa worker-prosessissaan
  (kohta 5); tämä on perusta jatkokäännökselle.

Nykyinen binääri: **patched.57** (`ddac4a3`) **+ spinner-korjaus** (`7e017ce`).

## Vahvistettu 2026-07-17

`working` sisältää täydellisen onnistuneen kooditilan. Ristiintarkistus kaikkia muita
worktree-puita vastaan:

- **`gc-pipeline`** (`ae5029e`): koodiltaan identtinen `5eb15d7`:n kanssa workingissa —
  sama diffstat (2 tiedostoa, +70/−1), sama patchisisältö, eri SHA ainoastaan eri
  parentin vuoksi. gc-pipeline **ei** sisällä kohdan 5 lapsiprosessipalvelin-refaktorointia;
  se on workingin yksinoikeus.
- **`yesloop-pr-cpu-bundle`**, **`yesloop-spinner-partial-render`**: 0 commitia workingin
  ulkopuolella.
- **`yesloop-tui-buffered-messages`** (`a1909dd`, `ed869de`): ominaisuus on workingissa
  applytty `05aa560`:nä ja revertoitu `e87bc03`:na — tarkoituksellinen peruutus.
- **`ab-bundle-merge`** (`f375f99`): vain merge-artefakti; sisällöllinen patch on
  workingissa commitin `249e71b` kautta.
- **`yesresearch-opencode-pr-analyse`** (3 commitia): puhdasta dokumentaatiota
  (tutkimuswiki `yesdocs/`:ssä, n. 850 riviä Markdownia) — pidetty erillään tarkoituksella,
  ei koodicommitteja.
