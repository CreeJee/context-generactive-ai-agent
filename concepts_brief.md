# Workflow 계층 개편 (owner 엔진·Goal 상태·칸반)

- **Author:** CreeJee
- **Date:** 2026-10-28

## Overview

`packages/memory-agent`의 workflow 계층을 실제 사용 시나리오 기준으로 다시 본다. 대상은 프로젝트가 직접 만든 durable `WorkflowEngine`(`workflow/owner-workflow-engine.ts`), Goal/Plan 상태(`workflow/workflow.ts`), 칸반이다. 사용자가 바라는 것은 다섯 가지다.

- 안정성
- 메모리 누수 제거
- Effect가 권하는 방식으로 성능 개선
- "Goal이 안 바뀐다" 같은 실제 장면이 끝까지 가는 것
- 0.0.17(마지막 정식 릴리즈, 2026-10-20) 사용자가 업그레이드해도 진행 중 항목이 체감 없이 이어지는 것

평가 기준은 병렬 진행과 사용성이다.

처음 목적은 이렇다(2026-10-29 사용자 설명). Plan을 만들면 여러 작업이 병렬로 돌면서 서로 자연스럽게 맞물리고 끝까지 완결된다. 쓰기 불편하지 않고, 조건이 맞으면 바로 다음으로 넘어간다. 한 저장소에서 여러 작업이 같은 파일을 고치는 충돌 때문에 카드마다 git worktree를 쓰게 됐다. 그런데 worktree마다 `node_modules`가 늘고 정리가 잘 안 되는 불편이 생겼다(Orca 워크플로와 칸반에서 겪음).

처음 가설은 시나리오 표를 만들어 막히는 곳과 엔진 누수를 고치고, 공식 `ClusterWorkflowEngine` + `SingleRunner`로 바꿀지도 그 표로 정하는 것이었다. Goldfish 6명(YAGNI, 비용·성능, 사용성, 마이그레이션, 관측, 기술 부채)이 각자 독립적으로 이 가설을 검토했다. reviewer들은 엔진을 고쳐 쓰자고 했다. 사용자는 공식 엔진으로 옮기는 목표를 유지하고, 교체 비용 중 둘(admission 결합, 조회 결합)을 먼저 없애기로 정했다(2026-10-28). 막힘은 엔진이 아니라 Goal 상태 기계에서 찾는다. 2026-10-29에는 그보다 앞에 지금 엔진과 Goal 상태 기계의 정상화를 두기로 정했다(결정 11).

## Analysis

### 1. 처음 가설에서 틀린 사실

- **activity scope는 샌다고 했지만 닫힌다.** `Workflow.intoResult`가 context의 `activityInstance` scope를 Complete나 실패 때 닫는다(`Workflow.ts:689-690`, `737-745`; 엔진 `:414-416`). 열린 채 남는 것은 Suspended로 끝난 pass뿐이다. (6명 모두 지적)
- **`layerMemory`는 본보기가 아니다.** 이것도 `executions`·`activities`·`deferredResults`에서 아무것도 지우지 않고, 문서에도 production용이 아니라고 적혀 있다(`WorkflowEngine.ts:688-689`, `722`, `727`, `787`). 정리의 본보기는 cluster 엔진이다. idle entity를 10초 뒤 내리고, activity 항목을 지우며, `RcMap` idle TTL은 5분이다(`ClusterWorkflowEngine.ts:143-160`, `540`, `685`, `865-869`).
- **`reconciledWorkflowPhase`는 이상 세션을 고치지 않는다.** phase가 execute·verify가 아니면 그대로 돌려주고(`workflow.ts:439`), plan이 completed나 blocked이면 저장된 phase를 돌려준다(`:442-445`). `goal.status`는 읽지 않는다. 따라서 로컬 DB의 이상 세션 6개는 읽을 때만 보이는 현상이 아니라 저장된 상태다. (6명 모두 지적)
- **"새 Goal 전환은 한 번도 안 돌았다"는 증명되지 않았다.** `workflow_new_goal_requests`에는 도구 경로 `requestNewGoal`만 쓴다(`workflow.ts:944-979`). 직접 경로 `startNewGoal`은 이 표에 행을 남기지 않는다(`:934-941`). `requestNewGoal`의 거절(`run_outcome_uncertain`, `transition_pending`, `workflow_changed`)도 INSERT 전에 돌아가므로 흔적이 없다(`:960-973`).
- **"그때는 DatabaseSync, 지금은 SqlClient"라는 대비는 약하다.** `docs/kanban-orchestration.md:100`은 10-18에 이미 "공유 SqlClient(같은 DatabaseSync 위)"라고 적었다. 2026-10-10 EFX-02가 공식 엔진을 거절한 이유(owner run binding과 첫 durable 요청을 한 transaction에 묶을 수 없음)가 풀렸다는 근거는 아직 없다. cluster의 `execute`는 `RcMap` entity client를 거쳐 `Sharding.sendOutgoing`으로 저장한다(`ClusterWorkflowEngine.ts:592-609`). 그 저장이 호출 fiber의 transaction에 들어가는지는 아무도 확인하지 못했다.

### 2. 엔진의 실제 결함

- **🔴 `awaitComplete`가 없어서 대기하는 호출자가 poll한다.** (Elephant 확인: `WorkflowEngine.ts:563-583`)
  - owner 엔진은 `makeUnsafe`에 `awaitComplete`를 넘기지 않는다(`owner-workflow-engine.ts:313-479`). 그래서 non-discard `execute`는 결과가 Suspended인 동안 `suspendedRetrySchedule`(기본 200ms에서 1.5배씩, 상한 30초) 간격으로 `run`을 다시 부른다.
  - owner 엔진에서 `run` 한 번은 `storage.admit` transaction, `resumeExecution`, 본문 replay, `setRunning`/`setResult` 쓰기다. 그리고 `Scope.fork(ownerScope)`로 닫히지 않는 scope를 하나 만든다(`:230-263`).
  - 이렇게 기다리는 곳은 다음과 같다.
    - `RelayedApprovalExecution`(`approvals/relayed.ts:131`, 승인 timeout 1일 `:204`)
    - `ProviderRetryWait`(`workflow/provider-retry.ts:145`, 대기 최대 30분, 한도 24시간)
    - `GoalExecution`의 `succeed`/`fail`(`goal-execution.ts:145`, `162`)
  - 결과는 두 가지다.
    - 사용자가 승인해도 기다리던 도구는 최대 30초 늦게 이어진다.
    - 하루짜리 승인 대기 하나가 replay와 열린 scope를 약 2,880개 남길 수 있다(사용성 reviewer의 계산). 누수 단위는 처음 가설의 "resume마다"가 아니라 "poll tick마다"다.
- **🟡 그 밖의 누수**
  - `liveExecution`이 만든 scope는 쓰이지 않고 바로 교체돼 실행마다 하나씩 남는다(`:196`, `:233`).
  - `executions` Map에서 지우는 곳이 없다(`:151`, `:207`). `state.fiber`는 끝난 fiber와 그 결과를 계속 잡고 있다(`:68`, `:263`).
