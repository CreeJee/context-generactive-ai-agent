# Workflow 개편 S1: 정상화 (owner 엔진·Goal 상태·run 로그·카드 worktree 정리)

- **Author:** CreeJee
- **Status:** Proposed (리뷰 반영 2판)
- **Date:** 2026-10-29

---

## Overview

`packages/memory-agent`의 workflow 계층 개편 중 첫 단계(S1)다. 지금 쓰는 부품에서 고장 난 동작을 고치고, 고친 결과를 잴 수 있게 만든다.

범위는 다음과 같다.

- owner workflow 엔진: 대기, 메모리 수명, 결정적 실패(`workflow/owner-workflow-engine.ts`, `workflow/owner-workflow-storage.ts`)
- Goal 상태 전이와 앱 시작 검사(`workflow/workflow.ts`, 새 `workflow/goal-transitions.ts`)
- 칸반 사람 결정 요청의 중복과 바뀐 사실(`kanban/human-decision.ts`)
- run 로그 reader(`workflow/durable-stream.ts`)
- `Workflows.locked`의 key lock(`workflow/workflow.ts`)
- 칸반 카드 worktree 정리(`kanban/git-worktrees.ts`, `kanban/orchestrator.ts`, `kanban/card-queue.ts`)

저장 형식은 열과 표를 더하기만 한다. 예외는 하나다. 칸반 사람 결정 실행의 payload를 새 형식으로 다시 쓴다(D3). 이 단계에서 잰 값은 S3 엔진 spike(`ClusterWorkflowEngine` 비교)의 기준선이 된다.

### 이 문서의 표기

- 목표는 `G1`–`G9`, 결정은 `D1`–`D4`, worktree 정리 항목은 `W1`–`W5`, 구현 단계는 `Step 1`–`Step 10`이다.
- 개편 단계는 `S1`–`S4`다. S1 정상화(이 문서), S2 admission 분리와 앱 소유 조회 표, S3 엔진 spike, S4 카드 준비 방식 spike다(`docs/decisions.md` "Workflow 개편은 지금 엔진과 Goal 상태 기계의 정상화부터 한다 (2026-10-29)").
- "결정 N"은 `concepts_brief.md`의 Key Decisions 번호다.
- 코드 경로는 `packages/memory-agent/src` 기준이다. `apps/`, `docs/`, `tools/`로 시작하는 경로는 저장소 루트 기준이다. `effect:`로 시작하는 경로는 `packages/memory-agent/node_modules/effect/src/`(effect 4.0.3) 기준이다. 파일 이름 없는 `:N`은 바로 앞에 이름이 나온 파일의 줄이다.
- 로컬 DB 수치는 사용자 한 명의 `~/.context-generactive-agent/agent.db`를 2026-10-29에 읽기 전용으로 센 값이다.

### 용어

- **엔진 실행 status**: `owner_workflow_executions.status`. 값은 `running`, `suspended`, `completed`, `interrupted`다(`db/migrations.ts:1392`).
- **세션 실행 상태**: `WorkflowExecutionState`(`workflow/execution.ts:48-69`). 값은 `idle`, `running`, `ready`, `retrying`, `blocked`, `stopped`다.
- **카드 lease**: `CardWorktrees.lease`가 카드 worktree를 쓰는 동안 쥐는 권리다. **세션 lease**: `SessionLeases`가 브라우저 탭이나 ACP 연결에 주는 세션 쓰기 권리다.
- **no-replay 규칙**: 끝나지 않은 run은 재시작 뒤 다시 돌지 않는다(`chat-state/chat-state.ts:88-108`).
- **`.goal` checkout**: Goal 수준 검증과 merge에 쓰는 Goal 브랜치 checkout이다(`kanban/git-worktrees.ts:760`).
- **owner 프로세스**: DB를 쓰는 프로세스는 하나이고 SQLite 연결도 하나다(`db/sql-client.ts:14-19`).

## The Problem

사용자가 겪는 증상과 그 원인이다.

1. **승인하거나 재시도 시각이 와도 작업이 늦게 이어지고, 기다리는 동안 메모리가 샌다.**
   - owner 엔진은 `WorkflowEngine.makeUnsafe`에 `awaitComplete`를 넘기지 않는다(`workflow/owner-workflow-engine.ts:313-479`). 그래서 결과를 기다리는 호출자는 `suspendedRetrySchedule` 기본값(200ms에서 1.5배씩, 상한 30초) 간격으로 `run`을 다시 부른다(`effect:workflow/WorkflowEngine.ts:563-583`).
   - `run` 한 번마다 admit transaction, resume, workflow 본문 replay, 상태 쓰기를 하고, 닫지 않는 scope를 하나 만든다(`workflow/owner-workflow-engine.ts:211-264`).
   - 기다리는 곳은 셋이다: 승인 대기(`approvals/relayed.ts:131`, 최대 1일), provider 재시도 대기(`workflow/provider-retry.ts:145`), Goal 실행의 `succeed`/`fail`(`workflow/goal-execution.ts:145`, `:162`).
   - 결과: 승인 뒤 최대 30초 늦게 이어진다. 하루짜리 승인 대기 하나가 replay 약 2,880회를 일으키고 열린 scope 약 2,880개를 남긴다.
   - 이와 별개로 `workflow/owner-workflow-engine.ts`의 `executions` Map에서 항목을 지우지 않고(`:151`, `:207`), 실행마다 쓰지 않는 scope가 하나씩 남는다(`:196`, `:230`).
2. **같은 질문의 사람 결정 요청이 동시에 오면 프로세스 fiber가 죽고, 순서대로 오면 바뀐 사실이 버려진다.**
   - `kanban/human-decision.ts`의 payload에 kind 전체와 `createdAt`이 있다(`:227-234`). executionId는 (session, Goal, card, key)로만 만든다(`:243-244`).
   - 동시에 오면 payload가 달라 admission이 `execution_conflict` 결함을 낸다(`workflow/owner-workflow-storage.ts:263-270`).
   - 순서대로 오면 기존 요청을 그대로 돌려준다(`kanban/human-decision.ts:520-522`). 사실이 실제로 바뀌는 kind는 `FileOverlap`(`files`)과 `ProtectedBranchMerge`(`prAvailable`)다.
3. **"Goal이 안 바뀐다."**
   - 새 Goal 요청이 도구 호출 때 거절되면, 거절은 `workflow/workflow.ts`의 잠금 안 transaction에서 오류로 돌아가 함께 rollback된다(`:944-981`). 거절 reason은 도구 결과에만 있고 화면에는 보이지 않는다.
   - 재시작 전에 `accepted`가 된 요청은 다시 정산되지 않는다. 정산은 run이 끝날 때 한 번 한다(`agent/chat.ts:614`). 재시작하면 `ChatState`가 옛 프로세스의 run을 `failed`로 바꾸지만(`chat-state/chat-state.ts:101-106`), 요청은 `accepted`로 남는다. 그 뒤 같은 세션의 새 요청은 모두 `transition_pending`으로 거절된다(`workflow/workflow.ts:962`).
   - 칸반 보드에서 Goal을 고치면 phase가 그대로다. 이것은 의도된 동작이다. 오케스트레이터가 카드를 다시 분류한다(`workflow/workflow.ts:1053-1059`). 다만 화면에 이유가 보이지 않는다.
   - 로컬 DB에서 Goal이 있는 세션 15개 중 6개가 끝으로 갈 수 없는 상태다. 6개 모두 칸반이 아니다.
     - 3개(`30a41877`, `72be4272`, `36046ac9`): Goal과 Plan이 `completed`인데 phase가 `execute`다.
     - 3개(`bb5ac2d3`, `d2c8bc4d`, `e7f6f46b`): Plan은 `completed`, 검증은 `passed`인데 Goal이 `active`다.
   - 원인은 하나다. `updateProgress`가 `goal.status`와 `plan.status`를 입력대로 따로 바꾸고 phase는 바꾸지 않는다(`workflow/workflow.ts:1294-1320`). phase를 `completed`로 바꾸는 곳은 `finishRun`의 검증 정산뿐이다(`:910-929`). `reconcile`은 `execute`·`verify` phase만 고치고, Plan이 `completed`면 phase를 그대로 둔다(`:442-445`). 전이가 메서드마다 흩어져 있어 어떤 조합이 막다른 상태인지 코드로 알 수 없다.
4. **run 로그를 기다리는 reader가 공유 SQLite 연결을 초당 50번 잡는다.** 로그 끝에서 20ms마다 SELECT 3개짜리 transaction을 돈다(`workflow/durable-stream.ts:18`, `:181`).
5. **`Workflows.locked`가 교착될 수 있다.** session key lock 안에서 transaction을 연다(`workflow/workflow.ts:473-474`). transaction 안에서 다른 `Workflows` 호출이 같은 key lock을 기다리면, lock을 쥔 fiber는 연결을 기다리고 transaction을 연 fiber는 lock을 기다린다.
6. **끝난 Goal의 카드 worktree가 남는다.** 카드마다 git worktree를 쓰면서 폴더가 정리되지 않는 불편을 사용자가 처음부터 겪었다(2026-10-29 사용자 설명).
   - Plan 종료(`kanban/orchestrator.ts:895-899`의 `halt`)와 새 Goal 전환(`:885-893`) 경로는 worktree를 정리하지 않는다. 진행 중이던 카드의 결과는 이 두 경로가 먼저 `stopped`를 돌려주므로 처리되지 않는다(`:597-606`의 정리가 돌지 않음).
   - `<goalInstanceId>` 부모 폴더를 지우지 않는다(`kanban/git-worktrees.ts:242`).
   - `Done` 정리는 worktree가 깨끗할 때만 된다(`kanban/git-worktrees.ts:425`).
   - worktree base 폴더(`~/.context-generactive-agent-worktrees`)는 개발판과 설치판이 함께 쓴다(`kanban/git-worktrees.ts:47-50`). 그래서 내 DB에 없는 폴더를 지우면 다른 인스턴스의 작업을 지울 수 있다.
7. **고쳤는지 잴 수 없다.** 실행 행에 시각이 없다(`workflow/owner-workflow-storage.ts:272-276`). 엔진 함수는 span이 없다(`workflow/owner-workflow-engine.ts:170-311`).

지켜야 할 조건: 0.0.17 사용자가 업그레이드할 때 일반 재시작과 같은 표시 말고는 따로 할 일이 없어야 한다(결정 4). 0.0.17은 마지막 정식 릴리즈다. git 태그 `0.0.17`의 시각은 2026-10-21 02:04 KST(2026-10-20 17:04 UTC)다.

이 설계가 다루지 않는 문제도 있다. 결함으로 죽은 엔진 실행이 재시작 때마다 다시 도는 경로가 코드에 있다. 하지만 로컬 DB에는 그런 행이 없다. 실행 73건 중 `running`은 0건이다(GoalExecution 8, HumanDecisionExecution 15, KanbanCardAttempt 50). 그래서 G4는 이 경로를 작게만 막는다.

## Goals

각 목표의 `합격 기준`은 이 단계의 완료 조건이다.

1. **G1. 모든 Goal 상태 전이를 한 함수에 정의하고, 코드가 그 함수만 따르게 한다.** 이 단계에서 가장 중요한 목표다.
   - 상태와 사건은 Technical Plan A의 표다. 상태는 `session_workflows.state_json`의 phase, Goal, Plan에서 정해진다. 세션 실행 상태와 새 Goal 요청은 각자의 표에 남고, 시작 검사가 이 둘과 Goal 상태가 맞는지 본다.
   - `합격 기준:`
     - `transition(state, event)`가 모든 (상태, 사건) 쌍을 다룬다. 빠진 쌍은 컴파일 오류다.
     - 도달할 수 있는 모든 상태에서 끝 상태(`Completed`, `Stopped`)나 새 Goal로 가는 경로가 있다. 막다른 상태가 0개다.
     - 로컬 DB의 끝으로 갈 수 없는 세션 6개는 시작 검사가 규칙 R1·R2로 고친다. 고친 세션의 세션 실행 상태는 `stopped{state_reconciled}`이고 자동 run이 시작되지 않는다(결정 5).
     - "Goal이 안 바뀐다"의 세 경로가 e2e 테스트로 통과한다. 세 경로는 도구 호출 때의 거절 표시, 재시작 뒤 `accepted` 정산, 칸반 Goal 수정 뒤의 "카드 재분류 중" 표시다.
2. **G2. 대기는 schedule을 기다리지 않고 깨어난다.**
   - `합격 기준:`
     - 승인 대기, provider 재시도 대기, Goal 실행 정산에서 deferred가 채워지거나 clock이 발화하면, TestClock을 진행하지 않아도 호출자가 다음 단계로 간다.
     - 대기 중의 `run` 재호출은 schedule이 정한다. 1초에서 2배씩 늘고 상한은 5분이다. 하루짜리 대기의 재호출은 약 300회 이하다(지금 약 2,880회).
