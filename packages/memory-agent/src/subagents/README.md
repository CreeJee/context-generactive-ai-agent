# subagents

## Overview

`packages/memory-agent/src/subagents`는 부모 에이전트 run이 하위 에이전트에게 일을 맡기는 기능(R18)을 구현한다. 하위 에이전트는 일회성일 수도 있고, 세션 안에서 자기 대화를 유지하는 이름 붙은 helper일 수도 있다. 하위 에이전트는 중첩되지 않는다.

`subagents.ts`의 `Subagents` 서비스는 부모 모델에게 `run_subagent`, `resume_subagent`, `get_subagent_reports` 도구를 제공한다. 자식에게만 주는 도구는 없다. 이 서비스는 자식 run을 백그라운드 fiber로 `runChat`에 돌리고, 그 상태를 SQLite `subagents` 표와 Work Trace(task/attempt)에 기록한다. 자식의 대화는 부모 세션 아래의 세션(`sessions.parent_session_id`)이고, 메시지와 도구 결과는 메인 대화처럼 그 세션의 기억 node가 된다. `role.ts`는 자식에게서 부모 전용 도구를 걸러 내고, `subagent-state.ts`는 채팅 화면(브라우저)이 쓰는 상태 타입을 정의한다.

이 서비스는 `packages/memory-agent/src/layers.ts`의 `memoryAgentLayerBody`, `packages/memory-agent/src/kanban/subagent-card-agent.ts`, `packages/memory-agent/eval/live-delegation.ts`가 사용한다.

## Interface

- `Subagents` — `Context.Service`이며 `Subagents.layer`가 `make`(Effect.gen)로 만든다. 하위 에이전트 도구 묶음과 실행 관리를 제공하고, 의존 서비스는 SqlClient, AppEvents, ActiveProvider, ApiUsage, PermissionClassifier, PermissionReviews, RelayedApprovals, WorkTraceStore, CodeTools, RunStore, SecureRandom.SecureRandom이다.
- `subagentToolNames` — 부모 쪽 도구 이름 상수 `["run_subagent", "resume_subagent", "get_subagent_reports"] as const`.
- `subagentInstructions` — 부모 모델에게 위임 규칙(백그라운드 실행, polling 금지, 보고서는 사용자 승인이 아님 등)을 알리는 시스템 프롬프트 문자열.
- `childInstructions` — `EffectFunction.dual(2)`로 만든 함수. `(name, instructions)`를 받아 자식 에이전트의 자기소개 프롬프트를 만든다.
- `SubagentOperationFailed` — `Schema.TaggedError`이며 필드는 `operation: "store"`, `cause: Defect`.
- `childFailureOf` — 자식 run의 `RUN_ERROR` code로 보고서의 실패 이유(`AttemptFailureReason`)를 정한다.
- `subagentThreadId` — `` (subagentId) => `subagent-${subagentId}` ``로 자식 대화 thread id를 만든다.
- `SubagentBinding` — subagent 도구 호출이 속한 부모 run 정보(project, sessionId, runId, selection, abortSignal, tools, systemPrompts, gated, origin). `origin`은 자식 지시가 부모의 subagent 호출이 아닌 곳에서 올 때의 출처 node다(카드 에이전트와 검증자의 Plan 버전 node).
- `SubagentReceipt` — 도구 호출이 부모 모델에게 돌려주는 receipt(status, subagentId, agent, taskId, attemptId, delivery).
- `SubagentReport` — `get_subagent_reports`가 돌려주는 보고서 union 타입이며 `SubagentReceipt`와 `SubagentStatus`를 기반으로 한다. 답이 있는 보고서는 자식 세션의 진행 메모(`memo`, `memoView` 모양)도 담는다.
- `childRunTools` (`role.ts`) — `RunTool` 배열에서 부모 전용 도구(`start_new_goal`, `update_goal`, `edit_goal`, `update_plan`, `edit_plan`, `close_plan`, `delegate_to_agent`, `cancel_background_task`, `get_background_result`, `update_memo`)를 뺀다. 부모의 `update_memo`는 부모 세션의 메모를 쓰므로, 자식은 자기 세션에 묶인 `update_memo`를 따로 받는다.
- `SubagentStatus` (`subagent-state.ts`) — `"running" | "completed" | "failed" | "cancelled" | "interrupted"` Schema.
- `SubagentView` (`subagent-state.ts`) — 채팅 화면이 보는 하위 에이전트 상태 Schema(id, name(일회성이면 null), status, lastTask, lastAnswer, error, createdAt, updatedAt).
- 내부 모델 도구 정의(export 아님) — `run_subagent`(task, agent, instructions, ownership, acceptanceCriteria), `resume_subagent`(taskId, expectedAttemptId, confirmUncertain), `get_subagent_reports`(attempts 1~100).
- 하위 디렉터리 없음.