- **🟡 고칠 때 지켜야 할 제약이 둘 있다.**
  - 단순히 Map에서 지우면 child→parent wake가 깨진다. 이 wake는 부모를 Map에서 찾는다(`:254-260`).
  - 새 instance를 넣는 일과 interrupt 표시를 옮기는 일은 yield 없이 한 번에 일어나야 한다(`docs/decisions.md:2935`).
- **🟡 죽은 실행과 살아 있는 실행이 모두 `running`이다.** `setRunning` 뒤 run이 `defect`(`orDie`, `:138-145`)로 죽으면 `running`으로 남는다. 앱을 시작할 때마다 register가 이 실행을 다시 resume하므로(`:338-343`) 같은 실패가 조용히 되풀이될 수 있다. `deferredDone`에서 fork한 wake(`:448`)는 아무도 join하지 않는다.
- **🟡 같은 key의 요청이 동시에 오면 죽는다.** `HumanDecisionExecution`의 payload에 `createdAt`이 들어 있다(`kanban/human-decision.ts:233`, `517`). 같은 key로 동시에 요청하면 payload가 달라 `execution_conflict`가 되고(`owner-workflow-storage.ts:264-269`), 이 오류는 `orDie`로 죽는다. 그런데 `human-decision.ts:566`의 주석은 "its payload wins"라고 적고 있다.

### 3. 성능: 엔진보다 먼저 볼 hot path

- **🟡 run 로그 polling**
  - `sqliteRunLog` reader는 로그 끝에서 20ms마다 SELECT 3개짜리 transaction을 돈다(`workflow/durable-stream.ts:18`, `117-122`, `177-183`). 기다리는 reader 하나가 공유 연결을 초당 50번 잡는다.
  - append는 chunk마다 문장 4개이고, 바뀌지 않는 binding을 매번 다시 확인한다(`:31-33`, `118`, `149-159`).
  - 같은 프로세스이므로 writer가 `PubSub`나 `Latch`로 reader를 깨우면 된다. `AppEvents`가 이미 이 방식이다(`decisions.md:2924`). polling은 1초 이상 간격의 대비책으로만 남긴다.
- **🟡 이력 전체를 매번 다시 읽는다**
  - `workflowExecutions(name)`은 그 workflow의 모든 행을 읽고 decode한다(`owner-workflow-storage.ts:170-176`, `325-328`). 부르는 곳은 승인 응답(`relayed.ts:90-102`), 재시도 번호 계산(`provider-retry.ts:191`), 오케스트레이터 조회(`human-decision.ts:424-437`)다.
  - 지우는 행은 clock뿐이다(`owner-workflow-storage.ts:229-235`). 그래서 쓸수록 느려진다.
- **🟢 트랜잭션 안의 잠금**
  - `Workflows.locked`는 `keyedSerialLimit` 안에서 읽기가 든 `withTransaction`을 돈다(`workflow.ts:473-474`).
  - 비용 reviewer는 이것이 `decisions.md:2922`와 어긋난다고 본다. YAGNI reviewer는 그 규칙이 `Ref.modify` 확인-변경에 대한 것이라 해당하지 않는다고 본다. 판단이 필요하다.

### 4. 공식 엔진으로 교체: 지금 바로 하면 비용이 크다

6명 중 6명이 "시나리오 표 통과로 교체를 정하지 말라"고 했다. 시나리오 표에 오를 막힘은 phase, `goal.status`, `plan.status`, `WorkflowExecutionState`(chat_metadata)의 조합에서 생긴다(`execution.ts:103-107`). 어느 엔진을 써도 같은 결과가 나오므로, 두 엔진이 같은 표를 통과해도 실제 차이는 표에 드러나지 않는다.

교체 비용은 다섯 가지다.

- **🔴 진행 중 행을 cluster 내부 형식으로 손수 만들어야 한다.**
  - 실행 하나가 여러 행이 된다: run 요청과 Suspended reply, deferred마다 요청·reply 쌍, `DeliverAt`이 붙은 clock 메시지, interrupt는 status 열이 아니라 `Workflow/InterruptSignal` deferred(`ClusterWorkflowEngine.ts:285-305`, `410-415`, `692-723`, `771-792`).
  - 행마다 Snowflake id와 `shard_id`가 필요하다(`SqlMessageStorage.ts:126-150`, `465`). 모듈은 `@stability unstable`이고, envelope 형식은 이미 한 번 바뀌었다(`ClusterWorkflowEngine.ts:7`, `854`).
  - cluster 표는 Effect가 `cluster_migrations`로 따로 migrate한다(`SqlMessageStorage.ts:820-838`). 앱의 `user_version` 체계 밖이다.
- **🔴 앱 코드가 엔진 저장소를 조회 모델로 쓴다.** `RelayedApprovals`, `ProviderRetries`, `HumanDecisions`, `GoalExecutions`가 `OwnerWorkflowStorage`를 직접 읽는다(`relayed.ts:92`, `157`, `174`; `provider-retry.ts:132-133`, `191`; `human-decision.ts:355`, `418`, `425`; `goal-execution.ts:77`). cluster에는 workflow별 목록 API가 없다. 특히 `provider-retry.ts:191`은 재시도 순번을 저장된 실행 수로 정하고, 이 값이 멱등 키에 들어간다.
- **🟡 owner 펜스가 사라진다.** 지금은 같은 executionId에 다른 payload가 오면 `execution_conflict`를 거쳐 `owner_mismatch`로 거절된다(`goal-execution.ts:118-123`, README Invariants). cluster의 `run`은 primaryKey `""`로 중복만 거르고 payload는 비교하지 않는다(`ClusterWorkflowEngine.ts:881`).
- **🟡 공유 연결에 배경 부하가 상시 생긴다.**
  - `SingleRunner` 기본값은 shard 300개, lock 갱신 10초, 할당 갱신 3초, reply poll 200ms, message poll 10초, lock 만료 35초다(`ShardingConfig.ts:183-199`).
  - sqlite에서는 갱신 때마다 heartbeat와 300행 UPDATE가 돈다(`SqlRunnerStorage.ts:501-507`, `615-631`).
  - clock 발화가 10초 message poll에 묶이면 provider 재시도 첫 대기 2초가 약 10초가 된다(미확인).
  - 설정은 `layerFromEnv`로 접두사 없는 `HOST`, `PORT`, `SHARDS_PER_GROUP`을 읽는다(`SingleRunner.ts:78`, `ShardingConfig.ts:255-289`, `373-396`). 사용자의 셸 환경이 shard 배치를 바꿀 수 있다.
  - `SqlRunnerStorage`는 tracer를 끈다(`:37`).
- **🟢 교체해도 unstable에서 벗어나지 못한다.** 지금 엔진도 unstable인 `makeUnsafe`와 `makeDeferredState`를 쓴다(`:154`, `:313`). 엔진 밖에 직접 만든 durable 표 7개도 그대로 남는다.

cluster 엔진의 장점도 있다. `awaitComplete`, idle 해제, envelope 안의 trace id가 기본으로 들어 있다. 이 셋은 owner 엔진에 같은 방식으로 넣을 수 있다.

