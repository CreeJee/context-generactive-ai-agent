# TanStack AI에서 Effect AI로 전환 계획 (2026-10-25)

상태: 구현 중(2026-10-26 시작). 방향은 2026-10-25 대화에서, 도구 실행 방식은 2026-10-26 대화에서 정했다. 전환 시작은 decisions.md "TanStack AI를 Effect AI로 전환한다 (2026-10-26)", Goal 실행은 "Goal도 owner 프로세스에서 돌고 도구를 병렬로 실행한다 (2026-10-26)"에 있다. 배경 논의: 세션 `0c379bba`(2026-10-25), `f5dc93f6`(2026-10-26). 코드 위치는 `fe9a74ef` 기준이다. 그 뒤 `c1ba4fff`(2026-10-25)에서 TanStack 패키지가 모두 1.0.0으로 올라갔고, 버전과 TanStack 동작은 1.0.0 기준으로 고쳤다(2026-10-26). Goal 부분은 `b54fcd7c` 기준이다.

## 목표

TanStack AI 패키지를 모두 뺀다. 모델 호출, 도구, agent loop, 채팅 전송은 Effect AI(`effect/ai`)와 직접 만든 코드로 옮긴다. 기존 채팅은 지금처럼 열리고 이어서 대화할 수 있어야 한다.

## 정한 방향 (2026-10-25)

- TanStack 패키지 9개와 pnpm patch 2개(`@tanstack__ai@1.0.0`, `@tanstack__openai-base@1.0.0`)를 모두 뺀다.
- provider 패키지는 `@effect/ai-openai-compat` 하나만 쓴다. 구독 Anthropic·ChatGPT, external ACP, scripted provider는 `LanguageModel.make`로 직접 만든다.
- 점진적 전환은 하지 않는다.
  - TanStack과 Effect를 잇는 bridge를 두지 않는다.
  - 옛 Goal용 host와 새 host를 함께 돌리지 않는다.
  - 새 모듈을 모두 만든 뒤 한 릴리즈 안에서 한 번에 바꾼다.
- Goal worker를 없앤다(2026-10-26). Goal loop는 일반 채팅처럼 owner 프로세스에서 돌고, 도구는 병렬로 실행한다. 그래서 옮길 worker 프로토콜과 native artifact가 없다("옛 Goal 처리" 참고).
  - 업그레이드는 바이너리 재시작이다. 재시작하면 실행 중이거나 승인을 기다리던 run은 이미 실패로 끝난다(`packages/memory-agent/src/chat-state/chat-state.ts`의 재시작 처리).
  - Goal 사용량도 많지 않다. 로컬 DB의 Goal bound run은 8개다(2026-10-26).
- DB의 테이블·열은 바꾸지 않는다. JSON 열 안의 TanStack 메타데이터는 migration 하나로 지우고, 쓰는 값만 우리 필드로 옮긴다("DB 저장 형식과 migration" 참고).
  - 조건: 기존 채팅이 지금처럼 열리고, 이어서 대화할 수 있어야 한다.
