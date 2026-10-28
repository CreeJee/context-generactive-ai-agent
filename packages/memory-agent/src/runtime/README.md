# runtime

## Overview

`packages/memory-agent/src/runtime`은 memory-agent 백엔드가 Effect 바깥의 호스트·네이티브 경계와 만나는 곳이다. OS 정보, PATH와 셸, tar, 키체인과 암호화 비밀 파일, 네이티브 addon 로딩, AbortSignal을 다룬다. 실행 동시성 제한(`ExecutionAdmission`), 아카이브 설치(`ArchiveInstaller`/`ArchiveHost`), 실패 태그 로깅과 defect 보고 같은 공통 런타임 기반도 둔다. 다른 계층은 이 파일들을 통해 node:os·keychain·child process 같은 비-Effect API를 Effect·Layer·Context.Service 형태로 쓴다.

## Interface

- `ExecutionAdmission` — Context.Service(`memory-agent/runtime/execution-admission/ExecutionAdmission`). workflow/model/tool마다 active·queued 게이트를 두고 `acquire`, `run`, `snapshot`, `limits`를 제공함. `ExecutionAdmission.layer(limits?)`는 limits가 없으면 env Config에서 한도를 읽음
- `ExecutionSaturated` / `AdmissionWait`(`forever` | `upTo{duration}`) / `ExecutionAdmissionKind` / `ExecutionAdmissionLimits` / `defaultExecutionAdmissionLimits` / `GateLimits` / `ExecutionAdmissionSnapshot` — 실행 허용 게이트의 오류·대기 정책·한도 스키마와 기본값(workflow 32/64, model 8/16, tool 16/64)
- `ArchiveInstaller` — Context.Service. `install({archive, target})`이 내려받기, 체크섬 검증, staging, 안전 항목 검사, 압축 해제, publish 순서를 소유함. `ArchiveInstaller.layer`는 `ArchiveHost`가 필요함
- `ArchiveHost` — 주입 가능한 호스트 I/O 서비스(download/checksum/stage/write/list/extract/publish/cleanup)
- `ArchiveInstallFailed` / `ArchiveInstallFailedReason`(DownloadFailed, HttpStatus, ChecksumMismatch, UnsafeEntry, HostOperationFailed) / `PinnedArchive` / `ArchiveStaging` — 아카이브 설치 오류 TaggedUnion과 고정 아카이브 계약
- `archiveHostLayer` / `archiveInstallerLayer` — Node 호스트 구현 Layer(FetchHttpClient, NodeChildProcessSpawner, NodeCrypto, NodeFileSystem, NodePath 제공)
- `npmIntegrity` / `ArchiveIntegrityRejected` — npm `sha512-<base64>` integrity를 hex digest의 `PinnedArchive`로 바꿈. 다른 알고리즘이면 throw함
- `DefectReporter` — Context.Reference. `report(DefectEvent)`와 `recent`를 가지며 기본값은 no-op임. 앱이 Discord reporter(`report/defect-reports.ts`)를 제공함. 타입 `DefectEvent`, `RecentDefect`
- `tagOf` / `tagOfUnknown` / `reasonTagOf` — 실패의 `_tag`(와 `reason._tag`)를 읽는 유일한 지점
- `logFailure` / `fallbackLogged` / `ignoreLogged` / `logDefect` / `failureTags` — 예상 실패를 태그로만 로그하고 fallback하거나 무시하는 헬퍼, defect 기록, Cause를 태그 문자열로 요약하는 함수
- `homeDirectory` / `temporaryDirectory` / `totalMemory` / `availableCores` / `hostPlatform` — node:os 정보를 `Effect.sync`로 감싼 값
- `findExecutable` — PATH의 절대 경로 항목에서만 실행 파일을 찾음(Windows는 PATHEXT 포함). 결과는 Effect<string | null>
- `tarExecutable` — 시스템 tar 경로. POSIX는 `tar`, Windows는 `%SystemRoot%\System32\tar.exe`
- `helperEnvironment` — 앱이 띄우는 helper 프로그램용 최소 환경변수. 시스템 변수와 고정 검색 경로만 담고, `user`이면 Windows 사용자 폴더 변수를 더함
- `shellInvocation` / `ShellInvocation` — 사용자 셸로 명령 한 줄을 실행하는 형태. POSIX는 `$SHELL`|`/bin/sh -c`, Windows는 `cmd.exe /d /s /c "..."`(verbatim)
- `keyringEntry` / `openKeyringEntry` / `SecretBackend`(`keychain` | `file`) / `KeyringEntry` / `SecretFileStoreFailed` / `KeyringFailure` / `KeyringOpenFailure` — OS 키체인 또는 AES-GCM 암호화 파일 비밀 저장소 항목을 엶
- `aborted(signal)` / `abortControllerFor(signal)` — AbortSignal이 abort되면 완료되는 Effect, 그리고 signal을 따라가는 TanStack AI용 AbortController
- `RunCancellations` / `RunCancellation` / `linkController` — 실행 취소 할당 서비스(`allocate(shutdownReason)`). 그래프 시그니처만 확인함
- `LoopHealth` / `healthyLoop` / `loopStopped` / `loopRetrySchedule` / `maxLoopRetries` / `superviseLoopStep` / `LoopStep` / `LoopSupervision` / `sameLoopHealth` — 반복 루프 상태 TaggedUnion과 감독·재시도 정책. 그래프 시그니처만 확인함
- `requireRuntime` / `configureRuntimeRoot` / `runtimeRoot` / `runtimeWorker` / `runtimeWorkerOptions` / `RuntimePackages` / `WorkerRuntime` — 런타임 패키지(네이티브 addon 등) 루트 설정, require, worker 로딩. 그래프 시그니처만 확인함
- `nativePromise` / `nativeFailure` / `NativeRejection` / `runNativeEffect` — 네이티브 Promise를 Effect로 감싸고 Effect를 Promise로 실행하는 경계. 그래프 시그니처만 확인함
- `ShownFailure` / `RunFailureCode` / `runFailureCodeOf` / `runFailureText` / `externalAgentFailureText` / `ExternalAgentFailureCode` / `McpFailureCode` / `ConfigFileFailureCode` / `decodeRunFailureCode` — 사용자에게 보여 줄 실패 코드 리터럴과 문구. 그래프 시그니처만 확인함
- `runProcess` / `CommandOptions` / `runTrace` / `onRun` / `RunTrace` — 프로세스 실행 함수와 실행 trace 헬퍼. 그래프 시그니처만 확인함
- `nodePlatformLayer` / `nodePlatform` / `NodePlatform` / `initializeNodeSqlite(addonPath)` — Node 플랫폼 Layer와 node sqlite addon 초기화. 그래프 시그니처만 확인함
- `referenceIds<Key>()` / `sha256` (synchronous-crypto) / `posix`·`win32`·`path` (synchronous-path) — 참조 id 헬퍼, 동기 sha256, 동기 path 모듈. 그래프 시그니처만 확인함
- 하위 디렉터리 없음

