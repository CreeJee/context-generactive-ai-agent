# Laya recall sensor — I1–I3 baseline, sealed set and budget screening (2026-10-12)

Status: I1–I3 of Goal 8346ac43 plan v6 executed. **I4 decision: NO-GO.** I5 (holdout unsealing) and I6 (production wiring/opt-in) were not started. No chat wiring, product search or compaction path changed; the sensor stays a hint-only, default-off eval experiment. Earlier history: [S1](laya-recall-s1.md), [S2 protocol](laya-recall-evaluation.md), [S3](laya-recall-s3-node.md), [S4](laya-recall-s4.md).

Record only: the sensor code was removed from main the same day (`139abb7`), and the eval code and sets this document cites (`eval/laya-budget*.ts`, `eval/laya-recall-*`, `eval/laya-sequence.ts`) were never merged and were discarded with their branch.

## I1 — baseline manifest

Every I3 run records a manifest (`manifest` in the report): SHA-256 of the eval/sensor sources, development set, model files, SDK package versions and the Node runtime. The values for the recorded run:

| Item                                       | Value                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Model                                      | `onnx-community/laya-multilingual-ONNX@46b77bbf5642fec5f14e540570228a8cbe8ab81f`, FP32, pre-staged at the S3 lab path |
| `onnx/model.onnx` / external data          | `22461d98…cf2f9f` / 1,287,635,968 bytes (LFS digest verified at acquisition, S3)                                      |
| `config.json`                              | `cc32109b…87dcc` (`laya.qtypes.noul=2`, temperature 1.0, `head_max_len` 256)                                          |
| `tokenizer.json` / `tokenizer_config.json` | `609d8f4c…b5b6f` / `424b6944…205e7` (`<bos>` as CLS, `<eos>` as SEP, `<mask>`)                                        |
| SDK dependencies used directly             | `@receptron/laya` 0.1.2 (only its installed deps), `onnxruntime-node` 1.30.0, `@huggingface/tokenizers` 0.2.0         |
| Runtime                                    | Node v26.8.2, darwin arm64, 16 GiB / 8 CPU host                                                                       |
| `src/agent/recall-sensor.ts`               | `2eda9b74…1cff28`                                                                                                     |
| `src/agent/recall-sensor-local.ts`         | `be276728…511f9`                                                                                                      |
| `eval/laya-process.ts` / `laya-sensor.ts`  | `9f0efc32…fb59` / `dd7ee718…1d94`                                                                                     |
| `eval/laya-worker-process.ts`              | `b334a51e…f81f`                                                                                                       |

The four existing paths are **different contracts** and their scores are not interchangeable:

| Path                                   | Transport / lifetime                                                 | Question                                                                        | Output → score                                                    | Input bound                      | Version label                                     |
| -------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------- | ------------------------------------------------- |
| `src/agent/recall-sensor.ts` (`http`)  | loopback HTTP DTO, per-run memo, `Effect.runPromiseExit`             | English `noul` instruction "Would recalling earlier conversation context help…" | `answers.recall_useful.noul` (rounded `p[1]` from the SDK server) | 2048 characters                  | legacy `laya-v0.3.26`                             |
| `src/agent/recall-sensor-local.ts`     | injected in-process SDK, `ManagedRuntime`, uninterruptible inference | same English instruction                                                        | same `noul` DTO decoded with Schema                               | 2048 characters                  | legacy `laya-v0.3.26` (wrong for the Node bundle) |
| `eval/laya-process.ts` + `laya-sensor` | cold child per turn under `sandbox-exec` deny-network, Ref memo/busy | defined by the external worker script (S3/S4: Korean evidence statement)        | worker JSON `score` in [0,1]                                      | 2048 characters, ≤512 tokens     | `…@46b77bbf…:node-cold-process`                   |
| `eval/laya-budget*.ts` (this work)     | one sandboxed batch child per eval run, Scope-owned kill + exit wait | three candidates (below), fixed `noul` options                                  | `[false, true]` marker logits → softmax → P(yes)                  | **total tokens** 128 / 192 / 256 | report manifest                                   |

