# Plan 039: 하위 작업의 상태 알림을 orchestrator notifications에 둔다

> **Executor instructions**: 이 계획을 단계 순서대로 따른다. 단계마다 Verify 명령을 돌려 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다. 임의로 풀지 않는다.
> `plans/README.md`는 고치지 않는다(검토자가 표를 관리한다).
>
> **이 저장소에서 찾을 때는 언제나 `rg --hidden -g '!.git' -g '!node_modules'`를 쓴다.** route 핸들러 폴더
> `apps/agent/app/.server`는 이름이 점으로 시작해 `rg`가 기본으로 건너뛴다. zsh에서 큰따옴표 안의
> backtick은 명령으로 실행된다. backtick이 든 패턴은 작은따옴표로 감싼다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat ce5311e9..HEAD -- packages/memory-agent/src/work-trace/store.ts packages/memory-agent/src/sessions/orchestrator-notifications.ts packages/memory-agent/src/agent/task-notifications.ts packages/memory-agent/src/agent/orchestrator-message.ts packages/memory-agent/src/agent/chat.ts packages/memory-agent/src/subagents/subagents.ts packages/memory-agent/src/db/migrations.ts`
> 바뀐 파일이 있으면 "Current state"의 발췌와 실제 코드를 비교한다. 다르면 STOP이다. 공백과 몇 줄의 번호
> 차이는 다른 것으로 보지 않는다. `migrations.ts`는 배열 끝에 다른 단계가 더해졌을 수 있다. 그때는 이
> 계획의 단계를 그 뒤에 둔다.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (표 하나를 없애는 migration, Work Trace 저장소, 알림 hook, 테스트와 golden 여러 개)
- **Depends on**: 037 (merge됨, merge commit `ccbfdade`). 시작할 때
  `rg -n 'untold:' packages/memory-agent/src/sessions/orchestrator-notifications.ts`가 한 줄을 내지 않으면
  STOP이다.
- **Category**: tech-debt (같은 일을 하는 장부 둘을 하나로 합친다), bug (실패한 run 뒤에 같은 알림이 모델에게
  두 번 보인다)
- **Planned at**: commit `ce5311e9`, 2026-11-26

## Why this matters

앱은 하위 작업(subagent)의 상태가 바뀌면 부모 대화의 모델에게 알린다. 끝났다, 실패했다, 멈췄다, 보관됐다,
지워졌다, 다시 시작했다 같은 것이다. 이 알림은 Work Trace 저장소의 표 `parent_notifications`에 있다.

앱이 모델에게 전하는 다른 알림(끝난 백그라운드 작업, 다른 대화가 남긴 메시지)은 표
`orchestrator_notifications`에 있고, 계획 037부터 규칙 하나를 따른다.

1. 알림은 대화에 메시지로 한 번 넣는다. 그 메시지는 자기가 전하는 알림의 id를 가진다
   (`StoredUserMessage.toldNotifications`). run이 가진 대화에 그 id가 있으면 다시 넣지 않는다.
2. run이 끝나 대화를 저장한 뒤에 전한 것으로 적는다. `completed`나 `interrupted`로 끝났으면 그 대화가 전하는
   알림을 모두 적는다. 실패하거나 취소됐으면 그 메시지 뒤에 모델의 답이 있는 것만 적는다.
3. 메시지가 대화에 없으면 다음 run이 다시 넣는다. 앱을 다시 시작할 때 알림을 따로 정리하지 않는다.

하위 작업의 알림만 옛 방식이다.

- run이 알림을 읽는 순간 그 run이 전한 것으로 적는다(`consumeParentNotifications`).
- run이 실패하거나 취소되면 되돌린다(`releaseParentNotifications`).
- run이 시작하지 못하면 `AgentChat.start`의 finalizer가 되돌린다(계획 036).
- 앱을 다시 시작하면 `completed`가 아닌 run이 가진 것을 되돌린다(`store.ts`의 시작 코드).

그래서 037이 고친 버그가 여기에는 남아 있다. 실패한 run도 알림 메시지를 대화에 저장하고 다음 요청은 그
메시지를 다시 보낸다. 되돌린 알림은 다음 run에서 새 메시지로 한 번 더 들어간다. 모델은 같은 알림을 두 번
본다.

사용자는 알림 넷(끝난 하위 작업, 끝난 백그라운드 작업, 다른 대화가 남긴 메시지, 보드의 호출)이 규칙 하나를
따른다고 정했다(2026-11-23, `plans/consistency-rules.md`의 R8). 이 계획은 하위 작업의 알림을
`orchestrator_notifications`로 옮긴다. 옮기면 위 규칙을 그대로 따른다. `parent_notifications` 표, 읽으며
적기, 되돌리기 둘, 재시작 정리가 없어진다.

보드의 호출은 이 계획에서 다루지 않는다.

## Current state

모든 경로는 저장소 루트 기준이다. 줄 번호는 commit `ce5311e9`의 것이다.

### 옮겨 갈 표: `orchestrator_notifications`

`packages/memory-agent/src/db/migrations.ts`의 `notificationClaimsDropMigration`(계획 037)이 만든 지금 꼴이다.

```sql
CREATE TABLE orchestrator_notifications (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('task', 'conversation', 'board')),
  delivery TEXT NOT NULL CHECK (delivery IN ('interrupt', 'wake', 'next_run')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  state TEXT NOT NULL CHECK (state IN ('waiting', 'delivered')),
  delivered_run_id TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  CHECK ((state = 'delivered') = (delivered_run_id IS NOT NULL)),
  CHECK ((state = 'delivered') = (delivered_at IS NOT NULL))
);
CREATE INDEX orchestrator_notifications_waiting
  ON orchestrator_notifications(session_id, state, created_at);
```

`created_at`과 `delivered_at`은 ISO 글자(`2026-11-26T01:02:03.456Z`)다.

### 없앨 표: `parent_notifications`

`packages/memory-agent/src/db/migrations.ts:1781-1801`.

```sql
CREATE TABLE parent_notifications (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
  origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  parent_run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'stopped', 'interrupted', 'archived', 'deleted', 'resume_blocked',
    'resumed', 'completed', 'failed'
  )),
  summary TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  idempotency_key TEXT NOT NULL UNIQUE,
  delivered_to_run_id TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX parent_notifications_pending
  ON parent_notifications(origin_session_id, delivered_at, seq);
CREATE INDEX parent_notifications_task ON parent_notifications(task_id, seq);
```

`created_at`과 `delivered_at`은 밀리초 숫자다. `work_tasks`에는 `delivery TEXT NOT NULL DEFAULT 'wake' CHECK
(delivery IN ('wake', 'next_run'))` 열이 있다(`migrations.ts:763`).

`parent_notifications(id)`를 가리키던 표 `final_answer_notifications`(`1947-1954`)는 뒤의 단계
(`migrations.ts:3190`, `DROP TABLE final_answer_notifications;`)가 이미 지웠다. 지금 이 표를 가리키는 표,
trigger, view는 없다. 그래서 `DROP TABLE parent_notifications` 하나면 된다.

`parent_notifications`를 읽는 코드는 전달뿐이다. 화면도 도구도 이 표를 읽지 않는다.

### Work Trace 저장소: `packages/memory-agent/src/work-trace/store.ts`

알림 행의 Schema와 decoder(`124-140`, `287-290`, `309-311`).

```ts
const NotificationTaskRow = Schema.Struct({
  project_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.String,
});
const ParentNotificationRow = Schema.Struct({
  id: Schema.String,
  task_id: Schema.String,
  parent_run_id: Schema.String,
  agent_name: Schema.NullOr(Schema.String),
  kind: Schema.String,
  summary: Schema.String,
  payload: Schema.String,
  created_at: Schema.Finite,
});
```

```ts
const decodeNotificationTask = Schema.decodeUnknownEffect(NotificationTaskRow);
const decodeParentNotificationRows = Schema.decodeUnknownEffect(
  Schema.Array(ParentNotificationRow),
);
```

```ts
const decodeOriginSessions = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ origin_session_id: Schema.String })),
);
```

재시작 복구가 읽는 행(`97-104`).

```ts
const RecoveryRow = Schema.Struct({
  id: Schema.String,
  task_id: Schema.String,
  project_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  agent_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.String,
});
```

읽은 알림의 타입(`333-344`).

```ts
export interface ParentNotificationView {
  readonly id: string;
  readonly taskId: string;
  /** The run that started the task: a chat run, or one of the kanban board's (`isBoardRun`). */
  readonly parentRunId: string;
  /** The task's agent, such as a named helper; null once the task is gone. */
  readonly agentName: string | null;
  readonly kind: string;
  readonly summary: string;
  readonly payload: JsonValue;
  readonly createdAt: number;
}
```

`agentName`과 `createdAt`을 읽는 코드는 없다.

저장소를 만들 때의 재시작 정리(`535-539`).

```ts
// A crash after prompt delivery but before parent completion must not lose operational
// notifications. No current-process runs exist while this singleton is being constructed.
yield *
  run(sql`UPDATE parent_notifications SET delivered_to_run_id = NULL, delivered_at = NULL
    WHERE delivered_to_run_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM chat_runs WHERE run_id = delivered_to_run_id AND status = 'completed')`);
```

재시작 복구(`recoveredAttempts`, `678-742`)는 죽은 프로세스가 남긴 attempt마다 알림을 직접 넣는다.

```ts
const attempts =
  yield *
  decodeRecoveryRows(
    yield *
      sql`SELECT a.id, a.task_id, t.project_id, t.origin_session_id, t.agent_id,
          t.parent_run_id
        FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
        WHERE a.status IN ('queued', 'running', 'waiting', 'blocked')`,
  );
```

```ts
yield *
  run(sql`INSERT INTO parent_notifications
            (id, project_id, task_id, origin_session_id, parent_run_id, kind, summary, payload,
             idempotency_key, created_at)
            VALUES (${yield * crypto.uuidV4()}, ${row.project_id}, ${row.task_id},
              ${row.origin_session_id}, ${row.parent_run_id}, 'interrupted', ${summary},
              ${yield * encodeJson({ attemptId: row.id, failure })},
              ${`recovery:${row.id}:interrupted`}, ${now})
            ON CONFLICT(idempotency_key) DO NOTHING`);