3. **G3. 끝난 실행은 메모리에서 내려간다.**
   - `합격 기준:` 실행이 Complete나 interrupt로 끝나면 `executions` Map과 그 실행의 scope에서 빠진다. 테스트는 Suspended→Complete 한 번 뒤 Map 크기가 시작값으로 돌아오는지 본다. 운영에서는 엔진 span의 `executions` 속성으로 본다(G8). child가 끝나면 부모를 깨우는 동작은 그대로 된다.
4. **G4. 이 단계가 다루는 실패 원인마다 처리를 정한다.**
   - 원인과 처리는 Technical Plan B3의 표다. 처리는 넷 중 하나다: 기다렸다가 재시도, reason과 함께 막음, Goal·카드 실패로 넘김, 요청 거절.
   - Goal이나 카드의 결과로 이어지는 원인은 G1 전이의 사건이 된다. 이어지지 않는 원인은 생긴 층에서 처리하고 owner 엔진까지 올리지 않는다.
   - `합격 기준:` B3 표의 원인마다 typed error나 기록된 결과가 있고, 테스트나 컴파일러가 처리를 확인한다.
5. **G5. run 로그 reader는 쓰기가 있을 때만 깨어난다.**
   - `합격 기준:` writer가 commit 뒤 `PubSub`로 reader를 깨운다. 쓰기가 없는 동안 reader의 SQL은 1초에 1번 이하다.
6. **G6. `Workflows.locked`에서 key lock을 뺀다**(결정 6).
   - `합격 기준:` `sql.withTransaction` 안에서 `Workflows` 메서드를 불러도 끝난다.
7. **G7. 끝난 Goal의 카드 worktree가 정리된다.**
   - Plan 종료와 새 Goal 전환은 그 Goal의 카드 worktree, `.goal` checkout, 부모 폴더를 정리한다. 각 카드의 작업은 카드 브랜치에 남는다.
   - 정리는 `git worktree remove`·`prune`으로 한다. 이 DB의 `kanban_goals`에 있는 Goal의 폴더만 다룬다.
   - 시작 sweep은 오케스트레이터가 attempt를 다시 보내기 전에 돈다. 첫 릴리즈의 sweep은 정리할 대상을 기록만 한다.
   - `ctx/*` 브랜치는 자동으로 지우지 않는다. 변경 없는 `Done` 카드 브랜치만 지금처럼 지운다.
   - `합격 기준:`
     - Plan 종료나 새 Goal 전환 뒤, 그 Goal의 폴더와 `.git/worktrees` 항목이 0이다. 그때 lease를 쥔 카드는 delivery가 끝날 때 정리된다.
     - kill -9 뒤 재시작하면, 큐 item·attempt가 남은 카드를 뺀 이 인스턴스의 고아 폴더와 고아 `.git/worktrees` 항목이 기록된다. 기록에서 빠진 고아 항목이 0이다.
8. **G8. 고친 것을 잴 수 있다.**
   - `합격 기준:` 엔진의 resume·wake·armClock·interrupt·awaitComplete와 `CardWorktrees.lease`, janitor의 sweep·settleGoal에 span이 있다. 엔진 span은 `executions`, `runs`, `clocks` 크기를 숫자 속성으로 단다. 실행 행에 만든 시각과 바뀐 시각이 남는다. 기존 `tools/profile`로 이 span을 읽는다.
9. **G9. 0.0.17에서 일반 재시작과 같은 표시만 보이며 올라온다.**
   - `합격 기준:` 0.0.17 태그의 코드로 만든 fixture DB로 업그레이드 테스트가 통과한다.
     - 대기 승인과 발화 전 provider 재시도 clock이 이어진다.
     - 진행 중이던 run은 `failed`(`server_restarted`)로 끝난다.
     - 재시작 전에 `accepted`였던 새 Goal 요청은 `rejected{run_outcome_uncertain}`이 된다.
     - R1·R2 모양의 세션은 고쳐지고 `stopped{state_reconciled}`이다.
     - 시작 migration이 fixture에서 2초 안에 끝난다.
   - 칸반 행(사람 결정, 카드 attempt, 큐 item)은 fixture에 넣지 않는다. 칸반을 실제로 쓴 사람은 사용자 한 명이다(2026-10-29 사용자 확인). 칸반 행의 변환은 옛 형식 행을 직접 넣는 migration 테스트로만 확인한다.

## Non-Goals

- **S2 이후의 일.** admission 분리, 앱 소유 조회 표, `workflowExecutions(name)` 전체 조회 개선, `ClusterWorkflowEngine` 비교, 카드 준비 방식(A′ worktree 재사용 pool, B 허용 목록 COW 복제)은 하지 않는다.
- **durable 행 삭제.** 무엇을 지울지는 S2에서 결정 8의 기준으로 분류한다. 이 단계는 지우는 행을 늘리지 않는다.
- **살아 있는 Goal의 worktree TTL.** 결정 10의 "마지막 lease 뒤 14일"은 미룬다. 사람이 그 폴더에서 직접 고치는 카드를 lease 없이 지울 위험이 있다. G7 뒤 남은 폴더 수(sweep span)를 보고 다시 정한다.
- **브랜치 gc와 원격 보관.** 사용자가 부르는 `ctx/*` 브랜치 gc와 원격 보관은 브랜치가 쌓여 불편해질 때 만든다.
- **결함으로 끝난 엔진 실행의 다시 시도.** 다시 시도 버튼과 실패 상태 값은 만들지 않는다(D2, D4). 실패가 실제로 생기는지 G8 span과 로그로 본 뒤 정한다.
- **provider 오류 분류 변경.** 어떤 provider 오류를 `ProviderRetryWait`로 기다릴지는 지금 규칙(2026-10-13 결정)을 유지한다.
- **진행 중 run을 재시작 뒤 이어 가는 것.** no-replay 규칙을 유지한다.
- **0.0.17로의 다운그레이드.**
- **turbovec·기억 검색 개편.**

## Open Questions

- **microVM과 volume 방식.** 깊게 조사하지 않았다. 단일 실행 파일 배포와 Windows 지원에서 AgentFS와 같은 외부 런타임 문제가 생길 것으로 보지만 확인하지 않았다. S4에서 다룬다.

## Critical User Journeys (CUJs)

### CUJ 1: 승인 뒤 도구가 바로 이어진다

- **Given:** 모델이 승인이 필요한 도구를 불렀고, 승인 요청이 화면에 떠 있다. 몇 시간이 지났다.
- **When:** 사용자가 승인한다.
- **Then:** 도구가 schedule을 기다리지 않고 실행된다. 기다리는 동안 엔진 span의 `executions` 값은 늘지 않았다.

### CUJ 2: 새 Goal로 바꾼다

- **Given:** Goal이 진행 중이거나, 앞선 run이 재시작으로 끊긴 채 남아 있다.
- **When:** 사용자가 새 Goal로 바꾸라고 한다.
- **Then:** Goal이 바뀐다. 바뀔 수 없으면 화면에 거절 reason(예: run 결과를 알 수 없음)과 사용자가 할 일이 보인다. 앱을 재시작해도 요청이 `accepted`에 갇히지 않는다.

### CUJ 3: 0.0.17에서 업그레이드한다

- **Given:** 0.0.17에 대기 중인 승인과 provider 재시도가 있고, 끝으로 갈 수 없는 세션이 있다.
- **When:** 새 버전으로 바꾸고 앱을 시작한다.
- **Then:** 일반 재시작과 같은 표시만 보인다. 대기 항목은 이어진다. 끝으로 갈 수 없던 세션은 고쳐진 상태로 `stopped`이고, 자동 run이 시작되지 않는다. 화면에 "앱이 상태를 고쳤어요"가 보인다.

### CUJ 4: Plan을 끝내거나 새 Goal로 넘어간다

- **Given:** 칸반 Goal에 진행 중, 막힘, 사람 결정 대기 카드가 있고 각자 worktree가 있다.
- **When:** 사용자가 Plan을 끝내거나 새 Goal로 넘어간다.
- **Then:** 카드 worktree 폴더, `.goal` checkout, Goal 부모 폴더가 정리된다. 각 카드의 작업은 카드 브랜치에 남는다. 다른 인스턴스(개발판·설치판)의 worktree는 그대로다.

### CUJ 5: 앱이 비정상 종료된 뒤 다시 시작한다

- **Given:** 카드 실행 중 앱이 kill -9로 죽었다.
- **When:** 앱을 다시 시작한다.
- **Then:** 오케스트레이터가 attempt를 다시 보내기 전에 sweep이 이 인스턴스의 worktree를 DB 상태와 맞춰 본다. 첫 릴리즈에서는 정리할 대상을 기록만 하고, 다음 릴리즈에서 정리한다. 큐 item·attempt가 남은 카드의 worktree는 건드리지 않는다.

## Technical Plan (Architecture)

바꾸는 곳은 일곱 부분(A–G)이다. 방법이 둘 이상인 결정은 넷(D1–D4)이다.

- D1·D3는 사용자가 2026-10-29에 골랐다.
- D2·D4는 사용자가 2026-10-29에 고른 뒤, 같은 날 리뷰 근거로 줄였다. 사용자가 기술 판단을 맡겼다(2026-10-29). 바꾼 이유는 각 결정과 `docs/decisions.md`에 적는다.
- 나머지는 답이 하나라고 보고 정했고, 이유를 함께 적었다.

### 앱 시작 순서

지금은 migration 뒤 각 layer가 만들어지면서 일을 시작한다. workflow를 등록하는 layer들(`approvals/relayed.ts:203-211`, `workflow/goal-execution.ts:175-178`, `workflow/provider-retry.ts:272-275`, `kanban/human-decision.ts:716-722`)은 서로 형제이고, 각자 `ownerWorkflowEngineLayer`를 직접 쓴다. 등록하면 엔진이 그 workflow의 대기 실행을 resume한다. 칸반 오케스트레이터는 만들어질 때 활성 Goal의 attempt를 다시 보낸다(`kanban/orchestrator.ts:1090-1094`).

이 단계는 순서를 layer 의존으로 정한다. 의존이므로 타입이 순서를 보장한다.

```text
Database.layer: migration (열·표 추가, D3 payload 변환)
  │
  ▼
WorkflowStartup (새 marker 서비스, ownerWorkflowEngineLayer가 의존)
  ├─ Goal 상태 검사: 모든 세션을 decode
  │    ├─ 맞음 ───────────────▶ 그대로
  │    ├─ 낡은 phase ─────────▶ 지금 reconcile처럼 phase만 고침
  │    └─ 모순(R1·R2·Unknown) ▶ 고친 revision + stopped{state_reconciled}
  ├─ 세션 실행 상태 검사: Running이 아닌 세션의 ready·retrying ─▶ stopped{state_reconciled}
  └─ accepted 새 Goal 요청 정산: run이 completed가 아니면 rejected{run_outcome_uncertain}
  │
  ▼
owner 엔진 생성 → 각 workflow 등록: 대기 실행 resume
  │
  ▼
CardWorkspaceJanitor (KanbanOrchestrator가 의존): 시작 sweep
  │
  ▼
KanbanOrchestrator: recover → board loop
  │
  ▼
AgentChat: 끊긴 run의 afterRestart, ready·retrying 세션 재개 (agent/chat.ts:2924-2960)
```

- `WorkflowStartup`은 `Workflows`와 `WorkflowExecution`만 쓴다. 둘 다 SQL만 쓰므로(`workflow/workflow.ts:465-470`, `workflow/execution.ts:109-110`) 엔진과 순환하지 않는다.
- `afterRestart`는 세션 실행 상태가 같은 run의 `running`일 때만 바꾼다(`workflow/execution.ts:233`). 그래서 시작 검사가 `stopped`로 바꾼 세션은 그대로 남는다.
- sweep은 큐 worker보다 먼저일 필요가 없다. worker는 큐에 있는 카드만 처리하고, sweep은 큐 item·attempt가 있는 카드를 건너뛴다. 새 큐 item은 오케스트레이터 recover와 사용자 요청에서만 생긴다. 사용자 요청은 layer가 다 만들어진 뒤에 들어온다.

### A. Goal 상태 전이 (G1, D1)

**지금.** 전이는 `Workflows`의 메서드 14개에 흩어져 있다: `setPhase`, `controlGoal`, `finishRun`, `startNewGoal`, `requestNewGoal`, `settleNewGoalRequest`, `updateGoal`, `updatePlan`, `updateProgress`, `closePlan`, `editBoard`, `holdCard`, `transitionCard`, `reconcile`. 결정을 순수 함수로 뗀 곳은 일부뿐이다: 사용자 행동 허용 여부(`workflow/actions.ts`의 `evaluateWorkflowAction`), 보드 편집(`workflow/board-edit.ts`의 `planBoardEdit`·`planCardTransition`).

**(결정 2026-10-29) D1. 전이는 순수 함수로 두고, 빠진 조합은 타입 오류가 되게 한다.** 도달 상태는 테스트가 탐색한다. 다른 안(이름 붙은 상태와 손으로 쓴 표, phase를 계산 값으로 바꾸기)은 Alternatives에 적는다.