**가장 강한 반론(비용 reviewer):** `GoalExecution`은 deferred 하나뿐이고(`goal-execution.ts:57-58`), 지금까지 durable 실행은 모두 73건이다. 엔진은 병목이 아니다. 교체하면 배경 쓰기와 지연이 늘고, 얻는 것은 측정된 적이 없다.

**지금 엔진 정상화와 비교 (2026-10-29)**

둘 중 하나를 고르는 문제가 아니라 순서의 문제다. 정상화를 먼저 하고, 교체는 그 뒤 spike로 정한다(결정 11).

- **교체해도 남는 것.** 사용자가 겪는 문제 대부분은 엔진과 무관하다.
  - Goal 전환 막힘(`workflow.ts` 상태 기계)
  - 칸반 worktree 정리
  - run 로그 20ms polling
  - 엔진 밖에 직접 만든 durable 표들
- **drain 동안에도 owner 엔진이 돈다.** 0.0.17의 진행 중 행은 owner 엔진이 끝까지 처리한다. `HumanDecision`에는 기한이 없어 owner 엔진이 오래 살 수 있다. 정상화 없이 교체하면 그 기간 내내 owner 엔진의 누수와 poll 버그가 사용자에게 보인다.
- **정상화에서 교체 때 버려지는 몫은 작다.**
  - 1단계 항목 중 owner 엔진 전용은 `awaitComplete`, `executions` Map 정리, scope 수명뿐이다. 이것도 위의 drain 때문에 완전히 버려지지는 않는다.
  - 나머지(상태 기계, 시나리오 suite, 관측, worktree 정리)는 교체 뒤에도 쓴다. 시나리오 suite와 관측은 교체를 검증하는 도구가 된다.
- **정상화를 건너뛰고 바로 교체할 때의 비용**
  - 사용자가 겪는 버그가 2단계, spike, drain이 끝날 때까지 남는다.
  - 교체를 검증할 도구 없이 바꾼다.
- **정상화 뒤 교체로 얻는 것**
  - 소유 코드 974줄이 준다(`owner-workflow-engine.ts` 515줄, `owner-workflow-storage.ts` 459줄).
  - durable 동작(activity, clock, deferred, interrupt, resume gate)을 upstream이 관리한다.
  - pre-release의 `WorkflowEngine` interface가 바뀌어도 Effect가 함께 맞춘다.
  - 이 이득이 drain 비용과 Effect 버전마다 바뀌는 cluster 저장 형식의 위험만큼 가치가 있는지는 3단계 spike가 답한다.

### 5. "Goal이 안 바뀐다"와 막힌 세션

- **🔴 원인 후보가 셋인데, 지금은 어느 것인지 볼 수 없다.**
  - `requestNewGoal`의 거절은 흔적 없이 돌아간다(`workflow.ts:960-973`).
  - run이 `running`이나 `interrupted`이면 `settleNewGoalRequest`가 계속 `accepted`를 돌려준다(`:996-1001`). 다시 정산하지 않으면 `startNewGoal`이 `transition_pending`으로 계속 거절한다(`:938`, `:962`). 업그레이드 뒤 0.0.17의 승인 대기 run을 새 loop가 재개하지 못하면 이 상태가 풀리지 않는다(`decisions.md:2819`).
  - 칸반 보드에서는 `updateGoal`이 phase를 유지한다(`:1055-1059`).
- **🟡 이상 세션 6개는 정상 경로에서 생길 수 있다.**
  - `updateProgress`는 goal과 plan의 status만 바꾸고 phase는 그대로 둔다(`workflow.ts:1294-1334`).
  - `finish`는 `stopped{completed}`를 chat_metadata에만 쓴다(`execution.ts:300-305`).
  - phase를 `completed`로 바꾸는 곳은 verify에서 시작한 정산뿐이다(`workflow.ts:840-846`, `919-922`).
  - 반대로 칸반 Goal은 카드가 모두 done이면 merge queue와 Goal 검증으로 넘어가므로(`kanban-orchestration.md:86-90`), 정상적인 merge 대기일 수도 있다. 칸반 여부, revision 시각, 그 상태를 쓴 코드 경로로 6개를 분류해야 한다.
- **🟡 이상 상태를 잡는 검사가 없다.** `tools/chat-store-check`는 "실패 없음"으로 끝났다(`decisions.md:2946`). 그런데 이상 세션은 6개다. 이 조합을 보지 않는 것으로 보인다(추정).

### 6. 관측: 지금은 잴 수 없다

- **🔴 시나리오 소요 시간을 잴 데이터가 없다.**
  - 실행 행 INSERT·UPDATE는 시각을 쓰지 않는다(`owner-workflow-storage.ts:272-276`, `333-358`).
  - `WorkflowExecutionState`에는 `retryAt` 말고 시각이 없다(`execution.ts:48-69`).
  - 엔진의 resume·wake·clock 함수는 모두 `Effect.fnUntraced`다(`owner-workflow-engine.ts:170-311`).
- **🟡 누수를 고쳤는지 보여 줄 지표가 없다.** `executions` 수, `runs`·`clocks` FiberMap 크기, `ownerScope`의 자식 scope 수를 볼 수 없다. 기존 `context_agent_execution_*` gauge 방식(`runtime/execution-admission.ts:62-71`)을 그대로 쓸 수 있다.
- **🟡 Goal 전환이 막혔다는 신호가 없다.** 가장 오래된 `accepted` 요청의 나이를 보여 주는 gauge도, 거절 reason별 카운터도 없다.

### 7. 0.0.17 업그레이드

- **🔴 기준선이 없다.**
  - 로컬 DB에는 대기 중인 durable 행이 0건이라 업그레이드를 시험할 표본이 없다.
  - 선례가 있다. admission은 payload를 JSON 텍스트로 비교하므로, 인코딩이 바뀌었을 때 대기 승인 행을 SQL로 다시 써야 했다(`owner-workflow-storage.ts:264-269`, `db/migrations.ts:1845-1860`).
  - 0.0.17 바이너리로 fixture DB를 만들어야 한다. 넣을 것: 대기 `RelayedApproval`, 대기 `HumanDecision`, 아직 발화하지 않은 `ProviderRetry` clock, `KanbanCardAttempt`와 `persisted_queue_items`, `accepted` 새 Goal 요청, interrupted run.
  - 칸반이 0.0.17에 들어 있었는지도 확인해야 한다(`decisions.md:942`는 10-18에 "릴리즈 전"이라고 적었다).
- **🟡 "체감 없이"는 기존 규칙과 충돌한다.** 재시작하면 진행 중 run은 `failed/server_restarted`로 끝나고, 이어지는 것은 대기(승인, 판단, clock)뿐이다(`decisions.md:687`, `2721`, `2872`). 목표는 "일반 재시작과 같은 표시 말고는 사용자가 따로 할 일이 없다"로 정해야 지킬 수 있다.
- **🟡 막힌 세션을 고칠 때 지켜야 할 규칙이 있다.**
  - 시작 시 state를 제자리에서 다시 쓰면 "legacy 행을 다시 쓰지 않는다"(README Invariants)와 부딪힌다. 방법은 둘이다. 순수 파생 함수로 phase를 계산하거나, author NULL인 새 revision을 더한다.
  - chat_metadata의 실행 상태가 `ready`나 `retrying`이면 업그레이드 직후 자동 run이 시작될 수 있다(`db/migrations.ts:1876-1885`).
