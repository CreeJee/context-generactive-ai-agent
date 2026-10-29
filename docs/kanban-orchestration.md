# 칸반 오케스트레이션 설계 (2026-10-18)

상태: 구현됨(슬라이스 A·B·C·D·F, 전체 흐름 검증 E, 보드 UI G 2026-10-18). 결정은 [decisions.md](decisions.md)에 있다. 확정(2026-10-18): DurableQueue, 동시 실행 수 사용자 설정과 기본값, worktree 위치, `goalInstanceId` 기준 식별, Goal 변경 시 카드별 영향 분류, squash·자동 merge 브랜치 흐름, 프로젝트 스케줄러.
배경 논의: 세션 `c872e018`(2026-10-10~11). 현재 구현 범위 밖으로 둔 결정: decisions.md "Plan step 의존성 기반 스케줄링 (2026-10-13)".

## 목표

Goal 하나를 카드(Plan step) 보드로 운영한다. 상위 오케스트레이터가 Ready 카드를 서브에이전트에 병렬로 배정하고, 결과를 모아 검증·통합·재계획한다. 사용자와 오케스트레이터는 같은 보드를 수정할 수 있고, 수정마다 누가 했는지 남는다.

## 이미 있는 기반

- `GoalExecution` Workflow, SQLite 기반 `OwnerWorkflowEngine`, `DurableDeferred`·`DurableClock`
- provider 요청 전 transport 실패의 durable 재시도, 재시작 후 이어가기 fence(`endedWithKnownEffectsSql`)
- `PlanStep.dependsOn` Ready 계산, `PlanDependenciesRejected`, `dependency_stalled`
- `ExecutionAdmission`(workflow·worker·model·tool 동시성 Semaphore), owner side-effect ledger
- 서브에이전트 실행 기록 `work_tasks`·`agent_run_attempts`

## 모델

```ts
type CardStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "verify"
  | "human_decision"
  | "done"
  | "blocked";

type BoardAuthor =
  | { readonly _tag: "User" }
  | { readonly _tag: "Orchestrator"; readonly runId: string };
```

- 카드 = 기존 `PlanStep`을 확장한다. 기존 필드(`dependsOn`, `acceptanceCriteria`, `evidence`)는 유지한다. `pending`·`in_progress`·`completed`·`blocked`는 각각 `ready|backlog`·`in_progress`·`done`·`blocked`로 읽는다.
- 카드 계약(선택 필드): Outcome, Boundaries, Risk, Evidence, Human decision. Evidence는 고정 체크리스트가 아니라 카드의 위험에 맞춰 오케스트레이터가 고른다.
- 모든 보드 변경은 `workflow_state_revisions`에 `BoardAuthor`와 함께 남는다.

## 수정 권한

- 사용자: 카드 추가·수정·순서·의존·취소, `human_decision` 응답.
- 오케스트레이터: 분할·병합·재배치·상태 전이, 재계획.
- 실행 중(`in_progress`) 카드를 사용자가 고치면 바로 덮어쓰지 않는다. `UserChangeRequest`로 오케스트레이터에 전달한다. 오케스트레이터가 반영(진행 중 attempt에 전달), 중단 후 재배정, 거절(사유 표시) 중 하나를 고른다.

## 보드 의도 (확정 2026-10-18)

드래그는 의도, 상태는 서버다. 보드는 드롭을 아래 의도 하나로 보내고(`BoardIntent`, `KanbanBoardActions.applyIntent`), 카드 상태는 owner가 정한다. 맞지 않는 의도는 리터럴 reason으로 거절한다.

