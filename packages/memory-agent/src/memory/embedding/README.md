# embedding

## Overview

memory-agent의 임베딩 계층이다. 모델 표(`models.ts`)에서 고른 로컬 임베딩 모델을 워커 스레드(onnxruntime-node, Effect RPC)에서 돌리는 `Embedder`, 문서를 토큰 창으로 자르는 `chunkText`, turbovec 네이티브 소유자 워커 위의 `VectorIndex`, nodes 테이블과 벡터 색인을 맞추는 `Indexer`를 제공한다. `EmbeddingSetup`은 설정 화면(`apps/agent`의 `settings.embedding` 라우트)에 실행 모드와 WebGPU 상태를 알려 준다. 이 디렉터리는 SQLite의 `nodes`/`node_vectors`/`node_vector_chunks` 매핑과 네이티브 벡터 저장소 사이의 게시(publication) 순서를 책임진다.

## Interface

- `Embedder` — `Context.Service<Embedder, EmbedderApi>`. `Embedder.local`은 GlobalConfig 설정과 메모리로 모드를 골라 `<storage>/models`의 로컬 모델 Layer를 만들고, `Embedder.localFile(mode)`는 그 모드의 파일을 CPU에서 돌리는 평가용 Layer다
- `EmbedderApi` — `identity`(비교 불가 벡터가 되면 바뀜), `dimensions`, `embed(texts, role, priority?)`(role의 prompt를 붙여 임베딩한 L2 정규화 벡터. `priority`는 `interactive`·`background`이고, 생략하면 `defaultPriority`대로 query는 `interactive`, document는 `background`다), 선택적 `chunks`, `runtime()`
- `EmbedderRuntime` — `EmbeddingOverview["running"]`의 `Data.taggedEnum` 생성자. `local{mode, device}` 또는 `other`(테스트·평가용)
- `EmbeddingError` — 임베더 실패를 나타내는 TaggedError(`cause: Defect`)
- `EmbeddingMode` / `embedderIdentity(mode)` / `identityMode(identity)` — cpu/gpu 모드 Schema(`contracts.ts`), 로컬 모델의 그 모드 파일이 만드는 벡터의 identity(`<id>@<tag>/<output>/<maxTokens>/chunks-v<version>-<tokens>-<overlap>`), identity를 만든 모드(로컬 모델이 아니면 None)
- `models.ts` — 모델 표. `EmbeddingModelName`(Schema.Literals)마다 `EmbeddingModel`(id, dimensions, `output`, `textOnly`, role별 `prompts`, 정정을 묶는 cosine `sameMeaning`, maxTokens, batchSize, batchCost, 모드별 `files{file, tag}`)을 둔다. 항목은 `granite-97m-r2`(384차원, CLS, prompt 없음, cpu `model_quint8_avx2`·gpu `model`)와 `embeddinggemma-2`(768차원, `sentence-embedding`, text 모델만, role별 prompt, 배치 비용 4×512², cpu `model_quantized`(q8)·gpu `model_fp16`)다. `localModel`은 앱이 돌리는 항목(현재 `embeddinggemma-2`)이고, `modelFile(mode)`는 모델 캐시 안의 `onnx/<file>.onnx` 경로다
- `EmbeddingRole` — `query`(검색 질의, 스킬을 찾는 글)·`document`(색인하는 노드, 스킬의 이름과 설명, 서로 견주는 정정). prompt가 있는 모델은 role마다 다른 prefix를 붙인다
- `EmbeddingOutput` — 워커가 벡터를 읽는 곳. `cls`는 첫 토큰의 hidden state, `sentence-embedding`은 모델 그래프가 직접 pooling한 출력
- `normalize` — Float32Array를 L2 정규화한다
- `planBatches` — dual 함수. 토큰 수 오름차순으로 크기·비용 제한 안에서 배치 인덱스를 묶는다
- `embeddingModeFor(settings)` — 설정(`embeddingDevice` cpu/gpu/auto)에서 모드를 정한다. auto는 gpu 모드다. gpu 모드는 WebGPU가 안 되면 같은 파일을 CPU에서 돌리므로 확인 결과를 기다리지 않는다
- `gpuModelFile` / `currentGpuCheck(settings)` — WebGPU 확인이 기록하는 gpu 모드 파일 이름, 저장된 확인이 그 파일의 것일 때만 돌려준다. 설정 화면 표시용이다
- `ModelSession` — 실행 중인 모델 워커 하나의 인터페이스(device, countTokens, embed, chunk, terminate, busy)
- `modelWorker(cacheDir, setup, connect?)` — 첫 요청 때 워커를 띄워 `ScopedRef`에 유지하는 세션 관리자. 테스트는 `connect`로 세션을 주입한다
- `checkGpu(storageRoot)` — gpu 모드의 모델 파일이 WebGPU에서 로드·실행되는지 별도 워커로 확인한다. 설정 화면에서 확인을 누를 때 `setup.ts`가 호출한다
- `EmbeddingRpcs` (`Load`, `CountTokens`, `Embed`, `Chunk`) — 호스트와 embed-worker 사이의 RpcGroup 프로토콜. `Load`는 stream이다. 모델 파일을 내려받는 동안 `LoadEvent.downloading{loaded, total}`을 보내고, 적재가 끝나면 `loaded{device}`를 보내고 끝난다
- `plannedDownload({ registry, modelId, files })` / `LoadReport` — 워커가 모델을 불러오기 전에 transformers.js `ModelRegistry`(`get_files`, `get_file_metadata`)로 캐시에 없는 파일과 그 크기를 읽는다. 결과는 `planned{files}`(모두 캐시에 있으면 빈 목록)이고, 읽지 못하면(네트워크가 끊긴 때 등) `unplanned`다. `LoadReport`는 이 둘과 transformers.js `ProgressInfo`의 합이다
- `downloadProgress(reports)` — `LoadReport` stream을 내려받는 파일들의 byte 합으로 바꾼다. 계획된 파일은 처음부터 total에 들어가므로 전체 크기가 첫 byte 전에 정해진다. 다운로드가 시작될 때(계획에 파일이 있거나, `unplanned`이거나, 중간 보고가 온 파일이 있을 때) 한 번, 그 뒤에는 정수 percent가 바뀔 때만 내보낸다. total 0은 크기를 아직 모른다는 뜻이다. embed-worker와 rerank-worker가 쓴다
- `ModelDownloads` / `ModelDownloads.layer` / `ModelDownloads.report(purpose, model)` / `DownloadReport` — 로컬 모델 워커가 보고한 다운로드를 용도별로 하나씩 모아 두는 서비스. `DownloadReport`는 `progress`와 적재가 끝났을 때의 `ended(exit)`다. 지금까지의 평균 속도로 남은 시간(`secondsLeft`)을 계산한다. `report`는 서비스가 없으면(테스트·평가) 아무 데도 기록하지 않는 `untrackedDownload`를 준다
- `DownloadProgress` / `DownloadPurpose` / `ModelDownload` — 내려받는 byte 합 `{loaded, total}`, 용도(`embedding`/`rerank`/`gpu-check`), 그리고 `downloading{purpose, model, loaded, total, secondsLeft}` 또는 `failed{purpose, model}`인 TaggedUnion Schema(`contracts.ts`)
- `EmbeddingWorkerData` / `EmbeddingDevice` / `EmbeddingWorkerFailed` — 워커 시작 데이터 스키마(모델 id, 파일, `output`, `textOnly`, maxTokens, 장치 순서), `cpu`/`webgpu` 장치(`contracts.ts`), `stage: load|run|lost` 실패 타입
- `embed-worker.ts` — 워커 스레드 진입점. `runtimeWorker("embed-worker")`로 실행되고 `RpcServer.layer(EmbeddingRpcs, { concurrency: 1 })`을 띄운다
- `ChunkSpan` / `chunkPolicy` / `chunkVectorIdFloor` / `ChunkingFailed` / `chunkText` — UTF-16 offset span 스키마, 512토큰·128 overlap 정책(version 1), chunk vector id 하한 2^52, 청킹 실패, 이분 탐색 청킹
- `VectorIndex` — 네이티브 벡터 색인 서비스 태그(`vector-index.ts`). 서비스 형태는 `VectorIndexApi`다
- `VectorIndexApi` / `VectorBackend` / `VectorHit` / `VectorIndexError` — add/remove/search/save/flushRemovals/publish, lexical 색인 반영 `applyLexical`과 native read API, 검색 결과(seq, cosine score), operation별 오류(`lexical` 포함)
- `nativeVectorIndexLayer` — 유일한 프로덕션 백엔드 Layer(`native-vector-index.ts`). 네이티브 소유자(`NativeOwner`)와 그 소유자의 세대 게이트(`NativePublication`)를 Layer로 열어 yield하고, 시작 시 제거 저널과 예약 chunk를 정리한다. NodeCrypto·NodePath를 공급하고 `StorageRoot`·`SqlClient`·`Embedder`를 요구한다
- `Indexer` / `Indexer.layer` — nodes 테이블과 벡터 색인을 맞춘다. `pending`, `indexBatch`, `indexAll`, `exclusive`, lexical 기록 반영 `lexicalBatch`/`lexicalAll`/`lexicalUpTo`, budget 제한 색인 메서드를 제공한다
- `IndexingError` — `reason: read-failed | revalidation-failed | mapping-commit-failed`
- `EmbeddingSetup` / `EmbeddingSetup.layer` / `GpuState` — 설정 화면용 서비스와 `EmbeddingOverview["gpu"]`의 `Data.taggedEnum` 생성자. 앱 API settings group(`apps/agent/app/.server/api/settings.ts`)이 사용한다. layer를 만들 때 lexical 기록 반영(`lexicalAll`, 임베더와 무관)과, 로컬 임베더의 모델 적재(준비 입력 하나를 임베딩해 첫 메시지의 검색이 적재를 기다리지 않게 한다), 벡터 backfill(`indexAll`)을 이 순서로 layer Scope에 fork한다. `downloads`는 `ModelDownloads.current`이고, `retryDownload(purpose)`는 그 용도의 다운로드가 `failed`일 때만 모델을 다시 불러온다(임베딩은 적재·backfill, `rerank`는 `Reranker.retry`, `gpu-check`는 WebGPU 확인). `Reranker`를 요구한다
- `EmbeddingOverview` — 설정 화면 개요 Schema(choice, running, next, gpu, unindexed, maintenance)(`contracts.ts`). 다운로드는 따로 `GET /api/settings/model-downloads`로 읽는다. 서버 코드를 import하지 않아 앱 API 계약과 브라우저가 쓴다
- 하위 디렉터리 없음

