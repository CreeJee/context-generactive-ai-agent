# Plan 040: 보드의 호출을 orchestrator notifications에 둔다

> **Executor instructions**: 이 계획을 단계 순서대로 따른다. 단계마다 Verify 명령을 돌려 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다. 임의로 풀지 않는다.
> `plans/README.md`는 고치지 않는다(검토자가 표를 관리한다).
>
> **이 저장소에서 찾을 때는 언제나 `rg --hidden -g '!.git' -g '!node_modules'`를 쓴다.** route 핸들러 폴더
> `apps/agent/app/.server`는 이름이 점으로 시작해 `rg`가 기본으로 건너뛴다. zsh에서 큰따옴표 안의
> backtick은 명령으로 실행된다. backtick이 든 패턴은 작은따옴표로 감싼다.
>
> **Drift check (먼저 실행)**: 이 계획은 계획 039가 `main`에 들어간 뒤의 코드를 기준으로 한다.
> `rg -n 'taskStatusWrites' packages/memory-agent/src/sessions/orchestrator-notifications.ts`가 줄을 내지
> 않으면 039가 아직 없다. STOP이다. 그다음 "Current state"의 발췌와 실제 코드를 비교한다. 내용이 다르면
> STOP이다. 공백과 줄 번호 차이는 다른 것으로 보지 않는다. `migrations.ts`는 배열 끝에 다른 단계가 더해졌을
> 수 있다. 그때는 이 계획의 단계를 그 뒤에 둔다.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (보드 루프가 planner를 부르는 길, 자동 run을 고르는 코드, 열 하나를 더하는 migration)
- **Depends on**: 039 (하위 작업의 상태 알림을 orchestrator notifications에 둔다). 039가 `chat.ts`의
  `runContext`와 `orchestrator-notifications.ts`를 고친다. 이 계획은 그 위에서 고친다.
- **Category**: bug (보드의 호출이 사라지거나, 앱을 다시 시작하면 같은 호출이 또 간다. 멈춘 보드가
  사용자의 말로 다시 움직이지 않는다), tech-debt (같은 것을 기억하는 메모리 상태 둘을 표 하나로 합친다)
- **Planned at**: commit `dee087bc`, 2026-11-26. `chat.ts`의 `runContext`와 `orchestrator-notifications.ts`,
  `task-notifications.ts`의 발췌는 039의 branch(`t3/task-status-orchestrator-notifications`, `f24b691e`)의
  모습이다. 그 diff와 대조했다.

## Why this matters

칸반 보드의 루프는 카드를 스스로 돌린다. 스스로 정할 수 없는 일(다시 계획하기, 사용자의 변경 요청, 바뀐
Goal, 열린 outcome 등 일곱 가지)이 생기면 그 대화의 모델(planner)을 부른다. 이것이 "보드의 호출"이다.

지금 보드의 호출은 프로세스 메모리 두 곳에만 있다.

- `announced`(`kanban/orchestrator.ts`): Goal마다 마지막으로 알린 상황. 같은 상황이면 다시 부르지 않는다.
- `kanbanAttention`(`agent/chat.ts`): 대화마다 아직 run이 가져가지 않은 호출의 이유.

그래서 세 가지가 깨진다.

1. **호출이 사라진다.** 자동 run은 호출을 `kanbanAttention`에서 먼저 지우고 시작한다
   (`chat.ts`의 `Ref.update(kanbanAttention, …)` 다음 줄이 `send`다). 시작을 거절당하면(provider를 쓸 수 없음
   등) 호출은 돌아오지 않는다. 루프는 그 상황을 이미 알린 것으로 기억하므로 다시 부르지 않는다. 보드는
   상황이 바뀌거나 앱을 다시 시작할 때까지 멈춘다.
2. **다시 시작하면 같은 호출이 또 간다.** `announced`가 비므로 루프는 첫 look에서 지금 상황을 다시 알린다.
   모델이 이미 답한 상황이어도 planner run이 한 번 더 돈다.
3. **다시 시작할 때마다 planner 라운드가 하나 는다.** 알릴 때 라운드를 세기 때문이다
   (`kanban_goals.planner_rounds`). 세 번을 넘으면 보드는 planner를 부르지 않고 사용자를 기다린다
   (`plannerStalled`). 재시작 몇 번이 진척 없는 라운드로 세어진다.

4. **멈춘 보드가 사용자의 말로 다시 움직이지 않는다.** 라운드가 한도를 넘은 보드는 사용자가 대화에 말하면
   다시 세기로 되어 있다(`docs/kanban-orchestration.md`, `KanbanOrchestrator.resumePlanner`). 그런데
   `resumePlanner`를 부르는 곳은 `chat.ts`에 하나뿐이고, 외부 에이전트 대화의 가지(`if (external !== null)`)
   안에 있다. 보드는 외부 에이전트 대화에서 돌지 않는다. 그래서 실제 앱에서는 불리지 않는다. 3번과 겹치면
   재시작 몇 번으로 멈춘 보드가 새 outcome이 met될 때까지 planner를 부르지 않는다.

앱이 모델에게 전하는 다른 알림(끝난 작업, 하위 작업의 상태, 다른 대화가 남긴 메시지)은 표
`orchestrator_notifications`에 있고 규칙 하나를 따른다(사용자, 2026-11-25. `plans/consistency-rules.md` R8).

1. 알림은 대화에 메시지로 한 번 넣는다. 그 메시지는 자기가 전하는 알림의 id를 가진다
   (`StoredUserMessage.toldNotifications`). 대화에 그 id가 있으면 다시 넣지 않는다.
2. run이 끝나 대화를 저장한 뒤에 전한 것으로 적는다. `completed`나 `interrupted`로 끝났으면 그 대화가 전하는
   알림을 모두 적는다. 실패하거나 취소됐으면 그 메시지 뒤에 모델의 답이 있는 것만 적는다.
3. 메시지가 대화에 없으면 다음 run이 다시 넣는다.

사용자는 보드의 호출도 이 규칙을 따른다고 정했다(2026-11-23, R8 "알림 넷은 규칙 하나를 따른다"). 이 계획은
보드의 호출을 그 표로 옮긴다.

- 루프는 호출을 `orchestrator_notifications`에 `board` 보낸 쪽의 행으로 남긴다.
- 루프가 마지막으로 본 상황은 Goal의 행(`kanban_goals.planner_situation`)에 남긴다. 다시 시작해도 같은
  상황을 또 알리지 않고 라운드도 세지 않는다.
- 자동 run은 호출을 지우지 않고 읽는다. 호출을 전하는 메시지가 호출의 id를 가진다. run이 끝나면 위 규칙
  2번대로 전한 것으로 적힌다. 시작하지 못한 run은 아무것도 바꾸지 않으므로 다음에 깨어날 때 다시 시도한다.

메모리 상태 `announced`와 `kanbanAttention`은 없어진다. 4번은 일반 대화의 run이 시작할 때도
`resumePlanner`를 부르게 해서 고친다.

## Current state

경로는 저장소 루트 기준이다. 줄 번호는 `dee087bc`의 것이고 039 뒤에 조금 밀린다.

### 루프가 호출을 만드는 곳: `packages/memory-agent/src/kanban/orchestrator.ts`

이유의 목록(`104-114`)과 planner 라운드로 세는 이유(`120-125`).

```ts
/** Why the orchestrator model is needed on a board. */
export const KanbanAttentionReason = Schema.Literals([
  "goal_changed",
  "replan_requested",
  "change_requested",
  "outcomes_open",
  "file_overlap",
  "goal_unverified",
  "upstream_regressed",
]);
export type KanbanAttentionReason = typeof KanbanAttentionReason.Type;

const plannerRoundReasons: readonly KanbanAttentionReason[] = [
  "replan_requested",
  "outcomes_open",
  "goal_unverified",
  "upstream_regressed",
];

export interface KanbanAttention {
  readonly sessionId: string;
  readonly goalInstanceId: string;
  readonly reasons: readonly KanbanAttentionReason[];
}
```

메모리 상태(`268-269`).

```ts
const attention = yield * PubSub.unbounded<KanbanAttention>();
const announced = yield * Ref.make<Readonly<Record<string, string>>>({});
```

look 하나의 끝부분(`1274-1310`). `goal`은 이 look의 처음에 읽은 `KanbanGoal`이다. `reasons`는 그 위에서
보드의 저장된 상태로 계산한 것이다.

