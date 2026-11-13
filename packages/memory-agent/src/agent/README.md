# agent

## Overview

`packages/memory-agent/src/agent`는 memory-agent의 대화 에이전트 핵심 계층이다. `chat.ts`의 `AgentChat` 서비스는 프로바이더·도구·메모리·워크플로·칸반·큐 서비스를 묶어 세션 채팅을 실행한다. 이 서비스는 시스템 프롬프트(memory/workspace/attachment 지침)와 프롬프트 배치 규칙도 정의한다. 주변 파일은 실행 루프(`RunHook`)에 끼우는 훅이다. 이 훅들은 대화 압축(compaction, 턴 요약), 컨텍스트 사용량 기록, API 사용량 원장, 모델 handoff, steer 중단, 오류 표시 정리를 맡는다. `run-state.ts`는 세션 실행 API의 브라우저 안전 응답 타입을 앱(`apps/agent`)과 공유한다.

## Interface

- `AgentChat` — `chat.ts`의 `Context.Service`이며 `AgentChat.layer`를 제공한다(`RunCancellations.layer` 포함). 세션 채팅 실행의 중심 서비스다.
- `makeAgentChatImplementation` — `AgentChat`의 네이티브 구현 seam이다. 생성할 때마다 중앙 서비스를 새로 획득한다.
- `memoryInstructions` / `concurrentCallsInstructions` / `reportAnalysisInstructions` / `attachmentInstructions` — 메모리 사용, 동시 도구 호출, 이슈 리포트 분석 세션, 첨부 이미지 참조에 관한 표준 시스템 프롬프트 문자열이다.
- `workspaceInstructions` — `EffectFunction.dual`이다. `Project`·`SettingsPlaces`·선택 `now`로 프로젝트 루트, 날짜·타임존, 셸, permissionMode별 승인 규칙, 설정 폴더 안내 프롬프트를 만드는 Effect를 돌려준다.
- `AgentChat`의 앱 API 메서드 가운데 `queued`·`enqueue`·`editQueued`·`subagents`·`subagentTranscript`·`approvals`·`answerApproval`·`cancel`·`compact`·`discardInterrupts`·`continuePastUncertain`·`lease`·`status`·`archive`·`deleteSession`·`moveWorkflow`·`controlWorkflow`·`traceTree`·`traceTask`·`lifecycleTraceTask`·`requestTraceResume`·`traceStream`은 값을 돌려주고, 페이지가 읽는 거부를 `{ error }` 값으로 실패한다. 수명주기 요청이 막히면 `LifecycleResult`의 `blocked`, 재시도가 막히면 `ResumeRequest`의 `blocked` 값으로 실패한다. `traceStream`은 `TraceStreamEvent` Stream을 돌려준다. 서비스 소유자가 닫히면 끝나고, trace를 읽지 못하면 경고 로그를 남긴 뒤 `TraceEventsLost`로 실패한다.
- `SettingsPlaces` / `AgentOperationFailed` / `ChatRequest` / `ChatStart` — 설정 위치 타입, 하위 transcript·follow-up 로그 읽기 실패 오류(`load-transcript`|`drain-followup`), 채팅 요청 타입, 채팅 시작 `Data.TaggedEnum`이다.
- `SessionRunState` / `CancelResult` / `CompactResult` / `ContextView` / `CompactionStage` / `RunStatus` / `RunningBackgroundTask` / `BackgroundKind` — `GET /api/sessions/:session`, cancel, `/compact` 응답과 컨텍스트 뷰, 실행 중 백그라운드 작업의 Schema다(`run-state.ts`). 앱 API 계약과 브라우저 번들이 쓴다.
- `taskNotifications` (`task-notifications.ts`) — 부모 대화가 아직 듣지 못한 Work Trace task 알림과 백그라운드 작업의 끝을 함께 다룬다. `consume`·`release`·`untold`와, run의 모델 호출 전마다 그것을 오케스트레이터 메시지로 대화에 넣고 run이 끝나지 못하면 돌려주는 `hookFor`가 있다.
- `skillSuggestions` (`skill-suggestions.ts`) — 사용자가 시작한 run의 첫 모델 호출 전에, 대화가 사용자 메시지로 끝나면 그 메시지에 맞을 수 있는 스킬 최대 `suggestedSkills`(3)개를 오케스트레이터 메시지(`next: "run"`, `skills`에 이름)로 그 뒤에 넣는 `hookFor(project, sessionId)`가 있다. `SkillSearch.find`를 모델 적재를 기다리지 않고 부르며, 실패하면 아무것도 넣지 않는다.
- `dispatchNotifications` (`dispatch-notifications.ts`) — 다른 대화가 대상 세션에 남겨 둔 session dispatch의 전달이다. `consume`은 저장소의 소비 API를 그대로 부른다(알림 보류 세션의 거름은 저장소의 `consume`이 한다). `hookFor`는 run의 모델 호출 전마다 소비한 dispatch를 `dispatchesMessage` 오케스트레이터 메시지로 대화에 넣는다. run이 끝나면 claim했던 것을 마무리한다: 완료·interrupted면 delivered로 표시(`deliverClaimed`), 실패·취소면 claim을 돌려놓아(`release`) 다시 waiting이 된다.
- `TaskNotifications` / `endedTasks` / `notificationLines` / `notificationsMessage` / `orchestratorMessage` / `dispatchesMessage` (`orchestrator-message.ts`) — 두 알림의 묶음, 끝난 백그라운드 작업·서브에이전트 수(보드의 카드 run은 세지 않음), 모델이 읽는 알림 줄, 오케스트레이터 메시지다. `dispatchesMessage`는 다른 대화가 남긴 dispatch를 "사용자 지시나 승인이 아님"을 명시한 운영 전달 문구로 모델에게 넘긴다.
- `serverRestartedCode` / `serverRestartedMessage` / `interruptContinuationLostCode` / `contextUsageEvent` — 실행 오류 코드·메시지 상수와 라이브 커스텀 이벤트 이름 `memory-agent.context`이다.
- `ApiUsage` — SQLite `api_usage_responses` 원장 서비스(`ApiUsage.layer`)이다. `record(response)`는 행 id를 돌려주고 `byRootSession(rootSessionId)`는 `ApiUsageTotals`를 돌려준다.
- `recordUsage` / `apiUsageHook` / `ApiUsageRejected` / `ApiUsageResponse` / `ApiUsageTotals` — Effect AI 응답 usage를 원장에 기록하는 dual 함수와 `RunHook.usage` 훅, 거부 오류(`attribution-missing`|`invalid-count`|`unknown-cache-mode`|`cache-exceeds-input`), 입출력 타입이다.
- `compactEffect` / `requestHistory` / `compactionHook` / `compactByHand` — 모델에 보낼 대화를 압축하는 본체, 요청 단위 히스토리와 적용 stage, Effect AI 루프용 compaction 훅, 수동 `/compact`이다.
- `summarizeEarlierTurns` / `SummaryRequest` / `Summarize` / `summaryInput` / `SummaryWriter` / `summaryWriter` — 세션 요약을 최신 사용자 턴 두 개 앞까지 이어 쓰는 함수, 요약기에 넘기는 앞 요약·메시지·다시 읽을 위치, 요약기 타입, 요약기가 읽는 메시지 글, 요약을 쓰고 저장하는 쌍(`ChatMetadata.replaceSummary`)이다.
- `nextRequestHistory` / `NextRequest` / `SentRequest` / `RequestBasis` / `RebuildReason` / `LastRequests` — 앞 요청에 새 메시지만 붙여 다음 요청을 만들거나, 붙일 수 없을 때 그 이유와 함께 `requestHistory`로 다시 계산한다. `LastRequests`(`LastRequests.layer`)는 세션마다 마지막 요청을 provider가 캐시하는 동안 메모리에 둔다.
- `clearedNotice` / `clearedOutput` — compaction이 비운 도구 출력 자리에 둘 글이다. 대화와 서브에이전트 모두 기억 node를 가리킨다(`read_evidence <node id>`, 미리보기 머리말은 `read_tool_result`). 아직 node로 기록되지 않은 출력은 다시 읽을 곳이 없어 비우지 않는다.
- `ConversationMessage` / `ConversationToolCall` / `CompactionMessage` / `CompactionFailed` / `CompactionReason` — compaction이 읽는 메시지 형태, 대체 메시지, 실패 오류(operation·reason·cause)이다.
- `budgetFor` / `Budget` / `leaveOutAtShare` / `estimateTokens` / `estimateConversation` / `messageText` / `clearedOutput` — 컨텍스트 예산(leaveOutAt = window*0.55, inputCeiling = window − 답할 자리), 토큰 추정, 메시지 텍스트, 비운 도구 출력 문구이다.
- `manualCompactionNamespace` / `ManualCompaction` / `compactionStateEffect` / `CompactionState` / `CompactionSources` / `sameTurn` / `userTurns` / `answeredToolCalls` / `memoryLookups` / `lookupSources` / `replayableToolHistory` / `lightweightToolResults` / `shorten` / `SummaryOutcome` / `Compacted` — 수동 compaction 저장 형식, 세션 compaction 상태(수동 기록과 세션 요약) 읽기, 요약-대화 정렬 보조 함수, 글 자르기이다.
- `defaultSummaryStartPercent` / `recentRawUserTurns` / `summaryCharacters` / `summaryInputCharacters` / `userMessageCharacters` / `retrievalLeadLimit` / `retrievalTokenLimit` / `recentRawSteps` / `summaryFailureLimit` — compaction 정책 상수(25, 2, 6,000, 60,000, 3,000, 5, 600, 10, 3)이다(`compaction-policy.ts`).
- `sessionSummarizer` / `summaryInstructions` / `summaryPrompt` / `cheapSummary` / `SummaryServices` / `SummaryFailed` (`session-summary.ts`) — 세션 요약을 run 모델의 가장 싼 강도로 이어 쓰는 함수와 그 지침·입력, 단일 호출(usage 기록, 시간 제한), 실패 오류이다. 실패하면 로그를 남기고 none을 돌려준다.
- `contextView` / `contextUsageHook` / `lastContextUsageEffect` / `ContextUsageFailed` / `ContextUsageReason` / `StoredContextUsage` / `contextUsageNamespace` / `measuredOverhead` — 요청별 컨텍스트 사용량 저장과 라이브 전송, 마지막 요청에서 provider가 추정보다 더 센 양이다.
- `TurnSummaries` — run이 끝난 뒤 세션 요약을 이어 쓰는 `Context.Service`이다. `TurnSummaries.layer(automatic = true)`와 `layerNoDeps(automatic = true)`를 제공하고, 관련 `TurnSummaryFailed`가 있다.
- `HandoffState` / `SavedHandoff` / `modelHandoffNamespace` / `fingerprint` / `legacyFingerprint` — 모델 handoff 저장 상태(`baseline`|`handoff` TaggedUnion)와 메시지 fingerprint(v2 정규화 sha256, legacy)이다.
- `modelHandoffHistoryEffect` / `handoffHistory` / `ModelHandoffOptions` / `ModelHandoffFailed` / `ModelHandoffReason` / `handoffNotice` — 모델이 바뀔 때 이전 턴을 텍스트로 넘기는 히스토리 생성과 오류이다.
- `sessionMessages` — 세션 노드에서 저장된 thread를 다시 만든다(사용자 턴별 텍스트+이미지, 실행 답변을 도구 결과 단위로 분할).
- `promptLayout` — dual 함수다. standing → role → context 순서로 프롬프트 블록을 배치한다.
- `projectInstructionsHook` — `root`를 받는다. 루트 안내와 경로 카탈로그를 대화 실행당 한 번 읽어 앞선 훅이 고른 system 프롬프트 뒤에 붙이는 `RunHook`이다.
- `steerCuttableModel` / `SteerCut` — steer된 메시지가 현재 응답을 끊도록 `LanguageModel`을 감싼다. 연 블록을 닫고 실행을 완료한다.
- `createLiveRuns` / `LiveRun` / `LiveRuns` — `AgentChat` 서비스당 하나 있는 실행 중 run 레지스트리이다.
- `shownRunErrors` / `pageTurns` / `withPageTurns` — `RUN_ERROR` 메시지를 자르고 비밀을 가리는 스트림 변환, 페이지 사용자 턴을 저장 thread에 보충하는 함수이다.
- `agentPrompts` — 모델이 읽는 리포트 근거 수집 실패 안내(`prompts.ts`)이다.
- 문구 — Lingui 런타임 매크로 메시지(`msg`)로 쓰는 곳에 두고 `src/i18n.ts`로 푼다. `src/locales/ko.po`로 추출되고 `lint/wording`가 검사한다.

