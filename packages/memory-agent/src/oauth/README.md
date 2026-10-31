# oauth

## Overview

`packages/memory-agent/src/oauth`는 OpenAI(ChatGPT/Codex)와 Anthropic(Claude) 구독 계정의 OAuth 연결을 맡는다. PKCE 로그인, OS keychain에 둔 토큰, SQLite `oauth_profiles`에 둔 다중 계정 프로필, 계정별 클라이언트 선택이 여기에 있다. 두 프로바이더의 SSE 모델 스트림을 공통 `NormalizedStreamEvent`로 바꾸는 프로토콜 정의, 구독 사용량·쿼터 조회, Windows 시스템 프록시를 거치는 토큰 요청도 이 디렉터리에 있다.

memory-agent의 프로바이더/런 계층은 `OAuthProfiles`·`OAuthAccountLogins` 서비스와 `createAccountBoundSubscriptionClients`로 실행마다 고정된 계정의 클라이언트를 얻는다. `subscription-oauth.ts`는 `validation-harness.ts`의 클라이언트와 키체인 API를 다시 내보내는 진입점이다.

## Interface

- `providerProtocols` / `ProviderProtocol` — openai·anthropic별 clientId, authorize/token/model/catalog URL, 콜백 경로·포트, tokenEncoding(form|json), refreshStatuses, 모델 요청 헤더를 담은 정적 표
- `claudeCodeVersion` — 구독 요청이 자신을 밝히는 Claude Code 버전 문자열(`"2.1.296"`). User-Agent와 Anthropic billing 헤더에 쓰인다
- `OAuthProvider` — `SubscriptionAccountProvider`(openai|anthropic)의 별칭 타입
- `createPkce` / `createOAuthState` — `Crypto.Crypto`로 PKCE verifier/challenge(SHA-256, base64url)와 OAuth state를 만드는 Effect
- `NormalizedStreamEvent` — 두 프로바이더의 SSE 이벤트를 디코드해 담는 프로바이더 중립 TaggedEnum(text, tool-call*, reasoning*, usage, error). `Stream*Event` 타입 별칭들이 함께 있다
- `ProviderStreamFailed` / `ProviderStreamFailedReason` (`RequestNotSent`, `ProviderStatusRejected`, `ResponseInterrupted`, `RequestOutcomeUnknown`) — 모델 스트림 실패와 그 이유의 TaggedUnion
- `ProviderFeatureRejectedError`, `ReasoningSummaryProtocolFailed`(+`ReasoningSummaryProtocolFailedReason`) — prompt-cache 기능 거부, reasoning summary 프로토콜 위반 오류
- `ToolArguments` — `Schema.Record(String, JsonValue)` 도구 인자 스키마. `JsonValue`도 다시 내보낸다
- `createSubscriptionOAuthClient` / `SubscriptionOAuthClient` / `SubscriptionOAuthClientOptions` — 프로바이더 하나의 로그인·상태·모델 카탈로그·연결 해제를 맡는 클라이언트. 구현은 `validation-harness.ts`에 있고 `subscription-oauth.ts`가 다시 내보낸다
- `OAuthKeychain` — Context.Service. 레거시 `store`와 `profileStore(id)`(프로필별 keychain slot)를 제공한다
- `OAuthHarnessError` (`fromCode("not_connected"|"cancelled"|"login_in_progress"...)`), `OAuthProfileIdRejected` — OAuth 하네스 오류와 프로필 id 거부 오류
- `CredentialStore`, `StoredCredential` / `StoredCredentialSchema`, `createKeychainCredentialStore`, `LoginAttempt`, `OAuthConnectionStatus`, `SubscriptionClientFailure` — 자격 증명 저장소 계약과 로그인 시도·연결 상태 타입
- `OAuthProfiles` — SQLite 기반 프로필 서비스. list/snapshot/committed/publish/select/remove/acquireRun/whileRemoving를 제공한다
- `OAuthProfile`, `OAuthProfileRejected`(reason 리터럴 7종), `OAuthProfileStoreFailed`(operation: database|keychain) — 프로필 모델과 오류. `OAuthProfile` Schema는 `contracts.ts`에 있고 `accounts.ts`가 다시 내보낸다
- `ProfileCredentialStore` / `createProfileCredentialStore(open)` — 프로필 id별 keychain slot에 read/write/remove를 위임하는 어댑터
- `OAuthAccountLogins` (+`.layer`, `OAuthProfiles` 필요) / `createOAuthAccountLoginManager` — 계정 페이지의 계정 추가 로그인 관리자. profiles/start/cancel/settled를 제공한다
- `AccountLoginState` — idle/completed/pending{authorizationUrl}/error{login_failed|credential_unavailable} TaggedEnum. 타입은 `contracts.ts`의 Schema에서 꺼내고, `account-login.ts`가 `Data.taggedEnum` 생성자를 붙인다
- `createAccountBoundSubscriptionClients` / `AccountLoginFailure` — 선택된 계정에 묶인 클라이언트 묶음. catalogKey, forRun(Scope), client{status, modelCatalog, startLogin, disconnect}를 반환한다
- `createChunkedPasswordEntry` / `PasswordEntry` / `OpenPasswordEntry` / `CredentialFragmentsFailed` / `ChunkedPasswordFailure` — OS vault 크기 제한을 넘는 비밀번호를 조각으로 나눠 저장하는 엔트리
- `prepareAnthropicValidationBody` — `EffectFunction.dual`(sessionId, serializedBody). Anthropic 요청 본문에 Claude Code billing/identity system 블록과 metadata.user_id를 넣고 필요한 beta 목록을 반환한다
- `SubscriptionQuota`, `SubscriptionUsage` (Context.Service), `SubscriptionQuotaError`, 스키마 `SubscriptionQuotaReport`/`SubscriptionQuotaStatus`/`SubscriptionQuotaWindow`/`SubscriptionAccountQuota`/`SubscriptionQuotaUnavailableReason` — 구독 쿼터 조회 서비스와 보고 스키마. 서비스는 `subscription-quota.ts`, 스키마는 `contracts.ts`에 있고 `subscription-quota.ts`가 다시 내보낸다
- `contracts.ts` — `/api/accounts`·`/api/accounts/quota`가 브라우저로 보내는 Schema(`OAuthProfile`, `AccountLoginState` 타입, `SubscriptionAccountsView`, 쿼터 스키마). 서버 코드를 import하지 않아 브라우저 번들이 쓴다
- `anthropicSubscriptionUsage`, `anthropicSubscriptionUsageProbe`, `openAiSubscriptionUsage`, `SubscriptionUsageCredentialExpired`, `SubscriptionUsageProbe`, `SubscriptionUsageWindow` — 프로바이더별 사용량 조회(`subscription-usage-probe.ts`)
- `parseWindowsProxy`, `classifyWindowsProxyOutput`, `windowsTokenProxy`, `fetchOpenAiTokenViaSystemProxy` — Windows 시스템 프록시를 해석하고 그 프록시로 OpenAI 토큰을 요청한다(`windows-token-proxy.ts`)
- 하위 디렉터리 없음