| 의도                       | 보드 드롭                | 처리                                                                         | 거절 reason                             |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------- | --------------------------------------- |
| `Reorder(cardId, at)`      | 같은 열 안               | 카드 순위 = Plan 순서 = Goal 안 배정 순서. `at`은 같은 Plan의 카드           | `reorder_across_columns`·`card_missing` |
| `Requeue`                  | 막힘 → 준비              | dead-letter item을 다시 열거나 실패 기록을 지우고 ready로                    | `card_not_blocked`, `not_kanban`        |
| `Hold`                     | 준비 → 백로그            | `PlanStep.hold { by, at }`를 붙인다. 의존이 끝나도 backlog에 남아 배정 안 됨 | `card_not_waiting`, `card_held`         |
| `Release`                  | 보류 카드 → 준비         | hold를 떼고 의존을 다시 따른다                                               | `card_not_held`                         |
| `ChangeRequest(cardId, …)` | 진행 중 카드를 다른 열로 | 이동하지 않고 수정 요청을 쓰게 한 뒤 `UserChangeRequest`로 보낸다            | `card_not_running`                      |
| `Cancel`                   | (peek의 취소)            | 기존 `CancelCard`·중단 경로                                                  | 기존 보드 편집 거절                     |

- 매핑이 없는 드롭(진행 중·검증·판단 필요·완료·막힘 열로, 판단 필요·검증·완료 카드에서)은 드래그 중 비활성과 이유를 보인다. 판단 필요 카드는 판단 응답으로 처리한다.
- 보류는 재시작·같은 id의 replan 뒤에도 유지된다(Plan과 함께 `workflow_state_revisions`에 저장). 이유는 decisions.md "드래그는 의도, 상태는 서버 (2026-10-18)".
- 화면은 채팅의 요약과 전체 폭 보드 Sheet(`?board`), 카드 peek(`?card`)로 나눈다. 상호작용은 decisions.md "칸반 보드 화면 (2026-10-18)". 프로젝트의 실행 중인 Plan은 사이드바 "칸반 보드"의 전체 보드(`?boards`, 한 보드에 실행 중인 Plan의 카드, 카드 peek은 `?boardCard`)에서 함께 보고, 실행 전 Plan은 거기서 이름만 보인다. decisions.md "프로젝트 보드를 한 보드로 합치고 카드를 다른 대화로 옮기기 (2026-10-22)", "우선순위 트리 (2026-10-22)".

## 실행

- 카드 실행 = 서브에이전트 attempt 1개. 카드가 실행을 시작할 때 Goal 브랜치에서 카드 전용 git worktree를 만든다. 서브에이전트의 파일·셸 도구 cwd는 그 worktree로 고정한다.
- 동시 실행 카드 수(WIP)는 사용자 설정이다. 기기 사양에 따라 다르다. 상한은 `Semaphore`로 둔다. `human_decision`·재시도 대기처럼 기다리는 카드는 슬롯을 반환한다.
- worktree는 카드가 `done`이 되거나 취소되면 정리한다. `blocked`·`human_decision` 카드의 worktree는 Goal이 살아 있는 동안 보존한다. `done` 카드에 커밋하지 않은 변경이 남아 있으면 카드 브랜치에 스냅샷 커밋하고 브랜치를 남긴다.
- worktree 정리(2026-10-29): Goal이 끝나면(Plan을 닫거나 새 Goal로 넘어감) `CardWorkspaceJanitor`가 남은 카드 worktree마다 스냅샷 커밋 뒤 폴더를 지우고 카드 브랜치를 남긴다. 그때 attempt가 쥔 worktree는 그 delivery가 끝날 때 정리한다. 대화를 지워 멈춘 Goal은 디스크를 그대로 둔다. `ctx/*` 브랜치는 지우지 않는다.
- 시작 sweep: owner가 시작할 때 card queue와 보드보다 먼저 worktree 위치를 훑는다. goalInstanceId가 이 DB에 있는 폴더만 판정하고, 끝난 Goal의 폴더, 실행 중인 보드에서 끝났거나 Plan에서 빠진 카드의 폴더, 폴더가 없는 git worktree 등록을 찾는다. 첫 릴리즈는 경고 로그와 span 숫자로 기록만 하고(`report`), 기록을 본 뒤 지우기(`delete`)로 바꾼다.
- worktree 위치(확정): `~/.context-generactive-agent-worktrees/<goalInstanceId>/<cardId>`. storage root(`~/.context-generactive-agent`)는 `files/paths.ts`의 credential directory라 그 아래에 두지 않는다. 보호 경계에 예외를 만들지 않는다.
- 카드 서브에이전트의 파일·셸 도구 루트는 프로젝트 루트가 아니라 그 카드 worktree다. 다른 카드 worktree와 사용자 작업 트리는 거부한다.
- 기본값(확정): 동시 실행 수 = CPU 코어 수의 절반(최소 1, 최대 4), 사용자 설정으로 바꾼다. 카드당 최대 시도 수 = 3. provider 장애 재시도(24시간 한도)는 시도 수와 따로 센다.
- git 저장소가 아닌 프로젝트는 worktree를 만들 수 없으므로 카드를 순차로 실행한다.

