# model

## Overview

`packages/memory-agent/src/model`은 앱의 모델 공급자들을 Effect AI `LanguageModel`로 감싸는 계층이다. 대상은 OpenAI 호환 Chat Completions(`compatible.ts`), ChatGPT·Claude 구독 OAuth 스트림(`subscription.ts`), 외부 ACP 에이전트(`external.ts`)다.

저장된 대화(`StoredMessage`)와 Effect `Prompt` 사이를 손실 없이 오가는 변환(`prompt.ts`)도 이 디렉터리에 있다. TanStack 1.0과 같은 요청을 다시 만드는 히스토리 replay·정제(`history.ts`)도 여기에 있다. 그 밖에 사용자 표시용 실패(`ShownFailure`), 단발 호출(`single-call.ts`), 전송 전 실패의 재시도(`unsent-retry.ts`), 도구 파라미터 JSON Schema(`tool-schema.ts`)를 다룬다.

사용처는 `packages/memory-agent/src/providers/openai-compatible.ts`, `packages/memory-agent/src/providers/subscription-runtime.ts`, `packages/memory-agent/src/agent/chat.ts`, `packages/memory-agent/src/agent/turn-summaries.ts`, `packages/memory-agent/src/report/diagnosis.ts`다.

## Interface

- `compatibleModel` — `Effect.fnUntraced((options: CompatibleModelOptions) => …)`. OpenAI 호환 엔드포인트를 Effect `LanguageModel`로 만든다. `OpenAiClient`가 요청을 보내고 이벤트를 나눈다.
- `CompatibleModelOptions` — 한 run의 compatible 모델 설정(`endpoint`, `reasoningEffort`, `key`, `fetcher`). 모든 step에서 고정된다.
- `CompatibleRunRequestFailed` / `CompatibleRunRequestFailedReason` — 앱이 compatible 요청을 거절하거나 실패한 이유를 담는 `Schema.TaggedError`. 이유는 `Cancelled`, `KeychainUnavailable`, `ContextLimitExceeded`, `ToolCallingDisabled`, `Transport{codes}` 중 하나다.
- `compatibleFailure` / `shownCompatibleFailure` / `failingCompatibleModel` — `AiError`에서 앱 실패를 꺼내고 사용자 표시용 `ShownFailure`로 만든다. `failingCompatibleModel`은 모든 요청이 주어진 실패로 끝나는 모델이다.
- `compatibleTarget` — compatible 모델의 `ReplayTarget`(provider `openai-compatible`, api `openai-completions`)과 TanStack 방식의 tool call id 재명명 규칙.
- `compatibleBody` / `compatibleRequest` / `CompatibleRequest` / `CompatiblePayload` — Chat Completions 요청 본문을 만든다. `compatibleRequest`는 컨텍스트 가드가 걸리면 보내기 전에 거절한다.
- `externalModel` / `ExternalModelOptions` — 외부 ACP 에이전트와의 대화를 `LanguageModel`로 만든다. 입력은 `agent`, `turn`, `preamble`이다.
- `ExternalAgentTurnFailed` / `turnFailure` — 외부 턴이 답 없이 끝났을 때의 오류(`code`, `detail`). `ExternalPromptOutcome`을 `Option<ExternalAgentTurnFailed>`로 매핑한다.
- `externalFailure` / `shownExternalFailure` — 외부 모델 `AiError`의 `UnknownError.metadata[optionsKey]`에서 턴 실패를 디코드하고, 사용자에게 보이는 실패로 만든다.
- `subscriptionModel` / `SubscriptionModelOptions` — ChatGPT·Claude 구독 모델을 `LanguageModel`로 만든다. 입력은 `client`, `selection`, `promptCache`다.
- `StreamingOAuthClient` — 구독 모델이 쓰는 스트리밍 클라이언트 인터페이스. `stream`이 `NormalizedStreamEvent`를 내보내고 실패 타입은 `SubscriptionClientFailure`다.
- `SubscriptionStreamFailed` / `SubscriptionStreamFailedReason` / `SubscriptionFailure` — 구독 스트림 실패 오류(`RequestNotSent`, `ProviderStatusRejected` 등)와 실패 합집합 타입(`ProviderFeatureRejectedError`, `ReasoningSummaryProtocolFailed` 포함).
- `subscriptionFailure` / `shownSubscriptionFailure` — 구독 모델 `AiError`에서 `SubscriptionFailure`를 꺼내고 표시용 실패로 만든다.
- `subscriptionBody` / `SubscriptionRequest` — provider(`anthropicBody`/`openAiBody`)별 구독 요청 본문을 만든다. eval 스크립트도 이 함수를 쓴다.
- `PromptCache` — 구독 요청의 prompt cache를 나타내는 Schema Struct이자 타입.
- `publicReasoningLimits` — 공개 reasoning 한도 상수(`characters: 2 * 1024 * 1024`, `parts: 256`, `idCharacters: 512`).
- `ReplayTarget` — 요청이 가는 모델의 `source`와, 다른 모델이 만든 tool call id를 바꾸는 규칙 `toolCallId(id, attempt)`.
- `providerHistory` / `providerPrompt` — dual 함수. `target` 기준으로 저장 히스토리나 `Prompt`를 replay하고 정제해 provider 요청용으로 만든다.
- `sanitizeText` — 짝 없는 UTF-16 surrogate를 지운다.
- `toPrompt` / `fromPrompt` — 저장 메시지와 system 프롬프트를 Effect `Prompt`로 바꾸는 dual 함수와 그 역변환.
- `optionsKey` / `PartOptions` / `partOptions` / `toolResultContent` / `StoredContent` — `Prompt`에 필드가 없는 앱 정보를 `options["memory-agent"]`에 담고 읽는 키·스키마·헬퍼.
- `collectResponse` — 스트림만 하는 모델의 `generateText`용으로, part 스트림을 전체 응답 `Array<Response.PartEncoded>`로 모은다.
- `shownReason` — `AiError` reason을 기본 `ShownFailure`로 바꾼다.
- `singleAnswer` / `singleAnswerParts` / `SingleCall` — system 프롬프트 하나 아래에서 질문 하나를 보내는 단발 호출(권한 리뷰, 보고서 진단, 해석, 턴 요약). 전체 답과 usage를 돌려주거나 part 스트림을 돌려준다.
- `unsentRetried` / `UnsentRetry` — Goal run 모델 래퍼. 공급자가 요청을 받지 못했을 때만 `wait` 뒤에 다시 보낸다. `toolParameters`(`tool-schema.ts`)는 도구 파라미터의 provider용 JSON Schema를 만든다.
- 하위 디렉터리 없음.

