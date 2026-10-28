# workflow

## Overview

`packages/memory-agent/src/workflow`는 세션 단위 Goal/Plan 워크플로를 담당한다. 버전이 붙은 Goal·Plan 산출물과 ledger, 칸반 카드 보드, 실행 상태, 완료 근거, 워크플로 규칙, 모델용 도구·지시문을 Effect 서비스로 제공하고 SQLite에 영속화한다.

`effect/workflow`의 WorkflowEngine은 프로젝트 소유 SQLite 저장소(`owner_workflow_*` 표)로 구현한다. 그 위에서 owner에 묶인 Goal 실행(`GoalExecution`)을 durable하게 감싼다. 또한 run 바인딩, tool ledger, run 이벤트 로그(SSE 재개용), 불확실 run 처리를 묶는다. 이 계층은 에이전트 루프와 HTTP 라우터가 쓰는 백엔드 계층이다.

## Interface

- `Workflows` — 세션 범위의 버전 있는 Goal/Plan 산출물과 실행 ledger 서비스(`layer`, `layerWithOptions({ allowNewGoal })`)
- `WorkflowState` / `GoalArtifact` / `PlanArtifact` / `PlanStep` / `WorkflowPhase` / `WorkflowAction` / `VerificationStatus` — 워크플로 상태 스키마(phase: chat|goal|plan|execute|verify|completed)
- `UpdateGoal` / `StartNewGoal` / `UpdatePlan` / `UpdateWorkflowProgress` — 모델 도구 입력 스키마
- `decodeWorkflowState`, `reconciledWorkflowPhase` — 저장된 상태 JSON 디코드와 phase 재조정
- `WorkflowStorageError` / `WorkflowTransitionRefused` / `WorkflowProgressRefused` / `NewGoalTransitionRefused`, `NewGoalSettlement` — 워크플로 오류와 새 Goal 정산 결과
- `evaluateWorkflowAction` / `workflowActions` / `WorkflowActionRequest` / `WorkflowActionReason` — phase 이동·pause/resume/stop 허용 판정(dual API)
- `CardStatus` / `StepProgressStatus` / `stepProgressStatus` / `CardRisk` / `cardContractFields` / `cardContract` / `BoardAuthor` / `CardHold` / `cardHoldFields` — 칸반 카드 상태와 카드 계약 스키마
- `Boards` — 프로젝트 보드 뷰 서비스(`BoardView`, `ProjectBoard`, `BoardCard`, `BoardRevision`, `BoardColumnCounts`)
- `BoardEdit` / `BoardIntent` / `CardDraft` / `CardPatch` / `UserChange` / `UserChangeRequest` / `BoardEditResult` / `BoardEditRefused` / `BoardEditPlan` — 보드 편집 스키마와 결과
- `planBoardEdit` / `planCardTransition` / `planCardHold` / `cardTransitions` / `planEnded` / `closedPlan` — 보드 편집·카드 전이 계획 함수
- `WorkflowExecution` — durable 연속 실행 의도 서비스, `WorkflowExecutionState`(idle|running|ready|retrying|blocked|stopped), `WorkflowBlocker`, `WorkflowExecutionFailed`
- `GoalExecution` — owner에 묶인 Goal SDK run의 durable `Workflow.make` 정의
- `GoalExecutionCompletion` — SDK 루프가 한 번 완료하는 `DurableDeferred` 대기 지점
- `GoalExecutions` / `goalExecutionLayer` / `GoalExecutionAdmissionRefused` — Goal 실행 admission 서비스와 레이어
- `GoalExecutionIdentity` / `GoalExecutionOwnerIdentity` / `GoalExecutionPayload` / `GoalExecutionSuccess` / `GoalExecutionError` / `GoalExecutionErrorReason` / `GoalExecutionSideEffectState` / `goalExecutionIdempotencyKey` — Goal 실행 계약 스키마와 멱등 키
- `ownerWorkflowEngineLayer` / `layer` / `admissionLayer` / `workflowName` / `OwnerWorkflowEngineError` — SqlClient 기반 프로젝트 소유 WorkflowEngine 레이어
- `OwnerWorkflowStorage` / `OwnerWorkflowStorageApi` / `ownerWorkflowStorageLayer` / `OwnerWorkflowAdmission` / `OwnerWorkflowAdmissionResult` / `StoredExecution` / `StoredWorkflowResult` / `ScheduledClock` / `OwnerWorkflowStorageError` — 실행·activity·deferred·clock 영속 저장소
- `sqliteRunLog` — session/run 바인딩을 확인하는 owner 전용 AG-UI 이벤트 전달 로그(`RunLog` 구현)
- `workflowRunEvents` / `RunEvent` / `RunEventKind` / `RunEventRejected` — run 이벤트(chunk|run_error|run_completed) 기록
- `workflowRunBindings` / `RunBinding` / `Admission` / `toolOperationSql` / `endedWithKnownEffectsSql` / `acknowledgedRunSql` / `resolvedRunSql` / `invocationFieldSql` / `recoveredReadRunSql` — run 바인딩 admission과 공유 SQL 조각
- `toolLedger` / `toolProgressFingerprint` / `uncertainRuns` / `UncertainContinue` / `UncertainRunsFailed` — tool 부수효과 ledger와 결과 불확실 run 처리
- `completionEvidence` / `CompletionSnapshot` / `CompletionRequest` / `CriterionMapping` / `Derived` — Goal 완료 근거 계산
- `planSchedule` / `PlanSchedule` / `planDependencyIssues` / `validatePlanDependencies` / `PlanDependenciesRejected` / `notStartedStatus` / `stalledEvidence` — Plan 의존성 검증과 실행 가능 step 스케줄
- `WorkflowRules` / `WorkflowRule` / `RuleSource` / `builtInWorkflowRules` / `projectWorkflowRules` / `skillWorkflowRules` / `structuredWorkflowRules` / `localWorkflowRules` / `projectWorkflowRulesPath` — 워크플로 규칙 해석과 소스 로딩
- `WorkflowTools` / `workflowInstructions` / `ProviderRetries` / `providerRetryLayer` / `providerRetryIdempotencyKey` / `providerRetryDelay` / `providerRetryLimits` — 모델용 워크플로 도구, 지시문 생성, provider 재시도 서비스