- API payload는 새 client에 맞춰 바꿔도 된다. chunk는 AG-UI 1.0 표준 모양으로만 쓰고, TanStack 확장 필드는 넣지 않는다.
- client는 `useChat` 대신 AG-UI 이벤트를 읽는 자체 hook을 `@effect/atom-react`로 만든다.
- Effect의 AG-UI 지원(#9842, #9852, #9853)은 merge 전이라 기대지 않는다. merge되면 다시 본다("Effect의 AG-UI 지원" 참고).
- 도구는 Effect 자동 해석 대신 앱이 stream을 읽으며 직접 실행한다(2026-10-26, "도구 실행 방식" 참고).

## 설치된 패키지로 본 가능성

- `effect` 4.0.3(pkg.pr.new `844a77b`, patch 적용)에 `effect/ai`가 들어 있다.
  - 모듈: `LanguageModel`, `Tool`, `Toolkit`, `Chat`, `Prompt`, `Response`, `AiError`, `Telemetry`, `IdGenerator`, `ResponseIdTracker`, `EmbeddingModel`, `McpServer`·`McpSchema`
  - 모두 `@stability unstable`이다.
- provider 패키지는 설치되어 있지 않다.
  - 같은 커밋이 pkg.pr.new에 있다: `@effect/ai-openai`, `@effect/ai-anthropic`, `@effect/ai-openai-compat`, `@effect/ai-openrouter`. 모두 4.0.3이고 peer는 `effect ^4.0.3`이다.
  - 쓸 패키지는 `@effect/ai-openai-compat` 하나이고, 같은 커밋에 고정한다.
- `@effect/ai-anthropic`로는 구독 provider를 대체할 수 없다.
  - 이 패키지의 adaptive thinking 스키마는 `{ type: "adaptive" }`뿐이다.
  - 구독 요청은 `display: "summarized"`와 `block_binding`을 보낸다(`packages/memory-agent/src/providers/subscription-adapter.ts`의 `subscriptionRequestBody`).
- `@effect/ai-openai-compat`은 `/chat/completions`를 쓰고 `reasoning_content`를 다시 보낸다. 지금의 `openaiCompatibleText`를 대체한다.
- `@effect/atom-react` 4.0.3도 같은 커밋으로 pkg.pr.new에 있다.
  - peer는 react `>=19 <20`, scheduler `>=0.25 <0.29`, `effect ^4.0.3`이다. 지금 react 19.3.1, scheduler 0.28.0이라 맞는다.
  - Atom 본체(`Atom`, `AsyncResult`, `AtomRegistry`, `Hydration`, `Reactivity`)는 이미 설치된 `effect/reactivity`에 있다.
  - frontend는 이미 Effect를 쓴다(`apps/agent/app/entry/chat/chat-panel.tsx`의 `runUiEffect`).
- 지금 쓰는 TanStack 패키지는 모두 1.0.0이다(`c1ba4fff`).
  - `@tanstack/ai`(patch), `ai-client`, `ai-react`, `ai-persistence`
  - `ai-openai`, `ai-anthropic`, `ai-mcp`, `ai-compaction`
  - `openai-base`(patch)
  - `@tanstack/ai` 1.0.0은 `@ag-ui/core` 1.0.0에 의존한다.

## Effect의 AG-UI 지원 (2026-10-25 기준)

merge된 Effect AI에는 AG-UI 지원이 아직 없다. 기능 요청 [#6341](https://github.com/Effect-TS/effect/issues/6341)(2026-06-15)이 열려 있고, 구현은 2026-10-23에 열린 PR 3개다. 셋 다 merge 전이고, 고정 커밋 `844a77b`에는 없다. PR 빌드는 pkg.pr.new에 있다: `effect@cafa88b`는 #9842, `effect@ddcf3f7`은 셋을 쌓은 #9853이다.

- [#9842](https://github.com/Effect-TS/effect/pull/9842): `AgUiSchema`(AG-UI 1.0 전체의 Effect Schema), `AgUi`(`toPrompt`, `fromStreamParts`, `withRunLifecycle`), `AgUiServer`(SSE endpoint). `@stability experimental`이다.
- [#9852](https://github.com/Effect-TS/effect/pull/9852): client에서 실행하는 tool(`execution: "client"`), `Chat.streamText`의 `maxSteps` loop.
- [#9853](https://github.com/Effect-TS/effect/pull/9853): `AgUiServer.agent`. 승인을 AG-UI interrupt로 바꾸는 일과 `STATE_*` 이벤트는 넣지 않았다.

쓸 수 있는 것:

- 저장된 승인 대기 기록은 이미 AG-UI 1.0 모양이다. `chat_interrupts.payload`의 키(`id`, `message`, `metadata`, `reason`, `responseSchema`, `toolCallId`)가 모두 AG-UI 1.0 `Interrupt`의 필드다.
- 새 chunk는 AG-UI 1.0 표준 모양만 쓰므로, merge되면 `AgUiSchema`를 chunk Schema로 그대로 쓸 수 있다. `fromStreamParts`는 loop의 이벤트 변환에 쓸 수 있다.

그대로는 쓸 수 없는 것:

- `AgUiServer.agent`는 승인을 interrupt로 바꾸지 않는다.
- `AgUi.toPrompt`는 client가 보낸 대화로 prompt를 만든다. 우리는 DB 기록이 기준이고, client는 새 메시지만 보낸다.
- Effect 쪽에는 server만 있다. client는 직접 만든다.

## TanStack이 지금 맡은 일

TanStack을 import하는 파일은 142개다: src 77, tests 45, app 8, eval 4, scripts 2, bench 1.

src에서 많이 쓰는 것:

- `ModelMessage` 135곳
- `ChatMiddleware` 58곳
- `EventType.` 54곳
- `toolDefinition(` 45곳
- `MetadataStore` 30곳
- `StreamChunk` 27곳
- `reconstructChat(` 21곳

### Effect AI로 바로 옮기는 것

- `toolDefinition` 45곳은 `Tool.make`로 옮긴다. 입력 스키마는 이미 Effect Schema다(`packages/memory-agent/src/tools/schema.ts`의 `toToolSchema`).
- `.server()`의 Promise 핸들러는 `Toolkit.toLayer`의 Effect 핸들러가 된다.
- 모델이 받는 도구 실패 `{ error, cause, detail }`는 `failureMode: "return"`과 `failure` schema로 표현한다. 그러면 `@tanstack/ai` patch가 필요 없다(decisions.md "원문 오류 표시와 백그라운드 루프 실패 정책 (2026-10-18)").
  - `failureMode` 기본값은 `"error"`라 도구마다 `"return"`을 지정한다(`effect/ai/Tool.ts`의 `make`).
  - `failure` schema를 따르는 것은 핸들러가 낸 typed failure뿐이다. 인자 decode 실패와 `AiError`는 `AiError` 모양으로 encode된다(`Toolkit.ts`의 `handle`, `Tool.ts`의 `failureResultSchema`). 모든 실패를 지금 모양으로 보이려면 모델에 넘기기 전에 앱이 바꾼다.
- 직접 만든 adapter(구독, external ACP, compatible 후처리, scripted)는 `LanguageModel.make({ generateText, streamText })`로 옮긴다.
- `chat({ stream: false })` 단발 호출 5곳은 `generateText`로 옮긴다.
  - 대상: `permissions/classifier.ts`, `report/diagnosis.ts`, `memory/interpret.ts`, `improve/interpret.ts`, `agent/turn-summaries.ts`
  - 지금은 `outputSchema`를 쓰지 않는다. turn-summaries는 text를 그대로 쓰고, 나머지 4곳은 text에서 JSON을 꺼내 Schema로 decode한다.
  - `generateObject`로 바꾸면 provider의 structured output에 기대게 된다. 직접 만드는 `LanguageModel`이 그것을 지원해야 하므로, 동작을 바꾸는 별도 결정으로 다룬다.
- MCP 도구는 `Tool.dynamic`에 JSON Schema를 그대로 넘긴다. JSON Schema로 만든 dynamic tool은 핸들러가 `unknown`을 받고 Effect가 인자를 검증하지 않는다. 인자 검증은 앱이 한다.

### 옮기면 나아지는 것

- 한 step의 도구를 동시에 실행할 수 있다.
  - Effect의 `concurrency`(기본값 `"unbounded"`)는 자동 도구 해석과 승인된 호출의 사전 실행에만 쓰인다. 이 계획은 `disableToolCallResolution: true`로 해석을 앱이 가져가므로, 동시 실행은 앱 scheduler가 정한다("도구 실행 방식").
  - 그렇게 만들면 서브에이전트를 첫 호출 직전에 모두 시작하던 우회를 지울 수 있다(decisions.md "서브에이전트 (2026-09-15)").
  - parallel-reads 우회도 지울 수 있다. 지금은 step의 첫 쓰기 앞에 있는 읽기만 미리 시작하지만, scheduler는 한 step의 호출을 순서 없이 모두 동시에 돌린다.
  - 직접 만드는 provider에서는 모델이 아직 생성하는 동안 읽기를 먼저 시작한다.
- 도구 진행 결과를 `HandlerContext.preliminary`로 보낼 수 있다.
- span, GenAI telemetry, 타입이 있는 `AiError` reason을 얻는다.
- Promise↔Effect 경계가 줄어든다. src에 경계 주석이 171개, `nativePromise`가 122개, `runNativeEffect`가 66개 있다. 상당수가 TanStack 콜백 때문이다.

### 의미가 달라 따로 맞출 것

- **승인 묶음.**
  - 지금 규칙은 "한 번에 여러 호출 중 하나라도 `ask`면 묶음 전체를 한 번에 묻는다"이다(decisions.md "권한 모드 (2026-09-14)"). 근거가 "TanStack 재개 단위"라 전환하면서 바꾼다. 승인 요청은 지금처럼 한 묶음으로 묻고, 승인이 필요 없는 호출은 기다리지 않는다("도구 실행 방식").
  - Effect는 자동 도구 해석에서 같은 step의 승인 불필요 도구를 순서 없이 바로 실행한다.
  - 그래서 `disableToolCallResolution: true`로 자동 해석을 끄고, 앱이 `toolkit.handle`을 직접 부른다.
  - 이 모드에서는 Effect가 `needsApproval`을 평가하지 않는다. 판정 함수(`isApprovalNeeded`)는 export되지 않으므로 앱이 `tool.needsApproval`을 직접 평가한다.
  - 이 모드에서도 prompt에 `tool-approval-request`와 `tool-approval-response(approved: true)` 쌍이 있고 결과가 없으면, Effect가 모델 호출 전에 그 도구를 실행한다(`LanguageModel.ts`의 `collectToolApprovals`, `executeApprovedToolCalls`). 그래서 승인을 Effect approval part로 표현하지 않는다.
- **permission-review payload.** Effect approval 흐름으로는 표현할 수 없다.
  - 승인 응답은 `approved`와 `reason`뿐이라 `responseSchema`도, 승인 인자도 담을 수 없다.
  - 승인 요청 part에는 `metadata`(Json record)가 있지만, 위의 사전 실행 경로를 피하려면 approval part를 쓰지 않아야 한다.
  - 저장은 지금 interrupt 기록 모양으로 하므로, 앱 쪽 interrupt로 다룬다.
- **lazy tool(`DISCOVERY_TOOL_NAME`).** 같은 기능이 없다. step마다 toolkit을 바꾸고, `toolCallValidation: "deferred"`로 등록되지 않은 호출을 받아 직접 처리한다.
  - 등록되지 않은 호출은 provider가 이 옵션을 지원할 때만 돌아온다. 직접 만드는 `LanguageModel`은 `providerOptions.toolCallValidation`을 읽어 그대로 내보낸다.
- **tool call 검증 모드.** `disableToolCallResolution: true`의 기본값(`"strict"`)에서는 인자가 schema에 맞지 않는 tool call이나 등록되지 않은 이름이 하나만 있어도 `generateText`·`streamText` 전체가 `AiError`로 실패한다. 자동 해석 모드에서도 등록되지 않은 이름은 같다. 그래서 loop는 step마다 `toolCallValidation: "deferred"`를 쓰고, 앱이 tool schema로 인자를 decode해 실패는 모델에 답으로 돌린다(`answerInvalid`).
- **끊긴 응답.** 자동 해석 모드의 Effect는 finish reason이 `stop`·`tool-calls`·`pause`가 아니면 핸들러를 시작하지 않는다. 이미 돌던 핸들러는 interrupt하고 `execution-interrupted` 결과를 만든다. 해석을 앱이 가져가면 이 판단도 앱이 한다. 실행 중인 쓰기 도구를 중간에 끊으면 부작용이 반만 남으므로, 앱은 쓰기 호출을 완전한 finish 뒤에만 시작하고 실행 중인 호출은 끊지 않는다("도구 실행 방식").
- **메시지 구조.** `ModelMessage`와 `Prompt`는 구조가 다르다.
  - `Prompt`에서는 system prompt가 history 안의 메시지다.
  - tool-result에 `name`이 필수다.
  - 메시지에 `id`·`createdAt` 필드가 없다. 자유 형식 `options`만 있다.
  - 그래서 저장은 지금 메시지 구조를 우리 Schema로 두고, model을 부르기 직전에만 `Prompt`로 바꾼다.
  - 저장된 tool 메시지에는 `name`이 없다. 같은 `toolCallId`의 assistant tool call에서 찾는다.
- **usage 모양.** `TokenUsage`는 promptTokens 계열이다. Effect `Usage`는 중첩 구조다: `inputTokens{total, uncached, cacheRead, cacheWrite}`, `outputTokens{total, text, reasoning}`. 저장된 `chat_runs.usage`는 migration에서 새 모양으로 바꾼다. 저장 모양과 대응표는 1단계 "결과"에 있다.
  - 로컬 DB에 실제로 있는 키(2026-10-26): `promptTokens`, `completionTokens`, `totalTokens`, `promptTokensDetails.{cachedTokens, cacheWriteTokens}`, `completionTokensDetails.reasoningTokens`.
  - `totalTokens` 말고는 모두 Effect `Usage`에 자리가 있다. `promptTokens`가 cache를 포함하는지는 provider마다 확인해 `inputTokens.total`·`uncached`에 나눈다.
- **history를 provider 요청으로 바꾸는 규칙.** TanStack 1.0은 요청마다 `transformMessagesForReplay`(`@tanstack/ai`의 `utilities/replay-messages.js`)로 history를 다듬는다. 새 변환이 같은 일을 해야 이어지는 대화의 요청이 같아진다.
  - `metadata.tanstack.stopReason`이 `error`·`aborted`인 assistant 턴과 그 tool 결과를 뺀다.
  - `metadata.tanstack.finishReason`이 `length`이고 tool call 인자가 JSON으로 읽히지 않으면 인자를 `{}`로 바꾼다.
  - 결과가 없는 tool call에는 `"No result provided"` tool 결과를 만든다(로컬 DB에 23개).
  - openai-compatible adapter는 `metadata.tanstack.source`가 대상 provider·api·model과 다른 assistant 턴을 다른 모델의 것으로 본다. thinking은 평문으로 바꾸고, tool call id는 다시 붙인다.

### 직접 만들 것

- **agent loop.** TanStack `chat()` 전체를 대신한다(`packages/memory-agent/src/agent/chat-execution.ts`). Effect `streamText`는 한 step만 처리한다.
- **middleware hook.**
  - 이름 붙은 middleware가 21개다.
  - hook별 사용 파일 수: onConfig 7, onBeforeToolCall 7, onAbort 7, onAfterToolCall 5, onFinish 5, onStart 3, onUsage·onIteration·onShouldContinue·onToolPhaseComplete 각 2, onChunk·onInterruptBoundary·onInterruptResolution 각 1.
  - `providerMessages`를 쓰는 곳이 18곳이다.
- **interrupt 정의와 재개.** `defineInterrupt`와 permission-review(`packages/memory-agent/src/tools/definitions.ts`의 `permissionReviewInterrupt`)를 대신한다.
- **persistence.** `withPersistence`, `reconstructChat`, `MessagePage`, `MetadataStore`를 대신한다. Effect `Chat.Persistence`는 chat id별로 prompt 전체를 저장하는 기능뿐이라 쓰지 않는다.
- **전송.** AG-UI `StreamChunk`, SSE 응답, `memoryStream`과 SQLite durability, run 재접속(`resumeServerSentEventsResponse`)을 대신한다.
- **client.**
  - `useChat`(`apps/agent/app/entry/chat/chat-panel.tsx`)이 맡던 일: persistence delta, 20개 단위 history paging, interrupt 응답·재시도·오류 코드, 재접속, `onCustomEvent`.
  - ACP bridge와 테스트에서 쓰는 `ChatClient`.
- **MCP client.** `createMCPClient`(`packages/memory-agent/src/mcp/servers.ts`)는 이미 의존성인 `@modelcontextprotocol/sdk` Client로 바꾼다.
- **모델 표와 provider tool.**
  - 모델 표 3개: `ANTHROPIC_MODELS`, `OPENAI_CHAT_MODELS`, `OPENAI_IMAGE_MODELS`. capability 타입도 함께 옮긴다.
  - provider tool factory 18개(OpenAI 11, Anthropic 7): `packages/memory-agent/src/providers/tool-capabilities.ts`. provider tool은 `Tool.providerDefined`로 만든다.
- **compaction.** `evictOldest`를 직접 만든다.

## 도구 실행 방식 (2026-10-26)

Effect의 자동 도구 해석을 쓰지 않고, 앱이 stream을 읽으며 도구를 실행한다. step마다 `streamText`를 `disableToolCallResolution: true`, `toolCallValidation: "deferred"`로 부르고, `tool-call` part가 오는 대로 앱 scheduler에 넣는다.

자동 해석을 쓰지 않는 이유(설치된 `844a77b`로 실행해 확인, "확인하지 않은 것" 참고):

- 등록되지 않은 이름이 하나라도 오면 호출 전체가 실패한다. `"deferred"`는 자동 해석에서 효과가 없어 lazy discovery를 만들 수 없다.
- 승인 판정이 boolean뿐이라 permission-review의 reason, `responseSchema`, `askedBy`를 담을 수 없다. 판정 함수가 실패하면 승인 없이 실행한다.
- 동시 실행을 `concurrency` 숫자로만 정한다. 읽기는 받는 즉시, 쓰기는 완전한 finish 뒤에 시작하는 구분을 표현할 수 없다. (호출 사이의 순서는 2026-10-27에 두지 않기로 했다.)
- 응답이 끊기면 실행 중인 핸들러를 interrupt한다. 쓰기 도구는 부작용이 반만 남는다.

호출 하나는 이 순서로 처리한다:

1. 받은 순서대로 tool schema로 인자를 decode한다. 실패는 실행하지 않고 모델에 답으로 돌린다(`answerInvalid`). 등록되지 않은 이름은 discovery 요청으로만 해석한다.
2. 게이트 순서(chatState → delivery → projectInstructions → repeatGuard → 게이트)를 거친다. 거절된 호출은 실행하지 않고 바로 결과를 만든다.
3. 통과한 호출만 scheduler에 넣는다. 자기 권한 확인을 통과하지 않은 호출은 시작하지 않는다.

scheduler 규칙:

호출 사이에는 순서를 두지 않는다(decisions.md "도구 호출 사이에 순서를 두지 않는다 (2026-10-27)"). 한 step의 호출은 서로 독립이고, 순서가 필요하면 모델이 다음 턴으로 나눈다.

- 읽기 호출은 `readOnlyToolNames`(`packages/memory-agent/src/tools/effects.ts`)에 있는 도구의 호출이다. 나머지(쓰기, 셸, MCP, delegation, 서브에이전트)는 쓰기 호출로 본다. MCP의 `readOnlyHint`는 쓰지 않는다(decisions.md "MCP 서버 (2026-09-15)").
- 읽기 호출은 받는 즉시 시작한다.
- 쓰기 호출은 그 step의 응답이 완전한 finish(`stop`, `tool-calls`, `pause`)로 끝난 뒤에 모두 함께 시작한다. 다른 호출을 기다리지 않는다.
  - 응답이 끊기거나 provider가 실패하면 쓰기 호출을 시작하지 않는다. 끊긴 경우에는 "응답이 끊겨 실행하지 않음" 결과를 만든다.
  - 이유: finish 전에 시작하면 run이 provider 실패로 끝나도 부작용이 남는다. 실패한 턴은 다음 요청의 history에서 빠지므로(`transformMessagesForReplay`의 `stopReason` 규칙), 모델은 그 쓰기를 모른다.
  - 실행 중인 호출은 응답 사정으로 끊지 않는다. 사용자 취소는 지금 취소 동작을 따른다.
- 모델에 돌려주는 tool 결과는 끝난 순서가 아니라 호출 순서로 놓는다(지금 `parallelReads`와 같다).
- 서브에이전트를 첫 호출 직전에 모두 시작하는 우회와 `parallelReads`는 이 scheduler로 대신한다.
- 모델에는 한 턴의 호출이 동시에 돈다고 시스템 프롬프트에서 한 번 알린다.
- 같은 파일을 한 턴에 두 번 쓰면 쓰기 도구의 기대 sha256 검사가 하나를 실패시킨다(decisions.md "잘못된 성공 거르기 (2026-10-14)"). 셸·코드 실행·MCP에는 이런 검사가 없다.

승인 대기:

- 승인이 필요한 호출은 승인 뒤에 시작한다. 한 step의 승인 요청은 지금처럼 한 interrupt 묶음으로 묻는다.
- 승인을 기다리는 동안에도 다른 호출은 먼저 실행하고 결과를 기록한다. 재개 run으로 넘어가는 것은 승인 대기 호출뿐이다.
- interrupt로 run을 끝내는 때는 실행할 수 있는 호출이 모두 끝난 뒤다. 그래서 오래 걸리는 호출이 승인 표시를 늦출 수 있다.
- 재개 run은 결과가 없는 호출만 실행한다. 이미 결과가 기록된 호출을 다시 실행하면 쓰기가 두 번 일어난다.
- decisions.md "권한 모드 (2026-09-14)"의 "묶음 전체를 한 번에 묻는다(TanStack 재개 단위)"를 이 규칙으로 대체한다.

provider별 차이:

- OpenAI 호환 `LanguageModel`(`packages/memory-agent/src/model/compatible.ts`)은 `@effect/ai-openai-compat`의 `OpenAiClient`로 보내고 받기만 한다. chunk는 TanStack `processStreamChunks`처럼 직접 바꾸고, `tool-call` part는 `finish_reason`을 받을 때 한꺼번에 낸다(TanStack과 같다). 이 provider에서는 읽기도 응답이 끝난 뒤에 시작한다.
  - 인자가 JSON으로 읽히지 않는 tool call은 실패하지 않고 글자 그대로 `params`로 온다(2단계 결과). 끊긴 응답의 tool call이 그렇다. 패키지의 `OpenAiLanguageModel`은 이때 `"deferred"`여도 stream 전체를 `AiError`(`ToolParameterValidationError`)로 실패시키므로(`makeStreamResponse`) 쓰지 않는다.
- 구독 Anthropic·ChatGPT `LanguageModel`은 tool call 하나가 끝날 때마다 `tool-call` part를 내보내게 만든다. 지금의 `NormalizedStreamEvent`(`packages/memory-agent/src/oauth/protocol.ts`)에 호출마다 끝을 알리는 `tool-call`과 `content-block-end`가 있다. 이 provider에서만 모델이 생성하는 동안 읽기가 먼저 돈다.

결과를 기다리지 않는 도구:

- 오래 걸리는 도구는 시작했다는 결과를 바로 돌려주고, 끝나면 알림 후속 턴으로 결과를 전달하게 바꿀 수 있다. 서브에이전트가 이미 이 방식이다(`ad2ccf97`).
- 대상은 셸처럼 오래 걸리는 도구로만 고른다. 모델이 결과 없이 다음 행동을 정해야 하고, 후속 턴이 늘어나기 때문이다. decisions.md "도구 성능 (2026-09-15)"에서 미룬 셸 실행 handle과 같은 일이다.
- 이 전환에는 넣지 않는다. TanStack 위에서도 할 수 있는 일이라 따로 한다. 대상 도구는 "열린 항목"에서 정한다.

## DB 저장 형식과 migration

테이블과 열은 그대로 둔다. JSON 안의 TanStack 메타데이터는 migration 하나로 지운다. 로컬 DB에 있는 TanStack 메타데이터(2026-10-26 확인, 쓸수록 늘어난다):

- 메시지의 `metadata.tanstack`(10,157개): `createdAt`, `model`, `toolCallMetadata`, 드물게 `source`(556개)·`responseId`(244개)·`finishReason`·`run`·`index`·`threadId`·`runId`·`stopReason`
- tool call의 `metadata.tanstack`(3,773개): `model`·`index`, 또는 `source`(678개)

로컬 DB의 메시지 모양(2026-10-26):

- 메시지 144,123개 가운데 78,497개는 `createdAt`도 `metadata.tanstack.createdAt`도 없다. 새 Schema에서 `createdAt`은 선택 필드다.
- tool 메시지 77,736개 모두 `name`이 없고, 모두 같은 thread에 짝이 되는 assistant tool call이 있다.
- 24개 thread에 같은 `toolCallId`의 tool 결과가 여러 번 있다(5,461쌍, 15,066행, 내용은 같다). 2단계의 요청 비교에 이 thread들을 꼭 넣는다.

migration이 하는 일:

- `metadata.tanstack.createdAt`은 메시지에 `createdAt`이 없을 때 그 자리로 옮긴다.
- `metadata.tanstack.model`은 우리 `model` 필드로 옮긴다. model handoff가 이전 model을 찾을 때 이 값을 읽는다(`packages/memory-agent/src/agent/model-handoff.ts`의 `StoredModel`).
- `source`·`finishReason`·`stopReason`도 지금 요청을 만들 때 쓰는 값이다("의미가 달라 따로 맞출 것"의 history 변환 규칙). 같은 원칙대로 메시지 필드로 옮기고, 변환 규칙은 그대로 둔다(2026-10-26).
- 나머지 TanStack 메타데이터를 지우고, 비게 된 `metadata`도 지운다.
- `chat_runs.usage`를 새 usage 모양으로 바꾼다.
- `memory-agent/model-handoff` 상태의 `anchor`를 다시 계산한다.
  - fingerprint는 메시지 전체의 해시라, 메타데이터를 지우면 값이 바뀐다.
  - 다시 계산하지 않으면 그 세션의 handoff가 `HistoryChanged`로 실패한다.
- `chat_threads.messages`를 바꾸면 trigger가 history projection을 stale로 만든다. `chat_history_groups`도 메시지마다 같은 변환으로 고치고, thread마다 migration 전의 `ready`로 되돌린다(2026-10-26). 다시 만들지 않는다.

migration은 7단계 전환 커밋에서 등록한다. 지금 코드는 `metadata.tanstack.model`을 읽으므로, 그 전에 돌리면 안 된다.

테이블별 모양:

- `chat_threads.messages`
  - 지금은 TanStack `ModelMessage[]`다. migration 뒤에는 같은 구조(`role`, `content`, `toolCalls`, `toolCallId`, `thinking`, `id`, `createdAt`, `error`)를 우리 Schema로 쓴다. subagent thread(`subagent-<id>`)도 같다.
  - 읽는 곳: history projection의 검증(role, id), migration의 `json_each`, model handoff, compaction
- `chat_history_projection`: 화면 메시지 id별 `ModelMessage` 묶음이다. `format_version`은 1이다.
- `chat_runs`
  - status 5종: `running`, `interrupted`, `completed`, `failed`, `aborted`
  - `error`, `error_code`
  - `usage`: 지금은 TanStack `TokenUsage`다. migration에서 새 usage 모양으로 바꾼다. chunk마다 누적한다.
- `chat_interrupts`
  - `payload`: `RUN_FINISHED` chunk의 `outcome.interrupts` 항목을 얕게 복사한 객체다(`@tanstack/ai-persistence`의 `interruptPayload`). 키는 모두 AG-UI 1.0 `Interrupt`의 필드다.
    - `metadata`에는 TanStack의 재개 binding(`tanstack:interruptBinding`)이 있다. 재개할 때 도구 이름과 스키마를 이 값으로 확인하고, 도구가 없으면 `stale`로 거절한다. migration은 이 키를 지운다. 같은 정보(도구 이름, tool call id, 인자)가 payload의 앱 필드에 있다.
    - permission review의 요청(`toolCallId`, `toolName`, `arguments`, `reason`, `askedBy`)은 `metadata`의 `tanstack:interruptPayload`에 있다. migration이 `metadata.payload`로 옮긴다.
  - `response`: 응답 JSON이다. 응답이 없으면 NULL이다.
- `chat_metadata`
  - namespace는 모두 우리 것이다: `memory-agent/context-usage`, `memory-agent/consumed-cold-usage`, `memory-agent/turn-summaries`, `memory-agent/manual-compaction`, `memory-agent/model-handoff`, `memory-agent/workflow-execution`, `background-task-result`, history group.
  - 메시지에서 계산하는 값만 같은 계산을 유지하면 된다.
- `workflow_run_events.payload_json`
  - AG-UI chunk다. event key는 `sdk-stream:v1:` namespace다(`packages/memory-agent/src/workflow/durable-stream.ts`).
  - 새 행은 AG-UI 1.0 표준 모양으로만 쓴다.
  - 옛 행에는 AG-UI 1.0 밖의 TanStack 필드가 있다: `RUN_FINISHED.usage` 객체(AG-UI 1.0은 배열), `TOOL_CALL_START.toolName`, `TOOL_CALL_END.input`, `RUN_ERROR`의 `runId`·`threadId`·`error`.
  - 옛 행은 그대로 둔다.
    - 읽는 곳은 진행 중 run에 다시 붙을 때의 replay뿐이고, 내용을 해석하지 않는다.
    - 재시작하면 진행 중 run은 실패로 끝나므로, 옛 행이 다시 읽힐 일이 없다.
- `owner_rpc_operations`
  - TanStack 소유는 아니다. Goal worker를 없애면 Goal 도구 장부로만 쓴다(5단계).
  - 새 행은 도구 호출(`operation = 'tool'`)뿐이다. 번호는 owner가 run 안에서 매긴다. 모델 chunk, middleware, 권한 확인 행은 더 쓰지 않는다.
  - 열은 그대로다. `side_effect`, `status`, `fingerprint`를 보는 SQL은 새 행에서도 같은 뜻으로 돈다(`packages/memory-agent/src/workflow/uncertain-runs.ts`, `run-bindings.ts`, `completion-evidence.ts`).
  - 옛 행은 그대로 둔다. 쓰기 tool의 권한 확인은 `operation_id - 1`, 실행은 `operation_id`에 기록되어 있다. read recovery receipt(`packages/memory-agent/src/agent/owner-read-recovery.ts`의 `recoveredReadRunSql`)가 이 규칙으로 옛 행을 가리키므로, receipt를 읽는 SQL은 남긴다.
- **hook이 채우는 테이블**
  - 대상: `nodes`(`tool_result` 노드의 `detail.ok`와 `text`), `subagents`, work trace
  - TanStack hook 정보에서 값을 만들므로 같은 행이 나와야 한다.
- **Goal 테이블**(`workflow_goal_native_artifacts`, `workflow_goal_worker_generations`, `workflow_worker_dispatches`): 스키마는 그대로다. 새 row는 생기지 않는다. 옛 row는 지우지 않는다. 지우는 것은 대화 purge뿐이다(decisions.md "Goal을 실행한 대화를 지우면 Goal 기록도 같이 지운다 (2026-10-25)").

## 옛 Goal 처리

Goal worker를 없애므로 옛 Goal을 거절할 이유가 없다. 옛 Goal 세션도 새 코드에서 이어서 진행한다. 그래서 전에 적었던 거절(loader contract 변경과 409 `goal_native_generation_unavailable`), 세션 읽기 전용, 자동 진행 문구 수정은 하지 않는다.

- **새 run.** Goal 세션의 새 run은 일반 채팅과 같은 owner loop로 간다.
  - `packages/memory-agent/src/agent/chat.ts`의 `workerRevision` 선택과 worker 경로(`createFullLoopExecution`)를 지운다.
  - bound run 기록(`workflow_run_bindings`)과 durable 실행(`GoalExecution`, `packages/memory-agent/src/workflow/goal-execution.ts`)은 지금처럼 남긴다.
- **완료 근거.** `packages/memory-agent/src/workflow/completion-evidence.ts`는 worker 세대가 있는 Goal이면 run마다 dispatch 세대(`workflow_worker_dispatches`)를 요구한다. 새 run에는 dispatch가 없으므로 이 조건을 뺀다. binding·revision, durable 실행 완료, 장부에 남은 미해결 쓰기 조건은 그대로다.
  - `required`(native artifact나 worker 세대가 있으면 근거를 요구)도 같이 본다. 새 Goal에는 둘 다 없다.
- **옛 기록.** worker 세대, native artifact, dispatch, 옛 장부 행, read recovery receipt는 지우지 않는다. 쓰는 코드는 지우고, 읽는 코드만 남긴다.
- **끊긴 옛 run.** 업그레이드 재시작에서 진행 중이던 Goal run은 지금 재시작 규칙대로 정리된다.
  - 결과를 모르는 도구가 없으면 자동으로 이어 간다(`endedWithKnownEffectsSql`).
  - 있으면 `server_restarted` blocker로 멈추고, 사용자가 확인하면 이어 간다(`uncertainRuns`).
  - 옛 run의 장부 행도 같은 SQL로 판정한다. 부작용 없는 행과 middleware 행은 지금도 미해결로 세지 않는다(`run-bindings.ts`의 `toolOperationSql`).
- **packaging과 build.**
  - build는 worker `.mjs`와 native artifact(`dist/runtime/native.mjs`)와 manifest를 만들지 않는다(`packages/memory-agent/scripts/build-runtime-artifacts.ts`). `neverBundle`의 `@tanstack/ai`도 같이 빠진다.
  - packaging은 manifest 검증과 artifact 복사, artifact용 `@tanstack/ai` 복사를 그만둔다(`apps/agent/scripts/package.ts`).
  - 디스크에 남은 Goal worker 자산 파일은 지우지 않는다. 시작할 때 manifest가 없어도 실패하지 않아야 한다.

## 단계

새 모듈은 7단계 전까지 앱에 연결하지 않는다. 단계마다 커밋하고, 각 커밋은 빌드된다. 릴리즈는 하나다.

### 0. 기준 고정

- 지금 runtime과 scripted provider로 시나리오를 돌리고, 나온 DB 행을 golden으로 저장한다. id와 시각은 정규화한다.
- 시나리오:
  - 일반 답변
  - 읽기·쓰기 tool
  - 승인 interrupt(승인·거절), permission-review
  - 한 step에 읽기, 쓰기, 승인 호출이 섞인 경우
  - 취소, provider 실패
  - reasoning: Anthropic thinking 서명, OpenAI `openai-reasoning:` 접두어
  - named subagent, compaction, model handoff
  - Goal run: 한 턴의 병렬 읽기·쓰기 tool, 승인, 끊긴 run을 확인하고 이어 가기
  - queue와 steer
  - 거절 경로("보안 체크리스트"의 "데이터와 절차"에 있는 부정 케이스). 지금 코드의 거절 응답을 golden으로 둔다.
- 비교 대상은 "DB 저장 형식과 migration"의 테이블 전부다. 비교할 때 TanStack 메타데이터는 뺀다.
- 완료 기준: 지금 코드에서 통과한다. 타입으로 확인할 수 없는 경계라 테스트로 둔다.
- 결과(2026-10-26): `packages/memory-agent/tests/golden/`. `driver.ts`만 클라이언트를 안다. 전환할 때는 이 파일만 바꾸고 시나리오와 golden 파일은 그대로 둔다.
  - 거절 경로는 페이지와 같은 모양의 요청을 직접 보내고, 응답과 행을 같이 저장한다(`rejections`).
  - Goal worker가 owner에 보내는 요청의 거절(승인 없는 실행 등)은 golden이 아니라 `tests/full-loop/owner-authority.test.ts`가 맡는다. 5단계에서 worker와 함께 사라진다.
  - 지금 코드의 결함도 golden에 그대로 남겼다. 이 자리의 golden 차이는 의도한 수정이다.
    - 확인한 끊긴 Goal run 뒤의 Goal 턴은 시작하지 못한다. 장부의 부작용 예약이 확인 기록(`workflow_uncertain_acknowledgements`)을 보지 않고 `uncertain_run`으로 거절한다(`agent/owner-rpc-ledger.ts`). `goal-restart`는 확인까지만 두고, 5단계가 다음 턴을 더한다.
    - 모델이 없는 도구를 부르면 `tool_result` 노드의 text가 `[object Object]`다(`unknown-tool`).
  - golden에 넣지 않은 결함: 사용자 메시지가 저장되기 전에 취소하면 run이 `aborted`가 아니라 `failed`("All fibers interrupted without error")로 끝난다. `cancelled`는 모델 호출이 시작된 뒤에 취소한다.

### 1. 저장 Schema와 migration

- Effect Schema로 정의할 것: 메시지(TanStack 메타데이터 없음, `model` 필드 추가), usage, interrupt payload, interrupt 응답, history group
  - AG-UI 1.0 chunk Schema는 chunk를 쓰는 4단계에서 정의한다(2026-10-26). `AgUiSchema`가 merge되면 그것으로 바꾼다.
  - usage는 `TokenUsage` 필드와 Effect `Usage` 필드의 대응표를 함께 정한다.
  - interrupt 응답은 payload의 `responseSchema`와 승인 인자로 검사한다. Effect에는 이 검사에 해당하는 기능이 없다.
- `publishIfCurrent`의 `messages = ?` 비교가 새 직렬화에서도 성립하는지 확인한다("보안 체크리스트"의 "데이터와 절차").
- "DB 저장 형식과 migration"의 migration을 만든다. 7단계 전까지 앱의 migration 목록에는 넣지 않는다.
- `tools/`에 로컬 DB 사본을 검사하는 도구를 둔다.
  - `~/.context-generactive-agent/agent.db`를 복사하고 migration을 돌린다.
  - 모든 행이 새 Schema로 decode되는지 본다.
  - 메시지마다 내용(text, tool call, tool result, thinking과 서명, 이미지)과 `createdAt`, `model`이 원본과 같은지 비교한다.
  - 개인 데이터를 쓰므로 테스트로 커밋하지 않는다.
- 완료 기준: golden과 로컬 DB 사본에서 차이가 없다.
- 결과(2026-10-26): Schema는 `packages/memory-agent/src/chat-store/schema.ts`, migration은 같은 폴더의 `tanstack-migration.ts`(`migrateTanStackRows`)다. 결정은 decisions.md "채팅 저장 행에서 TanStack 메타데이터를 지운다 (2026-10-26)".
  - usage는 AG-UI 1.0 `TokenUsage` 하나로 저장한다. `RUN_FINISHED`가 싣는 모양이다.
    - `inputTokens` ← `promptTokens`, `outputTokens` ← `completionTokens`, `totalTokens` ← `totalTokens`
    - `cachedInputTokens` ← `promptTokensDetails.cachedTokens`, `cacheWriteInputTokens` ← `promptTokensDetails.cacheWriteTokens`, `reasoningTokens` ← `completionTokensDetails.reasoningTokens`
    - 456191fe 전의 Anthropic 구독 run은 `promptTokens`가 캐시 밖 입력뿐이다. 그 커밋부터 `cacheWriteTokens`를 늘 채우므로, 이 키가 없는 Anthropic run에 캐시 읽기·쓰기를 더하고 `totalTokens`를 다시 계산한다. Anthropic run은 `api_usage_responses.provider`로 가린다.
    - Effect `Usage`(2·4단계)와는 이렇게 잇는다: `inputTokens.total` = `inputTokens`, `cacheRead` = `cachedInputTokens`, `cacheWrite` = `cacheWriteInputTokens`, `uncached`는 남는 값, `outputTokens.total` = `outputTokens`, `reasoning` = `reasoningTokens`.
  - golden은 migration 뒤의 행으로 비교한다(`tests/golden/rows.ts`의 `migratedRows`). 시나리오마다 변환 함수가 만든 행과 DB에서 migration을 돌린 행이 같은지, 저장된 model handoff가 replay되는지 본다. chunk(Goal의 `workflow_run_events`, 거절 응답)는 TanStack 메타데이터를 빼고 비교한다.
  - JSON key 순서는 golden에서 정렬한다. 7단계의 writer가 key를 다른 순서로 써도 golden이 흔들리지 않는다.
  - `publishIfCurrent`의 `messages = ?` 비교는 그대로 성립한다. migration이 thread와 group을 같은 encoder로 쓰고, 이후에는 publisher가 thread에서 읽은 글자를 그대로 비교한다.
  - 로컬 DB 검사 도구: `node tools/chat-store-check/main.ts --source <agent.db> --work <저장소 밖 폴더>`. 원본을 `VACUUM INTO`로 두 번 복사해 한쪽에만 migration을 돌리고, 두 번째 실행이 바꾸는 행이 없는지, 모든 행이 새 Schema로 decode되는지(정의 밖 key는 실패), 메시지 내용과 handoff anchor가 원본과 같은지 본다. 출력은 개수, id, Schema 경로뿐이다.
  - 로컬 DB 사본 결과(2026-10-26): thread 751개, 메시지 144,641개, history group 33,046개가 decode되고 내용이 같다. 두 번째 실행은 아무것도 바꾸지 않는다. projection의 ready 751개는 그대로다. usage 1,374개, interrupt payload 140개·응답 138개가 decode된다. Anthropic run 19개 중 456191fe 전 16개는 `cacheWriteTokens`가 없고 13개가 보정되며, 뒤 3개는 있다. handoff anchor 5개는 그대로 맞는다. migration은 27초 걸렸다.
  - 대화가 지워진 thread의 handoff 상태 7개(legacy 1개 포함)는 `chat_metadata`에 남아 있고 migration 대상이 아니다.

### 2. provider

- `@effect/ai-openai-compat`를 `844a77b`로 추가한다.
- 구독 Anthropic·ChatGPT `LanguageModel`을 만든다. 다음은 그대로 쓴다:
  - 요청 body(`subscriptionRequest`)
  - `StreamingOAuthClient`, `NormalizedStreamEvent`
  - prompt-cache 거절 시 재요청
  - `SubscriptionStreamFailed` 단계 분류
- external ACP와 scripted `LanguageModel`을 만든다.
- 모델 표, capability 타입, provider tool 18개를 직접 만든다.
- 저장 메시지와 `Prompt`를 양방향으로 바꾸는 변환을 만든다. reasoning 서명과 encrypted reasoning이 손실 없이 왕복해야 한다.
- 완료 기준:
  - 기존 provider 계약 테스트를 새 provider로 옮겨서 통과한다: subscription-stream-contract, subscription-reasoning-restoration, subscription-sqlite-reasoning, openai-compatible.
  - 변환이 golden과 로컬 DB 사본에서 왕복한다.
  - migration한 로컬 DB 사본의 세션마다, 이어서 대화할 때 provider에 보내는 요청이 지금 코드가 원본에서 만드는 요청과 같다. reasoning 서명도 포함한다.
- 결과(2026-10-26): 모두 `packages/memory-agent/src` 아래다.
  - 모델: `model/subscription.ts`(구독), `model/compatible.ts`(OpenAI 호환), `model/external.ts`(external ACP), `testing/scripted-model.ts`(scripted). 저장 메시지와 `Prompt`의 변환은 `model/prompt.ts`(`toPrompt`, `fromPrompt`), replay는 `model/history.ts`(`providerPrompt`)다.
  - 모델 표는 `providers/model-catalog.ts`, provider tool 18개는 `providers/provider-tools.ts`다.
  - 로컬 DB 사본 결과(2026-10-26): thread 751개와 history 706개가 `Prompt`로 왕복한다. 이어지는 요청은 anthropic, openai, openai-compatible 모두 TanStack이 원본에서 만든 요청과 같다. reasoning 서명도 같다. golden과 replay 경계 사례(`tests/model/requests.test.ts`)도 같다. 비교는 `tools/chat-store-check`가 한다.
  - 계약 테스트는 `tests/model/`로 옮겼다. 옛 `openai-compatible.test.ts`의 설정·키 저장 테스트는 provider 설정의 것이라 그대로 둔다. `subscription-sqlite-reasoning`의 저장 부분은 4단계 persistence에서 옮긴다. 2단계는 응답이 TanStack과 같은 thinking과 서명으로 저장되는지만 본다(`tests/model/reasoning.test.ts`).
  - 정한 것:
    - replay는 각 provider가 적용한다. 모델은 저장된 대화의 `Prompt`를 받고 `providerPrompt(prompt, target)`로 자기 규칙을 적용한다. 구독 provider는 target이 없고, OpenAI 호환 provider는 `{provider: "openai-compatible", api: "openai-completions", model}`이다.
    - OpenAI encrypted reasoning은 바로 앞 요약 block의 `reasoning-end` metadata에 서명으로 싣는다. TanStack이 현재 thinking step에 붙인 것과 같다. 앞에 요약이 없으면 text 없는 block이 된다.
    - 앱의 실패는 `AiError`의 `UnknownError.metadata["memory-agent"]`에 encode해 싣는다. `subscriptionFailure`, `compatibleFailure`, `externalFailure`로 꺼낸다.
    - 취소는 fiber interrupt다. 모델은 `AbortSignal`을 받지 않는다.
    - provider tool의 설정은 `args`에 그대로 싣는다(`ProviderToolConfig`). 검사는 지금처럼 `tool-policy.ts`가 한다.
  - 발견: Goal worker가 쓴 메시지에는 `source.api`가 없다. adapter 대역에 `api`와 `kind`가 없어 TanStack이 `{provider, model}`만 저장했다. Schema가 이 모양을 받는다(`dd39ffca`).
  - TanStack과 달라진 것:
    - OpenAI 호환 provider는 모든 도구를 작성한 schema 그대로 `strict: false`로 보낸다. TanStack은 strict와 맞는 schema를 바꿔 보냈고, 앱이 원래 schema와 `strict: false`로 되돌렸다. 남는 차이는 strict와 맞지 않는 schema에서 지원하지 않는 `format`을 더는 지우지 않는 것뿐이다. 그래서 요청 비교는 tool 항목의 key 순서만 보지 않는다.
    - OpenAI 호환 provider에서 chunk가 하나도 없는 stream은 실패다. TanStack은 아무것도 내지 않았다.
    - OpenAI 호환 provider는 `toolChoice`를 읽지 않는다. TanStack도 보내지 않았다.
  - 다음 단계로 넘기는 것:
    - 3단계(닫음): `tool-policy.ts`의 factory와 인자 검사를 `providers/provider-tools.ts`로 바꾼다. descriptor의 `extension.factory`는 아직 TanStack factory다(3단계 결과의 "provider tool").
    - 3단계(닫음): OpenAI `computer_use`의 검사는 type `computer_use_preview`만 받지만 TanStack 1.0 타입은 `computer`다. TanStack은 설정의 type을 도구 이름으로 썼다. 새 도구도 구독 요청에서 같은 이름을 쓴다(`namedBy`). 검사는 그대로 `computer_use_preview`만 받는다.
    - 3단계(닫음): TanStack의 tool 입력 정규화는 optional 필드의 `null`을 `undefined`로 바꿨다. 같은 규칙이 필요해 옮겼다(3단계 결과의 "인자 보정").
    - 3단계: scripted 모델은 lazy discovery를 흉내 내지 않는다. discovery 방식을 정한 뒤 넣는다. invocation에 `runId`와 `threadId`가 없다. `LanguageModel.ProviderOptions`에 없기 때문이며, 4단계 loop가 run을 모델에 알리는 방법을 정한다.
    - 3·4단계: `OpenAiClient`의 오류 description에는 URL이 들어간다. 화면 문구는 description이 아니라 reason으로 만든다.
    - 4단계 writer: Effect finish reason을 저장 문자열로 바꾼다(`tool-calls` → `tool_calls` 등). OpenAI 호환 턴의 `source`는 `{provider: "openai-compatible", api: "openai-completions", model}`로 쓴다. 모델 이름은 `response-metadata`의 `modelId`에서 얻을 수 있다.
    - 4단계 writer: usage에 없는 필드는 0으로 채우고, 빈 reasoning block은 저장하지 않는다. TanStack이 그렇게 저장했다.
    - 4단계: OpenAI 호환 provider의 `KeychainUnavailable`과 `Cancelled`는 이제 호출자가 낸다. 키는 모델을 만들기 전에 읽는다. `agent/chat.ts`의 `historyKey`(baseUrl의 SHA-256)도 이때 옮긴다.

### 3. tool

- 45곳을 `Tool.make`와 `Toolkit`으로 옮긴다. 실패는 `failureMode: "return"`, 승인은 `needsApproval`로 표현한다.
  - `needsApproval`은 앱 loop가 읽어 평가한다. 평가가 실패하면 승인을 요구하는 쪽으로 처리한다. Effect 내부 판정은 실패하면 승인 불필요로 처리하므로 그대로 따라 하지 않는다.
- lazy discovery는 step별 toolkit과 `toolCallValidation: "deferred"`로 만든다.
- MCP는 `@modelcontextprotocol/sdk` Client와 `Tool.dynamic`으로 옮긴다. 인자 검증은 앱이 한다.
- `withHiddenResults`(`packages/memory-agent/src/secrets/redactor.ts`)를 Toolkit 핸들러 래퍼로 다시 만든다. 지금은 TanStack `AnyServerTool.execute`를 감싼다.
- `tools/definitions.ts`는 브라우저도 import한다. bundle 영향을 확인한다.
- 완료 기준: "보안 체크리스트"의 "도구 실패와 비밀" 항목을 확인한다.
- 결과(2026-10-27 완료): 모두 `packages/memory-agent/src` 아래다.
  - 도구 단위는 `tools/run-tool.ts`의 `RunTool`이다. 모델에 알리는 Effect AI `Tool`, lazy 여부, 인자를 decode해 실행할 호출을 만드는 `prepare`를 담는다. `runTool`이 이름·설명·parameters와 handler로 만든다.
  - `Toolkit.handle`과 `Toolkit.toLayer`는 쓰지 않는다. loop는 decode를 먼저 하고 게이트를 거친 뒤 실행하므로 둘을 나눠야 한다. handler마다 다른 타입은 closure로 감춘다.
  - 도구 모듈은 같은 spec과 handler로 TanStack 도구와 `RunTool`을 함께 만든다. TanStack 쪽은 7단계까지 Promise 경계로 남는다. 옮긴 것: 파일 도구와 SVG 미리보기(`tools/files.ts`, `attachments/previews.ts`), 프로젝트 밖 읽기(`tools/outside.ts`), 기억 도구(`tools/memory.ts`), btw 증거 도구(`btw/tools.ts`), report 증거 도구(`tools/report-evidence.ts`), 승인 도구와 `run_skill`(`tools/approved.ts`), `run_code`와 ts skill(`tools/code.ts`의 `forRunTools`), `read_skill`(`tools/skills.ts`), Kagi(`tools/kagi.ts`), background 결과·취소(`tools/background.ts`), `delegate_to_agent`(`tools/delegate.ts`), kanban 보드 도구(`kanban/tools.ts`), verifier의 `record_card_verdict`(`kanban/subagent-card-agent.ts`의 `verdictRecorder`), workflow 도구(`workflow/tools.ts`, phase별 목록은 `phaseTools` 표), 부모의 subagent 도구 4개(`subagents/subagents.ts`의 `runToolsFor`), MCP 도구(`mcp/servers.ts`의 `runTools`).
  - MCP: `@tanstack/ai-mcp` 대신 SDK `Client`로 연결하고 도구를 나열·호출한다(`mcp/client.ts`). TanStack 도구와 Effect AI 도구가 같은 연결과 같은 호출을 쓰고, `@tanstack/ai-mcp` 의존성은 지웠다.
    - TanStack client에서 옮긴 것: 프로토콜 협상 `auto`, task가 필요한 도구는 서버가 task를 지원할 때만 제공, 2025 프로토콜 task의 polling(`tasks/get`·`tasks/result`, 멈춘 호출은 `tasks/cancel`), 2026 프로토콜의 `Mcp-Param-*` 헤더용 `toolDefinition`, 결과 변환(text 하나는 문자열, 나머지는 part, `ui://` resource 생략, output schema가 있으면 `structuredContent`), 서버 오류 문구 `MCP tool "<name>" returned an error: ...`.
    - 인자는 서버가 보낸 JSON Schema로 `jsonSchemaIssues`가 검사한다. TanStack도 같은 검사기로 검사했다. `Tool.dynamic`은 인자를 검사하지 않는다.
    - 호출 span(`McpServers.call`)은 TanStack 도구에서는 run trace 아래, Effect AI 도구에서는 loop가 호출을 실행하는 곳 아래에 생긴다.
  - provider tool: 요청은 TanStack factory 인자 배열 대신 `{ id, config }`(`ProviderToolRequest`)다. 설정 검사는 `providers/provider-tools.ts`의 표(`acceptsConfig`)가 한다. `ProviderToolRuntime.compose`가 같은 요청으로 TanStack 도구(`tool`)와 Effect AI 도구(`modelTool`)를 만든다. TanStack 쪽(`factoryArguments`, descriptor의 `extension.factory`)은 7단계에 지운다.
  - subagent 도구: 한 부모 run의 상태(검토한 보고서, 전달된 알림, adoption draft)를 `parentRun`이 갖고, TanStack middleware와 Effect AI 도구가 같은 규칙을 쓴다. `runToolsFor`는 middleware 대신 `hooks`(`retry`, `deliver`, `recordAdoption`, `release`)를 내보내고, 4단계 loop가 middleware 자리에서 부른다. 검토 표시는 `onAfterToolCall` 대신 get_subagent_reports의 handler가 성공한 결과로 한다.
  - 승인 도구: `ask` 모드(`static`)의 save_code_skill·write_outside_file·delete_outside_file은 `needsApproval: true`를 단다. 다른 모드(`gate`)는 loop의 review가 호출마다 정한다. 브라우저가 import하는 `tools/definitions.ts`에는 Effect Schema spec만 두고, `effect/ai`는 서버의 `tools/approved.ts`만 import한다.
  - `tests/tool-effects.test.ts`의 등록 검사는 `toolDefinition({ name })`과 함께 `{ name, description, parameters }` spec도 도구 등록으로 읽는다. 설명이 `${...}`를 쓰는 template literal이어도 읽는다.
  - provider 요청은 TanStack과 같다(`tests/tools/run-tools.test.ts`, `tests/model/tool-schema.test.ts`). parameters는 TanStack처럼 draft-07에서 `$schema`를 빼고, object에 `type`·`properties`·`required`를 채운다(`model/tool-schema.ts`).
  - lazy discovery는 `tools/discovery.ts`의 `lazyToolsFor`다. TanStack `LazyToolManager`와 같은 이름·설명·답을 쓰고, history에서 이미 찾은 도구는 처음부터 연다.
  - 결과는 TanStack처럼 JSON으로 바꾼다. 문자열은 JSON으로 읽히면 읽은 값을, 아니면 문자열 그대로 쓴다. 나머지는 JSON으로 바꾸므로 undefined 필드가 빠진다.
  - 인자 보정: TanStack은 인자가 schema에 맞지 않으면 모델에 보낸 JSON Schema 쪽으로 고쳐 다시 검사했다(`"5"` → 5, `"true"` → true, optional 필드의 `null` 제거). `tools/input-repair.ts`가 같은 검사기(`@cfworker/json-schema` 4.1.1)로 같은 규칙을 옮겼다. loop는 `prepareRepaired`로 호출을 준비한다.
  - ts skill 입력 검사: TanStack `validateJsonSchema`가 하던 JSON Schema 검사를 `jsonSchemaIssues`(`tools/input-repair.ts`)가 같은 검사기와 같은 문구로 한다.
  - 프로그램 안의 도구 호출은 `prepare`로 decode한다. 보정은 하지 않는다. TanStack도 프로그램의 호출은 Standard Schema로만 검사했다.
  - 기억 도구의 사용 기록은 middleware `onFinish` 대신 `recordUse(parentMessageId)`로 내보낸다. 4단계 loop가 답을 마친 뒤 부른다.
  - TanStack과 달라진 것:
    - 비밀 가리기가 실패하면 결과 대신 `redaction_failed` 도구 실패를 돌려준다. TanStack 경로는 `{error: message}`를 돌려줬다.
    - JSON이 아닌 결과(undefined 필드가 있는 객체 등)도 JSON으로 바꾼 뒤 가린다. 옛 `redactResult`는 이런 결과를 가리지 않고 넘겼다.
    - 프로그램 안 호출의 `invalid_input:` 뒤 문구는 Effect Schema의 decode 오류다. TanStack은 Standard Schema의 문구였다. 접두사는 같다.
    - MCP client는 elicitation·sampling capability를 알리지 않는다. 서버가 그래도 입력을 요청하면 도구 실패(`The MCP server asked for input, which this app does not answer.`)다. TanStack은 두 capability를 알리고 입력 요청을 `mcp_input` interrupt로 바꿨지만, 앱은 그 interrupt를 다루지 않았다.
    - 2025 프로토콜 서버의 도구 목록은 `tools/list` 한 번이다. SDK `listTools`가 페이지를 모으고 출력 검사용 캐시도 채운다. TanStack은 캐시를 채우려고 한 번 더 보냈다. 페이지 상한은 SDK 기본값 64다(TanStack 100).
    - 서버가 오류로 답한 호출의 실패 tag는 `McpToolFailed`다. TanStack 경로는 `Error`였다. 문구는 같다.
    - TanStack 도구에 MCP Apps용 `metadata.mcp`(title, annotations, `uiResourceUri`)가 없다. 앱은 읽지 않았다.
    - 2026 프로토콜의 `tools/list_changed` 구독을 열지 않는다. run마다 목록을 다시 읽는다.
    - provider tool 요청은 Anthropic `code_execution`의 `skills`(TanStack factory의 두 번째 인자)를 받지 않는다. 앱은 쓰지 않았다.
    - 등록되지 않은 id의 provider tool 요청은 `invalid_request`로 거절한다. 전에는 검사기가 없어 오류가 던져졌다.
  - 완료 기준 확인(2026-10-27):
    - "도구 실패와 비밀": `RunTool`의 결과와 실패 상세는 `withHiddenRunResults`(`secrets/redactor.ts`의 `hiddenCall`)를 지난다. `PreparedCall`은 `ToolFailed`로만 실패하므로 handler의 typed failure도 가린 뒤 loop로 간다. 중간 결과(preliminary)를 내는 경로는 없다. 가리기가 실패하면 원문 대신 `redaction_failed`를 돌려준다. 결과와 실패 상세는 `tests/secret-redactor.test.ts`가 본다.
    - bundle: `tools/definitions.ts`의 런타임 import 그래프(type-only import 제외)는 19개 파일과 `effect`, `@tanstack/ai`다. `secrets/`, `permissions/`, `tools/run-tool.ts`, `effect/ai`는 없다. `@tanstack/ai`(`defineInterrupt`, `toolDefinition`)는 7단계에서 빠진다.
  - 다음 단계로 넘기는 것:
    - 4단계: loop가 묶는 모든 도구 세트(children·read-only·verify·report)를 `withHiddenRunResults`로 감싼다. 지금은 `agent/chat.ts`가 TanStack 도구에 `withHiddenResults`를 쓴다.
    - 4단계: 인자 decode 실패를 모델에 돌려주는 문구. TanStack은 `Input validation failed for tool <name>: ...`였다.
    - 자식 run의 `read_subagent_tool_result`: spec과 호출(`childResult`)은 나눴고, RunTool은 자식 run을 새 loop로 옮길 때 만든다. 자식 도구 목록(code 도구, 병렬 읽기, 게이트)과 함께 바뀌기 때문이다.

### 4. loop, hook, persistence

- step 순서:
  1. history를 준비한다. onConfig를 대신한다.
  2. `streamText`를 `disableToolCallResolution: true`, `toolCallValidation: "deferred"`로 부른다.
  3. stream을 읽으며 `tool-call` part마다 decode와 게이트를 거쳐 scheduler에 넣는다("도구 실행 방식").
  4. 완전한 finish를 받으면 쓰기 호출을 풀고, 실행할 수 있는 호출이 모두 끝나기를 기다린다. 승인 대기가 있으면 interrupt로 run을 끝낸다.
  5. usage를 읽는다.
  6. 다음 step 여부를 정한다.
- middleware 21개는 순서가 정해진 typed hook으로 바꾼다.
  - 도구가 병렬이면 도구 뒤 hook(`onAfterToolCall` 자리)도 겹친다. run 상태를 공유하는 hook은 `Ref`나 permit으로 순서를 지킨다. TanStack 1.0 일반 채팅에서도 이미 겹치므로, 옮기기 전에 21개를 한 번 본다.
- interrupt는 지금의 `chat_interrupts` 모양으로 만든다. 재개 handshake(새 runId, `parentRunId`, `resume`)를 유지한다.
- persistence 서비스가 `withPersistence` 동작을 그대로 재현한다:
  - run 생성과 재개
  - usage 누적
  - 스트리밍 중 저장(snapshotStreaming)
  - interrupt 묶음 commit
  - 끊긴 답 보존
- durable stream은 지금과 같은 AG-UI chunk와 event key를 쓴다.
- 서브에이전트, compaction, model handoff를 새 loop로 옮긴다.
- 완료 기준:
  - 0단계 golden과 같은 행이 나온다. 예외는 한 step에 승인 호출과 다른 호출이 섞인 시나리오다. 승인 규칙이 바뀌어 앞 호출이 interrupt 전에 실행되므로, 그 차이만 있는지 확인하고 golden을 새 규칙으로 고친다.
  - migration한 로컬 DB 사본의 모든 세션에서, history page의 화면 메시지가 지금 코드가 원본에서 만드는 것과 같다.
  - scheduler 규칙을 테스트로 둔다: 읽기는 받는 즉시 시작, 쓰기는 완전한 finish 뒤에 다른 호출을 기다리지 않고 시작, 끊긴 응답의 쓰기는 실행하지 않음, 결과는 호출 순서, 승인 대기 중 다른 호출 실행, 재개 run은 결과 없는 호출만 실행. 타입으로 확인할 수 없는 순서다.

### 5. Goal 실행

결정: decisions.md "Goal도 owner 프로세스에서 돌고 도구를 병렬로 실행한다 (2026-10-26)".

- Goal worker와 owner RPC를 지운다. Goal loop는 4단계 loop를 owner 프로세스에서 그대로 쓴다. 일반 채팅과 다른 점은 아래 넷뿐이다.
  - bound run 기록과 durable 실행(`GoalExecution`)
  - 도구 장부
  - provider 요청 전 transport 실패의 재시도(decisions.md 2026-10-13). 지금은 owner의 모델 스트림 pull에서 한다. owner loop의 모델 호출에서 같은 조건(`RequestNotSent`, 모델 chunk가 하나도 나가지 않음)으로 한다.
  - Goal 단계별 도구와 프롬프트. 지금도 owner가 정한다.
- 도구 장부(`owner_rpc_operations`):
  - 실행 전에 `pending`으로 예약하고, 끝나면 결과를 적는다. 실행 중 취소되거나 결과 없이 끝난 쓰기는 `uncertain`이다.
  - 번호는 owner가 run 안에서 예약하는 순서로 매긴다. 순서 검사(`non_monotonic`)는 없앤다.
  - fingerprint는 지금 도구 행과 같은 모양(operation, 도구 이름, `toolCallId`, 인자)으로 적는다. `uncertainRuns`가 이 값을 읽어 확인 화면에 보여 준다(`invocationFieldSql`).
  - 권한 확인은 장부에 적지 않는다. 장부에 없는 도구는 실행되지 않았다는 규칙은 그대로다.
  - run 안에서는 결과를 모르는 쓰기가 다른 쓰기를 막지 않는다(지금의 `uncertain_run` fence). 다음 run의 입장 검사(`run-bindings.ts`의 `unresolved`)가 막는다.
- 지울 것:
  - `packages/memory-agent/src/agent`의 Goal worker 모듈(약 5,000줄): `full-loop-*.ts`, `effect-rpc-message-port.ts`, `owner-rpc.ts`, `owner-rpc-ledger.ts`의 RPC 처리, `owner-native-*.ts`, `native-artifact-*.ts`, `goal-worker-*.ts`, `owner-tool-grants.ts`. 목록은 구현 때 CodeGraph로 다시 확인한다.
  - `packages/memory-agent/src/tools/parallel-reads.ts`
  - read recovery의 새 receipt를 만드는 operator API. receipt를 읽는 입장 검사는 남긴다(0.0.17 호환).
  - `ExecutionAdmission`의 `worker` gate와 `CONTEXT_AGENT_WORKER_*` 설정
- "옛 Goal 처리"의 변경을 넣는다.
- 완료 기준:
  - 0단계 Goal golden과 같은 행이 나온다. 단, 지운 장부 행(모델 chunk, middleware, 권한 확인)은 비교에서 뺀다.
  - 한 턴의 병렬 tool 중 늦게 끝나는 것이 있어도 run이 성공한다.
  - 병렬 쓰기 일부가 실패해도 나머지 결과가 기록되고, 다음 step의 모델이 모두 본다.
  - worker 세대가 있는 옛 Goal 세션에서 새 run이 돌고, 완료 근거가 나온다.

### 6. client

`useChat`을 대체하는 hook을 `@effect/atom-react`로 만든다. atom-react는 상태를 담는 틀이고, 채팅 규칙은 직접 쓴다.

- atom 대응:
  - 세션별 상태: `Atom.family`
  - 보내기: `Atom.fn`. 결과가 `AsyncResult`라 로딩과 오류가 함께 나온다.
  - 중지: `Atom.Interrupt`로 실행 중인 계산을 끊는다.
  - 이전 기록 20개씩: `Atom.pull`
  - 보낸 메시지를 바로 보이기: `Atom.optimistic`, `optimisticFn`
  - run 뒤 다시 읽기: `withReactivity`, `refresh`
  - SSR이 필요하면 `Atom.serializable`과 `HydrationBoundary`
- 직접 쓰는 채팅 규칙(`chat-panel.tsx`의 `useChat` 호출 기준):
  - SSE를 읽고 4단계의 AG-UI chunk Schema로 decode한다.
  - AG-UI 이벤트를 화면 메시지 parts로 쌓는 reducer. 지금의 UIMessage parts 모양을 유지한다.
  - 서버에 이미 있는 메시지는 빼고 보내는 전송(`persistence: true`)
  - 이전 기록 paging(`history.pageSize: 20`, `hasOlderMessages`, `loadOlderMessages`)
  - 승인 대기 목록, `resolveInterrupts`·`retryInterrupts`(새 runId, `parentRunId`, `resume`)
  - 오류 코드 5종(`incomplete-batch`, `unknown-interrupt`, `stale`, `conflict`, `expired`)과 `retryable`
  - 새로고침 뒤 진행 중 run에 다시 붙기(`sessionGenerating`, `resuming`)
  - `onCustomEvent`(context usage, queue delivered)
- BTW panel(`apps/agent/app/entry/chat/btw-panel.tsx`)은 이 가운데 일부만 쓴다.
- ACP bridge의 `ChatClient`를 대체한다.

### 7. 전환과 삭제

- 커밋 순서:
  1. 모든 진입점을 새 runtime으로 바꾸고, client를 6단계 hook으로 바꾸고, migration을 등록한다.
     - 진입점: 본 채팅, BTW, 서브에이전트, Goal, ACP, MCP, 단발 호출. Goal은 5단계에서 owner loop로 옮겼으므로 본 채팅과 같이 바뀐다.
     - API payload가 바뀌어 기존 `useChat`으로는 확인할 수 없으므로, backend와 client를 함께 바꾼다.
  2. TanStack을 지운다: 패키지 9개, patch 2개, catalog·`minimumReleaseAgeExclude`·`patchedDependencies`의 TanStack 항목.
- 검사: golden(거절 경로 포함), 로컬 DB 검사 도구, `vp check`, `vp run typecheck`, memory-agent `vp test --maxWorkers=4`, `vp run test:browser`
- decisions.md에 대체 결정을 남긴다. 대상은 아래 목록이다.

## 이번에 하지 않는 것

- TanStack과 Effect 사이의 bridge adapter, 임시 `toTanStackTool`
- 옛 Goal용 v1 host, 옛 TanStack 코드를 고정한 package, 릴리즈 artifact 계약 테스트
- 도구 하나 단위의 복구. 복구 단위는 Goal의 bound run이다(decisions.md 2026-10-26).
- 저장 메시지 구조를 `Prompt`로 바꾸는 데이터 변환. migration은 TanStack 메타데이터만 지운다.
- BTW 선행 시험
- 결과를 기다리지 않는 도구(셸 등). 전환과 따로 한다("도구 실행 방식").

## 위험

- 7단계 전환 커밋이 크다. backend, client, migration이 한 커밋에 들어간다. 안전망은 golden DB, 로컬 DB 검사 도구, browser test다.
- migration은 되돌릴 수 없다. 1단계 검사 도구로 로컬 DB 사본에서 먼저 확인한다.
- Effect AI는 unstable이다. effect와 provider 패키지를 같은 커밋에 묶는다. effect를 올릴 때는 provider 계약 테스트를 함께 확인한다.
- 승인 묶음과 interrupt 의미를 앱이 직접 지켜야 한다. 필요한 검증은 아래의 "보안 체크리스트" 절이다.
- 한 턴의 호출은 순서 없이 동시에 돈다. 모델이 앞 호출에 기대는 호출을 한 턴에 내면, 읽기가 쓰기 전 상태를 읽거나 셸·MCP 쓰기가 겹친다. 시스템 프롬프트로 알리고, 파일 쓰기는 sha256 검사가 막는다. 쓰기를 finish 뒤에 시작하는 규칙이 틀리면 실패한 턴의 부작용이 남는다. 규칙은 "도구 실행 방식"에 있고, 4단계 테스트로 고정한다.
- Goal의 코드 고정과 loop의 프로세스 격리를 잃는다. 업그레이드한 코드가 옛 Goal의 다음 run을 돈다.
- 겹치는 도구 뒤 hook이 run 상태를 같이 바꾸면 기록이 어긋난다. 4단계에서 21개 middleware를 본다.

## 보안 체크리스트 (전환 시 앱이 떠안는 검증)

전환할 때 앱 코드가 지켜야 하는 검증이다. 위험 절의 "승인 묶음과 interrupt 의미를 앱이 직접 지켜야 한다"의 구체 목록이다. 두 종류가 섞여 있다.

- TanStack이 지금 대신 하는 검증: interrupt 응답 검사, `ask` 모드 내장 도구의 승인, 승인 대기 중 실행 순서. Effect에는 같은 기능이 없거나 동작이 달라서 앱이 새로 만든다.
- 이미 앱 코드에 있는 검증: 나머지 항목. loop, persistence, Goal 실행, MCP client를 다시 쓰면서 빠뜨리기 쉬운 것들이다.

심볼 위치는 2026-10-25 작업 트리 기준이고, 경로는 `packages/memory-agent/src/` 아래다. 검토할 때 각 파일에서 다시 확인한다. Effect 동작은 설치된 `effect` `844a77b`의 `src/ai/` 소스로 확인했다(2026-10-26).

### 승인과 권한 게이트

- interrupt 응답 검증. 지금은 SDK가 응답 스키마와 승인 인자를 도구 실행 전에 검사한다(`agent/chat.ts`의 resume 처리 주석). Effect 승인 응답은 `approved`와 `reason`뿐이라 이 검사에 해당하는 기능이 없다. 새 루프는 `chat_interrupts.response`를 payload의 `responseSchema`와 1단계의 interrupt 응답 Schema로 실행 직전에 검사한다. 이 검사가 없으면 변조된 응답이 곧 도구 승인이다.
- Effect approval part 금지. `disableToolCallResolution: true`여도 prompt에 승인된 `tool-approval-request`·`tool-approval-response` 쌍이 있고 결과가 없으면, Effect가 모델 호출 전에 `toolkit.handle`로 그 도구를 실행한다(`effect/ai/LanguageModel.ts`의 `collectToolApprovals`, `executeApprovedToolCalls`). 이 실행은 게이트, repeatGuard, 승인 묶음 규칙을 거치지 않는다. 저장 메시지를 `Prompt`로 바꿀 때 approval part를 만들지 않는다.
- `ask` 모드 내장 도구 승인. 지금은 TanStack 자체 승인에 맡기고, 게이트는 MCP·delegation 호출만 묻는다(`agent/chat.ts`의 `askEveryCall` 앞 주석). 새 loop가 `tool.needsApproval`을 직접 평가한다. 평가가 실패하면 승인을 요구한다. Effect 내부 판정(`isApprovalNeeded`)은 실패하면 승인 불필요로 처리하므로 따라 하지 않는다.
- needsApproval 차단. 지금 Goal worker에서는 owner가 승인 없는 실행을 거절한다(`agent/full-loop-execution.ts`의 `toolAuthorize`와 `resumedApproval`, `agent/full-loop-worker.ts`의 owner-tool-grant). worker를 없애도 같은 검사를 새 loop의 실행 직전에 둔다. 승인이 필요한 호출은 이 run이나 parent run의 승인 응답이 있어야 시작한다.
- 승인 대기 중 실행 순서. 지금의 interrupt는 step 전체를 멈추고, 묶음에 ask가 하나라도 있으면 묶음 전체를 한 번에 묻는다(decisions.md "권한 모드 (2026-09-14)", 근거는 TanStack 재개 단위). 새 loop는 승인 요청을 한 묶음으로 묻되, 승인이 필요 없는 호출은 먼저 실행한다("도구 실행 방식"). 승인을 기다리는 호출은 승인 전에 실행하지 않는다. 재개 run은 결과가 기록되지 않은 호출만 실행한다. 이미 실행한 호출을 다시 실행하면 쓰기가 두 번 일어난다.
- 쓰기 호출은 완전한 finish 뒤에만 시작한다. finish 전에 시작하면 provider 실패로 run이 실패해도 부작용이 남고, 실패한 턴은 history에서 빠져 모델이 그 쓰기를 모른다.
- 게이트 순서. 지금 순서는 chatState → delivery → projectInstructions → repeatGuard → 게이트다(`agent/chat.ts`의 middleware 조립). repeatGuard가 게이트 앞이라 거절된 반복은 검토·사용자 질의가 없고, 게이트가 도구 실행 전이라 거절 호출은 실행되지 않는다. middleware를 typed hook으로 바꿀 때 이 순서를 명세로 남긴다.
- permission-review payload의 `askedBy`("review"/"every_call")를 앱 쪽 interrupt에 유지한다. 빠지면 MCP `ask` 모드의 "호출마다 묻는" 구분이 감사 기록에서 사라진다.

### lazy tool 대체

- `toolCallValidation: "deferred"`는 지금 없는 허용면이다. 미등록 도구 이름이 앱 핸들러까지 도달하므로, 미등록 이름은 discovery 요청으로만 해석하고 등록된 도구 이름으로 우회 매핑하지 않는다.
- 인자가 스키마에 맞지 않으면 지금처럼 모델에 답으로 돌리고 실행으로 넘기지 않는다(`agent/full-loop-execution.ts`의 `answerInvalid`). `failureMode: "return"` 도구는 `Toolkit.handle`이 decode 실패를 결과로 돌려준다. JSON Schema로 만든 MCP `Tool.dynamic`은 검증하지 않으므로 앱이 검사한다.

### Goal 실행 (5단계)

worker를 없애면 owner와 worker 사이의 검사(`agent/full-loop-execution.ts`의 `authorizeRequest`: 관찰된 tool call만 실행, hook 허용 목록, context snapshot 동일성, 미등록 interrupt 거절)는 대상이 사라진다. loop가 owner 안에서 모델 stream을 직접 읽기 때문이다. 남는 검증은 이것이다.

- 장부는 외부 부작용 재생 방지다: `side_effect`·`status`·`fingerprint`, `workflow/run-bindings.ts`의 `previous`·`unresolved` 검사(`run_outcome_uncertain`), `workflow/uncertain-runs.ts`의 확인, `agent/owner-read-recovery.ts`의 receipt SQL. 새 장부 행이 이 SQL에서 지금 도구 행과 같은 뜻이어야 한다.
- 장부 예약은 실행 전이다. 예약하지 못한 호출은 실행하지 않는다. 장부에 없는 도구는 실행되지 않았다는 규칙이 재시작 뒤 자동 이어가기의 근거다(decisions.md 2026-10-13).
- 미리 시작하는 실행의 권한 확인. 지금 owner는 `parallelReads`가 미리 시작할 읽기의 권한 사슬을 시작 전에 모두 평가한다(`agent/full-loop-execution.ts`의 `toolAuthorize`). 새 scheduler는 호출마다 자기 권한 사슬을 통과한 뒤에만 시작한다("도구 실행 방식").

### interrupt 재개 handshake

- 모양(새 runId, `parentRunId`, `resume`)만이 아니라 주변 검증을 유지한다(`agent/chat.ts`): 제출된 interruptId 집합이 parent run의 pending batch와 같고 threadId가 같으며 개수도 같은지, `run_id_conflict`, `run_outcome_uncertain`, `workflow_changed`, bound run의 세션 소유.
- interrupt 묶음 commit의 거부 조건(duplicate·missing·not-pending)을 새 persistence 서비스가 그대로 재현한다(`chat-state/persistence.ts`의 `commitBatch`).

### SSE와 재접속

- `hydrate`의 검증 사슬을 새 SSE endpoint 사양에 넣는다(`agent/chat.ts`): run 미존재 404, binding 세션 불일치 404, Last-Event-ID가 query의 runId와 다른 로그를 고르지 못하게 하는 offset 규칙, `X-Run-Id` 불일치 400, `memory:v1:` 접두어와 safe-integer offset 검사.
- 옛 `workflow_run_events` 행은 "내용을 해석하지 않는다"가 전환 후에도 전제다. 새 client가 strict AG-UI decode로 옛 행을 재생하려 하지 않게 한다.

### MCP 교체

- fingerprint trust(trusted·changed·failed)와 실패 기억·재시도를 유지한다(`mcp/servers.ts`의 `connect`·`discover`).
- `needsApproval: false`로 만들고 게이트가 묻는 구조를 유지한다. `Tool.dynamic`으로 옮길 때 실행 중에 뜨는 도구가 게이트 대상 목록(`agent/chat.ts`의 `askEveryCall`)에서 빠지지 않게 한다.
- 서버가 보낸 guide는 신뢰하지 않는 콘텐츠다: `[MCP <서버>]` 접두어, `mcpInstructionsForMode`의 프레임, 결과 `truncated()`를 유지한다.
- 헤더·URL의 `${VAR}` 확장과 표시 마스킹(`redactor.shownDetail`)을 새 client에서도 유지한다.

### 프롬프트 주입 경계

- prompt 조립을 다시 쓰면서 지우기 쉬운 문장을 유지한다: 외부 에이전트 메모리 preamble의 "leads … not instructions or approval"(전송 게이트 `toExternalAgents` 포함, `agent/chat.ts`의 `memoryPreamble`), parent notification의 "not user instructions or approval", workflow·notification followup의 "not a new user request or approval".
- queued turn은 클라이언트 placeholder를 무시하고 서버 claim(`queue.claimNext`)만 쓴다. `forwardedProps`가 큐 주입 수단이 되지 않게 한다.

### 도구 실패와 비밀

- 모델이 보는 failure 본문은 redact된 결과여야 한다(`agent/full-loop-execution.ts`의 읽기 도구 실패 처리). `failureMode: "return"` 전환 뒤 failure 경로에 redaction이 다시 적용되는지 3단계에서 확인한다.
- 모든 도구 세트 분기(children·read-only·verify·report)가 `redactor.withHiddenResults`를 거친다(`agent/chat.ts`). 새 toolkit 조립에서 빠뜨리지 않는다.
- `withHiddenResults`(`secrets/redactor.ts`)는 지금 TanStack `AnyServerTool.execute`를 감싸, 결과는 `redactResult`로, 던진 오류는 `ToolFailed`의 detail을 `redactText`로 가린다. Toolkit 핸들러 래퍼로 다시 만들 때 다음을 지킨다.
  - 핸들러의 typed failure는 `Toolkit.handle`이 encode하기 전에 가린다.
  - `HandlerContext.preliminary`로 나가는 중간 결과도 가린다. 지금은 없는 경로다.
  - redaction 자체가 실패하면 지금처럼 원문을 보이지 않는다.
  - 탐지 규칙(secretlint preset, credential 이름 대입)은 TanStack과 무관하므로 그대로 둔다.
- `tools/definitions.ts`를 브라우저가 import한다. 번들 그래프에서 permission·secret 내부가 client 번들로 새지 않는지 3단계에서 확인한다.
- 3단계에서 확인했다(2026-10-27, 3단계 "완료 기준 확인"). 도구 세트 분기마다 감싸는 것은 loop를 만드는 4단계에서 확인한다.

### 데이터와 절차

- golden DB와 `tools/`의 로컬 DB 검사 도구는 개인 데이터를 다룬다. 행 내용을 stdout에 대량 출력하지 않고, 사본 파일은 저장소 밖에 둔다. "테스트로 커밋하지 않는다"를 도구 동작으로도 지킨다.
- migration이 쓰는 새 저장 Schema가 history projection의 검증(user·assistant·tool 외 role을 `invalid-transcript`로 거절, `chat-state/history-projection-native.ts`의 `prepared`)과 호환해야 세션이 읽힌다. `publishIfCurrent`의 `messages = ?` 동등 비교(오래된 snapshot 부활 방지)가 새 직렬화 기준으로 다시 성립하는지 1단계에서 확인한다. 확인했다(2026-10-26, 1단계 "결과").
- golden 비교는 정상 경로 동등성이라 보안 회귀를 잡지 못한다. 0단계 시나리오에 부정 케이스를 더한다: 승인 없는 needsApproval 실행 시도, 타 세션 resumeRunId, 미등록 interrupt 응답, deferred로 온 미등록 도구 호출, binding 불일치 재접속. 지금 코드의 거절 응답을 golden으로 고정해 7단계 전환이 이 검증을 회귀 테스트로 상속하게 한다.

## 대체 결정이 필요한 decisions.md 항목

TanStack을 전제로 쓴 항목들이다. 구현할 때 새 항목으로 대체 결정을 남긴다. "도구 실행 방식"은 권한 모드의 승인 묶음, 서브에이전트의 동시 시작, 도구 성능의 `parallelReads` 규칙을 바꾼다.

- 범위와 구조 (2026-09-15)
- 하네스 어댑터 조사 범위 (2026-09-30)
- 공식 Effect 서비스와 DB Migrator의 적용 (2026-10-11)
- 의존성 상향 (2026-10-17)
- 인증과 모델 (2026-09-15)
- Anthropic 구독 모델 카탈로그 (2026-09-21)
- OpenAI 호환 self-hosted 모델 연결 (2026-10-03)
- 모델 전환 시 근거 기반 인계 (2026-10-05)
- 대화 상태 (2026-09-14)
- 실행 재연결, 취소, 재시작 (2026-09-14)
- 대기열, 스티어링 (2026-09-14)
- 긴 대화 줄이기 (2026-09-17)
- 채팅 기록 표시 (2026-09-24)
- 빈 사용자 텍스트의 재유입 방지 (2026-10-05)
- Work Trace 실행 경계 (2026-09-20)
- Build-time native and Goal-worker artifacts (2026-10-10)
- 로컬 도구 (2026-09-14)
- 권한 모드 (2026-09-14)
- 이미지 첨부 (2026-09-14)
- MCP 서버 (2026-09-15)
- 서브에이전트 (2026-09-15)
- 도구 성능 (2026-09-15)
- `run_shell`을 셸 스킬로 바꿈 (2026-10-14)
- 로컬 API와 이벤트 연결 (2026-09-24)
- 테스트의 고정 대기 줄이기 (2026-09-29)
- 취소 재전송과 비동기 테스트 대기 (2026-09-30)
- 원문 오류 표시와 백그라운드 루프 실패 정책 (2026-10-18)
- compatible 어댑터의 run id와 bound run 전달 실패 (2026-10-21)
- 시스템 프롬프트와 도구 설명은 규칙을 한 곳에만 둔다 (2026-10-24)

Goal worker를 전제로 쓴 항목들이다. 5단계를 구현할 때 "Goal도 owner 프로세스에서 돌고 도구를 병렬로 실행한다 (2026-10-26)"로 대체한다고 적는다.

- 개발 빌더와 full-loop worker 소스 (2026-10-03)
- Configurable dev and Goal settlement boundaries (2026-10-10)의 worker 세대·worker 승인 부분
- Effect execution admission and safe observability (2026-10-10)의 worker gate
- Build-time native and Goal-worker artifacts (2026-10-10)
- Goal full-loop transport: Effect Worker/RPC protocol boundary (2026-10-10)
- Owner RPC fingerprint의 bounded evidence와 해시 비교 (2026-10-11)
- 검증된 background 읽기 실패의 명시적 복구 (2026-10-11)
- 최소 읽기 복구와 DB 단일 기준 (2026-10-11)의 읽기 복구 부분
- Provider 요청 전 transport 실패의 durable 재시도 경계 (2026-10-13)의 "owner의 모델 스트림 pull" 구현 부분
- TanStack 패키지를 1.0으로 올림 (2026-10-24)의 Goal worker 경계 부분

## 확인하지 않은 것

- provider 패키지는 받아서 소스만 읽었다. 설치, 타입 검사, 실행은 하지 않았다.
  - `@effect/ai-openai-compat`은 2026-10-26에 소스로 확인했다. `toolCallValidation: "deferred"`면 등록되지 않은 tool call을 그대로 돌려주고, JSON Schema dynamic tool의 인자는 검증 없이 넘긴다(`OpenAiLanguageModel.ts`의 `transformToolCallParams`). reasoning은 `reasoningField`(기본 `reasoning_content`)로 다시 보낸다. streaming에서는 `tool-call` part를 `[DONE]`에서 한꺼번에 내보내고, 인자 JSON이 읽히지 않으면 `"deferred"`여도 stream이 실패한다(`makeStreamResponse`).
- 2026-10-26에 설치된 `effect` `844a77b`로 실행해 확인한 것(저장소 밖 임시 스크립트):
  - `disableToolCallResolution: true`여도 prompt의 승인된 approval 쌍은 모델 호출 전에 핸들러가 실행된다.
  - `needsApproval` 함수가 실패하면 자동 해석에서 승인 없이 실행된다.
  - `failureMode: "return"`에서 인자 decode 실패는 `AiError`(`ToolParameterValidationError`) 모양으로, 핸들러 typed failure는 `failure` schema 모양으로 encode된다.
  - JSON Schema로 만든 `Tool.dynamic`은 맞지 않는 인자도 그대로 핸들러에 넘긴다.
  - `disableToolCallResolution: true`의 strict 모드에서는 인자가 틀린 tool call이나 등록되지 않은 이름 하나로 `generateText`·`streamText`가 `AiError`로 실패한다. `"deferred"`면 둘 다 tool call로 돌아온다. 자동 해석 모드는 틀린 인자를 실패 결과로 돌려주지만, 등록되지 않은 이름에는 실패한다.
  - 자동 해석 모드에서 finish reason이 `length`면 핸들러를 시작하지 않고 실패 결과를 만든다. 해석을 끄면 tool call과 finish만 돌려준다.
- 2026-10-26에 함께 확인한 것: `@effect/ai-anthropic` 4.0.3의 adaptive thinking schema는 `{ type: "adaptive" }`뿐이다. AG-UI PR #9842(`cafa88b`)·#9852·#9853(`ddcf3f7`)은 모두 open이고, 9842 ← 9852 ← 9853으로 쌓여 있다. #9853에는 승인을 interrupt로 바꾸는 코드가 없다. `@ag-ui/core` 1.0.0의 `Interrupt` 필드는 `id`, `reason`, `message`, `toolCallId`, `responseSchema`, `expiresAt`, `metadata`, `subagentRunId`이고, `RUN_FINISHED.usage`는 배열이다.
- `TokenUsage`의 모든 필드를 Effect `Usage`에서 채울 수 있는지. TanStack 1.0 타입에는 `cacheWrite1hTokens`, `cost`, `billed`, `providerUsageDetails`처럼 Effect `Usage`에 없는 필드가 있다. 다만 로컬 DB에 저장된 키는 "usage 모양"의 것뿐이다.
- `@effect/atom-react`는 받아서 export만 봤다. 설치와 실행은 하지 않았다.
  - 2026-10-26에 확인한 것: peer는 react `>=19.0.0 <20.0.0`, scheduler `>=0.25.0 <0.29.0`, effect `^4.0.3`이고, 설치된 react 19.3.1, scheduler 0.28.0과 맞는다. `HydrationBoundary`와 `useAtom` 계열 hook을 export한다. 6단계에 적은 `Atom.family`, `fn`, `Interrupt`, `pull`, `optimistic`, `optimisticFn`, `withReactivity`, `refresh`, `serializable`은 설치된 `effect/reactivity`의 `Atom`에 모두 있다.
- 공식 `@ag-ui/client`. 설치되어 있지 않고(`@ag-ui/core` 1.0.0만 간접 의존성으로 있다), 소스도 보지 않았다.
- (확인함, 2026-10-26) `toolCallMetadata`와 tool call `metadata`(`model`, `index`)를 지워도 provider 요청이 같은지. 같다. 2단계 "결과"의 로컬 DB 사본 비교다.
- 21개 middleware가 겹치는 도구 뒤 hook을 견디는지. TanStack 1.0 일반 채팅에서 이미 겹치지만 따로 보지 않았다.

## 열린 항목

- (닫힘, 2026-10-27) 호출 사이의 순서. 순서를 두지 않는다(decisions.md "도구 호출 사이에 순서를 두지 않는다 (2026-10-27)"). 검토한 안은 아래 셋이었다.
  - 쓰기를 앞뒤 호출 모두와 순서를 지키는 장벽으로 둔다. "도구 실행 방식"의 지금 규칙이고, decisions.md "도구 성능 (2026-09-15)"과 같다.
  - 쓰기를 도구가 정한 자원 키로 같은 자원끼리만 줄 세운다(`packages/memory-agent/src/concurrency/keyed-limit.ts`의 `keyedSerialLimit`). 키가 없는 쓰기는 장벽으로 둔다. 쓰기 뒤의 읽기가 같은 자원을 읽으면 쓰기를 기다려야 하므로, 읽기 도구에도 키가 필요하다.
  - 순서를 두지 않는다. 한 턴의 호출은 서로 독립이라고 보고 모두 동시에 돌린다. 순서가 필요하면 모델이 다음 턴으로 나눈다. 지금 TanStack 1.0의 동작이다. 사용자가 이 안으로 정했다(2026-10-27).
    - 같은 파일 쓰기의 충돌은 쓰기 도구의 기대 sha256 검사가 하나를 실패시킨다(decisions.md "잘못된 성공 거르기 (2026-10-14)"). 셸·코드 실행·MCP는 이런 검사가 없다.
    - 모델이 순서를 기대하지 않도록 도구 설명이나 시스템 프롬프트에 한 턴의 호출은 동시에 돈다고 알린다.
- (닫힘, 2026-10-26) 5단계를 전환 전에 TanStack 위에서 먼저 할지. 사용자가 전환을 바로 시작하기로 했다. Goal은 5단계에서 옮긴다.
- (닫힘, 2026-10-26) 옛 Goal 세션을 읽기 전용으로 둘지. Goal worker를 없애므로 옛 Goal 세션도 이어서 진행한다.
- 결과를 기다리지 않는 도구로 바꿀 대상(셸 등). 전환과 따로 정한다.
- (닫힘, 2026-10-26) `source`·`finishReason`·`stopReason`을 우리 필드로 옮길지, 아니면 history 변환 규칙을 바꿀지. 메시지 필드로 옮기고 변환 규칙은 그대로 둔다.
- (닫힘, 2026-10-26) `chat_runs.usage`의 새 모양. AG-UI 1.0 `TokenUsage` 하나로 저장한다. 1단계 "결과"에 대응표가 있다.