## Invariants

- 히스토리 replay는 TanStack 1.0이 만든 요청과 같아야 한다(`transformMessagesForReplay` 다음 `sanitizeProviderRequest` 순서). 마이그레이션 전에 시작한 대화를 이어 갈 때 이전과 같은 요청을 보내야 한다(`docs/effect-ai-migration.md` step 2).
- replay 규칙은 네 가지다. 실패하거나 취소된 assistant 턴(`stopReason`이 있음)은 그 턴의 tool 결과와 함께 빠진다. 결과 없이 남은 call에는 "No result provided" tool 메시지를 채운다. `finishReason === "length"`로 잘려 파싱되지 않는 arguments는 "{}"로 바꾼다. 다른 모델의 턴은 `target`이 있을 때만 다시 쓴다.
- 구독 provider는 `ReplayTarget`을 넘기지 않는다. 따라서 다른 모델의 턴을 자기 턴처럼 읽는다.
- `freeId`는 attempt 0..999 안에서 아직 쓰이지 않은 id를 찾는다. 찾지 못하면 Error를 던진다. 이는 규칙 쪽 버그로 간주한다(TanStack과 같은 한계).
- 턴이 segment로 나뉘면 메시지 id가 `${turnId}-segment-`로 시작한다. 이런 경우 결과가 오기 전까지 call을 열어 둔다.
- 정제는 메시지 텍스트와 tool call arguments의 lone surrogate만 지운다. thinking은 서명된 그대로 둔다. 바뀔 것이 없는 arguments는 원래 바이트를 유지한다.
- `toPrompt`/`fromPrompt`는 손실 없이 왕복해야 한다. `Prompt`에 없는 정보(reasoning signature·redacted, 원본 arguments 문자열, tool error, image url/untyped, 메시지 메타)는 `options[optionsKey]`("memory-agent")에 둔다. 이미지 data는 저장된 문자열 그대로 유지한다.
- compatible tool call id 재명명은 TanStack의 `hashToolCallId` 규칙을 따른다. 결합 id는 40자 이하일 때만 쓰고, 넘으면 31자 + `_` + 해시 8자로 만든다.
- compatible 요청 본문은 TanStack이 같은 히스토리로 만들던 본문과 같아야 한다. stream 필드도 이미 제자리에 둬서 키 순서를 유지한다. 도구는 `strict: false`로 보낸다.
- 빈 user 메시지(빈 텍스트이거나 part가 없음)는 `InvalidRequestError`로 거절한다. 그렇지 않으면 입력 없이 유료 요청이 나간다. 컨텍스트 한도를 넘는 요청은 보내기 전에 `ContextLimitExceeded`로 거절한다.
- `CompatibleRunRequestFailed`의 message는 URL·헤더·페이로드가 없는 고정 텍스트다. 외부 에이전트 `detail`은 비밀이 이미 가려진 에이전트 텍스트이고, 오류 상세에서만 보인다.
- 외부 에이전트는 JSON `responseFormat` 요청을 보내기 전에 거절한다. 한 step에서는 memory preamble 뒤에 사용자의 마지막 텍스트만 보낸다. 보고된 tool call은 답 텍스트 끝에 붙인다.
- run별 모델 옵션은 모든 step에서 고정된다. compatible은 endpoint·effort·key, 구독은 selection·promptCache, 외부 에이전트는 agent와 session이다.
- `unsentRetried`는 응답 part가 하나도 오지 않았을 때만 다시 보낸다(`docs/decisions.md` "승인된 Plan의 서버 자동 진행 (2026-10-02)", 2026-10-13).
- `toolParameters`는 앱의 closed draft-07 스키마에서 `$schema`를 빼서 보낸다. object 스키마에는 항상 `properties`와 `required`가 있다. JSON Schema로 작성된 동적(MCP) 도구는 작성된 그대로 보낸다.

## Side Effects

- 네트워크: `compatibleModel`이 `OpenAiClient`, `FetchHttpClient`·`HttpClient`, 주입된 `fetcher`로 OpenAI 호환 엔드포인트에 HTTP 스트리밍 요청을 보낸다. API key는 `Redacted`로 다룬다.
- 키체인: compatible 실패 이유에 `KeychainUnavailable`이 있다. 따라서 key 조회는 이 디렉터리 밖의 키체인에 의존한다.
- 네트워크: `subscriptionModel`이 주입된 `StreamingOAuthClient.stream`으로 ChatGPT·Claude 구독 OAuth 스트림을 연다.
- 외부 프로세스: `externalModel`이 주입된 `turn`·`preamble` Effect로 외부 ACP 에이전트 세션에 턴을 보낸다. 스트림이 interrupt되면 턴이 취소된다. 업데이트는 `Stream.callback` 큐에 `Queue.offerUnsafe`로 넣는다.
- 타이머: `unsentRetried`가 다시 보내기 전에 `wait`만큼 기다린다.
- SQLite·파일 시스템·환경 변수에는 직접 접근하지 않는다. `prompt.ts`, `history.ts`, `tool-schema.ts`, `response.ts`는 순수 변환이다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
