# config

## Overview

memory-agent의 사용자 전역 설정 계층이다. `<storage>/config.json`(`GlobalConfig`)을 Schema로 읽고 원자적으로 쓰며, 저장 루트 디렉터리(`StorageRoot`, 기본 `~/.context-generactive-agent`)를 정한다. 비밀값은 설정 파일이 아니라 OS 키체인(`SecretStore`)에 둔다. 칸반 동시 실행 수(`KanbanSettings`)는 전역 설정 위에서 기본값 계산과 변경 알림(PubSub)을 맡는다. 모든 기능은 Effect `Context.Service`와 Layer로 노출된다.

## Interface

- `GlobalConfig` — `<storage>/config.json`을 읽고(`read`) 부분 병합해 원자적으로 쓰는(`update`) Effect 서비스. `GlobalConfig.layer`는 NodeFileSystem·NodePath를 내장하고 `StorageRoot`를 요구한다
- `GlobalConfigApi` — `GlobalConfig` 서비스의 구현 타입(`read`, `update(patch: Partial<Settings>)`)
- `Settings` — 사용자 전역 설정 `Schema.Struct`(openaiCompatible, compatibleAccounts, provider, model, reasoningEffort, kagiEnabled, importsEnabled, embeddingDevice, gpuCheck, summaryStartPercent, kanbanConcurrency, crossProjectRecall, defectReports 등 전부 optional)
- `GlobalConfigFailed` / `GlobalConfigFailedReason` — operation(`read`|`write`)과 reason(`MissingFile`|`ReadFailed`|`WriteFailed`|`InvalidSettings`)을 갖는 설정 입출력 오류
- `EmbeddingChoice` — 임베딩 실행 장치 `auto`|`cpu`|`gpu` 리터럴 스키마
- `GpuCheck` — WebGPU 확인 결과 TaggedUnion(`available`{checkedAt} | `unavailable`{checkedAt, reason})
- `ModelFeatureFlagSettings` — version 1의 모델 의존 기능 플래그 정책(global/providers/capabilities/models/routes). 항목이 없으면 거부
- `CrossProviderMediaConsentMode` / `CrossProviderMediaConsentSettings` — provider 쌍별 미디어 전송 동의(`disabled`|`ask`|`always`), version 1
- `SummaryStartPercent` — 요약 시작 비율 정수 0~50 스키마
- `KanbanConcurrency` / `kanbanConcurrencyLimit` — 칸반 동시 실행 수 정수 1~32 스키마와 상한 상수 32
- `KanbanSettings` — 칸반 동시 실행 설정 서비스(`concurrency`, `changes` 구독, `setConcurrency(value)`, `resetConcurrency`). `KanbanSettings.layer(cores?)`는 `GlobalConfig`를 요구한다
- `KanbanSettingsRefused` — 범위 밖 값(`concurrency_out_of_range`) 거부 오류
- `KanbanConcurrencySetting` — `configured: Option<number>`와 실제 적용값 `effective`
- `defaultKanbanConcurrency(cores)` — 코어 절반, 최소 1·최대 4
- `SecretStore` — 비밀값 get/set/remove 서비스. `SecretStore.keychain`(OS 키체인, FileSystem·Path·Crypto 요구)과 `SecretStore.memory`(테스트용 메모리) 레이어
- `SecretStoreApi` / `SecretStoreFailed` / `SecretName` — 비밀 저장소 API 타입, operation(`read`|`write`|`delete`) 실패 오류, 비밀 이름(`kagi-api-key`, MCP 서버 로그인 `mcp-oauth:<scope>:<프로젝트 id>:<서버 이름>`)
- `keychainService` — 키체인 서비스 이름 상수 `context-generactive-agent`
- `StorageRoot` — DB·벡터 인덱스·모델·설정을 담는 디렉터리 경로 서비스. `StorageRoot.layer(path)`와 `StorageRoot.home` 레이어
- `defaultStorageRoot` — 홈 디렉터리 아래 `.context-generactive-agent` 경로를 계산하는 Effect
- 하위 디렉터리 없음

## Invariants

- 비밀값은 `Settings`/`config.json`에 넣지 않고 OS 키체인에 둔다. `SecretStore` 실패 시 다른 곳에 비밀을 저장하는 것으로 대체하지 않는다(R14). 비밀은 요청 직전에만 읽고 설정 파일·대화·도구 출력·로그에 남기지 않는다
- `GlobalConfig`의 `read`와 `update`는 같은 `Semaphore`(permit 1)로 직렬화된다. `update`는 read→병합→write를 한 permit 안에서 수행한다
- `config.json` 쓰기는 `${file}.${process.pid}.tmp`에 쓴 뒤 rename하는 원자적 방식이며 uninterruptible이고, 실패 시 임시 파일을 지운다. 디렉터리는 mode `0o700`, 파일은 `0o600`으로 만든다
- `config.json`이 없으면 `read`는 빈 설정 `{}`를 돌려준다(`MissingFile`만 성공으로 바꾼다)
- 하위호환: 0.0.17까지의 `gpuCheck`(`status` 필드 형식)와 provider 없이 model+reasoningEffort만 있는 설정(provider를 `openai`로 간주)은 첫 read 때 현재 형식으로 한 번 다시 쓴다
- `ModelFeatureFlagSettings`에 항목이 없으면 접근을 거부한다. `CrossProviderMediaConsentSettings` 항목은 로그인·권한으로 자동 생성하지 않는다
- `SummaryStartPercent`는 0~50으로, 오래된 메시지를 빼는 비율(55%)보다 낮게 유지한다
- `kanbanConcurrency`가 없으면 `defaultKanbanConcurrency(cores)`(코어 절반, 1~4)를 쓴다. `setConcurrency`는 `KanbanConcurrency`(1~32) 디코드로 범위를 검사한 뒤 저장하고, 저장 후 다시 읽은 값을 PubSub로 알린다
- `embeddingDevice` 변경은 앱이 다음에 시작할 때 적용된다
- `StorageRoot`는 프로젝트 내부에 두지 않는다

## Side Effects

- 파일 시스템: `<storage>/config.json` 읽기, 임시 파일 쓰기 후 rename, 임시 파일 삭제, storage 디렉터리 recursive 생성(`0o700`)
- 임시 파일 이름에 `process.pid`를 사용한다
- OS 키체인 접근: `openKeyringEntry(keychainService, name)`로 네이티브 keyring 애드온을 첫 사용 시 로드하고 password get/set/delete. Windows에서는 자격 증명 하나가 2,560바이트까지라 `createChunkedPasswordEntry`로 나눠 저장한다(MCP 로그인처럼 긴 값)
- 홈 디렉터리 조회(`homeDirectory`)와 CPU 코어 수 조회(`availableCores`, `packages/memory-agent/src/runtime/host-system`)
- 인메모리 상태: `KanbanSettings`의 unbounded PubSub 발행, `Semaphore` permit, `SecretStore.memory`의 `Ref<HashMap>`

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