- 새 순수 모듈 `workflow/goal-transitions.ts`에 상태, 사건, 전이를 모은다. `Workflows` 메서드는 "decode → `transition` → encode·저장"이 된다. `board-edit.ts`의 plan/apply 방식과 같다.
- `transition(state, event)`는 `Moved{next, display}`나 `Refused{reason}`를 돌려준다. `reason`과 `display`는 literal union이다. 빠진 (상태, 사건) 쌍은 컴파일 오류다.

**상태의 범위.** `GoalState`는 `session_workflows.state_json`의 phase, Goal, Plan만으로 정한다.

- 세션 실행 상태는 이미 tag union이고(`workflow/execution.ts:48-69`) 다른 저장소(`chat_metadata`)와 서비스(`WorkflowExecution`)에 있다. 새 Goal 요청은 `workflow_new_goal_requests`에 있다. 이 둘은 각자의 표와 서비스에 둔다. 앱 시작 검사가 Goal 상태와 맞는지 본다.
- 칸반 카드 상태는 `GoalState`에 넣지 않는다. 카드 전이는 지금처럼 `board-edit.ts`가 정의한다. Goal 상태는 Plan의 단계가 모두 `done`인지만 본다(`implementationComplete`).
- 그래서 한 전이의 쓰기는 `session_workflows` 한 곳이다. 두 저장소를 함께 쓰는 곳은 시작 검사 하나다. 시작 검사는 고칠 세션마다 `sql.withTransaction` 하나에서 revision과 세션 실행 상태를 함께 쓴다. 연결이 하나이므로(`db/sql-client.ts:14-19`) 다른 공유 장치는 두지 않는다.

**phase의 두 의미.** 저장된 phase는 두 가지를 함께 담는다. 하나는 화면 위치(`chat`, `goal`, `plan`)이고, 다른 하나는 진행 위치(`execute`, `verify`, `completed`)다. 화면 이동은 언제나 허용되고 Goal·Plan을 바꾸지 않는다(`workflow/actions.ts:73`). 그래서 `GoalState`의 각 tag는 phase를 `view` 필드로 가진다. 화면 위치는 모든 tag에서 쓸 수 있다. 진행 위치는 그 tag가 허용하는 값만 쓸 수 있다.

**`GoalState` tag.** 코드의 guard(`workflow/actions.ts:56-95`, `workflow/workflow.ts:438-463`, `workflow/execution.ts:103-107`)와 로컬 DB의 세션 15개에서 정했다.

| tag           | `goal.status`      | Plan                                           | 허용 진행 위치                     | 화면 문구                       |
| ------------- | ------------------ | ---------------------------------------------- | ---------------------------------- | ------------------------------- |
| `NoGoal`      | 없음               | 없음                                           | 없음                               |                                 |
| `Shaping`     | `draft`, `active`  | 없음, `draft`, `ready`                         | 없음                               |                                 |
| `Running`     | `active`           | `executing`, `plan.goalVersion = goal.version` | `execute`, `verify`                |                                 |
| `GoalChanged` | `active`           | `executing`, `plan.goalVersion < goal.version` | 칸반 Goal은 `execute`, 아니면 없음 | 칸반 Goal: `card_reclassifying` |
| `Paused`      | `paused`           | 없음, `draft`, `ready`, `executing`, `blocked` | 그대로 둠                          |                                 |
| `Blocked`     | `active`           | `blocked`                                      | `verify`                           |                                 |
| `Stopped`     | `failed`           | 없음, `draft`, `ready`, `blocked`, `closed`    | 그대로 둠                          |                                 |
| `Closed`      | `active`, `paused` | `closed`                                       | 없음                               |                                 |
| `Completed`   | `completed`        | 없음, `completed`, `closed`                    | `completed`                        |                                 |

- "그대로 둠"은 pause·stop이 phase를 바꾸지 않는 지금 동작이다(`workflow/workflow.ts:792-797`). 그 tag는 저장된 진행 위치를 값으로 들고 있다가 resume 때 쓴다.
- `GoalChanged`가 칸반인지는 `kanban_goals`에 활성 행이 있는지로 안다. decode는 이 값을 입력으로 받는다.

**decode의 세 결과.** decode는 저장된 값을 `GoalState`나 `GoalStateConflict`로 바꾼다.

- 맞음: `GoalState`가 나온다.
- 낡은 phase: Goal과 Plan은 어느 tag에 맞지만 진행 위치가 그 tag에 허용되지 않는다. 예: `Shaping`인데 phase가 `verify`다. 지금 `reconcile`처럼 phase만 고친다. 고치는 값은 `reconciledWorkflowPhase`(`workflow/workflow.ts:438-463`)와 같다. 세션 실행 상태는 바꾸지 않는다.
- 모순: Goal과 Plan이 어느 tag에도 맞지 않는다. `GoalStateConflict`는 tag union이고, 고치는 함수는 모든 case를 `Match.valueTags`로 다룬다.
  - `R1 GoalCompletedPhaseOpen`: Goal이 `completed`인데 진행 위치가 `execute`나 `verify`다. `Completed{view: completed}`로 고친다. 로컬 세션 3개.
  - `R2 PlanCompletedGoalOpen`: Plan이 `completed`인데 Goal이 `active`나 `paused`다. `Running{view: verify}`로 고치고 Plan을 `executing`으로 되돌린다. Goal 완료 근거를 다시 기록하면 `finishRun`이 끝낸다. 로컬 세션 3개.
  - `Unknown`: 그 밖의 조합이다. phase를 `goal`로 두고 Goal·Plan은 바꾸지 않는다. 경고 로그에 세션 id와 저장 값을 남긴다.
  - 세 경우 모두 새 revision과 ledger `phase_changed ... (state reconciled)`를 남기고, 세션 실행 상태를 `stopped{state_reconciled}`로 둔다.
- 활성 `kanban_goals` 행이 있는 세션은 모순이어도 고치지 않고 경고 로그만 남긴다. 오케스트레이터가 같은 Plan을 쓰고 있기 때문이다. 로컬 DB에는 이런 세션이 없다.
- 실행 중(시작 검사 뒤)에 decode가 모순을 내면 같은 고치는 함수를 쓴다. 이 경우 전이는 `Refused{reason: "state_reconciled"}`를 돌려주고, 화면은 CUJ 3과 같은 문구를 보인다.

**`GoalEvent` tag와 메서드.** 각 메서드는 사건 하나를 만든다. 사건의 필드는 메서드 입력에서 온다.

| 메서드                                        | 사건                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `setPhase(phase)`                             | phase가 `execute`면 `ExecutionApproved`, 아니면 `Navigated{phase}` |
| `controlGoal(action)`                         | `Paused`, `Resumed`, `StoppedByUser`                               |
| `updateGoal(input)`                           | `GoalEdited{status}`                                               |
| `updatePlan(input)`                           | `PlanEdited{status}`                                               |
| `updateProgress(input)`                       | `ProgressRecorded{goalStatus, planStatus, verification}`           |
| `finishRun(startedPhase)`                     | `RunFinished{startedPhase}`                                        |
| `closePlan(reason)`                           | `PlanClosed`                                                       |
| `startNewGoal`, `settleNewGoalRequest`의 적용 | `NewGoalStarted`                                                   |
| `requestNewGoal`                              | `NewGoalRequested` (`Moved`면 요청을 `accepted`로 쓴다)            |
| `editBoard`, `holdCard`, `transitionCard`     | `BoardEdited`                                                      |

- `reconcile`은 사건이 아니라 decode의 고치는 함수를 부른다.
- 보드 메서드의 카드 변경은 지금처럼 `planBoardEdit`·`planCardTransition`이 정한다. `BoardEdited`는 Plan이 보드를 받을 수 있는 상태인지만 정한다.
- `ProgressRecorded`가 Plan만 `completed`로 바꾸려 하면 `Refused{reason: "goal_completion_required"}`다. Goal을 `completed`로 바꾸면 phase도 `completed`가 된다. 이것이 R1·R2가 생기던 경로를 막는다.
- `WorkflowExecution`의 메서드 6개는 이 함수로 옮기지 않는다. 세션 실행 상태는 이미 tag union이다. 이 단계는 `stopped.reason`에 `state_reconciled`만 더한다(`workflow/execution.ts:66-68`).
- `evaluateWorkflowAction`은 세션 lease와 run 진행 검사(`workflow/actions.ts:61-66`)를 지금처럼 하고, 상태 판단은 `transition`에 맡긴다. 같은 규칙이 두 곳에 있으면 D1의 목적이 깨진다.

**도달 상태 탐색 테스트.**

- 처음 상태(`NoGoal`)에서 모든 사건을 적용해 도달할 수 있는 `GoalState`를 너비 우선으로 모은다.
- 무한히 많은 값은 작은 값으로 줄인다. Plan 단계 수는 0·1·2개로, 버전 차이는 같음·작음으로 줄인다.
- 검사: 도달한 모든 상태에서 끝 상태나 `NewGoalStarted`로 가는 경로가 있다. 도달한 상태는 모두 encode→decode가 같은 값으로 돌아온다.
- 테스트는 도달 상태와 전이 목록을 `docs/goal-transitions.md`로 만든다. 사람은 이 생성물을 리뷰한다. 코드와 생성물이 다르면 테스트가 실패한다. 전이가 바뀌면 리뷰할 diff가 생기게 하는 snapshot 검사다.
- 줄인 값이 실제 버그를 가릴 수 있다. 칸반 순서 문제는 기존 칸반 시나리오 테스트로 따로 본다.

**새 Goal 요청.**

- **도구 호출 때의 거절은 영속하지 않는다.** `requestNewGoal`의 `NewGoalTransitionRefused`는 지금처럼 도구 결과로 돌아간다. 화면은 도구 결과의 reason을 문구로 보인다. 서버는 reason을 경고 로그에 남긴다.
  - ledger에 쓰면 revision이 바뀐다(`workflow/workflow.ts:546-565`). 그러면 같은 세션에서 이미 `accepted`인 요청이 정산 때 `workflow_changed`로 거절된다(`:1014-1016`). 고치려던 증상을 새로 만든다.
  - `workflow_new_goal_requests`에 `refused` 행을 두면, 같은 run의 다음 요청이 모두 `transition_pending`으로 거절된다(`:955-957`).
  - 정산 때의 거절은 이미 `status='rejected', reason`으로 저장된다(`:1007-1008`).
- **재시작 뒤 `accepted`를 정산한다.** 시작 검사가 모든 `accepted` 요청을 정산한다. 옛 프로세스의 run은 `completed`가 아니면 결과를 알 수 없으므로 `rejected{run_outcome_uncertain}`이다. `completed`면 지금 정산 규칙(`:1012-1030`)을 그대로 쓴다.
  - 프로세스 안에서 승인을 기다리는 run(`interrupted`)의 요청은 지금처럼 `accepted`로 둔다(`:996-1001`). 승인 뒤 run이 끝나면 `agent/chat.ts:614`가 다시 정산한다. 이 경우는 갇힌 것이 아니다.
- **`rejected.reason`을 literal로 바꾼다.** `NewGoalSettlement.rejected.reason`은 `string | null`이다(`:263`). 이것을 `NewGoalTransitionRefused`의 reason literal(`:246-255`)이나 null로 decode한다. null은 0.0.17 이전 행에 있을 수 있다. DB에 쓰는 값은 이미 이 literal뿐이다(`:1013`, `:1016`, `:1029`).

**비용**

- `Workflows` 메서드 14개의 refactor가 이 단계에서 가장 큰 일이다. 메서드 하나씩 옮기고, 옮길 때마다 기존 테스트가 통과해야 한다.
- (상태 × 사건) 쌍은 9 × 14 = 126개다. 같은 결과의 쌍은 묶어 적지만 함수가 길다.

### B. owner 엔진 (G2, G3, G4)

**B1. 대기 깨우기.**

- 엔진이 `makeUnsafe`에 `awaitComplete`를 넘긴다(`effect:workflow/WorkflowEngine.ts:440-443`). 라이브러리는 이 hook과 schedule sleep 중 먼저 끝나는 쪽을 쓴다(`:579-582`). schedule은 hook이 놓친 깨움을 되살리는 안전망이다.
- 실행이 Complete나 interrupt로 끝나면, 엔진이 executionId를 `PubSub`에 발행한다.
- hook은 먼저 구독하고, 저장소에서 status를 읽는다. status가 `completed`나 `interrupted`면 바로 끝난다. 그 밖이면 자기 executionId가 올 때까지 기다린다.
  - `result_json`이 NULL인 `running` 행도 기다린다. hook이 일찍 끝나면 호출자가 sleep 없이 바로 다시 돌기 때문이다(`effect:workflow/WorkflowEngine.ts:433-438`).
  - 구독을 먼저 하므로 그 사이에 끝난 실행도 놓치지 않는다.
- 세 workflow 정의(`RelayedApprovalExecution` `approvals/relayed.ts:41`, `ProviderRetryWait` `workflow/provider-retry.ts:78`, `GoalExecution` `workflow/goal-execution.ts:41`)에 `suspendedRetrySchedule`을 둔다. 1초에서 2배씩, 상한 5분이고 끝나지 않는다. 정의의 필드이므로(`effect:workflow/Workflow.ts:62`) 호출하는 쪽은 바뀌지 않는다. schedule이 끝나면 라이브러리가 결함을 내므로(`effect:workflow/WorkflowEngine.ts:573-577`) 끝나지 않는 schedule이어야 한다.

