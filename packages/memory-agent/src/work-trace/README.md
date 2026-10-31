# work-trace

## Overview

`work-trace`는 하위 에이전트의 작업(Task), 호출(Invocation), 물리적 실행 시도(Attempt), 실행 이벤트, heartbeat, 산출물(Artifact), 부모 알림, 보관·삭제 lifecycle을 기록하고 조회하는 Work Trace 계층이다. `contracts.ts`는 상태 literal, 실패 사유 TaggedUnion, 도메인 Struct, attempt 상태 전이 표를 Effect Schema로 정의한다. `store.ts`는 `SqlClient` 기반 Effect 서비스 `WorkTraceStore`이며 attempt 시작·전이·heartbeat, 이벤트 append, 부모 알림 보류·소비, resume 요청·재시도 claim, task tree·snapshot 조회, 변경 대기(PubSub)를 제공한다.

## Interface

- `WorkTraceStore` — `Context.Service<WorkTraceStore, Effect.Success<typeof make>>` 서비스 태그. `WorkTraceStore.layer = Layer.effect(WorkTraceStore, make).pipe(Layer.provide(NodeCrypto.layer))`
- `WorkTraceStore` attempt 메서드 — `startAttempt`, `recordSteer`, `transitionAttempt`, `attemptHandle`, `activeAttemptForAgent`, `recoveredAttempts`, `claimRetries`
- `WorkTraceStore` heartbeat·도구 메서드 — `beat`, `toolStarted`, `toolSettled`, `keepAlive`
- `WorkTraceStore` 이벤트·조회 메서드 — `appendEvent`, `events`, `snapshot`, `snapshotEffect`, `latestCursor`, `projectLatestCursor`, `waitForChangeEffect`, `taskTree`, `projectTaskTree`, `taskDetail`, `projectTaskDetail`
- `WorkTraceStore` 부모 알림 메서드 — `notifyParent`, `consumeParentNotifications`, `holdParentNotifications`, `resumeParentNotifications`, `parentNotificationsHeld`, `pendingParentNotificationSessions`, `releaseParentNotifications`
- `WorkTraceStore` 산출물·최종 답변 메서드 — `recordArtifact`, `setArtifactVerification`, `markArtifactSourceDeleted`, `artifactsForTask`, `finalizeAnswerClaim`
- `WorkTraceStore` resume·lifecycle 메서드 — `claimResume`, `requestResume`, `requestSessionLifecycle`, `finalizeSessionLifecycle`, `requestTaskLifecycle`, `finalizeTaskLifecycle`, `pendingSessionDeletes`, `recoverLifecycleOperations`, `archiveTask`
- `WorkTraceRejected` — store가 거부한 쓰기 TaggedError. reason은 `handle_mismatch`, `unsafe_file_path`, `invalid_transition`, `foreign_session`, `attempt_not_found` 등이다. `message`는 모델에 보여도 안전하다
- `WorkTraceReadFailed` — `latest_cursor`/`snapshot` 읽기 실패 TaggedError
- `heartbeatIntervalMs` / `heartbeatLostMs` — live attempt는 10_000ms마다 beat한다. 60_000ms 동안 beat가 없으면 lost로 본다
- store 입력·뷰 타입 — `AttemptHandle`, `StartAttemptInput`, `AppendEventInput`, `RecordArtifactInput`, `TraceTaskView`, `TraceAttemptView`, `TraceHeartbeatView`, `TraceTreeSnapshot`, `TraceTaskDetail`, `TraceFinalAnswerClaimView`, `TraceArtifactView`, `TraceEventView`, `ParentNotificationView`, `ResumeContext`
- store 요청·결과 union — `ResumeClaim`, `ResumeRequest`, `ResumeBlocker`, `TaskArchive`, `LifecycleIntent`, `LifecycleRequest`, `LifecycleOutcome`, `LifecycleOperationView`, `PendingOperation`
- `LifecycleIntent` / `LifecycleResult` — 보관·복원·삭제 의도와, 페이지가 읽는 수명주기 결과(`completed`·`waiting_for_stop`·`blocked` TaggedUnion)의 Schema다(`contracts.ts`). 앱 API 계약과 브라우저 번들이 쓴다.
- `AttemptStatus` / `isActiveAttemptStatus` / `isTerminalAttemptStatus` — 물리 attempt 상태 literal과 판정. active는 queued·running·waiting·blocked이고 terminal은 interrupted·completed·failed·cancelled이다
- `canTransitionAttempt` — `attemptTransitions` 표로 attempt 상태 전이 허용 여부를 판정한다
- `TaskStatus` — 모든 attempt를 아우르는 Task의 논리 상태 literal(queued…archived, deleted)
- `InvocationKind` / `InvocationStatus` — start/continue/steer/resume 호출 종류와 호출 상태
- `AttemptFailureReason` / `AttemptFailure` / `AttemptFailureStage` / `attemptFailureCode` — 실패 사유 TaggedUnion, 실패 단계, 사유를 case 이름 코드로 바꾸는 matcher
- `RunEventKind` / `RunEvent` — lifecycle 이벤트 종류와 이벤트 Struct
- `HeartbeatState` — live attempt의 마지막 beat 상태(working/idle/waiting)
- `ArtifactKind` / `ArtifactLocator` / `ArtifactRef` / `EvidenceVerification` — 산출물 종류, 위치 TaggedUnion(file은 path와 sha256), 메타데이터, 검증 상태
- `TraceVisibility` / `RedactionState` / `ToolExecutionState` / `ResumeReason` — 노출 수준, 가림 상태, 도구 실행 상태, resume 사유 literal
- `WorkTask` / `AgentInvocation` / `AgentRunAttempt` / `AgentIdentity` / `AgentIdentityKind` — 도메인 Struct 스키마. 시각 필드는 `Schema.Finite`이다
- 하위 디렉터리 없음

