# embedding

## Overview

memory-agent의 임베딩 계층이다. 로컬 granite 임베딩 모델을 워커 스레드(onnxruntime-node, Effect RPC)에서 돌리는 `Embedder`, 문서를 토큰 창으로 자르는 `chunkText`, turbovec 네이티브 소유자 워커 위의 `VectorIndex`, nodes 테이블과 벡터 색인을 맞추는 `Indexer`를 제공한다. `EmbeddingSetup`은 설정 화면(`apps/agent`의 `settings.embedding` 라우트)에 실행 모드와 WebGPU 상태를 알려 준다. 이 디렉터리는 SQLite의 `nodes`/`node_vectors`/`node_vector_chunks` 매핑과 네이티브 벡터 저장소 사이의 게시(publication) 순서를 책임진다.

## Interface

- `Embedder` — `Context.Service<Embedder, EmbedderApi>`. `Embedder.local`은 GlobalConfig 설정과 메모리로 모드를 골라 `<storage>/models`의 로컬 모델 Layer를 만들고, `Embedder.localVariant(variant)`는 모델 파일 평가용 Layer다
- `EmbedderApi` — `identity`(비교 불가 벡터가 되면 바뀜), `dimensions`, `embed`(L2 정규화 벡터), 선택적 `chunks`, `runtime()`
- `EmbedderRuntime` — `Data.TaggedEnum`. `local{mode, device}` 또는 `other`(테스트·평가용)
- `EmbeddingError` — 임베더 실패를 나타내는 TaggedError(`cause: Defect`)
- `EmbeddingMode` / `ModelVariant` / `modelFile(variant)` — cpu/gpu 모드, fp32/quint8 변형, 모델 캐시 안의 `onnx/<file>.onnx` 경로
- `localModel` — `ibm-granite/granite-embedding-97m-multilingual-r2`, 384차원, maxTokens 2048, batchSize 16, batchCost 2048²
- `normalize` — Float32Array를 L2 정규화한다
- `planBatches` — dual 함수. 토큰 수 오름차순으로 크기·비용 제한 안에서 배치 인덱스를 묶는다
- `embeddingModeFor` / `gpuMemoryThreshold` — dual 함수로 설정(`embeddingDevice` cpu/gpu/auto)과 메모리에서 모드를 정한다. auto는 16GiB 이상이고 gpuCheck가 available일 때만 gpu
- `ModelSession` — 실행 중인 모델 워커 하나의 인터페이스(device, countTokens, embed, chunk, terminate, busy)
- `modelWorker(cacheDir, setup, connect?)` — 첫 요청 때 워커를 띄워 `ScopedRef`에 유지하는 세션 관리자. 테스트는 `connect`로 세션을 주입한다
- `checkGpu(storageRoot)` — 전정밀도 모델이 WebGPU에서 로드·실행되는지 별도 워커로 확인한다. `setup.ts`가 호출
- `EmbeddingRpcs` (`Load`, `CountTokens`, `Embed`, `Chunk`) — 호스트와 embed-worker 사이의 RpcGroup 프로토콜
- `EmbeddingWorkerData` / `EmbeddingDevice` / `EmbeddingWorkerFailed` — 워커 시작 데이터 스키마, `cpu`/`webgpu` 장치, `stage: load|run|lost` 실패 타입
- `embed-worker.ts` — 워커 스레드 진입점. `runtimeWorker("embed-worker")`로 실행되고 `RpcServer.layer(EmbeddingRpcs, { concurrency: 1 })`을 띄운다
- `ChunkSpan` / `chunkPolicy` / `chunkVectorIdFloor` / `ChunkingFailed` / `chunkText` — UTF-16 offset span 스키마, 512토큰·128 overlap 정책(version 1), chunk vector id 하한 2^52, 청킹 실패, 이분 탐색 청킹
- `VectorIndex` / `VectorIndex.layer` — 네이티브 벡터 색인 서비스. NodeCrypto·NodePath를 공급하고 `makeNativeVectorIndex`를 Scope에서 획득한다
- `VectorIndexApi` / `VectorBackend` / `VectorHit` / `VectorIndexError` — add/remove/search/save/flushRemovals/publish와 native read API, 검색 결과(seq, cosine score), operation별 오류
- `makeNativeVectorIndex` — 네이티브 소유자 워커를 열고 시작 시 제거 저널과 예약 chunk를 정리하는 유일한 프로덕션 백엔드
- `Indexer` / `Indexer.layer` — nodes 테이블과 벡터 색인을 맞춘다. `pending`, `indexBatch`, `analyzeBatch`, `analyzeAll`, `indexAll`, budget 제한 색인 메서드를 제공한다
- `IndexingError` — `reason: read-failed | revalidation-failed | mapping-commit-failed`
- `embeddedKinds` / `embeddedKindFilter` — 임베딩 대상 kind(`user`, `assistant`, `topic`)와 별칭 `n` 기준 SQL 필터 문자열
- `EmbeddingSetup` / `EmbeddingSetup.layer` / `EmbeddingOverview` / `GpuState` — 설정 화면용 서비스와 개요 타입(choice, running, next, memoryBytes, gpuMemoryThreshold, gpu, unindexed, maintenance). `apps/agent`의 `settings.embedding.tsx` loader/action이 사용한다(그래프로만 확인)
- 하위 디렉터리 없음