## 브랜치 흐름 (확정 2026-10-18)

```text
사용자 브랜치 (예: main@abc) ──Goal 시작── ctx/goal/<goalId>
                                              ├─ ctx/card/<goalId>/<cardA>  (worktree A)
                                              └─ ctx/card/<goalId>/<cardB>  (worktree B)
```

1. Goal을 시작하면 사용자 현재 HEAD에서 Goal 브랜치를 만든다. 사용자 작업 트리와 브랜치는 건드리지 않는다.
2. 카드는 실행을 시작할 때의 Goal 브랜치 HEAD에서 카드 브랜치와 worktree를 만든다.
3. verify를 통과한 카드는 Goal 브랜치에 하나씩 통합한다. 통합은 owner에서 직렬로 한다.
   - 그사이 다른 카드가 Goal 브랜치를 앞으로 옮겼으면, 먼저 Goal 브랜치를 카드 브랜치에 merge하고 카드의 Evidence를 다시 확인한다.
   - 그다음 카드 하나를 squash commit 하나로 Goal 브랜치에 올린다. 카드와 commit이 1:1이라 되돌리기 쉽다.
   - 충돌은 자동으로 풀지 않는다. 오케스트레이터가 해결 카드를 새로 만들거나 `human_decision`으로 보낸다.
4. 카드가 모두 `done`이면 Goal 브랜치에서 Goal 수준 통합 검증을 한다.
5. 통합 검증을 통과하면 Goal을 시작한 사용자 브랜치에 자동으로 merge한다(확정 2026-10-18). 예외: 대상이 보호 브랜치(프로젝트 설정, 기본 `main`·`staging`)면 자동 merge하지 않고 `human_decision`에서 PR 생성이나 수동 merge를 고른다.
   - 같은 대상 브랜치로 가는 merge는 owner가 대상 브랜치별로 하나씩 처리한다(merge queue).
   - 사용자 브랜치가 그사이 앞으로 갔으면 Goal 브랜치에 먼저 merge하고 통합 검증을 다시 한다. 충돌은 `human_decision`으로 보낸다.
   - 대상 브랜치가 사용자 작업 트리에 checkout되어 있고 커밋하지 않은 변경이 있으면 merge하지 않고 기다린다. 사용자 작업 파일을 덮어쓰지 않는다.

## 큐: DurableQueue (확정 2026-10-18)

10-10 결정은 DurableQueue를 보류했다. 이유는 세 가지다. at-least-once 재전달, 부작용 뒤 crash, dead-letter 운영 경로 부재. 카드 단위로 보면 이 문제를 받아들일 수 있다.