- **🟡 죽은 run에 묶인 승인이 남는다.** `relayed.ts`에는 재시작 뒤 죽은 run의 승인을 닫는 경로가 없다. 아무도 받지 않을 승인이 최대 1일 동안 화면에 남는다(`relayed.ts:111-166`).
- **🟢 롤백 방침이 없다.** 다운그레이드를 지원하지 않는다고 명시하거나, 업그레이드 전에 백업한다(`decisions.md:811` 선례).

### 8. 오래 남을 부채

- **🔴 원자적 admission이 엔진 저장소에 묶여 있다.** `admitWith`가 binding과 `owner_workflow_executions` INSERT를 한 transaction에 둔다(`owner-workflow-storage.ts:313-323`). 엔진을 무엇으로 쓰든 이 결합을 풀면 선택지가 넓어진다.
  1. binding과 실행 의도 행을 한 transaction에 쓴다.
  2. 결정적 executionId로 멱등하게 execute한다.
  3. 시작할 때 의도만 있고 실행이 없는 행을 다시 보낸다.
- **🟡 엔진 저장소를 앱이 읽는다.** 앱 소유 projection 표를 두고 session과 상태로 인덱스를 건다. 엔진 저장소는 엔진만 읽고, 완료된 행의 보존 기간을 정한다.
- **🟢 문서가 코드와 어긋난다.**
  - `kanban-orchestration.md:100`은 "같은 `DatabaseSync`"라고 쓰는데, README:43과 다르다.
  - README:62와 `decisions.md:747`은 Scope 관리가 완결된 것처럼 적는다.
  - EFX-02의 거절 기록이 `decisions.md`에 없다.

### 9. 카드 작업 공간 준비와 정리 (Goldfish 검토 2026-10-29 반영)

Goldfish 6명이 이 장의 첫 안(A 지금 방식, B gitignore 폴더 COW 복제, C base checkout 위 `agentfs run`을 비교하는 spike)을 검토했다. 결론은 같았다.

- **정리부터 고친다.** 정리는 spike와 무관하게 지금 할 수 있고, 지금 코드에 구멍이 있다.
- **준비 방식은 그 뒤에 실제 칸반 사용량을 재고 정한다.**
- **C는 지금 정의로는 비교할 수 없다.** 첫 안의 합격 기준으로는 A, B, C 중 하나를 고를 수 없다. C는 리서치 뒤 뺐다(2026-10-29, 9.3).

#### 9.1 고친 사실

- **"충돌을 세 겹으로 막는다"는 과장이었다.**
  - 파일 겹침 검사는 "hint, not a lock"이다(`orchestrator.ts:847`, `decisions.md:872`). 예상 파일이 없는 카드는 Goal 간 검사를 건너뛴다(`scheduler.ts:258`).
  - `merge-queue.ts:369`는 upstream 재검증 대상을 고르는 곳이다. 해결 카드는 오케스트레이터의 sync 충돌 경로에서 만든다(`decisions.md:871`).
  - 결론은 그대로다. 어떤 FS를 써도 겹친 수정은 합칠 때 충돌한다. 작업 공간 기술이 바꾸는 것은 준비 비용과 정리뿐이다.
- **"카드 에이전트가 셸로 매번 설치한다"는 근거가 없다.**
  - 호스트 명령은 승인된 sh 스킬로만 돈다(`run_shell`은 없어졌다, `shell-skill-sandbox.md:9`, `38-64`). 검증자는 읽기 도구와 `run_skill`만 받는다(`decisions.md:877`).
  - 그래서 A의 실제 비용은 설치 시간만이 아니다. 스킬 저장, 네트워크 호스트 승인, 사람의 개입이 함께 든다.
  - Windows에는 셸 샌드박스가 없어 ask·auto 모드가 sh 스킬을 거절한다(`shell-skill-sandbox.md:22`, `116-118`). 그래서 Windows 카드는 의존성을 설치할 수 없다.
- **디스크 고통은 앱에서 측정된 적이 없다.**
  - 앱 worktree root에는 Goal 폴더 하나(12K)만 남아 있다. 이것은 오히려 앱이 정리를 잘 한다는 근거에 가깝다. 남은 12K는 만들기만 하고 지우지 않는 `<goalInstanceId>` 부모 폴더일 가능성이 크다(`git-worktrees.ts:290`, `777`).
  - 2.4G는 앱 밖의 개발 worktree를 `du`로 잰 값이다. pnpm은 APFS에서 store로부터 clone이나 hardlink로 파일을 가져온다(일반 지식, 미확인). 그래서 실제로 늘어난 디스크는 이보다 작을 수 있다. 즉 pnpm 저장소에서는 A가 이미 copy-on-write에 가깝다.
- **배포 플랫폼이 틀렸다.** 릴리즈는 macOS arm64와 Windows x64이고, Linux는 로컬 빌드만 지원한다(`decisions.md:2015`).
- **venv 위험의 범위가 틀렸다.** 카드 셸의 `allowWrite`는 프로젝트, 임시 폴더, 캐시뿐이다(`sandbox.ts:98-103`). 카드 셸의 `projectRoot`가 카드 worktree라면(연결 코드는 미확인) base venv에 쓰는 일은 막히고 설치가 실패할 뿐이다. base가 실제로 바뀌는 경우는 full 모드와 Windows다.

#### 9.2 정리: 먼저 할 일

지금 코드에서 빠진 것:

- `halt`(Plan 종료)와 새 Goal 전환(supersede) 경로가 worktree를 settle하지 않는다(`orchestrator.ts:795-813`, `885-893`). `runs.stop` 내부는 확인하지 못했다.
- `<goalInstanceId>` 부모 폴더를 지우지 않는다(`git-worktrees.ts:290`). `.goal` checkout은 같은 Goal의 다음 checkout 때만 지운다(`:761-776`).
- `ctx/goal/*` 브랜치와 취소 카드의 `ctx/card/*` 브랜치를 지우는 코드가 없다(`:437-447`). 2026-10-29 결정으로 이것은 의도한 동작이 됐다(아래).
- `Done` 정리는 worktree가 깨끗할 때만 된다. 아니면 `WorktreeDirty`로 남는다(`:425`).
- `Retained`에는 시각이 없어 TTL을 셀 기준이 없다(`:406-409`).
- 코드의 disposition은 `Done`, `Cancelled`, `Blocked`, `HumanDecision` 넷뿐이다(`worktree.ts:39-44`). 보드에서 빠지는 카드(`Stop`, `Replace`, 충돌 해결 카드로 대체된 카드)는 `Cancelled`로 정리한다(`board-actions.ts:270-281`, `orchestrator.ts:453-455`, `597-606`). 스냅샷 커밋 뒤 폴더를 지우고 카드 브랜치를 남긴다. `decisions.md:823`은 "worktree를 남기므로"라고 적고 있었다. 2026-10-29에 문구를 고쳤다.

정리 규칙 제안:

- **폴더가 아니라 git으로 지운다.** worktree base는 여러 저장소가 함께 쓰고, 경로에 저장소 정보가 없다(`git-worktrees.ts:242`). 폴더만 지우면 사용자 저장소에 `.git/worktrees/*`가 남는다. worktree 등록 표(경로, 저장소, Goal, 카드, 마지막 lease)를 두고, 그 표를 기준으로 `git worktree remove`와 `prune`을 돈다.
- **남의 worktree를 지우지 않는다.** worktree base는 홈 폴더에서 정해지고(`git-worktrees.ts:47-50`), storage root(`--storage`)와 따로 정해진다. 그래서 개발판과 설치판이 같은 base를 쓴다. 내 DB에 없는 폴더가 다른 인스턴스에서 실행 중인 worktree일 수 있다. Goal 폴더에 owner 표식을 두고 자기 폴더만 지운다.
- **(결정 2026-10-29) 보존은 Goal이 살아 있는 동안 폴더로, 그 뒤에는 브랜치로 한다.**
  - `Blocked`·`HumanDecision`은 지금 커밋하지 않고 폴더로 보존한다(`git-worktrees.ts:452-453`). 재전달은 같은 worktree에서 이어 가므로(`kanban-orchestration.md:96`) Goal이 살아 있는 동안은 폴더를 둔다.
  - Goal이 끝나거나(완료, supersede, halt) 마지막 lease 뒤 14일 동안 활동이 없으면 `Cancelled`처럼 정리한다. 스냅샷 커밋 뒤 폴더를 지우고 브랜치만 남긴다(`:422-424`). 다음 lease는 그 브랜치에서 다시 만든다(`:299-302`).
  - `resolved` 답 뒤의 재검증은 worktree가 없으면 `WorktreeMissing`으로 실패한다(`:346-351`, `decisions.md:884`). 이 경로도 브랜치에서 worktree를 다시 만들도록 고친다.
- **시작 시 sweep은 큐 worker보다 먼저, DB 상태를 보고 한다.** 큐 item이나 attempt가 있는 카드, retained 카드는 건너뛴다. owner는 attempt가 끝난 뒤에만 커밋하고 재전달하기 때문이다(`decisions.md:849`, `865`).
- **첫 릴리즈는 dry-run이다.** 지울 대상을 기록만 하고, TTL로 지우기 전에는 보드에 먼저 알린다.
- **업그레이드 전에 남은 worktree도 다룬다.** retained 시각 열을 더하고, 이전 worktree는 업그레이드 뒤 첫 시작 시각부터 센다.
- **"Goal 수명 끝"을 사건으로 정의한다.** Goal 상태 기계가 끝 상태에 가지 않는 세션이 있으므로(5장) Goal 상태에만 묶으면 정리도 멈춘다.
- **(결정 2026-10-29) `ctx/*` 브랜치는 자동으로 지우지 않는다(사용자 결정).**
  - 취소 카드의 스냅샷 브랜치는 지우지 않는다. 충돌 해결 카드가 참조로 쓰기도 한다(`orchestrator.ts:453`).
  - Goal 브랜치도 자동으로 지우지 않는다.
  - 정리가 필요하면 사용자가 부르는 브랜치 gc를 둔다. gc는 target 브랜치에 이미 들어간 브랜치를 정리한다. PR squash merge처럼 들어갔는지 확인할 수 없는 브랜치는 목록으로 보여 주고 사용자가 고른다(제안).
  - `Done` 카드 브랜치는 지금처럼 정리 때 지운다(`git-worktrees.ts:437-447`). 내용은 squash로 Goal 브랜치에 들어가 있다.
  - 로컬 비용은 ref 하나와 스냅샷 커밋의 객체뿐이다. ignore 폴더는 커밋하지 않는다.
  - 로컬 보관이 문제가 되면 지우지 않고 원격에 올린다. 이어서 할 때 원격에서 checkout한다(사용자 결정). 원격에 올리면 진행 중 작업이 공개되므로, 사용자가 켤 때만 한다.
- **삭제를 빠르게 끝낸다.** `git worktree remove`는 uninterruptible이라 큰 트리를 지우는 동안 종료가 막힌다(`:426-428`). trash 폴더로 rename한 뒤 배경에서 지운다.
- **준비와 정리는 git 어댑터 밖의 서비스로 둔다.** `CardWorkspace` 계약은 바꾸지 않는다.

#### 9.3 준비 방식 후보

- **A. 지금 방식.** worktree를 만든 뒤 에이전트가 sh 스킬로 설치한다. 기준선은 "A + 9.2 정리"다.
- **A′. worktree 재사용 pool (Goldfish 제안, 첫 안에 없던 것)**
  - Goal마다 WIP 수만큼 worktree를 둔다(기본 최대 4, `kanban-orchestration.md:69`).
  - 다음 카드는 그 자리에서 `git checkout -B <카드 브랜치> <Goal HEAD>`와 `git clean -fd`(`-x` 없음)로 시작한다. 그래서 ignore 폴더(`node_modules` 등)는 남는다.
  - 장점:
    - 디스크는 카드 수가 아니라 WIP 수에 비례한다.
    - 설치는 증분이 된다.
    - 모든 OS와 FS에서 돌고, 패키지 매니저를 몰라도 된다.
  - 바꿀 곳은 `describe`·`lookup`의 경로 규칙이다(`git-worktrees.ts:242`, `255-262`).
  - 약점: 앞 카드의 ignore 산출물이 다음 카드에 남는다. 카드에 이 사실을 알려야 한다. 재전달된 카드는 같은 자리를 다시 받아야 한다.
