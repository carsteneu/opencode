# Rama `working` — Estado a 17 de julio de 2026

Rama consolidada que contiene todos los parches locales exitosos sobre `dev` (`2faa228`).
Worktree: `.worktrees/working` · HEAD: `7e017ce` · 23 commits por delante de dev.

Propósito de la rama: una build parcheada y funcional de opencode que aborda tres clases
de problemas aún abiertos en upstream — **parpadeo del TUI**, **alta carga de CPU durante
el streaming** y **fugas de memoria por un teardown no determinista de SSE**. También
contiene las builds patched.47–57 y la infraestructura de profiling con la que se midieron
estos parches.

Los commits de abajo están agrupados por tema; dentro de cada grupo, el orden es cronológico.
Los commits de build (`chore(opencode): build patched.N`) solo se listan brevemente al final,
ya que no contienen cambios de lógica.

---

## 1. Estabilidad de SSE y teardown determinista

**Problema de origen.** En los cambios de sesión y desconexiones, los listeners y las colas
de SSE se quedaban colgados; los contadores de listeners crecían monotónicamente, lo que
provocaba fugas de memoria y carga de CPU creciente por handlers huérfanos.

**`75ff364`** `fix(sse): deterministic teardown — disconnect detection, bounded queue, counters`
- 5 archivos, +151/−37. Nuevos: `sse-counters.ts`, `sse-disconnect.ts` (reelaborado),
  test `httpapi-sse-teardown.test.ts` (+100). Detecta desconexiones de forma fiable,
  acota las colas e introduce contadores de listeners para diagnóstico.

**`7703203`** Merge `yesloop/sse-orphan-fix` — incorpora `75ff364` y los cambios de
  handlers que lo acompañan (`event.ts`, `global.ts`).

