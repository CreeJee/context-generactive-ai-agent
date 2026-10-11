# Async native memory search — ownership and boundary baseline

Date: 2026-10-09 (Asia/Seoul). Goal v7 / Plan v15. Older baselines below are historical; the current public-service comparison is recorded separately.

## 2026-10-10 served executable observation

Before the single-path migration, the actual packaged `apps/agent/dist/context-agent.mjs` was measured once with the then-default legacy composition and once with the native composition temporarily substituted for comparison. Each arm used three fresh processes, a distinct temporary `--storage` directory, loopback-only `--no-open`, and measured from process spawn through successful `/api/health` and `/api/projects`; RSS was sampled from that server PID after the projects response. No user storage, credentials, model call or external network was used. The production composition now always uses native search; this table remains the historical before/after baseline, not a selectable rollback mode.

| Metric                                    |            Legacy |            Native | Native delta |
| ----------------------------------------- | ----------------: | ----------------: | -----------: |
| Median startup + first projects response  |         577.13 ms |         736.23 ms |   +159.10 ms |
| Median server RSS after projects response |        331.25 MiB |        396.58 MiB |   +65.33 MiB |
| Observed startup range                    |  557.60–720.91 ms | 728.64–1527.41 ms |            — |
| Observed server RSS range                 | 330.11–334.20 MiB | 394.92–397.13 MiB |            — |

This is a served production executable observation with an empty temporary database and warm OS/build caches, not OS-cold startup, steady-state loaded memory, or a claim that the earlier fixture regression disappeared. In particular, the prior same-workload public-service fixture remains approximately **126–137 MB higher median RSS** and approximately **169 ms higher scoped Layer startup** for native. The served executable still shows a material +65.33 MiB median RSS and +159.10 ms median startup/first-response cost, including a 1.53 s first native run. Both measurements remain part of the stability gate; neither is described as an improvement.

## Step 07: current public `MemorySearch` paired comparison

The existing finite service fixture now selects legacy or native while keeping the same public `MemorySearch.find` path, 10,000 rows, deterministic 384-dimensional vectors, 4-bit index, query, k/limit, project scopes, 20 warm rounds and loopback control workload. Three independent processes per backend were run. This is filesystem-temporary service composition with the current addon fingerprint, not the served application endpoint or true OS-cold production traffic.

| Metric                                |           Legacy |           Native |
| ------------------------------------- | ---------------: | ---------------: |
| 1-project warm median search          |         30.48 ms |         29.44 ms |
| 1-project warm p95 range              |   31.63–32.17 ms |   29.91–31.08 ms |
| 2-project warm median search          |         37.78 ms |         35.49 ms |
| 2-project warm p95 range              |   38.76–39.91 ms |   35.97–39.93 ms |
| 1-project event-loop p95 range        |   31.67–32.36 ms |     1.59–1.75 ms |
| 2-project event-loop p95 range        |   38.93–39.94 ms |     1.44–1.56 ms |
| 1-project concurrent control HTTP p95 | 603.01–614.23 ms |     1.83–4.83 ms |
| 2-project concurrent control HTTP p95 | 756.29–783.81 ms |     1.59–1.62 ms |
| Host-visible SQL executions/search    |        185 / 186 |        132 / 133 |
| Median RSS, 1 / 2 projects            | 319.7 / 322.4 MB | 445.6 / 459.6 MB |
| Scoped layer startup median           |         42.14 ms |        210.91 ms |

The public path therefore confirms the intended scheduling effect: candidate/vector/FTS/morph acquisition no longer blocks the main isolate, and the loopback control stays responsive during a continuous 20-search burst. End-to-end search wall time improves modestly, not by orders of magnitude, because TypeScript graph expansion and per-result metadata/provenance assembly remain on the host; the 132–133 host-visible executions expose that residual cost. Native internal SQLite is on a separate read-only connection and is not counted by this host proxy; the repaired same-fixture boundary result above separately measured ten native SQL executions, 0.744 ms main-thread CPU and 1,620 logical input bytes instead of 55, 30.577 ms and 40,802 bytes.