- **재전달은 replay가 아니라 이어가기다.** 재전달된 카드는 같은 worktree와 이전 transcript를 보고 새 attempt로 남은 일을 한다. 이미 쓴 파일은 worktree에 남아 있어 다시 쓰지 않는다. 기존 continuation run 예외(2026-10-13)와 같은 근거다.
- **fence는 그대로 둔다.** 이전 attempt에 `pending`·`uncertain` 도구가 있거나, 결과 기록이 없는 쓰기 도구가 있으면 자동으로 이어가지 않고 `human_decision`으로 보낸다. worktree 밖 부작용(push, 외부 API, Discord)은 계속 owner ledger receipt로만 판정한다.
- **멱등 키** = `goalId:cardId:attemptNo`. attemptNo는 owner가 저장된 값에서 정한다.
- **dead-letter.** 시도를 다 쓰면 카드를 `blocked`로 표시하고 이유를 남긴다. 보드에서 사용자나 오케스트레이터가 다시 큐에 넣을 수 있다. dead-letter된 item의 `DurableDeferred`는 자동으로 풀리지 않으므로, 이 경로가 없으면 Goal이 영구 정지한다.
- **저장소.** 프로젝트 소유 `PersistedQueue` store와 칸반 저장소(카드 시도·Goal 스케줄·보드 변경 요청·`human_decision` 닫힘 기록·보드 조회)는 owner Database layer가 제공하는 공유 `SqlClient`(같은 `DatabaseSync` 위, 연결 lease 공유)를 쓴다. 저장소마다 SqlClient를 따로 만들지 않고, 별도 DB도 두지 않는다. 여러 문장을 묶는 쓰기는 `withTransaction` 하나로 처리하고, 원시 `DatabaseSync`나 동기 `atomic`은 쓰지 않는다.
- 오래 끝난 item 정리에는 `PersistedQueue.layerCleanup`을 쓴다. 이 레이어는 owner 하나에서만 돈다.

## 식별자와 Goal 변경 (확정 2026-10-18)

- 보드, 큐 멱등 키, 브랜치는 `goalInstanceId` 기준이다. Goal 수정(`update_goal`)은 instance를 유지하고 `goal.version`·`plan.version`만 올리므로 key를 다시 매기지 않는다.
- 카드 attempt는 배정할 때 `(goalInstanceId, goalVersion, planVersion)`을 고정한다(`workflow_run_bindings`와 같은 방식). 최신 값과의 비교는 상시 동기화가 아니라 배정·verify·merge 경계에서만 한다.
- 새 Goal 전환은 세션 pointer가 새 instance로 옮겨 가는 것이다. 새 보드와 새 Goal 브랜치로 시작한다. 이전 instance의 큐 item은 handler가 pointer와 payload의 `goalInstanceId`를 비교해, 다르면 실행하지 않고 `Superseded`로 완료한다. 결과가 불확실한 도구에 대한 fence는 그대로다. 끝나지 않은 카드를 새 Goal로 옮기는 것은 명시적으로만 한다.
- 같은 instance의 Goal 수정은 일괄 정지하지 않는다. 카드별로 영향을 분류한다.

```text
GoalChanged(v3 → v4)
→ 시작 전 카드 배정만 잠시 보류(실행 중 카드는 계속 진행)
→ 오케스트레이터 영향 분류 턴: Goal 차이를 카드의 Outcome·Boundaries·파일과 대조
→ 카드별 판정을 보드에 반영(Orchestrator 작성자), 사용자는 어떤 판정이든 뒤집을 수 있다(User 작성자)
→ 배정 보류 해제
```

| 판정            | 처리                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `Continue`      | 그대로 진행. 고정 버전만 올린다                                                                          |
| `Amend`         | 실행 중이면 변경 내용을 그 attempt에 전달(`UserChangeRequest`와 같은 경로). 시작 전이면 카드 내용만 수정 |
| `Stop`          | attempt를 중단한다. worktree는 남겨 되돌릴 수 있다                                                       |
| `Replace`       | 중단하고 새 카드로 대체한다. 기존 worktree는 새 카드의 참고 자료다                                       |
| `NeedsDecision` | `human_decision`으로 보낸다                                                                              |