## Invariants

- `subagent-state.ts`는 브라우저에서 import해도 안전해야 한다(파일 주석). 이 파일에 서버 전용 의존성을 넣지 않는다.
- 하위 에이전트는 중첩되지 않는다(`Subagents` doc: "never nested", `run_subagent` 설명: "it cannot start subagents"). `childRunTools`는 `delegate_to_agent` 등 부모 전용 도구를 자식에게서 제거한다. 세션 Goal, Plan, workflow 진행, 최종 답은 부모가 맡는다.
- 자식은 부모와 같은 model, project, tools, permissions를 쓴다. 위임으로 권한이 넓어지지 않는다. 부모 에이전트의 task 메시지는 사용자 승인이 아니므로 위험한 동작은 평소대로 approval을 거친다. 자식의 gated 호출은 부모 페이지로 relay되어 묻는다. 도구의 `CallPlan`이 `Ungated`로 정한 호출은 relay하지 않는다.
- 자식 요청은 메인 대화와 같은 `compactionHook`을 같은 모델 창 예산(`budgetFor`)으로 거친다. 그래서 대화 compaction의 기준이 바뀌면 자식도 같이 바뀐다. 근거도 대화와 같이 자식 세션의 node다(`nodes.toolResultIds`). 뺀 도구 결과는 `read_evidence`/`read_tool_result`로 다시 읽는 pointer가 되고, 아직 node로 기록되지 않은 결과는 대화와 같이 다시 읽을 곳이 없어 빼지 않는다. 자식에게는 모델 handoff가 없다. `/compact` 기록도 쌓이지 않는다. 뺀 부분은 대화와 같이 자식 세션의 요약에 이어 쓰고, 같은 모델의 가장 싼 강도로 요청해 `summary` usage로 기록한다. 앞 요청에 새 메시지만 붙이는 것도 대화와 같지만, 자식은 `LastRequests`를 넘기지 않으므로 run 안에서만 이어 붙인다. 모델 입력만 바꾸고 저장된 자식 transcript는 바꾸지 않는다.
- 실패한 자식 보고서의 이유는 `RUN_ERROR` code로만 정한다. `repeated_tool_call`은 `RepeatedToolCall`, `context_limit_exceeded`는 `ContextLimitExceeded`, 그 밖의 code는 `ModelRunError`다. run의 텍스트는 provider 본문을 담을 수 있어 읽지 않는다. 부모는 `ContextLimitExceeded`를 보면 남은 일을 작게 나눠 다시 맡긴다(`subagentInstructions`).
- 입력 제약이 있다. `agent` 이름은 `/^[A-Za-z0-9_-]{1,40}$/`, `attempts`는 1~100개, `offset`은 0 이상 정수이고 기본값은 0이다. named helper의 `instructions`는 이전 값을 대체하고, 생략하면 기존 값을 유지한다.
- `resume_subagent`는 최신 failed 또는 interrupted attempt(`expectedAttemptId`)만 재시도한다. `confirmUncertain`의 기본값은 false이며, 사용자가 중복 부작용 가능성을 받아들인 뒤에만 true로 둔다. 완료된 tool 호출은 다시 실행하지 않고, 이전 approval은 이어지지 않는다.
- `SubagentRow` status literal 집합은 `SubagentStatus`와 같아야 한다. 이 행은 `subagents` 표 컬럼(id, session_id, name, instructions, status, last_task, last_answer, error, ...)을 decode한다.
- 서비스가 시작될 때(`make`) `subagents` 표의 running 행을 `interrupted`로 바꾼다.
- 같은 이름의 helper 메시지는 `keyedSerialLimit`로 직렬화한다. 직렬화 해제는 자식 run의 실제 결과 시점에 해야 하며, Effect interruption만으로 해제하면 다음 메시지가 겹친다.
- 자식 thread id 형식은 `subagent-${subagentId}`이고 테스트도 이 형식에 의존한다. 자식 세션의 id도 같다. 첫 run 전에 부모 세션의 project로 `sessions` 행을 만든다(`parent_session_id` = 부모).
- 자식 세션에는 `user` node가 없다(docs/decisions.md 2026-11-13). 지시는 사용자가 아니라 부모의 말이라, `user` node면 사용자 말을 정정·철회할 권한이 생긴다. 자식의 assistant node는 지시가 나온 node에 `reply` edge를 잇는다. 채팅 자식은 attempt를 시작한 부모의 `run_subagent`/`resume_subagent` 호출 node(`agent_invocations.parent_tool_call_id`)다. 부모는 step이 끝날 때 기록하므로 잠깐(100ms 간격 10번) 다시 찾고, 없으면 edge 없이 남긴다. 카드 에이전트와 검증자는 `SubagentBinding.origin`의 Plan 버전 node다.
- 자식은 자기 세션의 진행 메모(`ProgressMemos`)를 `update_memo`로 쓰고, 그 메모는 대화처럼 compaction 다음에 요청 끝에 붙는다. 보고서는 답과 함께 그 메모를 부모에게 돌려준다.
- 자식은 부모 run의 기억 도구를 그대로 받는다. `read_tool_result`는 세션 트리(부모와 자식들)의 결과를 열므로 자식은 자기 결과를, 부모는 자식 결과를 연다.

