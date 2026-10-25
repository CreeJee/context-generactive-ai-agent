# TanStack AI에서 Effect AI로 전환 계획 (2026-10-25)

상태: 계획(구현 전). 방향은 2026-10-25 대화에서 정했고 [decisions.md](decisions.md)에는 아직 올리지 않았다. 배경 논의: 세션 `0c379bba`(2026-10-25). 코드 위치는 `fe9a74ef` 기준이다.

## 목표

TanStack AI 패키지를 모두 뺀다. 모델 호출, 도구, agent loop, 채팅 전송은 Effect AI(`effect/ai`)와 직접 만든 코드로 옮긴다. 기존 채팅은 지금처럼 열리고 이어서 대화할 수 있어야 한다.

## 정한 방향 (2026-10-25)

- TanStack 패키지 9개와 pnpm patch 2개(`@tanstack__ai@0.61.0`, `@tanstack__openai-base@0.11.1`)를 모두 뺀다.
- provider 패키지는 `@effect/ai-openai-compat` 하나만 쓴다. 구독 Anthropic·ChatGPT, external ACP, scripted provider는 `LanguageModel.make`로 직접 만든다.
- 점진적 전환은 하지 않는다.
  - TanStack과 Effect를 잇는 bridge를 두지 않는다.
  - 옛 Goal용 host와 새 host를 함께 돌리지 않는다.
  - 새 모듈을 모두 만든 뒤 한 릴리즈 안에서 한 번에 바꾼다.
- 옛 Goal의 worker·native artifact 호환은 하지 않는다.
  - 업그레이드는 바이너리 재시작이다. 재시작하면 실행 중이거나 승인을 기다리던 run은 이미 실패로 끝난다(`packages/memory-agent/src/chat-state/chat-state.ts`의 재시작 처리).
  - Goal 사용량도 많지 않다.
- DB의 테이블·열은 바꾸지 않는다. JSON 열 안의 TanStack 메타데이터는 migration 하나로 지우고, 쓰는 값만 우리 필드로 옮긴다("DB 저장 형식과 migration" 참고).
  - 조건: 기존 채팅이 지금처럼 열리고, 이어서 대화할 수 있어야 한다.