- 판정은 사용자 승인 없이 바로 적용한다. `Stop`·`Replace`도 worktree를 남기므로 되돌릴 수 있다.
- 이 규칙은 칸반 모드에서 "실행 중 명시적 Goal 변경 동기화 (2026-10-06)"의 "즉시 Plan으로 돌아간다"를 대신한다. 칸반이 아닌 Goal 실행은 기존 규칙을 따른다.

## 오케스트레이터 루프

```text
보드 로드 → Ready 선택(dependsOn·WIP·파일 겹침 힌트) → DurableQueue.process(card)
→ 결과 수집 → verify(Evidence) → merge | human_decision | 재계획(분할·병합·취소)
→ UserChangeRequest 처리 → 반복. 카드가 모두 done이면 Goal 수준 통합 검증
```

- 반복 실패는 재시도 → 긴 backoff → 재계획 → `human_decision` 순서로 승격한다.
- `human_decision`과 사용자 수정 요청은 `DurableDeferred`로 기다린다. 앱을 재시작해도 이어진다.

## 프로젝트 스케줄러 (확정 2026-10-18)

Goal 오케스트레이터만으로는 여러 Goal을 끝까지 자동으로 돌릴 수 없다. Goal 하나가 다른 Goal 때문에 멈추면 사람이 풀 때까지 기다리게 된다. 그래서 프로젝트 단위의 결정적 서비스(LLM 아님)를 첫 범위에 넣는다. 의미 판단은 Goal 오케스트레이터나 사람에게 넘긴다.

- **전역 상한과 우선순위 트리:** 카드 큐 worker concurrency가 전역 동시 실행 수다. 우선순위는 프로젝트 → Goal(대화) → 카드의 트리다(`kanban_project_ranks`, `kanban_goal_ranks`, `kanban/goal-order.ts`). 빈 슬롯은 트리 순서로 첫 번째 시작 가능한 카드부터 받는다: 앞 프로젝트, 그 안의 앞 Goal, 그 Plan의 앞 카드. 앞 Goal이 슬롯을 다 못 쓰면(의존·파일 겹침·순차 모드) 다음 Goal이 받아 병렬이 된다. 사용자는 돌리는 중에도 프로젝트 순서(칸반 설정)와 Goal 순서(프로젝트 보드의 대화별 상태 패널)를 바꾸고, 새 Plan은 맨 아래로 들어와 바로 위로 올릴 수 있다. 자리를 정하지 않은 프로젝트·Goal은 정한 것들 뒤에 생성 순으로 선다. 순차 모드 Goal은 한 번에 카드 하나만 받는다.
- **Goal 간 `dependsOn`:** 다른 Goal의 merge를 기다리는 Goal은 실행 슬롯을 잡지 않는다. 선행 Goal이 대상 브랜치에 merge되면 자동으로 이어 간다.
- **merge queue:** 대상 브랜치별로 하나씩 처리한다(브랜치 흐름 5).
- **upstream 변경 신호:** Goal 하나가 대상 브랜치에 merge되면, 같은 대상을 가진 진행 중 Goal에 알린다. 그 Goal은 Goal 브랜치에 대상 브랜치를 merge하고, 영향받는 카드만 다시 verify한다(Goal 변경과 같은 카드별 판정을 쓴다).
- **파일 겹침:** 카드의 예상 파일이 다른 Goal의 진행 중 카드와 겹치면 두 Goal 오케스트레이터에 알린다. 순서를 정하지 못하면 `human_decision`으로 보낸다.
- **통합 inbox:** 모든 Goal의 `human_decision`을 한곳에 모은다. 사람만 풀 수 있는 것만 올라온다.

## 슬라이스 (Orca worker별 worktree)

경로는 `packages/memory-agent/src` 기준이다(앱은 `apps/agent/app`).