## Invariants

- `goalExecutionIdempotencyKey`는 sessionId·runId·goalInstanceId·workflowRevisionId만으로 키를 만든다. owner identity와 process generation은 fencing 용도이고 실행 identity가 아니다. 다른 owner의 같은 요청은 두 번째 workflow를 만들지 않고 같은 키로 충돌해야 한다. 키 형식은 `goal-execution-v1-<sha256>`이고 원본 identity나 사용자 내용을 담지 않는다.
- `GoalExecutionSideEffectState`에서 replay할 수 있는 것은 `Succeeded` receipt(`reuse_receipt`)뿐이다. `Pending`과 `Uncertain` 작업은 실행을 멈춘다(`disposition: stop`).
- `GoalExecutionCompletion`은 SDK 루프가 정확히 한 번 완료한다. workflow body를 replay해도 모델이나 tool을 다시 호출하지 않는다.
- owner admission에서 `bind`와 첫 durable workflow 요청은 한 트랜잭션에서 실행된다(`admitWith`, `admissionLayer`).
- 앱의 `SqlClient`만 연결과 writer를 소유하며 root가 공급한다. `ownerWorkflowEngineLayer`는 engine·admission·storage를 하나의 scoped graph로 묶는다.
- `sqliteRunLog`는 중앙 DB의 SqlClient를 써야 하며 worker 로컬 DB를 쓰면 안 된다. 인증은 HTTP route가 맡고, 이 로그는 `workflow_run_bindings`로 session/run 바인딩을 추가로 확인한다. receipt cursor는 로그 offset이 아니며, 재개 토큰은 이 namespace(`sdk-stream:v1:`)에 저장된 chunk만 만든다.
- 카드 이전에 저장된 Plan의 step status(`pending`/`completed`)는 읽기만 하고 제자리에서 다시 쓰지 않는다. 읽을 때 `pending`은 의존성이 끝났으면 ready, 아니면 backlog가 되고, `completed`는 `done`이 된다.
- `completed` phase는 서버가 소유하는 종료 phase이므로 사용자 이동 대상이 될 수 없다. execute 외의 phase 이동은 산출물을 승인하거나 바꾸지 않는다.
- execute phase 진입은 `plan.goalVersion === goal.version`이고 plan status가 `ready` 또는 `executing`일 때만 허용된다. lease가 다른 소유자면 `session_in_use`, run이 진행 중이면 phase 요청과 resume이 `run_in_progress`로 거부된다.
- 실행 가능 조건: phase가 execute 또는 verify이고, goal status가 active, plan status가 executing이며, plan의 goalVersion이 goal의 version과 같아야 한다.
- `WorkflowBlocker`로 모델이 기록할 수 있는 사유는 `user_decision`·`permission`·`external_dependency`·`repeated_failure`뿐이다. `dependency_stalled`와 `server_restarted`는 서버만 정한다.
- 턴을 끝내는 모델 텍스트로는 Plan이 완료되지 않는다(`WorkflowExecution` doc).
- hold된 카드는 의존성이 끝나도 backlog에 남고 루프가 배정하지 않는다. 카드 계약 필드(`cardContractKeys`)와 `hold`는 모델이 같은 step id로 replan해도 유지된다.
- `StartNewGoal`은 별도의 독립 성공 기준이다. `updateGoal`을 암묵적으로 해석해 만들어서는 안 된다.
- `toolOperationSql`은 `side_effect = 1`인 작업을 tool로 센다. fingerprint에 operation이 없어도 tool로 센다. 단, `middleware`와 `routedPersistence` operation은 owner bookkeeping이라 제외한다.
- 발화한 clock은 자신의 deferred를 void 성공으로 완료하고, 그 결과는 엔진이 인코딩하는 Exit 형태로 저장한다. workflow payload는 레코드 필드를 인코딩한 JSON 객체로 저장한다.