```ts
// A paused Goal wakes no planner; the model hears about the board once it resumes.
const reasons = paused ? [] : KanbanAttentionReason.literals.filter((reason) => raised[reason]);
const met = Arr.countBy(standings, (standing) => OutcomeStatus.guards.Met(standing.status));
// A newly met outcome is progress: the planner rounds count again from zero.
const counted = met > goal.planner.met ? { rounds: 0, met } : goal.planner;

// The model hears about a situation once; a later look finding the same one stays quiet.
const situation = [
  reasons.join(","),
  goal.hold?.toVersion ?? "",
  replanning.join(","),
  requests,
  notices.join(","),
].join("|");
const previous =
  yield *
  Ref.getAndUpdate(announced, (known) => ({
    ...known,
    [goalInstanceId]: situation,
  }));
const announcing = reasons.length > 0 && previous[goalInstanceId] !== situation;
const round = announcing && reasons.some((reason) => plannerRoundReasons.includes(reason));
const planner = round ? { rounds: counted.rounds + 1, met } : counted;
yield *
  Effect.when(
    attempts.setPlannerRounds(goalInstanceId, planner),
    Effect.succeed(planner.rounds !== goal.planner.rounds || planner.met !== goal.planner.met),
  );
// Past the limit the loop's own reasons wait for the user; theirs still wake the planner.
const told = plannerStalled(planner)
  ? reasons.filter((reason) => !plannerRoundReasons.includes(reason))
  : reasons;
if (announcing && told.length > 0)
  yield *
    PubSub.publish(attention, {
      sessionId: goal.sessionId,
      goalInstanceId,
      reasons: told,
    });
```

`resumePlanner`(`1485-1503`)는 사용자가 말하면 라운드를 0으로 돌리고 `announced`에서 그 Goal을 지운다.
다음 look이 지금 상황을 다시 알린다.

```ts
const reset =
  yield *
  looking.withPermits(1)(
    Effect.gen(function* () {
      const found = yield* attempts.goal(goalInstanceId);
      if (Option.isNone(found) || !found.value.active || found.value.planner.rounds === 0)
        return false;
      yield* attempts.setPlannerRounds(goalInstanceId, { ...found.value.planner, rounds: 0 });
      yield* Ref.update(announced, (known) => Struct.omit(known, [goalInstanceId]));
      return true;
    }),
  );
```

`resumePlanner`를 부르는 곳은 `chat.ts:1609` 하나다. `if (external !== null) {`(`1519`) 블록 안이다.

```ts
yield * Effect.when(workTrace.resumeParentNotifications(sessionId), Effect.succeed(turn !== null));
// The user's word is the direction a stalled board's planner waited for.
yield * Effect.when(kanbanOrchestrator.resumePlanner(sessionId), Effect.succeed(turn !== null));
```

일반 대화의 run은 `runStarted`(`1741-`)를 거친다. 거기에는 앞의 것만 있다.

```ts
const runStarted = Effect.gen(function* () {
  yield* Effect.when(
    execution.start(sessionId, runId, workflow, turn !== null),
    Effect.succeed(!notificationFollowup && kanbanFollowup === null),
  );
  yield* Effect.when(
    workTrace.resumeParentNotifications(sessionId),
    Effect.succeed(turn !== null),
  );
  yield* events.publishSession(sessionId, "run-state");
```

서비스는 `attention: Stream.fromPubSub(attention)`(`1559`)을 내보낸다. `Ref.`와 `Struct.`를 쓰는 곳은 이
파일에서 위 세 줄뿐이다.

### Goal의 행: `packages/memory-agent/src/kanban/card-attempts.ts`

```ts
export interface PlannerRounds {
  readonly rounds: number;
  readonly met: number;
}
```

`GoalRow`(`140-155`)에 `planner_rounds: Schema.Int`, `planner_met: Schema.Int`가 있고, `toGoal`(`195-206`)이
`planner: { rounds: row.planner_rounds, met: row.planner_met }`로 옮긴다. 행은 `SELECT k.*, …`로 읽으므로
(`260-262`) 열을 더하면 읽기 SQL은 고칠 것이 없다.

```ts
/** Records the planner rounds counted since the board's last newly met outcome. */
setPlannerRounds: (goalInstanceId: string, planner: PlannerRounds) =>
  Effect.flatMap(now, (at) =>
    sql`UPDATE kanban_goals SET planner_rounds = ${planner.rounds},
        planner_met = ${planner.met}, updated_at = ${at}
        WHERE goal_instance_id = ${goalInstanceId}`.pipe(Effect.mapError(failed("goal"))),
  ),
```

`make`는 `const sql = yield* SqlClient.SqlClient;`와 `const now = Clock.currentTimeMillis;`로 시작한다
(`235-237`). `failed(operation)`은 `SqlError | SchemaError`를 `KanbanStorageFailed`로 바꾼다. layer는
`static readonly layer = Layer.effect(CardAttempts, make);`(`613`)다. `setPlannerRounds`를 부르는 곳은
`orchestrator.ts`의 두 줄뿐이다.

### 알림 표와 서비스: `packages/memory-agent/src/sessions/orchestrator-notifications.ts` (039 뒤)

표는 `id, session_id, sender, delivery, payload(JSON), state('waiting'|'delivered'), delivered_run_id,
created_at(ISO), delivered_at(ISO)`다. `session_id`는 `sessions(id)`를 가리키고 대화를 지우면 행도 지워진다.

```ts
export const NotificationSender = Schema.Literals(["task", "conversation", "board"]);

export const notificationPayloads = {
  conversation: ConversationMessage,
  task: Schema.Union([BackgroundTaskEnd, TaskStatusChange]),
} as const;
type StoredSender = keyof typeof notificationPayloads;

const NotificationRow = Schema.Union([rowOf("conversation"), rowOf("task")]);
```

039가 `make` 밖에 둔 것: `isoNow`, `insertOnceWith(sql)`(id가 이미 있으면 넣지 않는 `INSERT … ON CONFLICT(id)
DO NOTHING`), `taskStatusWrites(sql)`. `taskStatusWrites`는 서비스를 거치지 않고 부르는 쪽의 `SqlClient`로
쓰는 쓰기 묶음이다. Work Trace 저장소가 자기 transaction 안에서 알림을 넣으려고 쓴다. 이 계획은 같은 모양의
`boardCallWrites(sql)`을 더한다.

깨우는 행을 찾는 SQL(`wakingRow`). 지금은 보낸 쪽을 가리지 않는다.

```ts
SELECT 1 AS waking FROM orchestrator_notifications n
WHERE n.session_id = ${sessionId} AND n.state = 'waiting'
  AND n.delivery = 'wake'
  AND NOT EXISTS (
    SELECT 1 FROM parent_notification_holds h WHERE h.session_id = n.session_id
  )
LIMIT 1
```

서비스의 메서드 가운데 이 계획이 쓰는 것.

- `untold(sessionId, sender, told: HashSet<string>)`: 그 보낸 쪽의 기다리는 행 가운데 id가 `told`에 없는 것.
  아무것도 쓰지 않는다. 사용자가 멈춘 대화(`parent_notification_holds`)에는 빈 배열을 준다.
- `heard(sessionId, runId, delivered: HashSet<string>)`: 기다리는 행 가운데 id가 `delivered`에 있는 것을
  전한 것으로 적는다. 보낸 쪽을 가리지 않는다.
- `wakes(sessionId)`: 위 `wakingRow`가 행을 주는지.

`heard`는 `agent/task-notifications.ts`의 `ended` hook이 run이 끝날 때마다 부른다
(`notifications.heard(sessionId, runId, heardBy(end, conversation))`). 보낸 쪽을 가리지 않으므로 보드의
호출도 이 hook이 전한 것으로 적는다. 새 hook은 필요 없다.

### 자동 run을 고르는 곳: `packages/memory-agent/src/agent/chat.ts`

import(`43-44`).

```ts
import { KanbanOrchestrator, type KanbanAttentionReason } from "../kanban/orchestrator.ts";
import { KanbanTools, kanbanAttentionPrompt, kanbanInstructions } from "../kanban/tools.ts";
```

자동 run의 종류(`378-396`).

```ts
type InternalFollowup = Data.TaggedEnum<{
  notification: {};
  /** The next turn is the message at the head of the queue, sent with no page needed. */
  queued: {};
  /** The kanban loop needs the model's judgement on the board. */
  kanban: { readonly reasons: readonly KanbanAttentionReason[] };
}>;

type AutomaticRun = Data.TaggedEnum<{
  board: { readonly reasons: readonly KanbanAttentionReason[] };
  notifications: {};
}>;
```

보드인지 묻는 함수(`616-624`)와 서비스 변수(`584`).

```ts
const orchestratorNotifications = yield * OrchestratorNotifications;

const kanbanBoard = (sessionId: string) =>
  Effect.flatMap(workflows.goalInstanceId(sessionId), (goalInstanceId) =>
    goalInstanceId === null
      ? Effect.succeed(false)
      : Effect.map(
          kanbanAttempts.goal(goalInstanceId),
          Option.exists((goal) => goal.active),
        ),
  );
```

메모리 상태(`731-746`).

