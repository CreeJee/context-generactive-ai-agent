# Goal 상태 전이

`packages/memory-agent/src/workflow/goal-transitions.test.ts`가 만든다. 새 세션에서 모든 사건을 보내 도달한 상태와, 상태마다 각 사건의 결과다. 결과의 상태 이름은 사건 뒤의 상태이고, 그대로는 바뀐 것이 없다는 뜻이다. 전이를 바꾸면 이 파일이 바뀌므로 diff를 리뷰한다.

## 도달한 상태 수

- `NoGoal`: 28
- `Shaping`: 88
- `Running`: 10
- `GoalChanged`: 20
- `Paused`: 74
- `Blocked`: 20
- `Stopped`: 88
- `Closed`: 72
- `Completed`: 70

## `NoGoal`

- `Navigated`: NoGoal, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: 거절: `plan_not_ready`
- `GoalPaused`: 거절: `goal_missing`
- `GoalResumed`: 거절: `goal_missing`
- `GoalStopped`: 거절: `goal_missing`
- `GoalEdited`: Closed, Shaping
- `PlanEdited`: NoGoal, 그대로
- `PlanClosed`: NoGoal, 거절: `plan_closed`, 거절: `plan_missing`
- `NewGoalRequested`: 거절: `goal_missing`, 거절: `phase_not_authorized`
- `NewGoalStarted`: 거절: `goal_missing`, 거절: `phase_not_authorized`
- `BoardEdited`: NoGoal, 거절: `plan_missing`, 그대로
- `OutcomesMet`: 거절: `goal_missing`

## `Shaping`

- `Navigated`: Shaping, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: Running, 거절: `plan_not_ready`, 거절: `plan_outdated`
- `GoalPaused`: Paused
- `GoalResumed`: 거절: `goal_not_paused`
- `GoalStopped`: Stopped
- `GoalEdited`: Shaping, 그대로
- `PlanEdited`: Shaping, 그대로
- `PlanClosed`: Closed, 거절: `plan_closed`, 거절: `plan_missing`
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`, 그대로
- `BoardEdited`: Closed, Shaping, 거절: `plan_missing`, 그대로
- `OutcomesMet`: 거절: `plan_not_executing`

## `Running`

- `Navigated`: Running, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: Running, 그대로
- `GoalPaused`: Paused
- `GoalResumed`: 거절: `goal_not_paused`
- `GoalStopped`: Stopped
- `GoalEdited`: GoalChanged
- `PlanEdited`: Shaping
- `PlanClosed`: Closed
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Closed, Running, 그대로
- `OutcomesMet`: Completed, 거절: `steps_incomplete`

## `GoalChanged`

- `Navigated`: GoalChanged, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: 거절: `plan_outdated`
- `GoalPaused`: Paused
- `GoalResumed`: 거절: `goal_not_paused`
- `GoalStopped`: Stopped
- `GoalEdited`: GoalChanged, 그대로
- `PlanEdited`: Shaping
- `PlanClosed`: Closed
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Closed, GoalChanged, 그대로
- `OutcomesMet`: Completed, 거절: `steps_incomplete`

## `Paused`

- `Navigated`: Paused, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: Paused, 거절: `plan_not_ready`, 거절: `plan_outdated`, 그대로
- `GoalPaused`: 거절: `goal_not_active`
- `GoalResumed`: Blocked, GoalChanged, Running, Shaping
- `GoalStopped`: Stopped
- `GoalEdited`: Blocked, GoalChanged, Shaping
- `PlanEdited`: Paused, 그대로
- `PlanClosed`: Closed, 거절: `plan_closed`, 거절: `plan_missing`
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Closed, Paused, 거절: `plan_missing`, 그대로
- `OutcomesMet`: 거절: `goal_not_active`

## `Blocked`

- `Navigated`: Blocked, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: 거절: `plan_outdated`
- `GoalPaused`: Paused
- `GoalResumed`: 거절: `goal_not_paused`
- `GoalStopped`: Stopped
- `GoalEdited`: Blocked, 그대로
- `PlanEdited`: Shaping
- `PlanClosed`: Closed
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Blocked, Closed, 그대로
- `OutcomesMet`: 거절: `plan_not_executing`

## `Stopped`

- `Navigated`: Stopped, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: 거절: `goal_terminal`
- `GoalPaused`: 거절: `goal_terminal`
- `GoalResumed`: 거절: `goal_terminal`
- `GoalStopped`: 거절: `goal_terminal`
- `GoalEdited`: Blocked, Closed, Shaping
- `PlanEdited`: Stopped, 그대로
- `PlanClosed`: Stopped, 거절: `plan_closed`, 거절: `plan_missing`
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Stopped, 거절: `plan_missing`, 그대로
- `OutcomesMet`: 거절: `goal_terminal`

## `Closed`

- `Navigated`: Closed, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: 거절: `plan_not_ready`, 거절: `plan_outdated`
- `GoalPaused`: Closed, 그대로
- `GoalResumed`: 거절: `goal_not_paused`
- `GoalStopped`: Stopped
- `GoalEdited`: Closed, 그대로
- `PlanEdited`: Paused, Shaping
- `PlanClosed`: 거절: `plan_closed`
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Closed, 그대로
- `OutcomesMet`: 거절: `plan_not_executing`

## `Completed`

- `Navigated`: Completed, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: 거절: `goal_terminal`
- `GoalPaused`: 거절: `goal_terminal`
- `GoalResumed`: 거절: `goal_terminal`
- `GoalStopped`: 거절: `goal_terminal`
- `GoalEdited`: Closed, Shaping
- `PlanEdited`: Completed, 그대로
- `PlanClosed`: Completed, 거절: `plan_closed`
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Completed, 그대로
- `OutcomesMet`: 거절: `goal_terminal`
