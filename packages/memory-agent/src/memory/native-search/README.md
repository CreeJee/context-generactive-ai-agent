# native-search

## Overview

`native-search`는 Rust/N-API 애드온 `turbovec`의 벡터 인덱스와 SQLite 읽기 세션을 전용 worker thread 하나에 가두는 계층이다. 호스트 쪽 `client.ts`의 `makeNativeOwner`/`NativeOwner`는 Effect RPC(`NativeOwnerRpcs`)로 worker를 띄운다. 호스트는 요청을 슬롯 1개와 대기 상한 32개로 직렬화하고, 취소·타임아웃·치명 실패를 관리한다.

`worker.ts`는 worker 진입점이다. 인덱스 add/remove/save/reset/validate/vector-search와 controlled memory-search를 실행한다. `contracts.ts`·`read-protocol.ts`·`worker-protocol.ts`는 전송 계약과 스키마를 제공한다. `publication.ts`는 인덱스 변경과 읽기 스냅샷 pin을 묶는 세대(generation) 게이트를 제공한다. 이 계층은 `packages/memory-agent/src/memory/embedding/native-vector-index.ts`의 `makeNativeVectorIndex`가 `makeNativeOwner`를 호출해 사용한다.

## Interface

- `makeNativeOwner` — `(setup: OwnerSetup, workerFile, connect = rpcTransport)`로 scoped native owner를 만드는 Effect.fn이다. `Crypto.Crypto`와 `Scope`가 필요하다. 반환 객체는 `NativeOwner` 서비스의 형태가 된다(주석상 `startRead`, `inspect` 등 포함).
- `NativeOwner` — `Context.Service` 클래스(`"memory-agent/memory/native-search/client/NativeOwner"`)다. `static layer(setup, workerFile)`이 `Layer.effect(makeNativeOwner)`에 `NodeCrypto.layer`를 제공한다. 컴포지션 루트용 Layer다.
- `rpcTransport` — 기본 `OwnerConnect`다. `node:worker_threads` Worker와 `RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 })`로 worker를 띄우고 `Open`으로 준비를 기다린다(2초 startup-timeout).
- `OwnerTransport` / `OwnerConnect` / `OwnerWorker` — 시작된 owner worker를 호스트가 다루는 인터페이스(`ready`, `send`, `exited`, `terminate`)와 연결 함수 타입이다. 테스트가 transport를 감쌀 때 쓴다.
- `ReadAdmission` — 읽기 진입 결과 TaggedEnum(`pinned` | `completed{reply}`)이다.
- `OwnerInspection` — `inspect` 결과 TaggedEnum(`open{queued, active}` | `failed{reason}`)이다.
- `OwnerSetup` — worker 설정 Schema(`epoch`, `dimensions`, `bits`, `cacheDirectory`, 선택 `ownerKey`/`databasePath`/`recover`)다.
- `OwnerCommand` — owner 명령 TaggedUnion(`add`, `remove`, `save`, `reset`, `validate`, `vector-search`, `vector-search-controlled`, `memory-search`)이다. 모든 명령에 `requestId`·`epoch`가 붙는다.
- `OwnerReply` — owner 응답 TaggedUnion(`ack`, `removed`, `vector-hits`, `controlled-result`, `memory-result`)이다.
- `NativeOwnerFailed` — Schema.TaggedError다. `reason` 리터럴 13종(`invalid-input`, `queue-full`, `input-budget`, `worker-exit`, `worker-error`, `startup-timeout`, `request-timeout`, `closed`, `epoch-mismatch`, `index-failed`, `lease-unavailable`, `read-failed`, `native-incompatible`)과 프로세스 내부에만 남는 `cause`를 가진다.
- `OwnerReady` / `Open` / `Execute` / `NativeOwnerRpcs` — 준비 보고 Schema와 Effect RPC 정의다. `Open`은 setup 결과를, `Execute`는 `OwnerCommand`를 `OwnerReply`로 처리한다.
- `NativeReadInput` / `NativeReadOutput` — native memory read의 입출력 Schema다. budget 0~2000ms, bytes ≤ 1 MiB, `vectorK ≤ maxVectorK` 범위를 검사한다.
- `nativeReadInputLogicalBytes` — 복사 전 경계에서 입력의 논리 바이트를 계산한다. 한도를 넘으면 `inputBudgetBytes + 1`을 반환한다.
- `TransferredVector` / `maxVectorK`(48) / `ReadStage` — 버퍼를 전송(transfer)하는 Float32Array Schema, 벡터 k 상한, 읽기 단계 순서 리터럴(candidate→vector→mapping→text→morph→coverage)이다.
- `NativeSearchRequest` / `NativeSearchOutcome` — 상위 검색 요청 계약과 결과 TaggedEnum(`success`, `degraded`, `cancelled`, `budget-exceeded`, `stale-generation`, `error`)이다.
- `NativeSearchClient` — 프레임워크 중립 비동기 전송 인터페이스(`search(request, signal) => Promise<NativeSearchOutcome>`, `close`)다.
- `nativeSearchBounds` — 고정 한도 상수(admittedSearches 32, activeSearches 1, workBudgetMs 2000, queuedAbortMs 50, activeAbortAcknowledgeMs 100, input/output 1 MiB)다.
- `QueryVectorChannel` / `MorphTermsChannel` / `TextTermsChannel` / `PublishedGeneration` / `ChannelBudgets` / `RankedChannels` / `RankedVectorHit` / `SearchCoverage` / `NativeStageMetrics` / `NativeSearchFailureCode` — `contracts.ts`의 채널별 TaggedEnum과 결과·지표 타입이다.
- `makePublication` — `(epoch)`로 세대 게이트를 만든다. `{ withMutation, admitSnapshot, read, inspect }`를 반환한다.
- `PublicationFailed` / `PublicationState` — 게이트 오류(`poisoned` | `owner-mismatch`)와 상태 TaggedEnum(`ready{generation}` | `poisoned{generation}`)이다.
- `worker.ts` (worker 진입점) — 최상위 `await runNativeEffect(Layer.launch(server))`로 `RpcServer.layer(NativeOwnerRpcs, { concurrency: 1 })`를 `NodeWorkerRunner` 위에서 실행한다.
- 하위 디렉터리 없음.