```ts
// What each board's loop last asked the model about, until a follow-up run takes it.
const kanbanAttention =
  yield * Ref.make<Readonly<Record<string, readonly KanbanAttentionReason[]>>>({});
yield *
  kanbanOrchestrator.attention.pipe(
    Stream.runForEach((needed) =>
      Effect.andThen(
        Ref.update(kanbanAttention, (pending) => ({
          ...pending,
          [needed.sessionId]: needed.reasons,
        })),
        wakeNotifications(needed.sessionId),
      ),
    ),
    Effect.forkScoped,
  );
```

`start`는 `const kanbanFollowup = InternalFollowup.$is("kanban")(internalFollowup) ? internalFollowup : null`
모양으로 자동 run의 종류를 받는다(`1301-1302`). `runContext`가 그 이유로 메시지를 만든다(039 뒤의 모습).

```ts
const followup = [
  ...(kanbanFollowup !== null ? [kanbanAttentionPrompt(kanbanFollowup.reasons)] : []),
  ...(notificationFollowup ? ["This is an automatic task completion follow-up, …"] : []),
];
const parentNotifications =
  yield *
  EffectArray.match(followup, {
    onEmpty: () => Effect.succeed(noTaskNotifications),
    onNonEmpty: () =>
      Effect.flatMap(runStore.thread(sessionId), (stored) =>
        notifications.consume(sessionId, stored),
      ),
  });
// …
const orchestrator =
  yield *
  EffectArray.match(followup, {
    onEmpty: () => Effect.succeed(null),
    onNonEmpty: (texts) =>
      Effect.map(
        Effect.flatMap(
          crypto.uuidV7(),
          orchestratorMessage(
            {
              next: kanbanFollowup !== null ? "board" : "results",
              ended: endedTasks(parentNotifications),
            },
            [...texts, ...(toldLines.length === 0 ? [] : [toldLines.join("\n")])],
          ),
        ),
        telling(toldIds(parentNotifications)),
      ),
  });
```

`telling(ids)`(`agent/orchestrator-message.ts`)는 메시지에 `toldNotifications`를 붙인다. `toldIn(conversation)`
은 대화의 메시지들이 전하는 id의 집합(`told`)을 준다.

자동 run을 고르는 곳(`2913-2931`). `followup(sessionId)` 안이라 `sessionId`가 보인다.

```ts
const nextAutomatic = Effect.gen(function* () {
  // The board's loop executes the Plan, so the planner runs only when the loop needs it, and
  // not past a message waiting in the queue or an approval waiting for the user.
  const reasons = (yield* kanbanBoard(sessionId))
    ? (yield* Ref.get(kanbanAttention))[sessionId]
    : undefined;
  if (
    reasons !== undefined &&
    NextDelivery.$is("empty")((yield* queue.snapshot(sessionId)).nextDelivery) &&
    (yield* relayed.pending(sessionId)).length === 0
  )
    return Option.some(AutomaticRun.board({ reasons }));
  if (
    (yield* notifications.wakes(sessionId)) &&
    (yield* runStore.pendingInterrupts(sessionId)).length === 0
  )
    return Option.some(AutomaticRun.notifications());
  return Option.none<AutomaticRun>();
});
```

보드 run을 시작하는 곳(`2999-3014`).

```ts
board: ({ reasons }) =>
  Effect.gen(function* () {
    yield* Ref.update(kanbanAttention, ({ [sessionId]: _taken, ...rest }) => rest);
    const started = yield* send(followupRunId, InternalFollowup.kanban({ reasons }));
    yield* drain(started);
    // The planner had its turn: a card it left waiting for a replan waits for the user.
    yield* Effect.when(
      kanbanOrchestrator
        .replanUnanswered(sessionId)
        .pipe(Effect.catch(logFailure("Unanswered replan not shown", { sessionId }))),
      Effect.succeed(Result.isSuccess(started) && reasons.includes("replan_requested")),
    );
  }),
```

이 가지 위에서 `automatic`은 사용자가 멈춘 대화(`workTrace.parentNotificationsHeld(sessionId)`)와 마지막
run이 `completed`가 아닌 대화에는 자동 run을 시작하지 않는다(`2954-2963`, `2996`). 이 계획은 그 조건을
바꾸지 않는다.

시작할 때 깨우는 곳(`3094-3095`).

```ts
// Only a persisted clean finish is eligible. Interrupted or failed runs are never replayed.
yield * Effect.forEach(yield * execution.readySessions(), wakeNotifications, { discard: true });
```

같은 파일의 `3064-3067`이 실패한 읽기를 기록하고 빈 배열로 넘기는 예다.

```ts
yield* goalExecutions.unsettled.pipe(
  Effect.catch((error) =>
    Effect.as(logFailure("Unsettled Goal executions unavailable")(error), []),
  ),
),
```

### 호출의 말: `packages/memory-agent/src/kanban/tools.ts`

`34`줄이 `import type { KanbanAttentionReason } from "./orchestrator.ts";`다. `kanbanAttentionPrompt(reasons)`
(`350-354`)가 이유마다 한 줄을 쓴다. 이 함수는 고치지 않는다.

### 이미 정해진 것 (`docs/decisions.md`)

- "follow-up은 기다리는 이유를 모아(`AutomaticRun`: `board` | `notifications`) 하나를 고른다. 보드 attention이
  먼저다. … 두 이유는 받는 쪽이 달라 한 run으로 합치지 않는다." 이 계획은 이것을 그대로 둔다. 보드의 호출은
  보드 run이 시작할 때만 전한다. 사용자가 시작한 run이나 알림 run에는 싣지 않는다.
- 보드의 호출은 대화에 아무것도 돌지 않으면 run을 시작한다(전달 값 `wake`).

### 지킬 규칙 (`AGENTS.md`, `CLAUDE.md`에서)

- `let`, `while`을 쓰지 않는다. Effect, Array, Stream의 combinator를 쓴다.
- lint를 끄는 주석을 쓰지 않는다. `unknown` 타입을 쓰지 않는다.
- 줄바꿈만 바꾸는 편집을 하지 않는다. formatter(commit hook의 `vp check --fix`)가 맡는다.
- id는 `effect/crypto`의 `SecureRandom.uuidV7()`로 만든다.
- 이름, 주석, 문서는 평이한 낱말로 쓴다. 새 용어를 지어내지 않는다.
- commit 메시지는 한국어 conventional commit이다. commit마다 typecheck가 통과해야 한다.

## Commands you will need

| 목적              | 명령                                                                 | 기대      |
| ----------------- | -------------------------------------------------------------------- | --------- |
| 새 worktree 준비  | 루트에서 `vp install`, 그다음 `vp run turbovec#build`                | exit 0    |
| 서버 typecheck    | `vp run memory-agent#typecheck`                                      | 오류 없음 |
| 앱 typecheck      | `vp run agent#typecheck`                                             | 오류 없음 |
| lint (루트에서만) | `vp lint` (`agent#typecheck` 뒤에 돌린다)                            | exit 0    |
| 고른 테스트       | `cd packages/memory-agent && vp test run --maxWorkers=4 <아래 목록>` | 전부 통과 |
| kanban 흐름만     | `cd packages/memory-agent && vp test run --maxWorkers=4 src/kanban`  | 전부 통과 |

고른 테스트: `tests/sessions tests/agent src/kanban tests/kanban-tools.test.ts tests/kanban-skills.test.ts
tests/workflow migration tests/db-migrator-metadata.test.ts tests/database.test.ts tests/upgrade-0.0.17.test.ts`.
`migration`은 경로에 그 낱말이 든 테스트 파일 전부다. 전체 suite는 돌리지 않는다. `src/kanban`의 테스트는 진짜
git 저장소를 쓴다. 부하 때문에 `Hook timed out in 10000ms`가 나면 그 파일만 다시 돌린다.

## Scope

**In scope** (이 파일들만 고친다)

- `packages/memory-agent/src/kanban/attention.ts` (새 파일)
- `packages/memory-agent/src/kanban/orchestrator.ts`
- `packages/memory-agent/src/kanban/card-attempts.ts`
- `packages/memory-agent/src/kanban/tools.ts` (import 한 줄)
- `packages/memory-agent/src/sessions/orchestrator-notifications.ts`
- `packages/memory-agent/src/agent/chat.ts`
- `packages/memory-agent/src/db/migrations.ts`
- `packages/memory-agent/src/kanban/kanban-flow.test.ts`
- `packages/memory-agent/tests/sessions/orchestrator-notifications.test.ts`
- `packages/memory-agent/tests/agent/board-call-delivery.test.ts` (새 파일)
- `packages/memory-agent/tests/kanban-goal-owners-migration.test.ts` (행의 모양을 보는 단언에 새 열)
- typecheck나 고른 테스트가 새 열, 새 payload 때문에 깨뜨리는 다른 테스트 (깨진 단언만 고친다)
- `docs/decisions.md`(끝에 항목 하나), `docs/kanban-orchestration.md`(`planner_rounds`를 설명하는 한 항목),
  `packages/memory-agent/src/kanban/README.md`, `packages/memory-agent/src/sessions/README.md`,
  `packages/memory-agent/src/agent/README.md`