## Invariants

- 세션의 지금 Goal이 칸반 보드로 실행 중이면 그 세션의 채팅 run은 계획자 모델(`ActiveProvider.selectedFor("planner")`)로 돈다. 상태 응답과 `/compact`의 context window도 같은 모델로 잰다. 보드가 없으면 선택된 모델이다.
- `promptLayout`는 항상 standing → role → context 순서를 지킨다. 지침은 순서가 의미에 영향을 주므로 절대 정렬하지 않는다. 호출자가 각 블록을 명시적으로 분류한다.
- `ApiUsage.record`는 보조 응답을 포함해 실제 프로바이더 응답마다 한 번만 호출한다. rootSessionId·purpose·model이 비면 `attribution-missing`으로 거부한다.
- API usage 카운트의 NULL은 0이 아니라 '모름'이다. `byRootSession` 합계는 한 행이라도 값이 없으면 null을 돌려준다. SUM만 쓰면 모르는 행이 빠지기 때문이다.
- cache_mode 규칙: `openai`·`openai-compatible`은 `included`(input에 cache read 포함), `anthropic`은 `separate`이다. 그 밖의 프로바이더는 `unknown-cache-mode`로 거부한다. included에서 cache read가 input보다 크면 `cache-exceeds-input`으로 거부한다.
- Effect AI usage를 기록할 때 Anthropic 행의 inputTokens는 total - cacheRead - cacheWrite(비캐시분)만 저장한다. 카운트를 하나도 보고하지 않은 응답은 행을 남기지 않는다.
- `apiUsageHook`은 카운트만 기록한다. 프롬프트·메시지·도구 인자는 절대 저장하지 않는다.
- compaction의 answered 도구 출력 비우기는 마지막 '도구 호출 없는 assistant 답변'까지만 적용한다. 진행 중인 실행의 도구 결과는 그대로 둔다.
- `keepLatestAnswered`일 때 최신 답변 턴은 다음 실행이 답할 때까지 유지한다. 비운 결과는 메모리 노드 id를 안내한다.
- `compactionHook`의 요청은 앞 요청에 새 메시지만 붙인다(`nextRequestHistory`). 새 메시지는 미리보기와 빈 사용자 글 빼기만 거친다. 다시 계산(`requestHistory`)은 붙이면 `leaveOutAt`을 넘을 때, `/compact` 뒤, 대화가 앞 요청 때와 달라졌을 때, 앞 요청이 없거나 provider가 캐시하는 시간(`RunModel.promptCacheFor`)이 지났을 때, 도구 정의나 system prompt가 앞 요청과 다를 때(`tools-changed`, `system-changed`)만 한다. provider는 요청을 앞에서부터 캐시하므로 앞부분이 바뀌면 메시지를 어차피 모두 새로 쓴다. 답한 도구 출력 비우기와 세션 요약은 그 다시 계산하는 요청부터 보낸다. `leaveOutAt`을 넘어서 다시 계산하는 요청은 요약으로 `leaveOutAt` 아래가 되어도 절반까지 내린다. 바로 아래에서 멈추면 몇 step 뒤 다시 넘어 캐시를 또 쓰기 때문이다. 요청마다 `model request history` 로그에 basis와 유지한 메시지 수, 추정 토큰, stage를 남긴다. `tools-changed`면 바뀐 도구 이름(`changedTools`)도 남긴다.
- retrieval appendix는 찾은 것만 run 동안 기억한다. 이어 붙일 때는 새 사용자 턴 바로 앞에 넣고, 앞 요청에 이미 있는 appendix는 다시 넣지 않는다.
- 세션 요약은 세션마다 하나(`session_summaries`)이고, 덮지 않은 첫 메시지로 끝을 적는다(`SummaryEnd`: 기억이 기록한 사용자 턴 `Turn {turn, nodeId}`, 또는 step의 첫 call `Step {callId}`). `Turn` 끝은 그 node의 기록 텍스트가 해당 위치의 사용자 턴과 같을 때만 쓴다(`sameTurn`, `[redacted:` 포함 노드는 어떤 텍스트와도 일치). 끝을 대화에서 찾지 못하면 요약 없이 보낸다. 요약은 앞 요약에 새 부분을 접어 다시 쓰고, `replaceSummary`가 읽은 요약과 저장된 요약이 같을 때만 바꾼다. 그래서 run 안 요약과 run 뒤 요약이 겹쳐도 하나만 남는다. 요약이 바뀌면 그 앞부분부터 요청이 다시 쓰이므로, 다시 계산하는 요청에서만 보낸다.
- `leaveOutAt`을 넘는 요청은 run 경계와 관계없이 한 규칙으로 절반까지 줄인다. 먼저 run의 최근 10 step(`recentRawSteps`)과 마지막 step 앞의 도구 출력을 오래된 것부터 pointer로 바꾼다. 그래도 넘으면 가장 오래된 메시지부터 도구 결과가 아닌 자리에서 끊어 뺀다. 끊는 곳은 최근 10 step의 시작과, 출력이 아직 기록되지 않은 첫 step을 넘지 않는다. 진행 중인 run을 시작한 메시지와 최신 사용자 턴 두 개(`recentRawUserTurns`)는 끊긴 앞에 있어도 순서대로 보낸다. 늘 보내는 메시지만 빠지는 자리에서는 끊지 않는다. 마지막으로 최근 step의 출력을 마지막 step 것만 빼고 pointer로 바꾼다.
- 뺀 부분은 요청을 보내기 전에 세션 요약에 이어 쓴다(`compactionHook({summarize})`). 요청 하나에서는 요약을 끝낼 수 있는 마지막 자리까지 한 부분(`summaryInputCharacters`)만 쓴다. 쓰지 못한 나머지와 요약이 실패한 부분은 표지가 대신한다. 표지에는 뺀 메시지 수와 그 도구 출력 최신 20개(`read_evidence` node id)가 있다. 요약이 연속 3번(`summaryFailureLimit`) 실패하면 그 run에서는 다시 요청하지 않고 표지만 쓴다. 요약 하나가 만들어지면 횟수를 0으로 돌린다.
- leave-out이 앞 메시지를 빼면 그 자리 표지에 빠진 턴의 사용자 말을 node id와 함께 남긴다(`CompactionSources.userMessages`, 세션은 `Nodes.userMessages`). 요약이 덮는 턴도 포함한다. 뒤의 사용자 메시지가 정정·철회한 말은 뺀다. 최신 말부터 `summaryCharacters`까지 남기고, 말 하나는 `userMessageCharacters`까지 자른다. 나머지는 개수와 find_memory 안내만 남긴다. 요약은 단서일 뿐이고 결정은 사용자 말뿐이기 때문이다.
- `Budget.compactAt`은 deprecated 호환 필드이며 항상 0이다. leave-out 기준은 `Math.floor(contextWindow * 0.55)`이다.
- 진행 메모(`ProgressMemos.hookFor`)는 compaction hook 다음의 `request` hook이라, 메모가 있으면 compaction이 무엇을 빼든 요청 끝에 user 메시지로 붙는다. 저장된 transcript에는 들어가지 않는다. 리포트 분석 세션에는 `update_memo`를 주지 않는다.
- `Budget.inputCeiling`은 창에서 답할 자리(16,384와 창의 1/5 중 작은 값)를 뺀 값이다. `compactionHook`은 run의 step 사용량이 오면 provider가 센 입력에서 우리 메시지 추정을 뺀 값(시스템 프롬프트, 도구 정의, tokenizer 차이)을 기억한다. 다음 step부터는 `inputCeiling`에서 그 값을 뺀 자리가 `leaveOutAt`보다 작을 때 그 자리를 기준으로 leave-out한다. run의 첫 step은 대화의 마지막 요청에서 잰 값(`measuredOverhead`, 저장된 사용량의 `inputTokens − estimatedTokens`)으로 시작하므로 run이 바뀌거나 서버를 다시 켜도 이어진다. 잰 값이 없는 첫 step과 입력 수를 알리지 않는 provider는 추정만 쓴다.
- `estimateTokens`는 ASCII 4자당 1토큰, 비ASCII 1자당 1토큰으로 센다(한국어 과소추정 방지). 이미지는 크기를 읽지 않고 하나에 4,784토큰(Anthropic 고해상도 모델의 문서 최대치)으로 센다.
- `defaultSummaryStartPercent = 25`는 `docs/decisions.md` 2026-10-13 결정이다. run이 끝난 뒤 요약 없이 보내는 대화가 창의 그 비율을 넘으면 `TurnSummaries`가 최신 사용자 턴 두 개 앞까지 세션 요약을 이어 쓴다. 요약이 한 번 생기면 비율과 관계없이 이어 쓴다. 최근 사용자 턴 2개(`recentRawUserTurns`)는 항상 원문으로 보낸다.
- `handoff-state.ts`는 모델 handoff 루프와 분리되어 있다. 시작 시 TanStack 행 마이그레이션이 루프를 로드하지 않고 상태·fingerprint를 읽기 위해서다. `fingerprint`는 'v2:' 접두와 객체 키 정렬로 UI hydration의 필드 순서 변화에 견딘다. `legacyFingerprint`는 이전 행 비교용으로 남긴다.
- `HandoffState.handoff.through`는 0보다 큰 정수이다. `context`는 이전 버전 호환용 optional 필드이며 더 이상 전송하지 않는다.
- `run-state.ts`는 브라우저 번들이 쓰므로 `effect`와 다른 계약 모듈(`sessions/contracts.ts`, `workflow/contracts.ts`) 밖의 코드를 import하지 않는다. `chat-store/schema.ts`의 `StoredRunStatus`가 이 모듈의 `RunStatus`다.
- ContextUsage 저장 스키마는 예전 행을 위해 `cachedTokens`·`compactionStage`·`estimatedTokens`를 decoding default null로 받는다. 예전 행의 `observationId`는 읽지 않는다. 저장 형식 하위 호환을 유지해야 한다.
- 한 응답의 도구 호출은 동시에 실행되고 순서가 보장되지 않는다(`docs/decisions.md` "도구 호출 사이에 순서를 두지 않는다"). 의존 호출은 다음 응답에서 한다.
- `AgentOperationFailed`의 `cause`는 서버에만 남기고 클라이언트에 노출하지 않는다.
- `shownRunErrors`는 `RUN_ERROR` 메시지를 페이지·에디터·durable 로그가 읽기 전에 자르고 비밀을 가린다.
- `createLiveRuns` 레지스트리는 `AgentChat` 서비스당 하나다. `makeAgentChatImplementation`은 생성할 때마다 중앙 서비스를 새로 획득한다.
- `start`는 호출자가 아니라 서비스 scope에서 돈다. user turn을 메모리 node로 먼저 쓰고 run을 그 뒤에 만들므로, 요청이 그 사이에 끊겨도 run 시작까지 마친다. 서비스가 닫힐 때만 중단된다.
- workspace 지침상 앱 저장소 폴더(`places.storageRoot`)는 파일 도구와 sh skill 스크립트가 열지 않는다. 자격 증명 파일과 .git 내부는 승인과 관계없이 파일 도구 접근이 금지된다.

