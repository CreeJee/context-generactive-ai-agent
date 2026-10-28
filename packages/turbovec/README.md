# turbovec

## Overview

`packages/turbovec`는 `turbovec` 양자화 벡터 인덱스와 읽기 전용 SQLite 읽기 세션을 Node에 노출하는 로컬 N-API 바인딩 패키지(`turbovec`, private, ESM)다. 최상위에는 Rust 크레이트 매니페스트(`memory-turbovec`, cdylib), 컴파일된 `memory-turbovec.node`를 로드하는 JS 진입점(`index.js`), 그 타입 계약(`index.d.ts`), cargo 빌드 후 애드온을 원자적으로 교체하는 Effect 빌드 스크립트(`build-turbovec.ts`)가 있다. 실제 네이티브 로직은 `src`(napi-rs Rust)에 있고, memory-agent 쪽 worker thread가 `loadTurbovec()`로 애드온을 불러 `VectorIndex`·`MemoryReadSession`·`SearchControl`·`CacheLease`를 사용한다. 빌드 산출물은 로컬 머신 전용이며 크로스 플랫폼 바이너리 배포를 뜻하지 않는다.

## Interface

- `loadTurbovec()` — `createRequire`로 `memory-turbovec.node`를 불러 `TurbovecAddon`을 돌려준다. `vp run build`로 바이너리를 만들지 않았으면 throw한다
- `addonPath` — 로컬 빌드된 애드온(`memory-turbovec.node`)의 절대 경로 문자열
- `TurbovecAddon` — `{ VectorIndex, CacheLease, MemoryReadSession, SearchControl }` 클래스 묶음 타입
- `VectorIndex` — 정규화된 u64 10진 문자열 id로 키를 거는 양자화 inner-product 인덱스. `new(dimensions, bits)`, static `load(path)`, `add(vectors: Float32Array, ids)`, `search(query, k, allowedIds?)`, `searchControlled(query, k, token, ownerKey, epoch, requestId, allowedIds?)`, `remove(id)`, `save(path)`, `dimensions()`, `bits()`, `size()`, `validateIds(ids)`, `close()`
- `SearchResult` — `{ ids: string[], scores: number[] }`. `VectorIndex.search` 결과
- `ControlledSearchResult` — `{ kind: "success"|"cancelled"|"budget-exceeded"|"invalid-input"|"index-failed", ids, scores, nativeWindow: "whole-call", nativeMs }`
- `SearchControl` — Rust가 소유한 일회성 요청 제어. `new(token, ownerKey, epoch, requestId, remainingMs)`, `token()`(새로 발급한 capability), `snapshotWasPinned()`, `cancel()`, `close()`, static `count()`
- `CacheLease` — 벡터 캐시 디렉터리에 한 프로세스만 쓰도록 OS 파일 락을 잡는 클래스. `new(path)`, `close()`
- `MemoryReadSession` — 읽기 전용 SQLite 세션. `new(databasePath)`, `close()`, `search(index, input, token, ownerKey, epoch, requestId) -> NativeReadOutput`
- `NativeReadInput` — `allowedProjects`, `embedder`, `query?`, `trigramTerms`/`shortTerms`/`morphTerms`, `vectorK`/`textK`/`morphK`, `textEnabled`/`morphEnabled`, `remainingMs`, `inputBudgetBytes`/`outputBudgetBytes`
- `NativeReadOutput` — `kind`(success/cancelled/budget-exceeded/invalid-input/read-failed/index-failed), `vectorIds`/`vectorSeqs`/`vectorScores`, `vectorUnavailable`, `textIds`, `morphIds`, `unindexed`, `uninterpreted`, `candidateCount`, `sqliteExecutions`, 단계별 `candidateMs`/`vectorMs`/`textMs`/`morphMs`/`mappingMs`/`coverageMs`, `failedStage?`, `inputLogicalBytes`/`outputLogicalBytes`
- `build` (`vite.config.ts` run task) — `node build-turbovec.ts`를 실행한다. 캐시 입력은 `src/**`, `build.rs`, `Cargo.toml`, `Cargo.lock`, `build-turbovec.ts`, 출력은 `memory-turbovec.node`, env는 `CARGO`
- `build-turbovec.ts` — CLI 스크립트. `cargo build --release --locked`로 크레이트를 빌드하고 결과 라이브러리를 `memory-turbovec.node`로 복사한다. 실패는 `TurbovecBuildFailed`(`reason: "cargo-failed"|"unsupported-host"`, `exitCode?`)
- `memory-turbovec` (`Cargo.toml`) — cdylib 크레이트. feature `node-sqlite`(기본, `rusqlite/loadable_extension`), `test-sqlite`(`rusqlite/bundled`, Rust 단위 테스트 전용). 의존성 `napi` 3(napi8), `rusqlite =0.37.0`(hooks), git rev 고정 `turbovec`
- [`src`](./src/README.md) — napi-rs Rust 네이티브 모듈. `VectorIndex`, `SearchControl` 레지스트리, `MemoryReadSession`, `CacheLease` 구현
- [`wasm-check`](./wasm-check/README.md) — 고정된 `turbovec` 크레이트가 wasm 대상으로 빌드되는지 확인하는 컴파일 전용 프로브 크레이트