**Out of scope** (건드리지 않는다)

- `kanbanAttentionPrompt`의 문장, 이유의 목록, 이유를 계산하는 `raised`.
- 자동 run의 조건(`automatic`의 멈춘 대화, `completed`가 아닌 마지막 run, 큐와 승인 대기).
- 보드의 호출을 사용자가 시작한 run이나 run 도중에 전하는 것.
- `parent_notification_holds`와 그것을 쓰는 코드.
- 알림을 보여 주는 화면. `apps/agent` 아래는 고치지 않는다.
- `packages/turbovec/**`, `packages/memory-agent/src/memory/native-search/**`, `plans/**`.

## Git workflow

지금 checkout의 branch에서 일한다. commit은 넷이다. commit마다 두 typecheck가 통과해야 한다.

1. Step 1: `feat(sessions): 알림 표가 보드의 호출을 담게 한다`
2. Step 2~4: `fix(kanban): 보드의 호출을 orchestrator notifications에 두고 재시작 뒤에 다시 알리지 않는다`
3. Step 5: `fix(agent): 사용자가 말하면 멈춘 보드의 planner를 다시 부른다`
4. Step 6: `docs: 보드의 호출을 orchestrator notifications에 둔 결정을 적는다`

메시지는 한국어 conventional commit이다. 끝에 이 줄을 붙인다.

```
Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

commit hook이 `vp check --fix`를 돌려 파일을 다시 정리할 수 있다. 그 결과는 그대로 둔다. push, merge, PR은
하지 않는다.

## Steps

### Step 1: 알림 표가 보드의 호출을 담게 한다

동작은 아직 바뀌지 않는다.

**1-1. 새 파일 `packages/memory-agent/src/kanban/attention.ts`**

`KanbanAttentionReason`의 정의를 `orchestrator.ts`에서 이 파일로 옮긴다. 알림 저장소가 이 타입을 읽어야
하는데, `orchestrator.ts`에서 읽으면 import가 돈다(`orchestrator.ts` → `card-attempts.ts` → 알림 저장소).

```ts
import { Schema } from "effect";

/** Why the orchestrator model is needed on a board. */
export const KanbanAttentionReason = Schema.Literals([
  "goal_changed",
  "replan_requested",
  "change_requested",
  "outcomes_open",
  "file_overlap",
  "goal_unverified",
  "upstream_regressed",
]);
export type KanbanAttentionReason = typeof KanbanAttentionReason.Type;

/**
 * The board's call: the reasons a Goal's loop needs its conversation's model for. The
 * orchestrator's notifications keep it until the model answers the message that tells it.
 */
export const BoardCall = Schema.TaggedStruct("BoardCall", {
  goalInstanceId: Schema.String,
  reasons: Schema.Array(KanbanAttentionReason),
});
export type BoardCall = typeof BoardCall.Type;

/** The reasons of several calls, each once, in the order the reasons are listed. */
export const reasonsOf = (
  calls: ReadonlyArray<{ readonly reasons: ReadonlyArray<KanbanAttentionReason> }>,
) =>
  KanbanAttentionReason.literals.filter((reason) =>
    calls.some((call) => call.reasons.includes(reason)),
  );
```

- `orchestrator.ts`: 정의(`104-114`)를 지우고 `import { KanbanAttentionReason } from "./attention.ts";`를
  더한다. 주석 `/** Why the orchestrator model is needed on a board. */`도 함께 옮겨졌으므로 지운다.
- `tools.ts:34`: `from "./orchestrator.ts"`를 `from "./attention.ts"`로 바꾼다.
- `chat.ts:43`: `KanbanOrchestrator`만 `../kanban/orchestrator.ts`에서 가져오고,
  `import { reasonsOf, type KanbanAttentionReason } from "../kanban/attention.ts";`를 더한다. `reasonsOf`는
  Step 4에서 쓴다. Step 1에서 lint가 안 쓰는 import를 막으면 `reasonsOf`는 Step 4에서 더한다.
- `rg -n 'KanbanAttentionReason' packages apps --hidden -g '!node_modules' -g '!*.md'`로 다른 import가
  있는지 본다. 있으면 같은 방식으로 고친다.

**1-2. `packages/memory-agent/src/sessions/orchestrator-notifications.ts`**

(a) `import { BoardCall } from "../kanban/attention.ts";`를 더한다.

(b) payload와 행의 union에 `board`를 더한다. `notificationPayloads`의 주석 끝에 한 문장을 더한다:
`` `board` carries the call of a Goal's board. ``

```ts
export const notificationPayloads = {
  conversation: ConversationMessage,
  task: Schema.Union([BackgroundTaskEnd, TaskStatusChange]),
  board: BoardCall,
} as const;

const NotificationRow = Schema.Union([rowOf("conversation"), rowOf("task"), rowOf("board")]);
```

(c) `wakingRow`의 SQL에 조건 한 줄을 더하고 주석을 바꾼다.

```ts
/**
 * A waiting row that wakes its conversation, unless the user stopped its notifications. The
 * board's call is not counted: the gate that starts its run reads it by itself
 * (`nextAutomatic`, agent/chat.ts), so a call that cannot be taken yet starts no other run.
 */
```

```sql
      WHERE n.session_id = ${sessionId} AND n.state = 'waiting'
        AND n.delivery = 'wake' AND n.sender <> 'board'
```

서비스의 `wakes` 주석에서 `whoever sent it`을 `sent by a task or a conversation`으로 바꾼다.

이 조건이 없으면 이렇게 된다. 보드 run은 큐에 메시지가 있거나 승인이 기다리면 시작하지 않는다. 그때
`wakes`가 보드의 호출 때문에 참이면 알림 run이 시작한다. 알림 run은 보드의 호출을 전하지 않으므로 끝나도
`wakes`는 참이고, 또 알림 run이 시작한다.

(d) `taskStatusWrites` 아래에 더한다.

```ts
/**
 * The writes the kanban board makes for its calls, with its own connection, so a Goal's planner
 * state and its call are stored in one transaction. They fail as the connection fails.
 */
export const boardCallWrites = (sql: SqlClient.SqlClient) => {
  const insertOnce = insertOnceWith(sql);
  const dropWaiting = SqlSchema.void({
    Request: Schema.Struct({ sessionId: Schema.String, goalInstanceId: Schema.String }),
    execute: ({ sessionId, goalInstanceId }) => sql`
      DELETE FROM orchestrator_notifications
      WHERE session_id = ${sessionId} AND sender = 'board' AND state = 'waiting'
        AND json_extract(payload, '$.goalInstanceId') = ${goalInstanceId}`,
  });
  return {
    /**
     * Makes `call` the one call of its Goal's board that waits. The Goal's calls that still wait
     * told an earlier situation and are dropped; `call` waits under `id` when it has reasons. A
     * call the model answered stays as it is.
     */
    replace: (entry: {
      readonly id: string;
      readonly sessionId: string;
      readonly call: BoardCall;
    }) =>
      Effect.andThen(
        dropWaiting({ sessionId: entry.sessionId, goalInstanceId: entry.call.goalInstanceId }),
        Effect.when(
          Effect.flatMap(isoNow, (now) =>
            insertOnce({
              id: entry.id,
              session_id: entry.sessionId,
              sender: "board",
              delivery: "wake",
              payload: entry.call,
              state: "waiting",
              delivered_run_id: null,
              created_at: now,
              delivered_at: null,
            }),
          ),
          Effect.succeed(entry.call.reasons.length > 0),
        ),
      ),
  };
};
```

(e) `make` 안에 읽기 하나를 더하고 서비스에 메서드를 더한다.

```ts
/** The conversations a waiting row of the sender is in. */
const waitingSessionRows = SqlSchema.findAll({
  Request: NotificationSender,
  Result: Schema.Struct({ session_id: Schema.String }),
  execute: (sender) => sql`
      SELECT DISTINCT session_id FROM orchestrator_notifications
      WHERE sender = ${sender} AND state = 'waiting'
      ORDER BY session_id`,
});
```

```ts
    /** The conversations that have a waiting row of `sender`. */
    waitingSessions: (sender: NotificationSender) =>
      Effect.map(waitingSessionRows(sender), (rows) => rows.map((row) => row.session_id)).pipe(
        stored,
      ),
