# Goal 상태 전이

`packages/memory-agent/src/workflow/goal-transitions.test.ts`가 만든다. 새 세션에서 모든 사건을 보내 도달한 상태와, 상태마다 각 사건의 결과다. 결과의 상태 이름은 사건 뒤의 상태이고, 그대로는 바뀐 것이 없다는 뜻이다. 전이를 바꾸면 이 파일이 바뀌므로 diff를 리뷰한다.

## 도달한 상태 수

- `NoGoal`: 392
- `Shaping`: 1344
- `Running`: 140
- `GoalChanged`: 278
- `Paused`: 1232
- `Blocked`: 554
- `Stopped`: 1576
- `Closed`: 672
- `Completed`: 1732

## `NoGoal`

- `Navigated`: NoGoal, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: 거절: `plan_not_ready`
- `GoalPaused`: 거절: `goal_missing`
- `GoalResumed`: 거절: `goal_missing`
- `GoalStopped`: 거절: `goal_missing`
- `GoalEdited`: Blocked, Closed, GoalChanged, Shaping
- `PlanEdited`: NoGoal, 그대로
- `ProgressRecorded`: NoGoal, 거절: `goal_missing`, 거절: `phase_not_executable`, 거절: `plan_missing`, 거절: `steps_incomplete`, 거절: `verification_required`, 그대로
- `RunFinished`: NoGoal, 그대로
- `PlanClosed`: NoGoal, 거절: `plan_closed`, 거절: `plan_missing`
- `NewGoalRequested`: 거절: `goal_missing`, 거절: `phase_not_authorized`
- `NewGoalStarted`: 거절: `goal_missing`, 거절: `phase_not_authorized`
- `BoardEdited`: NoGoal, 거절: `plan_missing`, 그대로

## `Shaping`