| ID  | 내용                                                                                                         | 의존    | 구현 위치                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | 카드 상태·계약 필드·`BoardAuthor` 기록, 마이그레이션, 수정 가능한 보드 API·UI                                | —       | `workflow/card.ts`, `workflow/board.ts`, `workflow/board-edit.ts`, `workflow/workflow.ts`, `db/migrations.ts`, 앱 `routes/api/sessions.$session.board.tsx`, `entry/chat/board-panel.tsx`                                                 |
| B   | 카드 worktree 실행기(생성·정리·도구 루트 고정), PersistedQueue store 어댑터, 동시 실행 설정                  | —       | `kanban/worktree.ts`(계약), `kanban/git-worktrees.ts`(git 구현), `kanban/persisted-queue-store.ts`, `kanban/card-queue.ts`, `config/kanban-settings.ts`, `tools/outside.ts`, `files/paths.ts`                                            |
| C   | Goal 오케스트레이터 루프, DurableQueue 배정, verify·squash 통합, 재계획·영향 분류 도구, `UserChangeRequest`  | A, B    | `kanban/orchestrator.ts`, `kanban/card-attempts.ts`, `kanban/board-actions.ts`, `kanban/board-ops.ts`, `kanban/tools.ts`, `kanban/card-agent.ts`, `kanban/subagent-card-agent.ts`, `agent/chat.ts`                                       |
| D   | `human_decision` DurableDeferred 대기·재개, 보드 응답, 통합 inbox                                            | A       | `kanban/human-decision.ts`, 앱 `routes/api/sessions.$session.decisions.*.tsx`, `routes/api/projects.$project.decisions.tsx`, `entry/chat/decision-prompt.tsx`, `entry/navigation/decision-inbox.tsx`                                     |
| F   | 프로젝트 스케줄러: round-robin offer, Goal 간 `dependsOn`, merge queue·보호 브랜치, upstream 신호, 파일 겹침 | C, D    | `kanban/scheduler.ts`, `kanban/goal-schedules.ts`, `kanban/merge-queue.ts`, 앱 `routes/api/settings.kanban.tsx`, `routes/api/projects.$project.kanban.tsx`, `routes/api/sessions.$session.kanban.tsx`, `entry/settings/pages/kanban.tsx` |
| E   | 전체 흐름 검증(재전달·재시작·충돌·dead-letter requeue·다중 Goal), decisions.md 기록                          | C, D, F | `kanban/kanban-flow.test.ts`, 기존 슬라이스 테스트(아래 표)                                                                                                                                                                              |
| G   | 전체 폭 칸반 보드 UI(dnd-kit, 키보드·스크린 리더), 보드 의도(`BoardIntent`)와 카드 보류                      | A, C, F | `workflow/board-edit.ts`, `workflow/plan-schedule.ts`, `kanban/board-actions.ts`, 앱 `entry/chat/board/*`, `entry/chat/board-panel.tsx`                                                                                                  |

## 전체 흐름 검증 (슬라이스 E, 2026-10-18)

실제 임시 git 저장소, owner DB, DurableQueue, WorkflowEngine Layer를 쓰고 카드 에이전트·검증자만 스크립트로 대체한다(`testing/kanban.ts`). 재시작은 owner Layer의 scope를 닫고 같은 파일로 다시 여는 것으로 모사한다.