```

(f) `NotificationEntry`의 union이 `board`를 갖게 되어 typecheck가 깨지는 곳이 있으면(보낸 쪽마다 가르는
코드) `board`의 가지를 더한다. 가지가 할 일이 없으면 다른 보낸 쪽의 "해당 없음" 가지와 같게 둔다.

**1-3. 테스트: `packages/memory-agent/tests/sessions/orchestrator-notifications.test.ts`**

이 파일의 기존 테스트(039가 더한 `taskStatusWrites` 테스트 포함)가 서비스와 `SqlClient`를 쓰는 방식을 그대로
따라 셋을 더한다.

- "boardCallWrites keeps one waiting call for a Goal": `boardCallWrites(sql)`로 `replace`를 부른다.
  1. Goal `g-1`에 `reasons: ["outcomes_open"]`, id `c-1`. `untold(sessionId, "board", HashSet.empty())`가 그
     payload 하나를 준다.
  2. `deliver(sessionId, "run-1", ["c-1"])`로 전한 것으로 적은 뒤 `g-1`에 `["replan_requested"]`, id `c-2`.
     기다리는 것은 `c-2` 하나이고 `c-1`의 행은 `delivered`로 남아 있다.
  3. `g-1`에 `["file_overlap"]`, id `c-3`. 기다리는 것은 `c-3` 하나다(`c-2`는 지워졌다).
  4. 다른 Goal `g-2`의 기다리는 호출 `c-4`를 넣고 `g-1`에 `reasons: []`, id `c-5`. `g-1`의 기다리는 호출은
     없고 `c-5` 행도 없다. `c-4`는 그대로다.
- "wakes does not count the board's call": `board`의 기다리는 호출만 있는 대화에서 `wakes(sessionId)`가
  `false`다. `delivery: "wake"`인 `task` 행을 하나 넣으면 `true`다.
- "waitingSessions lists the conversations a sender's rows wait in": 두 대화에 `board` 호출을 넣고 하나를
  전한 것으로 적는다. `waitingSessions("board")`가 남은 대화 하나만 준다.

**Verify**:

```
vp run memory-agent#typecheck        # 오류 없음
vp run agent#typecheck               # 오류 없음
vp lint                              # exit 0
cd packages/memory-agent && vp test run --maxWorkers=4 tests/sessions tests/kanban-tools.test.ts
```

통과하면 commit 1을 만든다.

### Step 2: 루프가 본 상황을 Goal의 행에 남기는 migration

`packages/memory-agent/src/db/migrations.ts`에서 039의 `taskStatusNotificationsMigration` 정의 바로 뒤에 둔다.

```ts
/**
 * The situation a board's loop last looked at stays with its Goal, so a restarted owner does not
 * call the planner for it again (decisions.md "보드의 호출을 orchestrator notifications에 둔다
 * (2026-11-26)"). NULL until the loop's next look.
 */
export const plannerSituationMigration = `
  ALTER TABLE kanban_goals ADD COLUMN planner_situation TEXT;
`;
```

`migrations` 배열의 끝(`taskStatusNotificationsMigration,` 다음)에 `plannerSituationMigration,`을 더한다.

단계 수나 마지막 버전을 세는 테스트(`tests/db-migrator-metadata.test.ts` 등)가 깨지면 그 수를 하나 올린다.
`tests/kanban-goal-owners-migration.test.ts:50` 근처는 `kanban_goals` 행 전체를 비교한다. 끝까지 migrate한
행을 보는 단언이면 `planner_situation: null`을 더한다.

### Step 3: Goal의 행과 루프

**3-1. `packages/memory-agent/src/kanban/card-attempts.ts`**

(a) import를 더한다. `effect`의 import 목록에 `Option`이 없으면 더한다.

```ts
import { SecureRandom } from "effect/crypto";
import { NodeCrypto } from "@effect/platform-node";
import { boardCallWrites } from "../sessions/orchestrator-notifications.ts";
import type { KanbanAttentionReason } from "./attention.ts";
```

(b) `PlannerRounds`에 필드를 더하고 주석을 바꾼다.

```ts
/**
 * Where a board's planner stands. `rounds` is how many times in a row the board woke it for work
 * (an open outcome, a replan, a failed Goal check, a regression) while no new outcome was met, and
 * `met` how many were met then. `situation` is what the loop last looked at, or null before its
 * first look and after the user spoke: the loop calls the planner once per situation.
 */
export interface PlannerRounds {
  readonly rounds: number;
  readonly met: number;
  readonly situation: string | null;
}
```

(c) `GoalRow`에 `planner_situation: Schema.NullOr(Schema.String),`을 `planner_met` 아래에 더한다. `toGoal`은
`planner: { rounds: row.planner_rounds, met: row.planner_met, situation: row.planner_situation },`로 한다.

(d) `make`의 처음에 둘을 더한다.

```ts
const crypto = yield * SecureRandom.SecureRandom;
const boardCalls = boardCallWrites(sql);
```

(e) `setPlannerRounds`를 지우고 그 자리에 둔다.

```ts
    /**
     * Records where the Goal's planner stands. `call` is given when the situation the loop looked
     * at changed: the board's calls of the Goal that still wait are dropped, and the reasons in
     * `call`, when there are any, wait as the new call. Both are stored together.
     */
    recordPlanner: (
      goal: Pick<KanbanGoal, "goalInstanceId" | "sessionId">,
      planner: PlannerRounds,
      call: Option.Option<ReadonlyArray<KanbanAttentionReason>>,
    ) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* sql`UPDATE kanban_goals SET planner_rounds = ${planner.rounds},
            planner_met = ${planner.met}, planner_situation = ${planner.situation},
            updated_at = ${at}
            WHERE goal_instance_id = ${goal.goalInstanceId}`;
        yield* Option.match(call, {
          onNone: () => Effect.void,
          onSome: (reasons) =>
            Effect.flatMap(crypto.uuidV7(), (id) =>
              boardCalls.replace({
                id,
                sessionId: goal.sessionId,
                call: { _tag: "BoardCall", goalInstanceId: goal.goalInstanceId, reasons },
              }),
            ),
        });
      }).pipe(sql.withTransaction, Effect.mapError(failed("goal"))),
```

(f) layer를 `Layer.effect(CardAttempts, make).pipe(Layer.provide(NodeCrypto.layer));`로 바꾼다.
`sessions/orchestrator-notifications.ts`의 `OrchestratorNotifications.layer`가 같은 방식이다.

**3-2. `packages/memory-agent/src/kanban/orchestrator.ts`**

(a) `const announced = yield* Ref.make<…>({});` 줄(`269`)을 지운다.

(b) look의 끝부분을 이렇게 바꾼다. 바꾸는 범위는 `const met = …` 줄(`1278`)부터
`PubSub.publish(attention, { … });`(`1310`)까지다. 그 위의 `const reasons = …`는 그대로 둔다. `counted`와
`round`의 식은 그대로 둔다. `counted`가 `goal.planner`를 그대로 쓰면 `situation`이 따라오므로 필드를 골라
적는다.

```ts
const met = Arr.countBy(standings, (standing) => OutcomeStatus.guards.Met(standing.status));
// A newly met outcome is progress: the planner rounds count again from zero.
const counted =
  met > goal.planner.met
    ? { rounds: 0, met }
    : { rounds: goal.planner.rounds, met: goal.planner.met };

// The model hears about a situation once; a later look finding the same one stays quiet.
// The Goal's row keeps the situation, so a restarted owner stays quiet about it too.
const situation = [
  reasons.join(","),
  goal.hold?.toVersion ?? "",
  replanning.join(","),
  requests,
  notices.join(","),
].join("|");
const changed = goal.planner.situation !== situation;
const announcing = reasons.length > 0 && changed;
const round = announcing && reasons.some((reason) => plannerRoundReasons.includes(reason));
const planner = {
  ...(round ? { rounds: counted.rounds + 1, met } : counted),
  situation,
};
// Past the limit the loop's own reasons wait for the user; theirs still wake the planner.
const told = plannerStalled(planner)
  ? reasons.filter((reason) => !plannerRoundReasons.includes(reason))
  : reasons;
// A changed situation replaces the call that waits for the model with what the board needs
// now; with nothing to tell, no call waits.
yield *
  Effect.when(
    attempts.recordPlanner(goal, planner, changed ? Option.some(told) : Option.none()),
    Effect.succeed(
      changed || planner.rounds !== goal.planner.rounds || planner.met !== goal.planner.met,
    ),
  );
// The call is stored: the conversation is woken to take it up.
if (announcing && told.length > 0)
  yield *
    PubSub.publish(attention, {
      sessionId: goal.sessionId,
      goalInstanceId,
      reasons: told,
    });
