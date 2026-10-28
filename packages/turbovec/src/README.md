# turbovec/src

## Overview

`packages/turbovec/src`는 napi-rs로 Node에 노출하는 Rust 네이티브 모듈이다. `turbovec::IdMapIndex` 양자화 벡터 인덱스를 `VectorIndex`로 감싼다. 요청마다 취소와 시간 예산을 관리하는 `SearchControl` 레지스트리를 둔다. `MemoryReadSession`은 에이전트 SQLite DB를 읽기 전용으로 열고, vector·FTS 텍스트(trigram/short)·morph 채널을 묶은 seed 순위 읽기를 한 번의 스냅샷 안에서 수행한다. SQLite는 별도로 링크하지 않고, 호스트 Node 프로세스의 SQLite를 확장 진입점(`sqlite3_turbovec_init`)으로 빌려 쓴다. 저장소 `CLAUDE.md`는 이 패키지를 이전 POC의 네이티브 모듈로 설명한다.

## Interface

- `VectorIndex` — napi 클래스. `new(dimensions, bits)`, `add(vectors, ids)`, `search(query, k, allowedIds?)`, `searchControlled(query, k, token, ownerKey, epoch, requestId, allowedIds?)`, `remove(id)`, `save(path)`, 팩토리 `load(path)`, `dimensions()`, `bits()`, `size()`, `close()`, `validateIds(ids)`를 제공한다
- `SearchResult` — napi 객체 `{ ids: string[], scores: f64[] }`. `VectorIndex.search`의 결과다
- `CacheLease` — napi 클래스. 생성자는 경로의 파일을 열거나 만들고(0o600) 배타적 non-blocking 락을 잡는다. `close()`로 락을 놓는다
- `SearchControl` — napi 클래스. `new(token, ownerKey, epoch, requestId, remainingMs)`, `token()`, `snapshotWasPinned()`, `cancel()`, `close()`, static `count()`를 제공한다. 요청별 취소와 deadline 상태를 전역 레지스트리에 등록한다
- `ControlledSearchResult` — napi 객체 `{ kind, ids, scores, nativeWindow, nativeMs }`. `kind`는 Outcome 태그 문자열이다
- `MemoryReadSession` — napi 클래스. `new(databasePath)`는 읽기 전용 SQLite 연결을 연다. `close()`, `search(index, input, token, ownerKey, epoch, requestId) -> NativeReadOutput`을 제공한다
- `NativeReadInput` — napi 객체. `allowedProjects`, `embedder`, `query?`, `trigramTerms`, `shortTerms`, `morphTerms`, `vectorK`/`textK`/`morphK`, `textEnabled`, `morphEnabled`, `remainingMs`, `input`/`outputBudgetBytes` 필드를 가진다
- `NativeReadOutput` — napi 객체. `kind`, `vectorIds`/`vectorSeqs`/`vectorScores`, `vectorUnavailable`, `textIds`, `morphIds`, `unindexed`, `uninterpreted`, `candidateCount`, `sqliteExecutions`, 단계별 `*Ms`, `failedStage?`, `input`/`outputLogicalBytes` 필드를 가진다
- `sqlite3_turbovec_init` — `#[no_mangle] extern "C"` SQLite 확장 진입점(`node-sqlite` feature). 호스트 SQLite의 API 테이블을 한 번만 초기화한다
- `sqlite_bridge::ensure_initialized` — crate 내부 함수. 브리지가 `SQLITE_OK_LOAD_PERMANENTLY`로 초기화되지 않았으면 "Node SQLite bridge is not initialized" 오류를 낸다. `test-sqlite` 빌드에서는 항상 Ok를 돌려준다
- `search_control::{Outcome, claim, admitted, search, outcome}` — crate 내부 제어 API. Outcome 태그는 `success`/`cancelled`/`budget-exceeded`/`invalid-input`/`index-failed`/`read-failed`이다. `claim`은 토큰을 일회성으로 획득하고, `admitted`는 측정 시간 기반으로 진입을 허용한다
- 하위 디렉터리 없음

## Invariants