- **B. gitignore 폴더 COW 복제. 설치를 대신하는 것이 아니라 빠르게 하는 캐시로 범위를 줄인다.**
  - **목록이 이 저장소에서 바로 커진다.** `.gitignore`는 `.env`(`:17-18`) 말고도 `.claude/worktrees/`(`:34`), `.rrsi-local/`(`:40`), `.codegraph/`(`:43`)를 무시한다. 그래서 다른 개발 worktree 전체(하나에 2.4G)와 쓰고 있는 SQLite 색인까지 복제한다.
    - (결정 2026-10-29) 허용 목록 대신 제외 규칙을 쓴다. ignore 폴더를 모두 복제하되 셋을 뺀다. 그래서 생태계별 폴더 이름을 알 필요가 없다.
      - `isCredentialPath`(`files/paths.ts:116-134`)에 걸리는 경로. `.env*`(`.env.example` 제외), `*.pem`·`*.key`, `secrets/`, `*credentials*` 같은 이름을 잡는다.
      - `.git`이 든 하위 폴더. 다른 worktree를 뺀다.
      - 크기 상한을 넘는 폴더
    - 실제 복제 목록을 보여 주고, 프로젝트별로 덮어쓸 수 있게 한다.
  - **🔴 비밀 파일이 커밋되어 push될 수 있다.**
    - 복제 목록은 base의 ignore 규칙으로 정한다. 그런데 커밋은 worktree(Goal 브랜치)의 규칙으로 `git add --all`을 돈다(`git-worktrees.ts:329`).
    - 두 규칙이 다르면 복제본이 untracked가 된다. 그러면 squash를 거쳐 자동 merge되고(`kanban-orchestration.md:87`), PR을 고른 경우 `pushGoalBranch`로 push까지 된다(`git-worktrees.ts:810-819`).
    - 막는 법: 복제 직전에 worktree에서 `git check-ignore`로 다시 거른다. 복제한 경로가 커밋에 들어 있으면 reason literal로 실패시킨다.
    - (결정 2026-10-29) 커밋 직전에 staged 변경을 secretlint로 검사한다. `SecretRedactor`(`secrets/redactor.ts`)가 쓰는 권장 preset을 쓴다. 복제 단계에서는 검사하지 않는다. 내용 검사라 `node_modules`의 파일을 모두 읽으면 준비가 느려진다. 이 검사는 B와 관계없이 에이전트가 비밀을 커밋하는 경우도 막는다.
  - **조용히 낡는다.** 복제 원본은 base(사용자 checkout)의 의존성인데, 카드는 Goal HEAD에서 시작한다. `syncWithGoal`(`:469-514`)이 다른 카드의 lockfile 변경을 가져와도 B는 알아채지 못한다. 사용자가 base에서 설치하는 도중이면 반쯤 쓰인 폴더를 복제한다.
    - 막는 법: 복제 시점의 base commit과 dirty 여부를 카드에 알린다.
  - **절대 경로 검사가 실패할 가능성이 높다.** pnpm의 `.bin` shim과 `.modules.yaml`에 절대 경로가 들어 있다(일반 지식). 검사가 실패하면 그 폴더는 복제하지 않고 A로 돌아간다는 규칙이 필요하다.
  - **crash에 안전해야 한다.** `ensure`는 이미 있는 worktree를 그대로 돌려준다(`:314-315`). 그래서 임시 형제 폴더에 복제한 뒤 rename하고, 완료 표식을 남긴다. 복제가 실패하면 카드를 실패시키지 않고 A로 돌아간다.
  - **Windows(NTFS)에서는 항상 A다.**
- **C. AgentFS. (결정 2026-10-29) 뺀다.** 공식 README·MANUAL(2026-10-29 확인)을 본 뒤, 이득이 미묘하다고 판단했다.
  - **상시 mount 자체는 된다.** `agentfs init --base <PATH>`로 overlay를 만들고 `agentfs mount <id> <MOUNT_POINT>`로 상시 mount한다. macOS는 NFS, Linux는 FUSE다. 그래서 첫 검토의 "`agentfs run`은 감싼 명령에만 보인다"는 반론은 `mount`로 풀린다.
  - **그런데 lower를 무엇으로 두든 B보다 낫지 않다.**
    - lower가 카드 worktree면 `node_modules`가 없다. 준비 비용을 줄이지 못하고, 격리는 worktree가 이미 준다.
    - lower가 base checkout이면 사용자의 브랜치와 미커밋 변경이 보인다. 카드는 Goal HEAD에서 시작해야 한다(`git-worktrees.ts:299-311`). overlay 안에서 checkout하면 카드 커밋이 overlay 안의 `.git`에 쌓여, owner가 실제 저장소로 다시 가져와야 한다(`:326-341`, `469-580`, `decisions.md:865`). 사용자가 base에서 고치거나 설치하면 실행 중인 카드에도 비친다.
    - lower가 base의 `node_modules`뿐이면 B와 같은 일을 한다. 다만 APFS clonefile 대신 NFS mount를 거치고, 카드마다 폴더마다 mount가 생긴다. 작은 파일이 많은 `node_modules`는 NFS에서 가장 불리하다(측정하지 않음).
  - **AgentFS만의 장점은 이 문제와 무관하다.** 장점은 SQLite 한 파일에 담긴 감사 기록, snapshot, 이동성이다.
  - **비용**
    - BETA다("may still contain bugs").
    - `exec`는 "Unix only"이고, Windows mount는 문서에 없다. 릴리즈 대상인 Windows x64에서는 쓸 수 없다.
    - 별도 CLI 설치가 필요하다. 서명된 단일 실행 파일에 beta mount 도구를 더해야 한다(`decisions.md:2002`, `2028-2029`).
    - 비정상 종료 뒤 남은 NFS mount를 앱이 찾아 `umount`해야 한다. stale NFS mount는 `stat`을 멈추게 할 수 있는데(일반 지식), git `run`에는 timeout이 없다(`git-worktrees.ts:104-136`).

#### 9.4 빠졌던 범위: `.goal` checkout

Goal 검증과 upstream 재검증은 head마다 `.goal` worktree를 새로 만들고 지운다(`git-worktrees.ts:752-807`, `merge-queue.ts:374`, `decisions.md:896`). 여기에도 의존성이 필요하므로, 준비 비용이 head마다 다시 든다. 정리에 실패하면 경고만 남긴다(`:803-805`). 준비 방식과 정리 범위에 넣는다.

#### 9.5 관측

- `lease`는 span이 없는 `acquireRelease`다(`git-worktrees.ts:379`). `repositoryOf`, `lookup`, `ensure`는 `fnUntraced`다. git stderr는 버리고(`:123`), 실패 reason은 `GitFailed{exitCode}` 하나뿐이다(`worktree.ts:124`).
- 넣을 것:
  - 준비 방식, fallback 이유, worktree 상태를 속성으로 가진 `CardWorktrees.lease` span
  - 방식별 준비 시간 histogram과 reason별 fallback counter(`execution-admission.ts:62-71` 방식)
  - `CloneUnsupported`, `CloneFailed{code}` 같은 reason literal
  - 남은 worktree 수와 가장 오래된 나이를 보여 주는 gauge
  - 시작할 때 worktree base 폴더, `git worktree list`, DB 카드 상태를 맞춰 보는 reconcile 기록
- 카드마다 쓴 준비 방식과 fallback 이유를 attempt 기록과 보드에 남긴다. 조용한 fallback은 허용하지 않는다.
- 준비 방식은 Goal 시작 때 저장하고(기본값 A), Goal이 끝날 때까지 바꾸지 않는다. 진행 중인 Goal은 A를 유지한다.

#### 9.6 다시 짠 spike (정리를 고친 뒤)

- 기준선: A + 9.2 정리
- 비교 대상: A′, B(9.3의 제외 규칙 포함). C는 뺐다(9.3).
- 표본: pnpm 저장소(이 저장소)와 store가 없는 저장소 하나 이상(npm이나 Python venv). pnpm 하나만 쓰면 A에 가장 유리하다.
- 준비 시간의 정의: lease 시작부터 첫 테스트 명령이 성공할 때까지. 설치 시간은 스크립트로 따로 재고, 실제 run의 모델 턴 수, 토큰, 사람 승인 횟수를 함께 센다.
- 재는 것:
  - 카드당 실제로 늘어난 디스크. APFS 스냅샷과 purgeable 공간 때문에 남은 공간이 흔들리므로 여러 번 재고 분산을 적는다.
  - `.goal` checkout 준비 시간
  - store가 비었을 때와 찼을 때
  - 동시 실행 상한(최대 32, `decisions.md:850`)에서의 최악 디스크: WIP + `.goal` + 보존 중인 worktree