```

그 아래의 `events.publishSession(…)`(`plannerStalled`가 바뀌었을 때)는 그대로 둔다.

(c) `resumePlanner` 안의 두 줄을 한 줄로 바꾼다.

```ts
yield *
  attempts.recordPlanner(
    found.value,
    { ...found.value.planner, rounds: 0, situation: null },
    Option.none(),
  );
```

그 위 주석("Between looks: …")은 그대로 맞다.

(d) `effect` import에서 `Ref`와 `Struct`가 더 쓰이지 않으면 지운다
(`rg -n 'Ref\.|Struct\.' packages/memory-agent/src/kanban/orchestrator.ts`로 확인한다).

(e) `KanbanAttention` interface 위에 주석을 더한다.

```ts
/**
 * What the loop publishes after it stored a call for the model: whose conversation to wake. The
 * call itself waits in the orchestrator's notifications (sender `board`).
 */
```

파일 머리 주석(`93-102`)의 `are raised as attention for the orchestrator model`은 그대로 둔다.

**Verify (Step 2~3 뒤)**: `vp run memory-agent#typecheck`. `src/kanban` 아래의 오류가 없어야 한다.
`chat.ts`의 오류는 Step 4에서 고친다.

### Step 4: 자동 run이 호출을 표에서 읽는다 (`packages/memory-agent/src/agent/chat.ts`)

(a) import. `./orchestrator-message.ts`의 import 목록에 `toldIn`을 더한다. `../kanban/attention.ts`의
import에 `reasonsOf`가 없으면 더한다.

(b) 자동 run의 종류가 이유 대신 호출을 든다. `InternalFollowup` 위에 타입을 더한다.

```ts
/** A board's call a run tells its model: the notification's id and the reasons it carries. */
interface WaitingBoardCall {
  readonly id: string;
  readonly reasons: readonly KanbanAttentionReason[];
}
```

`InternalFollowup`의 `kanban`과 `AutomaticRun`의 `board`를 둘 다
`{ readonly calls: ReadonlyArray<WaitingBoardCall> }`로 바꾼다. 주석은 그대로 둔다.

(c) 메모리 상태를 없앤다. `731-746`을 이렇게 바꾼다.

```ts
// The board's loop stored a call for the model: its conversation is woken to take it up.
yield *
  kanbanOrchestrator.attention.pipe(
    Stream.runForEach((needed) => wakeNotifications(needed.sessionId)),
    Effect.forkScoped,
  );
```

(d) `runContext`. `kanbanAttentionPrompt(kanbanFollowup.reasons)`를
`kanbanAttentionPrompt(reasonsOf(kanbanFollowup.calls))`로 바꾼다. `telling(toldIds(parentNotifications))`를
이렇게 바꾼다.

```ts
                telling([
                  ...(kanbanFollowup !== null ? kanbanFollowup.calls.map((call) => call.id) : []),
                  ...toldIds(parentNotifications),
                ]),
```

`// Why an automatic run started; …` 주석 끝에 한 문장을 더한다:
`The message carries the ids of the board's calls it tells, as it does the notifications'.`

(e) `followup(sessionId)` 안, `nextAutomatic` 바로 위에 더한다.

```ts
/**
 * The calls of the board this conversation runs that its conversation does not tell yet. The
 * conversation is read only when a call waits. A call of a Goal the conversation no longer
 * runs is left out. A conversation whose user stopped the notifications is given none.
 */
const untoldBoardCalls = Effect.gen(function* () {
  const goalInstanceId = yield* workflows.goalInstanceId(sessionId);
  if (goalInstanceId === null || !(yield* kanbanBoard(sessionId))) return [];
  const waiting = (yield* orchestratorNotifications.untold(
    sessionId,
    "board",
    HashSet.empty(),
  )).filter((entry) => entry.payload.goalInstanceId === goalInstanceId);
  if (waiting.length === 0) return [];
  const { told } = toldIn(yield* runStore.thread(sessionId));
  return waiting.flatMap((entry): WaitingBoardCall[] =>
    HashSet.has(told, entry.id) ? [] : [{ id: entry.id, reasons: entry.payload.reasons }],
  );
});
```

`nextAutomatic`의 첫 가지를 이렇게 바꾼다. 둘째 가지와 주석은 그대로 둔다.

```ts
const calls = yield * untoldBoardCalls;
if (
  calls.length > 0 &&
  NextDelivery.$is("empty")((yield * queue.snapshot(sessionId)).nextDelivery) &&
  (yield * relayed.pending(sessionId)).length === 0
)
  return Option.some(AutomaticRun.board({ calls }));
```

(f) 보드 run을 시작하는 가지. 호출을 지우는 줄이 없어진다.

```ts
              board: ({ calls }) =>
                Effect.gen(function* () {
                  // The calls stay waiting until the run answers them: a run that cannot start
                  // leaves them for the next wakeup.
                  const started = yield* send(followupRunId, InternalFollowup.kanban({ calls }));
                  yield* drain(started);
                  // The planner had its turn: a card it left waiting for a replan waits for the user.
                  yield* Effect.when(
                    kanbanOrchestrator
                      .replanUnanswered(sessionId)
                      .pipe(Effect.catch(logFailure("Unanswered replan not shown", { sessionId }))),
                    Effect.succeed(
                      Result.isSuccess(started) && reasonsOf(calls).includes("replan_requested"),
                    ),
                  );
                }),
```

(g) 시작할 때 깨우기. `execution.readySessions()`를 깨우는 줄(`3095`) 바로 아래에 더한다.

```ts
// A board's call that waited across the restart: its conversation is woken to take it up. The
// loop calls the planner once per situation, so nothing else would.
yield *
  Effect.forEach(
    yield *
      orchestratorNotifications
        .waitingSessions("board")
        .pipe(
          Effect.catch((error) =>
            Effect.as(logFailure("Waiting board calls unavailable")(error), []),
          ),
        ),
    wakeNotifications,
    { discard: true },
  );
```

(h) `kanbanAttention`을 가리키는 것이 남지 않았는지 본다:
`rg -n 'kanbanAttention\b' packages/memory-agent/src`가 줄을 내지 않아야 한다(`kanbanAttentionPrompt`는
남는다). `Ref` import는 다른 곳이 쓴다.

**4-2. 테스트**

**`packages/memory-agent/src/kanban/kanban-flow.test.ts`**

`SqlClient`는 이 파일이 이미 쓴다("starts with a board whose attempt cannot be recovered…" 테스트). 표를 읽는
작은 helper 둘을 파일 위쪽(`mergeOf` 근처)에 둔다.

```ts
/** The board's calls that wait in a conversation, oldest first: their ids and reasons. */
const waitingCalls = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly id: string; readonly reasons: string }>`
      SELECT id, json_extract(payload, '$.reasons') AS reasons FROM orchestrator_notifications
      WHERE session_id = ${sessionId} AND sender = 'board' AND state = 'waiting'
      ORDER BY created_at, id`.pipe(Effect.orDie);
  });

const plannerRounds = (goalInstanceId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly rounds: number }>`
      SELECT planner_rounds AS rounds FROM kanban_goals
      WHERE goal_instance_id = ${goalInstanceId}`.pipe(Effect.orDie);
    return rows[0]?.rounds;
  });
```

- `outcomes_open`을 듣는 기존 테스트(`orchestrator.attention.pipe(Stream.filter(…includes("outcomes_open")),
  Stream.runHead, …)`가 있는 것)의 `heard`를 확인한 줄 뒤에 더한다:
  `const called = yield* waitingCalls(board.sessionId);`와
  `expect(called.map((call) => call.reasons)).toEqual(['["outcomes_open"]']);`
  이 테스트의 마지막 `expect` 뒤에 `expect(yield* waitingCalls(board.sessionId)).toEqual(called);`를 둔다
  (`Effect.sleep("300 millis")`은 테스트 중간에 있다. 그 뒤라면 어디든 된다). look이 여러 번 돌아도 호출은 같은 행 하나다(id가 같다).
- 새 테스트 "calls the planner once for a situation across a restart". "restarts with a running card whose
  notes changed…" 테스트의 두 owner 모양을 따른다.
  1. 첫 owner(`verifyOutcome`이 `Rejected`를 주는 것, 위 테스트와 같다)에서 `executingPlan(fixture,
     [card("a")])`, `setProtectedBranches(board.projectId, [])`, `orchestrator.start(board.sessionId)`.
     `eventually(waitingCalls(board.sessionId), (calls) => calls.length === 1)`. `Effect.sleep("300 millis")`
     뒤에 `waitingCalls`와 `plannerRounds(board.goalInstanceId)`를 읽어 둔다(`before`). 호출의 이유는
     `'["outcomes_open"]'`이고 라운드는 `0`보다 크다.
  2. 첫 scope를 닫는다.
  3. 둘째 owner를 같은 fixture로 연다(`openKanbanOwner(fixture, yield* Effect.scope, { agent: () =>
     Effect.succeed(finished) })`. `agent`는 꼭 줘야 한다). `start`는 부르지 않는다. owner는 열릴 때 도는
     보드를 스스로 잇는다(위 재시작 테스트의 둘째 owner가 `start` 없이 `waitForCards`만 한다).
  4. `Effect.sleep("400 millis")` 뒤: `waitingCalls`가 `before`의 것과 같다(id까지 같다. 다시 알렸다면 옛 행이
     지워지고 새 id의 행이 생긴다). `plannerRounds`가 `before`의 것과 같다.