```

알림을 넣는 함수(`852-888`).

```ts
const notifyParent = (input: {
  readonly taskId: string;
  readonly kind:
    | "stopped"
    | "interrupted"
    | "archived"
    | "deleted"
    | "resume_blocked"
    | "resumed"
    | "completed"
    | "failed";
  readonly summary: string;
  readonly idempotencyKey: string;
  readonly payload?: Readonly<Record<string, JsonValue>>;
  readonly deliveredImmediately?: boolean;
  readonly deliveredToRunId?: string;
}) =>
  Effect.gen(function* () {
    const task = yield* decodeNotificationTask(
      yield* first(sql`SELECT project_id, origin_session_id, parent_run_id FROM work_tasks
          WHERE id = ${input.taskId}`),
    );
    const now = yield* Clock.currentTimeMillis;
    const id = yield* crypto.uuidV4();
    const payload = yield* encodeJson(input.payload ?? {});
    const deliveredToRunId =
      input.deliveredImmediately === true ? (input.deliveredToRunId ?? task.parent_run_id) : null;
    const result = yield* run(sql`INSERT INTO parent_notifications
        (id, project_id, task_id, origin_session_id, parent_run_id, kind, summary, payload,
         idempotency_key, delivered_to_run_id, delivered_at, created_at)
        VALUES (${id}, ${task.project_id}, ${input.taskId}, ${task.origin_session_id},
          ${task.parent_run_id}, ${input.kind}, ${input.summary}, ${payload},
          ${input.idempotencyKey}, ${deliveredToRunId},
          ${input.deliveredImmediately === true ? now : null}, ${now})
        ON CONFLICT(idempotency_key) DO NOTHING`);
    return result.changes === 1 ? id : null;
  }).pipe(sql.withTransaction);
```

되돌리기와 읽으며 적기(`890-925`).

```ts
  const releaseParentNotifications = (sessionId: string, deliveredToRunId: string) =>
    Effect.map(
      run(sql`UPDATE parent_notifications SET delivered_to_run_id = NULL, delivered_at = NULL
        WHERE origin_session_id = ${sessionId} AND delivered_to_run_id = ${deliveredToRunId}`),
      (result) => result.changes,
    );

  const consumeParentNotifications = (sessionId: string, deliveredToRunId: string) =>
    Effect.gen(function* () {
      const rows = yield* decodeParentNotificationRows(
        yield* sql`SELECT n.id, n.task_id, n.parent_run_id, t.agent_name, n.kind, n.summary, n.payload,
          n.created_at
          FROM parent_notifications n LEFT JOIN work_tasks t ON t.id = n.task_id
          WHERE n.origin_session_id = ${sessionId} AND n.delivered_at IS NULL ORDER BY n.seq`,
      );
      // … 행마다 delivered_to_run_id와 delivered_at을 적고 ParentNotificationView로 돌려준다
```

attempt의 상태를 바꾸는 함수(`1017-1090`). 일곱째 인자 `deliveredImmediately`의 기본값은 `true`다. `true`면
알림을 처음부터 전한 것으로 넣는다. 부르는 쪽의 도구 결과가 같은 것을 모델에게 전하는 경우다.

```ts
  const transitionAttempt = (
    handle: AttemptHandle,
    sessionId: string,
    status: AttemptStatus,
    event: RunEventKind,
    summary: string,
    failure?: {
      readonly reason: AttemptFailureReason;
      readonly stage?: AttemptFailureStage;
    } | null,
    deliveredImmediately = true,
    deliveredToRunId?: string,
    detail: Readonly<Record<string, JsonValue>> = {},
  ) =>
```

```ts
yield *
  Option.match(notificationKind, {
    onNone: () => Effect.void,
    onSome: (kind) =>
      notifyParent({
        taskId: handle.taskId,
        kind,
        summary,
        idempotencyKey: `attempt:${handle.id}:${kind}`,
        payload:
          recorded === null
            ? { attemptId: handle.id }
            : { attemptId: handle.id, failure: recorded },
        deliveredImmediately,
        ...optionalProperty("deliveredToRunId", deliveredToRunId),
      }),
  });
```

`notifyParent`를 부르는 곳은 넷이다. 위 `transitionAttempt`, `notifyLifecycle`(`1645-1660`, 보관·삭제),
`claimRetries` 안(`1907-1913`, `resume_blocked`), 그리고 테스트다. `transitionAttempt` 밖의 둘은
`deliveredImmediately`를 넘기지 않는다.

task를 지울 때 알림의 글을 지우는 곳(`purgeTask`, `1674-1676`).

```ts
yield *
  run(sql`UPDATE parent_notifications
      SET summary = 'Deleted task lifecycle notification', payload = '{}'
      WHERE task_id = ${taskId}`);
```

서비스가 내보내는 것(`2060-2094`) 가운데 이 계획이 없애는 셋.

```ts
    consumeParentNotifications,
```

```ts
    /**
     * Durable wake-up source: sessions with a notification of a `wake` task. Reading does not mark
     * a notification delivered.
     */
    wakingParentNotificationSessions:
      sql`SELECT DISTINCT n.origin_session_id FROM parent_notifications n
        JOIN work_tasks t ON t.id = n.task_id AND t.delivery = 'wake'
        WHERE n.delivered_at IS NULL AND n.origin_session_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM parent_notification_holds h WHERE h.session_id = n.origin_session_id
          )`.pipe(
        Effect.flatMap(decodeOriginSessions),
        Effect.map((rows) => rows.map((row) => row.origin_session_id)),
      ),
    releaseParentNotifications,
```

`holdParentNotifications`, `resumeParentNotifications`, `parentNotificationsHeld`와 표
`parent_notification_holds`는 **그대로 둔다**. 사용자가 멈춘 대화를 적는 곳이고 `orchestrator_notifications`도
이것을 읽는다.

대화를 지우는 코드(`1445`)는 `DELETE FROM work_tasks WHERE origin_session_id = ${sessionId}`로 task를 지우고
`1481`에서 `sessions` 행을 지운다. `orchestrator_notifications`의 행은 `session_id`의 `ON DELETE CASCADE`로
같이 지워진다. 이 코드는 고치지 않는다.

### `transitionAttempt`를 부르는 곳: `packages/memory-agent/src/subagents/subagents.ts`

여덟 곳이다. `525`, `551`은 인자 다섯 개로 부른다(고치지 않는다). 나머지 여섯 곳이 여덟째 인자로
`binding.runId`를 넘긴다. `820-829`, `867-877`, `943-952`, `983-994`, `1179-1188`, `1413-1423`. 둘의 모양:

```ts
yield *
  trace.transitionAttempt(
    handle,
    binding.sessionId,
    "running",
    "attempt_started",
    "Subagent started",
    null,
    notifyParentImmediately,
    binding.runId,
  );
```

```ts
yield *
  trace.transitionAttempt(
    handle,
    binding.sessionId,
    status,
    attemptEnds[status].event,
    attemptEnds[status].summary,
    Option.getOrNull(Option.map(ran.failure, (reason) => ({ reason }))),
    notifyParentImmediately,
    binding.runId,
    optionalProperty("messageId", Option.getOrUndefined(answerMessageId)),
  );
```

`store.ts:2039-2047`의 한 곳은 인자 일곱 개로 부른다(고치지 않는다).

### 알림 저장소: `packages/memory-agent/src/sessions/orchestrator-notifications.ts`

보낸 쪽마다의 payload(`44-53`).

```ts
/**
 * What each sender's message carries. Only the senders listed here are stored and read; a sender
 * that moves to the table adds its key. `task` carries the end of a background task; its payload
 * is tagged because the ends of other kinds of task join the same sender later.
 */
export const notificationPayloads = {
  conversation: ConversationMessage,
  task: BackgroundTaskEnd,
} as const;
type StoredSender = keyof typeof notificationPayloads;
type PayloadOf<Sender extends StoredSender> = (typeof notificationPayloads)[Sender]["Type"];
```

`BackgroundTaskEnd`는 `packages/memory-agent/src/tools/background-end.ts`의
`Schema.TaggedStruct("BackgroundEnd", { taskId, parentRunId, kind, title, status })`다.

`make` 안의 statement와 시각(`133-142`, `188-190`).

```ts
/** Stores the row unless a row with its id is there already; that row stays as it is. */
const insertOnce = SqlSchema.void({
  Request: NotificationRow,
  execute: (row) => sql`
      INSERT INTO orchestrator_notifications (id, session_id, sender, delivery, payload, state,
        delivered_run_id, created_at, delivered_at)
      VALUES (${row.id}, ${row.session_id}, ${row.sender}, ${row.delivery}, ${row.payload},
        ${row.state}, ${row.delivered_run_id}, ${row.created_at}, ${row.delivered_at})
      ON CONFLICT(id) DO NOTHING`,
});
```

```ts
const isoNow = Effect.map(Clock.currentTimeMillis, (millis) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis)),
);
```

서비스의 메서드. 이 계획이 쓰는 것:

- `putOnce({ id, sessionId, sender, delivery, payload })`: 그 id의 행이 없으면 `waiting`으로 넣는다.
- `wakes(sessionId)`: `waiting`이고 `delivery`가 `wake`인 행이 있고 사용자가 알림을 멈추지 않았으면 `true`.
- `untold(sessionId, sender, told)`: 그 보낸 쪽의 `waiting` 행 가운데 id가 `told`에 없는 것. `created_at`,
  `id` 순서다. 사용자가 알림을 멈춘 대화에는 빈 배열을 준다. 아무것도 쓰지 않는다.
- `heard(sessionId, runId, delivered)`: `waiting` 행 가운데 id가 `delivered`에 있는 것을 전한 것으로 적는다.

서비스의 메서드는 실패를 `NotificationStoreFailed`로 감싼다(`stored`). `SqlSchema.void`와
`SqlSchema.findAll`이 만든 statement 자체는 `SqlError | SchemaError`로 실패한다.

### 끝난 작업을 전하는 hook: `packages/memory-agent/src/agent/task-notifications.ts`

파일 전체가 92줄이다. 핵심:

```ts
export const taskNotifications = (services: {
  readonly trace: WorkTraceStore["Service"];
  readonly notifications: OrchestratorNotifications["Service"];
  readonly crypto: SecureRandom.SecureRandom["Service"];
}) => {
  const { trace, notifications, crypto } = services;
  const consume = (sessionId: string, runId: string, conversation: ReadonlyArray<StoredMessage>) =>
    Effect.all({
      tasks: trace.consumeParentNotifications(sessionId, runId),
      background: Effect.map(
        notifications.untold(sessionId, "task", toldIn(conversation).told),
        (entries) =>
          entries.map(({ payload }): BackgroundEnd => ({
            taskId: payload.taskId,
            parentRunId: payload.parentRunId,
            kind: payload.kind,
            title: payload.title,
            status: payload.status,
          })),
      ),
    });
  /** Gives back the Work Trace notifications the run took; the background ends need no giving back. */
  const release = (sessionId: string, runId: string) =>
    Effect.asVoid(trace.releaseParentNotifications(sessionId, runId));
  return {
    consume,
    release,
    wakes: (sessionId: string) =>
      Effect.zipWith(
        trace.wakingParentNotificationSessions,
        notifications.wakes(sessionId),
        (sessions, waking) => waking || sessions.includes(sessionId),
      ),
    hookFor: (sessionId: string, runId: string): RunHook => ({
      joining: (_scope, conversation) =>
        consume(sessionId, runId, conversation).pipe(
          Effect.flatMap((notifications: TaskNotifications) =>
            hasTaskNotifications(notifications)
              ? Effect.map(
                  Effect.flatMap(crypto.uuidV7(), notificationsMessage(notifications)),
                  (message): StoredMessage[] => [message],
                )
              : Effect.succeed<StoredMessage[]>([]),
          ),
          Effect.mapError(asRunFailed),
        ),
      ended: (_scope, end, conversation) =>
        Effect.andThen(
          (finishedRun(end) ? Effect.void : release(sessionId, runId)).pipe(
            Effect.ignore({ log: "Warn" }),
          ),
          notifications
            .heard(sessionId, runId, heardBy(end, conversation))
            .pipe(Effect.ignore({ log: "Warn" })),
        ),
    }),
  };
};
```

### 알림 메시지를 만드는 곳: `packages/memory-agent/src/agent/orchestrator-message.ts`

```ts
import type { ParentNotificationView } from "../work-trace/store.ts";