The migration decision does not turn these numbers into an improvement claim: the fixture shows roughly 126–137 MB higher median RSS and about 169 ms higher scoped startup, and its HTTP probe is a scheduling control rather than the real application endpoint. Native search is now the only production path, so failure is explicit rather than routed to the removed host fallback. CPP scoring remains non-preemptible once entered, FTS work is bounded by request admission but not hard-preempted, and this does not explain or claim removal of the earlier 3.8-second application delay. Raw samples, source/addon fingerprints and accounting notes: `native-search-public-service-2026-10-09.json`.

## Step 04-repair: Rust-owned control, current-build paired comparison

Removed JS SAB backing-store atomics, pointer-as-usize SQLite callbacks, brand/intrinsic lookups and Node clock run_script. The host registers Arc<AtomicBool>/Instant control before large input validation/copy/queueing; worker/native conversion uses the same control. Only bounded identity/budget scalar conversion precedes registration. A host-private UUID seed plus never-recycled native serial prevents issued-token reuse without an unbounded tombstone set. Claims are one-shot and owner/epoch/request-bound. Explicit read cleanup confirms rollback/autocommit; failure poisons the connection and terminates its owner.

A rebuilt addon reran the exact same one-worker/index, temporary WAL fixture: 10,002 candidates, 384 dimensions/4-bit/k48, 13 alternating pairs. IDs/scores/text/morph/coverage matched in every pair. Twelve warm pairs:

| Metric                       | Legacy boundary median | Repaired native-read median |
| ---------------------------- | ---------------------: | --------------------------: |
| Wall ms                      |                 34.424 |                      25.704 |
| Main thread CPU ms           |                 30.577 |                       0.744 |
| Worker N-API boundary CPU ms |                  1.163 |                      24.658 |
| Vector stage wall ms         |                  1.148 |                       0.169 |
| SQL executions               |                     55 |                          10 |
| Reported input logical bytes |                 40,802 |                       1,620 |

The actual direct-ABI cross-worker control harness used 20 calls on an ephemeral 50k/384/4bit index with main-isolate GC. Five main-thread Rust-owned cancel calls were timestamped inside synchronous N-API windows and all returned cancelled; 15 after-completion calls returned success. SAB is now only a JS measurement gate, never native cancellation storage. These timestamps include N-API conversion, not a scoring-midpoint hook; no CPP mid-scan preemption/hard deadline claim.

Current source/addon fingerprints and raw paired/visibility observations are in `native-search-rust-control-2026-10-08.json`. Native eight tests/release build passed; targeted format/lint/type and real ABI/worker/read tests passed. This remains isolated boundary qualification: no public MemorySearch integration, true OS-cold, concurrent general API/RSS or production/default-activation conclusion. Logical bytes are DTO accounting, not exact wire bytes; outputs use different old/new metadata accounting. Worker boundary CPU includes SQL/FFI, not pure engine CPU. Historical SAB normal-path tests below do not prove the removed unsafe boundary sound.

## Historical step 04: pre-safety-repair read-boundary comparison

`tools/native-search-read-paired.ts` uses one NativeOwner Layer, one worker/index and temporary WAL fixture; 10,002 authorized vector candidates, 384 dimensions/4-bit, vector k48, text/morph k2 with two short terms. Both arms score vectors in that same worker. Legacy-boundary enumerates candidates/converts strings in JS and maps each hit with a SELECT; native-read keeps candidates and batch mapping in Rust and executes text/morph/coverage there. Thirteen alternating pairs matched IDs/scores/channel order/coverage exactly. First-call samples are separate but share caches, not true OS-cold.

| Warm metric (12 pairs)       | Legacy boundary median / p95 | Native read median / p95 |
| ---------------------------- | ---------------------------- | ------------------------ |
| Wall ms                      | 33.805 / 35.021              | 25.981 / 26.696          |
| Main thread CPU ms           | 30.551 / 31.300              | 0.533 / 0.745            |
| Worker N-API boundary CPU ms | 1.183 / 1.317                | 24.954 / 25.608          |
| Vector stage wall ms         | 1.172 / 1.307                | 0.168 / 0.299            |
| SQL executions               | 55                           | 10                       |
| Reported input logical bytes | 40,802                       | 1,620                    |

