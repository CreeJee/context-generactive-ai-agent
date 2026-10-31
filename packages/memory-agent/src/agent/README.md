# agent

## Overview

`packages/memory-agent/src/agent`는 memory-agent의 대화 에이전트 핵심 계층이다. `chat.ts`의 `AgentChat` 서비스는 프로바이더·도구·메모리·워크플로·칸반·큐 서비스를 묶어 세션 채팅을 실행한다. 이 서비스는 시스템 프롬프트(memory/workspace/attachment 지침)와 프롬프트 배치 규칙도 정의한다. 주변 파일은 실행 루프(`RunHook`)에 끼우는 훅이다. 이 훅들은 대화 압축(compaction, 턴 요약), 컨텍스트 사용량 기록, API 사용량 원장, 모델 handoff, steer 중단, 오류 표시 정리, owner RPC fingerprint를 맡는다. `run-state.ts`는 세션 실행 API의 브라우저 안전 응답 타입을 앱(`apps/agent`)과 공유한다.

## Interface

- `AgentChat` — `chat.ts`의 `Context.Service`이며 `AgentChat.layer`를 제공한다(`RunCancellations.layer` 포함). 세션 채팅 실행의 중심 서비스다.
- `makeAgentChatImplementation` — `AgentChat`의 네이티브 구현 seam이다. 생성할 때마다 중앙 서비스를 새로 획득한다.
- `memoryInstructions` / `concurrentCallsInstructions` / `reportAnalysisInstructions` / `attachmentInstructions` — 메모리 사용, 동시 도구 호출, 이슈 리포트 분석 세션, 첨부 이미지 참조에 관한 표준 시스템 프롬프트 문자열이다.
- `workspaceInstructions` — `EffectFunction.dual`이다. `Project`·`SettingsPlaces`·선택 `now`로 프로젝트 루트, 날짜·타임존, 셸, permissionMode별 승인 규칙, 설정 폴더 안내 프롬프트를 만드는 Effect를 돌려준다.
- `AgentChat`의 앱 API 메서드 가운데 `queued`·`enqueue`·`editQueued`·`subagents`·`subagentTranscript`·`approvals`·`answerApproval`·`cancel`·`compact`·`discardInterrupts`·`continuePastUncertain`·`lease`는 값을 돌려주고, 페이지가 읽는 거부를 `{ error }` 값으로 실패한다. 나머지는 아직 HTTP `Response`를 만든다(`docs/httpapi-migration.md` 1-4b).
- `SettingsPlaces` / `AgentOperationFailed` / `ChatRequest` / `ChatStart` — 설정 위치 타입, 하위 transcript·follow-up 로그 읽기 실패 오류(`load-transcript`|`drain-followup`), 채팅 요청 타입, 채팅 시작 `Data.TaggedEnum`이다.
- `SessionRunState` / `CancelResult` / `CompactResult` / `ContextView` / `CompactionStage` / `RunStatus` — `GET /api/sessions/:session`, cancel, `/compact` 응답과 컨텍스트 뷰의 Schema다(`run-state.ts`). 앱 API 계약과 브라우저 번들이 쓴다.
- `serverRestartedCode` / `serverRestartedMessage` / `interruptContinuationLostCode` / `contextUsageEvent` — 실행 오류 코드·메시지 상수와 라이브 커스텀 이벤트 이름 `memory-agent.context`이다.
- `ApiUsage` — SQLite `api_usage_responses` 원장 서비스(`ApiUsage.layer`)이다. `record(response)`는 행 id를 돌려주고 `byRootSession(rootSessionId)`는 `ApiUsageTotals`를 돌려준다.
- `recordUsage` / `apiUsageHook` / `ApiUsageRejected` / `ApiUsageResponse` / `ApiUsageTotals` — Effect AI 응답 usage를 원장에 기록하는 dual 함수와 `RunHook.usage` 훅, 거부 오류(`attribution-missing`|`invalid-count`|`unknown-cache-mode`|`cache-exceeds-input`), 입출력 타입이다.
- `compactEffect` / `requestHistory` / `compactionHook` / `compactByHand` — 모델에 보낼 대화를 압축하는 본체, 요청 단위 히스토리와 적용 stage, Effect AI 루프용 compaction 훅, 수동 `/compact`이다.
- `ConversationMessage` / `ConversationToolCall` / `CompactionMessage` / `CompactionFailed` / `CompactionReason` — compaction이 읽는 메시지 형태, 대체 메시지, 실패 오류(operation·reason·cause)이다.
- `budgetFor` / `Budget` / `leaveOutAtShare` / `estimateTokens` / `estimateConversation` / `messageText` / `clearedOutput` — 컨텍스트 예산(leaveOutAt = window*0.55), 토큰 추정, 메시지 텍스트, 비운 도구 출력 문구이다.
- `SummaryBlock` / `StoredSummaries` / `turnSummariesNamespace` / `manualCompactionNamespace` / `compactionStateEffect` / `CompactionState` / `CompactionSources` / `linedUp` / `sameTurn` / `userTurns` / `answeredToolCalls` / `memoryLookups` / `lookupSources` / `replayableToolHistory` / `lightweightToolResults` / `SummaryOutcome` / `Compacted` — 턴 요약 블록 저장 형식, 세션 compaction 상태 읽기, 요약-대화 정렬 보조 함수이다.
- `summaryBlockTurns` / `defaultSummaryStartPercent` / `recentRawUserTurns` / `retrievalLeadLimit` / `retrievalTokenLimit` — compaction 정책 상수(4, 25, 2, 5, 600)이다(`compaction-policy.ts`).
- `contextView` / `contextUsageHook` / `lastContextUsageEffect` / `pendingColdObservationEffect` / `consumeColdObservationEffect` / `coldObservationId` / `ContextUsageFailed` / `ContextUsageReason` / `StoredContextUsage` / `contextUsageNamespace` / `consumedColdUsageNamespace` — 요청별 컨텍스트 사용량 저장·라이브 전송과 cache-cold 관측 처리이다.
- `TurnSummaries` — 이전 턴 요약을 만드는 `Context.Service`이다. `TurnSummaries.layer(automatic = true)`와 `layerNoDeps(automatic = true)`를 제공하고, 관련 `summaryInstructions`·`TurnSummaryFailed`가 있다.
- `HandoffState` / `SavedHandoff` / `modelHandoffNamespace` / `fingerprint` / `legacyFingerprint` — 모델 handoff 저장 상태(`baseline`|`handoff` TaggedUnion)와 메시지 fingerprint(v2 정규화 sha256, legacy)이다.
- `modelHandoffHistoryEffect` / `handoffHistory` / `ModelHandoffOptions` / `ModelHandoffFailed` / `ModelHandoffReason` / `handoffNotice` — 모델이 바뀔 때 이전 턴을 텍스트로 넘기는 히스토리 생성과 오류이다.
- `sessionMessages` — 세션 노드에서 저장된 thread를 다시 만든다(사용자 턴별 텍스트+이미지, 실행 답변을 도구 결과 단위로 분할).
- `promptLayout` — dual 함수다. standing → role → context 순서로 프롬프트 블록을 배치한다.
- `projectInstructionsHook` — `root`를 받는다. 루트 안내와 경로 카탈로그를 대화 실행당 한 번 읽어 앞선 훅이 고른 system 프롬프트 뒤에 붙이는 `RunHook`이다.
- `steerCuttableModel` / `SteerCut` — steer된 메시지가 현재 응답을 끊도록 `LanguageModel`을 감싼다. 연 블록을 닫고 실행을 완료한다.
- `createLiveRuns` / `LiveRun` / `LiveRuns` — `AgentChat` 서비스당 하나 있는 실행 중 run 레지스트리이다.
- `shownRunErrors` / `pageTurns` / `withPageTurns` — `RUN_ERROR` 메시지를 자르고 비밀을 가리는 스트림 변환, 페이지 사용자 턴을 저장 thread에 보충하는 함수이다.
- `ownerRpcFingerprint` / `ownerRpcCanonicalJson` / `ownerRpcFrame` / `compactLegacyOwnerRpcFingerprint` / `OwnerRpcFingerprintFailed` / `migrateOwnerRpcFingerprintBatch` / `OwnerRpcFingerprintMigrationError` — Goal worker owner RPC 입력의 정규 JSON·fingerprint, legacy fingerprint 압축, 운영자용 배치 마이그레이션이다.