**B2. 실행의 메모리 수명.**

- `executions` Map의 항목은 Complete·interrupt 때 지운다. 새 항목을 넣는 일과 interrupt 표시를 옮기는 일은 한 번의 원자 갱신에서 한다(`docs/decisions.md:2935`).
- scope는 실행마다 하나만 만든다. resume 사이에는 재사용하고, Complete·interrupt 때 닫는다.
- child가 끝났을 때 부모를 Map이 아니라 저장소에서 찾는다. 그래서 부모가 Map에서 빠져 있어도(재시작 직후) 깨어난다(`workflow/owner-workflow-engine.ts:251-261`).

**B3. 실패 원인과 처리 (G4).**

| 원인                                        | 생기는 층      | 오류 또는 기록                                                                                                        | 처리                                                                     |
| ------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| workflow 본문의 typed 실패·결함             | workflow 본문  | `Complete{exit: failure}` (라이브러리 기본, `effect:workflow/Workflow.ts:732-734`, `:1023-1028`)                      | 지금과 같다. 호출자가 실패를 받는다                                      |
| 엔진이 결과를 encode하지 못함               | owner 엔진     | 새 기록: `Complete{exit: die(OwnerWorkflowEngineError{operation: "execution.result", reason: "result_unencodable"})}` | 결정적 실패다. resume하지 않는다. 호출자는 결함을 받는다                 |
| 엔진의 SQL 쓰기 실패                        | owner 엔진     | 지금처럼 결함(`workflow/owner-workflow-engine.ts:138-145`)                                                            | `running`으로 남아 다음 시작에서 다시 돈다. 일시 실패일 수 있기 때문이다 |
| 같은 질문의 사람 결정 동시 요청             | 칸반 사람 결정 | 없음. 같은 payload라 하나로 모인다                                                                                    | D3                                                                       |
| 오래된 사실로 한 답                         | 칸반 사람 결정 | `HumanDecisionRefused{reason: "facts_changed"}`                                                                       | HTTP 409. 화면이 다시 읽는다                                             |
| 새 Goal 요청 거절                           | Goal 상태      | `NewGoalTransitionRefused{reason}` (기존)                                                                             | 도구 결과와 화면에 reason. 경고 로그                                     |
| 재시작으로 결과를 모르는 run의 새 Goal 요청 | Goal 상태      | `rejected{run_outcome_uncertain}`                                                                                     | 시작 검사가 저장한다                                                     |
| 저장된 Goal 상태의 모순                     | Goal 상태      | `GoalStateConflict`                                                                                                   | A의 고치는 함수. `stopped{state_reconciled}`                             |
| Plan만 완료로 바꾸려는 진행 기록            | Goal 상태      | `Refused{goal_completion_required}`                                                                                   | 도구 결과로 돌아간다                                                     |
| 카드 lease 중인 worktree 정리               | 칸반 worktree  | `CardWorktreeFailed{reason: InUse}` (기존, `kanban/git-worktrees.ts:414-417`)                                         | 건너뛰고 delivery 끝(W2)에서 정리                                        |

- 엔진 interface의 오류 채널은 `never`다(`effect:workflow/WorkflowEngine.ts:394-428`). 그래서 엔진 안의 실패는 typed error로 호출자에게 갈 수 없다. 결정적 실패는 라이브러리가 본문 결함을 저장하는 방식과 같은 `Complete{exit: die}`로 남긴다.

**(결정 2026-10-29, 리뷰 반영으로 줄임) D2. 엔진 실행 status 값은 바꾸지 않는다. 결정적인 엔진 실패는 결함 결과로 저장한다.**

- 원안은 status에 `failed`를 더하고 표를 다시 만드는 것이었다. 원안은 Alternatives에 적는다.
- 줄인 이유:
  - 본문 결함은 이미 `completed`로 저장된다(`effect:workflow/Workflow.ts:732-734`). `running`에 남는 길은 본문 밖 엔진 단계뿐이다.
  - 엔진 단계의 실패 중 SQL 오류는 다음 시작에서 다시 도는 것이 맞다. 남는 대상은 결과 encode 실패뿐이다.
  - 로컬 DB에는 `running` 실행이 0건이다.
  - 원안은 표 재생성, migration 규칙 일반화, `failed`를 읽는 모든 소비자 수정(승인 응답, 사람 결정 목록, 카드 attempt 복구), 다시 시도 route와 화면을 부른다.
- 시각 열은 남긴다. `created_at`, `updated_at`을 `ALTER TABLE ... ADD COLUMN`으로 더한다. 둘 다 INTEGER millis이고 NULL을 허용한다. 0.0.17 행은 NULL이다. 표를 다시 만들지 않으므로 참조하는 표 넷(`db/migrations.ts:1399`, `:1407`, `:1415`, `:1440`)은 건드리지 않는다.

### C. 사람 결정 요청 (G4, D3)

**(결정 2026-10-29) D3. 사람 결정 요청을 "무엇을 묻는지"(occasion)와 "물을 때 본 사실"(facts)로 나눈다.** 다른 안은 Alternatives에 적는다. 리뷰 반영으로 두 가지를 줄였다: payload에는 occasion 대신 key 문자열을 넣고, 이전 사실을 펼쳐 보는 화면은 만들지 않는다.

**occasion.**

- 새 `DecisionOccasion`은 kind tag마다 case가 하나인 `Schema.TaggedUnion`이다. 각 case는 지금 key 문자열에 들어 있는 값을 필드로 가진다. 코드 안에서만 쓰고 저장하지 않는다.
- key 문자열은 occasion에서 만든다. 형식은 지금과 같다. 그래서 기존 실행의 executionId가 바뀌지 않는다.

| occasion                                   | key 형식                                        | 지금 만드는 곳                |
| ------------------------------------------ | ----------------------------------------------- | ----------------------------- |
| `RetryExhausted{attemptNo}`                | `retry_exhausted:${attemptNo}`                  | `kanban/orchestrator.ts:352`  |
| `IntegrationConflict{attemptNo, answered}` | `integration_conflict:${attemptNo}:${answered}` | `kanban/orchestrator.ts:420`  |
| `UncertainSideEffect{runId, attemptNo}`    | `uncertain_side_effect:${runId}:${attemptNo}`   | `kanban/orchestrator.ts:618`  |
| `FileOverlap{otherGoalInstanceId}`         | `file_overlap:${otherGoalInstanceId}`           | `kanban/orchestrator.ts:866`  |
| `MergeConflict{goalHead, targetHead}`      | `merge_conflict:${goalHead}:${targetHead}`      | `kanban/merge-queue.ts:263`   |
| `ProtectedBranchMerge{head}`               | `protected_branch:${head}`                      | `kanban/merge-queue.ts:311`   |
| `ImpactUnclear{fromVersion, toVersion}`    | `impact_unclear:${fromVersion}:${toVersion}`    | `kanban/board-actions.ts:693` |

- 요청 입력은 tag마다 occasion과 사실(`DecisionKind`의 같은 tag case)을 함께 받는 union이다. tag가 다른 occasion과 사실을 짝지으면 컴파일이 실패한다.
- 엔진 payload는 `{sessionId, goalInstanceId, cardId, key}`다. 같은 occasion은 항상 같은 payload이므로, 동시에 와도 admission이 기존 실행을 돌려준다.

**facts.**

- 새 표 `human_decision_facts`에 사실을 쌓는다. 덮어쓰지 않는다.

```text
human_decision_facts
  execution_id  TEXT NOT NULL      -- owner_workflow_executions, ON DELETE CASCADE, DEFERRABLE INITIALLY DEFERRED
  seq           INTEGER NOT NULL   -- 1부터
  kind_json     TEXT NOT NULL      -- DecisionKind, json_valid
  observed_at   INTEGER NOT NULL   -- millis
  PRIMARY KEY (execution_id, seq)
```

- 새 요청은 실행 행과 첫 사실 행을 한 transaction에 쓴다. `OwnerWorkflowAdmission.admit(request, bind)`의 bind가 사실 행을 쓴다(선례 `workflow/goal-execution.ts:101-116`). bind는 실행 행보다 먼저 돌므로 외래 키는 commit 때 검사한다(선례 `db/migrations.ts:437`).
- 행이 이미 있으면 admission은 bind를 돌리지 않는다(`workflow/owner-workflow-storage.ts:316-318`). 이미 있는 요청에 사실을 더하는 일은 새 함수 `appendFacts(executionId, kind)`가 한다.
  - 한 transaction 안에서 마지막 사실 행을 읽는다. 같으면 쓰지 않는다. 다르면 `seq + 1` 행을 쓴다.
  - 답했거나 닫힌 요청이면 쓰지 않는다. 답은 그 occasion에 대한 것이므로 다시 묻지 않고 그 답을 쓴다.
  - 엔진 호출은 이 transaction 밖에서 한다. 하나뿐인 연결을 쥔 채 엔진 resume을 기다리면 교착이 생긴다.
- `request`의 순서: 기존 요청이면 `appendFacts` → 없으면 admit(첫 사실 포함) → admit이 기존 실행을 돌려줬으면(동시 요청에 졌으면) `appendFacts`.

**화면과 답.**

- `view`는 최신 사실, 최신 순번 `factsSeq`, `factsChanged`(`factsSeq > 1`)를 내놓는다. 화면은 최신 사실과 "물은 뒤 바뀜" 표시를 보인다.
- 답 본문에는 사용자가 본 `factsSeq`가 반드시 온다. 최신이 아니면 `HumanDecisionRefused{reason: "facts_changed"}`로 거절한다. lock 없이 비교한 뒤 거절한다.
- 경합: 비교와 답 기록 사이에 사실이 더해질 수 있다. 그때 답은 한 단계 오래된 사실로 받아들여진다. 사용자가 한 명이고 창이 짧아 받아들인다(Risks 9).
- `answerFits`는 최신 사실로 검사한다(`kanban/human-decision.ts:296-305`).
- 만든 시각은 실행 행의 `created_at`에서 읽는다.

**보존.** 사실 행은 사람이 화면에서 보는 기록이므로 결정 8의 근거에 든다. Goal purge가 실행 행을 지우면 cascade로 함께 지워진다(`docs/decisions.md:2625`).

**0.0.17 행.**

- startup transaction 안의 TypeScript 단계 하나가 모든 `HumanDecisionExecution` 행을 바꾼다. 답했거나 닫힌 행도 바꾼다. 화면의 이력이 같은 decoder로 읽기 때문이다. 선례는 `migrateTanStackRows`(`db/database.ts:147-152`)다.
- 지금 payload schema로 decode한다. key 문자열은 decode하지 않고 그대로 옮긴다.
  - 성공: kind를 사실 첫 행(`observed_at` = 옛 `createdAt`)으로, `createdAt`을 `created_at` 열로 옮기고, payload를 앱의 새 Schema로 encode해 다시 쓴다. 앱과 같은 encode이므로 다음 admission의 payload 비교와 맞는다.
  - 실패: 그 행은 그대로 둔다. 앱은 이미 decode되지 않는 payload를 건너뛴다(`kanban/human-decision.ts:349-352`). 건너뛴 수를 로그에 남긴다.
- 확인은 옛 형식 행을 직접 넣는 migration 테스트 하나로 한다.

### D. run 로그 (G5)

- 새 서비스 `RunLogSignals`(`workflow/durable-stream.ts`)가 run id를 실은 `PubSub`를 가진다. `sqliteRunLog`의 `append`와 `close`는 transaction이 commit된 뒤 run id를 발행한다.
- reader는 로그 끝에 닿으면, 먼저 구독하고 페이지를 한 번 더 읽는다. 그래도 비어 있으면 자기 run id가 오거나 1초가 지날 때까지 기다린다. 지금의 20ms sleep(`:18`, `:181`)을 이것으로 바꾼다.
- 공급: `sqliteRunLog`는 서비스를 읽는 `Effect.fn`이다(`:36-42`). `AgentChat`이 `RunLogSignals`를 읽어 `committedLog`(`agent/chat.ts:497`)에서 SqlClient와 함께 제공한다. layer는 `layers.ts`의 `stores`에 둔다.
- 기존 `AppEvents` PubSub를 쓰지 않는 이유: `AppEvents`는 화면 SSE 구독자에게 가는 이벤트다. chunk마다 발행하면 모든 SSE 구독자가 깨어난다.
- 1초 poll이 남는 이유: 발행하지 않는 쓰기 경로가 나중에 생겨도 reader가 멈추지 않게 한다.

### E. 잠금 (G6)