CPU uses `process.threadCpuUsage`, not wall-minus-wait or whole-process CPU. Worker boundary includes N-API conversion and, in the native-read arm, all SQL; more worker CPU is expected when main-thread SQL is offloaded. Vector-stage wall improvement includes removed allowlist conversion and must not be labelled pure engine CPU improvement. Logical byte counters are DTO accounting, not exact wire serialization; the new host preflight separately charges eight bytes per entry. Output is bounded by the requested successful payload budget; raw native logical output is 1,291 bytes, while old final JSON is 902 with different accounting/metadata, so those are not a valid wire-size speed comparison. Tiny budgets return a separate fixed failure envelope, not partial success.

The reviewed empty-string-array loophole is repaired before Schema decoding/copying. Native now samples the absolute Node hrtime deadline after N-API conversion, retaining elapsed preparation/queue/transport budget. Four native tests (including actual interrupted ReadGuard/rollback/fresh snapshot), four TS files/seven tests, release build and seven-file format/lint/type passed on the measured build. Source/addon fingerprints and safe raw samples: `native-search-read-paired-2026-10-08.json`.

This is boundary qualification, not the full-service stage-01 before/after workload or concurrent API/RSS qualification. It establishes actual offload/transfer/SQL improvement for this fixture, not production default activation, generation consistency, fully bounded internal FTS match work, hard CPP preemption or removal of the earlier 3.8-second latency. Publication/MemorySearch integration remains step 05 and full qualification remains steps 06–07.

## Worker transport foundation (step 03, implementation in progress)

The new `native-search/worker.ts` owns one native index/CacheLease on threadId>0. `client.ts` manages request Deferreds, removable Ref-owned admission, a capacity-one Queue wake signal and scoped receiver/dispatcher fibers. Actual native add/search/save and lease exclusion/reacquisition passed real Worker tests. A gated host test proves the 32-admission limit, queued Fiber interruption freeing capacity, and worker termination settling remaining waiters. Initial lint/type issues were repaired; no pass is inferred from a running task.

The worker is registered in the package export/checkout resolver and `.mjs` packaging entries. A deployment-style worker bundle was built in temporary storage and native ready/close smoke succeeded with file-compatible worker flags. This is not a complete packaged-app/current-served-build verification. The app's default search runtime has not been switched.

Still required: active/native abort budget and SQLite progress hooks, publication/gen integration, and the additive Rust high-level read session. Fixed-workload native responsiveness is now observed below; broader SQL/API behavior remains unproven. Low-level compatibility commands still accept vector allowlists; the high-level request contract deliberately does not. Do not report this transport foundation as completed candidate-bridge elimination or production speed improvement.

## Concurrent cancellation visibility / GC observation

The finite `tools/native-search-control-visibility.ts` direct-ABI harness uses one ephemeral 50k/384dim/4bit index in a dedicated worker, temporary Int32Array views, fresh per-request SAB cells, and main-isolate forced GC. It timestamps the main shared write against the worker's entire synchronous N-API window; the main Atomics waits are measurement gates only, not server orchestration.

- Early 2ms observation: 20/20 shared writes inside N-API windows returned cancelled; main GC ran 20 times. Reported Rust-body times were only 0.004–0.090 ms, so these predominantly caught pre-engine cancellation during FFI conversion, not running scoring.
- Varied 2/5/8/12/20ms offsets: six writes timestamped inside the N-API window all returned cancelled; 14 writes after completion returned success. Main GC ran 20 times. Two in-window cases had nontrivial Rust-body times (2.51/4.36 ms), but there is no scoring-midpoint instrumentation, so do not label this mid-scan preemption.
- Both finite runs exited successfully and the final harness passed format/lint/type. No persistent cache, extra writer or application DB was opened. Raw runs/fingerprints: `native-search-control-visibility-2026-10-08.json`.

This verifies concurrent shared visibility/result discard for this workload. It is not forced worker-isolate GC, adversarial-realm safety, arbitrary-size cancellation latency or a hard deadline. Preserve those limits through high-level integration/default-activation review.

## Actual native-call / main-thread overlap observation

`tools/native-search-worker-responsiveness.ts` uses the actual NativeOwner Context/Layer, client dispatcher and production worker with scoped temporary cache storage. It seeds 50,000 normalized 384-dimensional vectors (4-bit, k=48), then executes ten searches. Worker monotonic timestamps bracket the synchronous N-API call; independent main-thread heartbeat timestamps are counted strictly inside each interval, rather than before/after a request. Query/allowlist preparation occurs outside these native-call windows.