## Invariants

- `promptLayout`는 항상 standing → role → context 순서를 지킨다. 지침은 순서가 의미에 영향을 주므로 절대 정렬하지 않는다. 호출자가 각 블록을 명시적으로 분류한다.
- `ApiUsage.record`는 보조 응답을 포함해 실제 프로바이더 응답마다 한 번만 호출한다. rootSessionId·purpose·model이 비면 `attribution-missing`으로 거부한다.
- API usage 카운트의 NULL은 0이 아니라 '모름'이다. `byRootSession` 합계는 한 행이라도 값이 없으면 null을 돌려준다. SUM만 쓰면 모르는 행이 빠지기 때문이다.
- cache_mode 규칙: `openai`·`openai-compatible`은 `included`(input에 cache read 포함), `anthropic`은 `separate`이다. 그 밖의 프로바이더는 `unknown-cache-mode`로 거부한다. included에서 cache read가 input보다 크면 `cache-exceeds-input`으로 거부한다.
- Effect AI usage를 기록할 때 Anthropic 행의 inputTokens는 total - cacheRead - cacheWrite(비캐시분)만 저장한다. 카운트를 하나도 보고하지 않은 응답은 행을 남기지 않는다.
- `apiUsageHook`은 카운트만 기록한다. 프롬프트·메시지·도구 인자는 절대 저장하지 않는다.
- compaction의 answered 도구 출력 비우기는 마지막 '도구 호출 없는 assistant 답변'까지만 적용한다. 진행 중인 실행의 도구 결과는 그대로 둔다.
- `keepLatestAnswered`일 때 최신 답변 턴은 다음 실행이 답할 때까지 유지한다. 각 도구 결과는 정확히 한 번만 바뀌어 요청 prefix가 캐시 가능하게 남는다. 비운 결과는 메모리 노드 id를 안내한다.
- 요약 블록은 불변이다. 블록을 추가해도 이전 메시지를 다시 쓰지 않는다(프로바이더 KV prefix 유지).
- `SummaryBlock`은 `nextTurnNodeId`의 기록 텍스트가 해당 위치의 사용자 턴과 같을 때만 쓴다(`sameTurn`, `[redacted:` 포함 노드는 어떤 텍스트와도 일치). `linedUp`은 `end`가 엄격히 증가하는 앞쪽 연속 블록만 받는다.
- `Budget.compactAt`은 deprecated 호환 필드이며 항상 0이다. leave-out 기준은 `Math.floor(contextWindow * 0.55)`이다.
- `estimateTokens`는 ASCII 4자당 1토큰, 비ASCII 1자당 1토큰으로 센다(한국어 과소추정 방지).
- `defaultSummaryStartPercent = 25`는 `docs/decisions.md` 2026-10-13 결정이다. 최근 사용자 턴 2개(`recentRawUserTurns`)는 항상 원문으로 보낸다.
- `handoff-state.ts`는 모델 handoff 루프와 분리되어 있다. 시작 시 TanStack 행 마이그레이션이 루프를 로드하지 않고 상태·fingerprint를 읽기 위해서다. `fingerprint`는 'v2:' 접두와 객체 키 정렬로 UI hydration의 필드 순서 변화에 견딘다. `legacyFingerprint`는 이전 행 비교용으로 남긴다.
- `HandoffState.handoff.through`는 0보다 큰 정수이다. `context`는 이전 버전 호환용 optional 필드이며 더 이상 전송하지 않는다.
- `run-state.ts`는 브라우저 번들이 쓰므로 `effect`와 다른 계약 모듈(`sessions/contracts.ts`, `workflow/contracts.ts`) 밖의 코드를 import하지 않는다. `chat-store/schema.ts`의 `StoredRunStatus`가 이 모듈의 `RunStatus`다.
- ContextUsage 저장 스키마는 cache-cold 추적 이전에 저장된 행을 위해 `cachedTokens`·`observationId`·`compactionStage`를 decoding default null로 받는다. 저장 형식 하위 호환을 유지해야 한다.
- `memoryRulesFor`는 실행에 `promote_memory_candidate`/`use_promoted_memory` 도구가 없으면 해당 규칙 줄을 뺀다. `promotionRules` 값은 `memoryInstructions` 줄 접두와 정확히 일치해야 한다.
- 한 응답의 도구 호출은 동시에 실행되고 순서가 보장되지 않는다(`docs/decisions.md` "도구 호출 사이에 순서를 두지 않는다"). 의존 호출은 다음 응답에서 한다.
- `AgentOperationFailed`의 `cause`는 서버에만 남기고 클라이언트에 노출하지 않는다.
- `shownRunErrors`는 `RUN_ERROR` 메시지를 페이지·에디터·durable 로그가 읽기 전에 자르고 비밀을 가린다.
- `migrateOwnerRpcFingerprintBatch`는 명시적 운영자 유지보수용으로만 실행한다.
- `createLiveRuns` 레지스트리는 `AgentChat` 서비스당 하나다. `makeAgentChatImplementation`은 생성할 때마다 중앙 서비스를 새로 획득한다.
- `start`는 호출자가 아니라 서비스 scope에서 돈다. user turn을 메모리 node로 먼저 쓰고 run을 그 뒤에 만들므로, 요청이 그 사이에 끊겨도 run 시작까지 마친다. 서비스가 닫힐 때만 중단된다.
- workspace 지침상 앱 저장소 폴더(`places.storageRoot`)는 파일 도구와 sh skill 스크립트가 열지 않는다. 자격 증명 파일과 .git 내부는 승인과 관계없이 파일 도구 접근이 금지된다.