- 합격 기준:
  - 카드당 실디스크 상한
  - kill -9 뒤 재시작했을 때 남는 폴더, mount, `.git/worktrees` 항목이 0
  - 테스트 결과가 같다
  - base ignore 폴더의 hash manifest가 전후로 같다
  - 복제한 경로가 커밋에 들어가지 않는다
  - "의존성을 바꾼 카드가 통합된 뒤 시작한 카드"가 맞는 버전으로 검증된다
- 동률일 때의 규칙: 지원 플랫폼이 더 많고 외부 바이너리와 mount가 없는 쪽을 고른다.
- 플랫폼별 결과를 표로 적는다. 예: Windows는 A(또는 A′)에 정리만 더한다.

#### 9.7 가장 강한 반론 (6명 중 5명)

측정된 고통은 앱에서 온 것이 아니다. 아픔이 주로 정리 실패와 설치 마찰이라면, A에 정리 개선만 더해도 목적 대부분을 얻는다. 패키지 매니저의 전역 store는 lockfile 지식 없이도 이미 중복을 줄인다. B와 C는 측정된 적 없는 비용을 최적화하면서 비밀 파일 복제, 중첩 worktree 복제, 의존성 신선도라는 새 위험을 진다. 그래서 B·C는 정리를 고친 뒤 실제 칸반 사용량을 재고 정한다.

### 검토 한계

- reviewer들은 Grep과 Glob 권한을 받지 못해 Read로만 확인했다. 그래서 각자 읽지 않은 파일이 있다. `tool-ledger.ts`, `uncertain-runs.ts`, `run-bindings.ts`, `SqlMessageStorage.ts` 후반부, `Sharding.ts`는 대부분 확인되지 않았다.
- 확인하지 못한 것: cluster 저장이 어느 fiber에서 일어나는지, clock 발화가 message poll에 묶이는지, 0.0.17 태그의 schema, `db/database.ts`의 다운그레이드 동작.
- 로컬 DB 수치(이상 세션 6개, 실행 73건)는 사용자 한 명의 DB다. 다른 0.0.17 사용자의 상황을 대표하지 않는다.

## Goals vs. Non-Goals

- **In-Scope Goals:** 네 단계를 이 순서로 한다(결정 11).
  - **1단계: 정상화.** 지금 엔진, Goal 상태 기계, 칸반 정리에서 고장 난 것과 대기 지연을 고친다. 저장 형식은 거의 바꾸지 않는다. 이 단계의 측정값이 3단계 spike의 기준선이 된다.
    - owner 엔진에 `awaitComplete`를 넣어 대기 호출자의 poll·replay·scope 누수를 없앤다. 성공 기준: 긴 대기 동안 replay 0회, deferred 완료에서 호출자 재개까지 측정값이 목표 안이다.
    - scope 수명을 실행 하나에 하나로 둔다. resume 사이에 재사용하고, Complete나 interrupt 때 닫고 Map에서 내린다. 부모는 저장소에서 찾는다. 성공 기준: 시나리오 N회(예: Suspended→Complete 1,000회) 뒤 `executions.size`와 자식 scope 수가 시작값으로 돌아온다.
    - 죽은 실행을 `running`과 구분하고, 실행마다 연속 실패 횟수를 센다.
    - Goal 상태의 불변식 검사를 만든다(phase × `goal.status` × `plan.status` × 실행 상태). 앱 시작 때와 테스트에서 돌린다. 이상 세션 6개를 분류한 뒤 원인 경로를 고친다.
    - "Goal이 안 바뀐다" 경로 셋(조용한 거절, `accepted` 고착, 칸반 phase 유지)을 볼 수 있게 하고 고친다. 거절 reason을 기록해 화면에 보이고, `NewGoalSettlement.rejected.reason`을 literal union으로 바꾼다(`workflow.ts:263`). 성공 기준: Goal 전환 시나리오가 e2e로 끝까지 간다.
    - run 로그 reader를 `PubSub`/`Latch`로 깨우고, polling은 대비책으로 둔다.
    - 시나리오는 기존 표(`kanban-orchestration.md:165-179`)에 행을 더한다. 엔진 계약 suite와 앱 시나리오 suite로 나누고, 둘 다 `TestClock`과 실제 SQLite 파일을 쓴다. 행마다 다섯 가지를 적는다: trigger, done 조건(DB와 화면), 시간 예산, 막힘 reason literal, 사용자 복구 동작.
    - span, duration histogram, 엔진 크기 gauge를 추가한다. 실행 행에 시각을 남긴다.
    - 카드 작업 공간 정리를 고친다(9.2): git으로 지우기, owner 표식, 스냅샷 커밋 뒤 브랜치로 보존, DB 상태를 보는 시작 sweep(첫 릴리즈는 dry-run), `halt`·supersede 경로의 settle, 부모 폴더 정리. `ctx/*` 브랜치는 자동으로 지우지 않고, 필요하면 사용자가 부르는 gc로 정리한다. `.goal` checkout(9.4)과 관측(9.5)도 함께 다룬다.
  - **2단계: 엔진에서 떼어 내기.** 교체하지 않아도 필요한 일이다.
    - admission을 엔진 저장소에서 떼어 낸다(결정 7).
    - 앱이 읽는 durable 조회를 앱 소유 표로 옮긴다(8장). 이력 전체 조회는 인덱스가 있는 조회로 바꾼다.
  - **3단계: 엔진 spike.** 1단계를 마친 owner 엔진을 기준선으로 결정 9의 기준을 적용한다.
  - **4단계: 준비 방식 spike.** 9.6의 spike(기준선 A + 정리, 비교 대상 A′·B)로 정한다.
  - **모든 단계 공통:** 0.0.17 fixture DB로 업그레이드를 검증하고, 시작 migration 시간 예산을 잰다.
- **Out-of-Scope Non-Goals:**
  - spike 전에 `ClusterWorkflowEngine` + `SingleRunner` 교체를 확정하는 것(아래 결정 1).
  - 진행 중 run(모델·도구 실행 중)을 재시작 뒤 이어 가는 것. 기존 no-replay 규칙을 유지한다.
  - 0.0.17로의 다운그레이드 지원.
  - turbovec·기억 검색 개편. 별도 brief로 다룬다.

## Key Decisions & Staging for Next Steps

`/egm-draft`로 넘기기 전에 사용자가 정할 것과, 정해진 것으로 넘길 것이다.