## Invariants

- attempt 상태 전이는 `attemptTransitions` 표를 따른다. queued는 running·cancelled·failed로만 간다. running은 waiting·blocked·interrupted·completed·failed·cancelled로 간다. waiting과 blocked는 running·interrupted·failed·cancelled로 간다. terminal 상태는 어디로도 가지 않는다. store는 `canTransitionAttempt`를 import하며, 위반을 거부하는 사유로 `invalid_transition`을 정의한다.
- steer는 현재 attempt에 합류하고 resume은 새 attempt를 만든다(`InvocationKind` 주석).
- 실패는 정해진 코드와 안전한 필드만 저장하고 보여 준다. provider 응답 본문, 명령 출력, 경로는 저장하지 않는다(`AttemptFailureReason` 주석). 보고에는 `attemptFailureCode`로 case 이름만 쓰고 필드는 쓰지 않는다.
- 사용자에게 보이는 trace에는 내부 reasoning을 노출하지 않는다(`TraceVisibility` 주석).
- `RunEventKind`에는 lifecycle 변화만 담는다. attempt의 현재 위치는 이벤트가 아니라 heartbeat에 둔다.
- Artifact 메타데이터는 결과를 가리키기만 한다. generated 내용은 그 내용을 소유한 store에 남는다. file locator에는 `path`와 `sha256`이 필요하다. store는 이를 어기면 `unsafe_file_path`, `missing_file_digest`, `artifact_kind_mismatch`로 거부한다.
- retry가 안전한지는 attempt status가 아니라 run event로 판단한다(`AttemptStatus` 주석).
- DB row는 snake_case 컬럼을 Schema로 decode한다. `failure`는 `Schema.fromJsonString(AttemptFailure)` JSON 문자열이다. `locator`와 `payload`는 JSON 문자열이고 `pending_tool_call_ids`는 JSON 문자열 배열이다. 저장 형식을 바꾸면 decode와 호환되어야 한다.
- lifecycle operation row에는 target_kind(task/session), intent(archive/restore/delete), status(requested…failed), `idempotency_key`가 있다.
- `WorkTraceRejected.message`는 모델에 보여도 안전한 문구여야 한다.
- `WorkTraceStore.layer`는 `NodeCrypto.layer`를 내부에서 제공한다. `SqlClient`는 외부 layer가 제공해야 한다(`store.ts`가 `effect/sql`의 `SqlClient`를 import한다).

## Side Effects

- SQLite 읽기·쓰기(`effect/sql` `SqlClient`): task, invocation, attempt, run event, heartbeat, artifact, 부모 알림, final answer claim, lifecycle operation을 다룬다.
- in-memory `PubSub.unbounded<TraceChange>()`: 새 이벤트(sessionId, cursor)와 heartbeat progress(sessionId)를 publish한다. `waitForChangeEffect`가 이를 기다린다.
- `Crypto`와 `NodeCrypto.layer`로 id를 만든다.
- `Clock`과 `DateTime`으로 현재 시각을 읽는다.
- `logFailure`로 실패를 로그에 남긴다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
