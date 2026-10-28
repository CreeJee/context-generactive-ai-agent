# src

## Overview

`packages/memory-agent/src` 최상위는 memory-agent 패키지의 공개 진입점이다. `index.ts`는 하위 디렉터리의 서비스·스키마·오류·타입을 다시 내보내는 barrel이다. `layers.ts`의 `memoryAgentLayer`는 composition root로, 저장 디렉터리 하나 위에 모든 memory-agent 서비스(DB, 설정, 프로바이더, 칸반, 메모리, 도구, 채팅 등)를 계층별로 조립한다. `json.ts`, `optional-property.ts`, `truthy.ts`는 패키지 전체가 쓰는 작은 순수 헬퍼다.

## Interface

- `memoryAgentLayer` — `EffectFunction.dual`이며 `(storageRoot)`, `(storageRoot, options)`, `(options)(storageRoot)` 형태를 받는다. 첫 인자가 문자열(`Schema.is(Schema.String)`)이면 data-first로 판별한다. 저장 디렉터리 하나 위에 모든 memory-agent 서비스를 조립하는 composition root다
- `MemoryAgentLayerOptions` — `memoryAgentLayer`의 선택 옵션이다. 레이어 교체용 옵션은 `compatibleSettings`, `embedder`, `morphAnalyzer`, `providerRegistry`, `providerToolRegistry`, `modelFeatureFlags`, `crossProviderMediaConsent`, `providerToolPolicy`, `providerToolRuntime`, `routeCatalog`, `imageRouteFacts`, `imageRouter`, `imageFeature`, `directImageExecutor`, `imageMediaWorkflow`, `secrets`다. 값 옵션은 `executionAdmission`, `openDatabase`, `leaseTtlMs`, `interpretAutomatically`, `summarizeAutomatically`, `kagiBaseUrl`, `skillsHome`, `skillsBuiltin`, `importsHome`, `importsWatching`, `sweepSecrets`, `kanbanWorktreesBase`다
- `JsonValue` — 손실 없이 JSON으로 표현되는 값 타입이자 `Schema.Codec<JsonValue>`이다(`json.ts`). `Schema.suspend` 재귀 Union으로 String, Finite, Boolean, Null, Array, Record를 받는다. `index.ts`는 이를 `JsonValue`와 타입 별칭 `Json`으로 다시 내보낸다
- `optionalProperty` — `EffectFunction.dual(2)`이며 `(key, value)`와 `(value)(key)`를 지원한다. value가 `undefined`가 아니면 `{ [key]: value }`를, `undefined`면 `{}`를 돌려준다(`optional-property.ts`)
- `isTruthy` — JavaScript truthiness를 그대로 쓰면서 `Exclude<NonNullable<T>, false | 0 | 0n | "">`로 좁히는 타입 가드다(`truthy.ts`)
- `AgentChat` / `QueueRequest` / `attachmentInstructions` / `memoryInstructions` / `workspaceInstructions` — `agent/chat.ts`에서 다시 내보낸다
- `ChatApiHandlers` / `BtwApiHandlers` — `api/chat-api-live.ts`의 HTTP API 핸들러를 다시 내보낸다
- `createLiveRuns` / `LiveRun` / `LiveRuns`, `contextUsageEvent` / `serverRestartedCode` / `CancelResult` / `CompactResult` / `ContextView` / `SessionRunState` — `agent/live-runs.ts`와 `agent/run-state.ts`에서 다시 내보낸다
- `ChatState`, `StoredMessage`(type), `UncertainContinueRequest` — chat-state, chat-store 스키마, `workflow/uncertain-runs.ts`에서 다시 내보낸다
- `ProjectImprovement`, `ImprovementItem` / `ImprovementReport` / `ImprovementScan`(type) — improve 디렉터리에서 다시 내보낸다
- `OpenAICompatibleSettings` / `OpenAICompatibleFailed` / `makeOpenAICompatibleSettings` 등과 `OpenAICompatibleConfiguration` / `OpenAICompatibleStatus` / `CompatibleAccountsView` / `CompatibleAccountStatus` / `CompatibleConnectionInput` / `CompatibleModelInput` — OpenAI 호환 provider 설정과 그 스키마다
- `OAuthProfiles` / `OAuthProfileRejected` / `OAuthProfileStoreFailed` / `createProfileCredentialStore`, `OAuthAccountLogins` / `createOAuthAccountLoginManager` / `AccountLoginState`, `OAuthHarnessError` / `OAuthKeychain`, `SubscriptionQuota` / `SubscriptionUsage` / `SubscriptionQuotaReport` 등 — oauth 디렉터리에서 다시 내보낸다
- `ReportDiagnoser` / `ReportDiagnosisError`, `ReportDelivery` / `ReportDeliveryError` / `maxEvidenceBytes` / `maxReportBytes`, `bundleLimits` / `collectReportBundle` / `ReportBundle`, delivery·diagnosis 계약 스키마 — report 디렉터리에서 다시 내보낸다
- `logDefect` / `logFailure` — `runtime/logged-failures.ts`에서 다시 내보낸다
- `StorageRoot` / `defaultStorageRoot`, `GlobalConfig` / `GlobalConfigFailed` / `Settings` / `SummaryStartPercent` / `EmbeddingChoice` / `GpuCheck` / `ModelFeatureFlagSettings` / `CrossProviderMediaConsent*Settings`, `SecretStore` / `SecretStoreFailed` / `keychainService` — config 디렉터리에서 다시 내보낸다
- `Kagi` / `KagiFailed` / `KagiKeyMissing` / `kagiBaseUrl` / `maxExtractUrls`, `attachmentIdOf` / `attachmentUrl` — kagi와 attachments URL 규약에서 다시 내보낸다
- `ProviderId` / `ModelSelection` / `ProviderModel` / `providerConnection` / `ProviderUnavailable` / `AuthConnectionState` 등 provider 계약, `ActiveProvider`, `ProviderRegistry` / `providerRegistryFrom` — providers 디렉터리에서 다시 내보낸다
- `CrossProviderMediaConsent` / `decideCrossProviderMediaConsent` / `makeCrossProviderMediaConsent`, `ModelFeatureFlags` / `decideModelFeatureFlag` / `makeModelFeatureFlags` — 교차 provider 미디어 동의와 모델 기능 플래그를 다시 내보낸다
- `ProviderToolCapabilityRegistry` / `providerToolDescriptors` / `filterProviderTools`, `ProviderToolPolicy` / `ProviderToolRuntime` / `makeProviderToolPolicy` / `makeProviderToolRuntime` / `classifyProviderToolRisk` / `decideProviderToolExposure`와 다수의 ProviderTool* 오류·타입 — provider 네이티브 도구의 기능, 정책, 런타임을 다시 내보낸다
- `imageRouteContracts` / `productionImageRouteContracts` / `RouteCatalog` / `makeRouteCatalog` / `ImageRouter` / `makeImageRouter` / `rankImageRoutes` / `ImageRouteFacts` 등 — 이미지 라우트 계약, 카탈로그, 라우터를 다시 내보낸다. `index.ts` 301줄 이후의 export는 scout가 줄 상한 때문에 읽지 않았다
- 하위 디렉터리:
  - [`acp`](./acp/README.md) — 에디터용 ACP 에이전트 브리지
  - [`agent`](./agent/README.md) — 대화 에이전트 핵심 계층(`AgentChat`)
  - [`api`](./api/README.md) — 채팅 HTTP API 계약 `ChatApi`와 구현
  - [`approvals`](./approvals/README.md) — 하위·외부 에이전트 승인 중계(`RelayedApprovals`)
  - [`attachments`](./attachments/README.md) — 이미지 첨부 저장과 모델용 변환
  - [`btw`](./btw/README.md) — BTW 곁질문 스레드
  - [`chat-state`](./chat-state/README.md) — 채팅 상태 준비와 히스토리 투영
  - [`chat-store`](./chat-store/README.md) — 저장 채팅 행 스키마
  - [`code`](./code/README.md) — QuickJS 코드 샌드박스
  - [`concurrency`](./concurrency/README.md) — 키 단위 직렬화 유틸리티
  - [`config`](./config/README.md) — 전역 설정, 저장 루트, 비밀 저장소
  - [`db`](./db/README.md) — 단일 SQLite 연결과 마이그레이션
  - [`events`](./events/README.md) — 앱 변경 이벤트 버스(SSE)
  - [`external-agents`](./external-agents/README.md) — 외부 ACP 에이전트 클라이언트
  - [`files`](./files/README.md) — 호스트 파일 접근 계층
  - [`imports`](./imports/README.md) — 다른 에이전트 transcript 가져오기
  - [`improve`](./improve/README.md) — 프로젝트 개선 항목 스캔
  - [`kagi`](./kagi/README.md) — Kagi Search/Extract API 서비스
  - [`kanban`](./kanban/README.md) — Goal 칸반 실행 백엔드
  - [`loop`](./loop/README.md) — Effect AI 에이전트 루프(`runChat`)
  - [`mcp`](./mcp/README.md) — MCP 서버 설정·신뢰·연결
  - [`memory`](./memory/README.md) — 장기 기억 그래프 계층
  - [`messages`](./messages/README.md) — 채팅 메시지 판별 헬퍼
  - [`model`](./model/README.md) — `LanguageModel` 어댑터와 히스토리 변환
  - [`oauth`](./oauth/README.md) — 구독 계정 OAuth 연결
  - [`permissions`](./permissions/README.md) — 도구 호출 권한 계층
  - [`projects`](./projects/README.md) — 프로젝트 루트 관리(`Projects`)
  - [`providers`](./providers/README.md) — 모델 공급자 계층
  - [`queue`](./queue/README.md) — 후속 메시지 큐
  - [`report`](./report/README.md) — 버그 리포트 백엔드
  - [`runtime`](./runtime/README.md) — 호스트·네이티브 경계와 공통 런타임
  - [`secrets`](./secrets/README.md) — 비밀 가리기와 sweep
  - [`sessions`](./sessions/README.md) — 세션 레코드와 lease
  - [`shell`](./shell/README.md) — 호스트 셸 명령 실행
  - [`skills`](./skills/README.md) — 에이전트 스킬 카탈로그
  - [`subagents`](./subagents/README.md) — 하위 에이전트 위임
  - [`tools`](./tools/README.md) — 모델 내장 도구
  - [`work-trace`](./work-trace/README.md) — 하위 에이전트 Work Trace 기록
  - [`workflow`](./workflow/README.md) — 세션 Goal/Plan 워크플로
  - `testing/` — 테스트 전용 헬퍼(문서화 제외)