## Invariants

- 애드온은 worker thread 안에서 로드해야 하며 요청 경로에서 로드하지 않는다(`index.js` 주석).
- `VectorIndex`에 넣는 벡터는 호출자가 L2 정규화해야 한다. id는 정규화된 u64 10진 문자열이다.
- `search`의 `allowedIds`를 생략하면 전체 인덱스를 검색하고, 빈 allowlist는 결과를 돌려주지 않는다.
- `SearchControl`은 모든 종료 경로에서 `close()`해야 한다. 취소는 worker claim 이후에도 유지된다.
- `searchControlled`의 control은 입력 검증·복사·큐잉 전에 등록되어야 한다. 시간 제어는 측정 envelope 기반 admission과 협력적 사전·사후 검사이며 스캔 중 선점이 아니다.
- `SearchControl.token()`은 생성자에 준 엔트로피 seed가 아니라 새로 발급한 capability이며 재사용하지 않는다.
- `snapshotWasPinned()`는 실제 SQLite pin이 일어났는지를 나타내는 단조 이벤트이고 진행 중인 lease가 아니다. 완료 여부는 따로 추적해야 한다.
- `NativeReadInput.remainingMs`는 호환용 DTO 필드일 뿐이고, 등록된 `SearchControl`의 deadline이 기준이다.
- `MemoryReadSession`은 빌려 쓰는 `VectorIndex`와 같은 worker가 소유해야 한다.
- `NativeReadOutput.vectorUnavailable`이 true여도 text/morph/coverage 결과는 같은 깨끗한 스냅샷에서 나온 값이다. `failedStage`는 읽기 도중 실패한 단계만 표시하고, 성공했거나 읽기 전에 실패하면 없다.
- `VectorIndex.close()`는 멱등이며 이후 호출은 throw한다.
- 빌드는 이미 실행 중인 서버가 mmap한 라이브러리를 truncate하지 않도록 `memory-turbovec.node.<pid>.tmp`로 복사한 뒤 rename으로 교체해야 한다.
- 기본 feature `node-sqlite`는 SQLite를 링크하지 않고 호스트 프로세스의 SQLite를 loadable extension으로 빌린다. 자체 SQLite(`test-sqlite`, bundled)는 Rust 단위 테스트 실행 파일에서만 쓴다.
- cargo 빌드는 `--locked`로 실행하므로 `Cargo.lock`과 맞아야 한다. `turbovec` 의존성은 git rev `ccab9f325e6ce2a270a87daf01ae4e443bcf2d49`로 고정된다.
- 지원 빌드 호스트는 `darwin`·`linux`·`win32`뿐이며, 그 외 플랫폼은 `unsupported-host`로 실패한다.
- `target/`과 `*.node`는 git에서 무시된다. 바이너리는 로컬 빌드 산출물이며 배포 대상이 아니다.

## Side Effects

- `loadTurbovec()`가 `createRequire`로 네이티브 애드온 `memory-turbovec.node`를 프로세스에 로드한다.
- `build-turbovec.ts`가 자식 프로세스로 `cargo build --release --locked --manifest-path Cargo.toml`을 실행하고 stdin/stdout/stderr를 상속한다.
- `build-turbovec.ts`가 환경 변수 `CARGO`를 읽는다(기본값 `cargo`). vite 태스크 캐시도 `CARGO`를 키로 쓴다.
- `build-turbovec.ts`가 `target/release/<libmemory_turbovec.dylib|.so|memory_turbovec.dll>`을 `memory-turbovec.node.<pid>.tmp`로 복사한 뒤 `memory-turbovec.node`로 rename한다(파일 시스템 쓰기).
- `build-turbovec.ts`가 완료 메시지를 콘솔에 출력한다.
- `CacheLease` 생성 시 경로의 파일을 열거나 만들고 OS 파일 락을 잡으며, `close()`로 락을 놓는다(구현은 `src`).
- `VectorIndex.save(path)`/`load(path)`가 인덱스 파일을 쓰고 읽는다(구현은 `src`).
- `MemoryReadSession`이 `databasePath`의 SQLite DB를 읽기 전용으로 연다(구현은 `src`).
- `SearchControl`이 전역 레지스트리에 요청별 취소·deadline 상태를 등록하고 해제한다(구현은 `src`).

## Verification

- Run: `vp run turbovec#build`
- Run: `cargo check` (`packages/turbovec`에서)
