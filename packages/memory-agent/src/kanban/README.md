# kanban

## Overview

`packages/memory-agent/src/kanban`은 Goal을 칸반 보드로 실행하는 백엔드 계층입니다. 카드 시도는 DurableQueue 항목 하나로 다루고, 카드마다 git worktree를 둡니다. 끝난 카드는 Goal 브랜치에 squash로 하나씩 들어가고, Goal 브랜치는 merge queue를 거쳐 사용자 브랜치로 병합됩니다.

이 디렉터리는 다음을 Effect 서비스(`Context.Service`)와 레이어로 묶습니다. 대상은 결정적 오케스트레이터 루프(`KanbanOrchestrator`), 오케스트레이터 모델이 쓰는 보드 동작과 도구, 실행 기록 SQLite 저장소(`CardAttempts`), 사람 결정 대기, 프로젝트 스케줄러와 Goal 순서·일정입니다. 카드 에이전트와 검증기는 계약(`card-agent.ts`, `worktree.ts`)으로만 의존합니다. 프로덕션에서는 세션 subagent(`subagent-card-agent.ts`)와 git 구현(`git-worktrees.ts`)이 이 계약을 채웁니다.

## Interface

- `KanbanOrchestrator` — 이 owner의 칸반 Goal 오케스트레이터 루프 서비스입니다. `KanbanOrchestrator.layer(options: KanbanOrchestratorOptions)`로 만들고 `stopAttempt(goalInstanceId, cardId)` 등을 제공합니다. 관련 export로 `KanbanStartRefused`, `KanbanAttentionReason`, `KanbanAttention`이 있습니다.
- `KanbanBoardActions` — 오케스트레이터 모델의 보드 동작 서비스입니다. 카드 분할·병합·취소·이동, 사용자 변경 요청 처리, Goal 변경 분류 적용을 맡습니다. 거절할 때는 `KanbanActionRefused`(reason literal은 `not_kanban`, `card_running`, `card_waiting`, `card_has_dependents`, `transfer_target_invalid` 등)로 실패합니다.
- `ChangeDecision` / `GoalChangeVerdict` — 실행 중인 카드에 대한 사용자 변경 처리(Apply/Reassign/Reject)를 담는 Schema.TaggedUnion입니다. 변경된 Goal에 비춘 카드 판정(Continue/Amend/Stop/Replace/NeedsDecision)도 같은 형식입니다.
- `KanbanBoardView` / `KanbanCardView` / `KanbanScheduleView` / `KanbanGoalOption` — 보드 화면용 view 타입입니다. 카드 hold 사유, 실패 횟수, 일정, 대기 중인 Goal, 루프 상태(`LoopHealth`)를 담습니다.
- `BoardHealth` — 보드별 루프 상태를 메모리에 두는 서비스입니다. `get`, `restart(board)`, `supervise(board, message, annotations)`를 제공하고 `BoardHealth.layer`로 만듭니다. 보드 식별에는 `BoardRef`를 씁니다.
- `boardOps(workflows)` — 단일 카드 변경을 조합하는 헬퍼입니다. `addCard`, `editCard`, `cancelCard`, `replaceCards`를 돌려줍니다.
- `CardAgent` / `CardVerifier` / `GoalVerifier` — 카드 한 번의 delivery 실행, 카드 검증, Goal 브랜치 통합 검증의 서비스 계약입니다. 입력은 `CardAgentRun`, `CardVerification`, `GoalVerification`이고 결과는 `CardAgentOutcome`(Finished/Failed)과 `CardVerdict`(Passed/Failed)입니다.
- `CardAttempts` — 칸반 실행 기록 서비스(`CardAttempts.layer`)입니다. owner 연결로 SQLite에 기록하며 `activeGoals`, `goal(goalInstanceId)` 등을 제공합니다.
- `CardAttemptOutcome` / `AssignmentHold` / `KanbanMode` / `KanbanGoal` / `CardAttempt` / `CardAttemptKey` / `CardLadder` / `DeadLetteredAttempt` — 시도 결과 tagged union(Completed/Failed/Fenced/Superseded/Stopped), Goal 변경 hold, `worktree`·`sequential` 모드, 카드 실패 사다리를 정의합니다.
- `KanbanStorageFailed` / `KanbanStorageReason` — 칸반 저장소 오류입니다. operation은 goal/attempt/run/card/dead_letters/change_request/decision이고, reason은 Storage/Encode/Missing입니다.
- `CardQueue` / `CardRunPayload` / `cardQueueName` / `cardAttemptKey` / `cardDeliveryLimit` — 카드 시도 DurableQueue, 그 payload, 큐 이름, 시도 키, dead-letter 전 최대 delivery 수(3)입니다.
- `CardAttemptExecution` / `cardAttemptExecutionLayer` — 카드 시도 하나를 기다리는 durable workflow(`KanbanCardAttempt`)와 그 등록 레이어입니다. 큐 항목을 offer하고 결과를 기다립니다.
- `cardQueueWorkerLayer` / `cardQueueFactoryLayer` — 카드 큐 worker(`handleCardRun`) 레이어입니다. owner용 `PersistedQueueFactory`는 카드 큐에 delivery 한도와 gate를 적용합니다.
- `CardQueueGate` / `CardRuns` — `CardQueueGate`는 모든 Goal에 걸쳐 동시에 실행할 카드 수를 정하는 Semaphore로, `KanbanSettings`에서 값을 읽습니다. `CardRuns`는 실행 중인 카드 에이전트의 `FiberMap`이며 항목을 건드리지 않고 run을 멈출 때 씁니다.
- `CardFailure` / `CardHoldReason` / `VerdictFailure` / `AgentFailureCode` / `WorktreeFailureReason` — 카드 실패와 hold 사유를 정한 닫힌 태그 집합입니다(`failures.ts`). 변환 헬퍼로 `failureCode`와 `worktreeFailure`가 있습니다.
- `CardWorktrees` / `CardWorktreesApi` / `CardWorkspace` — 카드 worktree와 Goal 브랜치의 계약입니다. 메서드는 `lease`, `present`, `settle`, `commitWork`, `syncWithGoal`, `squashIntoGoal`, `earlierWork`, `prepareGoal`, `currentBranch`, `goalHead`, `mergeTargetIntoGoal`, `advanceTarget`, `goalCheckout`, `pushGoalBranch`, `goalFolders`, `goalFolder`, `removeGoalFolder`, `staleWorktrees`, `prune`이며, owner 프로세스에서만 씁니다.
- `GoalRef` / `CardRef` / `CardWorktree` / `GoalFolder` / `WorktreeDisposition` / `WorktreeSettlement` / `GoalSync` / `CardIntegration` / `TargetSync` / `TargetAdvance` — worktree 계약이 쓰는 값 타입이며 앞의 넷은 interface, 나머지는 `Data.taggedEnum`입니다.
- `CardWorkspaceJanitor` / `SweepMode` / `SweepSummary` — 끝난 Goal의 카드 worktree를 정리하는 서비스입니다(`workspace-janitor.ts`). `settleGoal`은 오케스트레이터가 Plan을 닫거나 새 Goal로 넘어간 보드를 멈춘 뒤 부르고, `settleDelivered`는 card queue가 delivery의 lease를 닫은 뒤 부릅니다. `sweep`은 layer가 만들어질 때 상수 `sweepMode`(`report`)로 한 번 돕니다.
- `CardWorktreeFailed` / `CardWorktreeFailedReason` / `cardWorktreeFailedReasonName` / `CardIntegrationConflict` / `GoalMergeConflict` — worktree 작업의 실패와 충돌 오류입니다.
- `cardToolProject` / `sequentialWorkspace` / `cardWorkspace` — `cardToolProject`는 프로젝트를 카드 worktree 루트와 `deniedRoots` fence로 좁힙니다. `sequentialWorkspace`는 worktree 없이 프로젝트 자체에서 실행하는 workspace입니다. `cardWorkspace`는 모드에 따라 workspace를 고릅니다.
- `gitCardWorktreesLayer(worktreesBase?)` — `CardWorktrees`의 git 구현 레이어입니다. 카드 worktree는 `worktreesBase` 아래에 만들고, 기본값은 `defaultWorktreesBase`(home 디렉터리 기준)입니다.
- `HumanDecisions` — 칸반 카드의 durable `human_decision` 대기 서비스입니다. `HumanDecisions.layer`는 `HumanDecisionExecution` workflow를 함께 등록합니다. 관련 export로 `DecisionKind`, `DecisionOccasion`, `DecisionAnswer`, `DecisionCloseScope`, `DecisionCloseReason`, `DecisionAnswered`, `HumanDecisionRefused`가 있습니다. 저장 형태(`DecisionKind`, `HumanDecisionPayload`)는 Schema만 쓰는 `human-decision-schema.ts`에 있어 DB 마이그레이션이 서비스 없이 읽습니다.
- `GoalSchedules` / `GoalMergeState` / `GoalScheduleRefused` / `GoalScheduleStorageFailed` — 프로젝트 스케줄러가 쓰는 Goal 일정 서비스와 그 타입입니다. 일정에는 대상 브랜치, 의존 edge, merge 상태, 보호 브랜치가 들어갑니다. `board-actions.ts`는 `get`, `edges`, `forProject`를 호출합니다.
- `ProjectScheduler` / `GoalOrder` / `GoalMerges` — `ProjectScheduler`는 프로젝트 스케줄러로, slot을 배정하고 `waitingOn`을 제공합니다. `GoalOrder`는 프로젝트 순서와 프로젝트별 Goal 순서를, `GoalMerges`는 Goal merge queue를 맡습니다. 셋 다 `.layer`를 가집니다.
- `KanbanTools` / `kanbanAttentionPrompt` — `KanbanTools`는 칸반 세션의 보드 도구(`readBoard`, `editBoard`)입니다. `kanbanAttentionPrompt`는 루프가 모델을 필요로 할 때 보내는 자동 후속 프롬프트입니다.
- `PersistedQueueItems` / `persistedQueueStoreLayer` / `persistedQueueCleanupLayer` / `subagentCardAgentsLayer` — owner 연결의 PersistedQueue 저장소 레이어와 그 dead-letter 조회·requeue 서비스, 완료 항목 정리 레이어입니다. `subagentCardAgentsLayer`는 `CardAgent`·`CardVerifier`·`GoalVerifier`를 세션 subagent로 구현합니다.
- 하위 디렉터리 없음