- `Navigated`: Shaping, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: Running, 거절: `plan_not_ready`, 거절: `plan_outdated`
- `GoalPaused`: Paused
- `GoalResumed`: 거절: `goal_not_paused`
- `GoalStopped`: Stopped
- `GoalEdited`: Shaping, 그대로
- `PlanEdited`: Shaping, 그대로
- `ProgressRecorded`: Blocked, Completed, GoalChanged, Paused, Running, Shaping, Stopped, 거절: `goal_completion_required`, 거절: `goal_not_active`, 거절: `phase_not_executable`, 거절: `plan_missing`, 거절: `steps_incomplete`, 거절: `verification_required`, 그대로
- `RunFinished`: Blocked, Completed, Shaping, 그대로
- `PlanClosed`: Closed, 거절: `plan_closed`, 거절: `plan_missing`
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`, 그대로
- `BoardEdited`: Closed, Shaping, 거절: `plan_missing`, 그대로

## `Running`

- `Navigated`: Running, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: Running, 그대로
- `GoalPaused`: Paused
- `GoalResumed`: 거절: `goal_not_paused`
- `GoalStopped`: Stopped
- `GoalEdited`: GoalChanged
- `PlanEdited`: Shaping
- `ProgressRecorded`: Blocked, Completed, Paused, Running, Stopped, 거절: `goal_completion_required`, 거절: `phase_not_executable`, 거절: `steps_incomplete`, 거절: `verification_required`, 그대로
- `RunFinished`: Blocked, Completed, Running, 그대로
- `PlanClosed`: Closed
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Closed, Running, 그대로

## `GoalChanged`

- `Navigated`: GoalChanged, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: 거절: `plan_outdated`
- `GoalPaused`: Paused
- `GoalResumed`: 거절: `goal_not_paused`
- `GoalStopped`: Stopped
- `GoalEdited`: GoalChanged, 그대로
- `PlanEdited`: Shaping
- `ProgressRecorded`: Blocked, Completed, GoalChanged, Paused, Shaping, Stopped, 거절: `phase_not_executable`, 거절: `steps_incomplete`, 거절: `verification_required`, 그대로
- `RunFinished`: Blocked, Completed, GoalChanged, 그대로
- `PlanClosed`: Closed
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Closed, GoalChanged, 그대로

## `Paused`

- `Navigated`: Paused, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: Paused, 거절: `plan_not_ready`, 거절: `plan_outdated`, 그대로
- `GoalPaused`: 거절: `goal_not_active`
- `GoalResumed`: Blocked, GoalChanged, Running, Shaping
- `GoalStopped`: Stopped
- `GoalEdited`: Blocked, GoalChanged, Shaping
- `PlanEdited`: Paused, 그대로
- `ProgressRecorded`: Blocked, Completed, GoalChanged, Paused, Running, Shaping, Stopped, 거절: `goal_completion_required`, 거절: `phase_not_executable`, 거절: `plan_missing`, 거절: `steps_incomplete`, 거절: `verification_required`, 그대로
- `RunFinished`: Completed, Paused, 그대로
- `PlanClosed`: Closed, 거절: `plan_closed`, 거절: `plan_missing`
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Closed, Paused, 거절: `plan_missing`, 그대로

## `Blocked`

- `Navigated`: Blocked, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: 거절: `plan_not_ready`, 거절: `plan_outdated`
- `GoalPaused`: Paused
- `GoalResumed`: 거절: `goal_not_paused`
- `GoalStopped`: Stopped
- `GoalEdited`: Blocked, 그대로
- `PlanEdited`: Shaping
- `ProgressRecorded`: Blocked, Completed, GoalChanged, Paused, Running, Shaping, Stopped, 거절: `goal_completion_required`, 거절: `goal_not_active`, 거절: `phase_not_executable`, 거절: `steps_incomplete`, 거절: `verification_required`, 그대로
- `RunFinished`: Blocked, Completed, 그대로
- `PlanClosed`: Closed
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Blocked, Closed, 그대로

## `Stopped`

- `Navigated`: Stopped, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: 거절: `goal_terminal`
- `GoalPaused`: 거절: `goal_terminal`
- `GoalResumed`: 거절: `goal_terminal`
- `GoalStopped`: 거절: `goal_terminal`
- `GoalEdited`: Blocked, Closed, GoalChanged, Shaping
- `PlanEdited`: Stopped, 그대로
- `ProgressRecorded`: Stopped, 거절: `goal_terminal`, 거절: `phase_not_executable`, 거절: `plan_missing`, 거절: `steps_incomplete`, 거절: `verification_required`, 그대로
- `RunFinished`: 그대로
- `PlanClosed`: Stopped, 거절: `plan_closed`, 거절: `plan_missing`
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Stopped, 거절: `plan_missing`, 그대로

## `Closed`

- `Navigated`: Closed, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: 거절: `plan_not_ready`, 거절: `plan_outdated`
- `GoalPaused`: Closed, 그대로
- `GoalResumed`: 거절: `goal_not_paused`
- `GoalStopped`: Stopped
- `GoalEdited`: Closed, 그대로
- `PlanEdited`: Paused, Shaping
- `ProgressRecorded`: Blocked, Closed, Completed, GoalChanged, Paused, Running, Shaping, Stopped, 거절: `goal_completion_required`, 거절: `goal_not_active`, 거절: `phase_not_executable`, 거절: `steps_incomplete`, 거절: `verification_required`, 그대로
- `RunFinished`: 그대로
- `PlanClosed`: 거절: `plan_closed`
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Closed, 그대로

## `Completed`

- `Navigated`: Completed, 거절: `goal_terminal`, 그대로
- `ExecutionApproved`: 거절: `goal_terminal`
- `GoalPaused`: 거절: `goal_terminal`
- `GoalResumed`: 거절: `goal_terminal`
- `GoalStopped`: 거절: `goal_terminal`
- `GoalEdited`: Blocked, Closed, GoalChanged, Shaping
- `PlanEdited`: Completed, 그대로
- `ProgressRecorded`: Completed, 거절: `goal_terminal`, 거절: `phase_not_executable`, 거절: `plan_missing`, 거절: `steps_incomplete`, 거절: `verification_required`, 그대로
- `RunFinished`: Completed, 그대로
- `PlanClosed`: Completed, 거절: `plan_closed`, 거절: `plan_missing`
- `NewGoalRequested`: 거절: `phase_not_authorized`, 그대로
- `NewGoalStarted`: Shaping, 거절: `phase_not_authorized`
- `BoardEdited`: Completed, 거절: `plan_missing`, 그대로