## Invariants

- 모델 워커는 한 번에 요청 하나만 처리한다. 워커 쪽 `RpcServer` concurrency 1, 호스트 쪽 `RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 })`, `modelWorker`의 `Semaphore.make(1)`이 이를 보장한다. 세마포어는 문서 전체가 아니라 물리적 워커 요청 하나를 묶는다. 그래서 질의가 backfill 배치 사이에 끼어들 수 있다
- `EmbeddingWorkerFailed.stage`가 `run`이면 세션을 유지한다. `load`나 `lost`이면 세션을 버리고 다음 요청이 새 워커를 띄운다(`keepsSession`). 워커는 모델을 `Effect.cached`로 한 번만 로드하며, 실패한 로드는 그 워커에서 계속 실패로 남는다
- 세션은 호출자 Scope가 소유한 `ScopedRef`에 있다. 세션을 교체하거나 Scope를 닫으면 워커를 멈추고 종료를 기다린다. `ScopedRef.set`은 uninterruptible로 획득하므로 모델 로드는 `Effect.interruptible`로 감싸야 한다
- ONNX 추론은 그 자리에서 중단할 수 없다. 진행 중 작업은 `terminate`로만 멈춘다. 유휴 워커는 `unref` 상태여야 하고, 작업 중에만 `busy`로 `ref`한다
- `EmbedderApi.embed`는 L2 정규화된 벡터를 입력 순서대로 돌려준다. 워커 `Embed` RPC는 정규화 전 CLS 행을 돌려주며 버퍼는 복사하지 않고 transfer한다
- `Embedder.identity`는 이전 벡터와 비교할 수 없게 되면 바뀌어야 한다. 네이티브 캐시 디렉터리는 `<storage>/vectors/<sha256(identity) 앞 16자>`이고, SQL 매핑은 모두 `embedder = identity`로 구분한다
- chunk vector id는 `chunkVectorIdFloor`(2^52, migration CHECK) 이상이고 node seq는 그 아래에 둔다. 검색 결과 `nodeHits`는 이 경계로 chunk id와 node seq를 구분한다
- `ChunkSpan`은 원문의 UTF-16 offset이며 surrogate pair를 쪼개지 않는다. span 길이는 special token을 포함해 재고, overlap은 special token 없이 잰다. `localModel.maxTokens`(질의 한도)와 `chunkPolicy.tokens`(문서 청크 크기)는 서로 다른 값으로 유지한다
- `planBatches`는 짧은 텍스트부터 배치에 넣는다. 각 배치는 `batchSize` 이하이고 `(개수) × 최장² ≤ batchCost`를 지킨다
- `Indexer.indexBatch`는 `oneBatchAtATime` 세마포어로 직렬화한다. 같은 pending 노드가 두 번 색인되지 않게 하기 위해서다. `analyzeBatch`도 자체 세마포어로 직렬화한다
- 색인 순서는 다음과 같다. chunk 분할과 embed는 publication gate 밖에서 실행한다. 재검증(`selectFresh`), chunk id 예약, 네이티브 add/save, commit은 `vectors.publish` 안에서 실행한다. chunk 예약 INSERT는 한 트랜잭션에서 순차 실행해 RETURNING id가 chunk 순서와 맞게 한다
- `node_vectors` 행만이 완전히 커밋된 노드를 뜻한다. commit 트랜잭션은 노드를 다시 읽어 텍스트가 같을 때만 `indexed`로 처리한다. 다르면 `stale-chunks`(chunk 행 삭제) 또는 `stale-whole`(`memory_graph_vector_removals`에 기록)로 처리한다. 시작 시 `node_vectors` 표시가 없는 예약 chunk는 네이티브에서 제거하고, 매핑을 삭제하고, 제거 저널을 acknowledge한다
- 네이티브 소유자 워커가 유일한 색인·lease 소유자이며 명령을 하나씩 실행한다. remove는 id를 하나씩 보내지 않고 배치 하나를 한 owner 단계로 보낸다. `remove`는 네이티브 await 전에 모든 노드의 chunk id를 한 트랜잭션에서 읽는다
- flush는 제거 저널과 live 매핑을 한 트랜잭션으로 snapshot한다. 그다음 네이티브 remove와 save를 실행하고, snapshot에 있던 id만 acknowledge한다. `owner.initialNeedsReset`이면 시작 시 flush와 네이티브 제거를 건너뛴다
- SQLite 변수 한도 때문에 id 목록은 statement당 1000개(`idsPerStatement`)로 나눈다
- `PRAGMA database_list`의 파일 경로가 비어 있으면 open이 `NativeOwnerFailed{native-incompatible}`로 실패한다. lease를 다른 프로세스가 쥐고 있으면(`lease-unavailable`) `VectorIndexError.message`가 같은 storage root를 쓰는 다른 서버를 멈추라고 안내한다
- 임베딩 대상은 `user`, `assistant`, `topic` kind뿐이다. tool call과 tool result는 임베딩하지 않는다(`docs/decisions.md`). pending 노드는 `created_at DESC, seq DESC` 순서로 고른다
- embed-worker는 `env.allowLocalModels = false`로 동작한다. `devices`를 선호 순서대로 시도하고, 짧은 텍스트 하나를 실제로 실행하는 첫 장치를 쓴다. 실패한 장치의 모델은 dispose한다. gpu 모드는 fp32 파일로 webgpu를 먼저 시도한 뒤 cpu로 넘어가고, cpu 모드는 quint8 파일을 쓴다