export interface TaskNotifications {
  readonly tasks: ReadonlyArray<ParentNotificationView>;
  readonly background: ReadonlyArray<BackgroundEnd>;
}
```

```ts
/** One line per notification, for the model. */
export const notificationLines = ({ tasks, background }: TaskNotifications) => [
  ...tasks.map(
    (notification) =>
      `Notification ${notification.id}; task ${notification.taskId}; ${notification.kind}: ${notification.summary}; ${JSON.stringify(notification.payload)}`,
  ),
  ...background.map(
    (end) =>
      `Background ${end.kind} task ${end.taskId} ${end.status}: ${end.title}; retrieve it with get_background_result`,
  ),
];
```

`notificationsMessageBody`의 끝(계획 037이 넣었다).

```ts
    telling(notifications.background.map((end) => end.taskId)),
```

`telling(ids)`는 메시지에 `toldNotifications`를 붙인다. `toldIn(conversation)`은 대화의 메시지들이 전하는 id를
읽는다. `heardBy(end, conversation)`은 run이 전한 id를 준다. 셋 다 이 파일에 있고 고치지 않는다.

### `packages/memory-agent/src/agent/chat.ts`

hook을 만드는 곳(`696-700`).

```ts
const notifications = taskNotifications({
  trace: workTrace,
  notifications: orchestratorNotifications,
  crypto,
});
```

시작하지 못한 run이 잡은 것을 돌려주는 finalizer(계획 036, `1306-1317`).

```ts
// What an early end must undo. The run takes over the cancellation, the steering and the
// Work Trace notifications it took once it is following its log.
const claimedNext = yield * Ref.make<string | null>(null);
const cancellationToRelease = yield * Ref.make<Effect.Effect<void>>(Effect.void);
const stopSteeringOnExit = yield * Ref.make<Effect.Effect<void>>(Effect.void);
const notificationsToRelease = yield * Ref.make<Effect.Effect<void>>(Effect.void);
yield *
  Effect.addFinalizer(() =>
    Effect.flatMap(Ref.get(claimedNext), (next) =>
      isTruthy(next) ? queue.releaseNext(sessionId, next) : Effect.void,
    ).pipe(Effect.catch(logFailure("Queued next turn was not released"))),
  );
yield * Effect.addFinalizer(() => Effect.flatten(Ref.get(notificationsToRelease)));
```

`runContext`(`1759-1881`)의 주석과 알림을 읽는 곳.

```ts
/**
 * The run's context prompts, the same on either loop: report evidence, skills, delegation,
 * workspace and workflow, the subagent notifications since the last run and why an
 * automatic run started. Taking the Work Trace notifications marks them delivered to this
 * run; a background end waits until the model answers the message that tells it.
 */
```

```ts
const parentNotifications =
  yield *
  EffectArray.match(followup, {
    onEmpty: () => Effect.succeed(noTaskNotifications),
    onNonEmpty: () =>
      Ref.set(
        notificationsToRelease,
        notifications
          .release(sessionId, runId)
          .pipe(
            Effect.catch(logFailure("Notifications of a run that did not start not given back")),
          ),
      ).pipe(
        Effect.andThen(runStore.thread(sessionId)),
        Effect.flatMap((stored) => notifications.consume(sessionId, runId, stored)),
      ),
  });
```

```ts
                telling(parentNotifications.background.map((end) => end.taskId)),
```

run이 log를 따라가기 시작하면 finalizer를 비우는 곳(`2384-2386`).

```ts
yield * Ref.set(cancellationToRelease, Effect.void);
yield * Ref.set(stopSteeringOnExit, Effect.void);
yield * Ref.set(notificationsToRelease, Effect.void);
```

`workTrace.holdParentNotifications`, `resumeParentNotifications`, `parentNotificationsHeld`를 부르는 곳
(`1161`, `1604`, `1701`, `1747`, `2435`, `2451`, `2954`)은 고치지 않는다.

### 고칠 테스트와 eval이 지금 보는 것

- `packages/memory-agent/tests/agents/agent-env.ts:97`, `packages/memory-agent/tests/golden/driver.ts:104`,
  `packages/memory-agent/eval/live-delegation.ts:97`, `packages/memory-agent/eval/tool-use.ts:327`: 대화가
  가라앉았는지 보는 SQL에 같은 조각이 있다.

  ```sql
  + (SELECT count(*) FROM parent_notifications n
     WHERE n.origin_session_id = ? AND NOT EXISTS (
       SELECT 1 FROM chat_runs r
       WHERE r.run_id = n.delivered_to_run_id AND r.status <> 'running'))
  ```

- `packages/memory-agent/tests/golden/rows.ts:255-258`: golden에 들어가는 알림 행.

  ```ts
    notifications: yield* rows(
      `SELECT task_id, parent_run_id, kind, summary, payload, delivered_to_run_id
       FROM parent_notifications WHERE origin_session_id = ? ORDER BY seq`,
      sessionId,
    ),
  ```

- `packages/memory-agent/tests/work-trace-lifecycle.test.ts`: `190`, `339`, `377`, `503`이 표를 SQL로 읽고,
  `244-252`가 `wakingParentNotificationSessions`와 `consumeParentNotifications`를 부른다. `19`의 layer는
  `Layer.merge(database, WorkTraceStore.layer.pipe(Layer.provide(database)))`다.
- `packages/memory-agent/tests/work-trace-stream.test.ts:258`: `consumeParentNotifications`를 부른다.
- `packages/memory-agent/tests/agents/subagents.test.ts:537-541`: 표를 SQL로 읽는다.
- `packages/memory-agent/tests/agents/async-subagents.test.ts`: `162-167`(`deliveredCompletions`),
  `250-254`가 표를 SQL로 읽는다. `446`, `573-579`가 `wakingParentNotificationSessions`를, `534-552`가
  `notifyParent`의 반환값과 `consumeParentNotifications`를 쓴다.
- `packages/memory-agent/tests/deleted-conversation-trace-migration.test.ts:66`,
  `packages/memory-agent/tests/background-tasks-migration.test.ts:108-114`: 옛 단계까지 적용한 DB에 행을 넣고
  `migrateDatabase(db)`로 끝까지 올린 뒤 `parent_notifications`의 개수가 0인지 본다.
- `packages/memory-agent/src/agent/orchestrator-message.test.ts:8-23`: `ParentNotificationView`를 만드는
  helper `notification`이 있다.

### 지킬 규칙 (`AGENTS.md`, `CLAUDE.md`에서)

- `let`, `while`을 쓰지 않는다. 반복은 Effect·Array combinator로 쓴다.
- Effect v4 표준 방식으로 쓴다. 의미 없는 `(x) => f(x)` 감싸기를 하지 않는다.
- `unknown` 타입을 쓰지 않는다. lint를 끄는 주석을 쓰지 않는다.
- 형식만 바꾸는 수정(줄바꿈 다시 하기, 주석 다시 감싸기)을 하지 않는다.
- 추적되는 파일을 진단용으로 잠깐 고쳤다 되돌리지 않는다.
- 이름·주석·문서·commit 메시지에는 쉬운 말을 쓴다. 새로 지어낸 용어를 쓰지 않는다.
- 코드의 주석은 영어, 문서(`docs/`, `README.md`)는 한국어다. 지금 파일들이 그렇다.

## Commands you will need

| 목적             | 명령                                                                     | 기대             |
| ---------------- | ------------------------------------------------------------------------ | ---------------- |
| 새 worktree 준비 | 루트에서 `vp install`, 그다음 `vp run turbovec#build`                    | exit 0           |
| typecheck (서버) | 루트에서 `vp run memory-agent#typecheck`                                 | exit 0           |
| typecheck (화면) | 루트에서 `vp run agent#typecheck`                                        | exit 0           |
| lint             | 루트에서 `vp lint` (`agent#typecheck` 뒤에)                              | exit 0           |
| 테스트           | `cd packages/memory-agent && vp test run --maxWorkers=4 <파일들>`        | 모두 통과        |
| golden 고치기    | `cd packages/memory-agent && vp test run --maxWorkers=4 tests/golden -u` | 아래 Step 5 참고 |

전체 suite는 돌리지 않는다. 이 계획의 **고른 테스트**는 아래다.

```
tests/sessions tests/agent tests/agents tests/chat tests/golden
src/agent/orchestrator-message.test.ts
tests/work-trace-lifecycle.test.ts tests/work-trace-stream.test.ts
tests/work-trace-provenance.test.ts tests/work-trace-resume.test.ts
migration
tests/db-migrator-metadata.test.ts tests/database.test.ts tests/upgrade-0.0.17.test.ts
```

`migration`은 경로에 그 글자가 든 테스트 파일 전부다(`tests/*-migration.test.ts`,
`tests/work-trace-migrations.test.ts` 등 20여 개). 여러 파일이 DB를 끝 단계까지 올리므로 새 단계가 거기서도
돈다.

부하 때문에 `Hook timed out in 10000ms`로 한 파일이 떨어지면 그 파일만 다시 돌린다. 같은 단언에서 두 번
떨어지면 진짜 실패다.

## Scope

**고치는 파일** (모두 `packages/memory-agent/` 아래, `docs/decisions.md`만 루트 아래):

- `src/work-trace/task-status.ts` (새 파일)
- `src/sessions/orchestrator-notifications.ts`
- `src/work-trace/store.ts`
- `src/subagents/subagents.ts` (`transitionAttempt`를 부르는 여섯 곳의 인자 하나만)
- `src/agent/task-notifications.ts`
- `src/agent/orchestrator-message.ts`, `src/agent/orchestrator-message.test.ts`
- `src/agent/chat.ts` (위 "Current state"에 적은 네 군데만)
- `src/db/migrations.ts` (단계 하나를 더한다. 옛 단계는 고치지 않는다)
- `src/index.ts` (`ParentNotificationView`를 내보내고 있으면 그 줄만)
- `tests/task-status-notifications-migration.test.ts` (새 파일)
- `tests/agent/task-status-delivery.test.ts` (새 파일)
- `tests/sessions/orchestrator-notifications.test.ts`
- `tests/work-trace-lifecycle.test.ts`, `tests/work-trace-stream.test.ts`
- `tests/agents/subagents.test.ts`, `tests/agents/async-subagents.test.ts`, `tests/agents/agent-env.ts`
- `tests/golden/driver.ts`, `tests/golden/rows.ts`, `tests/golden/__golden__/*.json`(Step 5-9가 허락한 차이만)
- `tests/deleted-conversation-trace-migration.test.ts`, `tests/background-tasks-migration.test.ts`
- `eval/live-delegation.ts`, `eval/tool-use.ts`, `eval/README.md`
- `src/work-trace/README.md`, `src/sessions/README.md`, `src/agent/README.md`, `src/subagents/README.md`
- `docs/decisions.md` (끝에 항목 하나를 더한다)