## Invariants

- 자격 증명(토큰)은 SQLite에 넣지 않는다. 로컬 프로필마다 별도 OS keychain 계정에 둔다. SQLite `oauth_profiles`에는 id/provider/label/selected/created_at 메타데이터만 둔다.
- 프로필 id는 UUID 또는 `legacy-(openai|anthropic)` 패턴이어야 한다. `publish`는 `legacy-` 접두 id, 공백뿐인 라벨, 80자를 넘는 라벨을 `invalid_oauth_profile`로 거부한다. keychain slot에 자격 증명이 없으면 `oauth_profile_missing_credential`로 거부한다.
- `publish`는 현재 선택을 바꾸지 않는다(selected=0으로 INSERT). 로그인 완료 뒤 선택된 계정이 없을 때만 새 계정을 `select`한다.
- `OAuthProfiles`의 쓰기는 `commit`으로 감싼다. 쓰기와 다시 읽은 snapshot의 `Ref.set`은 한 `sql.withTransaction` 안에서 함께 커밋된다. SqlError/SchemaError는 `OAuthProfileStoreFailed{operation:"database"}`로 바뀐다.
- `acquireRun`은 run 생성 시점에 프로필을 잡는다. Scope가 닫히면 count를 줄인다. `removing` 상태인 프로필은 `oauth_profile_removing`으로 거부한다. `whileRemoving`은 active run이 있으면 `oauth_profile_in_use`, 같은 provider에서 다른 제거가 진행 중이면 `oauth_profile_removing`으로 거부한다. release는 자기 gate만 identity로 비교해 지운다(구조 비교 금지).
- run 상태 맵은 로컬 서버 프로세스 메모리에만 있고 토큰이나 계정 라벨을 담지 않는다. 영속 프로필의 원본은 SQLite다.
- 레거시(계정 기능 이전) 클라이언트는 구성된 프로필이 0개이고 `oauth_legacy_removed`에 해당 provider가 없을 때만 쓴다. 계정이 하나라도 구성되면 캐시에서 legacy client를 지운다. 삭제된 계정의 client도 캐시에서 지운다.
- `forRun`은 adapter를 만들 때 한 번만 선택을 읽어 고정한다. 그 뒤 전역 선택이 바뀌어도 진행 중인 run의 계정은 바뀌지 않는다.
- 계정 추가 로그인은 항상 `crypto.randomUUIDv4()`로 만든 새 keychain slot을 쓴다. legacy provider client로는 계정을 추가하지 않는다.
- provider당 실행 중인 add-account 로그인은 하나다. 진행 중에 `start`를 부르면 `login_in_progress`로 실패한다. `settle`은 자기 attempt의 running entry만 settled로 바꾸고 더 새로운 로그인의 상태는 건드리지 않는다.
- 로그인 완료 처리는 `Effect.forkDetach`로 HTTP 요청 수명과 분리된다. 명시적 cancel만 이를 멈춘다. publish 전에 cancelled 플래그와 `connection.connected`를 확인한다.
- 실패 정리는 best-effort다. 이미 게시된 계정은 select 실패나 늦은 취소가 있어도 남는다. 게시되지 않은 slot만 제거한다. 정리 실패는 tag 이름만 경고 로그로 남기고, 원래 실패 결과를 그대로 둔다.
- `ProviderStreamFailedReason`에서 요청이 프로바이더에 닿지 않았음을 증명하는 것은 `RequestNotSent`(dns/connect/tls)뿐이다. `RequestOutcomeUnknown`은 보낸 것으로 취급한다. `ProviderStatusRejected`는 status class만 남기고 응답 body는 남기지 않는다.
- OpenAI 콜백 redirect host는 `127.0.0.1`, 포트는 1455로 고정이다(Codex 등록값. Windows에서 localhost가 ::1로 풀릴 수 있음). refreshStatuses는 openai [401], anthropic [401, 403]이다.
- `claudeCodeVersion`은 모델이 최소 버전을 검사하는 값이다. Anthropic 모델 헤더(User-Agent)와 billing system 블록이 이 값을 함께 쓴다.
- `prepareAnthropicValidationBody`는 원래 system 앞에 billing 헤더와 Claude Agent SDK identity 텍스트를 붙인다. `thinking.block_binding`이 있을 때만 `thinking-binding-controls-2026-08-01` beta를 추가한다. 디코드할 수 없는 본문이면 `Error("invalid_anthropic_request")`를 throw한다.
- 조각 저장(`createChunkedPasswordEntry`): Windows `CRED_MAX_CREDENTIAL_BLOB_SIZE` 2,560바이트와 UTF-16 인코딩 때문에 한 조각은 1,280자로 제한한다. manifest는 `context-agent:chunked-password:v1:` 접두에 generation(UUIDv4)·count(1..256)·SHA-256 digest를 담는다. 새 generation은 모든 조각 쓰기가 성공한 뒤에만 공개한다. 조각 삭제는 모두 시도하고 첫 실패를 결과로 삼는다. 읽는 중 manifest가 바뀌면 한 번 더 읽는다.
- Effect 요구사항: `createAccountBoundSubscriptionClients`와 `createOAuthAccountLoginManager`는 `OAuthKeychain`, `Crypto.Crypto`, `ChildProcessSpawner`가 필요하다. `OAuthProfiles` 생성에는 `SqlClient`와 `OAuthKeychain`, `OAuthAccountLogins.layer`에는 `OAuthProfiles`가 필요하다. `createChunkedPasswordEntry`는 `Crypto.Crypto`가 필요하다.

