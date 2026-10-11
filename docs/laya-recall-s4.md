# Laya multilingual shadow evaluation — S4 (2026-10-06)

## Decision

**Activation gate: NOT PASSED. Do not execute S5 or enable automatic recall.** This completes the current smoke-evaluation pass, not a successful rollout. S1–S3 preparation remains useful; the model/SDK stay outside the app distribution and the eval adapter stays default-off. No Clef substitution, cloud fallback, server, self-export or Python–ONNX parity gate was added.

## Tested path and reproducibility

- Model: `onnx-community/laya-multilingual-ONNX@46b77bbf5642fec5f14e540570228a8cbe8ab81f`, FP32. The public graph/weights/tokenizer LFS digests were verified during the user-authorized acquisition.
- Installed external SDK: `@receptron/laya@0.1.2`; its tokenizer/ONNX Runtime dependencies are used through a compatible local worker. **This is not unmodified `Laya.load()` compatibility.** See [S3](laya-recall-s3-node.md).
- Platform: Apple Silicon, 16 GiB RAM; CPU 2 threads; 2048-character state cap, total sequence <=512 tokens; macOS `sandbox-exec` network denial for the sensor process. Supported-host eval only, not a cross-platform release.
- Fixture: `packages/memory-agent/eval/recall-turns.fixture.json`, 10 synthetic Korean turns, grouped partitions train/validation/holdout = 4/3/3. Five answerable needed turns; four unnecessary turns; one unanswerable history question reported separately. No private conversation or real user's memory database is queried.
- Actual retrieval: `eval/recall-shadow-search.ts` creates disposable storage/projects/evidence, uses already cached real CPU embedding and Kiwi, indexes the original synthetic nodes, and calls existing `MemorySearch.find` with `crossProject:false` at K=5/10/16. It never replays `searchEvidenceIds`. Automatic interpretation is off; no graph correction edges are inferred from scores.
- All five answerable cases' required original evidence is accessible at K=5, K=10 and K=16 **if search runs**; wrong-project candidates: 0. No embedding/search degradation in the measured cached run. Historical and corrected statements are both retrieved where required, but answer generation and source-selection correctness were not run. `sourceCorrectness=unknown`, not zero errors.

Raw artifacts remain under `/Users/creejee/laya-sensor-lab/node-multilingual/`:

| File                  | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `s4-sensor-cold.json` | `f034287efa2db8ee1d51fbd159ae97015c3a7ec2ab03edf53e0b7e8e4b2358bb` |
| `s4-search.json`      | `506d944fdd9b9a2ee3f9948813dff0947296c51af736de3b166b2885127f4a68` |
| `s4-summary.json`     | `f2ae1879c7b09974c473b07573d702c58856e4462b09d7622cd584ec49d63664` |
| `s4-contention.json`  | `b04079c21739f1811d4c7257725781ba023e54041f8397880d325fbaeda9a1da` |

The actual search/fallback regressions are reproducible with:

```sh
vp install --offline --frozen-lockfile
vp check
RECALL_SHADOW_REAL=1 vp test packages/memory-agent/tests/recall-shadow-search.test.ts packages/memory-agent/tests/laya-process.test.ts packages/memory-agent/tests/laya-sensor.test.ts packages/memory-agent/tests/laya-shadow-chat.test.ts packages/memory-agent/tests/recall-sensor.test.ts packages/memory-agent/tests/recall-turns-fixture.test.ts packages/memory-agent/tests/agent-chat.test.ts packages/memory-agent/tests/search.test.ts packages/memory-agent/tests/compaction.test.ts --run
```

The real-search test must report `cached-real-embedding-and-kiwi`; a fallback to text-only is not equivalent proof. The worker runner accepts explicitly supplied external SDK/model paths; no automatic package/model acquisition. The existing external `node-sdk/s4-warm-probe.mjs` (SHA-256 `f5a5491653aa4ef1b1fbee3df1b3a20845e1ce741d9d62f9983430d435a2b651`) is the 30-call warm/resource probe, not the turn-level effectiveness fixture.

## Effectiveness and threshold

Use gold evidence accessibility, not sensor classification alone. Select threshold using **validation rows only**: maximize all-gold K5 coverage minus unnecessary-search rate; tie-break fewer searches, then higher threshold. Candidate thresholds are 0, 1 and validation scores. Result: **0.13053786517765606**. The summary does not select a threshold from holdout metrics.

Explicit opt-out veto is applied ahead of all replay policies using `(?:이전|과거).{0,30}(?:참고하지|가져오지|사용하지)|기억.{0,12}참고하지`. The illustrative prior-reference heuristic is `아까|그때|고친|결정했|했지|얘기했던`. These are **fixture-level exploratory replay rules**, not installed product policy or comprehensive opt-out detection. The heuristic was written after inspecting the fixture; it is not a preregistered blind competitor. Holdout scores had already been collected; there is no once-used sealed suite. Do not claim statistically meaningful generalization or superiority for either policy.

| Policy, with explicit opt-out veto       | All needed: all gold accessible | Unnecessary searches | Holdout needed: all gold accessible |
| ---------------------------------------- | ------------------------------: | -------------------: | ----------------------------------: |
| No new automatic recall (counterfactual) |                             0/5 |                  0/4 |                                 0/1 |
| Exploratory phrase heuristic             |                             5/5 |                  0/4 |                                 1/1 |
| Search every eligible turn               |                             5/5 |                  1/4 |                                 1/1 |
| Laya, validation-selected threshold      |                         **4/5** |              **1/4** |                             **0/1** |

