# Node multilingual preparation — S3 (2026-10-06)

Status: incomplete; automatic recall and production sensor remain disabled. Historical source/distribution observations below are followed by a newly completed acquisition and real Korean smoke probe; this is not a representative recall benchmark.

## Historical initial acquisition investigation (superseded by authorized acquisition below)

- The public npm registry reports `@receptron/laya` 0.1.2, MIT, Node >=20: https://registry.npmjs.org/@receptron%2flaya/latest . No SDK was installed by this trial.
- The official README and `src/download.ts` support `subfolder: "multilingual"`. That option is implemented; this is not a claim that multilingual selection is unsupported.
- On 2026-10-06 the Hugging Face API reports `receptron/laya-onnx` revision `68f27dfe5a27a54fb2b1fefc432f43f972e90868` with only root `laya.onnx`, `laya.onnx.data`, `laya_config.json`, `tokenizer/tokenizer.json`, `tokenizer/tokenizer_config.json` (and metadata). https://huggingface.co/api/models/receptron/laya-onnx
- https://huggingface.co/api/models/receptron/laya-onnx/tree/main/multilingual?recursive=true returned **HTTP 404**. This establishes absence from the inspected public revision, not permanent absence or lack of an alternative repo.
- No bundle exists in the checked default `~/.cache/receptron-laya` or dedicated `/Users/creejee/laya-sensor-lab/onnx` path. Other user directories were not exhaustively searched. The dedicated lab contains a previous Python environment/cache, not a verified Node bundle.
- Existing dedicated Python venv lacks `onnx`, `onnxscript` and `onnxruntime` (module-spec checks only). The upstream exporter at https://github.com/receptron/laya/blob/6478649e723122ca24bbf5fb69ed1010023c9750/export/export_onnx.py requires additional dependencies. It also contains a parity printout, which is not an acceptance gate in this Plan. No export or package/model download was performed.

## Locality and lifecycle requirements

Pass an absolute owned `modelDir`; do not call default `Laya.load()` or use a populated cache as an offline guarantee. The upstream cache path performs HEAD freshness calls. Restrict CPU threads and resource admission before load, minimize redacted input, validate finite [0,1] `noul`, and never log content or mutate evidence/graph edges. Real offline operation, model identity/digests, Korean output, memory and latency are still unverified.

The reviewed `systemOne` does not accept a cancellation signal. A Promise timeout alone cannot stop native ONNX inference. Any mock/injected preparation must explicitly acknowledge this limitation, serialize pending inference and avoid releasing a session while inference still uses it. A hard deadline for an unresponsive native call needs process/worker isolation and verified termination before production activation. Such termination is not established by current HTTP/mock regression tests.

## Host observation (not inference measurement)

Read-only `sysctl -n hw.memsize hw.ncpu` reports 16 GiB RAM / 8 CPUs; `pmset -g batt` reports AC power / 100% charge; `df -h` reports only 15 GiB available on the dedicated lab's volume (2026-10-06). These are current observations, not previous-session resource estimates. Do not initiate model/export acquisition until total dependency, output and temporary disk allowance is explicit. No inference RSS, latency, embedding contention or energy result exists yet.

## Injected adapter preparation

`recall-sensor-local.ts` is default-off and not wired into production. It accepts only an injected installed SDK loader and an absolute local `modelDir`, bounds state to 2048 characters, uses CPU/2 threads, validates the named `noul` response at runtime and owns session release through Effect scope. Mock checks cover disabled/resource skips, malformed responses, errors, deduplication, timeout/cancellation and close ordering. These checks do not establish real SDK compatibility or offline inference.

**Remaining safety gap:** timeout/cancellation outcomes wait for native completion; a permanently hung SDK can block evaluation and close indefinitely. Process isolation and verified hard termination remain required before enabling this path. The local result currently inherits the legacy Python sensor version label; real Node model/version provenance must be supplied before evaluating or activating a genuine SDK bundle.

## Public bundle discovery follow-up (2026-10-06)

The broader public search found existing multilingual ONNX distributions; the default receptron subfolder 404 does **not** imply no bundle exists. No model weights were downloaded or exported.