## Invariants

- 실패 사유와 hold 사유는 닫힌 tag 집합으로 유지합니다(`docs/decisions.md` "칸반 실패 사유는 닫힌 태그로 (2026-10-18)"). 모델이 쓴 문장은 `note`에만 두고 그 값으로 분기하지 않습니다. 이름이 정해지지 않은 실패는 모두 `Defect`입니다. `failureCode`는 tag만 쓰고 모델의 문장은 넣지 않습니다.
- `WorktreeFailureReason` literal은 `satisfies`로 `CardWorktreeFailedReason`의 case 키와 맞춰져 있습니다. 둘 중 하나를 바꾸면 다른 하나도 함께 바꿔야 합니다.
- 오케스트레이터와 큐 handler는 `CardAgent`, `CardVerifier`, `GoalVerifier`, `CardWorktrees` 계약에만 의존합니다. git 구현과 subagent 구현은 레이어로 바꿔 끼울 수 있게 둡니다.
- `CardAgentRun.register`는 agent run에 id가 생긴 직후, 어떤 도구도 호출하기 전에 한 번만 불러야 합니다. `CardAgent.run`이 interrupt되면 run의 checkpoint가 정리된 다음에 effect가 끝납니다.
- `lease`의 scope가 열려 있는 동안에는 그 worktree를 settle로 치울 수 없습니다. `goalCheckout`이 만든 checkout은 scope가 닫힐 때 제거됩니다.
- `squashIntoGoal`을 하려면 카드에 이미 Goal HEAD가 들어 있어야 하고, 아니면 `GoalAdvanced`로 실패합니다. 한 Goal의 integration은 한 번에 하나씩만 실행합니다. `syncWithGoal`이 `Merged`를 돌려준 카드는 squash 전에 다시 검증해야 합니다.
- 충돌은 자동으로 해결하지 않고 파일 단위로 보고합니다. `mergeTargetIntoGoal`은 충돌이 나면 아무것도 쓰지 않고 어떤 checkout도 건드리지 않습니다. `advanceTarget`은 uncommitted 변경이 있는 checkout을 덮어쓰지 않고 기다립니다. `pushGoalBranch`는 push를 반복하지 않습니다.
- `prepareGoal`은 사용자의 checkout, index, 현재 브랜치를 바꾸지 않습니다. Goal 브랜치는 사용자의 현재 HEAD에서 시작합니다.
- `WorktreeDisposition`에 따른 보존 규칙은 다음과 같습니다. `Done`이면 worktree와 카드 브랜치를 제거하되, 커밋하지 않은 변경이 남아 있으면 snapshot을 commit하고 브랜치를 남깁니다. `Cancelled`이면 먼저 카드 브랜치에 snapshot을 commit해 복구할 수 있게 한 뒤 worktree를 제거합니다. `Blocked`와 `HumanDecision`이면 worktree를 그대로 둡니다.
- worktree는 Goal이 살아 있는 동안 폴더로, Goal이 끝나면 snapshot commit 뒤 카드 브랜치로 남습니다. Goal이 끝났다는 것은 보드가 멈췄고 Plan이 닫혔거나 대화가 다른 Goal instance로 넘어갔다는 뜻입니다. 대화를 지워 멈춘 보드는 디스크를 그대로 둡니다(`docs/decisions.md` "Goal을 실행한 대화를 지우면 Goal 기록도 같이 지운다 (2026-10-25)"). janitor는 브랜치를 지우지 않습니다.
- Goal 폴더가 이 owner의 것인지는 그 goalInstanceId가 이 DB의 `kanban_goals`에 있는지로 판정합니다. 다른 설치본과 지운 대화의 폴더는 건드리지 않습니다. Goal-level check가 쥔 `.goal` checkout은 그 scope가 닫힐 때까지 지우지 않습니다.
- `sequential` 모드(git 없음, git 저장소 아님, commit 없음)에서는 Goal의 카드를 프로젝트 자체에서 한 번에 하나씩 실행합니다. 이때 commit, sync, merge는 no-op입니다.
- `CardWorktrees`는 owner 프로세스에서만 씁니다. `persistedQueueStoreLayer`는 owner 프로세스에서 한 번만 만듭니다.
- `boardOps`는 변경할 때마다 그 순간 Plan의 `planVersion`을 새로 읽어 `editBoard`에 넘깁니다. 그래서 그 사이에 들어온 다른 변경을 덮어쓰지 않습니다. `replaceCards`는 먼저 dependent의 `dependsOn`을 대체 카드로 바꾼 뒤, 대체되는 카드를 leaf부터 취소합니다.
- 보드 동작은 호출한 run의 `Orchestrator` author로 저장합니다. 카드가 `in_progress` 또는 `verify`에 있으면 실행 중으로 보고 `card_running`으로 거절합니다. `interrupt`는 카드 상태를 먼저 전이한 뒤 `stopAttempt`를 부릅니다. 그러면 delivery는 Stopped로 끝나고, 카드는 그 뒤에 다시 배정됩니다.
- 사람 결정 요청의 정체성은 카드와 `DecisionOccasion`(무엇 때문에 묻는지)뿐입니다. 같은 occasion을 다시 물으면 같은 요청이고, 그때 본 사실(`DecisionKind`)이 달라졌을 때만 `human_decision_facts`에 다음 `seq` 행을 더합니다. 답은 화면이 본 `factsSeq`를 함께 보내고, 대기 중인 요청의 최신 `seq`와 다르면 `facts_changed`로 거절합니다. 답한 뒤나 닫힌 뒤에는 사실을 더하지 않습니다.
- 카드를 retire할 때는 열린 사람 결정 대기를 `card_stopped`로 닫습니다. 닫기는 답이 아니므로 카드를 옮기지 않습니다. 그다음 worktree를 `Cancelled`로 settle합니다.
- 대화가 다른 Goal instance로 교체한 Goal은 이 Goal이 기다릴 대상 목록에서 뺍니다. 기준은 `workflows.goalInstanceId(sessionId)`와 같은지입니다.
- `BoardHealth`는 메모리에만 있습니다. 한 번 멈춘 보드는 `restart` 전까지 그 상태를 유지하고, 이후 들어오는 step 보고가 멈춘 이유를 덮지 않습니다. owner를 재시작하면 모든 보드가 healthy로 다시 시작합니다.
- 시각은 `Clock.currentTimeMillis`로 읽습니다. `CardLadder.notBefore`는 Clock 기준 밀리초입니다. `CardAttemptOutcome`, `AssignmentHold`, `CardHoldReason`, notes는 JSON 문자열 컬럼에 Schema로 encode·decode하므로, 바꿀 때는 저장된 행과의 호환성을 지켜야 합니다.
- 카드 시도 하나는 delivery를 `cardDeliveryLimit`(3)번 넘기면 dead-letter로 갑니다.
- 카드 검증은 최대 3라운드입니다. 라운드마다 카드의 현재 상태를 검증하고, 움직인 Goal 브랜치와 sync하면 다음 라운드가 필요합니다. 3라운드 안에 끝나지 않으면 카드는 `GoalBranchKeptMoving`으로 실패합니다.
- Goal 병합은 한 번에 `mergeRounds`(3)라운드까지 다시 검증하고 대상 브랜치를 전진시킵니다. 모든 라운드에서 대상 브랜치가 움직였을 때만 merge 상태를 `TargetMoving`으로 남기고, 다음 확인 때 다시 시도합니다.

