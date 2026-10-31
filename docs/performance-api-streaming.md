# Local API and subscription streaming verification (2026-10-07)

This is evidence for the in-progress `perf-api` step, not completion of the Goal or a production performance guarantee. Parallel source refactoring is in progress; historical runs and current-source runs are distinguished below.

## Latest applied-build observation (2026-10-08 Asia/Seoul)

The user reports running dev again. Fresh health (`73f62804-a148-41cf-a310-43df19c12080`) confirms ready/200 and matching served/source fingerprint **b69717d9c665d257f255185d**, started **2026-10-07T17:22:48.127Z**. Current on-disk MemorySearch retains both `f.rank` expressions. Fingerprints include parallel changes, so this is not a controlled attribution of improvement to those two expressions.

Run `470e05d8-5bfd-48de-b897-705d07c014df` (both result pages reviewed) made 21 parallel rounds against catalog, projects, health and Vite static: **84/84 HTTP 200**, no timeout, catalog/project response shapes preserved. The first observed catalog request was **291.429 ms**; it is not proven to be the first request since dev startup or a cold-start measurement.

| Endpoint    | Subsequent samples |    Median |         p95 |     Maximum | ≥10 seconds |
| ----------- | -----------------: | --------: | ----------: | ----------: | ----------: |
| Catalog     |                 20 | 27.843 ms | 3760.528 ms | 3805.881 ms |           0 |
| Projects    |                 20 | 22.480 ms | 3689.205 ms | 3749.228 ms |           0 |
| Health      |                 20 | 21.749 ms | 3749.082 ms | 3806.104 ms |           0 |
| Vite static |                 20 | 16.332 ms |   28.504 ms |   29.192 ms |           0 |

**The earlier ten/fifteen-second episode is not reproduced in this bounded current-build observation, but latency is not fully resolved:** the 3.7–3.8-second common API/health wait remains. The worst projects runtime boundary was 0.485 ms (query rounded 1 ms), worst catalog boundary 115.388 ms (auth 111 ms); those inner times do not account for the entire wall time. Do not hide the outliers behind the medians or claim a universal p95 target was met. Per Goal v6/Plan v13, stop additional deep API/SQL investigation and proceed to final targeted regressions, retaining this remaining symptom explicitly.

Previous restart/missing-header/no-recurrence-pending statements below describe their **historical builds and observations**, not the applied-build status above. Existing history storage/bytes, independent UI/SSR/CSR measurements and 0.0.13 compatibility evidence are reused as approved, not presented as measurements of this latest parallel-refactored frontend. No new SQL integration suite, operating DB mutation, model generation, tool replay or assistant-initiated restart was performed.

### Final targeted regressions

Run `bc9348e0-01d2-4b2e-82fb-e5ac4aec1f27` (both pages reviewed) passed current search format/lint/type and **59/59 tests across eleven existing files**: search 11, memory maintenance 11, provider 13, stream contract 6, memory-store reasoning restoration 1, production SQLite-factory reasoning restoration 1, lease actions 4, run state 6, run notice 3, interrupt recovery 2, chat fetch 1. The maintenance warning is the intended failed-save recovery fixture. This is not a full repository test or fresh browser/performance/0.0.13 release-binary run.

Reviewed historical evidence remains separated: `performance-history-pagination.md` records bounded selected-group processing, complete unhinted model context, actual live page bytes **628,377 → 294,690**, preserved older cursor/content, and released-source/schema rollback. `performance-ui-history.md` records fixed identical-data independent render/mount **38.9 → 31.3 ms**, actual SDK/SSR/CSR boundaries, delayed catalog/error/fast-switch isolation and tool open/close/scroll. Those approved reused results do not prove the same timing for parallel-refactored frontend files today. No additional deep SQL tests were added.

## Approved limited verification update (2026-10-07)

Goal v6 / Plan v13 limit additional SQL checks to excessive retrieval and API investigation to recurring approximately ten-second delays after initial dev startup. The older equal-condition endpoint comparison below is historical remaining work, not an instruction to expand the current approved scope.