Findings at the baseline:

- `eval/laya-process.ts` needs a `workerPath`, but the worker it was measured with (`laya-worker.mjs`, S3) was never committed; the repository alone cannot reproduce the S3/S4 cold runner. The new batch worker is TypeScript (`eval/laya-budget-worker.ts`) and is committed.
- `chat.ts` keeps the shadow seam: after run admission, an explicitly supplied sensor gets one redacted turn, its Promise is discarded (`void … .catch(() => undefined)`), and nothing reaches messages/tools/search. Unchanged.
- `RECALL_SHADOW_REAL=1` real-search regression (`tests/recall-shadow-search.test.ts`) fails on current `main`: `MemorySearch.find` asks the native index for `vectorK = 4 × limit`, and the native admission envelope caps k at 48, so the harness's K=16 returns `NativeMemorySearchFailed{reason:"budget-exceeded"}`. Not fixed here (product search code is out of scope); I3 uses K = 5/10/12.
- The in-process local adapter's timeout/abort still waits for native completion (no hard cancellation). Its existing tests are kept as-is.

### Effect/API contract review

| AGENTS requirement                               | Current state                                                                                                                                                    | Needed before any I4/I6 code                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Context/Layer services                           | `LayaWorkerProcess` service+layer; local/eval sensors use per-instance `ManagedRuntime`; HTTP sensor is a plain closure                                          | Warm worker as a `Context.Service` provided by the owner's Layer; no new `ManagedRuntime` |
| `Schema.TaggedError` + literal reason            | `LayaWorkerFailure.stage`, `LocalRecallSensorError.stage`, new `LayaBudgetEvalError.reason`/`LayaBudgetWorkerError.stage` ✓; `SensorFailed` (HTTP) has no reason | Keep stage/reason literals; protocol errors per request ID                                |
| No branching on `Error.message`                  | `layaWorkerProcessLayer.exitCode` maps signal exit by `message.startsWith("Process interrupted due to receipt of signal:")`                                      | Replace with an exit-status contract before reuse in a warm worker                        |
| Scope / `acquireRelease`                         | child kill + exit wait finalizer ✓; ONNX session `acquireRelease` in the batch worker ✓                                                                          | Warm child owned by the owner Scope; lease not reused until actual exit                   |
| Fiber interruption, no Promise managers          | eval bridges use `Effect.raceFirst` + `Effect.callback` for abort ✓; `recall-sensor-local` keeps `busy/memo/closed` as mutable closure flags outside Effect      | `Ref` state + `Deferred` per request ID; no resolver/timer Map                            |
| Literal-tag unions + `switch`, no `"key" in obj` | `LayaResult`, `BudgetSequence`, `BudgetCell`, `Policy` are tagged and switched ✓                                                                                 | —                                                                                         |
| String ID keys                                   | memo by `turnId`, cells by variant/question/budget IDs ✓                                                                                                         | Results joined by run/project/request ID, not order                                       |

## I2 — fixed evaluation set