typecheck가 위에 없는 테스트 파일에서 `transitionAttempt`의 여덟째 인자나 없어진 메서드 때문에 깨지면 그
파일도 같은 방식으로 고치고 보고에 적는다.

**건드리지 않는 것**:

- 표 `parent_notification_holds`와 `holdParentNotifications`, `resumeParentNotifications`,
  `parentNotificationsHeld`.
- `migrations.ts`의 옛 단계들(`parent_notifications`를 만들고 고치는 단계 포함). `tests/fixtures/`.
- `tools/background.ts`와 끝난 백그라운드 작업의 동작.
- `dispatches.ts`, `dispatch-notifications.ts`.
- 보드의 호출(`chat.ts`의 `kanbanAttention`).
- 모델에게 보이는 알림 줄의 꼴. `Notification <id>; task <taskId>; <kind>: <summary>; <JSON>` 그대로다. id의
  값만 달라진다.
- `plans/` 아래의 모든 파일.

## Git workflow

지금 checkout의 branch에서 일한다. commit은 셋이다. commit마다 두 typecheck가 통과해야 한다.

1. Step 1 (`feat(sessions): …`)
2. Step 2–5 함께 (`refactor(work-trace): …`). 하나라도 빠지면 build가 깨진다.
3. Step 6 (`docs: …`)

메시지는 한국어 conventional commit이다. 끝에 이 줄을 붙인다.

```
Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
```

commit hook이 `vp check --fix`를 돌려 파일을 다시 정리할 수 있다. 그 결과는 그대로 둔다. push, merge, PR은
하지 않는다.

## Steps

### Step 1: 알림 표가 하위 작업의 상태 알림을 담게 한다

동작은 아직 바뀌지 않는다. 담을 수 있게만 한다.

**1-1. 새 파일 `packages/memory-agent/src/work-trace/task-status.ts`**

```ts
import { Schema } from "effect";
import { JsonValue } from "../json.ts";

/** What a Work Trace task's status change reports. */
export const TaskStatusKind = Schema.Literals([
  "stopped",
  "interrupted",
  "archived",
  "deleted",
  "resume_blocked",
  "resumed",
  "completed",
  "failed",
]);
export type TaskStatusKind = typeof TaskStatusKind.Type;

/**
 * A Work Trace task's status change, as the orchestrator's notifications keep it until the model
 * answers the message that tells it.
 */
export const TaskStatusChange = Schema.TaggedStruct("TaskStatus", {
  taskId: Schema.String,
  /** The run that started the task: a chat run, or one of the kanban board's (`isBoardRun`). */
  parentRunId: Schema.String,
  kind: TaskStatusKind,
  summary: Schema.String,
  /** What the change carries besides its words, such as the attempt and why it failed. */
  detail: Schema.Record(Schema.String, JsonValue),
});
export type TaskStatusChange = typeof TaskStatusChange.Type;

/** A status change with the id of the notification that carries it. */
export type TaskStatusNotification = TaskStatusChange & { readonly id: string };
```

**1-2. `packages/memory-agent/src/sessions/orchestrator-notifications.ts`**

(a) import를 더한다.

```ts
import { TaskStatusChange } from "../work-trace/task-status.ts";
```

(b) `notificationPayloads`의 주석과 `task`를 바꾼다.

```ts
/**
 * What each sender's message carries. Only the senders listed here are stored and read; a sender
 * that moves to the table adds its key. `task` carries the end of a background task or the status
 * change of a Work Trace task; the payload's tag says which.
 */
export const notificationPayloads = {
  conversation: ConversationMessage,
  task: Schema.Union([BackgroundTaskEnd, TaskStatusChange]),
} as const;
```

(c) `isoNow`를 `make` 밖으로 옮긴다. `make` 바로 위(`const make = Effect.gen(` 앞)에 그대로 둔다. `make`
안의 정의는 지운다.

(d) `insertOnce`를 `make` 밖의 함수로 옮기고, Work Trace 저장소가 쓸 쓰기 둘을 내보낸다. `isoNow` 아래,
`make` 위에 둔다.

```ts
/** The statement that stores a row unless a row with its id is there already; that row stays as it is. */
const insertOnceWith = (sql: SqlClient.SqlClient) =>
  SqlSchema.void({
    Request: NotificationRow,
    execute: (row) => sql`
      INSERT INTO orchestrator_notifications (id, session_id, sender, delivery, payload, state,
        delivered_run_id, created_at, delivered_at)
      VALUES (${row.id}, ${row.session_id}, ${row.sender}, ${row.delivery}, ${row.payload},
        ${row.state}, ${row.delivered_run_id}, ${row.created_at}, ${row.delivered_at})
      ON CONFLICT(id) DO NOTHING`,
  });

/**
 * The writes the Work Trace store makes for its tasks' status changes, with its own connection, so
 * a change and its notification are stored in one transaction. They fail as the connection fails.
 */
export const taskStatusWrites = (sql: SqlClient.SqlClient) => {
  const insertOnce = insertOnceWith(sql);
  return {
    /**
     * Stores one waiting status change under `id` unless a row with that id is there already: that
     * row stays as it is, waiting or delivered.
     */
    putOnce: (entry: {
      readonly id: string;
      readonly sessionId: string;
      readonly delivery: MessageDelivery;
      readonly payload: TaskStatusChange;
    }) =>
      Effect.flatMap(isoNow, (now) =>
        insertOnce({
          id: entry.id,
          session_id: entry.sessionId,
          sender: "task",
          delivery: entry.delivery,
          payload: entry.payload,
          state: "waiting",
          delivered_run_id: null,
          created_at: now,
          delivered_at: null,
        }),
      ),
    /**
     * Takes the words out of a deleted task's status changes: their summary and detail. The rows
     * stay, so a change the model was not told yet is still told.
     */
    redact: SqlSchema.void({
      Request: Schema.String,
      execute: (taskId) => sql`
        UPDATE orchestrator_notifications
        SET payload = json_set(payload, '$.summary', 'Deleted task lifecycle notification',
          '$.detail', json('{}'))
        WHERE sender = 'task' AND json_extract(payload, '$._tag') = 'TaskStatus'
          AND json_extract(payload, '$.taskId') = ${taskId}`,
    }),
  };
};
```

`make` 안에서는 `const insertOnce = insertOnceWith(sql);`로 쓴다. `putOnce` 서비스 메서드는 그대로다.

`MessageDelivery`가 타입으로도 쓰이는지 확인한다(`./message-delivery.ts`가 같은 이름의 타입을 내보낸다).
타입이 없으면 `typeof MessageDelivery.Type`으로 쓴다.

**1-3. `packages/memory-agent/src/agent/task-notifications.ts`**

`task`의 payload가 이제 둘 중 하나라서 `payload.kind`, `payload.title`, `payload.status`가 typecheck에서
깨진다. 이 단계에서는 끝난 백그라운드 작업만 고르게 한다. `consume`의 `background`를 이렇게 바꾼다.

```ts
      background: Effect.map(
        notifications.untold(sessionId, "task", toldIn(conversation).told),
        (entries) =>
          entries.flatMap(({ payload }): BackgroundEnd[] =>
            payload._tag === "BackgroundEnd"
              ? [
                  {
                    taskId: payload.taskId,
                    parentRunId: payload.parentRunId,
                    kind: payload.kind,
                    title: payload.title,
                    status: payload.status,
                  },
                ]
              : [],
          ),
      ),
```

같은 까닭으로 깨지는 다른 곳이 있으면(`rg -n 'sender: "task"|"task"\)' packages/memory-agent/src packages/memory-agent/tests`
로 찾는다) 같은 방식으로 `_tag`를 보고 고른다.

**1-4. 테스트: `packages/memory-agent/tests/sessions/orchestrator-notifications.test.ts`**

이 파일의 기존 테스트가 서비스와 SQL을 쓰는 방식을 그대로 따라 둘을 더한다.

- "keeps a task's status change and gives it to the task sender's reader": `putOnce`로 `sender: "task"`,
  payload `{ _tag: "TaskStatus", taskId: "t-1", parentRunId: "run-1", kind: "completed", summary: "Done",
  detail: { attemptId: "a-1" } }`인 행을 넣고, `untold(sessionId, "task", HashSet.empty())`가 그 payload를
  그대로 돌려주는지 본다.
- "taskStatusWrites stores a change once and redacts a deleted task's words": 이 테스트의 `SqlClient`로
  `taskStatusWrites(sql)`을 만든다. 같은 id로 `putOnce`를 두 번 불러 행이 하나인지 본다. `redact("t-1")` 뒤
  payload의 `summary`가 `"Deleted task lifecycle notification"`, `detail`이 `{}`이고, 다른 task의 행과
  `BackgroundEnd` 행은 그대로인지 본다.

**Verify**:

```
vp run memory-agent#typecheck        # exit 0
vp run agent#typecheck               # exit 0
vp lint                              # exit 0
cd packages/memory-agent && vp test run --maxWorkers=4 tests/sessions tests/agents/background-tasks.test.ts
```

모두 통과하면 commit 1을 만든다.

### Step 2: 옛 표의 행을 옮기는 migration

`packages/memory-agent/src/db/migrations.ts`에서 `notificationClaimsDropMigration`의 정의 바로 뒤에 둔다.

```ts
/** The step that moves the status changes of Work Trace tasks into the orchestrator's notifications. */
export const taskStatusNotificationsMigration = `
  -- A Work Trace task's status change is told through the orchestrator's notifications like every
  -- other thing the app hands a conversation's model (decisions.md "하위 작업의 상태 알림을
  -- orchestrator notifications에 둔다"). A row keeps the key that made it unique as its id. What a
  -- run took is settled once, as the step that dropped the claims settled them: a row taken by a
  -- run that completed or waits for the user is delivered, every other row waits. A row whose
  -- conversation is gone has no one to tell and does not move. OR IGNORE keeps a row the table
  -- cannot hold from stopping the app's start.
  INSERT OR IGNORE INTO orchestrator_notifications (id, session_id, sender, delivery, payload,
    state, delivered_run_id, created_at, delivered_at)
  SELECT n.idempotency_key, n.origin_session_id, 'task', t.delivery,
    json_object('_tag', 'TaskStatus', 'taskId', n.task_id, 'parentRunId', n.parent_run_id,
      'kind', n.kind, 'summary', n.summary,
      'detail', json(CASE WHEN json_type(n.payload) = 'object' THEN n.payload ELSE '{}' END)),
    CASE WHEN r.run_id IS NULL THEN 'waiting' ELSE 'delivered' END,
    CASE WHEN r.run_id IS NULL THEN NULL ELSE n.delivered_to_run_id END,
    strftime('%Y-%m-%dT%H:%M:%fZ', n.created_at / 1000.0, 'unixepoch'),
    CASE WHEN r.run_id IS NULL THEN NULL
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(n.delivered_at, n.created_at) / 1000.0,
        'unixepoch') END
  FROM parent_notifications n
  JOIN work_tasks t ON t.id = n.task_id
  JOIN sessions s ON s.id = n.origin_session_id
  LEFT JOIN chat_runs r ON r.run_id = n.delivered_to_run_id
    AND r.status IN ('completed', 'interrupted')
  ORDER BY n.seq;
  DROP TABLE parent_notifications;