- `Workflows.locked`(`workflow/workflow.ts:473-474`)에서 `serialize`를 지우고 `persisted(sql.withTransaction(effect))`만 남긴다(결정 6).
- 앱의 SQLite 연결은 하나이고, transaction이 끝날 때까지 semaphore로 쥔다(`db/sql-client.ts:14-19`). 그래서 key lock이 막아 주는 경쟁이 없다.
- `keyedSerialLimit` 모듈(`concurrency/keyed-limit.ts`)은 지우지 않는다. `subagents/subagents.ts:548`과 `agent/chat.ts:670`이 쓴다. 지우는 것은 `workflow/workflow.ts`의 import(`:16`)와 `serialize`(`:470`)뿐이다.

### F. 카드 worktree 정리 (G7)

**소유 판정.** 폴더 경로는 `<base>/<goalInstanceId>/<cardId>`이고(`kanban/git-worktrees.ts:242`), `.goal` checkout은 `<base>/<goalInstanceId>/<.goal 폴더>`다(`:760`). goalInstanceId는 무작위 UUID다(`workflow/workflow.ts:1041`). 그래서 "폴더의 goalInstanceId가 이 DB의 `kanban_goals`에 있으면 이 인스턴스의 것"으로 판정한다. `kanban_goals`에는 `project_root`와 `status`(`active`, `stopped`)가 있다(`kanban/card-attempts.ts:114-123`).

- 새 표와 표식 파일은 두지 않는다. 이 규칙은 업그레이드 전에 남은 폴더도 덮는다.
- purge가 `kanban_goals`를 지운 Goal의 폴더는 소유에서 빠져 남는다. 대화를 지울 때 디스크의 브랜치와 worktree를 지우지 않는다는 결정(`docs/decisions.md:2628`)과 맞는다.

**새 서비스.** `CardWorkspaceJanitor`(`kanban/workspace-janitor.ts`)가 정리를 맡는다. git 명령은 기존 `CardWorktrees`를 통해서만 부른다. `CardWorkspace` 계약은 바꾸지 않는다.

**W1. Goal이 끝날 때 `settleGoal(goal)`.**

- 부르는 곳은 둘이다. kanban Goal은 이 두 곳에서만 `stopped`가 된다(`kanban/card-attempts.ts:278-280`의 `stopGoal`을 부르는 곳).
  - Plan 종료: `tick`이 닫힌 Plan을 보고 `halt`한 뒤(`kanban/orchestrator.ts:895-899`)
  - 새 Goal 전환: `tick`의 supersede 분기(`:885-893`)
- `stopSession`(`:1163-1167`)은 `settleGoal`을 부르지 않는다. 대화 삭제 경로이고, 디스크를 지우지 않는다는 결정(`docs/decisions.md:2628`)이 있다. 그래서 `settleGoal`은 `halt` 안이 아니라 `tick`의 두 분기에서 부른다.
- 순서:
  1. `Done`이 아닌 카드마다 `settle(card, Cancelled)`를 부른다. 스냅샷 커밋 뒤 폴더를 지우고 카드 브랜치를 남긴다(`kanban/git-worktrees.ts:422-424`).
  2. 그 카드가 lease 중이면(`InUse`) 건너뛴다. W2가 정리한다.
  3. `.goal` checkout이 남아 있으면 `git worktree remove`로 지운다. 보통은 scope가 닫힐 때 이미 지워진다(`kanban/git-worktrees.ts:796-806`).
  4. `<goalInstanceId>` 부모 폴더는 비었을 때만 비재귀로 지운다. 남은 자식이 있으면 두고, 다음 시작 sweep에 맡긴다.

**W2. delivery가 끝날 때.** `deliver`(`kanban/card-queue.ts:164-`)는 카드 lease를 `Effect.scoped` 안에서 쥔다(`:192-194`). scope가 닫힌 뒤 그 Goal이 더는 활성이 아니면, 결과와 상관없이 `settle(card, Cancelled)`를 부른다. 그래서 halt 때 진행 중이던 카드와 새 Goal 전환 뒤 끝난 카드가 정리된다.

**W3. `Done`인데 깨끗하지 않은 worktree.** 지금은 `WorktreeDirty`로 남는다(`kanban/git-worktrees.ts:425`). 바꾼 뒤에는 남은 변경을 스냅샷 커밋하고 브랜치를 남긴 뒤 폴더를 지운다. `Done` 카드 브랜치를 지우는 것은 변경이 없을 때만이다.

**W4. 시작 sweep.** janitor layer가 만들어질 때 돈다. 오케스트레이터 layer가 janitor에 의존하므로 recover(`kanban/orchestrator.ts:1090-1094`)보다 먼저 끝난다.

| 대상                                                                                                | 판정                         | `report`      | `delete`                  |
| --------------------------------------------------------------------------------------------------- | ---------------------------- | ------------- | ------------------------- |
| goalInstanceId가 이 DB에 없는 폴더                                                                  | 다른 인스턴스나 purge된 Goal | 건드리지 않음 | 건드리지 않음             |
| `stopped` Goal의 카드 폴더                                                                          | 고아                         | 기록          | W1의 1·2단계              |
| `stopped` Goal의 `.goal`·부모 폴더                                                                  | 고아                         | 기록          | W1의 3·4단계              |
| `active` Goal의 카드 폴더: 큐 item·attempt가 있거나 카드가 `in_progress`·`blocked`·`human_decision` | 쓰는 중                      | 건드리지 않음 | 건드리지 않음             |
| `active` Goal의 카드 폴더: 카드가 `done`이거나 Plan에 없음                                          | 고아                         | 기록          | W1의 1단계(`Done`이면 W3) |
| 폴더가 없는 `.git/worktrees` 항목(저장소별 `git worktree list --porcelain`)                         | 고아                         | 기록          | `git worktree prune`      |

- 동작은 코드 상수 `sweepMode`다. 첫 릴리즈는 `report`이고, 기록을 본 뒤 다음 릴리즈에서 `delete`로 바꾼다. 사용자 설정은 두지 않는다.
- `delete`도 폴더를 바로 지우지 않고 `settle`(스냅샷 커밋 뒤 제거)을 쓴다. 그래서 커밋하지 않은 작업은 카드 브랜치에 남는다.
- 기록은 sweep span의 숫자 속성(찾음, 고아, 정리함, 건너뜀)과 경고 로그(경로와 판정)다.

**W5. 브랜치.** `ctx/*` 브랜치는 지우지 않는다. 지금처럼 변경 없는 `Done` 카드 브랜치만 지운다(`kanban/git-worktrees.ts:437-447`).

### G. 관측 (G8)

- 측정은 span으로 한다. 새 metric 모듈은 만들지 않는다.
  - 읽는 곳이 이미 있다. `tools/profile`의 OTLP 수집기가 span을 받는다(`.claude/skills/effect-profile/SKILL.md`). metric은 그 수집기가 받아서 버린다(`tools/profile/otlp-collector.ts:58`).
  - 로컬 수집기는 문자열 속성을 버린다. 그래서 크기와 개수는 숫자 속성으로 달고, reason 같은 문자열은 경고 로그에 남긴다.
- 엔진: `resumeExecution`, `wakeExecution`, `armClock`, `interruptExecution`, `awaitComplete`에 `Effect.fn("OwnerWorkflowEngine.<이름>")` span을 둔다. 숫자 속성은 `executions`, `runs`, `clocks`(span 시작 때 크기)다.
- 칸반: `CardWorktrees.lease`(`kanban/git-worktrees.ts:379`), `CardWorkspaceJanitor.settleGoal`, `CardWorkspaceJanitor.sweep`에 span을 둔다.
- 저장: 실행 행의 `created_at`·`updated_at`(B, D2).

## Risks & Mitigations

| #   | 위험                                        | 종류   | 영향                                     | 완화                                                                                                                                                                                                            | 탐지                                 |
| --- | ------------------------------------------- | ------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | sweep이 사용자 작업이 든 폴더를 지운다      | 실패   | 커밋하지 않은 작업 손실                  | 첫 릴리즈는 `report`. `delete`도 스냅샷 커밋 뒤 제거. 이 DB의 Goal만 다룸. 쓰는 중인 카드는 건너뜀                                                                                                              | sweep span, 경고 로그                |
| 2   | 스냅샷 커밋에 비밀 파일이 들어간다          | 보안   | 로컬 카드 브랜치에 비밀이 커밋됨         | 지금 `Cancelled` 스냅샷과 같은 `commitIn`(`git add --all`, `.gitignore`를 따름)을 쓴다. 카드 브랜치는 자동으로 push하지 않는다. 남는 위험은 `.gitignore`에 없는 비밀 파일이고, 지금 `Cancelled` 경로와 같다     | 없음                                 |
| 3   | 시작 migration이 실패한다                   | 실패   | 앱이 시작하지 않음                       | 모든 단계가 startup transaction 하나다(`db/database.ts:65-79`). 실패하면 rollback되고 0.0.17 행은 그대로다. 값을 다시 쓰는 단계(D3 payload)는 decode되지 않는 행을 건너뛰고 실패하지 않는다                     | upgrade 테스트(G9)                   |
| 4   | 다운그레이드                                | 실패   | 0.0.17로 되돌리면 새 열·표를 모른다      | 지원하지 않는다. 바뀌는 값은 칸반 사람 결정 행뿐이고 사용자는 한 명이다. 그래서 DB 백업 장치는 두지 않는다                                                                                                      | 없음                                 |
| 5   | 시작 검사가 정상 세션을 고친다              | 실패   | 정상 세션이 멈춤                         | 고치는 규칙은 로컬 DB에서 확인한 두 모순(R1·R2)과 `Unknown`뿐이다. 낡은 phase는 지금 `reconcile`과 같게 phase만 고친다. 활성 칸반 세션은 고치지 않는다. 고칠 때는 새 revision을 남기므로 이전 revision이 남는다 | 경고 로그, ledger `state reconciled` |
| 6   | `human_decision_facts`가 쌓인다             | 확장성 | 행 증가                                  | 사실이 바뀔 때만 행을 더한다. 답했거나 닫힌 요청에는 더하지 않는다. purge 때 cascade로 지워진다                                                                                                                 | 없음                                 |
| 7   | `ctx/*` 브랜치가 쌓인다                     | 확장성 | 저장소 브랜치 목록 증가                  | 사용자 결정으로 자동 삭제하지 않는다. gc는 불편해질 때 만든다                                                                                                                                                   | 없음                                 |
| 8   | key lock을 빼면 세션 쓰기가 겹친다          | 실패   | 같은 세션의 상태가 덮어써짐              | 연결 하나와 transaction semaphore가 쓰기를 하나씩 돌린다(`db/sql-client.ts:14-19`). Step 6 테스트                                                                                                               | Step 6 테스트                        |
| 9   | 사실 비교와 답 기록 사이에 사실이 더해진다  | 실패   | 한 단계 오래된 사실로 한 답이 받아들여짐 | 사용자가 한 명이고 창이 짧다. 한 transaction으로 묶으면 엔진 resume과 교착한다                                                                                                                                  | 없음                                 |
| 10  | hook이 깨움을 놓친다                        | 실패   | 대기가 최대 5분 늦게 이어짐              | 구독을 먼저 한다. schedule이 안전망이다                                                                                                                                                                         | 엔진 span                            |
| 11  | 답을 저장한 뒤 카드 이동이 실패한 사람 결정 | 실패   | 카드가 `human_decision`에 남음           | 지금 동작과 같다. 사용자는 카드 Stop·Replace로 빠져나간다. 다시 시도 버튼은 실패가 실제로 보이면 더한다(D4)                                                                                                     | 경고 로그                            |
| 12  | `active` Goal의 남은 폴더                   | 확장성 | 오래 막힌 카드의 `node_modules`가 남음   | TTL은 미룬다(Non-Goals). sweep span의 폴더 수로 본다                                                                                                                                                            | sweep span                           |

## Alternatives Considered

### 개편 순서: `ClusterWorkflowEngine`으로 먼저 바꾸기

정상화 대신 공식 cluster 엔진으로 바로 바꾸는 안이다. 상태: 미룸(결정 11). 정상화 뒤 S3 spike에서 교체 여부를 정한다.

- 사용자가 겪는 문제 대부분은 엔진을 바꿔도 남는다. Goal 전환 막힘(`workflow/workflow.ts` 상태 기계), 칸반 worktree 정리, run 로그 20ms polling, 엔진 밖에 직접 만든 durable 표가 그렇다.
- 교체하는 동안에도 owner 엔진이 0.0.17의 진행 중 행을 끝까지 처리한다. `HumanDecision`에는 기한이 없다. 정상화 없이 바꾸면 그동안 owner 엔진의 누수와 poll 버그가 그대로 보인다.
- 지금 바꾸면 비용이 크다(`concepts_brief.md` 4장).
  - 진행 중 행을 cluster 내부 형식(Snowflake id, `shard_id`, 요청·reply 쌍)으로 손수 만들어야 한다.
  - 앱 코드 네 곳이 엔진 저장소를 조회 모델로 읽는데, cluster에는 workflow별 목록 API가 없다.
  - owner 펜스(같은 executionId에 다른 payload면 거절)가 사라진다.
  - 공유 SQLite 연결에 배경 부하(shard 300개 갱신, reply poll 200ms, message poll 10초)가 늘 생긴다.
  - 모듈이 `@stability unstable`이고, envelope 형식이 이미 한 번 바뀌었다.
