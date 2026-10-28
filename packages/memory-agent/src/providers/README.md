# providers

## Overview

`packages/memory-agent/src/providers`는 모델 공급자 계층이다. 저장된 공급자 ID(`openai`, `anthropic`, `openai-compatible`)를 연결 방식(구독 OAuth 또는 호환 엔드포인트)으로 해석하고, 인증·모델 카탈로그·런 단위 Effect AI `LanguageModel` 런타임 계약을 정의한다. `ProviderRegistry`와 `ActiveProvider`로 저장된 공급자/모델 선택을 해석한다. 이미지 생성(route catalog → image router 점수화 → 교차 공급자 동의 → OpenAI Images API 직접 실행 → 첨부 저장), 공급자 네이티브 도구 정책·기능 레지스트리, 모델별 기능 플래그도 이 디렉터리에 Effect `Context.Service`로 있다.

## Interface

- `ProviderId` / `ProviderVendor` / `SubscriptionAccountProvider` — 저장되는 공급자 ID 리터럴 스키마(`openai`, `anthropic`, `openai-compatible`)와 벤더·구독 계정 공급자 스키마
- `providerConnection` / `ProviderConnection` / `NativeToolSupport` — 공급자 ID를 `subscription` 또는 `compatible-endpoint` 연결과 네이티브 도구 지원 여부로 한 번에 해석하는 TaggedUnion
- `ModelSelection` / `SubscriptionModelSelection` / `ProviderModel` / `ModelCapabilities` / `CacheRetention` — 공급자+모델+reasoningEffort 선택, 카탈로그 모델, 입력 모달리티·도구 호출·추론 능력 스키마
- `ProviderUnavailable` / `ModelUnavailable` / `ProviderOperationFailed` — 공급자 계층 TaggedError(operation: auth|catalog|model)
- `AuthConnectionState` / `AuthStatus` / `AuthProvider` — signed-out|pending|signed-in|error 로그인 상태 TaggedEnum과 status/connect/cancel/disconnect 인증 수명주기 인터페이스
- `ModelCatalog` / `AgentModelRuntime` / `RunModel` / `ModelRun` / `ShownFailure` / `ProviderConfiguration` / `ProviderServices` — 모델 목록·선택, 런 단위 Effect AI 모델 생성(Scope 필요), 컨텍스트 창, 사용자 표시용 실패 계약
- `ActiveProvider` — GlobalConfig와 ProviderRegistry로 저장된 공급자/모델을 resolve하고 models/runtime/auth/authFor를 제공하는 Context.Service(`ActiveProvider.layer`)
- `ProviderRegistry` / `ProviderRegistryApi` / `providerRegistryFrom` — 공급자별 configuration·runtime 조회 레지스트리 서비스(registry.ts; 시그니처만 확인)
- `SubscriptionProviderRegistry` / `AccountSubscriptionProviderRegistry` — 구독 공급자 레지스트리 구성(subscriptions.ts; 이름만 확인)
- `createSubscriptionProvider` / `parseSubscriptionCatalog` / `ProductOAuthClient` — 구독 OAuth 공급자 configuration 생성과 구독 카탈로그 페이지 파싱(subscription-provider.ts; 시그니처만 확인)
- `createSubscriptionRuntime` / `createSubscriptionRuntimeImplementation` — 구독 계정 공급자용 `AgentModelRuntime` 생성(subscription-runtime.ts; 시그니처만 확인)
- `OpenAICompatibleSettings` / `makeOpenAICompatibleSettings` / `OpenAICompatibleFailed` — OpenAI 호환 엔드포인트 계정·키·모델 설정 서비스(openai-compatible.ts; 시그니처만 확인)
- `CompatibleAccount` / `CompatibleAccounts` / `OpenAICompatibleConfiguration` / `CompatibleReasoning` / `compatibleAccountsOf` / `compatibleEndpointModel` / `compatibleToolCalling` / `OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW` — 호환 엔드포인트 설정 스키마와 헬퍼(openai-compatible-config.ts; 이름·시그니처만 확인)
- `readCompatibleReasoning` / `CompatibleModelPage` — 호환 서버 `/models` 페이지에서 모델의 reasoning 레벨을 읽는 dual 함수
- `CrossProviderMediaConsent` / `makeCrossProviderMediaConsent` / `decideCrossProviderMediaConsent` / `crossProviderMediaConsentKey` / `CrossProviderMediaConsentStoreFailed` — 교차 공급자 미디어 실행 동의(always|ask|disabled) 판정·저장 서비스
- `ImageFeature` / `makeImageFeature` / `decideImageContext` / `imageProviderWorkflowPrompt` — 이미지 생성 사용자 설정과 턴 단위 이미지 컨텍스트 게이트
- `openAIImageRouteContracts` / `anthropicImageProviderContract` / `productionImageRouteContracts` / `ImageRouteContract` / `ImageExecutorModel` — 이미지 라우트 계약 정의와 운영용 필터
- `ImageRouter` / `makeImageRouter` / `rankImageRoutes` / `ImageRouteDecision` / `ImageRerouteConfirmation` / `ImageRouteScore` — 미디어 라우트 점수화·선택 서비스와 결정/재라우팅 확인 TaggedEnum
- `ImageRouteFacts` — 라우트별 계정 사실 서비스(`layerFrom`, `unavailableLayer`, `authenticatedRoutesLayer`)
- `DirectImageExecutor` — OpenAI Images API 직접 실행 서비스(`openAIEnvironmentLayer`, `unavailableLayer`, `layerFrom`)와 `DirectImageExecutionFailed`
- `ImageMediaWorkflow` / `makeImageMediaWorkflow` / `ImageMediaApprovalRequired` / `ImageMediaUnavailable` / `ImageMediaExecutionFailed` / `CrossProviderMediaRunApproval` — 승인→라우팅→실행→첨부 저장 이미지 워크플로
- `RouteCatalog` / `makeRouteCatalog` / `ChatRoute` / `MediaRoute` / `RouteCatalogRefreshFailed` / `UnknownCatalogRoute` / `IncompatibleCatalogRoutes` — 채팅·미디어 실행 라우트 카탈로그 서비스(route-catalog.ts; 시그니처만 확인)
- `ProviderToolPolicy` / `ProviderToolRuntime` / `makeProviderToolPolicy` / `decideProviderToolExposure` / `classifyProviderToolRisk` / `hasRequiredProviderToolAuthority` / `normalizeProviderToolUsage` / `normalizeProviderToolCost` 및 `ProviderTool*` TaggedError 다수 — 공급자 네이티브 도구 노출·승인·샌드박스 정책과 실행 런타임(tool-policy.ts; 시그니처만 확인)
- `ProviderToolCapabilityRegistry` / `makeProviderToolCapabilityRegistry` / `providerToolDescriptors` / `filterProviderTools` / `ProviderToolId` / `providerTools` — 도구 기술자·모델 메타데이터 레지스트리와 도구 ID 스키마(tool-capabilities.ts, provider-tool-id.ts, provider-tools.ts; 이름만 확인)
- `ModelFeatureFlags` / `decideModelFeatureFlag` / `OPENAI_CHAT_MODELS` / `ANTHROPIC_MODELS` / `OPENAI_IMAGE_MODELS` / `openAIModelToolCapabilities` / `anthropicModelToolCapabilities` / `failedReasons` — 모델별 기능 플래그 서비스, 정적 모델 카탈로그·도구 능력 표, 실패 이유 수집 헬퍼
- 하위 디렉터리 없음