`;
```

`migrations` 배열의 끝(`notificationClaimsDropMigration,` 뒤, 또는 그 뒤에 다른 단계가 있으면 맨 끝)에
`taskStatusNotificationsMigration,`을 더한다.

**새 테스트 `packages/memory-agent/tests/task-status-notifications-migration.test.ts`**

`packages/memory-agent/tests/notification-claims-drop-migration.test.ts`를 본으로 삼는다(같은 import, 같은
`database`, `migrations.indexOf(...)`까지 적용, `PRAGMA foreign_keys = OFF`로 단계 실행 뒤 `ON`). 넣는 행:

- project `p`, session `s`.
- `chat_runs`(`run_id, thread_id, status, started_at`): `('run-done', 's', 'completed', 1)`,
  `('run-waits', 's', 'interrupted', 1)`, `('run-failed', 's', 'failed', 1)`.
- `work_tasks` 둘: `t-wake`(`parent_run_id` `'run-1'`, `delivery` `'wake'`), `t-board`(`parent_run_id`
  `'kanban:g:S1:1'`, `delivery` `'next_run'`). 둘 다 `origin_session_id` `'s'`. 열 목록은
  `packages/memory-agent/tests/background-tasks-migration.test.ts:24-33`의 `INSERT INTO work_tasks`에서
  시작하고 `delivery`를 더한다. 그 사이에 `NOT NULL`이고 기본값이 없는 열이 더해져 insert가 실패하면 오류가
  말하는 열을 더한다.
- `parent_notifications` 여섯. 아래에 적지 않은 열은 모든 행이 같다. `project_id` `'p'`, `parent_run_id`는
  그 task의 것, `summary` `'S'`, `payload` `'{}'`, `created_at` `1000`, `delivered_to_run_id`와
  `delivered_at`은 NULL.
  - `k-waiting`: `t-wake`, `origin_session_id` `'s'`, `kind` `'completed'`, `payload`
    `'{"attemptId":"a-1"}'`.
  - `k-done`: `t-wake`, `'s'`, `'failed'`, `delivered_to_run_id` `'run-done'`, `delivered_at` `2000`.
  - `k-waits`: `t-wake`, `'s'`, `'resumed'`, `delivered_to_run_id` `'run-waits'`, `delivered_at` `2000`.
  - `k-failed-run`: `t-wake`, `'s'`, `'stopped'`, `delivered_to_run_id` `'run-failed'`, `delivered_at` `2000`.
  - `k-board`: `t-board`, `'s'`, `'completed'`.
  - `k-no-session`: `t-wake`, `origin_session_id` NULL, `'deleted'`.

  위 이름은 `idempotency_key`의 값이다. `id`는 `'n-' || idempotency_key`처럼 그것과 다른 값으로 넣는다. 옮긴
  행의 id가 `idempotency_key`인지 보려는 것이다.

단언:

- `SELECT id, session_id, sender, delivery, state, delivered_run_id FROM orchestrator_notifications ORDER BY id`
  가 다섯이다. `k-board`(`next_run`, `waiting`, null), `k-done`(`wake`, `delivered`, `run-done`),
  `k-failed-run`(`wake`, `waiting`, null), `k-waiting`(`wake`, `waiting`, null), `k-waits`(`wake`,
  `delivered`, `run-waits`). 모두 `session_id` `'s'`, `sender` `'task'`다.
- `k-waiting`의 `json_extract(payload, '$._tag')`가 `'TaskStatus'`, `'$.taskId'`가 `'t-wake'`,
  `'$.parentRunId'`가 `'run-1'`, `'$.kind'`가 `'completed'`, `'$.detail.attemptId'`가 `'a-1'`.
- `k-waiting`의 `created_at`이 `'1970-01-01T00:00:01.000Z'`, `k-done`의 `delivered_at`이
  `'1970-01-01T00:00:02.000Z'`.
- `SELECT name FROM sqlite_master WHERE name LIKE 'parent_notifications%'`가 빈 배열이다(표와 index 둘이
  모두 없다).
- `PRAGMA foreign_key_check`가 빈 배열이다.

### Step 3: Work Trace 저장소가 알림을 새 표에 넣는다

`packages/memory-agent/src/work-trace/store.ts`.

**3-1. import와 Schema**

`store.ts:5`의 `import { deliveryFor } from "../agent/notification-delivery.ts";`를
`import { deliveryFor, NotificationDelivery } from "../agent/notification-delivery.ts";`로 바꾼다
(`deliveryFor`는 다른 곳이 쓴다). 그리고 둘을 더한다.

```ts
import { taskStatusWrites } from "../sessions/orchestrator-notifications.ts";
import type { TaskStatusKind } from "./task-status.ts";
```

`store.ts:7`의 `import { optionalProperty } from "../optional-property.ts";`는 Step 3-4 뒤에 쓰는 곳이
없어진다. 지운다.

`NotificationTaskRow`를 이렇게 바꾼다.

```ts
const NotificationTaskRow = Schema.Struct({
  origin_session_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.String,
  delivery: NotificationDelivery,
});
```

`RecoveryRow`에 `delivery: NotificationDelivery,`를 더한다.

지운다: `ParentNotificationRow`, `decodeParentNotificationRows`, `decodeOriginSessions`, 인터페이스
`ParentNotificationView`. 지운 뒤 쓰는 곳이 없어진 다른 이름이 있으면(lint가 알려 준다) 그것도 지운다.
`decodePayload`와 `encodeJson`은 다른 곳이 쓰므로 둔다.

**3-2. 재시작 정리를 지운다**

`535-539`의 주석 두 줄과 `yield* run(sql\`UPDATE parent_notifications SET delivered_to_run_id = NULL …\`);`를
지운다. 그 자리에 `const taskStatus = taskStatusWrites(sql);`를 둔다.

**3-3. `notifyParent`**

```ts
/**
 * Leaves a task's status change for its conversation's model in the orchestrator's notifications,
 * once per `idempotencyKey`: the key is the notification's id, and a key left before stays as it
 * is. A task whose conversation is gone has no one to tell. Returns the id, or null when the
 * conversation is gone.
 */
const notifyParent = (input: {
  readonly taskId: string;
  readonly kind: TaskStatusKind;
  readonly summary: string;
  readonly idempotencyKey: string;
  readonly payload?: Readonly<Record<string, JsonValue>>;
}) =>
  Effect.gen(function* () {
    const task = yield* decodeNotificationTask(
      yield* first(sql`SELECT origin_session_id, parent_run_id, delivery FROM work_tasks
          WHERE id = ${input.taskId}`),
    );
    return yield* Option.match(Option.fromNullishOr(task.origin_session_id), {
      onNone: () => Effect.succeed(null),
      onSome: (sessionId) =>
        Effect.as(
          taskStatus.putOnce({
            id: input.idempotencyKey,
            sessionId,
            delivery: task.delivery,
            payload: {
              _tag: "TaskStatus",
              taskId: input.taskId,
              parentRunId: task.parent_run_id,
              kind: input.kind,
              summary: input.summary,
              detail: input.payload ?? {},
            },
          }),
          input.idempotencyKey,
        ),
    });
  }).pipe(sql.withTransaction);
```

`onNone`과 `onSome`의 반환 타입이 맞지 않는다고 typecheck가 말하면 `onNone`을
`Effect.succeed<string | null>(null)`로 쓴다.

**3-4. `transitionAttempt`**

여덟째 인자 `deliveredToRunId?: string`을 지운다. `detail`이 여덟째가 된다. 일곱째 인자 위에 주석을 단다.

```ts
    /**
     * Whether the tool result of the call that made the change tells the parent already. Then no
     * notification is left for it.
     */
    deliveredImmediately = true,
    detail: Readonly<Record<string, JsonValue>> = {},
```

알림을 넣는 곳을 이렇게 바꾼다.

```ts
const notificationKind = Option.filter(
  Option.fromNullishOr(notificationForAttempt[status]),
  (kind) => !deliveredImmediately && (kind !== "resumed" || handle.attemptNumber > 1),
);
yield *
  Option.match(notificationKind, {
    onNone: () => Effect.void,
    onSome: (kind) =>
      notifyParent({
        taskId: handle.taskId,
        kind,
        summary,
        idempotencyKey: `attempt:${handle.id}:${kind}`,
        payload:
          recorded === null
            ? { attemptId: handle.id }
            : { attemptId: handle.id, failure: recorded },
      }),
  });
```

**3-5. 재시작 복구(`recoveredAttempts`)**

select에 `t.delivery`를 더한다.

```ts
      yield* sql`SELECT a.id, a.task_id, t.project_id, t.origin_session_id, t.agent_id,
          t.parent_run_id, t.delivery
        FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
        WHERE a.status IN ('queued', 'running', 'waiting', 'blocked')`,
```

`INSERT INTO parent_notifications …` 문장 전체를 이렇게 바꾼다.

```ts
yield *
  Option.match(Option.fromNullishOr(row.origin_session_id), {
    onNone: () => Effect.void,
    onSome: (sessionId) =>
      taskStatus.putOnce({
        id: `recovery:${row.id}:interrupted`,
        sessionId,
        delivery: row.delivery,
        payload: {
          _tag: "TaskStatus",
          taskId: row.task_id,
          parentRunId: row.parent_run_id,
          kind: "interrupted",
          summary,
          detail: { attemptId: row.id, failure },
        },
      }),
  });
```

`now`는 그 위의 `UPDATE` 둘이 쓰므로 둔다. `crypto`는 다른 곳이 쓰므로 둔다. `RecoveryRow.project_id`는 더
읽히지 않지만 그대로 둔다.

**3-6. 읽기와 되돌리기를 지운다**

`releaseParentNotifications`와 `consumeParentNotifications`의 정의를 지운다. 서비스가 내보내는 객체에서
`consumeParentNotifications,`, `wakingParentNotificationSessions`(주석 포함), `releaseParentNotifications,`를
지운다.

**3-7. `purgeTask`와 대화를 지우는 곳의 주석**

`UPDATE parent_notifications SET summary = …` 문장을 `yield* taskStatus.redact(taskId);`로 바꾼다.

`1442-1444`의 주석에서 `notifications`를 뺀다. 알림은 이제 `sessions` 행이 지워질 때 같이 지워진다.