- API payload는 새 client에 맞춰 바꿔도 된다. chunk는 AG-UI 1.0 표준 모양으로만 쓰고, TanStack 확장 필드는 넣지 않는다.
- client는 `useChat` 대신 AG-UI 이벤트를 읽는 자체 hook을 `@effect/atom-react`로 만든다.
- Effect의 AG-UI 지원(#9842, #9852, #9853)은 merge 전이라 기대지 않는다. merge되면 다시 본다("Effect의 AG-UI 지원" 참고).

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
- 지금 쓰는 TanStack 패키지와 버전:
  - `@tanstack/ai` 0.61.0(patch), `ai-client` 0.35.1, `ai-react` 0.29.1, `ai-persistence` 0.6.7
  - `ai-openai` 0.24.1, `ai-anthropic` 0.19.1, `ai-mcp` 0.4.6, `ai-compaction` 0.1.17
  - `openai-base` 0.11.1(patch)

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
- 직접 만든 adapter(구독, external ACP, compatible 후처리, scripted)는 `LanguageModel.make({ generateText, streamText })`로 옮긴다.
- `chat({ outputSchema })` 단발 호출 5곳은 `generateObject`나 `streamText`로 옮긴다.
  - 대상: `permissions/classifier.ts`, `report/diagnosis.ts`, `memory/interpret.ts`, `improve/interpret.ts`, `agent/turn-summaries.ts`
- MCP 도구는 `Tool.dynamic`에 JSON Schema를 그대로 넘긴다.

### 옮기면 나아지는 것

- 한 step의 도구를 동시에 실행한다(`concurrency` 기본값 `"unbounded"`).
  - 서브에이전트를 첫 호출 직전에 모두 시작하던 우회를 지울 수 있다(decisions.md "서브에이전트 (2026-09-15)").
  - parallel-reads 우회도 지울 수 있다.
- 도구 진행 결과를 `HandlerContext.preliminary`로 보낼 수 있다.
- span, GenAI telemetry, 타입이 있는 `AiError` reason을 얻는다.
- Promise↔Effect 경계가 줄어든다. src에 경계 주석이 171개, `nativePromise`가 122개, `runNativeEffect`가 66개 있다. 상당수가 TanStack 콜백 때문이다.

### 의미가 달라 따로 맞출 것

- **승인 묶음.**
  - 지금 규칙은 "한 번에 여러 호출 중 하나라도 `ask`면 묶음 전체를 한 번에 묻는다"이다(decisions.md "권한 모드 (2026-09-14)").
  - Effect는 자동 도구 해석에서 같은 step의 승인 불필요 도구를 바로 실행한다.
  - 그래서 `disableToolCallResolution: true`로 자동 해석을 끄고, 앱이 `toolkit.handle`을 직접 부른다.
- **permission-review payload.** reason, askedBy 등을 담을 자리가 Effect approval part에 없다. 저장은 지금 interrupt 기록 모양으로 하므로, 앱 쪽 interrupt로 다룬다.
- **lazy tool(`DISCOVERY_TOOL_NAME`).** 같은 기능이 없다. step마다 toolkit을 바꾸고, `toolCallValidation: "deferred"`로 등록되지 않은 호출을 받아 직접 처리한다.
- **메시지 구조.** `ModelMessage`와 `Prompt`는 구조가 다르다.
  - `Prompt`에서는 system prompt가 history 안의 메시지다.
  - tool-result에 `name`이 필수다.
  - 메시지에 `id`·`createdAt`이 없다.
  - 그래서 저장은 지금 메시지 구조를 우리 Schema로 두고, model을 부르기 직전에만 `Prompt`로 바꾼다.
  - 저장된 tool 메시지에는 `name`이 없다. 같은 `toolCallId`의 assistant tool call에서 찾는다.
- **usage 이름.** `TokenUsage`는 promptTokens 계열이고 Effect `Usage`는 inputTokens 계열이다. 저장된 `chat_runs.usage`는 migration에서 새 이름으로 바꾼다.

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

## DB 저장 형식과 migration

테이블과 열은 그대로 둔다. JSON 안의 TanStack 메타데이터는 migration 하나로 지운다. 로컬 DB에 있는 TanStack 메타데이터(2026-10-25 확인):

- 메시지의 `metadata.tanstack`(9,589개): `createdAt`, `model`, `toolCallMetadata`, 드물게 `source`·`finishReason`·`run`
- tool call의 `metadata.tanstack`(3,099개): `model`·`index`, 또는 `source`

migration이 하는 일:

- `metadata.tanstack.createdAt`은 메시지에 `createdAt`이 없을 때 그 자리로 옮긴다.
- `metadata.tanstack.model`은 우리 `model` 필드로 옮긴다. model handoff가 이전 model을 찾을 때 이 값을 읽는다(`packages/memory-agent/src/agent/model-handoff.ts`의 `StoredModel`).
- 나머지 TanStack 메타데이터를 지우고, 비게 된 `metadata`도 지운다.
- `chat_runs.usage`를 새 usage 이름으로 바꾼다.
- `memory-agent/model-handoff` 상태의 `anchor`를 다시 계산한다.
  - fingerprint는 메시지 전체의 해시라, 메타데이터를 지우면 값이 바뀐다.
  - 다시 계산하지 않으면 그 세션의 handoff가 `HistoryChanged`로 실패한다.
- `chat_threads.messages`를 바꾸면 trigger가 history projection을 stale로 만든다. `chat_history_groups`도 같은 규칙으로 고쳐 ready로 되돌릴지, 다시 만들게 둘지 1단계에서 정한다.

migration은 7단계 전환 커밋에서 등록한다. 지금 코드는 `metadata.tanstack.model`을 읽으므로, 그 전에 돌리면 안 된다.

테이블별 모양:

- `chat_threads.messages`
  - 지금은 TanStack `ModelMessage[]`다. migration 뒤에는 같은 구조(`role`, `content`, `toolCalls`, `toolCallId`, `thinking`, `id`, `createdAt`, `error`)를 우리 Schema로 쓴다. subagent thread(`subagent-<id>`)도 같다.
  - 읽는 곳: history projection의 검증(role, id), migration의 `json_each`, model handoff, compaction
- `chat_history_projection`: 화면 메시지 id별 `ModelMessage` 묶음이다. `format_version`은 1이다.
- `chat_runs`
  - status 5종: `running`, `interrupted`, `completed`, `failed`, `aborted`
  - `error`, `error_code`
  - `usage`: 지금은 TanStack `TokenUsage`다. migration에서 새 usage 이름으로 바꾼다. chunk마다 누적한다.
- `chat_interrupts`
  - `payload`: `RUN_FINISHED` chunk의 `outcome.interrupts` 항목을 얕게 복사한 객체다(`@tanstack/ai-persistence`의 `interruptPayload`). 키는 모두 AG-UI 1.0 `Interrupt`의 필드다.
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
  - TanStack 소유는 아니지만, worker RPC 규칙이 SQL에 들어 있다.
  - 쓰기 tool의 권한 확인은 `operation_id - 1`, 실행은 `operation_id` 번호에 기록된다.
  - SQL은 `side_effect`, `status`, `fingerprint`를 본다(`packages/memory-agent/src/agent/owner-read-recovery.ts`의 `recoveredReadRunSql`, `packages/memory-agent/src/workflow/completion-evidence.ts`).
  - worker 프로토콜을 다시 정의해도 이 규칙은 지킨다.
- **hook이 채우는 테이블**
  - 대상: `nodes`(`tool_result` 노드의 `detail.ok`와 `text`), `subagents`, work trace
  - TanStack hook 정보에서 값을 만들므로 같은 행이 나와야 한다.
- **Goal 테이블**(`workflow_goal_native_artifacts`, `workflow_goal_worker_generations`): 스키마는 그대로다. 새 row에 새 contract 값과 새 worker hash만 들어간다.

## 옛 Goal 처리

- **거절.** 새 native artifact의 `nativeFactoryLoaderContract`(`packages/memory-agent/src/agent/native-artifact-loader.ts`)를 바꾼다.
  - 옛 등록은 `Registration`의 `Schema.Literal` decode에서 거절된다(`packages/memory-agent/src/agent/owner-native-artifacts.ts`).
  - 응답은 이미 있는 409 `goal_native_generation_unavailable`이다(`packages/memory-agent/src/agent/chat.ts`).
  - legacy artifact fallback을 두지 않는다는 결정(decisions.md "Build-time native and Goal-worker artifacts (2026-10-10)")과도 맞다.
- **세션은 읽기 전용이 된다.** 옛 Goal이 있던 세션은 새 run을 시작할 수 없다.
  - Goal 세션의 새 run은 모두 worker 경로로 간다(`chat.ts`의 `workerRevision` 선택).
  - Goal을 멈춰도 Goal identity가 새 revision에 남는다(`packages/memory-agent/src/workflow/workflow.ts`의 `save`).
  - 새 Goal은 run 안의 새 Goal 도구로만 만든다(`packages/memory-agent/src/workflow/tools.ts`).
  - 그래서 사용자는 새 세션에서 시작한다.
- **자동 진행 문구.** 재시작 때 자동 진행 중이던 Goal은 `external_dependency` blocker로 멈춘다. 지금 문구는 로그인 확인 안내라, 이 경우에 맞는 문구로 고친다(`chat.ts`의 자동 진행 `blockPending`).
- **packaging과 build.**
  - packaging은 artifact용으로 `@tanstack/ai`를 runtime root에 복사하던 일을 그만둔다(`apps/agent/scripts/package.ts`).
  - build의 `neverBundle`에서 `@tanstack/ai`를 뺀다(`packages/memory-agent/scripts/build-runtime-artifacts.ts`).

## 단계

새 모듈은 7단계 전까지 앱에 연결하지 않는다. 단계마다 커밋하고, 각 커밋은 빌드된다. 릴리즈는 하나다.

### 0. 기준 고정

- 지금 runtime과 scripted provider로 시나리오를 돌리고, 나온 DB 행을 golden으로 저장한다. id와 시각은 정규화한다.
- 시나리오:
  - 일반 답변
  - 읽기·쓰기 tool
  - 승인 interrupt(승인·거절), permission-review
  - 취소, provider 실패
  - reasoning: Anthropic thinking 서명, OpenAI `openai-reasoning:` 접두어
  - named subagent, compaction, model handoff
  - Goal worker run(tool과 승인)
  - queue와 steer
- 비교 대상은 "DB 저장 형식과 migration"의 테이블 전부다. 비교할 때 TanStack 메타데이터는 뺀다.
- 완료 기준: 지금 코드에서 통과한다. 타입으로 확인할 수 없는 경계라 테스트로 둔다.

### 1. 저장 Schema와 migration

- Effect Schema로 정의할 것: 메시지(TanStack 메타데이터 없음, `model` 필드 추가), usage, interrupt payload, AG-UI 1.0 chunk, history group
  - `AgUiSchema`가 merge되면 chunk Schema는 그것으로 바꾼다.
- "DB 저장 형식과 migration"의 migration을 만든다. 7단계 전까지 앱의 migration 목록에는 넣지 않는다.
- `tools/`에 로컬 DB 사본을 검사하는 도구를 둔다.
  - `~/.context-generactive-agent/agent.db`를 복사하고 migration을 돌린다.
  - 모든 행이 새 Schema로 decode되는지 본다.
  - 메시지마다 내용(text, tool call, tool result, thinking과 서명, 이미지)과 `createdAt`, `model`이 원본과 같은지 비교한다.
  - 개인 데이터를 쓰므로 테스트로 커밋하지 않는다.
- 완료 기준: golden과 로컬 DB 사본에서 차이가 없다.

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

### 3. tool

- 45곳을 `Tool.make`와 `Toolkit`으로 옮긴다. 실패는 `failureMode: "return"`, 승인은 `needsApproval`로 표현한다.
- lazy discovery는 step별 toolkit과 `toolCallValidation: "deferred"`로 만든다.
- MCP는 `@modelcontextprotocol/sdk` Client와 `Tool.dynamic`으로 옮긴다.
- `tools/definitions.ts`는 브라우저도 import한다. bundle 영향을 확인한다.

### 4. loop, hook, persistence

- step 순서:
  1. history를 준비한다. onConfig를 대신한다.
  2. `streamText`를 `disableToolCallResolution: true`로 부른다.
  3. 앱이 도구를 해석한다: permission gate, repeat guard, 승인 묶음, 동시 `handle`, 기록.
  4. usage를 읽는다.
  5. 다음 step 여부를 정한다.
- middleware 21개는 순서가 정해진 typed hook으로 바꾼다.
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
  - 0단계 golden과 같은 행이 나온다.
  - migration한 로컬 DB 사본의 모든 세션에서, history page의 화면 메시지가 지금 코드가 원본에서 만드는 것과 같다.

### 5. worker와 Goal

- worker 안의 loop를 4단계 loop로 바꾼다.
- RPC payload는 TanStack 타입 없이 Schema로 다시 정의한다. `owner_rpc_operations` 규칙은 유지한다.
- native artifact를 TanStack import 없이 빌드하고, loader contract 문자열을 바꾼다.
- "옛 Goal 처리"의 변경을 넣는다.

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
  - SSE를 읽고 1단계의 AG-UI chunk Schema로 decode한다.
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
     - 진입점: 본 채팅, BTW, 서브에이전트, Goal worker, ACP, MCP, 단발 호출
     - API payload가 바뀌어 기존 `useChat`으로는 확인할 수 없으므로, backend와 client를 함께 바꾼다.
  2. TanStack을 지운다: 패키지 9개, patch 2개, catalog·`minimumReleaseAgeExclude`·`patchedDependencies`의 TanStack 항목.
- 검사: golden, 로컬 DB 검사 도구, `vp check`, `vp run typecheck`, memory-agent `vp test --maxWorkers=4`, `vp run test:browser`
- decisions.md에 대체 결정을 남긴다. 대상은 아래 목록이다.

## 이번에 하지 않는 것

- TanStack과 Effect 사이의 bridge adapter, 임시 `toTanStackTool`
- 옛 Goal용 v1 host, 옛 TanStack 코드를 고정한 package, 릴리즈 artifact 계약 테스트
- 저장 메시지 구조를 `Prompt`로 바꾸는 데이터 변환. migration은 TanStack 메타데이터만 지운다.
- BTW 선행 시험

## 위험

- 7단계 전환 커밋이 크다. backend, client, migration이 한 커밋에 들어간다. 안전망은 golden DB, 로컬 DB 검사 도구, browser test다.
- migration은 되돌릴 수 없다. 1단계 검사 도구로 로컬 DB 사본에서 먼저 확인한다.
- Effect AI는 unstable이다. effect와 provider 패키지를 같은 커밋에 묶는다. effect를 올릴 때는 provider 계약 테스트를 함께 확인한다.
- 승인 묶음과 interrupt 의미를 앱이 직접 지켜야 한다.
- 옛 Goal 세션은 읽기 전용이 된다.

## 대체 결정이 필요한 decisions.md 항목

TanStack을 전제로 쓴 항목들이다. 구현할 때 새 항목으로 대체 결정을 남긴다.

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
- `run_shell`을 셸 스킬로 바꿈 (2026-10-14)
- 로컬 API와 이벤트 연결 (2026-09-24)
- 테스트의 고정 대기 줄이기 (2026-09-29)
- 취소 재전송과 비동기 테스트 대기 (2026-09-30)
- 원문 오류 표시와 백그라운드 루프 실패 정책 (2026-10-18)
- compatible 어댑터의 run id와 bound run 전달 실패 (2026-10-21)
- 시스템 프롬프트와 도구 설명은 규칙을 한 곳에만 둔다 (2026-10-24)

## 확인하지 않은 것

- provider 패키지는 받아서 소스만 읽었다. 설치, 타입 검사, 실행은 하지 않았다.
- `TokenUsage`의 모든 필드를 Effect `Usage`에서 채울 수 있는지.
- `@effect/atom-react`는 받아서 export만 봤다. 설치와 실행은 하지 않았다.
- 공식 `@ag-ui/client`. 설치되어 있지 않고(`@ag-ui/core` 1.0.0만 간접 의존성으로 있다), 소스도 보지 않았다.
- `toolCallMetadata`와 tool call `metadata`(`model`, `index`)를 지워도 provider 요청이 같은지. 2단계 완료 기준으로 확인한다.

## 열린 항목

- 옛 Goal 세션을 읽기 전용으로 둘지(기본), 아니면 일반 채팅만이라도 열어 줄지.
