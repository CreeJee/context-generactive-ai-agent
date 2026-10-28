# morph

## Overview

`morph` 디렉터리는 검색어 추출용 한국어 형태소 분석기(Kiwi, `kiwi-nlp` WASM)를 제공한다. `analyzer.ts`의 `MorphAnalyzer` Effect 서비스가 호스트 쪽을 맡는다. 이 서비스는 고정 버전 모델을 `<storage>/models`에 내려받아 풀고, worker thread를 띄워 `effect/rpc`로 통신한다. `kiwi-worker.ts`는 그 worker 진입점으로 모델을 빌드하고 텍스트별 검색어(명사·어간·어근·한자·라틴어·숫자)를 돌려준다. `kiwi-rpc.ts`는 두 쪽이 공유하는 RPC 계약이다.

## Interface

- `MorphAnalyzer` — 한국어 형태소 분석 `Context.Service` 태그(키 `memory-agent/memory/morph/analyzer/MorphAnalyzer`)
- `MorphAnalyzer.kiwi` — Kiwi worker 기반 Layer. `StorageRoot`가 필요하고 `NodeFileSystem`·`NodePath`·`archiveInstallerLayer`는 내부에서 제공한다. 모델은 처음 쓸 때 내려받는다
- `MorphAnalyzer.disabled` — 분석기 없는 Layer. `identity: "none"`, `ready()` false, `terms`는 `reason: "disabled"`로 실패한다
- `MorphAnalyzerApi` — 서비스 인터페이스: `identity`, `ready()`, `warm()`, `terms(texts)` (`Effect<string[][], MorphAnalysisFailed>`)
- `MorphAnalysisFailed` — 호스트 쪽 TaggedError. `reason`은 `not_ready` | `disabled` | `model_install_failed` | `worker_failed`이고 `cause`는 선택(Defect)이다
- `kiwiModel` — 고정 모델 릴리스 상수(version `0.24.0`, GitHub tgz url, sha256, `models/cong/base`)
- `KiwiRpcs` — `Load`·`Terms`를 묶은 `RpcGroup`(호스트·worker 공유 계약)
- `Load` — worker에서 모델을 한 번 빌드하는 RPC. error는 `KiwiWorkerFailed`
- `Terms` — RPC. payload `{ texts: string[] }`를 받아 텍스트별 검색어 배열 `string[][]`을 순서대로 돌려준다
- `KiwiWorkerData` — worker 시작 데이터 Schema `{ modelDirectory: string }`와 그 타입
- `KiwiWorkerFailed` — worker 쪽 TaggedError. `stage`는 `load` | `run` | `lost`, `reason`은 string
- `kiwi-worker.ts` — worker thread 진입 모듈. 호스트가 `runtimeWorker("kiwi-worker")`로 띄우고, 모듈 최상위에서 `runNativeEffect(Layer.launch(server))`를 await한다

## Invariants