```ts
// Its Work Trace goes with it, also the tombstones of the tasks deleted above: no page shows a
// deleted conversation's tasks. Their attempts, events and artifacts cascade, and so do the
// receipts of their lifecycle operations. Their notifications go with the session's row.
```

**3-8. `packages/memory-agent/src/subagents/subagents.ts`**

`transitionAttempt`를 부르는 여섯 곳(`820-829`, `867-877`, `943-952`, `983-994`, `1179-1188`, `1413-1423`)에서
여덟째 인자 `binding.runId,` 한 줄만 지운다. `867-877`의 `optionalProperty("messageId", …)`는 그대로 남아
여덟째 인자가 된다. 다른 것은 고치지 않는다.

### Step 4: hook과 `chat.ts`가 새 표에서 읽는다

**4-1. `packages/memory-agent/src/agent/orchestrator-message.ts`**

- `import type { ParentNotificationView } from "../work-trace/store.ts";`를
  `import type { TaskStatusNotification } from "../work-trace/task-status.ts";`로 바꾼다.
- `TaskNotifications.tasks`의 타입을 `ReadonlyArray<TaskStatusNotification>`으로 바꾼다.
- `notificationLines`에서 `JSON.stringify(notification.payload)`를 `JSON.stringify(notification.detail)`로
  바꾼다. 줄의 나머지는 그대로다.
- `noTaskNotifications` 아래에 더한다.

  ```ts
  /** The ids of the orchestrator notifications that `notifications` tells. */
  export const toldIds = ({ tasks, background }: TaskNotifications) => [
    ...tasks.map((change) => change.id),
    ...background.map((end) => end.taskId),
  ];
  ```

- `notificationsMessageBody`의 `telling(notifications.background.map((end) => end.taskId))`를
  `telling(toldIds(notifications))`로 바꾼다.

**4-2. `packages/memory-agent/src/agent/task-notifications.ts`**

파일의 본문을 이렇게 바꾼다. import는 쓰는 것만 남긴다(`WorkTraceStore`, `finishedRun`은 더 쓰지 않는다).

```ts
type TaskEntry = Extract<NotificationEntry, { readonly sender: "task" }>;

/** The task sender's rows as the message builders read them: status changes and background ends. */
const fromEntries = (entries: ReadonlyArray<TaskEntry>): TaskNotifications => ({
  tasks: entries.flatMap(({ id, payload }) =>
    payload._tag === "TaskStatus" ? [{ ...payload, id }] : [],
  ),
  background: entries.flatMap(({ payload }): BackgroundEnd[] =>
    payload._tag === "BackgroundEnd"
      ? [
          {
            taskId: payload.taskId,
            parentRunId: payload.parentRunId,
            kind: payload.kind,
            title: payload.title,
            status: payload.status,
          },
        ]
      : [],
  ),
});

/**
 * What a parent session has not been told of: its Work Trace tasks' status changes and its
 * background tasks' ends. Both wait in the orchestrator's notifications (sender `task`): one its
 * conversation does not tell yet joins it, and once the run ended and saved its conversation, the
 * ones it delivered are marked delivered.
 */
export const taskNotifications = (services: {
  readonly notifications: OrchestratorNotifications["Service"];
  readonly crypto: SecureRandom.SecureRandom["Service"];
}) => {
  const { notifications, crypto } = services;
  const consume = (sessionId: string, conversation: ReadonlyArray<StoredMessage>) =>
    Effect.map(notifications.untold(sessionId, "task", toldIn(conversation).told), fromEntries);
  return {
    consume,
    /**
     * Whether the session has a notification that wakes it (`wake` delivery), unless the user
     * stopped its notifications. A `next_run` one waits for a run that starts anyway.
     */
    wakes: notifications.wakes,
    /**
     * Before each model call of the run, the notifications its conversation does not tell yet join
     * it as the orchestrator's message. Once the run ended and saved its conversation, those it
     * delivered are marked delivered: all its conversation tells when it finished, else those the
     * model answered.
     */
    hookFor: (sessionId: string, runId: string): RunHook => ({
      joining: (_scope, conversation) =>
        consume(sessionId, conversation).pipe(
          Effect.flatMap((notifications: TaskNotifications) =>
            hasTaskNotifications(notifications)
              ? Effect.map(
                  Effect.flatMap(crypto.uuidV7(), notificationsMessage(notifications)),
                  (message): StoredMessage[] => [message],
                )
              : Effect.succeed<StoredMessage[]>([]),
          ),
          Effect.mapError(asRunFailed),
        ),
      ended: (_scope, end, conversation) =>
        notifications
          .heard(sessionId, runId, heardBy(end, conversation))
          .pipe(Effect.ignore({ log: "Warn" })),
    }),
  };
};
```

`NotificationEntry`는 `../sessions/orchestrator-notifications.ts`에서 타입으로 가져온다. root `vp lint`가
`_tag` 비교를 막으면 같은 가르기를 `Match.valueTags`로 쓴다. 동작은 같아야 한다.

**4-3. `packages/memory-agent/src/agent/chat.ts`**

네 군데만 고친다.

(a) `696-700`: `trace: workTrace,` 줄을 지운다.

(b) `1306-1317`: `notificationsToRelease`의 `Ref.make` 줄과
`yield* Effect.addFinalizer(() => Effect.flatten(Ref.get(notificationsToRelease)));` 줄을 지운다. 그 위 주석을
이렇게 둔다.

```ts
// What an early end must undo. The run takes over the cancellation and the steering once it
// is following its log.
```

(c) `runContext`:

- 주석의 마지막 문장을 이렇게 바꾼다.

  ```ts
         * automatic run started. A notification waits until the model answers the message that
         * tells it.
  ```

- 알림을 읽는 곳을 이렇게 바꾼다.

  ```ts
  const parentNotifications =
    yield *
    EffectArray.match(followup, {
      onEmpty: () => Effect.succeed(noTaskNotifications),
      onNonEmpty: () =>
        Effect.flatMap(runStore.thread(sessionId), (stored) =>
          notifications.consume(sessionId, stored),
        ),
    });
  ```

- `telling(parentNotifications.background.map((end) => end.taskId))`를
  `telling(toldIds(parentNotifications))`로 바꾼다. `toldIds`를 `./orchestrator-message.ts`의 import에 더한다.

(d) `2386`: `yield* Ref.set(notificationsToRelease, Effect.void);` 줄을 지운다.

`logFailure` 같은 import가 이 때문에 안 쓰이게 되면 지운다. `workTrace` 변수는 다른 곳이 쓰므로 둔다.

**4-4. `packages/memory-agent/src/index.ts`**

`ParentNotificationView`를 내보내는 줄이 있으면 지운다. 없으면 고치지 않는다.

**Verify (Step 2–4 뒤)**:

```
vp run memory-agent#typecheck
```

`src/` 아래의 오류가 없어야 한다. `tests/`와 `eval/`의 오류는 Step 5에서 고친다.

### Step 5: 테스트와 eval을 새 표에 맞춘다

옛 표를 SQL로 읽던 곳은 이 대응으로 바꾼다. `TaskStatus` 행만 고르는 조건은
`sender = 'task' AND json_extract(payload, '$._tag') = 'TaskStatus'`다.

| 옛것                           | 새것                                        |
| ------------------------------ | ------------------------------------------- |
| `FROM parent_notifications`    | `FROM orchestrator_notifications` + 위 조건 |
| `origin_session_id = ?`        | `session_id = ?`                            |
| `task_id = ?`                  | `json_extract(payload, '$.taskId') = ?`     |
| `kind`                         | `json_extract(payload, '$.kind')`           |
| `summary`                      | `json_extract(payload, '$.summary')`        |
| `json_extract(payload, '$.x')` | `json_extract(payload, '$.detail.x')`       |
| `delivered_at IS NULL`         | `state = 'waiting'`                         |
| `delivered_at IS NOT NULL`     | `state = 'delivered'`                       |
| `delivered_to_run_id`          | `delivered_run_id`                          |
| `ORDER BY seq`                 | `ORDER BY rowid`                            |

`SELECT kind`처럼 열을 그대로 읽어 `toEqual({ kind: … })`로 비교하는 곳은 `json_extract(payload, '$.kind') AS
kind`처럼 같은 이름을 붙인다.

**5-1. 가라앉았는지 보는 SQL 넷** (`tests/agents/agent-env.ts`, `tests/golden/driver.ts`,
`eval/live-delegation.ts`, `eval/tool-use.ts`)

"Current state"에 적은 조각을 이렇게 바꾼다. `?`는 그 파일이 쓰는 방식(`?` 또는 `${sessionId}`)을 따른다.

```sql
+ (SELECT count(*) FROM orchestrator_notifications n
   WHERE n.session_id = ? AND n.sender = 'task'
     AND json_extract(n.payload, '$._tag') = 'TaskStatus' AND n.state = 'waiting')
```

넘기는 인자의 개수는 그대로다(조각마다 `sessionId` 하나).

그 SQL 위의 주석도 맞춘다. 알림은 이제 run이 끝난 뒤에 전한 것으로 적힌다.

- `tests/agents/agent-env.ts:82-87`: "every notification reached a run that ended. A follow-up takes its
  notifications before it counts as live, and a run ends after its record says so, so both …"를
  "no status change waits to be told. A change is marked delivered once the run that told it ended, and a
  run ends after its record says so, so both …"로 바꾼다. 문장의 나머지는 그대로다.
- `tests/golden/driver.ts:91-95`: "every child's notification reached a run that ended"를 "no child's status
  change waits to be told"로 바꾼다.
- `eval/live-delegation.ts:85-89`: 마지막 문장 "A follow-up takes its notifications before its run is
  recorded, so each must have reached a run that ended."를 "A status change is marked delivered once the
  run that told it ended, so none may wait."로 바꾼다.

**5-2. `tests/golden/rows.ts`**

golden의 `notifications` 행이 같은 열 이름을 갖게 한다.

```ts
    notifications: yield* rows(
      `SELECT json_extract(payload, '$.taskId') AS task_id,
         json_extract(payload, '$.parentRunId') AS parent_run_id,
         json_extract(payload, '$.kind') AS kind, json_extract(payload, '$.summary') AS summary,
         json_extract(payload, '$.detail') AS payload, delivered_run_id AS delivered_to_run_id
       FROM orchestrator_notifications
       WHERE session_id = ? AND sender = 'task' AND json_extract(payload, '$._tag') = 'TaskStatus'
       ORDER BY rowid`,
      sessionId,
    ),
```

**5-3. `tests/work-trace-lifecycle.test.ts`, `tests/work-trace-stream.test.ts`**