The no-new-recall replay means only the current synthetic incoming turn is visible; it is **not a measured end-to-end production compaction/answer baseline**. Validation Laya coverage 2/2 does not rescue the holdout miss. Gold-bearing selected queries did retrieve their evidence; the observed missing-gold failure is the trigger suppressing search, not inability of this fixture's search to find the nodes.

95% Wilson intervals for all-needed coverage: Laya 4/5 = [0.3755, 0.9638], heuristic 5/5 = [0.5655, 1.0000]. Holdout Laya 0/1 = [0.0000, 0.7935]. These intervals assume independent trials, which this tiny synthetic fixture cannot substantiate; they illustrate uncertainty only. The result does not demonstrate improvement over an acceptable baseline.

Failure examples:

- `ho-ko-correction`: score 0.102115 < selected threshold; search suppressed and both `ev-ho-pine-01`/`ev-ho-pine-02` missed. Searching would retrieve both.
- `tr-self-contained`: score 0.309689 >= threshold; unnecessary arithmetic-turn search.
- `va-opt-out`: raw score 0.754464 despite explicit instruction not to use earlier memory. The replay veto prevents search; this is evidence that the model score cannot authorize recalling against the user's boundary.
- `tr-empty-search`: score 0.861185; one requested search with no gold evidence. Reported separately, not recall success; answer abstention/hallucination remains untested.

## Resource gates

Cold means a new child/session per turn; later calls can benefit from filesystem/page cache and are **not** warmed model sessions. For ten cold-process fixture evaluations:

| Metric                             |               Measured | Gate/conclusion                                                 |
| ---------------------------------- | ---------------------: | --------------------------------------------------------------- |
| End-to-end p50 / p95               | 1585.0 / **4915.2 ms** | Not viable as <=250 ms per-turn overhead                        |
| Model-load p50 / p95               |  436.8 / **3413.9 ms** | First cold setup exceeds <=2 s readiness                        |
| Inference p95, short fixture turns |               241.9 ms | Excludes process/model setup; cannot count as full overhead     |
| Child RSS snapshots                |        848.9–1163.2 MB | Not simultaneous process-tree peak/free-headroom proof          |
| Multilingual model acquisition     |    1,325,559,856 bytes | User-authorized, app-external; no packaging growth from weights |
| Current model directory            |          1,294,576 KiB | Includes analysis files; SDK disk cost separate                 |

Controlled CPU embedding + warm sensor probe uses a cached real embedding model, two strings padded to [2,512], and 30 warm sensor calls (20 short, 10 long, Korean and English). Successful child exit 0:

- Embedding baseline p95 299.0 ms (five calls, includes first-run effects); concurrent p95 284.9 ms (100 calls). This **does not establish improvement or absence of contention**: different sample counts, first-run skew, and the 100-call cap can let the sensor continue after embedding ends. No synchronized per-inference paired timing was collected.
- Sensor short-input p95 **395.7 ms**; long-input p95 **1866.1 ms**; overall p95 **1804.6 ms**. These exceed the 250 ms gate.
- RSS snapshots: sensor 669,499,392 bytes; embedding parent 291,635,200 bytes. Their sum is not a synchronized peak measurement.
- Fresh sensor-alone OS-network-denied warm repeat: 30 calls, short p95 **173.8 ms**, long p95 **1121.9 ms**, overall p95 **1029.8 ms**, model load **2929.5 ms** plus tokenizer **749.6 ms**, RSS snapshot **680,509,440 bytes**, max 512 tokens. Short warm inference meets 250 ms in this small run, but long turns and cold readiness fail. A warm probe is not evidence that the current per-turn process adapter has persistent warm-session lifecycle. Raw `/tmp/laya-s4-warm-20261006.json` SHA-256 `f035ad3285f92eafea8c9b3a285362723c7a747cc895ba792193d29293b75181`; parent task `353f2d22-7b11-4118-99f8-731adf3695cc` exit 0.

Power/energy limitation: the host is on AC; battery discharge/energy impact has **not** been measured and is not assumed negligible. GPU/WebGPU matrix, thermal-normalized repetitions, continuous process-tree RSS/CPU and actual free-memory admission monitoring remain unverified. Mock resource rejection is verified; it is not a hardware pressure monitor. These unknowns prevent activation, but cannot reverse the already failed effectiveness/latency gates. No user power settings were changed.

## Safety and regression scope

Actual supported-host tests previously established network denial, startup timeout/abort with child PID absent on return, and a separate inference-boundary kill probe. Deterministic runner/bridge tests verify cleanup before returning timeout/cancel, disabled/resource/pre-abort no spawn, process/output failures, bounded tokens, memo/concurrency and scope close. Seven chat seam states preserve incoming-only provider input, original synthetic evidence and no added search calls. Fresh parent task `76495acd-de06-4506-ace5-9e03d5bbc062` exit 0: offline frozen-lockfile install, full `vp check` (661 formatted / 599 lint-and-type-checked files), and all **86 tests in 9 files** passed, including cached real embedding+Kiwi retrieval, existing manual find/read/trace, compaction and chat. The fresh retrieval report again had `fullActivation:false`, `answerGeneration:not-run`, `sourceCorrectness:unknown`, project-only queries and original gold-node rankings. Kiwi reports an architecture-specific quantization fallback warning; this successful cached retrieval is not proof of a quantized Kiwi runtime.

Do not enable a background resident process, auto-search, provider appendix, cross-project recall or production model downloads from this result. Finishing S4 measurement is not passing S4 activation. S5 is conditional and remains blocked by the failed gate. A larger adjudicated/once-used evaluation set, revised runtime/input budget, warm lifecycle and resource monitoring would require an explicit revised Plan before rollout work.