## Invariants

- ExecutionAdmission의 `admittedPermits`는 `active + queued` 크기임. 먼저 `admit`로 admitted permit을 얻은 뒤 active permit을 기다림. 대기 중 인터럽트되면 `onInterrupt`가 admitted permit 1개를 되돌려 줌
- ExecutionAdmission의 release는 `released` Ref로 한 번만 실행됨(멱등). active 감소, gauge 갱신, activePermits 반환, admittedPermits 반환 순서임
- 포화는 작업 자체의 실패가 아님. `saturatedRetry`(50ms 지수, 최대 2초 간격, jitter)로 재시도함. 이미 실행 중인 작업은 `AdmissionWait.forever`를 쓰고, 새 요청은 `upTo`로 기한을 둬 caller가 busy를 듣게 함
- 포화 metric과 warning 로그는 caller의 대기마다 첫 거절에서만 남김(`reportOnce`)
- `ExecutionAdmissionLimits` 스키마 범위는 active 1..1024, queued 0..16384임. env Config 경로는 active 최소 1, queued 최소 0, 최대 16384로 검사함. 명시 limits의 디코드 실패는 `Config.ConfigError`로 바뀜
- ArchiveInstaller 순서는 download, checksum, digest 비교(불일치 시 ChecksumMismatch), stage, write, list, 위험 항목 검사, extract, publish임. staging은 `acquireUseRelease`로 항상 cleanup됨. 호스트 I/O는 주입하고, 순서와 수명은 설치 정책이 소유함
- 아카이브 목록에 `/`로 시작하거나 `..` 세그먼트를 가진 항목이 있으면 extract 전에 `UnsafeEntry`로 거부함
- tar 명령 scope는 stdout/stderr를 모두 drain하고 프로세스 종료를 기다린 뒤 staging을 놓음. 출력 상한은 list 64MiB, extract 1MiB임. 0이 아닌 종료 코드는 HostOperationFailed임
- Node 파일시스템 호출(remove, writeFile, rename)은 abort할 수 없어 `Effect.uninterruptible`로 끝까지 실행함. remove는 EBUSY/ENOTEMPTY/EPERM/EMFILE/ENFILE에서 최대 10회 재시도함. rename은 win32에서 EPERM/EACCES/EBUSY일 때만 500ms 간격으로 19회 재시도함
- `npmIntegrity`는 `sha512`만 허용함. 다른 알고리즘이면 `ArchiveIntegrityRejected`를 동기 throw함
- Windows의 tar는 PATH가 아니라 System32의 bsdtar를 경로로 지정해야 함. PATH 앞쪽의 GNU tar는 `C:\…`를 원격 `host:path`로 해석함
- `findExecutable`은 PATH의 절대 경로 항목만 봄. 상대 경로(프로젝트 폴더)가 실행 파일을 가로채지 못하게 하기 위함임
- `helperEnvironment`는 시스템 시작에 필요한 변수와 고정 검색 경로만 넘김. 사용자의 다른 환경변수는 절대 넘기지 않음(R14)
- 로그, 보고, 저장된 요약은 오류를 태그로만 부름. cause와 message에는 경로, SQL, 명령 출력, provider 텍스트가 들어갈 수 있음. 태그 읽기는 `failure-tag.ts`에서만 함
- `logFailure`/`fallbackLogged`/`ignoreLogged`는 예상 실패만 처리함. defect와 인터럽트는 그대로 통과시킴. 프로세스를 끝내지 않고 기록하는 defect는 모두 `logDefect`를 거쳐 `DefectReporter.report`로 감
- `RecentDefect`는 fingerprint(tag, location, count, lastAt)만 담음. message나 stack은 담지 않음
- 비밀 파일 백엔드는 `CONTEXT_AGENT_SECRET_DIRECTORY`가 있을 때만 선택됨. 실패해도 OS 키체인으로 fallback하지 않음. 키는 디렉터리 밖(`CONTEXT_AGENT_SECRET_KEY` 또는 `_KEY_FILE`)에서 가져오며 base64 32바이트여야 함. 키는 사용할 때마다 읽으므로 교체가 즉시 반영됨
- 비밀 파일 이름은 `sha256(service\naccount).secret`이고 형식은 `v1:<iv>:<ciphertext>`(AES-GCM, 12바이트 IV)임. `service\naccount`를 additionalData로 묶어, 다른 항목에 복사된 파일은 복호화되지 않음
- 비밀 파일 쓰기는 디렉터리 0o700, 임시 파일 `<file>.tmp-<pid>` 0o600에 쓴 뒤 rename함. 실패하면 임시 파일을 지움
- OS 키체인 항목을 열 때 `requireRuntime("@napi-rs/keyring")`로 네이티브 addon을 로드함. 로드에 실패하면 open이 실패함. Windows 키체인이 돌려주는 null은 `?? null`로 정규화함
- node:os 같은 네이티브 호스트 API는 runtime 경계 파일 안에만 두고, 호출자는 Effect로 읽음(`host-system.ts` 주석)
- Service/Reference 키는 `memory-agent/runtime/<file>/<Name>` 형식의 문자열임