- layer에 알림 서비스를 더한다(두 파일 모두 같은 `testLayer`다).

  ```ts
  const testLayer = () => {
    const database = Database.layer(":memory:");
    return Layer.mergeAll(
      database,
      WorkTraceStore.layer.pipe(Layer.provide(database)),
      OrchestratorNotifications.layer.pipe(Layer.provide(database)),
    );
  };
  ```

  `OrchestratorNotifications`는 `../src/sessions/orchestrator-notifications.ts`에서, `HashSet`은 `effect`에서
  가져온다. `lifecycle:21-23`의 `run`은 프로그램이 요구하는 것을 `SqlClient.SqlClient | WorkTraceStore`로
  적어 두었다. `| OrchestratorNotifications`를 더한다. `stream`의 `run`은 고칠 필요가 없다.

- `lifecycle:190`, `339`, `377`: 위 대응표로 SQL을 바꾼다. `ORDER BY seq DESC LIMIT 1`은
  `ORDER BY rowid DESC LIMIT 1`이다.
- `lifecycle:244-252`:

  ```ts
  const told = yield * OrchestratorNotifications;
  yield * finish(yield * startFrom("kanban:g:S1:1"));
  expect(yield * told.wakes("s1")).toBe(false);
  yield * finish(yield * startFrom("parent-1"));
  expect(yield * told.wakes("s1")).toBe(true);
  // A run that starts anyway is given both.
  expect(
    (yield * told.untold("s1", "task", HashSet.empty()))
      .map(({ payload }) => payload.parentRunId)
      .toSorted(),
  ).toEqual(["kanban:g:S1:1", "parent-1"]);
  ```

  정렬해서 비교한다. 이 테스트의 시계는 멈춰 있어 두 알림의 `created_at`이 같고, 그때 순서는 id(무작위
  uuid가 든 키)를 따른다.

- `lifecycle:503`: 합에서 `(SELECT count(*) FROM parent_notifications)`를
  `(SELECT count(*) FROM orchestrator_notifications)`로 바꾼다.
- `stream:258`:

  ```ts
  expect(
    (yield * (yield * OrchestratorNotifications).untold("s1", "task", HashSet.empty())).flatMap(
      ({ payload }) => (payload._tag === "TaskStatus" ? [payload.kind] : []),
    ),
  ).toContain("failed");
  ```

- `lifecycle`에 테스트 하나를 더한다. 이름 "a change the caller's tool result tells leaves no notification":
  `transitionAttempt(handle, "s1", "running", "attempt_started", "Started")`, 이어서
  `transitionAttempt(handle, "s1", "completed", "attempt_completed", "Done")`(일곱째 인자 없이)를 부른 뒤
  `SELECT count(*) AS count FROM orchestrator_notifications`가 `{ count: 0 }`인지 본다. task를 만드는 방법은 같은
  파일의 `244` 근처 테스트(`startFrom`)를 따른다.

**5-4. `tests/agents/subagents.test.ts:537-541`**

```ts
              `SELECT json_extract(payload, '$.detail.failure.reason._tag') AS reason
             FROM orchestrator_notifications
             WHERE json_extract(payload, '$.taskId') = ?
               AND json_extract(payload, '$.kind') = 'interrupted'`,
```

**5-5. `tests/agents/async-subagents.test.ts`**

- `162-167`, `250-254`: 대응표로 바꾼다. 둘 다 `TaskStatus` 조건을 더한다.
- `446`: `expect(yield* (yield* current(OrchestratorNotifications)).wakes(sessionId)).toBe(false);`
- "reports survive restart and incomplete notification deliveries are replayable"(`522-557`): 이름을
  "reports survive restart and a notification no conversation tells yet is still given after it"로 바꾼다.
  `consumeParentNotifications` 둘을 이렇게 바꾼다. 읽기는 아무것도 쓰지 않으므로 재시작 뒤에도 그대로 준다.

  ```ts
  expect(
    (
      yield *
      (yield * current(OrchestratorNotifications)).untold(sessionId, "task", HashSet.empty())
    ).map((entry) => entry.id),
  ).toContain(notificationId);
  yield * env.reopen;
  expect(
    (
      yield *
      (yield * env.use(OrchestratorNotifications)).untold(sessionId, "task", HashSet.empty())
    ).map((entry) => entry.id),
  ).toContain(notificationId);
  ```

- "a held parent notification stays out of automatic follow-up after restart"(`559-581`):
  `trace.wakingParentNotificationSessions` 셋(`573`, `577`, `579`)을 `wakes(sessionId)`로 바꾼다. 재시작 앞의
  것은 `current(OrchestratorNotifications)`, 뒤의 둘은 `env.use(OrchestratorNotifications)`에서 얻는다.
  기대값은 차례로 `false`, `false`, `true`다. `expect(notificationId).not.toBeNull()`은 그대로 둔다.
- `OrchestratorNotifications`는 이 파일이 다른 것을 가져오는 방식대로
  `../../src/sessions/orchestrator-notifications.ts`에서 가져온다.
- `deliveredCompletions`를 바로 `expect`하는 테스트가 있다. 전한 것으로 적는 때가 "읽는 순간"에서 "run이 끝난
  뒤"로 바뀌었다. 그 `expect`가 떨어지면 같은 파일의 `until(…)`로 기다리게 바꾼다. **run이 아직 도는 동안에
  전한 것으로 적혀 있기를 기대하는 테스트가 있으면 STOP이다**(동작과 테스트가 맞지 않는다).

**5-6. 옛 migration 테스트 둘**

- `tests/deleted-conversation-trace-migration.test.ts:66`:
  `SELECT count(*) AS n FROM parent_notifications`를 `SELECT count(*) AS n FROM orchestrator_notifications`로
  바꾼다. 기대값은 그대로 `{ n: 0 }`이다.
- `tests/background-tasks-migration.test.ts:108-114`: 합에서 `(SELECT count(*) FROM parent_notifications)`를
  `(SELECT count(*) FROM orchestrator_notifications WHERE json_extract(payload, '$._tag') = 'TaskStatus')`로
  바꾼다. 기대값은 그대로 `{ n: 0 }`이다.

**5-7. `src/agent/orchestrator-message.test.ts`**

helper `notification`이 `TaskStatusNotification`을 만들게 한다.

```ts
const notification = (
  taskId: string,
  parentRunId: string,
  kind: TaskStatusNotification["kind"] = "completed",
): TaskStatusNotification => ({
  _tag: "TaskStatus",
  id: `n-${taskId}`,
  taskId,
  parentRunId,
  kind,
  summary: "Subagent completed",
  detail: {},
});
```

부르는 곳에서 셋째 인자(`agentName`)를 뺀다. 테스트 하나를 더한다. "toldIds lists the status changes and the
background ends": `toldIds({ tasks: [notification("t-1", "run-1")], background: [{ taskId: "b-1", … }] })`가
`["n-t-1", "b-1"]`이다. `background`의 값은 같은 파일의 기존 테스트가 만드는 방식을 따른다.

**5-8. 새 테스트 `tests/agent/task-status-delivery.test.ts`**

`packages/memory-agent/tests/agent/dispatch-delivery.test.ts`를 본으로 삼는다(같은 `testAgent()`, `scriptedRun`,
`RunStore`, `sqlGet`, `messageText`). hook은 이렇게 만든다.

```ts
const told = Effect.map(
  Effect.all({ notifications: OrchestratorNotifications, crypto: SecureRandom.SecureRandom }),
  taskNotifications,
);
```

알림은 서비스로 직접 넣는다.

```ts
const leaveChange = (sessionId: string, id: string, summary: string) =>
  Effect.flatMap(OrchestratorNotifications, (notifications) =>
    notifications.putOnce({
      id,
      sessionId,
      sender: "task",
      delivery: "wake",
      payload: {
        _tag: "TaskStatus",
        taskId: `task-of-${id}`,
        parentRunId: "parent-run",
        kind: "completed",
        summary,
        detail: {},
      },
    }),
  );
```

테스트 셋. 대화는 `Sessions.create(project.id)`로 테스트마다 하나 만든다.

1. "a run is told the waiting status change and delivers it when it finishes": `turns: [{ text: "확인." }]`.
   저장된 대화의 orchestrator 메시지 글에 `summary`가 있고 `toldNotifications`가 `[id]`다. 행은 `delivered`,
   `delivered_run_id`는 그 run이다.
2. "a run whose model call fails leaves the change in the conversation, and the next run hears it without
   being told again": 첫 run은 `turns: [{ failAfterText: "모델이 실패했습니다." }]`. 행은 `waiting`이다. 저장된
   대화에 그 글을 가진 orchestrator 메시지가 하나다. 다음 run은 저장된 대화에 사용자 메시지 하나를 더해
   `turns: [{ text: "확인했습니다." }]`로 돈다. 그 run의 `invocations[0].history`에 그 메시지가 하나뿐이고,
   행은 `delivered`, `delivered_run_id`는 다음 run이다.
3. "a run that fails after the model answered keeps the change delivered": `turns`가 도구 호출 하나
   (`{ toolCalls: [{ id: "call-1", name: "find_memory", arguments: '{"query":"결정"}' }] }`)와
   `{ failAfterText: "둘째 단계에서 실패." }`다. 행은 `delivered`다.

**5-9. golden**

먼저 `-u` 없이 돌린다.

```
cd packages/memory-agent && vp test run --maxWorkers=4 tests/golden
```

떨어지는 것이 있으면 차이를 읽는다. 허락하는 차이는 다섯뿐이다. 지금 알림 행이 있는 golden은
`named-subagent.json` 하나다.

1. orchestrator 메시지의 `toldNotifications`에 하위 작업 알림의 id가 더해진다(키가 새로 생기거나 배열이
   길어진다).
2. 메시지 글 `Notification <id>;`의 id와 그 id를 가리키는 자리의 값이 달라진다. uuid 하나에서
   `attempt:<id>:<kind>` 같은 키 꼴로 바뀐다.
3. `notifications` 행 가운데 `delivered_to_run_id`가 처음부터 채워져 있던 행(도구 결과가 이미 전한 것)이
   없어진다.
4. `notifications` 행의 `delivered_to_run_id`가 달라진다. 실패하거나 취소된 run이 들은 것은 `null`로 남는다.
5. `<id-N>`의 번호가 당겨진다. golden은 uuid를 처음 나온 순서대로 `<id-1>`, `<id-2>`…로 바꾼다
   (`tests/golden/rows.ts:56-73`). 전에는 알림이 자기 uuid를 가져 번호 하나를 썼다. 이제 알림의 id는 이미
   나온 attempt의 uuid로 만든 키라서 번호를 쓰지 않는다. 그래서 첫 알림 뒤의 번호는 1씩, 둘째 알림 뒤는
   2씩 작아진다. 파일의 많은 줄이 바뀌지만 **번호만** 바뀐다. 같은 것을 가리키던 자리들은 여전히 같은
   번호를 가진다.

다섯 밖의 차이가 있으면 **STOP**이다. 다섯뿐이면 고친다.

```
cd packages/memory-agent && vp test run --maxWorkers=4 tests/golden -u
```

돈 파일 수를 본다. golden 밖의 파일까지 돌았으면 snapshot이 바뀐 파일이 `tests/golden/__golden__/` 아래뿐인지
`git status --short`로 확인한다. `git diff -- packages/memory-agent/tests/golden/__golden__`를 다시 읽어
다섯 밖의 차이가 없는지 확인하고, 차이의 종류마다 예 하나를 보고에 적는다.