- Files: `packages/memory-agent/eval/laya-recall-dev.json` (train + validation) and `laya-recall-holdout.json` (sealed). Decoder and invariants: `eval/laya-recall-set.ts`.
- 24 scenario families × 3 paraphrase variants = **72 variants**; a family (all its paraphrases, its evidence and its project) belongs to exactly one split: train 9 families / 27, validation 7 / 21, holdout 8 / 24.
- Scenarios (`RecallScenario`): needed — current decision, supersession (correction), retraction, project boundary; not needed — self-contained, answer already in visible recent turns, explicit opt-out (paraphrased, not only the S4 regex wording), history-word decoy, new decision in the turn; unanswerable — no evidence, only another project has it. Labels derive from the scenario (`recallLabel`), gold evidence must be present exactly for needed families and must belong to the family's project; superseded IDs must be gold. Each family carries a rationale.
- Query contract: the incoming (last, user) turn text only, project-only (`crossProject: false`). Sensor input contract: role-labelled recent turns, see I3.
- Retrieval is the real `MemorySearch.find` over disposable storage with cached CPU embedding + Kiwi (`cached-real-embedding-and-kiwi`, interpretation disabled, no answer generation). Fixture `searchEvidenceIds` are not used. `answerGeneration: not-run`, `sourceCorrectness: unknown` — no source/abstention success is claimed.
- **Seal**: `holdoutCommitment` in `laya-recall-set.ts` is the SHA-256 of the committed holdout bytes (`0996f5ba…391d4`). The I3 command only hashes that file; it never decodes or scores it, and fails if the hash changes. Unsealing (I5) requires: a committed frozen manifest (question, budget, threshold, policy, code hashes) first, then exactly one holdout run; any tuning after that needs a new holdout and a new commitment.
- Limitations stated up front: the families were written by the same agent that knew the S4 rule regexes, so rule hit/miss rates on this set are not an unbiased estimate; 9 needed variants (3 families) in validation cannot resolve small effects, so the I3 gate is a screening rule, not a significance test. Family-level paired intervals are left to the I5 protocol.

## I3 — question and total-token budget screening

Command (repository root, offline, uses only the already-staged SDK/model and cached embedding/Kiwi files):

```sh
vp run turbovec#build && vp run memory-agent#build   # native search addon/runtime artifacts
cd packages/memory-agent
node --no-warnings eval/laya-budget.ts \
  --sdk-dir /Users/creejee/laya-sensor-lab/node-sdk \
  --model-dir /Users/creejee/laya-sensor-lab/node-multilingual > i3-report.json
```

Method, fixed before scores were collected:

- Sequence = `[CLS] noul question: <q> [SEP] [MASK] false… [MASK] true… [SEP] <state> [SEP]`, using the SDK's fixed noul option texts. **All** tokens count toward the total budget (128/192/256). The incoming user turn must fit whole, otherwise the cell is `OverBudget` and the policy does not search; earlier turns are added whole newest-first and rendered oldest-first with role labels. No evidence, tool bodies or attachments are sent. P(yes) = softmax over the two marker logits with the config temperature.
- Questions (≤3): `q-ko-evidence` (the S3/S4 Korean statement), `q-en-src` (the `src` adapter's English instruction), `q-ko-visible` (new: needs prior content not visible in the conversation).
- Admission before score: the frozen S4 opt-out regex vetoes all automatic policies; project scope is enforced by search.
- Policies: no new recall, frozen S4 rule, search every eligible turn, Laya ≥ θ, hybrid (rule ∨ Laya ≥ θ). θ is chosen on **train** only (best K5 coverage − unnecessary rate, then fewer searches, then higher θ); the configuration is chosen on **validation** (best objective, then smaller budget). 18 configurations tried. Holdout not evaluated.
- Pre-registered I4 gate: on validation, ≥2 more needed variants covered **or** ≥2 fewer unnecessary searches than the rule, no worse on the other axis or on opt-out searches, and train objective not below the rule's.

Results (K5 all-gold coverage = needed variants searched with every gold ID in the top 5; K10/K12 identical in every row; query failures 0 and wrong-project candidates 0 in every row):

| Policy                                  | Train coverage | Train unnecessary | Val coverage | Val unnecessary | Val opt-out searches | Val unanswerable searched | Val objective |
| --------------------------------------- | -------------: | ----------------: | -----------: | --------------: | -------------------: | ------------------------: | ------------: |
| No new recall                           |           0/12 |              0/12 |          0/9 |             0/9 |                    0 |                       0/3 |         0.000 |
| Frozen S4 rule                          |           3/12 |              3/12 |          1/9 |             0/9 |                    0 |                       2/3 |         0.111 |
| Search every eligible turn              |          12/12 |             11/12 |          9/9 |             7/9 |                **1** |                       3/3 |         0.222 |
| Laya `q-ko-visible`, 128, θ=0.569 (sel) |           6/12 |              2/12 |          5/9 |         **3/9** |                    0 |                       0/3 |         0.222 |
| Hybrid `q-ko-visible`, 128, θ=0.569     |           8/12 |              4/12 |          5/9 |             3/9 |                    0 |                       2/3 |         0.222 |
| Laya `q-ko-evidence`, any budget        |           4/12 |              1/12 |          1/9 |             2/9 |                    0 |                       1/3 |        −0.111 |
| Laya `q-en-src`, any budget             |           9/12 |              7/12 |          3/9 |             5/9 |                    0 |                       2/3 |        −0.222 |

- **Budget had no measurable effect on this set**: the longest sequence was 138 tokens, so 192 and 256 never truncated, and 128 dropped an earlier turn in only one variant (`f06-a`); every metric is identical across budgets. The set's short turns cannot discriminate 128/192/256 — longer multi-turn contexts are needed before choosing a budget.
- **Question choice dominates**: the src English instruction is nearly uninformative on Korean turns (mostly P(yes) < 0.25); the S4 Korean statement is unstable across paraphrases (`f03-a` 0.008 vs `f03-b` 0.887 for the same correction family).
- Best Laya covers 4 more validation needed variants than the rule but adds 3 unnecessary searches and ties "search every eligible turn" on the objective. It fails the pre-registered gate (unnecessary searches worse than the rule). Hybrid fails the same way.
- **Opt-out admission gap**: the frozen regex vetoed only 3 of 6 paraphrased opt-outs in train/validation (`f07-b`, `f07-c`, `f15-b` pass it), so always-search would recall against the user's instruction. Any future automatic path needs a stronger, separately evaluated opt-out admission; a sensor score must never be the opt-out guard.
- The rule baseline itself is weak here (1/9 validation coverage); see the authoring-bias note in I2.

Resources (one sandboxed batch child, CPU EP, intra-op 2 / inter-op 1 threads, network denied by `sandbox-exec`; 432 sequential inferences):

| Metric                                  | Run 1                                                      | Run 2            |
| --------------------------------------- | ---------------------------------------------------------- | ---------------- |
| Tokenizer preparation / model load      | 1,691 / 3,110 ms                                           | 5,018 / 4,653 ms |
| Inference p50 / p95, budget 128         | 199 / 1,000 ms                                             | 167 / 570 ms     |
| Inference p50 / p95, budget 192         | 211 / 1,157 ms                                             | 166 / 630 ms     |
| Inference p50 / p95, budget 256         | 186 / 1,113 ms                                             | 167 / 537 ms     |
| Worker RSS after load / at end / max    | 552 / 566 / 814 MB                                         | max 819 MB       |
| Parent eval process max RSS (`time -l`) | 1,236 MB (embedding + Kiwi + native search, not the child) | —                |
| Batch child wall time                   | 160 s                                                      | 108 s            |

The host was shared with other concurrent agent workers during the run, so p95 includes uncontrolled CPU contention; it is reported as measured, not as a clean warm-latency figure. Cold-ready (tokenizer + load) exceeds the 2 s gate in both runs; per-call p95 exceeds 250 ms in both runs even for ≤138-token inputs. Worker max RSS is Node `maxRSS` (kilobytes × 1024).

## Decision

- **I4 (warm eval worker): NO-GO.** No question/budget/threshold candidate shows a meaningful effect over the rule under the pre-registered gate, and the best candidate is not better than searching every eligible turn. Building warm-worker ownership now would optimise latency for a trigger that has not shown value.
- I5/I6 not started; holdout remains sealed and unscored. Automatic search, production preload and chat wiring stay disabled.
- Reopening requires a revised plan: longer multi-turn contexts that actually exercise the budgets, a question re-designed on train only, a stronger opt-out admission evaluated on its own, and a family-level paired method fixed before the holdout is touched.

## Reproducibility

- Contract tests: `vp test packages/memory-agent/tests/laya-sequence.test.ts` (marker order, total-token budget/skip, logits → P(yes), worker DTO bounds, development-set invariants and holdout commitment).
- Scores are deterministic for a given manifest: a second full run reproduced every P(yes) (maximum difference 0) and every policy metric exactly; only latency/RSS differ.