**`c9d5600`** `fix(tui): dispose event.on subscriptions on unmount` (PR ascendente #34616)
- 3 archivos (`app.tsx`, `prompt/index.tsx`, `routes/session/index.tsx`), +135/−117.
- Lado TUI del mismo problema: las suscripciones de `event.on` no se liberaban al
  desmontar. Ahora todas las suscripciones se disponen de forma limpia.

## 2. Renderizado por ventanas y fix del parpadeo

**Problema de origen.** Cada token que llegaba vía stream volvía a renderizar la lista
completa de mensajes — esto provocaba parpadeo visible y picos de CPU que, en sesiones
largas, eran el principal motor de carga.

**`04f19c5`** `fix(tui): restore windowed message rendering + scroll-up history paging`
- `routes/session/index.tsx`, +62/−1. Restaura el renderizado por ventanas: solo la
  ventana visible se toca en cada frame. Además: el scroll hacia arriba hasta el inicio
  del historial vuelve a funcionar (estaba roto — era la regresión abierta al final de
  la sesión `ses_09d679f8`).

**`2f95b0a`** Merge `fix/loadolder-consumer-restore` — commit de merge de `04f19c5`.

## 3. Fast path de renderizado parcial para el spinner

**Problema de origen.** El spinner del prompt (estela Knight-Rider) corría en el camino
de frame completo y producía 30–60 renders completos/s, solo para animar una pequeña
área rectangular.

**`7721bd2`** `feat(tui): wire spinner to partial-render fast path`
- 3 archivos, +76/−4. Nuevo: `ui/partial-render.ts` (+61). El spinner se registra como
  elegible-parcial y solo dispara un re-render parcial de su propia área, ya no un
  frame completo.

**`4a8190c`** `perf(tui): lower idle render cost — 30fps cap, 100ms spinner tick, precomputed spinner frames`
- 3 archivos (`app.tsx`, `prompt/index.tsx`, `ui/spinner.ts`), +41/−34. La CPU en idle
  se reduce con un cap de 30 fps, un tick del spinner de 100 ms y frames precalculados.

**`2f6a3a5`** Merge `yesloop/spinner-partial-render`.

## 4. Batching de deltas SSE (bundle de CPU)

**Problema de origen.** Cada delta SSE entrante disparaba trabajo reactivo de limpieza
y re-renders. En un stream de modelo típico, con varios cientos de deltas por segundo,
esto provocaba una cascada de invalidación que llevaba la CPU al 80–110 % incluso en
máquinas rápidas.

**`6771d26`** `feat: SSE delta batching in sync.tsx` (PR #36045)
- `context/sync.tsx`, +65/−27. Recoge los deltas entrantes y los flushea en lotes en
  lugar de pasar cada delta individualmente por la pipeline reactiva.

**`243d1b6`** `feat: settle session status after stream end` (PR #36002)
- 4 archivos (`handlers/session.ts`, `run-state.ts`, 2 tests), +62/−17. Establece de
  forma determinista el estado de sesión a "settled" tras el fin del stream, para que
  las actualizaciones de UI posteriores no compitan contra un estado pendiente.

**`0162c3c`** `fix: pendingDeltas cleanup on part removal + disposal, fix indentation`
- `run-state.ts`, `sync.tsx`, +50/−47. Limpia `pendingDeltas` correctamente al eliminar
  partes y en el disposal; evita que los deltas batcheados se pierdan.

**`86eca67`** `fix: normalize indentation in sync.tsx event handlers` — limpieza final
  de la indentación en los bloques de handlers introducidos en `6771d26`.

**`249e71b`** Merge `yesloop/pr-cpu-bundle` — agrupa PR #36045 / #36002.

## 5. Refactor del servidor en proceso hijo (aislamiento del streaming)

**Problema de origen.** El streaming del LLM, el TUI y el servidor corrían en un solo
proceso; la presión de GC del stream (árboles de objetos grandes, concatenación de
strings) cargaba visiblemente el loop de render del TUI — el heap crecía hasta ~700 MB
por instancia de opencode en ejecución y empujaba la CPU a través de pausas de GC.
Solución: mover el streaming del LLM a un proceso worker separado.

**`88072db`** `perf(tui): isolate streaming processes`
- 20 archivos, +751/−143. El commit **arquitectónicamente más grande** de la rama.
  Archivos nuevos:
  - `packages/opencode/src/cli/tui/process-server.ts` (+164) — andamiaje de servidor
    para el proceso hijo (127.0.0.1, puerto libre, espera de readiness, auto-conexión).
  - `packages/opencode/src/session/llm/ai-process-client.ts` (+146) — lado cliente de
    la comunicación del LLM desde el TUI hacia el worker.
  - `packages/opencode/src/session/llm/ai-process-worker.ts` (+135) — lado worker;
    ejecuta el stream del LLM de forma aislada.
  - `packages/opencode/src/session/llm/ipc.ts` (+22) — protocolo IPC.
  - `test/session/llm-process.test.ts` (+138) — cobertura de tests del nuevo camino.
- Acompañado por cambios en `bootstrap.ts`, `cli/cmd/tui.ts` (−103, aligerado),
  `session/llm.ts` (+57), `context/{data,sdk,sync}.tsx` y `prompt/index.tsx`.
- **Atención — generador de regresión conocido:** Este commit eliminó por accidente el
  import de `createColors` y la función `ColorGenerator` en `spinnerDef`. Consecuencia:
  el spinner se volvió monocromo en lugar del gradiente Knight-Rider. Corregido en
  `7e017ce` (sección 7).

## 6. Coalesce del streaming del LLM

**`5eb15d7`** `perf(opencode): coalesce streaming deltas`
- 2 archivos (`session/llm.ts`, `test/session/llm-coalesce.test.ts`), +70/−1. Batching
  en el lado del LLM: varios deltas entrantes se combinan en un único flush antes de
  entrar en la pipeline de streaming. Reduce aún más el número de updates reactivos,
  complementario al batching de SSE de la sección 4.

## 7. Salida de shell y gradiente de color del spinner (v56 → v57)

**`56718c5`** `fix(tui): keep streaming shell output partial`
- `routes/session/index.tsx`, +15/−6. La salida de shell en la herramienta de streaming
  se movió al camino de renderizado parcial (en lugar de un frame completo en cada
  actualización de salida). Este es el cambio v56→v57.

**`7e017ce`** `fix(tui): restore knight rider spinner color gradient` (17 de julio de 2026)
- `component/prompt/index.tsx`, +8/−2. Devuelve `createColors` y reconecta
  `spinnerDef.color` a la función `ColorGenerator`. Sin el generador, `opentui-spinner`
  pinta cada carácter con el mismo RGBA — la estela colapsa en una animación de bloque
  monocromo. Corrige la regresión de `88072db`.

## 8. Tooling e infraestructura de build

**`3686a04`** `sync: local patches from main workspace`
- 8 archivos, +134/−45. Recopila parches locales menores: `targetFps` 30, caché del
  spinner + intervalo de 100 ms, rotación de logs, coalesce de SSE de 100 ms, eliminación
  de `structuredClone`, `loadOlder`.

**`6b5e516`** `chore(opencode): add on-demand CPU profiling` — +26 en un archivo.
  Activa perfiles de CPU bajo pulsación de tecla en lugar de estar siempre activos.

**`89325cf`** `chore(opencode): enable unminified profile builds` — permite builds de
  perfil legibles (cambio de 1 línea en el script de build).

**`5bdc8fd`** `docs(tui): document patched 56 changes` — +457. Documentación del estado
  de patched.56.

**Commits de build** (cada uno una build terminada, sin cambio de lógica):
`c6e169e` (.47), `240af19` (.48), `44f976d` (.47 baseline restore),
`2af5b3c` (.49 profile), `735d786` (.50), `968bf9f` (.51), `db0c451` (.52 debug),
`c58c615` (.53 debug), `c2e66bc` (.54 profile), `926d543` (.55 profile),
`4716241` (.56), `ddac4a3` (.57).

**Reverts** (reversiones intencionadas, cada uno como par Feature → Revert en el
historial):
- `c4f3213` `perf: replace scroll polling with events` → revertido en `2170548` +
  `44f976d` (reset de baseline a .47). La variante basada en eventos degradó la
  detección del estado de scroll; se volvió a la variante de polling.
- `05aa560` `perf: buffer completed assistant messages` → revertido en `e87bc03`.
  El buffering optimizaba el renderizado de mensajes de asistente completados, pero
  provocaba problemas de visualización; se deshizo.

## Efecto neto

- **Parpadeo** eliminado — renderizado por ventanas + camino de renderizado parcial
  (secciones 2, 3).
- **CPU significativamente reducida** — batching de SSE, coalesce del LLM, aislamiento
  del streaming en proceso hijo, cap de 30 fps, tick del spinner de 100 ms (secciones
  4, 5, 6, 3).
- **Fugas de memoria cerradas** — teardown determinista de SSE, disposal de `event.on`
  (sección 1).
- **Gradiente de color del spinner** restaurado (sección 7, 17 de julio de 2026).
- **Arquitectura:** el streaming del LLM corre aislado en su propio proceso worker
  (sección 5); esta es la base para futuros ajustes.

Build actual: **patched.57** (`ddac4a3`) **+ fix del spinner** (`7e017ce`).

## Verificado el 17 de julio de 2026

`working` contiene el estado completo de código exitoso. Verificación cruzada contra el
resto de worktrees:

- **`gc-pipeline`** (`ae5029e`): idéntico en código a `5eb15d7` en working — misma
  diffstat (2 archivos, +70/−1), mismo contenido de patch, SHA distinta solo por el
  parent distinto. gc-pipeline **no** contiene el refactor del servidor en proceso hijo
  de la sección 5; eso es exclusivo de working.
- **`yesloop-pr-cpu-bundle`**, **`yesloop-spinner-partial-render`**: 0 commits fuera de
  working.
- **`yesloop-tui-buffered-messages`** (`a1909dd`, `ed869de`): feature aplicada en working
  como `05aa560` y revertida como `e87bc03` — reversión intencionada.
- **`ab-bundle-merge`** (`f375f99`): solo artefacto de merge; el parche sustantivo está
  en working vía `249e71b`.
- **`yesresearch-opencode-pr-analyse`** (3 commits): pura documentación (wiki de
  investigación bajo `yesdocs/`, ~850 líneas de Markdown) — mantenida separada por
  diseño, sin commits de código.