- Current source review: hinted production history reads dispatch directly to indexed projection snapshots; initial/older SQL uses a materialized limited page and metadata-only earlier-page probe. Only selected group JSON is decoded. Unhinted model context and explicit startup/import preparation retain complete originals. Existing native/reader tests pass **14/14** (`6e7f2f4d-0b9f-4831-ad07-f9248ecfe436`). No new deep SQL fixture or operating DB changes.
- Static checks pass for three current history projection files; existing subscription streaming, restoration (memory store and production SQLite factory), provider and full-loop owner/run regressions pass **36/36** (`3e626b6f-da26-48ca-9a1b-e8670b069a60`). The SQLite factory fixture uses an isolated in-memory DB, not the operating database.
- First current batch, twenty GETs per target, all 200 (`029b162f-a5d3-4806-b9c3-7c74d765cf04`): catalog median/p95/max **11.864/24.455/3800.442 ms**; projects **3.523/307.703/13681.608 ms**; document **7.297/252.269/857.162 ms**. The projects outlier exceeds ten seconds and must not be hidden by p95 or described as proven initial startup.
- Follow-up after that batch, twenty parallel rounds without restart/cache invalidation (`d2a10a02-37f6-4994-bdb1-97c7ad8c7de4`): catalog had an **18.052-second timeout** in round zero; its other nineteen requests succeeded. Projects and document each had twenty successful requests, maximum **7496.772 ms** and **5056.532 ms**. Catalog median/p95 **32.469/7839.056 ms** includes the failed sample and is not a success-only latency statistic. The script printed the shared error list on all three rows; only catalog failed.
- Listener process age was approximately **5 hours 54 minutes** when inspected. This is not a restarted-server experiment or proof of the request's layer warmth. A later idle CPU observation cannot establish what blocked the earlier requests. Projects uses a local service lookup, while catalog awaits auth status, provider list and selection through the same global shared ManagedRuntime; source review does not prove that the upstream catalog call caused the projects delay.

A later five-round phase probe (`464516af-46ed-4633-ba9e-5988a2cfabb8`, both pages reviewed) separates TCP connect, headers and body for catalog/projects/document and Vite's client module. All twenty requests returned 200; connects were 1.89–15.85 ms. The first catalog request spent 4141.72 ms to headers and only approximately 0.04 ms thereafter. Static client headers also took 576.89 ms, and projects/document approximately 379/374 ms in that round. Later catalog responses were 80–344 ms. This probe did not reproduce the ten-second episode and cannot retroactively locate its cause; it does show that catalog queue/upstream/header waiting and shared dev-server delays must not be confused with history response transfer or pure database processing. No source/runtime reload or private error/body logging was introduced.

A delay over ten seconds occurred in both earlier batches, including a subsequent timeout. Therefore the no-recurrence shortcut is not met. Keep `perf-api` in progress and narrow investigation to these observed delays; do not expand SQL validation or claim the original symptom solved.

## Diagnostic source versus running backend

Two GET routes now add safe numeric `Server-Timing` stages only in Vite DEV or the explicit native `--dev-backend` mode. Catalog records registry/auth/catalog/selection and runtime-boundary; projects records service/query and runtime-boundary. Domain time uses Effect Clock/DateTime; the outer Promise adapter uses monotonic host performance time. The boundary includes inner stages, so these durations are not additive. Production without either development mode skips the extra Clock work and does not receive timing headers. Response JSON, provider validation, auth/status handling and project POST remain unchanged.

- 2026-10-31: GET /api/projects moved to the app API (`docs/httpapi-migration.md`). Its service/query stages are gone; every request `serveApi` answers carries one `handler` stage, under the same development condition. Inner stages are read from spans.

- The initial route format/lint/type check passed (`0dc6a101-f769-422c-8023-5975f58bae53`). A first probe had a Python built-in shadowing bug and produced no valid timing evidence (`56063ced-d4c0-40ae-804a-53840562c3a0`); it is not an API failure.
- The repaired probe (`0add8191-d97a-484f-a731-2e5799816e5a`, both pages reviewed) returned twenty-four HTTP 200 responses in eight parallel rounds. Catalog/projects JSON shapes were preserved. All timing headers were absent, so internal-stage verification did **not** pass. The first catalog request was 3.522 seconds; round six had catalog 8.774 seconds and projects 8.611 seconds while static was 12 ms. This is another delay observation, not measured timings of the modified route implementation.
- Listener cwd matches this repository, but dev.ts builds and starts a **no-HMR bundled backend**, while Vite proxies `/api` to it. Vite's DEV constant alone is false in that production-style bundle; the guard was repaired to recognize the existing explicit `--dev-backend` CLI flag.
- Read-only health/source comparison (`039540c6-d17f-45bb-860c-d1dd6ab0d012`) confirmed the running backend was ready and started at **2026-10-07T05:02:55.261Z**, but its served build ID `8a115067e5a3625e1b89fc0f` differed from the then-current source fingerprint `c984271dc841b19cd67b7837`. Subsequent guard edits also require a rebuild. Current-source unit/static checks must not be presented as current-source live API proof.
- Live verification requires a coordinated rebuild/restart of that stable backend after preserving active runs and the parallel refactor. No restart, account change, tool replay, operating DB modification or automatic HMR removal was performed here. The cause of the original approximately ten-second delay remains unconfirmed; SQL validation is not being expanded.