## Invariants

- owner는 한 번에 활성 작업 1개만 실행한다. 근거는 호스트 `Semaphore.make(1)` 슬롯, `RpcClient` `size: 1, concurrency: 1`, `RpcServer` `concurrency: 1`이다. 대기와 활성을 합친 요청 수는 `capacity = 32`를 넘지 않는다.
- 호출자가 떠나면 queued 작업은 dispatch 전에 멈춘다. 이미 active인 작업은 worker가 답할 때까지 슬롯을 놓지 않는다. 시작된 native 호출은 호출자가 떠나도 끝나지 않기 때문이다.
- `forget`은 `result` Deferred가 같은 작업만 지운다. 같은 requestId를 나중 작업이 재사용할 수 있기 때문이다.
- `cachedSize`의 유일한 writer는 reply ingress다. command waiter를 풀기 전에 갱신된다.
- reply 기한: `memory-search`는 `input.remainingMs`+2초, `vector-search-controlled`는 `budgetMs`+2초, 나머지 명령은 2초다. 이 기한 덕에 typed `budget-exceeded`가 `request-timeout`보다 먼저 도착한다.
- `index-failed`, `read-failed`, `native-incompatible`, `worker-exit`, `worker-error`는 `fatal`이다. 주석상 이후 아무것도 신뢰할 수 없다. worker 종료나 Scope 종료 시 `failAll`이 모든 대기 작업을 실패시키고 control을 닫는다.
- `controlToken`은 호스트 dispatch만 설정한다. 사용자 값은 채택하지 않는다. controlled 명령에 control이 없거나, worker에 `controlToken`/`ownerKey`가 없으면 `invalid-input`이다.
- `ownerKey`는 호스트가 `Crypto.randomUUIDv4`로 만드는 private binding이다. `databasePath`는 호스트 소유의 신뢰된 경로이며, 검색 요청에서 오지 않는다. 공개 검색은 후보 allowlist를 보내지 않는다.
- worker는 `command.epoch !== setup.epoch`이면 `epoch-mismatch`로 거부한다.
- IPC로는 `reason`만 넘는다. native 예외 메시지와 cache 경로는 worker 안에 남는다. worker의 `reported`는 `epoch-mismatch`, `invalid-input`, `read-failed`, `native-incompatible`, `lease-unavailable` 외 사유를 모두 `index-failed`로 바꾼다.
- 동기 native 호출과 파일시스템 호출은 owning worker 안에서만 한다. `NativeSearchClient` 구현은 무거운 동기 native search를 호출자 스레드에서 실행하면 안 된다.
- setup 검증: `dimensions`는 0보다 큰 8의 배수이면서 4294967295 이하다. `bits`는 1, 2, 4, 8 중 하나다. id는 canonical 10진 u64 문자열이다(20자 이하, 18446744073709551615 이하).
- add는 `vectors.length === ids.length * dimensions`이고 모든 값이 finite여야 한다. vector-search 계열은 `query.length === dimensions`이고 `0 < k ≤ 4294967295`여야 한다. memory read의 `vectorK`는 `maxVectorK`(48) 이하여야 하며, 넘으면 read 전체가 실패한다.
- 저장된 인덱스의 dimensions/bits가 setup과 다를 때 `recover !== true`이면 `index-failed`다. 재구축은 명시적 호스트 recovery로만 한다. 조용히 빈 owner로 바꾸지 않는다(`needsReset` 보고).
- save는 `index.tvim.tmp`에 쓴 뒤 `index.tvim`으로 rename한다. 인덱스는 GC가 아니라 교체될 때나 worker Scope가 닫힐 때 `close`된다. 읽기 세션은 인덱스보다 먼저 닫힌다.
- `TransferredVector`는 버퍼를 복사하지 않고 transfer한다. 호스트 명령은 소유한 복사본을 실어 보낸다.
- Publication: 모델/임베딩 작업은 `withMutation` 밖에서 해야 한다. `withMutation`은 gate permit 1개를 잡고 uninterruptible로 돈다. 실패하면 상태가 `poisoned`가 되고, 성공하면 generation이 +1 된다. poisoned 게이트는 명시적 owner recovery가 새 gate/epoch를 만들기 전까지 읽을 수 없다.
- `admitSnapshot`은 native 스냅샷 pin 확인 동안에만 gate를 잡는다. 큐 진입 동안이나 검색 전체 동안은 잡지 않는다. `read`는 handle의 epoch가 publication epoch와 다르면 `owner-mismatch`로 실패한다. `mapAdmissionError`는 게이트 자신의 admission 오류만 바꾼다.
- `nativeReadInputLogicalBytes`는 문자열을 스캔하기 전에 항목당 고정 오버헤드를 먼저 부과한다. 빈 항목으로 무한 배열을 숨기지 못하게 하려는 것이다.
- `PublishedGeneration.generation`은 canonical 비음수 10진 문자열이다. 런타임 간 정수 정밀도 손실을 피하기 위해서다.