- `identity`(`kiwi-${kiwiModel.version}-cong-v1`)는 이전 검색어와 비교할 수 없는 검색어가 나올 때마다 바뀌어야 한다. 모델이나 토큰화 규칙을 바꾸면 identity도 올려야 한다.
- 모델 아카이브는 sha256(`kiwiModel.sha256`)을 확인한 뒤에만 푼다. 설치는 `<modelDirectory>/cong.mdl`이 없을 때만 실행한다.
- 한 번에 요청 하나만 처리한다. 호스트는 `Semaphore.make(1)`, worker는 `RpcServer.layer(..., { concurrency: 1 })`, 클라이언트 protocol은 `{ size: 1, concurrency: 1 }`이다. `busy`의 ref/unref 짝은 이 단일 요청 보장에 기댄다.
- worker는 생성 직후 `unref()`한다. 요청이 도는 동안만 `busy`가 `ref()`하므로 idle worker가 프로세스를 살려 두면 안 된다.
- `KiwiWorkerFailed.stage`에 따라 처리한다. `run`은 세션을 유지하고, `load`·`lost`는 세션을 버린다(`keepsSession`). 다음 요청이 새 worker를 띄운다.
- worker 안의 모델 빌드는 `Effect.cached`로 worker당 한 번만 한다. 실패한 빌드는 실패로 남고, 호스트가 새 worker로 교체한다.
- 세션은 layer Scope가 소유한 `ScopedRef`에 있다. 교체하거나 Scope를 닫으면 worker를 멈추고 종료를 기다린다. `ScopedRef.set`은 uninterruptible하게 acquire하므로 `connect`를 `Effect.interruptible`로 감싸야 Scope를 닫을 때 빌드가 멈춘다.
- idle worker를 종료하는 방식은 측정 후 폐기했다(주석: footprint가 줄지 않고 재시작마다 ~900 MB 피크와 ~2 s가 든다). worker는 처음 쓸 때 띄우고 계속 유지한다.
- `ready()`는 세션이 있을 때만 true다. 검색은 로딩을 기다리지 말고 `warm()`을 호출한 뒤 형태소 없이 진행해야 한다(주석).
- `warm()`은 `oneRequest` 허가를 잡고 layer Scope에 fork한다. 실패하면 `morph_warm_failed`로 로그만 남기고 not ready 상태로 둔다.
- 텍스트는 64개 배치(`batchSize`)로 나눠 보내고, 텍스트마다 앞 20,000자(`maxCharacters`)까지만 분석한다. 결과 순서는 입력 순서와 같다.
- worker는 `workerData`를 `KiwiWorkerData` Schema로 decode한다. 필드는 모두 호스트가 정한다.
- WASM 경로는 `createRequire(import.meta.url).resolve("kiwi-nlp")` 옆의 `kiwi-wasm.wasm`으로 정한다. 번들된 호출자에서도 경로가 맞아야 하기 때문이다.
- 모델 디렉터리를 읽을 때 심볼릭 링크(깨진 링크 포함)는 제외하고 regular file만 넣는다. 예전 readdir `isFile` 계약을 유지하기 위해서다.
- 검색어 규칙: 입력은 NFKC로 정규화하고 결과는 소문자로 바꾼다. 품사 태그는 `NNG`,`NNP`,`NR`,`VV`,`VA`,`XR`,`SH`만 남기고 태그의 `-R`/`-I` 접미사는 뗀다. `lightStems`(하·되·있 등)는 뺀다. 공백 없이 붙은 명사 연속은 합친 복합어로도 하나 더 넣는다. 라틴 문자·숫자는 Kiwi 토큰에서 빼고 원문에서 `/[\p{Script=Latin}\p{Nd}]+/gu`로 따로 뽑는다.
- `Load` RPC가 성공한 뒤에만 세션을 돌려준다. 전송 오류(`RpcClientError`, `WorkerError`)는 `stage: "lost"`로 바꾼다.

## Side Effects

- 네트워크: `ArchiveInstaller.install`이 GitHub 릴리스에서 Kiwi 모델 tgz를 내려받는다(`kiwiModel.url`).
- 파일 시스템(호스트): `<storage>/models`를 `mode: 0o700`, recursive로 만든다. 아카이브는 `<storage>/models/kiwi-0.24.0`에 푼다. `fs.exists`로 `cong.mdl`이 있는지 확인한다.
- worker thread: `node:worker_threads`의 `Worker`를 `runtimeWorker("kiwi-worker")` 파일과 `runtimeWorkerOptions(data)`로 띄운다. 요청 동안 `ref()`, 끝나면 `unref()`한다. Scope를 닫거나 세션을 교체하면 worker를 종료한다.
- 파일 시스템(worker): 모델 디렉터리에서 `readDirectory`, `readLink`, `stat`, `readFile`을 실행한다. `kiwi-wasm.wasm`을 로드한다(`KiwiBuilder.create`). 모델 빌드 피크는 ~850–900 MB 메모리다.
- 백그라운드 fiber: `warm()`이 `Effect.runForkWith`로 layer Scope 안에 로딩 fiber를 fork한다. 실패하면 `morph_warm_failed` 로그를 남긴다.
- worker 모듈은 import 시점에 top-level `await runNativeEffect(Layer.launch(server))`로 RPC 서버를 띄운다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