## Post-restart current-build verification (2026-10-07)

The user reports restarting dev. Fresh health (`cb903cbf-4820-42ff-8698-b197038bb83f`) confirms HTTP 200, ready, backend started **2026-10-07T12:36:08.954Z**, and matching served/source fingerprint **2e95ca3c1c89afddf3d43d2f**. The prior stale-build/restart dependency is resolved. This does not establish that the first observed request is the first request since startup.

Run `150b8c48-c915-4cb3-a37a-32914a001c88` performed one first observation and twenty subsequent parallel rounds against catalog/projects/Vite static. All 63 responses returned 200; existing catalog/project JSON shapes and their diagnostic headers were present in every sample.

| Endpoint    | First observation | Subsequent median | Subsequent p95 | Subsequent maximum | Subsequent ≥10s |
| ----------- | ----------------: | ----------------: | -------------: | -----------------: | --------------: |
| Catalog     |       3811.178 ms |         31.951 ms |     167.919 ms |       15035.428 ms |               1 |
| Projects    |        463.333 ms |         26.288 ms |     158.406 ms |       15036.566 ms |               1 |
| Vite static |         30.642 ms |         12.023 ms |      33.250 ms |          40.405 ms |               0 |

The slow catalog headers arrived at 15033.334 ms, while its runtime boundary was **1584.037 ms** (auth 1584 ms; catalog 0 ms). The slow projects headers arrived at 15034.122 ms, while its runtime boundary was **0.332 ms** and query was timer-rounded 0 ms. Neither these route-inner metrics nor a zero-rounded duration prove zero cost or locate the entire delay. They show that the fifteen-second wall-time sample cannot be presented as fifteen seconds of the projects SELECT or catalog model-list call. The first catalog's distinct 3323 ms catalog phase belongs to its 3.811-second first observation, not the later fifteen-second outlier.

The no-recurrence condition is still **not met**, now on a verified current build. Investigate only the transport/pre-handler/post-handler gap: pair direct backend/proxy requests and a health endpoint that bypasses the Router; do not expand SQL validation or claim the historic symptom resolved.

A direct/proxy attempt (`380fdba4-764d-41ee-9540-45d5448951dd`, all four pages reviewed) used the wrong IPv4-only address for the frontend. Its proxy `ConnectionRefusedError` samples are setup errors, **not** evidence of proxy latency or backend outage. The direct backend samples are valid: all 36 GETs returned 200 with the same build/start time. In round two, TCP connected in less than 1 ms, yet the Router-bypassing health headers took **6269.105 ms**, projects **6270.461 ms** and catalog **6264.504 ms**. Projects runtime was **0.249 ms**, catalog **124.623 ms**. Thus another shared delay is observable directly at the backend, even without a Router or database query in the health handler. This rules out a proxy-only explanation for that particular 6.27-second episode, but does not prove which backend or host operation stalled processing. The twelve direct rounds did not themselves exceed ten seconds; they do not erase the fifteen-second current-build outlier above. A bounded corrected localhost/proxy comparison follows; no listener or networking configuration was changed. No operating DB write, model generation, tool replay, cache invalidation or assistant-initiated restart was performed.

The corrected localhost frontend comparison (`6a612e2b-9ba8-42df-92a7-904edefb58d0`) had 32/32 HTTP 200 responses. Maximum direct health was 75.810 ms, direct projects 75.650 ms, proxy projects 76.297 ms, but proxy health reached **7265.780 ms**. This is an additional delay observed through the proxy path, not proof that the proxy itself imposed the wait: upstream servicing may have occurred at a different moment. Do not generalize this episode or the earlier direct-backend episode to all outliers.