- https://huggingface.co/onnx-community/laya-multilingual-ONNX , revision `46b77bbf5642fec5f14e540570228a8cbe8ab81f`: Apache-2.0 per model card; fp32 graph/data 1,291,189,219 bytes, fp16 graph/data 647,389,759 bytes, tokenizer 34,363,188 bytes. Config and conversion sources published. Base model is `convaiinnovations/laya-multilingual`.
- https://huggingface.co/mizchi/laya-multilingual-onnx , revision `d9d003d543e63d6d3375c21d44624136bd1e0bad`: Apache-2.0 per card; fp16 graph 646,870,871 bytes plus tokenizer. Published ONNX metadata and source checkpoint provenance.
- https://huggingface.co/soyelmismo/laya-multilingual-onnx , revision `0966c4fa58da6878b39e7e14cb5e93313b82d828`: Apache-2.0 per card; INT8 graph 325,734,062 bytes or fp32 graph 1,290,688,971 bytes plus tokenizer. Speed and accuracy claims remain publisher claims, not host measurements.

These are not verified drop-in bundles for `@receptron/laya` 0.1.2. Its reviewed `src/laya.ts` requires `laya_config.json`, `laya.onnx`, `[CLS]/[SEP]/[MASK]/[PAD]` special tokens and float32 `act_probs`. The documented community/mizchi graph outputs include `act_logits`, their tokenizer configs specify `<bos>/<eos>/<mask>/<pad>`, and layout/config names differ. File renaming alone is insufficient. The soyelmismo graph output contract still needs inspection; its tokenizer/config already differs. No real inference compatibility test has been performed.

The ONNX community card references a `shreyaskarnik/open-jev` `laya-family` fork. Do not assume installing npm `open-jev` obtains that support: npm latest metadata points to `nico-martin/open-jev` 0.1.2, a different source repository. Runtime adaptation or a verified published compatible SDK is still required.

Deployment direction requested by the user: model files live in an external local model directory/cache, **not the app distribution**; no Python/export service or HTTP inference server is bundled. Node native-runtime distribution size remains separately measurable. Prefer existing public bundle acquisition over self-export, and do not silently substitute the root English model.

## Authorized acquisition and real smoke probe (2026-10-06)

The user explicitly authorized the proposed SDK/FP32 download. `@receptron/laya@0.1.2` was installed with `npm install --ignore-scripts --no-audit --no-fund` only in `/Users/creejee/laya-sensor-lab/node-sdk` (19 packages). The project package manifest/lockfile and app packaging were not changed. The native ONNX Runtime and JS tokenizer successfully import despite skipped install scripts.

The pinned ONNX community revision above was downloaded to `/Users/creejee/laya-sensor-lab/node-multilingual`: six files, 1,325,559,856 bytes total. All sizes matched repository metadata; the graph, external weights and tokenizer additionally matched their published LFS SHA-256. Other small files have recorded SHA-256 in `acquisition.json` and pinned revision/size validation, not independently published digests. No model was converted or exported.

`node-sdk/korean-probe.mjs` uses the SDK's installed tokenizer and ONNX Runtime dependencies directly; **unmodified `Laya.load()` is not used and this does not establish compatibility of that SDK class**. It implements the published model inputs and uses its tokenizer config, produces [false,true] logits and computes `P(true)`. Local Python code inspection was used only to check sequence formatting, not inference or numerical parity. Synthetic Korean strings only; no private turns were sent or logged. CPU two threads, at most 512 tokens. A JS socket/fetch tripwire counted zero network attempts; this is **not** proof of OS-level egress isolation or native-code network absence.

Successful parent task `b3f28ca1-eb65-4ada-862b-f5afc92d5a2f`:

- Model load: 3,154.7 ms; tokenizer preparation: 832.1 ms (cold 2-second budget is not met).
- Three synthetic cases repeated twice; 76–78 tokens; 128.7–178.7 ms per sequence including tokenization. Six calls do not establish p95 or concurrency behavior.
- Past-decision question: P(true) 0.62935; standalone arithmetic: 0.14450; correction-history question: 0.92070. These are smoke outputs, not accuracy/calibration or evidence-retrieval results.
- RSS at measurement: 1,021,542,400 bytes. `maxRSS` is platform-dependent; the script multiplies by 1024, which must be checked against Darwin's Node units before treating its reported peak as valid. No independent process RSS/energy/embedding-contention measurement yet.
- Session released on normal completion; command exit 0; no server or production integration.

## OS-isolated probe checks (2026-10-06)