## Side Effects

- 환경변수 읽기: `CONTEXT_AGENT_WORKFLOW_CONCURRENCY`, `CONTEXT_AGENT_WORKFLOW_QUEUE_CAPACITY`, `CONTEXT_AGENT_MODEL_CONCURRENCY`, `CONTEXT_AGENT_MODEL_QUEUE_CAPACITY`, `CONTEXT_AGENT_TOOL_CONCURRENCY`, `CONTEXT_AGENT_TOOL_QUEUE_CAPACITY`, `CONTEXT_AGENT_SECRET_DIRECTORY`, `CONTEXT_AGENT_SECRET_KEY`, `CONTEXT_AGENT_SECRET_KEY_FILE`
- `process.env`의 PATH/Path, PATHEXT, SystemRoot, ComSpec, SHELL과 Windows 사용자 변수 읽기, `process.platform` 읽기
- Metric: gauge `context_agent_execution_active`·`context_agent_execution_queued`, counter `context_agent_execution_saturated_total`(attribute `kind`), span `execution.admission`, warning 로그 `execution admission saturated`
- 네트워크: `ArchiveHost.download`가 FetchHttpClient로 아카이브 URL을 HTTP GET함
- child process: `tar -tzf <file>`와 `tar -xzf <file> -C <dir>`를 실행함(stdin ignore). `runProcess`도 프로세스를 실행함(시그니처만 확인)
- 파일시스템(아카이브): 대상의 부모 디렉터리를 0o700으로 만들고, 임시 디렉터리 `.install-*`를 만든 뒤 `archive.tgz`를 0o600으로 씀. 대상을 재귀 삭제한 뒤 staging 디렉터리를 대상으로 rename하고, staging을 정리함
- 파일시스템(키링): 비밀 파일 `<hash>.secret` 읽기·쓰기·삭제, 키 파일 읽기, 임시 파일 rename
- 파일시스템(호스트): `findExecutable`과 `shellInvocation`이 후보 경로를 `fs.stat`으로 확인함
- OS 키체인: `@napi-rs/keyring` `AsyncEntry`의 getPassword/setPassword/deletePassword/deleteCredential
- 암호화: Web Crypto AES-GCM importKey/encrypt/decrypt, `crypto.getRandomValues`로 IV 생성, Effect `Crypto.digest`로 SHA-256/SHA-512 계산
- node:os 읽기: homedir, tmpdir, totalmem, availableParallelism, platform, arch
- AbortSignal에 `abort` 리스너를 등록함(`aborted`는 해제 시 제거, `abortControllerFor`는 once). 새 AbortController를 만듦
- 재시도 타이머: 포화 재시도(50ms 지수, 최대 2초, jitter), 삭제 재시도(200ms×(n+1), 최대 10회), win32 rename 재시도(500ms, 19회)
- 로그와 defect 보고: Effect.logWarning/logDebug/logError, 그리고 `DefectReporter.report`(앱이 제공하면 Discord로 전송)
- 그래프 시그니처만 확인한 전역 상태와 네이티브 로딩: `configureRuntimeRoot`(런타임 루트 설정), `initializeNodeSqlite(addonPath)`(node sqlite addon 초기화), `runtimeWorker`(worker 생성 옵션)

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