The successful run observed worker threadId=1, ten native-boundary spans of 5.39–5.85 ms, and **4–5 main-thread heartbeats inside every span**. Thus the actual native-call boundary does not monopolize the main thread for this fixed workload; this is not a Promise-only wrapper. It does not prove pure inner native CPU, SQL/graph offload, active CPU cancellation, a worst-case bound for arbitrary index sizes, or end-to-end application API improvement.

Safe raw intervals/counts and source/client/addon fingerprints: `native-search-worker-responsiveness-2026-10-08.json`. The initial harness lint found runtime import of a service constructor; the host now exposes an owning Context service/Layer and the harness yields that service. Final harness/client/worker/protocol format/lint/type and finite execution passed. Runtime callers must use the owning Layer, not import the test constructor into domain flow.

## Confirmed source boundary

The current server runtime supplies Database, VectorIndex and MemorySearch together (`src/layers.ts:150–155,229–235,285–287,317–321`). MemorySearch materializes every allowed vector sequence in JS, converts the allowlist to strings through VectorIndex, and maps each returned sequence with a separate SELECT (`src/memory/search.ts:211–229`, `src/memory/embedding/vector-index.ts:170–179`). The Rust binding is synchronous (`packages/turbovec/src/lib.rs:68–81`). Its owning-worker comment and the loader's worker recommendation are not proof of an actual worker boundary.

The read-only ownership audit traced the server singleton through owner tool execution: Goal/full-loop workers proxy tools back to the owner, and automatic recall also executes at the owner. Kiwi and embedding workers analyze input/model vectors, not SQLite/vector ranking. No existing search-owning worker was found. This is source-path evidence, not an attached live-server thread measurement.

The VectorIndex Layer owns one native handle and its CacheLease; Scope closes the lease. Publication currently orders native add, snapshot save/rename, then committed SQLite vector mappings. Maintenance records durable removal intent before remove/save/cleanup. Preserve these orderings; moving the handle must move its lease to the same single owner, not open another index Layer.

The central Database is not the only SQLite connection: the import worker has an existing separate writer connection. “Single writer” in the new search design means preserving the vector-cache writer lease and existing storage authority, not assuming all database writers already share one thread. New search connections must be read-only.

## Reproducible fixture

Run `node --no-warnings tools/native-search-baseline.ts`. This is a finite, synthetic in-memory SQLite/N-API boundary fixture, not a production workload replay. It creates no application DB or vector-cache file and calls no model service. All synthetic rows are eligible/meaningful; it omits the production quality predicate because the reduced fixture schema has no suppressed or empty rows.

- Node v26.8.2, normalized 384-dimensional vectors, 4-bit index, k=48.
- 10,000 and 50,000 rows, evenly divided among four projects; one-project and four-project searches.
- One first-call observation followed by 20 consecutive warm searches per case. The first observation is **not** process-cold, OS-cache-cold or production cold startup.
- Text FTS uses trigram; morphological FTS uses fixed pre-analyzed terms and the fixture's default FTS tokenizer. It does not execute Kiwi.
- Four concurrent independent worker HTTP clients make five GETs each to a loopback control handler hosted on the searching main thread. Its p95 is a scheduling control, **not** the actual application API p95. A 20-search synchronous burst deliberately represents continuous saturation, not normal production interarrival spacing.
- Three independent process runs. Numeric raw results and source/addon fingerprints: `native-search-baseline-2026-10-08.json`.

|   Rows | Projects | Allowed candidates | Warm search p95 range (ms) | Saturated control HTTP p95 range (ms) | Event-loop maximum range (ms) |
| -----: | -------: | -----------------: | -------------------------: | ------------------------------------: | ----------------------------: |
| 10,000 |        1 |              2,500 |                12.78–13.47 |                         248.92–259.18 |                 249.56–259.65 |
| 10,000 |        4 |             10,000 |                16.49–16.61 |                         315.42–322.30 |                 317.19–320.34 |
| 50,000 |        1 |             12,500 |                64.88–66.88 |                     1,251.16–1,288.48 |             1,252.00–1,289.75 |
| 50,000 |        4 |             50,000 |                80.51–83.20 |                     1,534.12–1,602.41 |             1,535.12–1,603.27 |

Idle control HTTP p95: 1.23–1.67 ms. All 240 saturated-control GETs across the three runs returned 200. The fixture directly records `isMainThread: true, threadId: 0` for the SQLite/native search calls.