- "stops waking the planner after three rounds…" 테스트는 고치지 않고 통과해야 한다. `resumePlanner` 뒤에
  planner가 다시 불리는 것을 본다.

**새 파일 `packages/memory-agent/tests/agent/board-call-delivery.test.ts`**

`tests/agent/dispatch-delivery.test.ts`의 "dispatch delivery in chat" 블록(`255`줄부터)의 틀을 따른다.
`testAgent({ testProvider: {} })`로 열고, 테스트마다 `yield* selectTestModel();`을 부른다(provider가 없는
`testAgent()`에서는 `send`가 run을 시작하지 못한다). 보드 루프는 돌리지 않는다. 대화를 "보드가 도는 대화"로
만들고 호출을 직접 넣는다. 같은 상태를 만드는 선례가 `tests/agents/async-subagents.test.ts:320-351`
("a task the conversation started wakes it while its kanban board runs")에 있다.

준비(테스트마다 새 대화):

```ts
const { project } = yield * TestEnv;
const session = yield * (yield * Sessions).create(project.id);
yield * selectTestModel();
const workflows = yield * Workflows;
yield * workflows.move(session.id, "goal");
yield * workflows.updateGoal(session.id, goalInput); // src/testing/kanban.ts의 goalInput
const goalInstanceId = Option.getOrThrow(
  Option.fromNullishOr(yield * workflows.goalInstanceId(session.id)),
);
const attempts = yield * CardAttempts;
yield *
  attempts.registerGoal({
    goalInstanceId,
    projectRoot: project.root,
    mode: "sequential",
    goalVersion: 1,
  });
```

`goalInput`을 `src/testing/kanban.ts`에서 가져올 수 없으면(그 파일이 테스트 문맥에 없는 것을 끌고 오면)
선례의 Goal 객체를 그대로 쓴다.

호출은 루프가 넣는 길로 넣는다:
`attempts.recordPlanner({ goalInstanceId, sessionId: session.id }, { rounds: 0, met: 0, situation: "s-1" },
Option.some(["outcomes_open"]))`. 그 행의 id는 `orchestrator_notifications`에서 `sender = 'board'`로 읽는다.
이 대화의 보드 루프는 돌지 않는다(`start`를 부르지 않았다). 그래서 넣은 호출을 루프가 바꾸지 않는다.
`env.reopen`은 쓰지 않는다. 다시 열면 owner가 도는 보드의 루프를 잇고, 루프가 이 호출을 자기 상황으로 바꾼다.

테스트 하나(둘째는 Step 5에서 더한다).

"a board's call starts a run that tells it and delivers it": 호출을 넣고 사용자 메시지 하나를 보낸다
(`send`). 그 run이 끝나면 대화가 깨어 보드 run이 시작한다. 호출의 행이 `delivered`가 될 때까지 기다린다
(`Effect.repeat({ until, schedule: Schedule.spaced("20 millis") })`와 `Effect.timeout("10 seconds")`). 그 뒤:

- 대화(`RunStore.thread(session.id)`)에 `orchestrator.next === "board"`인 메시지가 하나 있고, 그 글에
  `automatic kanban board follow-up`과 `A Goal outcome is unplanned or not_met`가 있고, `toldNotifications`가
  호출의 id 하나다.
- 그 메시지보다 앞의 메시지(사용자의 run이 남긴 것) 어디에도 `toldNotifications`에 호출의 id가 없다. 사용자가
  시작한 run은 호출을 싣지 않는다.
- 행의 `delivered_run_id`는 사용자의 run의 id와 다르다. `send`는 run의 id를 돌려주지 않는다. 사용자의 run은
  `SELECT run_id FROM chat_runs WHERE thread_id = ? ORDER BY started_at, rowid`의 첫 행이다.
- `Effect.sleep("300 millis")` 뒤에도 그 대화의 `chat_runs` 행은 둘이다(같은 호출로 run이 또 시작하지
  않는다).

이 준비로 대화가 보드로 읽히지 않거나(`kanbanBoard`가 `false`) 사용자의 run 뒤에 보드 run이 시작하지 않으면
까닭을 찾는다(`automatic`의 조건: 마지막 run이 `completed`, `executesPlan(workflow)`가 `false`, 사용자가
멈춘 대화가 아님). 테스트를 통과시키려고 `src/`의 조건을 바꾸지 않는다. 맞추지 못하면 이 테스트 파일은 만들지
않고, 무엇이 막았는지 보고에 적는다. Step 1과 `kanban-flow`의 테스트는 건너뛰지 않는다.

**Verify (Step 4 뒤)**:

```
vp run memory-agent#typecheck        # 오류 없음
vp run agent#typecheck               # 오류 없음
vp lint                              # exit 0
cd packages/memory-agent && vp test run --maxWorkers=4 <고른 테스트>
```

통과하면 commit 2를 만든다.

### Step 5: 사용자가 말하면 멈춘 보드의 planner를 다시 부른다

`packages/memory-agent/src/agent/chat.ts`의 `runStarted`에서 `workTrace.resumeParentNotifications(sessionId)`
를 부르는 `Effect.when` 바로 아래에 더한다. 외부 에이전트 가지(`1607-1611`)에 있는 것과 같은 모양이다.

```ts
// The user's word is the direction a stalled board's planner waited for.
yield *
  Effect.when(
    kanbanOrchestrator
      .resumePlanner(sessionId)
      .pipe(Effect.catch(logFailure("Stalled board planner not resumed", { sessionId }))),
    Effect.succeed(turn !== null),
  );
```

`logFailure(message, annotations)`는 이 파일이 이미 쓰는 모양이다(`logFailure("Unanswered replan not shown",
{ sessionId })`). 보드를 다시 세지 못한 것이 사용자의 run을 막아서는 안 되므로 실패는 기록만 한다. 외부
에이전트 가지의 호출은 그대로 둔다.

`resumePlanner`는 라운드가 `0`인 보드에는 아무것도 하지 않는다. 보드가 아닌 대화에서는 Goal이 없거나 보드가
`active`가 아니어서 곧바로 돌아온다.

**테스트**: `packages/memory-agent/tests/agent/board-call-delivery.test.ts`에 하나를 더한다(Step 4-2의 준비를
그대로 쓴다).

"a user's turn makes a stalled board call its planner again": 준비 뒤에
`attempts.recordPlanner({ goalInstanceId, sessionId: session.id }, { rounds: 4, met: 0, situation: "s-1" },
Option.none())`로 멈춘 보드를 만든다. `send(session.id, "계속해 줘")` 뒤에 `kanban_goals`의 그 행이
`planner_rounds = 0`, `planner_situation IS NULL`인지 본다(`sqlGet`). Step 4-2의 테스트 파일을 만들지 못했으면
이 테스트도 만들지 않고 보고에 적는다.

**Verify**:

```
vp run memory-agent#typecheck        # 오류 없음
vp lint                              # exit 0
cd packages/memory-agent && vp test run --maxWorkers=4 tests/agent src/kanban
```

통과하면 commit 3을 만든다.

### Step 6: 문서

**`docs/decisions.md`**의 끝에 더한다.