## Invariants

- `ProviderId`는 저장되는 연결 ID다. `openai-compatible`은 OpenAI 벤더 ID가 아니다. 소비자는 `providerConnection`으로 한 번 해석한 뒤 연결 종류와 `nativeTools`로 분기해야 한다(contracts.ts 주석).
- 모델은 언제나 공급자와 함께 식별한다(`ModelSelection`에 provider 필수).
- `AuthProvider`에는 의도적으로 토큰·자격증명 getter가 없다. 추가하지 말 것.
- `ShownFailure`는 앱의 문구만 담고 공급자 원문 텍스트를 절대 담지 않는다.
- `RunModel.historyKey`는 자격증명을 보관하지 않고 연결 ID만 고정한다. `RunModel.source`는 모델이 쓰는 모든 메시지에 기록되고 replay가 비교한다.
- `AgentModelRuntime.model`은 `Scope.Scope`를 요구한다. 런에 고정된 계정 등은 scope가 닫힐 때 해제된다. 루프는 런마다 모델 하나를 만들고 프롬프트 캐시는 thread로 키잉한다.
- `ActiveProvider`는 다른 공급자로 조용히 대체하지 않는다. 설정에 provider가 없으면 `provider`는 `openai`, `selected`는 null이다. `authFor`는 `ProviderUnavailable`/`ProviderOperationFailed`를 `AuthConnectionState.error`로 바꿔 보고한다.
- 운영 이미지 라우트는 `productionEnabled && verification === "verified"`인 계약만이다. `openai:provider_tool:image_generation`은 unverified·비활성이고, Anthropic 이미지 생성은 unsupported다.
- `decideImageContext`: 사용자 설정 활성, 명시적 `generate_image` 의도, 선택된 라우트가 모두 있어야 허용한다. Provider Tool 주입과 워크플로 프롬프트 주입은 `provider_tool` 모드에서만, 직접 워크플로는 `direct_adapter`에서만 허용한다.
- `imageProviderWorkflowPrompt`는 실패 뒤 사용자 확인 없이 다른 유료 라우트로 재시도·전환하지 말라고 지시한다. 실행 실패는 `ImageMediaExecutionFailed.reroute`에 `confirmation_required` 재라우팅 확인을 싣는다.
- 교차 공급자 동의 키 형식은 `${initiatorProvider}->${executorProvider}:${capability}`이다. 같은 공급자면 항상 허용한다. 저장된 쌍이 없으면 기본값은 `disabled`이다. 설정 version은 1이다.
- `ImageMediaWorkflow.generate`는 `approved`가 false면 먼저 `ImageMediaApprovalRequired(paid_execution)`로 실패한다. 그 다음 trim한 prompt가 비면 `prompt_empty`로 실패하고, catalog가 있으면 refresh를 먼저 한다.
- `DirectImageExecutor.openAIEnvironmentLayer`는 환경의 `OPENAI_API_KEY`가 필요하다(없으면 `not_configured`). executorMediaModel이 `explicit`이어야 하고, 2xx가 아니면 `provider_rejected`(status 포함)다. 호출자 AbortSignal은 fetch init signal과 `AbortSignal.any`로 합친다.
- 이미지 라우팅 입력 검증: `sourceImageCount`는 0 이상 정수, 비용 상한은 유한한 0 이상이다. 라우트 fact의 quality·speed는 0..1 유한값이어야 한다. 잘못된 비용은 보고된 그대로 두어 라우트를 부적격으로 만들고 점수가 NaN일 수 있다. 엄격한 비용 상한에서 비용을 모르면 `allowUnknownCost`가 없을 때 부적격이다.
- `ImageRouteFacts.authenticatedRoutesLayer`는 `direct_adapter`이면서 `authentication.verified`인 라우트만 available로 본다. 실제 계정 이미지 접근은 실행 시점에 검증한다.
- 호환 엔드포인트 reasoning 레벨은 모델 목록의 명시 확장(`capabilities.reasoning`), 알려진 서버(`owned_by` = `strata`)의 고정 레벨, `supported_parameters`(빈 options) 순서로만 정한다. 파라미터 지원만으로 유효 레벨이나 wire 매핑을 정하지 않는다(`docs/decisions.md` 2026-10-25).
- `failedReasons`는 체크 목록 순서를 유지한다.
- Context.Service 키는 `memory-agent/providers/<file>/<Service>` 형식 문자열이다.