## Invariants

- 모델 워커는 한 번에 요청 하나만 처리한다. 워커 쪽 `RpcServer` concurrency 1, 호스트 쪽 `RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 })`, `modelWorker`의 잠금(`TxRef` 두 개)이 이를 보장한다. 잠금은 문서 전체가 아니라 물리적 워커 요청 하나를 묶는다. `interactive` 요청이 기다리거나 도는 동안에는 `background` 요청이 워커를 잡지 못한다. 그래서 질문은 이미 기다리던 backfill 요청보다 먼저, backfill 배치 사이에 들어간다. backfill은 질문이 없을 때 이어서 돈다
- `EmbeddingWorkerFailed.stage`가 `run`이면 세션을 유지한다. `load`나 `lost`이면 세션을 버리고 다음 요청이 새 워커를 띄운다(`keepsSession`). 워커는 모델을 `Effect.cached`로 한 번만 로드하며, 실패한 로드는 그 워커에서 계속 실패로 남는다. 로드한 모델의 `dispose()`는 워커 Scope finalizer에 등록되므로, 호스트가 워커를 닫으면 onnxruntime 세션이 스레드 종료 전에 해제된다
- 세션은 호출자 Scope가 소유한 `ScopedRef`에 있다. 세션을 교체하거나 Scope를 닫으면 워커를 멈추고 종료를 기다린다. `ScopedRef.set`은 uninterruptible로 획득하므로 모델 로드는 `Effect.interruptible`로 감싸야 한다
- ONNX 추론은 그 자리에서 중단할 수 없다. 진행 중 작업은 `terminate`로만 멈춘다. 워커 안의 `Embed` 실행은 `Effect.uninterruptible`이어서, 중단된 요청도 세션 실행이 끝날 때까지 기다리고 실행 도중에는 모델이 dispose되지 않는다. 유휴 워커는 `unref` 상태여야 하고, 작업 중에만 `busy`로 `ref`한다
- `EmbedderApi.embed`는 L2 정규화된 벡터를 입력 순서대로 돌려준다. role의 prompt는 호스트가 붙이고, 토큰 수와 배치도 prompt를 붙인 텍스트로 정한다. 워커 `Embed` RPC는 모델의 `output`에서 읽은 정규화 전 행을 32비트 float로 돌려주며 버퍼는 복사하지 않고 transfer한다
- 모델 표 항목의 벡터를 바꾸는 변경(prompt 포함)은 그 파일의 `tag`도 바꾼다. identity가 바뀌어야 indexer가 모든 노드를 다시 임베딩한다
- `Embedder.identity`는 이전 벡터와 비교할 수 없게 되면 바뀌어야 한다. 네이티브 캐시 디렉터리는 `<storage>/vectors/<sha256(identity) 앞 16자>`이고, SQL 매핑은 모두 `embedder = identity`로 구분한다
- chunk vector id는 `chunkVectorIdFloor`(2^52, migration CHECK) 이상이고 node seq는 그 아래에 둔다. 검색 결과 `nodeHits`는 이 경계로 chunk id와 node seq를 구분한다
- `ChunkSpan`은 원문의 UTF-16 offset이며 surrogate pair를 쪼개지 않는다. span 길이는 special token을 포함해 재고, overlap은 special token 없이 잰다. `EmbeddingModel.maxTokens`(질의 한도)와 `chunkPolicy.tokens`(문서 청크 크기)는 서로 다른 값으로 유지한다
- `planBatches`는 짧은 텍스트부터 배치에 넣는다. 각 배치는 `batchSize` 이하이고 `(개수) × 최장² ≤ batchCost`를 지킨다
- `Indexer.indexBatch`는 `oneBatchAtATime` 세마포어로 직렬화한다. 같은 pending 노드가 두 번 색인되지 않게 하기 위해서다. `lexicalBatch`도 자기 세마포어로 직렬화한다
- `lexicalBatch`는 `lexical_changes`를 id 순으로 최대 512개 읽고, 원문이 약 1MiB(`octet_length`)를 넘기 전까지의 앞부분만 반영한다(최소 1개). 비었거나 숨긴 노드, 지운 노드는 색인에서 뺀다. 반영한 마지막 id까지 지우므로 그 사이에 기록된 변경은 남는다
- native 소유자를 열 때 lexical 색인의 build 이름이 `lexical_index`와 다르거나 없으면 색인을 비우고 새 이름(uuidV7)을 준 뒤, 한 transaction에서 기록을 지우고 모든 노드를 최신순으로 다시 기록하고 이름을 저장한다. lexical 색인 폴더는 `<storage>/lexical/<layout hash 16자>`다
- 색인 순서는 다음과 같다. chunk 분할과 embed는 publication gate 밖에서 실행한다. 재검증(`selectFresh`), chunk id 예약, 네이티브 add/save, commit은 `vectors.publish` 안에서 실행한다. chunk 예약 INSERT는 한 트랜잭션에서 순차 실행해 RETURNING id가 chunk 순서와 맞게 한다
- `node_vectors` 행만이 완전히 커밋된 노드를 뜻한다. commit 트랜잭션은 노드를 다시 읽어 텍스트가 같을 때만 `indexed`로 처리한다. 다르면 `stale-chunks`(chunk 행 삭제) 또는 `stale-whole`(`memory_graph_vector_removals`에 기록)로 처리한다. 시작 시 `node_vectors` 표시가 없는 예약 chunk는 네이티브에서 제거하고, 매핑을 삭제하고, 제거 저널을 acknowledge한다
- 네이티브 소유자 워커가 유일한 색인·lease 소유자이며 명령을 하나씩 실행한다. remove는 id를 하나씩 보내지 않고 배치 하나를 한 owner 단계로 보낸다. `remove`는 네이티브 await 전에 모든 노드의 chunk id를 한 트랜잭션에서 읽는다
- `publish`와 `flushRemovals`는 같은 `mutate`로 publication gate에 들어간다. 그 안의 갱신이 실패하면 게이트가 멈추고, 이후 읽기와 갱신은 owner를 다시 열 때까지 `stopped`로 실패한다. 그래서 `mutate`가 멈춘 원인을 그 자리에서 warn 로그(`Vector index stopped after a failed update`)로 한 번 남긴다. 태그와 cause 사슬, `VectorIndexError.operation`, cause가 `NativeOwnerFailed`이면 그 `reason`까지만 적는다. cause의 SQL이나 경로는 남기지 않는다
- flush는 제거 저널과 live 매핑을 한 트랜잭션으로 snapshot한다. 그다음 네이티브 remove와 save를 실행하고, snapshot에 있던 id만 acknowledge한다. `owner.initialNeedsReset`이면 시작 시 flush와 네이티브 제거를 건너뛴다
- SQLite 변수 한도 때문에 id 목록은 statement당 1000개(`idsPerStatement`)로 나눈다
- `PRAGMA database_list`의 파일 경로가 비어 있으면 open이 `NativeOwnerFailed{native-incompatible}`로 실패한다. lease를 다른 프로세스가 쥐고 있으면(`lease-unavailable`) `VectorIndexError.message`가 같은 storage root를 쓰는 다른 서버를 멈추라고 안내한다
- 임베딩 대상은 `user`, `assistant`, `topic` kind뿐이다. tool call과 tool result는 임베딩하지 않는다(`docs/decisions.md`). pending 노드는 `created_at DESC, seq DESC` 순서로 고른다
- 다운로드 진행은 캐시에서 읽은 파일을 세지 않는다. 계획된 파일과 중간 보고가 온 파일만 내려받는 중으로 본다. 캐시에서 읽은 파일은 완료 보고 하나만 보낸다
- 호스트는 적재가 끝나면 `ended(exit)`를 부른다. 성공했거나 중단됐으면 그 용도의 다운로드를 지운다. 실패했는데 다운로드가 끝나지 않았으면(byte가 남았거나 크기를 몰랐거나 이미 `failed`) `failed`로 남긴다. 파일을 다 받은 뒤의 적재 실패(WebGPU 없음 등)는 다운로드 실패가 아니어서 지운다. `failed`는 다음 적재가 진행을 보고하거나 끝날 때까지 남는다
- 남은 시간은 크기를 안 첫 보고부터의 평균 속도로 계산하고, 5초가 지나기 전에는 `null`이다
- embed-worker는 `env.allowLocalModels = false`로 동작한다. `devices`를 선호 순서대로 시도하고, 짧은 텍스트 하나를 실제로 실행하는 첫 장치를 쓴다. 실패한 장치의 모델은 dispose한다. gpu 모드는 모델 표의 gpu 파일로 webgpu를 먼저 시도한 뒤 cpu로 넘어가고, cpu 모드는 cpu 파일을 쓴다. `textOnly` 모델은 config의 vision·audio 설정을 비우고 text 모델만 로드한다