## Side Effects

- SQLite `api_usage_responses` 테이블: `ApiUsage.record`가 INSERT ... RETURNING id를 실행하고 `byRootSession`이 집계 SELECT를 실행한다. created_at은 `Clock.currentTimeMillis`로 채운다.
- ChatMetadata 읽기·쓰기(네임스페이스 `memory-agent/turn-summaries`, `memory-agent/manual-compaction`, `memory-agent/context-usage`, `memory-agent/consumed-cold-usage`, `memory-agent/model-handoff`): compaction 상태·요약, 컨텍스트 사용량·cold 관측 소비, handoff 상태를 저장한다.
- `contextUsageHook`은 `RunScope.emit`으로 실행 중 `memory-agent.context` 라이브 이벤트를 페이지에 보낸다.
- compaction의 `memoryLookups`/`CompactionSources`는 메모리 노드 저장소에서 tool_result 노드 id와 노드 텍스트를 읽는다(`NodeStoreFailed`).
- `fingerprint`/`legacyFingerprint`는 동기 sha256(`packages/memory-agent/src/runtime/synchronous-crypto.ts`)을 계산한다.
- `workspaceInstructions`는 `process.env`로 호스트 셸을 확인하고(`hostShell`) `process.platform`, `Intl` 타임존, `DateTime.now`를 읽는다.
- `projectInstructionsHook`은 실행마다 프로젝트 루트의 안내 파일과 경로 카탈로그를 읽는다.
- `chat.ts`의 `AgentChat`은 import 기준으로 SqlClient(실행·워크플로 바인딩 SQL, `sqliteRunLog` durable 로그), `RunLogSignals`(로그 끝 reader 깨우기), FileSystem/Path, Queue/Fiber/Scope 기반 동시성, Crypto/NodeCrypto id 생성, 프로바이더 네트워크 호출(ActiveProvider·ProviderRegistry·subscription runtime), MCP 서버, 외부 에이전트, 백그라운드 작업, AppEvents를 사용한다.
- `TurnSummaries`는 `summaryInstructions`로 모델에 이전 턴 요약을 요청한다. `layer(automatic = true)` 설정이 있다.
- `migrateOwnerRpcFingerprintBatch(afterRowid, limit)`는 owner RPC 행을 배치로 읽고 legacy fingerprint를 압축 형식으로 다시 쓴다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