## Side Effects

- SQLite 읽기/쓰기(`owner_workflow_storage`): `owner_workflow_executions`, `owner_workflow_activities`, `owner_workflow_deferreds`, `owner_workflow_clocks`에 INSERT/UPDATE/SELECT
- SQLite 읽기/쓰기(`workflow.ts`): `session_workflows`, `workflow_state_revisions`, `workflow_goal_identities`, `workflow_goal_instances`, `workflow_new_goal_requests`, `board_change_requests`에 INSERT/UPDATE. `chat_runs`, `kanban_goals`, `work_tasks`, `owner_rpc_operations`, `workflow_run_bindings`는 조회
- SQLite 쓰기: `run-bindings.ts`는 `workflow_run_bindings`에, `run-events.ts`·`durable-stream.ts`는 `workflow_run_events`에, `tool-ledger.ts`는 `owner_rpc_operations`에 INSERT/UPDATE, `uncertain-runs.ts`는 `workflow_uncertain_acknowledgements`에 INSERT, `execution.ts`는 `chat_metadata`에 INSERT
- SQLite 읽기: `board.ts`, `completion-evidence.ts`, `read-recoveries.ts`가 `kanban_goals`, `sessions`, `nodes`, `chat_runs`, `chat_interrupts`, `owner_read_recoveries`, `workflow_goal_native_artifacts`, `workflow_goal_worker_generations`, `workflow_worker_dispatches` 등을 조회
- 타이머: `sqliteRunLog`는 열린 로그 끝에 도달한 reader가 20 millis 간격으로 새 항목을 polling한다. owner workflow engine은 `Clock`·`FiberMap`·`Scope`로 durable clock을 예약하고 발화하며 실행 fiber를 관리한다
- 암호화: `goalExecutionIdempotencyKey`가 `sha256`을 쓰고, `workflow.ts`는 `Crypto`/`NodeCrypto`로 id를 생성한다
- 파일 시스템: `sources.ts`가 프로젝트의 `.agents/workflow-rules.json`(`projectWorkflowRulesPath`)을 워크플로 규칙 소스로 읽는다. 이 항목은 export 이름으로만 확인했고 본문은 읽지 않았다

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