## Side Effects

- GlobalConfig 읽기/쓰기: `ActiveProvider`(provider 설정 읽기), `ImageFeature`(`imageGenerationEnabled` update), `CrossProviderMediaConsent`(`crossProviderMediaConsent` update), `ModelFeatureFlags`·`OpenAICompatibleSettings`(시그니처상 GlobalConfigApi 사용)
- 네트워크: `DirectImageExecutor.openAIEnvironmentLayer`가 `https://api.openai.com/v1/images/generations`로 POST(FetchHttpClient). 구독 OAuth·호환 엔드포인트 모델 조회도 네트워크를 쓴다(subscription-provider.ts, openai-compatible.ts; 본문 미확인)
- 환경 변수: `OPENAI_API_KEY`를 `ConfigProvider.fromEnv()`로 읽는다
- 첨부 저장: `ImageMediaWorkflow`가 생성 이미지를 `Attachments.save`로 영속화한다
- Crypto: `ImageMediaWorkflow`와 `makeOpenAICompatibleSettings`가 `Crypto.Crypto`를 받는다(run id 등)
- 파일시스템/키체인: openai-compatible.ts의 `keychain`/`CompatibleKeyring`이 `FileSystem`·`Path` 컨텍스트로 자격증명을 저장한다(시그니처만 확인). `makeProviderToolPolicy`가 신뢰 작업 공간과 경로 검사에 `FileSystem`을 쓴다

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