## Side Effects

- SQLite `api_usage_responses` 테이블: `ApiUsage.record`가 INSERT ... RETURNING id를 실행하고 `byRootSession`이 집계 SELECT를 실행한다. created_at은 `Clock.currentTimeMillis`로 채운다.
- ChatMetadata 읽기·쓰기(네임스페이스 `memory-agent/manual-compaction`, `memory-agent/context-usage`, `memory-agent/model-handoff`): compaction 상태, 컨텍스트 사용량, handoff 상태를 저장한다. 예전 cold 관측 소비 기록(`memory-agent/consumed-cold-usage`)은 더 읽지 않는다. 세션 요약은 `ChatMetadata.summary`/`replaceSummary`로 `session_summaries`에 세션당 한 행으로 둔다.
- `contextUsageHook`은 `RunScope.emit`으로 실행 중 `memory-agent.context` 라이브 이벤트를 페이지에 보낸다.
- compaction의 `memoryLookups`/`CompactionSources`는 메모리 노드 저장소에서 tool_result 노드 id와 노드 텍스트를 읽는다(`NodeStoreFailed`).
- `fingerprint`/`legacyFingerprint`는 동기 sha256(`packages/memory-agent/src/runtime/synchronous-crypto.ts`)을 계산한다.
- `workspaceInstructions`는 `process.env`로 호스트 셸을 확인하고(`hostShell`) `process.platform`, `Intl` 타임존, `DateTime.now`를 읽는다.
- `projectInstructionsHook`은 실행마다 프로젝트 루트의 안내 파일과 경로 카탈로그를 읽는다.
- `chat.ts`의 `AgentChat`은 import 기준으로 SqlClient(실행·워크플로 바인딩 SQL, `sqliteRunLog` durable 로그), `RunLogSignals`(로그 끝 reader 깨우기), FileSystem/Path, Queue/Fiber/Scope 기반 동시성, SecureRandom/NodeCrypto id 생성, 프로바이더 네트워크 호출(ActiveProvider·ProviderRegistry·subscription runtime), MCP 서버, 외부 에이전트, 백그라운드 작업, AppEvents를 사용한다.
- `TurnSummaries`와 `compactionHook`은 `summaryInstructions`로 모델에 세션 요약을 요청한다(purpose `summary`). `TurnSummaries`는 `layer(automatic = true)` 설정이 있고, 밀린 부분을 `summaryInputCharacters`씩 차례로 요약해 하나씩 저장한다. 한 부분이 실패하면 거기서 멈추고 다음 번에 다시 요약한다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