```md
## 보드의 호출을 orchestrator notifications에 둔다 (2026-11-26)

- 문제: 보드가 모델(planner)을 부르는 호출은 프로세스 메모리 두 곳에만 있었다. 루프가 마지막으로 알린
  상황(`announced`)과 run이 아직 가져가지 않은 이유(`kanbanAttention`)다. 자동 run은 호출을 지우고 시작해서,
  시작을 거절당하면 호출이 사라지고 보드가 멈췄다. 앱을 다시 시작하면 같은 상황을 다시 알려 planner run이 한
  번 더 돌았고, 그때마다 planner 라운드가 하나 늘었다.
- 결정: 보드의 호출도 다른 알림과 같은 규칙을 따른다("알림은 대화에 한 번 넣고, 모델이 답하면 전한 것으로
  적는다 (2026-11-25)").
  - 루프는 상황이 바뀌면 호출을 `orchestrator_notifications`에 남긴다(보낸 쪽 `board`, payload `BoardCall`,
    전달 값 `wake`). 그 Goal의 아직 기다리는 호출은 지운다. 기다리는 호출은 Goal마다 많아야 하나이고 보드가
    지금 필요로 하는 것을 말한다. 알릴 이유가 없어지면 기다리는 호출도 없다.
  - 루프가 마지막으로 본 상황은 Goal의 행에 남긴다(`kanban_goals.planner_situation`). 호출과 한
    transaction으로 쓴다. 다시 시작한 owner는 같은 상황을 다시 알리지 않고 라운드도 세지 않는다. 사용자가
    말하면(`resumePlanner`) 비워서 다음 look이 다시 알린다.
  - 보드 run은 호출을 지우지 않고 읽는다. 호출을 전하는 메시지가 호출의 id를 가진다
    (`toldNotifications`). run이 끝나면 `ended` hook이 전한 것으로 적는다. 시작하지 못한 run은 아무것도
    바꾸지 않아서 다음에 깨어날 때 다시 시도한다.
  - 앱이 시작할 때 기다리는 호출이 있는 대화를 깨운다. 루프는 같은 상황을 다시 알리지 않으므로 달리 깨울
    것이 없다.
- 그대로 둔 것: 보드의 호출은 보드 run이 시작할 때만 전한다. 사용자가 시작한 run과 알림 run에는 싣지 않는다
  ("두 이유는 받는 쪽이 달라 한 run으로 합치지 않는다"). 사용자가 멈춘 대화와 마지막 run이 끝까지 가지 못한
  대화에는 자동 run을 시작하지 않는다.
- `wakes`는 보드의 호출을 세지 않는다. 보드 run은 큐에 메시지가 있거나 승인이 기다리면 시작하지 않는데,
  그때 `wakes`가 참이면 호출을 전하지 않는 알림 run이 되풀이해 시작한다.
- 달라지는 동작:
  - 다시 시작한 뒤에 모델이 이미 답한 상황으로 planner를 다시 부르지 않는다.
  - 상황이 바뀌어 알릴 이유가 없어지면 아직 전하지 않은 호출을 거둔다. 전에는 낡은 이유로 run이 한 번
    돌았다.
  - 실패한 보드 run이 대화에 남긴 호출은, 그 대화의 다음 run이 끝까지 가면 전한 것으로 적힌다(규칙 2번).
  - Goal을 일시정지하면 아직 전하지 않은 호출을 거둔다. 재개하면 다시 알리고 라운드도 센다.
  - planner 라운드가 한도를 넘으면(`plannerStalled`) 루프 자신의 이유로 기다리던 호출도 거둔다. 사용자가
    말해 다시 셀 때 다시 알린다.
  - 상황과 호출을 한 transaction으로 쓴다. 전에는 메모리의 상황을 먼저 바꿔서, 그 뒤의 쓰기가 실패한 look은
    호출을 잃었다.
  - 상황이 바뀔 때마다 `kanban_goals`의 행을 쓴다(`updated_at` 포함). 전에는 라운드나 met가 바뀔 때만 썼다.
  - 이 버전으로 올린 뒤 첫 look은 지금 상황을 한 번 알린다(`planner_situation`이 비어 있다). 전에 재시작마다
    하던 것과 같다.
- 함께 고친 것: 한도를 넘어 멈춘 보드는 사용자가 대화에 말하면 다시 세기로 되어 있었다
  (`KanbanOrchestrator.resumePlanner`). 그런데 그것을 부르는 곳이 외부 에이전트 대화의 가지에만 있어서, 보드가
  도는 일반 대화에서는 불리지 않았다. 일반 대화의 run이 사용자의 턴으로 시작할 때도 부른다.
- 남은 것: 끝난 Goal의 호출이 기다리는 채로 남을 수 있다. 자동 run은 지금 도는 Goal의 호출만 읽으므로
  전해지지 않고, 대화를 지울 때 함께 지워진다. 그동안 앱이 시작할 때마다 그 대화를 한 번 깨우지만 run은
  시작하지 않는다.
- 구현: 계획 040.
```

**README들**. 각 파일에서 `rg -n 'attention|kanbanAttention|setPlannerRounds|PlannerRounds'`로 찾은 문장을
지금 동작에 맞게 고친다.

- `packages/memory-agent/src/kanban/README.md`: `KanbanAttentionReason`과 `BoardCall`은 `attention.ts`에
  있다. `PlannerRounds`가 `situation`을 갖고 `kanban_goals.planner_situation`에 남는다. 루프는 호출을
  `CardAttempts.recordPlanner`로 `orchestrator_notifications`에 남긴다.
- `packages/memory-agent/src/sessions/README.md`: `board` 보낸 쪽의 payload(`BoardCall`),
  `boardCallWrites`, `waitingSessions`, `wakes`가 보드의 호출을 세지 않는 것. `OrchestratorNotifications`를
  설명하는 줄이 `task` 행의 payload를 `BackgroundTaskEnd` 하나로 적고 있으면 둘(`BackgroundTaskEnd`,
  `TaskStatusChange`)로 고친다.
- `docs/kanban-orchestration.md`의 `planner_rounds`를 설명하는 항목(`127`줄 근처): 루프가 마지막으로 본 상황을
  `kanban_goals.planner_situation`에 남겨 재시작 뒤에 같은 상황으로 다시 깨우지 않는다는 문장을 더한다.
- `packages/memory-agent/src/agent/README.md:79` 근처: 보드 run은 표에서 기다리는 호출을 읽어 시작한다.

**Verify**: `vp lint` exit 0. commit 4를 만든다.

## Test plan

- `tests/sessions/orchestrator-notifications.test.ts`: 새 테스트 셋(Step 1-3).
- `src/kanban/kanban-flow.test.ts`: 고친 테스트 하나, 새 테스트 하나(Step 4-2). 기존 테스트는 모두 통과.
- `tests/agent/board-call-delivery.test.ts`: 새 테스트 둘(Step 4-2, Step 5).
- 끝까지 migrate하는 테스트(`migration`, `tests/database.test.ts`, `tests/upgrade-0.0.17.test.ts`,
  `tests/db-migrator-metadata.test.ts`)가 새 단계와 함께 통과.

## Done criteria

- [ ] `vp run memory-agent#typecheck`와 `vp run agent#typecheck`가 오류 없음
- [ ] 루트 `vp lint` exit 0
- [ ] 고른 테스트 전부 통과
- [ ] `rg -n 'kanbanAttention\b|setPlannerRounds' packages/memory-agent/src --hidden -g '!node_modules' -g '!*.md'`
      가 줄을 내지 않는다
- [ ] `rg -n 'announced' packages/memory-agent/src/kanban/orchestrator.ts`가 줄을 내지 않는다(다른 파일의
      주석에는 이 낱말이 무관하게 있다)
- [ ] `rg -n 'resumePlanner' packages/memory-agent/src/agent/chat.ts`가 두 줄을 낸다
- [ ] `rg -n "planner_situation" packages/memory-agent/src/db/migrations.ts`가 한 줄을 낸다
- [ ] `git diff --stat <시작 commit>..HEAD`에 "In scope" 밖의 파일이 없다
- [ ] `docs/decisions.md` 끝에 위 항목이 있다

## STOP conditions

- `rg -n 'taskStatusWrites' packages/memory-agent/src/sessions/orchestrator-notifications.ts`가 줄을 내지
  않는다(039가 없다).
- "Current state"의 발췌와 실제 코드의 내용이 다르다.
- `orchestrator.ts`의 look에서 `goal`이 이 look의 처음에 읽은 Goal의 행이 아니다(`goal.planner.situation`이
  낡은 값이면 같은 상황을 look마다 다시 알린다).
- `CardAttempts.layer`에 `NodeCrypto.layer`를 주면 다른 layer 조립이 깨지고, 그 조립을 고치려면 "In scope"
  밖의 파일 셋 이상을 고쳐야 한다.
- `kanban-flow`의 기존 테스트가 이 변경 때문에 실패하는데 고치려면 테스트의 뜻을 바꿔야 한다.
- 계획이 정하지 않은 동작을 골라야 한다. 스스로 정하지 말고 `NEEDS-DECISION`으로 보고한다.

## Maintenance notes

- 상황 문자열(`situation`)의 모양을 바꾸면 올린 뒤 첫 look이 모든 보드에서 한 번 다시 알린다. 저장된 값과
  달라지기 때문이다. 받아들일 만하지만 planner 라운드가 하나씩 는다.
- 보낸 쪽을 더할 때 `wakingRow`의 조건을 본다. 자기 문에서 run을 시작하는 보낸 쪽은 `wakes`에서 빼야 한다.
- 끝난 Goal의 기다리는 호출은 지우지 않는다. 알림을 보여 주는 화면을 만들 때 걸러야 한다.
- 뒤에 올 계획: 사용자 메시지 큐가 같은 전달 값(`MessageDelivery`)을 쓰는 것, `notify_session`의 깨우기,
  알림 화면.