## Invariants

- `layers.ts` 주석은 "Each tier only depends on the tiers below it."라고 적는다. 레이어 조립은 아래 계층만 의존하는 계층 순서를 지켜야 한다
- foundation 계층의 조립 순서는 다음과 같다. `OAuthProfiles.layer`에 `OAuthKeychain.keychain`, `defectReports`, `GlobalConfig.layer`를 차례로 `provideMerge`한다. `GlobalConfig.layer`에는 `StorageRoot.layer(storageRoot)`, `Database.layer(join(storageRoot, "agent.db"), options.openDatabase)`, `ExecutionAdmission.layer(options.executionAdmission)`를 merge하고 `nodePlatformLayer`를 provideMerge한다. DB 파일 위치는 항상 `<storageRoot>/agent.db`다
- 위 계층 어디의 defect든, 설정되어 있으면 report 페이지가 쓰는 webhook으로 보고된다. `defectReportsLayer`에는 `ReportDelivery.layer()`와 `SecretRedactor.layer`를 제공한다
- 주석 "One store per owner: the cleanup schedule shares it with the card queue."에 따라 `persistedQueueStoreLayer()`는 한 번만 만든다. `persistedQueueCleanupLayer()`와 kanban 묶음은 같은 store 인스턴스를 공유해야 한다
- 기본 `providerRegistry`는 `AccountSubscriptionProviderRegistry` 목록 끝에 OpenAI 호환 provider를 덧붙인다. compatible provider id의 `get`은 `settings.services`를 돌려준다. `runtime` 실패는 `ProviderUnavailable.make({ provider })`로 매핑한다
- `ModelFeatureFlags.layer`는 `providerToolDescriptors`의 id 목록으로 만든다. 기본 `ProviderToolPolicy.featureFlagLayer`와 `ProviderToolRuntime.layer`는 같은 `providerToolRegistry`와 `modelFeatureFlags`를 공유한다
- 보안 기본값: `providerToolRegistry`는 도구를 실행하거나 정책을 강제하지 않는다. `providerToolRuntime`은 명시적 입력 없이 도구를 노출하지 않는다. `directImageExecutor`는 production에서 명시적으로 구성하기 전까지 unavailable이다
- 옵션 기본값: `interpretAutomatically`, `summarizeAutomatically`, `sweepSecrets`는 true다. `secrets`는 OS 키체인을 쓴다. 임포트는 실제 home을 계속 따라간다. `embedder`는 로컬 임베딩 모델을 쓴다. `morphAnalyzer`는 Kiwi를 쓰며 첫 사용 때 모델을 내려받는다
- `Boards.layer`에는 `GoalOrder.layer`를 provide한다
- `JsonValue` 스키마의 숫자는 `Schema.Finite`만 허용한다. 따라서 NaN과 Infinity는 거부된다
- `optionalProperty`는 값이 `undefined`이면 키를 넣지 않는다. exact optional property 타입을 보존하려고 이렇게 한다

## Side Effects

- `memoryAgentLayer`를 빌드하면 `Database.layer`가 SQLite 파일 `<storageRoot>/agent.db`를 열고 마이그레이션한다
- `OAuthKeychain.keychain`과 기본 `SecretStore`는 OS 키체인에 접근한다
- `defectReportsLayer`는 `ReportDelivery`로 defect를 Discord webhook에 보고한다. webhook이 설정되어 있을 때만 보고한다
- `gitCardWorktreesLayer(options.kanbanWorktreesBase)`는 칸반 카드용 git worktree 폴더를 사용한다
- 백그라운드 작업이 있다: run 이후의 해석과 요약, 시작 시 비밀 sweep, 다른 에이전트 transcript(`.claude`, `.codex`) 추적
- Kagi API 서버(`kagiBaseUrl`)로 네트워크 요청을 보낸다. 형태소 분석기 Kiwi는 첫 사용 때 모델을 내려받는다
- `json.ts`, `optional-property.ts`, `truthy.ts`는 순수 코드이며 부수 효과가 없다

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