## Side Effects

- SQLite(owner 연결의 `SqlClient`)를 읽고 씁니다. 대상 테이블은 `kanban_goals`, `kanban_card_attempts`, `kanban_cards`이고 change request, run, dead letter 행도 포함합니다(`CardAttempts`). Goal 일정·순서·사람 결정(`human_decision_facts`, `human_decision_closures`)·persisted queue 저장소도 SQL을 씁니다(서비스 doc 기준).
- 프로세스 안의 `PubSub`로 결과가 새로 기록된 Goal instance를 알립니다(`CardAttempts`).
- `AppEvents.publishSession(sessionId, "run-state")`로 보드 상태가 바뀐 것을 발행합니다(`BoardHealth`). 상태는 `Ref`에 둡니다.
- git 명령을 실행하고 파일 시스템을 바꿉니다. worktree 생성·제거, 카드·Goal 브랜치, commit, squash, merge, 사용자 브랜치 전진을 다루며 위치는 home 디렉터리 기준 `defaultWorktreesBase` 아래입니다(`gitCardWorktreesLayer`).
- `pushGoalBranch`가 `origin`으로 네트워크 push를 합니다.
- durable workflow와 DurableQueue를 씁니다(`CardAttemptExecution`, `HumanDecisionExecution`, `CardQueue` worker). 완료된 queue 요소는 정리 레이어가 지웁니다.
- 동시성을 제어합니다. `CardQueueGate`의 Semaphore로 전역 카드 동시 실행 수를 제한하고, `CardRuns`의 `FiberMap`으로 실행 중인 agent fiber를 interrupt합니다.
- 세션 subagent로 LLM 카드 에이전트와 검증기를 실행합니다(`subagentCardAgentsLayer`).

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