## Side Effects

- SQLite `subagents` 표를 다룬다. 시작 시 running 행을 `UPDATE ... status = 'interrupted'`로 바꾼다. `INSERT INTO subagents`로 행을 만들고, status, instructions, last_answer, error, updated_at을 `UPDATE`한다. `SELECT`는 session_id에 name 또는 id를 더해 조회하고, 목록은 `created_at, rowid` 순으로 가져온다.
- `WorkTraceStore`에 task, attempt, event를 기록한다. 실행 중에는 `trace.keepAlive(handle)` heartbeat를 scoped fiber로 fork한다. attempt 종료 event로 `attempt_completed`, `attempt_cancelled`, `attempt_failed`를 쓰고, `write_file`/`edit_file` 결과(path, sha256)를 `ArtifactLocator`로 다룬다.
- SQLite `sessions`에 자식 세션 행을 INSERT한다(있으면 그대로). `Recorder` hook이 자식 세션에 assistant·tool_call·tool_result node와 구조 edge를 쓴다. 출처를 찾으려고 `agent_invocations`를 SELECT한다.
- `RunStore`(`finishedRun`)에 자식 run을 저장한다. `AppEvents.publishSession`으로 세션 이벤트를 발행한다.
- 자식 모델 run은 `runChat`과 `ActiveProvider`를 통해 LLM provider를 호출한다(네트워크). `ApiUsage` hook으로 사용량 ledger를 기록한다.
- 자식 tool 호출은 `runTool`과 `CodeTools`를 통해 공유 workspace의 파일을 읽고 쓸 수 있다. 권한은 `PermissionClassifier`, `PermissionReviews`, `RelayedApprovals`(`ApprovalRequester`)를 거친다.
- `Subagents.toolsFor`의 `hook`은 run이 시작할 때 끝나지 않은 자식을 다시 시도한다. 상태 알림을 대화에 넣고 돌려주는 일은 `agent/task-notifications.ts`가 백그라운드 작업의 끝과 함께 맡는다.
- 동시성 자원으로 `FiberMap`(activeChildren)을 쓰고, 자식 fiber를 `Effect.forkScoped`/`Effect.forkIn`으로 백그라운드 실행하며 `Deferred`로 결과를 기다린다. `PubSub.unbounded` completions 채널에는 sessionId로 완료 알림을 publish한다. 취소 경로에는 `AbortSignal`과 `Effect.interrupt`가 있다.
- `Clock.currentTimeMillis`로 시각을 읽고, `SecureRandom.SecureRandom`으로 id를 생성한다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