## Side Effects

- worker_threads: `runtimeWorker("embed-worker")` 파일로 `new Worker`를 띄운다(NodeWorker). `worker.ref()`/`unref()`/`terminate()`를 호출한다. `checkGpu`는 별도 워커를 띄웠다가 끝낸다
- 네이티브 추론: `@huggingface/transformers`(onnxruntime-node)로 tokenizer와 모델을 로드한다. `env.cacheDir`를 설정하고 WebGPU 또는 CPU 장치를 쓴다. 모델 파일은 `<storage>/models` 캐시에 둔다
- 네이티브 벡터 소유자: `runtimeWorker("native-search-worker")`로 `makeNativeOwner` 워커를 연다. lease를 잡고 `<storage>/vectors/<hash>` 디렉터리에 색인을 저장한다(save/remove/add 명령)
- SQLite 읽기·쓰기 대상 테이블: `nodes`, `node_vectors`, `node_vector_chunks`, `memory_graph_vector_removals`, `memory_chunk_vector_removals`, `nodes_morph`, `node_morphs`. `PRAGMA database_list`를 조회하고 `sql.withTransaction`을 쓴다
- AppEvents: 색인이 하나 이상 커밋되면 `publishGlobal("embedding")`과 `publishGlobal("imports")`를 발행한다
- Crypto: `randomUUIDv4`로 owner epoch과 명령별 requestId를 만든다
- 설정·호스트 정보: `GlobalConfig` 설정(`embeddingDevice`, `gpuCheck`)과 `totalMemory`(host-system)를 읽는다. `setup.ts`가 설정을 갱신하는지는 읽지 않아 확인하지 못했다

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