- Successful task `34d69fef-bef2-4f17-9a90-a80ee37c35d4` ran the same six Korean smoke calls through macOS `sandbox-exec -p '(version 1)(allow default)(deny network*)'`: exit 0, identical scores, model load 2990.3 ms, runs 127.3–171.6 ms, RSS snapshot 657,063,936 bytes. This is an OS-enforced no-network check of that probe on this host, not of production wiring or other platforms.
- Node negative control independently attempted a loopback TCP connection under the same profile and received `EPERM`, command exit 0. An earlier Python control also showed `PermissionError` but its outer tool reported `timed_out`; it is not counted as a successful verification run.
- Successful task `c6b4d469-bdbf-48ba-b81e-f9aac72fb401` forks a probe child with IPC, observes the marker immediately before its native `session.run`, requests SIGKILL 20 ms later, and observes process exit after 32.6 ms with `aliveAfterExit:false`. This demonstrates process termination at the inference boundary; it is not a proof of precisely where ONNX was executing or a completed adapter timeout/fallback integration.
- A synthetic-only cancellation probe file was created outside the app in `node-sdk/korean-probe-cancellation.mjs`; no production worker or search activation was added. A process per call would incur the measured cold-load cost; warm persistent-worker lifetime/restart/resource admission must be designed and measured separately.

## Experimental worker and process runner

Added `eval/laya-worker.mjs` (one stdin request, one bounded metadata-only result) and default-disabled `eval/laya-process.ts`. This is a **cold-process evaluation runner**, not production chat integration or a persistent service. The runner uses `effect/process`/Scope, macOS network-deny sandbox, explicit external SDK/model paths, bounded input/output, single-entry memo, busy/resource skip and ONNX revision provenance. Timeout/abort finalizers issue SIGKILL and await process exit. A fresh process per turn cannot meet the warm 250ms budget; it must not be treated as an activation-ready design.

`@effect/platform-node@4.0.0` was added only to the external SDK experiment directory to supply a trusted platform layer; the repository package manifest and lockfile were not changed. The Node layer is injected into the runner. Portability is fail-closed: non-Darwin hosts return unavailable pending a verified isolation policy.

Parent real-run task `4901bd21-fe8b-4fab-a6f5-182fef37617a` succeeded through the whole runner, returning score 0.92070, load 2755.7ms, inference 187.1ms, RSS 1,116,798,976 bytes, and `Laya-ONNX/46b77bbf/nonproduction-cold-process` provenance. Worker initialization issues (wrong Schema length API and CJS tokenizer export) were repaired before this successful run.

Parent lifecycle task `9345842a-99c1-49cd-8e24-3f5949668752` observed actual child PIDs: a 100ms startup timeout returned timeout in 115.4ms; a user abort 100ms after spawn returned cancelled in 107.4ms. Both had no live PID on return. These exercise startup interruption, not warmed native inference cancellation. The earlier native-boundary prototype remains separate evidence.

Parent verification: full `vp check` passed (656 formatted files, 594 lint/type checked); four focused test files passed, 39 tests total; `git diff --check` passed. The two new unit tests cover disabled/schema boundaries only. Broader deterministic process concurrency/error/oversize-output tests and S3 chat-fallback compatibility remain work, not passed checks.

## S3 contract verification (2026-10-06)

`eval/laya-sensor.ts` now supplies an eval-only `RecallSensorInput`/`RecallSensorResult` Promise bridge and scoped `close()` using the trusted injected platform layer. Version is the full ONNX community revision, not Python version. Admission/pre-abort checks precede memo access; output token count is constrained to 1–512. The old injected in-process prototype is not the actual runtime path and its non-cancellable SDK limitation remains a historical warning.

Parent real bridge task `0a28a37e-63f1-45e3-996d-d272fc7dd6f2` succeeded: Korean score 0.920701898, accurate revision provenance, 4379.9ms end-to-end; same text subsequently denied resources returned skipped. No app integration or new download. The mock process/bridge tests cover finalizer completion before timeout/abort return, output/process failures, memo, concurrency and scope shutdown. Chat seam tests cover evaluated/disabled/skipped/unavailable/timeout/cancelled/error: provider sees only the incoming user message, private synthetic prior evidence remains unchanged and no tool search is invoked.

Parent task `e1c8785a-ae7d-4a29-9e4e-e156c9b4981c`: all 17 tests passed across runner (8), bridge (2), chat seam (7). An initial chat test missed the construction Scope and failed; its explicit owned Scope was fixed before the passing run. Parent task `26b61f8c-0dfc-43e1-bb35-b5d090d87ec3`: full `vp check` passed (659 formatted files, 597 lint/type checked).

S3 preparation/safety contract is verified for the supported macOS eval runtime; not production rollout approval. Its per-call cold loading exceeds the activation budget. S4 must report this and keep S5 disabled unless every effectiveness/resource/privacy gate passes. A warm lifecycle redesign is not silently substituted for this measured runtime. Python parity and self-export remain excluded from the default path.