| 시나리오                                                                                        | 근거 테스트                                                                                                                                                     | 결과         |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Goal 하나: 의존 포함 카드 3개 병렬 → verify → 카드당 squash commit 1개 → Goal 검증 → 자동 merge | `kanban-flow.test.ts` "runs a Goal's cards in parallel…"                                                                                                        | 통과         |
| ack 전 crash 재전달: 같은 worktree에서 이어가기, 다시 쓰지 않음, uncertain run은 판단 요청      | `kanban-flow.test.ts` "after a crash before the result was recorded…", `card-queue.test.ts`                                                                     | 통과         |
| 재시작 뒤 대기 복원: human_decision, merge queue(보호 브랜치 판단), Goal 간 dependsOn           | `kanban-flow.test.ts` "keeps waits for a person, a protected merge and another Goal…", `human-decision.test.ts` restart                                         | 통과         |
| 재시작 뒤 큐 item: 처리 중 item 재전달, 시작 전 attempt의 메모 유지                             | `persisted-queue-store.test.ts`, `kanban-flow.test.ts` "keeps a card's notes when the owner died…"                                                              | 수정 후 통과 |
| 충돌 → 해결 카드 → 재충돌 판단 요청 → 응답 후 진행                                              | `orchestrator.test.ts` "replaces a conflicting card with a resolution card…"                                                                                    | 통과         |
| dead-letter: 전달 3회 소진 → blocked → 보드 requeue → 재실행                                    | `persisted-queue-store.test.ts` "dead-letters a card…", `orchestrator.test.ts` "blocks a card whose deliveries ran out…"                                        | 통과         |
| 다중 Goal: round-robin·전역 상한, upstream 신호로 영향 카드만 재verify, 보호 브랜치 판단        | `scheduler.test.ts`, `merge-queue.test.ts`                                                                                                                      | 통과         |
| GoalChanged: 카드별 판정, 실행 중 카드 Amend 전달, verify 중 Amend                              | `orchestrator.test.ts` "holds new assignments…", `kanban-flow.test.ts` "sends an amendment…", "does not integrate work verified before the card was amended…"   | 수정 후 통과 |
| 새 Goal 전환: 이전 instance item `Superseded`, 판단 대기 닫힘                                   | `card-queue.test.ts` "completes an earlier Goal instance's card as Superseded…", `orchestrator.test.ts` "asks a person when a Goal change's effect is unclear…" | 통과         |

브라우저 확인(격리 storage·HOME, 가짜 OpenAI 호환 모델로 카드 에이전트·검증자를 돌림): 보드에서 카드가 준비 → 진행 중 → 검증 → 완료로 옮겨 가고 의존 카드는 선행 카드 완료 뒤 시작했다. 결과를 알 수 없는 run이 있는 카드는 판단 필요로 가고 "판단 대기" inbox에 떴다. inbox에서 "반영됨, 이어서 진행"으로 답하자 카드가 진행 중 → 완료로 옮겨 가고, Goal 검증 뒤 비보호 브랜치(`feature`)로 자동 merge됐다. 설정 "실행 › 칸반 실행"에서 동시 실행 수를 4에서 3으로 바꾸자 `GET /api/settings/kanban`이 `{"configured":3,"effective":3}`을 돌려줬다.

## 알려진 한계

- `UncertainSideEffect` 요청의 `toolNames`는 비어 있다. 카드 run 기록에서 결과가 불확실한 도구 이름을 읽지 않으므로 화면은 일반 문구를 보여 준다.
- verify 판정 뒤 통합 전에 카드 상태와 Goal 변경 hold를 다시 확인하지만, squash와 `verify → done` 이동 사이에 카드가 Amend되는 짧은 구간은 남는다. 그 경우 Goal 브랜치에는 이전 squash가 남고, 고친 카드의 다음 통합은 같은 `Ctx-Card` trailer 때문에 `AlreadyIntegrated`로 끝난다.
- 전달 한도 3은 owner 프로세스가 강제 종료될 때만 소진된다. scope를 닫는 정상 종료는 interruption이라 시도를 돌려준다. 그래서 테스트의 dead-letter 경로는 `persisted_queue_items.attempts`를 직접 3으로 두어 모사한다(store 단위 테스트는 실제 실패 3회로 소진한다).
- `tests/agents/external-agents.test.ts`의 "delegation from a chat needs approval, and the agent's own request is relayed to the page"는 부하가 크면 마지막 `waitUntil`(4초) "the delegation result"에서 시간 초과로 실패한다. 단독 실행은 통과하고, 같은 파일을 6개 동시에 돌리면 칸반 이전 커밋(`9c80e4c`)과 이 브랜치 모두 6/6 같은 지점에서 실패한다. 칸반 변경과는 관련 없다.
