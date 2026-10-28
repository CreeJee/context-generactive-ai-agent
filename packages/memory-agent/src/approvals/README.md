# approvals

## Overview

`approvals` 디렉터리는 도구 호출 안에서 도는 작업(하위 에이전트, 외부 에이전트)이 요청하는 승인을 페이지로 중계하는 서비스를 담는다. 이런 작업은 실행을 멈추지 못한 채 승인을 요청한다. `RelayedApprovals`는 승인 대기를 Effect Workflow 실행(`RelayedApprovalExecution`)으로 저장한다. 대기는 `DurableDeferred` 결정과 `DurableClock` 시간 초과의 경주로 이루어지므로 프로세스가 재시작돼도 남는다. `relayed-state.ts`는 브라우저에서도 import할 수 있는 뷰 타입과 요청자 스키마만 둔다.

## Interface

- `RelayedApprovals` — `Context.Service` 태그(`memory-agent/approvals/relayed/RelayedApprovals`). 서비스는 `ask`, `pending`, `answer`를 가진다.
- `RelayedApprovals.layerWith({ timeoutMs? })` — 서비스 레이어와 워크플로 핸들러 레이어를 합친다. `ownerWorkflowEngineLayer`를 provideMerge하고 `NodeCrypto.layer`를 제공한다. 기본 시간 초과는 1일이다.
- `RelayedApprovals.layer` — 기본 옵션으로 만든 `layerWith()` 레이어
- `ask(sessionId, runId, request, signal)` — 승인 대기 워크플로를 서비스 scope에 fork하고 `Fiber<boolean>`을 돌려준다. 승인되면 true, 거절·시간 초과·중단이면 false다.
- `pending(sessionId)` — 해당 세션의 대기 중인 실행을 `RelayedApprovalView[]`로 돌려준다. 목록은 `createdAt` 오름차순이다.
- `answer(sessionId, approvalId, approved)` — `DurableDeferred`에 결정을 기록하고 실행을 재개한다. 다른 세션, 시간 초과, 알 수 없는 승인이면 false를 돌려준다. 같은 값으로 다시 답하면 true다.
- `RelayedRequest` — `RelayedApprovalView`에서 `id`와 `createdAt`을 뺀 요청 타입
- `ApprovalRequester` — `Schema.TaggedUnion`이다. `subagent { subagentId, name }` 또는 `external_agent { agent }`를 담는다(`relayed-state.ts`).
- `RelayedApprovalView` — 페이지가 보는 승인 뷰 인터페이스다. 필드는 `id`, `requester`, `toolName`, `argumentsJson`, `reason`, `askedBy`(`review`|`every_call`|`agent`), `createdAt`이다.

## Invariants

- `relayed-state.ts`는 브라우저에서 import해도 안전해야 한다(파일 주석). `effect`의 `Schema` 외에 Node 전용 의존성을 넣지 말 것.
- 워크플로 이름 `RelayedApprovalExecution`, deferred 이름 `RelayedApproval/Decision`, race 이름 `RelayedApproval/DecisionOrTimeout`, clock 이름 `RelayedApproval/Timeout`은 저장된 실행과 맞물린다. 이름을 바꾸면 남아 있는 대기를 찾지 못한다.
- idempotencyKey는 `${sessionId}\u0000${runId}\u0000${approvalId}`이다. 실행 id가 이 키에서 나온다.
- `RelayedApprovalPayload` 스키마는 저장된 `execution.payload`를 디코드하는 데 쓰인다. 디코드에 실패한 실행은 `find`와 `pending`에서 조용히 빠진다. 필드를 바꿀 때 기존 행과의 호환성을 지켜야 한다.
- 대기는 호출자가 아니라 서비스 scope에 속한다(`Effect.forkIn(..., scope, { startImmediately: true })`). 호출자가 중단돼도 대기는 끝나지 않으며 취소는 `signal`로만 한다.
- `signal` abort가 오면 `RelayedApprovalExecution.interrupt(executionId)`로 실행을 중단하고 false를 돌려준다. 실행 id를 해시하는 동안 이미 온 abort는 리스너 등록 직후 `signal.aborted`로 다시 확인한다.
- 프로세스나 레이어가 취소 없이 재시작되면 대기 race가 보존된다. 소유자 취소만 실행을 중단한다(주석).
- interrupt 원인은 승인 거절(false)로 바뀐다(`Effect.catchCauseIf(Cause.hasInterrupts, ...)`). 시간 초과도 false다.
- `answer`는 이미 저장된 deferred 결과가 있으면 새로 쓰지 않고 같은 값인지만 비교한다. 실행 상태가 `completed`나 `interrupted`면 false를 돌려준다.
- `DurableClock.sleep`은 `inMemoryThreshold: Duration.zero`를 쓴다. 따라서 시간 초과는 항상 durable clock으로 저장된다.
- `approvalId`는 `crypto.randomUUIDv4()`로 만든다. 실패하면 답이 아닌 defect로 처리한다(`Effect.orDie`).
- 서비스는 `WorkflowEngine.WorkflowEngine`, `Crypto.Crypto`, `OwnerWorkflowStorage`, `Scope`를 요구한다. `layerWith`가 엔진·저장소 레이어와 `NodeCrypto`를 함께 묶는다.

## Side Effects

- `OwnerWorkflowStorage`로 워크플로 실행 영속 저장소를 읽는다. 호출은 `workflowExecutions`, `pendingExecutions`, `deferredResult`다.
- `WorkflowEngine`으로 실행을 생성·재개·중단한다. 호출은 `execute`, `interrupt`, `DurableDeferred.succeed`이며 owner workflow engine 저장소에 쓰기가 생긴다.
- `DurableClock.sleep`으로 durable 타이머를 건다. 기본값은 1일이다.
- `ask`는 서비스 scope에 fiber를 fork한다.
- `AbortSignal`에 `abort` 이벤트 리스너를 등록하고, 완료나 중단 시 해제한다.
- `Clock.currentTimeMillis`로 현재 시각을 읽는다.
- `NodeCrypto`로 UUIDv4를 생성한다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