## Side Effects

- `node:worker_threads` `Worker`를 생성하고 `terminate`한다(`rpcTransport`). worker 쪽은 최상위 `await runNativeEffect(Layer.launch(server))`로 RPC 서버를 실행한다.
- `requireRuntime("turbovec")`로 native 애드온을 로드하고 `initializeNodeSqlite(addon.addonPath)`를 호출한다(worker). `runtimeWorkerOptions(setup)`로 worker 옵션을 얻는다(호스트).
- `setup.databasePath`가 있으면 `node:sqlite` `DatabaseSync`를 read-only로 열어 `assertDatabaseSchema`를 실행하고 닫는다. 이어서 `binding.MemoryReadSession`으로 read-only SQLite 세션을 Scope 동안 연다.
- 파일시스템: `cacheDirectory`를 `mkdir -p`(mode `0o700`)로 만든다. `index.tvim`의 존재를 확인하고 load한다. save는 `index.tvim.tmp`에 쓴 뒤 rename한다.
- `binding.CacheLease`로 `cacheDirectory/writer.lock` 프로세스 간 lease(lock)를 Scope 동안 잡는다. 실패하면 `lease-unavailable`다.
- native `VectorIndex`의 add/remove/search/searchControlled/validateIds/save/close를 동기 호출한다. 인메모리 인덱스 상태가 바뀐다.
- `process.threadCpuUsage`와 `process.hrtime.bigint`로 worker CPU와 native 호출 구간을 측정한다.
- 호스트 인메모리 상태: `Ref`(job 원장, `cachedSize`, `PublicationState`), `FiberMap`, `Semaphore`. scoped fiber 하나가 worker 종료를 감시한다.
- 타이머: startup 2초 타임아웃과 명령별 reply 기한(2초 또는 budget+2초).
- `Crypto.randomUUIDv4`로 `ownerKey`를 생성한다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