A three-second native process sample (`7e055b94-7b1f-4dc8-a876-804657f9adcf`) identified the backend's main thread and observed SQLite stack frames (99 lines containing sqlite3, 127 containing sqlite), with no turbovec/SpawnSync/waitpid markers in that sample. These are **stack-line counts, not sampled CPU percentages or additive timing**, and were not captured at the exact fifteen-second outlier. They are a lead for synchronous backend work, not proof of an excessive history query, lock wait, or the offending SQL statement. Raw stacks/arguments/credentials were not printed; the temporary profile was removed. No SQL integration checks were added.

## Bounded FTS investigation and minimum repair (2026-10-07)

An eight-second native main-thread sample paired with direct health (`0ca7cc0d-dd36-4245-8726-95b9c59b83ef`, both pages reviewed) observed 14 health requests; the two slow samples were **2150.05 / 4222.61 ms**, HTTP 200. Native stack function tokens include `StatementSync::All`, `StatementSync::Get`, `fts5Bm25Function`, `sqlite3Fts5IndexQuery`, and FTS cursor traversal. These are function/stack-line observations, **not CPU percentages**, SQL text, or proof that the earlier fifteen-second outlier was this exact query. No raw stack arguments/credentials were printed, and the temporary profile was removed.

Source inspection confirms `DatabaseSync` is shared synchronously (`db/database.ts`), with a 5000-ms busy timeout; that setting is not proof of a lock wait and was not changed. `Indexer` already limits pending text batches; its count and joins remain candidates, not diagnosed outliers. `MemorySearch` has FTS morphology/text SELECTs with project/meaningfulness filters and `ORDER BY bm25(...) LIMIT ?`. The result limit alone does not avoid scoring/sorting matches before returning rows.

A **30-row isolated in-memory query-plan check**, not a new SQL integration suite, compared existing text ranking with `ORDER BY f.rank LIMIT ?`. Both returned the exact same six ordered IDs with the same excluded-project filter. The old plan contains `USE TEMP B-TREE FOR ORDER BY`; the hidden-rank plan uses FTS virtual index `32:M1` and omits that temporary sort. This proves that narrow plan change, not a live latency speedup or a bound on every internally scanned FTS match.

Only the two FTS ORDER BY expressions in `src/memory/search.ts` were changed to the FTS default BM25 hidden-rank order. Filters, limits, fusion, provenance/correction metadata, original records, model context, owner/run/approval/lease and schema are unchanged. There is no schema migration/backfill/rollback step; reverting those two expressions is the code rollback. No custom rank configuration was added. This is a source-supported excessive-sort repair candidate, not a claim that all backend/proxy stalls are fixed.

- Current changed-file `vp check` passed format/lint/type. Existing search and memory-maintenance regressions pass **22/22** (`573947bd-09dd-40ad-a627-e073a9dbf0d8`). The warning in the maintenance output is the intentional failed-index-save recovery fixture, not a failed check.
- Existing catalog cancellation/public streaming/error/restoration regressions separately pass **21/21** (`1b620b5a-f7b4-4cdf-9414-bdc87dff8594`), including the already-existing isolated SQLite restoration test. No new deep SQL tests were created.
- After the repair, public health is ready/200 but served fingerprint is still **2e95ca3c1c89afddf3d43d2f**, while current source is **871db2fc509289ba19616103** (started **2026-10-07T12:36:08.954Z**). This new FTS repair is not yet served by the no-HMR backend. Current-source tests must not be presented as live repair verification. Safe owner-coordinated rebuild/restart is required before the remaining live recurrence check; no arbitrary service stop/restart was performed.

## Latest continuation checks (before restart)

- Final two-route code, including the stable backend CLI guard and disabled production Clock measurement, passed format/lint/type (`74146674-65c7-4d41-849b-96d7ff62400b`). Both evidence/decision documents passed formatting (`a8b29274-b054-44e4-8111-cc0c88641f23`).
- A new read-only health check still returned the same ready backend/build/start time, while the current source fingerprint was `301e6fde3dc086d86dd5fdb1`. The server has **not** adopted the current source. Fingerprints describe the whole backend source boundary, not just this task's edits; parallel refactoring is included.
- Independently of the running backend, existing lease-actions, use-run-state, run-notice, interrupt-recovery and chat-fetch tests pass **16/16** (`aac8cfd5-92f0-46ae-8d37-54230f0d9aeb`). These are current-source unit regressions, not live routing/phase timing evidence.
- Rebuild/restart must be coordinated with the current backend owner and parallel refactoring, preserving active operations. The verified app `dev` script rebuilds and starts the backend plus frontend. In `apps/agent`, the existing command is `vp run dev`; do not start a second copy on occupied ports or change the existing storage configuration. No service stop/restart was attempted in this continuation.