- 벡터 ID는 정규형 u64 10진 문자열이어야 한다. `parse_id`는 "01"이나 u64 범위를 넘는 값처럼 왕복 문자열이 다른 값을 "Non-canonical vector ID"로 거부한다
- `validateIds`는 ids 개수가 인덱스 크기와 같고, 모든 ID가 정규형이면서 중복이 없고, 모두 인덱스에 있어야 통과한다. 아니면 "Vector snapshot mapping mismatch"를 낸다
- `VectorIndex`의 동기 메서드는 소유 Node worker 안에서만 호출된다(주석 근거). `close()` 뒤의 호출은 "Vector index is closed"로 실패하고, `close`는 멱등이다
- `search`의 `allowedIds`가 생략되면 전체 인덱스를 검색하고, 빈 배열이면 결과 없이 반환한다. query 길이는 인덱스 차원과 같아야 한다
- SQLite는 호스트 Node 프로세스의 것만 쓴다. 두 번째 SQLite를 링크하면 살아 있는 WAL SHM 매핑이 잘릴 수 있다. `node-sqlite`와 `test-sqlite` feature는 함께 켤 수 없고, `test-sqlite`는 Rust 단위 테스트 실행 파일에서만 허용된다(`compile_error`로 강제)
- `sqlite3_turbovec_init`는 SQL 함수나 DB 효과를 등록하지 않는다. 확장 코드와 API 테이블은 프로세스 수명 동안 상주한다
- `MemoryReadSession` 경로는 빈 문자열, `":memory:"`, `"file:"`로 시작하는 값을 받지 않는다. 연결은 `READ_ONLY|NO_MUTEX`로 열고 `PRAGMA query_only=ON`을 건다. 권한 확인과 인덱스 게시 직렬화는 호스트가 맡는다
- worker teardown 전에 `MemoryReadSession.close()`로 SQLite를 닫아야 한다. 나중의 N-API GC가 WAL 매핑을 붙잡으면 안 되기 때문이다
- `EMBEDDED_KINDS`(`n.kind IN ('user', 'assistant', 'topic')`)는 `nodes_embeddable` 부분 인덱스의 조건과 글자까지 같아야 한다. 다르게 쓰면 SQLite가 그 인덱스를 쓰지 않는다
- `ReadGuard`는 명시적 `finish`로 끝내야 하고, Drop은 unwinding 대비책일 뿐이다. `finish`는 progress handler를 지우고 ROLLBACK한다. autocommit으로 돌아오지 못하면 세션을 poisoned로 표시하고, 이 표시는 이후에도 유지된다
- snapshot pinned 표시(`mark_snapshot_pinned`)는 `BEGIN DEFERRED`와 실제 읽기가 성공해 SQLite 스냅샷을 고정한 뒤에만 게시한다
- `snapshotWasPinned`는 요청 로컬의 단조 이벤트일 뿐 스냅샷이 아직 살아 있다는 증거가 아니다. 실제 완료·취소와 owner 순서는 호스트가 따로 관찰해야 한다
- 읽기 결과에서 vector 엔진 실패만 vector 채널을 degrade한다(`vectorUnavailable=true`). 제어 실패와 SQLite 실패는 원자적으로 실패한다. 호출자는 제어 상태를 먼저 확인해야 한다
- 실패한 읽기 출력에는 히트나 coverage가 없다. 끝난 단계의 시간, 지금까지 잰 실행 중 단계의 시간, 그리고 `failedStage`만 담는다
- 읽기 입력 검증 조건: input/output 예산은 1~1,048,576바이트이다. query는 차원이 일치하고 유한하며 |x|<1e16이어야 하고, 그때 `vectorK`>0이어야 한다. text/morph가 켜져 있으면 해당 k>0이어야 한다. 문자열은 비어 있지 않고 65536바이트 이하여야 한다. 어긴 입력은 `invalid-input`이 된다
- `SearchControl` 등록 조건: token/ownerKey/epoch/requestId는 비어 있지 않고 256바이트 이하여야 한다. `remainingMs`는 유한하고 0~86,400,000 범위여야 한다. 동시 등록은 최대 4096개이고, 같은 seed는 중복 등록할 수 없다
- 발급 토큰은 `{seed}:{serial}` 형식이다. serial은 전역 `AtomicU64`로 단조 증가하며 재사용하지 않는다. 고갈되면 "Control token exhausted"를 낸다
- `claim`은 token·ownerKey·epoch·requestId가 모두 일치할 때 compare_exchange로 한 번만 성공한다. `SearchControl`의 close와 drop은 레지스트리 항목이 같은 Arc일 때만 제거한다
- 진입 허용은 측정 시간 기반 정책이며, 선점형 deadline 보장이 아니다. `admitted` 조건은 dim==384, bits==4, k<=48, remaining >= max(previous, 12ms)이다. 같은 요청의 다음 호출은 남은 예산이 이전 호출 시간을 덮을 때만 허용된다. 인덱스와 allowlist 크기는 진입 기준이 아니다(`docs/decisions.md` 2026-10-20)
- `searchControlled`는 기존의 early-empty 의미(빈 인덱스나 빈 allowlist면 엔진을 호출하지 않음)를 지킨다. 엔진은 정확히 한 번 호출한다. 후보를 자르거나 엔진·인덱스·writer를 바꾸지 않는다(주석 근거)

## Side Effects

- `CacheLease`: 경로의 파일을 read/write/create로 연다. truncate하지 않고, unix에서는 0o600 권한이다. close나 drop 전까지 OS 배타 파일 락을 잡고 있다
- `VectorIndex.save`는 인덱스 파일을 디스크에 쓰고, `VectorIndex.load`는 디스크에서 읽는다
- `MemoryReadSession`: SQLite 파일을 읽기 전용으로 연다. 요청마다 `BEGIN DEFERRED`/`ROLLBACK`을 실행하고, 1000 VM op마다 취소와 deadline을 확인해 중단하는 progress handler를 건다
- SQLite에서 읽는 테이블: `nodes`, `nodes_fts`, `nodes_morph`, `node_vectors`, `node_vector_chunks`, `interpret_jobs`, `memory_graph_suppressed_nodes`, `sqlite_schema`
- 프로세스 전역 상태: `REGISTRY`(`OnceLock<Mutex<HashMap<String, Arc<RequestState>>>>`), `NEXT_TOKEN`(`AtomicU64`), `INITIALIZED`(`OnceLock<i32>`)
- `sqlite3_turbovec_init`: 호스트 SQLite의 `sqlite3_load_extension`이 부르는 C ABI 심볼이다. 확장을 영구 로드(`SQLITE_OK_LOAD_PERMANENTLY`)한다
- 시간 측정과 deadline에 단조 시계 `Instant::now()`를 쓴다

## Verification

- Run: `vp run turbovec#build`
- Run: `cargo check` (`packages/turbovec`에서)