- 엔진은 병목이 아니다. 로컬 DB의 durable 실행은 73건이다(사용자 한 명, 2026-10-29). 교체로 얻는 것은 아직 잰 적이 없다.
- 교체 때 버려지는 owner 전용 일은 B1·B2뿐이다. 이것도 교체 기간에 쓰인다. 상태 전이, 시나리오, 관측, worktree 정리는 교체 뒤에도 쓰고, 교체를 검증하는 도구가 된다.

### Goal 상태 전이 모양 (D1에서 뺀 안)

- **이름 붙은 상태와 손으로 쓴 전이 표.** 순수 함수 `classify`가 저장 값을 이름 붙은 상태 중 하나로 바꾸고, "상태 × 사건" 표를 object literal로 둔다. 상태: 뺌.
  - 뺀 이유: 저장 값의 조합이 늘 때 `classify`와 표를 함께 고쳐야 하고, 빠뜨려도 컴파일러가 알려 주지 않는다.
- **phase를 계산 값으로 바꾸기.** 진행 위치는 Goal·Plan·검증으로 계산하고, 화면 위치만 저장한다. 상태: 뺌.
  - 뺀 이유: phase를 읽는 곳(`workflow/actions.ts`, 화면, 도구, `reconciledWorkflowPhase`)의 의미가 모두 바뀐다. 결정 5(저장된 상태를 고친다)와 방향이 다르다. 고른 안은 phase를 저장 값으로 두고, decode에서 `view`로 나눠 읽는다.
- **세션 실행 상태와 새 Goal 요청까지 한 `GoalState`에 넣기.** 상태: 뺌.
  - 뺀 이유: 세 저장소와 두 서비스에 걸친다. 한 전이를 어느 transaction에서 쓰는지가 복잡해지고, `Workflows`가 `WorkflowExecution`에 의존해야 한다. 세션 실행 상태는 이미 tag union이다.
- **ts-pattern 의존성 추가.** 상태: 뺌. `.exhaustive()`와 같은 보장을 Effect `Match.valueTags`·`Match.exhaustive`가 준다. 이 저장소는 이미 `Match.exhaustive`를 쓴다(`workflow/workflow.ts:455-461`).
- **`Match.orElse`나 기본 분기로 쌍을 줄이기.** 상태: 뺌. 기본 분기가 있으면 새 tag를 더해도 컴파일러가 빠진 쌍을 알려 주지 않는다. 묶을 때는 `Match.tags`·`Match.whenOr`에 tag를 모두 이름으로 적는다.

### 결정적 엔진 실패를 저장하는 방법 (D2에서 뺀 안)

- **status에 `failed`를 더하고 표를 다시 만들기 (D2 원안, 2026-10-29 사용자 결정).** 상태: 뺌(같은 날 리뷰 반영).
  - 뺀 이유: 대상이 결과 encode 실패 하나로 좁다(B3). 그런데 표 재생성, 참조되는 표 재생성 규칙(`db/migrations.ts:1955-1970`)의 일반화, `failed`를 읽는 소비자 수정을 부른다. 소비자는 승인 응답(`approvals/relayed.ts:184`), 사람 결정 목록(`kanban/human-decision.ts:417-421`), 카드 attempt 복구(`kanban/orchestrator.ts:1069-1088`)다.
  - 실패가 실제로 생기면 다시 본다. 그때도 결함 결과 저장이 라이브러리 방식과 같아 바꿀 곳이 적다.
- **실패 열 더하기.** `failure_json`과 `failed_at`을 더하고 status는 `running`으로 둔다. 상태: 뺌. "실패"가 두 열의 조합이 되고, status만 보는 코드는 실패한 실행을 resume한다.
- **실패 표 따로 두기.** `owner_workflow_failures`를 만든다. 상태: 뺌. 실행 상태를 알려면 두 표를 join해야 하고, join을 빠뜨린 코드는 실패를 보지 못한다.

### 같은 질문의 사람 결정 요청 (D3에서 뺀 안)

- **`createdAt`만 빼기.** 상태: 뺌. 사실이 바뀐 재요청(`FileOverlap`의 `files`, `ProtectedBranchMerge`의 `prAvailable`)은 여전히 payload가 다르다.
- **먼저 온 요청이 이기기.** admission이 payload가 달라도 기존 실행을 돌려준다. 상태: 뺌. 뒤 요청의 바뀐 사실을 조용히 버리고, owner 펜스에 예외가 생긴다.
- **앱 서비스가 먼저 확인하고, 같은 key 요청을 Fiber 하나로 합치기.** 상태: 뺌. owner 프로세스가 하나이므로 동시 요청은 이것으로도 막힌다. 그러나 순서대로 온 재요청의 바뀐 사실은 여전히 버려진다.
- **kind 전체로 key 만들기.** 상태: 뺌. 사실이 바뀔 때마다 새 key가 생겨 같은 occasion의 질문이 늘고, 0.0.17 행의 executionId도 바뀐다.
- **충돌하면 사용자에게 묻는 새 질문 열기.** 상태: 뺌. 그 질문의 key와 충돌 규칙이 다시 필요하고, 카드 하나에 대기가 둘 생긴다. 동시 요청의 충돌은 엔진 admission의 결함이라(오류 채널 `never`) 그 자리에서 질문으로 바꿀 수 없다.
- **session lease로 막기.** 상태: 뺌. 경쟁하는 요청은 lease를 쥐지 않는 서버 안의 orchestrator(`kanban/orchestrator.ts:226`)와 merge queue(`kanban/merge-queue.ts:81`)에서 온다.
- **payload에 occasion을 그대로 저장하기 (D3 원안).** 상태: 뺌(리뷰 반영). key와 같은 정보이고, 0.0.17 행을 바꿀 때 key 문자열을 occasion으로 decode해야 한다. decode가 실패하면 앱이 시작하지 않는다.
- **이전 사실을 펼쳐 보는 화면 (D3 원안).** 상태: 미룸. 사실 행은 쌓아 두므로 필요할 때 화면만 더한다.

### 실패한 실행의 다시 시도 (D4)

**(결정 2026-10-29, 리뷰 반영으로 미룸) D4. 결함으로 끝난 실행의 다시 시도 경로는 이 단계에서 만들지 않는다.**

- run이 기다리는 실행(`RelayedApproval`, `ProviderRetryWait`, `GoalExecution`)은 지금처럼 run과 함께 끝난다. run은 `execute`의 `Fiber.join`으로 실행을 기다리므로(`workflow/owner-workflow-engine.ts:368-374`) run도 결함으로 끝나고, no-replay 규칙상 다시 돌지 않는다. 사용자는 메시지를 다시 보낸다.
- 사람 결정은 답을 저장한 뒤 카드 이동이 실패하면 카드가 `human_decision`에 남는다(`kanban/human-decision.ts:598-602`). 사용자는 카드 Stop·Replace로 빠져나간다.
- 원안(사람 결정 다시 시도 버튼, `failed` → `running` 되돌리기)은 D2 원안의 `failed` 상태에 기대므로 함께 미룬다.
- 뺀 안
  - 실행 단위 공통 retry: 끝난 run의 승인 대기를 다시 돌리면 아무도 답하지 않는 대기가 생긴다.
  - 다시 시도 없이 카드를 `blocked`로 보내기: 같은 occasion은 같은 executionId라서, attempt 번호가 key에 없는 질문은 다시 물을 수 없다.

### 실패 처리

- **죽은 실행을 연속 실패 횟수로 판단하기.** 상태: 뺌. 횟수로는 원인이 provider 지연인지 앱 결함인지 구분할 수 없다. 원인마다 처리를 정한다(B3).
- **모든 실패를 owner 엔진의 typed error로 올리기.** 상태: 뺌. 엔진 interface의 오류 채널이 `never`다(`effect:workflow/WorkflowEngine.ts:394-428`).
- **live fiber가 없는 Suspended 실행은 replay 없이 바로 돌려주기.** 상태: 뺌. 놓친 깨움을 되살리는 안전망(`workflow/owner-workflow-engine.ts:221-226`)이 사라지고, 교체 때 버려지는 owner 전용 코드가 는다.

### 새 Goal 요청 거절 기록

- **거절을 ledger에 쓰기 (초판 안).** 상태: 뺌. revision이 바뀌어 `accepted` 요청이 `workflow_changed`로 거절된다(A).
- **revision을 만들지 않는 별도 표에 쓰기.** 상태: 뺌. 화면과 도구 결과에 reason이 이미 보이고, 경고 로그가 남는다. 다시 읽을 곳이 없다.

### run 로그

- **`Latch`로 깨우기.** 상태: 뺌. reader가 여러 run을 기다리므로 run id를 실어야 한다. `PubSub`는 구독마다 값을 받는다.
- **`AppEvents`로 깨우기.** 상태: 뺌. D 참고.

### 잠금

- **`Workflows.locked`의 key lock을 두고 DB 읽기만 밖으로 빼기.** 상태: 뺌. 연결 하나와 semaphore 때문에 key lock이 막아 주는 경쟁이 없고, transaction 안에서 `Workflows`를 부르면 교착할 수 있다(결정 6).

### 카드 작업 공간

- **AgentFS(Turso) overlay.** 상태: 뺌(2026-10-29, 공식 문서 확인).
  - lower를 무엇으로 두든 COW 복제(B)보다 낫지 않다. 카드 worktree를 lower로 두면 `node_modules`가 없다. base checkout을 lower로 두면 사용자의 미커밋 변경이 보이고, 카드 커밋이 overlay 안에 쌓인다.
  - BETA이고, Windows mount는 문서에 없으며, 별도 CLI 설치가 필요하다.
- **준비 방식(A′ pool, B COW 복제)을 이 단계에 넣기.** 상태: 미룸(S4, `concepts_brief.md` 9.6).
  - 앱에서 측정된 디스크 비용은 없다. 앱 worktree root에 남은 용량은 12K였다(`concepts_brief.md:179`, `:298`). 사용자 보고는 정리 실패와 준비 마찰이다. 이 단계는 정리만 고친다.
  - B는 비밀 파일 복제, 중첩 worktree 복제, 의존성 신선도라는 새 위험을 진다.
- **`card_worktrees` 표와 owner 표식 파일 (초판 안).** 상태: 뺌(리뷰 반영). `kanban_goals`와 경로 규칙으로 소유를 판정할 수 있다. 표와 표식은 업그레이드 전 폴더를 덮지 못한다.
- **살아 있는 Goal의 14일 TTL (결정 10).** 상태: 미룸(리뷰 반영). Non-Goals 참고.
- **sweep 동작을 사용자 설정 `report | delete`로 두기 (초판 안).** 상태: 뺌. 한 릴리즈 동안만 쓰는 값이라 코드 상수로 둔다.
- **취소 카드의 스냅샷 브랜치나 `ctx/*` 브랜치를 자동으로 지우기.** 상태: 뺌(사용자 결정). 지우면 이어서 할 작업을 잃는다.
- **시작 sweep이 첫 릴리즈부터 지우기.** 상태: 뺌. worktree base를 개발판과 설치판이 함께 쓴다. 분류가 틀리면 사용자 작업을 지운다.
- **폴더를 직접 지우기.** 상태: 뺌. `.git/worktrees` 항목이 남는다.
- **`resolved` 재검증 때 브랜치에서 worktree를 다시 만들기 (초판 안).** 상태: 뺌. TTL이 없으면 살아 있는 Goal의 폴더가 없어지는 경로가 없다. `presentWorktree`(`kanban/git-worktrees.ts:346`)는 네 경로가 함께 쓰므로 바꾸면 동작이 전역으로 바뀐다.

### 관측

- **metric 모듈(gauge·histogram·counter) 두기 (초판 안).** 상태: 뺌. 읽는 곳이 없다. 기존 OTLP 수집기는 metric을 버린다. 크기와 개수는 span 숫자 속성으로 잰다.
- **대기→재개 지연 histogram.** 상태: 뺌. B1 뒤에는 깨움이 schedule을 기다리지 않는다. Step 4의 TestClock 테스트로 확인한다.

### 검증 방법

- **Suspended→Complete를 1,000번 반복하는 누수 테스트.** 상태: 뺌(사용자 판단). G1은 모든 Goal 전이가 정의되어 있는지를 탐색 테스트로 보고, G3은 실행 하나가 끝난 뒤 Map이 비는지를 단일 주기 테스트와 span으로 본다.

## Detailed Implementation

일은 10단계로 나눈다. 단계마다 커밋하고, 각 커밋은 빌드와 테스트를 통과해야 한다. README 갱신은 그 내용을 바꾸는 단계에서 함께 한다.

테스트는 타입으로 확인할 수 없는 동작만 더한다. 빠진 (상태, 사건) 쌍, 빠진 occasion, 빠진 reason 문구와 HTTP 상태는 컴파일 오류가 잡으므로 테스트를 두지 않는다.

### Step 1. span을 넣고 지금 값을 잰다 (G8)

동작은 바꾸지 않는다.