## Side Effects

- SQLite: `oauth_profiles`를 읽고 쓴다. `oauth_legacy_removed`를 읽는다. 쓰기는 `sql.withTransaction` 안에서 한다.
- OS keychain: `OAuthKeychain` store와 `profileStore(id)`로 자격 증명을 읽고 쓰고 지운다. 큰 비밀번호는 `{account}:{generation}:{index}` 계정에 조각으로 나눠 쓰고 지운다.
- 네트워크: `providerProtocols`의 OAuth token 엔드포인트, 모델 URL(SSE), 카탈로그 URL, 구독 사용량 URL(`anthropicUsageUrl`, `openAiUsageUrl`)을 호출한다.
- OAuth 로그인의 로컬 콜백 수신: `callbackPath`/`callbackPort`로 콜백을 받는다(openai 1455, anthropic 동적).
- 자식 프로세스: `ChildProcessSpawner`로 Windows 시스템 프록시를 조회하고(`windowsTokenProxy`), 그 프록시로 OpenAI 토큰을 요청한다(`fetchOpenAiTokenViaSystemProxy`).
- 분리된 fiber: 로그인 완료와 계정 게시를 `Effect.forkDetach`로 백그라운드에서 실행한다.
- 프로세스 메모리 상태: `SynchronizedRef`에 계정별 클라이언트 캐시, provider별 로그인 entry, 프로필 run/removing 게이트를 둔다. `Ref`에 커밋된 프로필 snapshot을 둔다.
- 난수·시각: `Crypto.randomBytes`/`randomUUIDv4`/`digest`(SHA-256)를 쓰고, `DateTime.now`로 프로필 `created_at`을 기록한다.
- 로그: 정리 실패 시 `Effect.logWarning`(`"OAuth login cleanup failed"`, `"OAuth login slot cleanup failed"`, `"Credential fragment cleanup failed"`)을 남긴다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