### Boundary costs, 50,000 rows / four projects

- Candidate SELECT/materialization p95: 17.39–20.43 ms; JS string conversion p95 about 1 ms.
- Native-call wall p95: 5.61–5.90 ms. Calling-thread CPU within the native boundary p95: 5.18–5.44 ms. Both include N-API ID parsing/output conversion; this does **not** isolate turbovec's inner algorithm CPU.
- First run text/morph FTS medians: 30.24 / 22.91 ms. The larger cost is SQLite/FTS work, not just JS string conversion. Eliminating the allowlist bridge alone cannot eliminate that work.
- Canonical candidate ID UTF-8 payload: 238,894 bytes, versus 1,442 bytes for the fixture's bounded mapped/text/morph result JSON. ID bytes exclude V8 object/array/UTF-16 storage and N-API allocations; response JSON is a size proxy, not actual N-API wire encoding.
- SQL calls per search: 51 (one candidate query, 48 per-hit ID lookups, two FTS queries). This excludes Graph/provenance/coverage/project-name queries in the full service.
- Largest observed candidate JS heap delta: approximately 15.2 MB. After-case RSS ranges 300.5–398.3 MB for this case, and up to 418.1 MB in the preceding case. Fixture construction, retained matrix/index allocations and GC timing affect RSS. These are observations, not precise native residency or a memory-regression threshold.

## Actual production-service fixture

`tools/native-search-service-baseline.ts` runs the real Database migrations, Graph, VectorIndex and MemorySearch Layers with scoped temporary storage, deterministic fake embedding and fixed morphological terms. It seeds 10,000 eligible user nodes in two projects and same-project related edges; no application storage, credentials or network model calls are used. Find limit is 12, first-call plus 20 warm calls per mode. Runtime uses Effect service composition and Scope finalizers; host timer/HTTP Promises are measurement-only boundaries.

Parent-side independent `vp check` on both tools and finite service execution passed. In that fresh run:

| Mode           | First call (ms) | Warm median / p95 (ms) | Event-loop p95 (ms) | RSS after case (MB) |
| -------------- | --------------: | ---------------------: | ------------------: | ------------------: |
| Single project |           38.36 |          30.95 / 32.23 |               32.37 |               258.2 |
| Both projects  |           40.10 |          38.67 / 40.38 |               40.47 |               259.9 |

The fixture checks 12 results, no degradation, no unindexed rows, and no cross-project leakage in single-project mode. Thread ID is 0. SQL call count is not instrumented in this service fixture. The separate idle HTTP control p95 of 1.54 ms is **not concurrent with search**. Post-call turn latency does not measure the preceding blocked interval; use the histogram instead. First-call is after fixture preparation, not true process/OS cold startup. Raw parent-run results/fingerprints: `native-search-service-baseline-2026-10-08.json`.

The full-service fixture and the reduced boundary fixture intentionally have different embeddings/schema/corpus; do not compare their elapsed times as an optimization result. Each must be paired with itself after implementation.

## Separate live API observation

A fresh, read-only `/api/projects` observation at localhost:5173 made four concurrent requests in each of five rounds: 20/20 HTTP 200, median 3.00 ms, p95 62.77 ms, maximum 63.33 ms. No response contents were logged. Raw aggregate: `native-search-live-api-baseline-2026-10-08.json`.

This is an application endpoint, unlike the fixture's control handler. Owner activity was not controlled and the served build fingerprint was not checked in this observation, so it is a separate current-state observation, not a paired performance result or production cold-start measurement.

## Final paired baseline: file/WAL, SQL count, startup and concurrent control

The current service harness uses a scoped **temporary file/WAL database**, not `:memory:`, so the future native read-only connection can reopen the same fixture storage without changing the corpus or workload. The earlier in-memory records are retained as historical observations, not interchangeable old/new baselines. Raw three-run file/WAL results and final harness/probe fingerprints: `native-search-service-file-baseline-2026-10-08.json`.

| Projects | Warm search p95 range (ms) | SQL executions/search | Preparations/search | Search-concurrent control HTTP p95 range (ms) |
| -------: | -------------------------: | --------------------: | ------------------: | --------------------------------------------: |
|        1 |                31.80–33.42 |                   185 |                   6 |                                 608.13–623.57 |
|        2 |                39.63–41.50 |                   186 |                   7 |                                 765.50–777.21 |