- **`memory-agent/src/workflow/owner-workflow-engine.ts`**
  - `resumeExecution`, `wakeExecution`, `interruptExecution`을 `Effect.fnUntraced`에서 `Effect.fn("OwnerWorkflowEngine.<이름>")`으로 바꾼다. `armClock`(`:289`)은 일반 함수이므로 `Effect.fn`으로 감싼다.
  - 각 span에 숫자 속성 `executions`(Map 크기), `runs`, `clocks`(FiberMap 크기)를 단다.
- **`memory-agent/src/kanban/git-worktrees.ts`**: `lease`(`:379`)에 span `CardWorktrees.lease`를 단다.
- **측정.** 개발 앱을 OTLP 수집기로 띄우고(`.claude/skills/effect-profile/SKILL.md`의 1절), 승인 대기 하나를 10분 둔다. 그 실행의 `OwnerWorkflowEngine.resumeExecution` span 수와 `executions` 값의 변화를 센다. 결과를 `docs/decisions.md`에 기준선으로 남긴다.

### Step 2. 0.0.17 업그레이드 fixture (G9)

- **fixture 만들기 (한 번, 커밋하지 않는 스크립트).**
  - scratch 폴더에 `git worktree add --detach <scratch> 0.0.17`로 태그를 꺼낸다. `vp install`, `packages/turbovec`의 `node build-turbovec.ts`, `packages/memory-agent`의 `vp run build`를 돈다.
  - 그 checkout의 테스트 하나가 `testAgent()`를 열고, 0.0.17의 서비스로 다음을 만든다.
    - 대기 중인 relayed 승인(`RelayedApprovals.ask`)
    - 발화 전 provider 재시도 clock(`ProviderRetries.wait`, retry 10이라 약 17분 뒤)
    - `running` 상태로 끊긴 chat run과, 그 run의 `accepted` 새 Goal 요청
    - `interrupted`인 chat run과, 그 run의 `accepted` 새 Goal 요청
    - R1·R2 세션: Execute에서 모든 단계를 끝낸 뒤 `updateProgress`로 Plan(R1은 Goal도)을 `completed`로 바꾼다. 로컬 DB의 세션이 생긴 것과 같은 버그 경로다.
  - chat run 행은 0.0.17의 테스트처럼 SQL로 넣는다.
  - `VACUUM INTO`로 연 DB를 복사하고 `sqlite3 <copy> .dump`로 텍스트를 만든다. 리뷰할 수 있게 바이너리 DB 대신 텍스트로 둔다. `.dump`는 `PRAGMA user_version`을 빼므로 끝에 더한다. 만든 방법은 dump 머리 주석에 적는다.
- **새 `memory-agent/tests/fixtures/release-0.0.17.sql`**: 위 dump다.
- **`memory-agent/tests/support/test-env.ts`**: `TestEnvOptions`에 `beforeOpen(storage)`를 더한다. 첫 agent를 열기 전에 storage root에 옛 DB를 넣기 위해서다.
- **새 `memory-agent/tests/upgrade-0.0.17.test.ts`**
  - `beforeOpen`에서 dump를 defensive를 끈 연결로 넣고, 새 연결에서 `migrateDatabase`를 잰다. FTS5 표는 `writable_schema`로 되살아나 새 연결에서만 보인다.
  - 업그레이드가 fixture를 만든 직후라고 보고, 승인 timeout clock은 그때와의 거리를 유지하고 provider 재시도 clock은 지금으로 옮긴다. 그래야 재시작한 agent가 재시도 clock을 발화하는 것을 볼 수 있다.
  - 그다음 `testAgent`가 `memoryAgentLayer`를 연다. 그래야 `ChatState`의 재시작 처리, 시작 검사, 엔진 등록이 모두 돈다.
  - 확인할 것과 통과하는 단계(`it.effect.fails`로 두었다가 그 단계에서 `it.effect`로 바꾼다)
    - 대기 승인이 남아 답할 수 있고, provider 재시도 clock이 발화한다: Step 2부터 통과
    - 두 chat run이 `failed`, `error_code = server_restarted`다: Step 2부터 통과
    - 실행 행에 `created_at` 열이 있고 0.0.17 행은 NULL이다: Step 3
    - 두 `accepted` 요청이 `rejected{run_outcome_uncertain}`이다: Step 7
    - R1 세션은 `Completed`, R2 세션은 `Running{view: verify}`이고 둘 다 `stopped{state_reconciled}`이다: Step 7
    - migration 시간이 2초 안이다. 시간은 테스트 로그에 남긴다: Step 2부터 통과

### Step 3. 실행 행의 시각 열 (D2)

- **`memory-agent/src/db/migrations.ts`**: 새 migration 하나가 `owner_workflow_executions`에 `created_at INTEGER`, `updated_at INTEGER`를 `ADD COLUMN`으로 더한다.
- **`memory-agent/src/db/database.ts`**: `assertDatabaseSchema`(`:184-200`)가 새 열을 읽는다. 계약이 깨진 DB를 시작 전에 잡기 위해서다.
- **`memory-agent/src/db/README.md`**: `assertDatabaseSchema` 열 목록(`:34`)에 두 열을 더한다.
- **`memory-agent/src/workflow/owner-workflow-storage.ts`**
  - `StoredExecution`에 `createdAt: number | undefined`, `updatedAt: number | undefined`를 더한다. 옆의 `parentExecutionId`처럼 NULL은 `undefined`로 읽는다.
  - admit은 `created_at`과 `updated_at`을 쓰고, 상태 쓰기(`setRunning`, `setInterrupted`, `setResult`)는 `updated_at`을 쓴다. 시각은 `Clock`에서 읽어 TestClock으로 시험할 수 있다.
- **`memory-agent/src/workflow/README.md`**: SQLite 쓰기 목록(`:58`)에 두 열을 적는다.
- **`memory-agent/tests/owner-workflow-engine.test.ts`**: 대기했다가 끝난 실행의 `created_at`이 admission 시각으로 남고 `updated_at`이 완료 시각이 되는지 TestClock으로 본다.
- **`memory-agent/tests/upgrade-0.0.17.test.ts`**: 시각 열 확인을 `it.effect.fails`에서 `it.effect`로 바꾼다.

### Step 4. owner 엔진 (B1–B3)

- **`memory-agent/src/workflow/owner-workflow-engine.ts`**
  - B1
    - 엔진 안에 executionId를 싣는 `PubSub`를 둔다. 결과가 Complete로 저장될 때와 interrupt될 때 발행한다.
    - `makeUnsafe`에 `awaitComplete`를 넘긴다. hook은 구독 → status 읽기 → `completed`·`interrupted`면 끝 → 아니면 자기 id를 기다림 순서다.
  - B2
    - `executions`를 `new Map`(`:151`)에서 `SynchronizedRef<HashMap<string, LiveExecution>>`로 바꾼다. 상태를 바꾸는 변수 대신 `Ref` 계열을 쓰는 규칙(`docs/decisions.md:2921`)을 따른다. 새 항목을 넣는 일과 interrupt 표시를 옮기는 일은 `SynchronizedRef.modify` 하나에서 한다.
    - `liveExecution`(`:196`)의 scope 생성을 지운다.
    - `resumeExecution`(`:230`)은 실행의 scope를 처음 한 번만 만들고, 그다음부터 재사용한다.
    - 결과가 Complete일 때와 interrupt 때 scope를 닫고 Map에서 지운다.
    - 부모 wake(`:251-261`)는 저장소에서 부모의 workflow 이름을 읽어 등록된 workflow로 resume한다.
  - B3
    - `setResult`에 넘길 값의 encode(`encodeResult`, `:120-126`)가 throw하면, `Complete{exit: die(OwnerWorkflowEngineError{operation: "execution.result", reason: "result_unencodable"})}`를 다시 encode해 저장한다. 이 저장도 실패하면 지금처럼 결함으로 끝나고 `running`으로 남는다.
    - SQL 오류는 지금처럼 `defect`(`:138-145`)가 결함으로 끝낸다.
    - `OwnerWorkflowEngineError`의 reason literal에 `result_unencodable`을 더한다.
- **`memory-agent/src/approvals/relayed.ts`**, **`memory-agent/src/workflow/provider-retry.ts`**, **`memory-agent/src/workflow/goal-execution.ts`**: 각 `Workflow.make`(`:41`, `:78`, `:41`)에 `suspendedRetrySchedule`을 둔다. 1초에서 2배씩, 상한 5분이고 끝나지 않는 schedule이다. 세 곳이 같은 값을 쓰도록 `workflow/owner-workflow-engine.ts`에서 내보낸다.
- **`memory-agent/tests/owner-workflow-engine.test.ts`**에 더할 것
  - deferred가 끝나면 TestClock을 진행하지 않아도 호출자가 깨어난다.
  - 대기 중 TestClock을 10분 진행했을 때 workflow 본문 실행 횟수가 schedule이 정한 수(1, 2, 4 … 초, 그 뒤 5분 간격)와 같다.
  - 실행 하나가 Complete된 뒤 Map 크기가 시작값으로 돌아온다.
  - 부모가 Map에 없을 때(재시작 직후)도 child 완료가 부모를 깨운다.
  - 결과 encode가 실패하면 실행이 결함 결과의 `completed`가 되고, 다시 시작해도 resume되지 않는다.

### Step 5. run 로그 reader (D)

- **`memory-agent/src/workflow/durable-stream.ts`**
  - 새 서비스 `RunLogSignals`가 run id를 싣는 `PubSub`를 가진다. `RunLogSignals.layer`를 둔다.
  - `sqliteRunLog`가 `RunLogSignals`를 읽는다. `append`와 `close`는 transaction이 commit된 뒤 발행한다.
  - reader는 끝에 닿으면 구독한 뒤 한 번 더 읽는다. 그래도 비어 있으면 자기 run id가 오거나 1초가 지날 때까지 기다린다.
  - 20ms 상수(`:18`)와 sleep(`:181`)을 지운다.
- **`memory-agent/src/agent/chat.ts`**: `AgentChat`의 `make`가 `RunLogSignals`를 읽고, `committedLog`(`:497`)가 SqlClient와 함께 제공한다.
- **`memory-agent/src/layers.ts`**: `stores`(`:275-305`)에 `RunLogSignals.layer`를 더한다.
- **`memory-agent/src/workflow/durable-stream.test.ts`**: 테스트 context(`:32-34`)에 `RunLogSignals.layer`를 더한다. 더할 테스트
  - 쓰기가 없는 동안 reader의 SQL이 1초에 1번 이하다. TestClock으로 잰다.
  - 읽기와 구독 사이에 들어온 append도 놓치지 않는다.
- **`memory-agent/src/workflow/README.md`**: 20 millis polling 설명(`:62`)을 바꾸고, SQLite 쓰기 목록(`:58`)에 `RunLogSignals`를 적는다.

### Step 6. `Workflows.locked`의 key lock 제거 (E)

- **`memory-agent/src/workflow/workflow.ts`**: `locked`(`:473-474`)에서 `serialize`를 지운다. `keyedSerialLimit` import(`:16`)와 `serialize`(`:470`)도 지운다.
- **`memory-agent/tests/workflow/state.test.ts`**: `sql.withTransaction` 안에서 `Workflows` 메서드를 불러도 끝나는지 본다. 교착은 타입으로 보이지 않는다.

### Step 7. Goal 상태 전이와 시작 검사 (A, D1)

- **새 `memory-agent/src/workflow/goal-transitions.ts`**
  - `GoalState`(A의 tag 표), `GoalEvent`(A의 사건 표), `GoalStateConflict`(`GoalCompletedPhaseOpen`, `PlanCompletedGoalOpen`, `Unknown`)를 `Schema.TaggedUnion`으로 둔다.
  - `decodeGoalState(state, kanbanActive)`는 `GoalState`, 낡은 phase, `GoalStateConflict` 중 하나를 돌려준다. `encodeGoalState`는 `GoalState`를 phase·Goal·Plan으로 되돌린다.
  - `repair(conflict)`는 A의 규칙대로 고친 `GoalState`를 돌려준다. 모든 case를 `Match.valueTags`로 다룬다.
  - `transition(state, event)`는 `Moved{next, display}`나 `Refused{reason}`를 돌려준다. 구현은 `Match.valueTags(state, …)` 안에서 `Match.valueTags(event, …)`를 쓴다. 같은 결과는 `Match.tags`·`Match.whenOr`로 묶되 tag를 모두 적는다. `Match.orElse`는 쓰지 않는다.
  - `reason`은 기존 `WorkflowActionReason`(`workflow/actions.ts:6-15`), `NewGoalTransitionRefused` reason(`workflow/workflow.ts:246-255`), 진행 기록 거절 reason에 `goal_completion_required`와 `state_reconciled`를 더한 literal union이다.
  - `display`는 화면이 실제로 보이는 경우만 literal union으로 둔다: `card_reclassifying`, `state_reconciled`.