**Verify (Step 5 뒤)**:

```
vp run memory-agent#typecheck        # exit 0
vp run agent#typecheck               # exit 0
vp lint                              # exit 0
cd packages/memory-agent && vp test run --maxWorkers=4 <고른 테스트>
```

모두 통과하면 commit 2를 만든다.

### Step 6: 문서

**6-1. `docs/decisions.md`의 끝에 항목을 더한다.**

```md
## 하위 작업의 상태 알림을 orchestrator notifications에 둔다 (2026-11-26)

- 계기: 사용자가 알림 넷(끝난 하위 작업, 끝난 백그라운드 작업, 다른 대화가 남긴 메시지, 보드의 호출)이 규칙
  하나를 따른다고 정했다(2026-11-23). "알림은 대화에 한 번 넣고, 모델이 답하면 전한 것으로 적는다
  (2026-11-25)"가 그 규칙을 바꿨고, 끝난 백그라운드 작업과 다른 대화가 남긴 메시지가 따른다. 하위 작업의 상태
  알림은 표 `parent_notifications`에서 옛 방식으로 돌았다. run이 읽는 순간 전한 것으로 적고, 실패하면
  되돌리고, 재시작할 때 따로 되돌렸다. 실패한 run 뒤에 같은 알림이 새 메시지로 한 번 더 들어갔다.
- 결정: 하위 작업의 상태 알림을 `orchestrator_notifications`에 둔다. 보낸 쪽은 `task`, payload의 태그는
  `TaskStatus`다. 2026-11-25의 규칙을 그대로 따른다.
- 코드:
  - 표 `parent_notifications`를 없앴다(`taskStatusNotificationsMigration`). 옛 행은 옮겼다. `completed`나
    `interrupted`로 끝난 run이 들은 행은 전한 것으로, 나머지는 기다리는 것으로 옮겼다(2026-11-23의 기준. 계획
    037의 단계와 같다). 대화가 없어진 행은 옮기지 않았다.
  - 알림의 id는 한 번만 넣으려고 쓰던 키(`attempt:<attempt id>:<kind>` 등)다.
  - `WorkTraceStore`에서 `consumeParentNotifications`, `releaseParentNotifications`,
    `wakingParentNotificationSessions`, 시작할 때의 되돌리기를 지웠다. `notifyParent`는 상태를 적는
    transaction 안에서 알림을 넣는다(`taskStatusWrites`).
  - `AgentChat.start`의 finalizer(계획 036)를 지웠다. 되돌릴 것이 없다.
- 달라진 동작:
  - 모델 호출이 실패한 run 뒤에 같은 알림이 새 메시지로 다시 들어가지 않는다.
  - 사용자가 멈춘 대화는 사용자의 다음 메시지가 올 때까지 하위 작업의 알림도 받지 않는다. 전에는 승인 뒤에
    이어 도는 run처럼 사용자 메시지 없이 도는 run이 받았다. 2026-11-23의 3번과 같아졌다.
  - 재시작한 뒤에 `interrupted`(승인 대기)로 멈춘 run이 들은 알림을 다시 넣지 않는다. 전에는 하위 작업의
    알림만 `completed`가 아닌 run이 들은 것을 모두 되돌렸다.
  - 한 메시지 안에서 알림의 순서가 넣은 순서가 아니라 넣은 시각, 그다음 id의 순서다. 같은 밀리초에 넣은 둘은
    id의 글자 순서로 나온다.
  - 이 방식으로 바꾸기 전에 저장된 알림 메시지에는 id가 없다. 그때 기다리던 알림은 한 번 더 들어갈 수 있다.
- 내 기본값(사용자가 정한 것이 아니다): 부르는 쪽의 도구 결과가 이미 전하는 상태 변화
  (`transitionAttempt`의 `deliveredImmediately`)는 알림으로 남기지 않는다. 전에는 처음부터 전한 것으로 적은
  행을 남겼고, 그 run이 실패하거나 앱이 다시 시작하면 그 행도 되돌려져 다음 run에게 전해졌다. 지금 코드에서
  해당하는 것은 없어진 subagent의 재시도를 거두는 `stopped` 하나다(`subagents.ts`의 "Subagent no longer
  exists").
- 아직 이 방식이 아닌 것: 보드의 호출.

구현: 계획 039.
```

**6-2. README**

- `packages/memory-agent/src/work-trace/README.md`: `13`의 "부모 알림 메서드" 목록에서
  `consumeParentNotifications`, `wakingParentNotificationSessions`, `releaseParentNotifications`를 빼고,
  `notifyParent`가 알림을 `orchestrator_notifications`에 넣는다는 한 문장을 더한다. `19`에서
  `ParentNotificationView`를 뺀다. `task-status.ts`의 `TaskStatusKind`, `TaskStatusChange`,
  `TaskStatusNotification`을 한 줄로 더한다.
- `packages/memory-agent/src/sessions/README.md`: `notificationPayloads`를 설명하는 줄(`26`)에 `task`의
  payload가 `BackgroundEnd`와 `TaskStatus` 둘이라는 것을 적고, `taskStatusWrites`를 한 줄로 더한다.
- `packages/memory-agent/src/agent/README.md`: `taskNotifications`와 `TaskNotifications`를 설명하는 줄
  (`rg -n 'taskNotifications|TaskNotifications' packages/memory-agent/src/agent/README.md`)에서 Work Trace
  알림을 "잡고 돌려준다"는 말을 지우고 둘 다 orchestrator notifications에서 읽는다고 적는다. `toldIds`를 더한다.
- `packages/memory-agent/src/subagents/README.md:55`: "상태 알림을 대화에 넣고 돌려주는 일은"을 "상태 알림을
  대화에 넣는 일은"으로 바꾼다.
- `packages/memory-agent/eval/README.md`: `35`의 "아직 끝난 run에 전달되지 않은 parent_notifications"를 "아직
  전하지 않은 하위 작업의 상태 알림(`orchestrator_notifications`)"으로, `44`의 표 목록에서
  `parent_notifications`를 `orchestrator_notifications`로 바꾼다.

문장은 그 파일의 다른 줄과 같은 말투로 쓴다. 다른 줄은 고치지 않는다.

**Verify**: `vp lint`가 exit 0이다. commit 3을 만든다.

## Test plan

- 새 단위 테스트: `tests/sessions/orchestrator-notifications.test.ts` 둘(Step 1-4),
  `src/agent/orchestrator-message.test.ts` 하나(Step 5-7), `tests/work-trace-lifecycle.test.ts` 하나(Step 5-3).
- 새 migration 테스트: `tests/task-status-notifications-migration.test.ts`(Step 2).
- 새 전달 테스트: `tests/agent/task-status-delivery.test.ts` 셋(Step 5-8). 둘째가 이 계획이 고치는 버그를
  받친다(실패한 run 뒤에 알림 메시지가 하나뿐).
- 고친 테스트: Step 5의 나머지.
- golden: 허락한 다섯 가지 차이만.

## Done criteria

실행자가 시작한 HEAD를 `START`라 한다.

- [ ] `vp run memory-agent#typecheck`, `vp run agent#typecheck`, 루트 `vp lint`가 모두 exit 0.
- [ ] 고른 테스트가 모두 통과한다.
- [ ] `rg -n --hidden -g '!.git' -g '!node_modules' -g '!**/fixtures/**' 'parent_notifications\b' packages apps -g '!migrations.ts' -g '!*.md'`
      가 내는 줄은 migration 테스트(`tests/*-migration.test.ts`)의 것뿐이다.
- [ ] `rg -n 'consumeParentNotifications|releaseParentNotifications|wakingParentNotificationSessions|notificationsToRelease|ParentNotificationView' packages apps --hidden -g '!node_modules' -g '!*.md'`
      가 아무것도 내지 않는다.
- [ ] `rg -n 'taskStatusNotificationsMigration' packages/memory-agent/src/db/migrations.ts`가 두 줄(정의와
      배열)을 낸다.
- [ ] `git diff --stat START..HEAD`의 파일이 모두 Scope 안이다(Scope가 허락한 "깨진 테스트 파일"은 보고에
      적는다).
- [ ] `docs/decisions.md`의 끝이 새 항목이고 마지막 줄이 `구현: 계획 039.`다.

## STOP conditions

- Drift check에서 "Current state"와 실제 코드가 다르다.
- `parent_notifications`를 가리키는 표, trigger, view가 있다
  (`rg -n 'REFERENCES parent_notifications' packages/memory-agent/src/db/migrations.ts`가 내는 표 가운데 뒤의
  단계가 지우지 않은 것이 있다).
- `parent_notifications`를 전달 밖의 목적으로 읽는 코드가 있다(화면, 도구, 보고서).
- `notifyParent`나 `transitionAttempt`의 실패 타입이 바뀌어 부르는 쪽 여러 곳을 고쳐야 한다. 이 계획은 실패
  타입이 그대로(`SqlError | SchemaError | WorkTraceRejected`)라고 본다.
- golden에 허락한 다섯 밖의 차이가 있다.
- run이 아직 도는 동안에 알림이 전한 것으로 적혀 있기를 기대하는 테스트가 있다.
- Scope 밖의 파일을 고쳐야만 검사가 통과한다(위 "깨진 테스트 파일"은 빼고).
- 계획이 정하지 않은 동작을 골라야 한다. 고르지 말고 `NEEDS-DECISION:`으로 시작하는 줄에 선택지와 결과를
  적어 돌려준다.

## Maintenance notes

- 알림의 순서는 `created_at`, `id`다. 같은 밀리초에 넣은 하위 작업 알림 둘은 키 글자 순서로 나온다. 전에는
  넣은 순서(`seq`)였다.
- `task`의 payload는 태그 둘이다. 읽는 쪽은 `_tag`로 가른다. 새 종류를 더하면
  `agent/task-notifications.ts`의 `fromEntries`와 `orchestrator-message.ts`의 `toldIds`, `notificationLines`를
  함께 고친다.
- `taskStatusWrites`는 서비스의 실패 감싸기(`NotificationStoreFailed`)를 거치지 않는다. Work Trace 저장소의
  transaction 안에서 같은 연결로 쓰려고 그렇게 했다. 다른 곳은 서비스(`OrchestratorNotifications`)를 쓴다.
- `redact`는 표 전체를 읽는다(`taskId`의 index가 없다). task를 지우는 일은 드물다. 행이 많아져 느려지면
  index를 더한다.
- 다음 계획: 보드의 호출(`kanbanAttention`)을 같은 표로 옮긴다. 그 뒤에는 `task-notifications.ts`의
  `wakes`와 `chat.ts`의 자동 run 조건이 표 하나만 읽는다.
- `sessions/dispatches.ts` 머리 주석의 "the target conversation's next run delivers it"는 새 기준(모델이 답하면
  전한 것)보다 덜 정확하다. 이 계획은 고치지 않는다.