Executions count actual `all/get/run/exec` invocations through a bound SQLite instrumentation wrapper, excluding fixture seeding. Preparations are separate; preparation is not counted as execution. Counter overhead is included and must remain enabled in both old/new comparisons. The 51-query boundary fixture omits Graph and metadata work and cannot replace these full-service counts.

Concurrent control has four independent worker clients × five GETs while the owner runs a fixed twenty-search burst. All 120 concurrent GETs across the three file/WAL runs returned 200. The one-project idle probe includes the client's first fetch initialization (p95 10.33–14.16 ms); two-project idle p95 is 1.26–2.83 ms. This handler still is **not** a production application endpoint.

Fresh-process startup to empty fixture services: scoped Layer setup 42.39–46.12 ms, total process elapsed including imports 448.72–568.81 ms. This is genuine new-process fixture startup, not production backend startup or an OS-cache-cold measurement. First searches run after deterministic fixture seeding and are labeled separately.

### Frozen comparison rules

These operational criteria implement step-01's approved requirement to establish noise/budgets after baseline; they do not authorize additional implementation scope.

- Preserve deterministic results/project isolation/ties/metadata and existing recall criteria before interpreting performance. No quality loss is exchanged for speed.
- Repeat both paths in three fresh processes, same corpus/vector/terms/limit, separate single/two-project modes, same twenty-search burst and four-client control. Keep initial fetch, first search, Layer startup and warm measurements separate. Fingerprint source/addon on every comparison.
- Use 15% or 5 ms (whichever is larger) as the warm-search p95 non-regression allowance. File/WAL anchors are 33.42/41.50 ms; a result exceeding the allowance is not default-enabled.
- Require event-loop p95 and saturated control HTTP p95 to improve by at least 50% in each mode, with control HTTP p95 ≤20 ms, over all three runs. The measured baseline variation is well below these effect thresholds. An uncontrolled live API sample cannot substitute for this comparison.
- Compare total-process observed RSS including the worker at matching fixture phases; allow at most 64 MiB additional peak-observed RSS versus the worst old-path run. Report retained arrays/SQLite cache/GC limitations rather than calling endpoint samples an exact memory peak. A native memory leak or unbounded accumulation is an independent failure even below this allowance.
- New-process startup budget: additional owner/worker setup ≤500 ms relative to the matching old fixture; report module import time separately. Do not claim an improvement in the user's full dev startup from this number.
- Runtime contract budgets to finalize in step 02: ≤32 admitted searches, one active search at the index owner; search timeout/default work budget 2 seconds; queued abort settles within 50 ms and active abort acknowledges within 100 ms. CPU work that cannot interrupt immediately must terminate by its own finite budget, not merely abandon a Promise. These are upper bounds, not a reason to delay ordinary responses.
- Native-internal CPU is not available in the old low-level binding. Keep native-boundary thread CPU (includes N-API conversion), explicit JS candidate/conversion stages and logical ID-byte counts separate. The new native layer must expose safe stage counters to distinguish internal work from bridge overhead; do not present the old aggregate as pure turbovec CPU.

## Verification and remaining baseline work

The harness passed `vp fmt` and targeted `vp check` (format/lint/type); all three full runs exited successfully. The first lint attempt rejected representation narrowing and unnecessary type assertions; the final harness uses a narrowed Node address contract and an explicitly typed timing record. No runtime implementation was changed.

The initial boundary-only result did not complete step 01. The subsequent file/WAL three-run fixture now adds full-service SQL instrumentation, pinned search-concurrent HTTP control, new-process startup and frozen comparison rules. Together with the separate live API observation and ownership audit, these establish the implementable baseline. Pure old-binding native-internal CPU, production cold startup and controlled production API attribution remain explicitly unavailable rather than fabricated. Those limitations must survive the final comparison. Do not substitute fixture HTTP delays for the user's observed 3.8-second application delay.

The measured FTS dominance supports moving SQL and the existing native handle out of the main thread together; it does not demonstrate that rewriting SQLite calls in Rust speeds up SQLite itself. The next design must retain the single index/lease owner, introduce only a read-only search connection, and make publication/failed-generation behavior explicit.