1. **(결정 2026-10-28, 순서는 2026-10-29에 바뀜) 공식 엔진 교체를 목표로 두고, 교체 비용을 먼저 없앤다.** 정상화(11번) 다음 단계는 admission 분리(7번)와 앱 소유 조회 표(8장 두 번째 항목)다. 둘 다 교체하지 않아도 필요한 일이다. 그다음 spike로 clock 발화 지연, 놀 때의 SQL 문장 수, 재시작 뒤 재개 지연을 잰다. 교체할 때 0.0.17의 진행 중 행은 변환하지 않고 drain한다. 최종 교체 여부는 spike 결과로 정한다. 기록: `docs/decisions.md` "Workflow 엔진 교체를 목표로 두고, admission과 조회를 먼저 엔진에서 뗀다 (2026-10-28)".
2. **(제안) 막힘은 엔진이 아니라 `workflow.ts` 상태 기계에서 찾는다.** 먼저 불변식 검사와 이상 세션 분류를 하고, 그다음 고친다.
3. **(제안) EFX-02 거절과 이번 재검토를 `docs/decisions.md`에 기록한다.** 교체를 다시 볼 조건도 함께 적는다. 조건은 셋이다: owner 엔진을 고친 뒤에도 남는 측정된 결함, bind와 run envelope 저장의 원자성 테스트 통과, 진행 중 행을 drain하는 계획.
4. **(결정 2026-10-29) "체감 없는 업그레이드"의 정의.** 일반 재시작과 같은 표시 말고는 사용자가 따로 할 일이 없다. 진행 중 run은 지금처럼 `server_restarted`로 끝나고, 대기 항목만 이어진다.
5. **(결정 2026-10-29) 막힌 세션은 이미 있는 `reconcile`을 넓혀 고친다.** `reconcile`(`workflow.ts:716-731`)은 phase가 어긋나면 새 revision과 ledger `state reconciled`를 남긴다. 지금은 `execute`·`verify` phase만 고친다. 이것을 불변식 검사 기준으로 넓힌다. 순수 파생 함수 방식은 고치는 경로를 하나 더 만들어 뺐다. 실행 상태는 `stopped`로 고정해 업그레이드 직후 자동 run이 시작되지 않게 한다.
6. **(결정 2026-10-29) `Workflows.locked`의 key lock을 뺀다.** "DB 읽기를 잠금 안에 두지 않는다" 규칙(`decisions.md:2922`) 위반으로 본다.
   - 앱은 SQLite 연결 하나를 semaphore로 빌려 주고, transaction(`BEGIN IMMEDIATE`)이 끝날 때까지 쥔다(`db/sql-client.ts:14-19`). 그래서 key lock 없이도 세션의 read-modify-write는 하나씩 돈다.
   - key lock(`workflow.ts:473-474`)은 이득 없이 교착 위험만 만든다. transaction 안에서 `Workflows`를 부르면, key lock을 쥔 쪽은 연결을 기다리고 transaction 쪽은 key lock을 기다릴 수 있다.
7. **(결정 2026-10-28) admission을 엔진 저장소에서 떼어 낸다(의도 행 + 멱등 execute + 시작 시 재발행).** 2단계의 첫 일이다.
8. **(결정 2026-10-29) durable 행은 근거로 쓸 가치가 있으면 남기고, 아니면 운영에 필요 없어진 뒤 지운다(사용자 결정).**
   - 근거는 다른 에이전트가 `read_evidence`·`trace_evidence`로 읽거나, 사람이 화면에서 보는 기록이다. 에이전트가 읽는 근거는 memory node(`user`, `assistant`, `tool_call`, `tool_result`, `file_observation`, `topic`)다(`memory/nodes.ts:22-29`).
   - 지금 지우는 행은 clock뿐이다. 표마다의 분류는 2단계에서 한다.

   첫 분류(제안)는 이렇다.
   - 엔진 표(`owner_workflow_*`)는 에이전트도 사람도 근거로 읽지 않는다. 운영 목적이 끝나면 지운다.
     - activities, clocks: replay와 예약에만 쓴다. 실행이 끝나면 지운다.
     - executions: 재요청에 결과를 돌려주고, provider 재시도 순번을 센다(`provider-retry.ts:191`). 순번을 앱 소유 표로 옮긴 뒤, run이 닫힌 실행부터 지운다.
     - deferreds: 승인 답은 이미 `tool_result`의 `permission`(결정, 결정한 사람, 이유)으로 node에 남는다(`memory/nodes.ts:41-44`). 사람 결정 카드의 답이 node나 Goal ledger에 남는지는 확인해야 한다.
   - 엔진 밖 표
     - `owner_rpc_operations`, `workflow_run_events`: 도구 호출·결과와 답변 본문은 node에 남는다. 화면이 지난 run을 이 표에서 다시 그리는지 확인한 뒤, run이 닫히면 지운다.
     - `workflow_state_revisions`: Goal 이력과 완료 근거를 담는다(`completion-evidence.ts:135`). 남긴다.
     - `kanban_card_attempts`, `human_decision_closures`: 보드에서 사람이 이 기록을 보는지 확인하고 정한다.

9. **(결정 2026-10-29) 엔진 spike의 합격 기준은 "owner 엔진보다 나빠지지 않는다"이다.** 사용자의 목표(쓰기 편함, 조건이 맞으면 바로 넘어감, 병렬 작업의 완결)는 엔진 종류보다 대기 방식(`awaitComplete`, run 로그 polling, 오케스트레이터 wake)과 작업 공간에 달려 있다. 그래서 엔진 교체는 이 일들보다 뒷순위다.
10. **(결정 2026-10-29) 카드 작업 공간을 이 brief에 넣는다.** Goldfish 검토 뒤 제안은 세 가지다.
    - (제안) 정리를 먼저 고친다(9.2).
    - (제안) 준비 방식은 정리를 고친 뒤 9.6의 spike로 정한다. 비교 대상은 A′(worktree 재사용 pool)와 B(허용 목록 COW 복제)다.
    - (결정 2026-10-29) C(AgentFS)는 뺀다. 리서치 결과 lower를 무엇으로 두든 B보다 낫지 않고, Windows에서 쓸 수 없다(9.3).

    2026-10-29에 네 가지를 정했다(9.2).
    - 보존: Goal이 살아 있는 동안은 폴더, 그 뒤에는 브랜치
    - TTL: 마지막 lease 뒤 14일
    - `ctx/*` 브랜치는 자동으로 지우지 않는다. merge된 브랜치는 사용자가 부르는 gc로 정리하고, 로컬 보관이 문제면 원격에 올린다.
    - `Stop`·`Replace`는 지금처럼 `Cancelled`로 정리한다.

    B를 고를 경우의 복제 규칙도 정했다(9.3): 허용 목록 대신 제외 규칙, 커밋 직전 secretlint 검사.

11. **(결정 2026-10-29) 지금 엔진과 Goal 상태 기계의 정상화를 첫 단계로 둔다.** 순서는 1 정상화, 2 엔진에서 떼어 내기(admission 분리, 앱 소유 조회 표), 3 엔진 spike, 4 준비 방식 spike다. 이유는 넷이다.
    - 사용자가 처음 말한 목표(안정성, 누수, Goal 전환)가 바로 이 결함들이다.
    - 엔진 spike(9번)는 고친 owner 엔진을 기준선으로 삼아야 비교가 공정하다.
    - Goal 전환 막힘은 `workflow.ts` 상태 기계에 있어 엔진을 바꿔도 남는다.
    - 저장 형식을 거의 바꾸지 않아 0.0.17의 진행 중 행을 옮길 필요가 없다.

    대가: owner 엔진에만 하는 수정(`awaitComplete`, `executions` Map 정리, scope 수명)은 엔진을 교체하면 버려진다. 변경이 작고, spike가 실패하면 어차피 필요하다.