## Current-source regression

- Background run `90725959-8ea7-4fd8-b46f-d0e0323c0168` passed all 79 tests across subscription provider, adapter, OAuth validation harness, account-bound client, and stream contracts.
- Earlier run `2e35f3dc-04e4-4d92-af3f-8124c4e74af2` also passed 79 tests and format/lint/type checks for four changed files. It is historical evidence, not another independent 79 tests.
- Run `d92ebaa9-5264-44ce-938f-3a00c50923d1` passed the additional public reasoning restoration integration test and its format/lint/type checks. Real SDK `chat` → `withPersistence` → `reconstructChat` restores public thinking/text, retains the opaque signature in the model snapshot, and excludes opaque content from visible text. The fixture uses an in-memory message store, not production SQLite; the 79-test run does not include it.

## Streaming contracts

Public summary state has explicit per-stream limits: 2,097,152 text characters, 256 summary parts (including completed parts retained for duplicate detection), and 512 characters per upstream item ID. These are character limits, not byte counts. Exceeding them fails explicitly; it is not successful truncation, transcript compression, or decryption of private reasoning.

Duplicate starts, conflicting completion text, events after completion, and incomplete summary exhaustion fail with a safe typed protocol error. Unfinished native tool/reasoning blocks cannot produce a successful `RUN_FINISHED`. Overlapping native block indexes cannot overwrite pending tool associations. Owner abort does not become a successful completion or expose an upstream error body. These negative paths are exercised by the stream-contract tests; they do not prove that the originally reported live tool incident had this cause.

## Controlled catalog comparison (historical replay)

Run `b7a93f9c-c065-4dec-bed2-3e17dd6e1b82` used the same synthetic native catalog with a serialized 20 ms operation, eight concurrent cold requests, and twenty subsequent warm requests. The baseline replay directly fetches and parses the catalog; the improved side calls the production subscription provider's shared catalog path.

| Measurement                           | Uncached replay | Shared catalog |
| ------------------------------------- | --------------: | -------------: |
| Cold batch, 8 requests                |      175.117 ms |      21.428 ms |
| Cold request median                   |      109.857 ms |      20.812 ms |
| Cold request p95 (8 samples)          |      173.662 ms |      21.375 ms |
| Warm request median (20 samples)      |       21.271 ms |       0.009 ms |
| Warm request p95 (20 samples)         |       21.914 ms |       0.078 ms |
| Native catalog calls, all 28 requests |              28 |              1 |

This demonstrates duplicate-work and queue-wait avoidance under the stated serialized fixture. It is not live provider latency, HTTP endpoint p95, browser main-thread blocking, or proof that the historical approximately 12-second catalog wait is resolved. The cold p95 is descriptive for only eight samples. A fresh equivalent measurement after all parallel refactoring and the slow endpoint comparison remain separate work.

## Current live read-only observations

Run `bb8d6b63-efe4-43d4-a620-beec444ce077` consumed each response from localhost:5173 without printing response contents or changing state. Each target returned twenty successful responses:

| Endpoint |    Median |        p95 |
| -------- | --------: | ---------: |
| Projects |  3.783 ms |   9.501 ms |
| Document | 22.928 ms | 104.943 ms |

These are current observations, not a controlled before/after improvement. They do not measure the slow catalog endpoint, SSR hydration, UI commit/layout, or database writer blocking. No provider generation, tools, production DB writes, account changes, or service restart was performed by these checks.

## Remaining acceptance work

- The SDK reconstruction fixture passes; production SQLite integration and live provider reproduction must not be inferred from its in-memory message store.
- Compare the actually slow endpoint under equivalent conditions and keep server processing, upstream queue wait, and UI blocking separate.
- Verify owner/authorization/run/approval integration contracts against the current refactored source and run the final consolidated regression.
- Keep the measured history writer regression and cold preparation costs visible; neither catalog caching nor reduced UI payload demonstrates their elimination.