- **`memory-agent/src/workflow/workflow.ts`**
  - 메서드 14개를 하나씩 decode → `transition` → encode·저장으로 바꾼다. 옮길 때마다 기존 테스트가 통과해야 한다.
  - `reconcile`(`:716-737`)은 `decodeGoalState`와 `repair`를 쓴다.
  - 새 메서드 `checkAll()`은 모든 세션을 decode하고, 고칠 세션의 새 revision과 ledger를 쓴다. 고친 세션 id 목록을 돌려준다.
  - 새 메서드 `settleAbandonedNewGoalRequests()`는 모든 `accepted` 요청을 A의 재시작 규칙으로 정산한다.
  - `NewGoalSettlement.rejected.reason`(`:263`)을 `NewGoalTransitionRefused` reason literal이나 null로 decode한다.
  - `requestNewGoal`의 거절을 경고 로그에 남긴다.
- **`memory-agent/src/workflow/execution.ts`**: `stopped.reason`(`:67`)에 `state_reconciled`를 더한다. 새 메서드 `stopReconciled(sessionId)`는 세션 실행 상태를 `stopped{state_reconciled}`로 쓴다.
- **새 `memory-agent/src/workflow/workflow-startup.ts`**: marker 서비스 `WorkflowStartup`과 그 layer다.
  - layer는 `Workflows.layer`와 `WorkflowExecution.layer`를 쓴다.
  - 하는 일: `checkAll` → 고친 세션마다 `stopReconciled` → Goal 상태가 `Running`이 아닌데 세션 실행 상태가 `ready`·`retrying`인 세션을 `stopReconciled` → `settleAbandonedNewGoalRequests`.
  - 고친 세션 수와 정산한 요청 수를 span `WorkflowStartup.check`의 숫자 속성으로 단다.
- **`memory-agent/src/workflow/owner-workflow-engine.ts`**: 엔진 `make`가 `WorkflowStartup`을 읽는다. `ownerWorkflowEngineLayer`(`:505-507`)와 `layer`(`:510-511`)가 `WorkflowStartup.layer`를 제공한다. 그래서 어느 workflow 등록도 시작 검사 전에 resume하지 않는다.
- **`memory-agent/src/workflow/actions.ts`**: `evaluateWorkflowAction`은 lease와 run 진행 검사(`:61-66`)만 하고, 상태 판단은 `transition`을 부른다.
- **`memory-agent/src/agent/chat.ts`**: 세션 workflow 응답에 `display`를 더한다.
- **`apps/agent/app/entry/api.ts`**: workflow 응답 타입에 `display`와 `stopped.reason`의 `state_reconciled`를 더한다.
- **`apps/agent/app/entry/chat/workflow-panel.tsx`**: `display`를 `Record<Display, string>` 문구로 보인다. `card_reclassifying`은 "카드를 다시 분류하는 중이에요", `state_reconciled`는 "앱이 상태를 고쳤어요. 이어서 하려면 메시지를 보내 주세요"다. 도구 결과의 새 Goal 거절 reason도 문구로 보인다.
- **`apps/agent/app/entry/session/run-notice.ts`**, **`apps/agent/app/entry/session/run-state.tsx`**: `stopped{state_reconciled}`에 같은 문구를 보인다.
- **새 `memory-agent/src/workflow/goal-transitions.test.ts`**
  - 처음 상태에서 너비 우선으로 도달 상태를 모은다. Plan 단계는 0·1·2개, 버전 차이는 같음·작음으로 줄인다.
  - 확인할 것: 막다른 상태가 없다. encode→decode가 같은 값으로 돌아온다. 생성한 목록이 `docs/goal-transitions.md`와 같다.
  - R1·R2·`Unknown`의 decode와 `repair` 결과.
- **새 `docs/goal-transitions.md`**: 위 테스트가 만든 도달 상태와 전이 목록이다. 사람이 리뷰한다.
- **`memory-agent/tests/workflow/goal-transition.test.ts`**: G1의 세 경로를 끝까지 확인한다. 기존 테스트에 더한다.
  - 도구 호출 때 `transition_pending`으로 거절된 새 Goal 요청이 도구 결과에 reason을 남기고, 이미 `accepted`인 요청은 정산 때 그대로 적용된다.
  - 재시작 전 `accepted` 요청은 시작 검사 뒤 `rejected{run_outcome_uncertain}`이고, 그 세션의 다음 새 Goal 요청이 받아들여진다.
  - 칸반 Goal을 고치면 phase가 유지되고 응답의 `display`가 `card_reclassifying`이다.
- **`memory-agent/src/workflow/README.md`**: 상태 전이 위치와 시작 검사를 적는다.

### Step 8. 사람 결정 요청 (C, D3)

- **`memory-agent/src/kanban/human-decision.ts`**
  - 새 `DecisionOccasion` union과 `occasionKey(occasion)`를 둔다. 형식은 C의 key 표다.
  - 요청 입력(`DecisionRequestInput`, `:181-189`)을 tag별로 occasion과 사실을 함께 받는 union으로 바꾼다. `key` 필드는 지운다.
  - payload(`:227-234`)를 `{sessionId, goalInstanceId, cardId, key}`로 바꾼다. 옛 payload schema는 migration 단계가 쓰도록 이름을 바꿔 남긴다.
  - 새 요청은 `OwnerWorkflowAdmission.admit(request, 첫 사실 쓰기)`로 쓴다. 이미 있으면 `appendFacts`를 부른다(C의 순서).
  - `view`(`:383-392`)는 최신 사실, `factsSeq`, `factsChanged`를 내놓는다. `createdAt`은 실행 행의 `createdAt`에서 읽는다.
  - `answer`(`:575-630`)는 `factsSeq`를 받고, 최신이 아니면 `facts_changed`로 거절한다. `answerFits`(`:296-305`)는 최신 사실로 검사한다.
  - `HumanDecisionRefused`의 reason literal(`:216-224`)에 `facts_changed`를 더한다.
  - 주석 "its payload wins"(`:566`)를 지운다. 같은 occasion은 같은 payload이므로 더는 맞지 않는다.
- **새 `memory-agent/src/kanban/human-decision-migration.ts`**: C의 0.0.17 행 변환 단계다.
- **`memory-agent/src/db/migrations.ts`**: `human_decision_facts` 표를 만드는 migration을 둔다.
- **`memory-agent/src/db/database.ts`**: 위 migration 뒤에 변환 단계를 돌린다(`tanStackRowsMigration`과 같은 방식, `:147-152`).
- **`memory-agent/src/kanban/orchestrator.ts`**: `askPerson`(`:226`)과 호출 네 곳(`:348`, `:416`, `:614`, `:862`)이 key 문자열 대신 occasion을 넘긴다.
- **`memory-agent/src/kanban/merge-queue.ts`**: `askGoal`(`:81`)과 호출 두 곳(`:261`, `:309`)도 같다.
- **`memory-agent/src/kanban/board-actions.ts`**: NeedsDecision 요청(`:689-693`)도 같다.
- **`apps/agent/app/.server/kanban-failures.ts`**: `humanDecisionStatus`(`:56`)에 `facts_changed: 409`를 더한다. Record라서 빠지면 컴파일 오류다.
- **`apps/agent/app/routes/api/sessions.$session.decisions.$decision.tsx`**: 답 본문의 `factsSeq`(필수 정수)를 받아 넘긴다.
- **`apps/agent/app/routes/api/sessions.$session.decisions._index.tsx`**, **`apps/agent/app/routes/api/projects.$project.decisions.tsx`**: 목록 응답에 `factsSeq`, `factsChanged`를 더한다.
- **`apps/agent/app/entry/api.ts`**: 결정 요청 타입에 `factsSeq`, `factsChanged`를 더하고, 답 호출에 `factsSeq`를 더한다.
- **`apps/agent/app/entry/queries/mutations/session.ts`**: 답에 `factsSeq`를 보내고, 409 `facts_changed`를 받으면 결정 목록을 다시 읽는다.
- **`apps/agent/app/entry/chat/decision-prompt.tsx`**: 최신 사실과 "물은 뒤 바뀜" 표시를 보인다.
- **`memory-agent/src/kanban/human-decision.test.ts`**에 더할 것
  - 같은 occasion을 동시에 요청하면 실행이 하나이고 결함이 없다.
  - 사실이 바뀐 재요청은 같은 요청에 `seq` = 2를 남긴다. 같은 사실이면 행이 늘지 않는다.
  - 답한 요청에 사실이 바뀐 재요청이 와도 행이 늘지 않는다.
  - 오래된 `factsSeq`로 한 답은 `facts_changed`로 거절된다.
- **새 `memory-agent/tests/human-decision-migration.test.ts`**
  - 옛 형식의 대기, 답함, 닫힘 행과 decode되지 않는 행 하나를 넣는다.
  - migration 뒤 확인할 것: executionId가 같다. payload가 새 형식이다. 사실 첫 행과 `created_at`이 채워진다. decode되지 않는 행은 그대로다. 같은 occasion의 새 요청이 admission에서 충돌하지 않는다.
  - 칸반 행은 0.0.17 fixture에 넣지 않으므로 이 테스트가 유일한 확인이다.
- **`memory-agent/src/kanban/README.md`**: `HumanDecisions`(`:31`)에 occasion과 사실 표를 적는다.

### Step 9. 카드 worktree 정리 (F)

- **`memory-agent/src/kanban/worktree.ts`**: `CardWorktrees` 계약(`:147-157` 주변)에 메서드 셋을 더한다.
  - `registered(repository)`: 저장소의 `git worktree list --porcelain` 결과
  - `removeGoalCheckout(goal)`: `.goal` checkout을 `git worktree remove`로 지움
  - `prune(repository)`: `git worktree prune`
  - 실패는 기존 `CardWorktreeFailed`이고, `operation` literal에 `list`, `remove_goal_checkout`, `prune`을 더한다.
- **`memory-agent/src/kanban/git-worktrees.ts`**
  - 위 메서드를 구현한다. `registered`는 이미 있는 private 파서(`:222`)를 쓴다.
  - W3: `Done`인데 깨끗하지 않으면(`:425`) 스냅샷 커밋 뒤 브랜치를 남기고 폴더를 지운다.
- **새 `memory-agent/src/kanban/workspace-janitor.ts`**: `CardWorkspaceJanitor` 서비스다.
  - `settleGoal(goal)`: W1의 순서.
  - `sweep()`: W4의 판정 표. layer를 만들 때 한 번 돈다. 동작은 상수 `sweepMode = "report"`다.
  - 부모 폴더 삭제는 `FileSystem.remove`를 `recursive` 없이 부른다. 비어 있지 않으면 실패를 무시한다.
- **`memory-agent/src/kanban/orchestrator.ts`**: `tick`의 닫힌 Plan 분기(`:895-899`)와 supersede 분기(`:885-893`)에서 `settleGoal`을 부른다. `stopSession`(`:1163-1167`)은 바꾸지 않는다.
- **`memory-agent/src/kanban/card-queue.ts`**: W2. `deliver`(`:164-`)의 scoped lease가 닫힌 뒤 Goal이 활성이 아니면 `settle(card, Cancelled)`를 부른다.
- **`memory-agent/src/layers.ts`**: `kanbanRuntime`(`:370-389`)에서 `KanbanOrchestrator.layer()` 아래에 `CardWorkspaceJanitor.layer`를 `provideMerge`로 둔다.
- **`memory-agent/src/testing/kanban.ts`**: `kanbanOwnerBase`·`kanbanBoardOwner`(`:98-153`)에 janitor layer를 더한다.
- **새 `memory-agent/src/kanban/workspace-janitor.test.ts`**
  - halt 뒤 `Blocked` 카드 worktree가 카드 브랜치만 남기고, 부모 폴더가 지워진다.
  - halt 때 lease 중이던 카드는 delivery가 끝난 뒤 정리된다.
  - sweep은 다른 goalInstanceId의 폴더와 쓰는 중인 카드를 건너뛴다.
  - `report`는 지우지 않고 기록만 한다.
  - `delete` 모사: `stopped` Goal의 카드 폴더와 큐 item·attempt가 없는 상태에서 sweep을 돌면, 폴더 0개, `git worktree list`의 해당 항목 0개, 카드 브랜치는 남는다.
- **`memory-agent/src/kanban/git-worktrees.test.ts`**: `Done`인데 깨끗하지 않으면 브랜치가 남고 폴더가 지워진다.
- **`memory-agent/src/kanban/orchestrator.test.ts`**: 닫힌 Plan과 supersede가 `settleGoal`을 부르고, `stopSession`은 부르지 않는다.
- **`memory-agent/src/kanban/README.md`**: 보존 규칙(`:48`)을 "Goal이 살아 있는 동안 폴더, Goal이 끝나면 스냅샷 커밋 뒤 카드 브랜치"로 고친다. `CardWorktrees` 메서드 목록(`:26`)과 janitor를 적는다.
- **`docs/kanban-orchestration.md`**: worktree 보존 설명(`:66`)을 같은 규칙으로 고치고, 시작 sweep을 적는다.

### Step 10. 기록 확인

- **`docs/decisions.md`**: Step 1의 기준선과 Step 7의 시작 검사 결과(고친 세션 수)가 기록됐는지 확인한다.

---

_Drafted with EGM_