## Side Effects

- worker_threads: `runtimeWorker("embed-worker")` 파일로 `new Worker`를 띄운다(NodeWorker). `worker.ref()`/`unref()`/`terminate()`를 호출한다. `checkGpu`는 별도 워커를 띄웠다가 끝낸다
- 네이티브 추론: `@huggingface/transformers`(onnxruntime-node)로 tokenizer와 모델을 로드한다. `env.cacheDir`를 설정하고 WebGPU 또는 CPU 장치를 쓴다. 모델 파일은 `<storage>/models` 캐시에 둔다. 워커가 닫힐 때 모델을 dispose하고, 실패하면 `embedding_model_dispose_failed`로 로그만 남긴다
- 네이티브 벡터 소유자: `runtimeWorker("native-search-worker")` 파일로 `NativeOwner.layer`를 연다. lease를 잡고 `<storage>/vectors/<hash>` 디렉터리에 색인을 저장한다(save/remove/add 명령)
- SQLite 읽기·쓰기 대상 테이블: `nodes`, `node_vectors`, `node_vector_chunks`, `memory_graph_vector_removals`, `memory_chunk_vector_removals`, `lexical_changes`, `lexical_index`. `PRAGMA database_list`를 조회하고 `sql.withTransaction`을 쓴다
- AppEvents: 색인이 하나 이상 커밋되면 `publishGlobal("embedding")`과 `publishGlobal("imports")`를 발행한다. `EmbeddingSetup`은 `ModelDownloads`가 바뀔 때마다 `publishGlobal("downloads")`를 발행한다
- 네트워크: 워커가 적재 전에 캐시에 없는 모델 파일마다 Hugging Face에 1byte Range 요청을 보내 크기를 읽는다(`plannedDownload`)
- 난수: `uuidV4`로 owner epoch과 명령별 requestId를 만든다
- 설정: `GlobalConfig` 설정(`embeddingDevice`, `gpuCheck`)을 읽는다. `setup.ts`가 설정을 갱신하는지는 읽지 않아 확인하지 못했다

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
