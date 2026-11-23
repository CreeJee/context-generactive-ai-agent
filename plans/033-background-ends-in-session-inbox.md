# Plan 033: 끝난 백그라운드 작업의 알림을 세션 inbox에 둔다

> **Executor instructions**: 이 계획을 단계 순서대로 따른다. 단계마다 Verify 명령을 돌려 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다. 임의로 풀지 않는다.
> `plans/README.md`는 고치지 않는다(검토자가 표를 관리한다).
>
> **이 저장소에서 찾을 때는 언제나 `rg --hidden -g '!.git' -g '!node_modules'`를 쓴다.** route 핸들러 폴더
> `apps/agent/app/.server`는 이름이 점으로 시작해 `rg`가 기본으로 건너뛴다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat 3547b7e6..HEAD -- packages/memory-agent/src/sessions/inbox.ts packages/memory-agent/src/sessions/dispatches.ts packages/memory-agent/src/tools/background.ts packages/memory-agent/src/agent/task-notifications.ts packages/memory-agent/src/agent/dispatch-notifications.ts packages/memory-agent/src/db/migrations.ts packages/memory-agent/tests/agents/background-tasks.test.ts packages/memory-agent/tests/sessions/inbox.test.ts`
> 바뀐 파일이 있으면 "Current state"의 발췌와 실제 코드를 비교한다. 다르면 STOP이다. 공백과 몇 줄의 번호
> 차이는 다른 것으로 보지 않는다. 이 계획은 `chat.ts`를 줄 번호가 아니라 이름으로 찾는다.

> **2026-11-23 고침**: 독립 검토(새 문맥의 에이전트)를 한 번 거쳤다. 작업의 끝과 inbox 행을 한 transaction으로
> 묶으려던 것을 버리고 "id가 이미 있으면 그대로 두는 넣기"(`putOnce`)로 바꿨다. 묶으면
> `background-tasks.test.ts`의 "an end that cannot be saved …"가 세는 값이 rollback으로 사라진다.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (DB 표의 열을 지우고 행을 옮긴다)
- **Depends on**: 030(세션 inbox 표와 서비스, `main`에 있다)
- **Category**: tech-debt
- **Planned at**: commit `3547b7e6`, 2026-11-23

## Why this matters

사용자가 2026-11-21에 정했다(`plans/consistency-rules.md`의 R8, `docs/decisions.md` "대화에 들어오는 메시지는
세션 inbox 하나에 둔다 (2026-11-22)"): 대화에 "사용자가 지금 치지 않은 메시지"가 들어오는 길은 한 종류다.
누가 보냈는가(`sender`)와 언제 전달하는가(`delivery`)만 다르고, 모두 `session_inbox` 표에 둔다.

계획 030이 표와 `SessionInbox` 서비스를 만들고 "다른 대화가 남긴 메시지"를 옮겼다. 이 계획은 둘째 단계다.
**끝난 백그라운드 작업의 알림**을 옮긴다. 지금은 `background_tasks` 행의 두 열(`delivered_to_run_id`,
`delivered_at`)이 "이 끝을 대화에 알렸는가"를 적고, 그 열을 읽고 쓰는 claim·돌려주기·깨우기 코드를
`tools/background.ts`가 따로 갖고 있다. inbox의 것과 뜻이 같은데 규칙이 조금씩 다르다(아래 "달라지는
동작").

끝난 하위 작업(`parent_notifications`), 보드, 사용자의 대기 메시지는 이 계획이 건드리지 않는다. 뒤의 계획이
하나씩 옮긴다.

## Current state

저장소: TypeScript monorepo. `packages/memory-agent`가 서버 로직이고 SQLite를 쓴다. Effect v4, 명령은
`vp`(Vite+).

### inbox 서비스 (`packages/memory-agent/src/sessions/inbox.ts`, 297줄)

보낸 쪽마다 payload schema를 객체 리터럴 하나에 둔다. 지금은 `conversation` 하나다:

```ts
export const inboxPayloads = {
  conversation: ConversationMessage,
} as const;
type StoredSender = keyof typeof inboxPayloads;
type PayloadOf<Sender extends StoredSender> = (typeof inboxPayloads)[Sender]["Type"];

/** One message to put in a conversation's inbox. */
export type NewInboxEntry = {
  readonly [Sender in StoredSender]: {
    readonly sessionId: string;
    readonly sender: Sender;
    readonly delivery: InboxDelivery;
    readonly payload: PayloadOf<Sender>;
  };
}[StoredSender];
```

행을 읽는 schema도 그 표에서 만든다:

```ts
const InboxRow = Schema.Union([rowOf("conversation")]);
```

기다리는 행을 읽는 SQL과 claim:

```ts
/** The rows of a conversation that wait and that no run holds, oldest first. */
const waiting = SqlSchema.findAll({
  Request: Schema.String,
  Result: InboxRow,
  execute: (sessionId) => sql`
      SELECT * FROM session_inbox
      WHERE session_id = ${sessionId} AND state = 'waiting' AND claimed_run_id IS NULL
      ORDER BY created_at, id`,
});
```

```ts
    claim: (sessionId: string, runId: string) =>
      Effect.gen(function* () {
        const held = yield* notificationsHeld(sessionId);
        if (Option.isSome(held)) return [];
        const rows = yield* waiting(sessionId);
        if (rows.length === 0) return [];
        const taken = yield* claimRows({
          sessionId,
          ids: rows.map((row) => row.id),
          runId,
          now: yield* isoNow,
        });
        const takenIds = HashSet.fromIterable(Iterable.map(taken, (row) => row.id));
        return rows.filter((row) => HashSet.has(takenIds, row.id)).map(toEntry);
      }).pipe(sql.withTransaction, stored),
```

`put`은 id를 스스로 만든다(`crypto.uuidV7()`). 다른 메서드: `pending(sessionId)`, `release(sessionId, runId)`
(그 run의 claim을 모두 지운다), `deliverClaimed(sessionId, runId)`(그 run이 잡은 행을 모두 delivered로),
`deliver(sessionId, runId, ids)`(기다리는 행을 바로 delivered로). 서비스가 만들어질 때
`settleAbandonedClaims`가 한 번 돈다: claim한 run의 `chat_runs.status`가 `completed`나 `interrupted`면
delivered로, 아니면 claim을 지운다.

`claim`, `release`, `deliverClaimed`에는 **보낸 쪽 조건이 없다.** 지금은 행이 한 종류뿐이라 문제가 없다.
둘째 보낸 쪽이 들어오면 한쪽의 run hook이 다른 쪽의 행까지 잡는다. 이 계획이 `claim`에 조건을 더한다.

`claim`을 부르는 곳은 한 군데다(`packages/memory-agent/src/sessions/dispatches.ts`):

```ts
    consume: (toSessionId: string, runId: string) =>
      Effect.map(fromInbox(inbox.claim(toSessionId, runId)), toDispatches),
```

### 백그라운드 작업 저장소 (`packages/memory-agent/src/tools/background.ts`)

표(`packages/memory-agent/src/db/migrations.ts`의 `backgroundTasksMigration` 안, 그리고 `delivery` 열을 더한
`notificationDeliveryMigration`):

```sql
  CREATE TABLE background_tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_run_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('shell', 'external_agent')),
    title TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
    result TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    delivered_to_run_id TEXT,
    delivered_at INTEGER,
    UNIQUE (parent_run_id, tool_call_id),
    CHECK ((status = 'running') = (finished_at IS NULL)),
    CHECK ((status = 'running') = (result IS NULL))
  );
  CREATE INDEX background_tasks_session ON background_tasks(session_id, status);
  CREATE INDEX background_tasks_untold ON background_tasks(session_id)
    WHERE finished_at IS NOT NULL AND delivered_at IS NULL;
```

```sql
  ALTER TABLE background_tasks ADD COLUMN delivery TEXT NOT NULL DEFAULT 'wake'
    CHECK (delivery IN ('wake', 'next_run'));
```

`started_at`, `finished_at`, `delivered_at`은 ms 정수다. inbox의 `created_at`, `delivered_at`은 ISO 글자열
(`2026-11-22T10:28:18.123Z` 꼴)이다.

작업이 끝날 때(`start` 안의 `finish`):

```ts
const hidden = yield * redactor.redactText(end.result);
const now = yield * Clock.currentTimeMillis;
yield *
  stored("write")(sql`UPDATE background_tasks
          SET status = ${end.status}, result = ${hidden.text}, finished_at = ${now}
          WHERE id = ${taskId}`);
```

서비스가 만들어질 때, 앞 프로세스가 돌리던 작업을 끝난 것으로 적는다:

```ts
// Tasks the previous process left running ended with it; their end is told like any other.
yield *
  Effect.flatMap(
    Clock.currentTimeMillis,
    (now) =>
      sql`UPDATE background_tasks
      SET status = 'interrupted', result = ${restartedResult}, finished_at = ${now}
      WHERE status = 'running'`,
  ).pipe(stored("write"));
```

알림을 맡는 메서드 넷(같은 파일의 `return { … }` 안):

```ts
    waitResult: Effect.fn("BackgroundTasks.waitResult")(function* (
      sessionId: string,
      taskId: string,
      milliseconds: number,
    ) {
      …
      const result = yield* milliseconds === 0 ? ended(sessionId, taskId) : waited;
      yield* Effect.when(
        stored("write")(
          Effect.flatMap(
            Clock.currentTimeMillis,
            (now) => sql`UPDATE background_tasks
              SET delivered_to_run_id = parent_run_id, delivered_at = ${now}
              WHERE id = ${taskId} AND delivered_at IS NULL`,
          ),
        ),
        Effect.succeed(Option.isSome(result)),
      );
      return Option.getOrNull(result);
    }),
    consume: (sessionId: string, runId: string) =>
      Effect.gen(function* () {
        const rows = yield* selectUntold(sessionId);
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE background_tasks SET delivered_to_run_id = ${runId}, delivered_at = ${now}
          WHERE session_id = ${sessionId} AND finished_at IS NOT NULL AND delivered_at IS NULL`;
        return rows.map((row): BackgroundEnd => ({
          taskId: row.id,
          parentRunId: row.parent_run_id,
          kind: row.kind,
          title: row.title,
          status: row.status,
        }));
      }).pipe(sql.withTransaction, stored("write")),
    release: (sessionId: string, runId: string) =>
      stored("write")(
        sql`UPDATE background_tasks SET delivered_to_run_id = NULL, delivered_at = NULL
          WHERE session_id = ${sessionId} AND delivered_to_run_id = ${runId}`,
      ).pipe(Effect.asVoid),
    wakes: (sessionId: string) =>
      stored("read")(
        sql`SELECT 1 FROM background_tasks b
          WHERE b.session_id = ${sessionId} AND b.finished_at IS NOT NULL
            AND b.delivered_at IS NULL AND b.delivery = 'wake'
            AND NOT EXISTS (
              SELECT 1 FROM parent_notification_holds h WHERE h.session_id = b.session_id
            )
          LIMIT 1`,
      ).pipe(Effect.map((rows) => rows.length > 0)),
```

`selectUntold`는 `ORDER BY finished_at, id`로 읽는다. `BackgroundEnd`(같은 파일, 모델이 읽는 글을 만드는 쪽이
쓴다):

```ts
export interface BackgroundEnd {
  readonly taskId: string;
  /** The run that started the task: a chat run, or one of the kanban board's (`isBoardRun`). */
  readonly parentRunId: string;
  readonly kind: BackgroundKind;
  readonly title: string;
  readonly status: BackgroundResult["status"];
}
```

`EndedStatus`(`Schema.Literals(["completed", "failed", "cancelled", "interrupted"])`)는 그 파일 안에서만 쓰는
상수다. `BackgroundKind`는 `packages/memory-agent/src/agent/run-state.ts`가 내보낸다(그 파일은 서버 코드를
import하지 않는다).

### run에 끼워 넣는 곳 (`packages/memory-agent/src/agent/task-notifications.ts`, 71줄)

```ts
export const taskNotifications = (services: {
  readonly trace: WorkTraceStore["Service"];
  readonly background: BackgroundTasks["Service"];
  readonly crypto: SecureRandom.SecureRandom["Service"];
}) => {
  const { trace, background, crypto } = services;
  const consume = (sessionId: string, runId: string) =>
    Effect.all({
      tasks: trace.consumeParentNotifications(sessionId, runId),
      background: background.consume(sessionId, runId),
    });
  const release = (sessionId: string, runId: string) =>
    Effect.all(
      [trace.releaseParentNotifications(sessionId, runId), background.release(sessionId, runId)],
      { discard: true },
    );
  return {
    consume,
    release,
    wakes: (sessionId: string) =>
      Effect.zipWith(
        trace.wakingParentNotificationSessions,
        background.wakes(sessionId),
        (sessions, waking) => waking || sessions.includes(sessionId),
      ),
    hookFor: (sessionId: string, runId: string): RunHook => ({
      joining: () => consume(sessionId, runId).pipe(…),
      ended: (_scope, end) =>
        Effect.when(release(sessionId, runId), Effect.succeed(!finishedRun(end))).pipe(
          Effect.ignore({ log: "Warn" }),
        ),
    }),
  };
};
```

`finishedRun(end)`은 run이 `Completed`나 `Interrupted`로 끝났다는 뜻이다(`src/loop/store.ts`).

`chat.ts`가 이것을 만든다(이름으로 찾는다):

- `const notifications = taskNotifications({ trace: workTrace, background, crypto });`
- `notifications.consume(sessionId, runId)`: 자동으로 시작한 run이 첫 글을 만들 때.
- `notifications.hookFor(sessionId, runId)`: run의 hook 목록. 바로 다음 줄이
  `toldDispatches.hookFor(sessionId, runId)`다(다른 대화의 메시지를 inbox에서 잡는 hook,
  `src/agent/dispatch-notifications.ts`).
- `notifications.wakes(sessionId)`: 쉬는 대화를 깨울지 정할 때.

모델이 읽는 글은 `src/agent/orchestrator-message.ts`의 `notificationLines`가 만든다. **이 글은 한 글자도
바꾸지 않는다.**

### 알림 멈춤

사용자가 대화를 멈추면 `parent_notification_holds`에 그 대화의 행이 생긴다(`chat.ts`의
`workTrace.holdParentNotifications`). 사용자의 다음 메시지로 run이 시작하면 지워진다
(`workTrace.resumeParentNotifications`, `turn !== null`일 때). 지금 이 표를 읽는 곳: `inbox.claim`(멈춘
대화는 아무것도 잡지 않는다), `background.wakes`와 `wakingParentNotificationSessions`(멈춘 대화는 깨우지
않는다), 자동 run을 시작하는 `chat.ts`. **`background.consume`은 읽지 않는다.**

### migration 관례

- `migrations.ts`의 `migrations` 배열 끝에 SQL 글자열을 더한다. 배열의 길이가 스키마 버전이다. 앞의 단계는
  고치지 않는다.
- 여러 문장이 필요한 단계는 `export const`로 이름 붙인다(본보기: `sessionInboxMigration`,
  `btwTablesDropMigration`). migration 테스트가 `migrations.indexOf(<상수>)`로 그 단계의 자리를 찾는다.
- 열을 지운 앞선 예: `ALTER TABLE workflow_state_revisions DROP COLUMN mode;`(배열의 지금 마지막 단계).

### 지금 동작을 단언하는 테스트

- `packages/memory-agent/tests/agents/background-tasks.test.ts`(415줄). 알림을 보는 것:
  - "an end is told once to the run that takes it, and again after that run gives it back":
    `tasks.wakes`, `tasks.consume(sessionId, "later-run")`, `tasks.release`를 부른다.
  - "the end of a task the board started goes with the next run but does not wake the session":
    `tasks.wakes`, `tasks.consume`.
  - "an end that cannot be saved reads as failed, without retry or a task left running": TEMP trigger가
    `UPDATE OF status`마다 TEMP 표 `result_writes`에 한 행을 넣고 `RAISE(FAIL)`한다. 테스트는 그 표의 행이
    하나인지 본다(끝을 한 번만 적으려 했고 다시 시도하지 않았다). **이 `UPDATE`를 transaction 안에 넣으면
    실패 때 rollback이 그 행까지 지워 0이 된다. 그래서 이 계획은 transaction을 쓰지 않는다. 이 테스트는
    고치지 않는다.**
  - "cancel stops active work and restart never resends an interrupted operation": 끝에서
    `tasks.wakes(session.id)`가 `true`인지 본다. 그 앞에 "끝을 저장하지 못하고 죽은 프로세스"를 흉내 내려고
    `UPDATE background_tasks SET status = 'running', result = NULL, finished_at = NULL WHERE id = ?`를 돌린다.
- `packages/memory-agent/tests/background-tasks-migration.test.ts`: 옛 Work Trace의 백그라운드 작업을 옮긴 뒤
  `SELECT … delivered_to_run_id FROM background_tasks`가 `"run"`인지 본다. `migrateDatabase(db)`로 최신
  스키마까지 올리므로, **이 계획 뒤에는 그 열이 없어 고쳐야 한다.**
- `packages/memory-agent/tests/sessions/inbox.test.ts`(7개), `tests/sessions/dispatches.test.ts`,
  `tests/agent/dispatch-delivery.test.ts`: inbox와 dispatch.
- `packages/memory-agent/tests/session-inbox-migration.test.ts`: migration 테스트의 본보기.

### 지킬 규칙 (`AGENTS.md`, `CLAUDE.md`에서)

- `let`, `while`을 쓰지 않는다. lint 규칙을 끄는 주석을 쓰지 않는다. `unknown`으로 타입을 뭉개지 않는다.
- 고정된 종류는 `Schema.Literals`로 적고, 종류마다 다른 모양은 tagged union으로 적는다.
- Effect v4 표준 꼴을 따른다. SQL은 `SqlSchema.findAll`/`findOne`/`findOneOption`(`inbox.ts`가 본보기다).
- 줄바꿈만 바꾸는 편집을 하지 않는다. 포맷은 commit hook이 맡는다.
- 이름, 주석, 문서에 만든 말을 쓰지 않는다. 쉬운 말을 쓴다. 코드 주석은 영어, 문서는 한국어다(둘 다 주변
  파일을 따른다).
- 진단하려고 추적되는 파일을 잠깐 고치지 않는다.

## 만들 것

### 1. inbox가 보낸 쪽을 가려 잡는다

`inbox.ts`를 고친다.

- 새 파일 `packages/memory-agent/src/tools/background-end.ts`에 끝난 백그라운드 작업의 모양을 둔다. inbox와
  `background.ts`가 둘 다 이것을 import한다(`background.ts`가 inbox를 쓰므로 inbox가 `background.ts`를
  import하면 순환이 된다).

  ```ts
  import { Schema } from "effect";
  import { BackgroundKind } from "../agent/run-state.ts";

  /** How a background task ended. A command that exited non-zero still completed, with its output. */
  export const BackgroundEndedStatus = Schema.Literals([
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]);

  /** A background task's end, as the session inbox keeps it until a run tells the model. */
  export const BackgroundTaskEnd = Schema.TaggedStruct("BackgroundEnd", {
    taskId: Schema.String,
    /** The run that started the task: a chat run, or one of the kanban board's (`isBoardRun`). */
    parentRunId: Schema.String,
    kind: BackgroundKind,
    title: Schema.String,
    status: BackgroundEndedStatus,
  });
  export type BackgroundTaskEnd = typeof BackgroundTaskEnd.Type;
  ```

  `background.ts`의 `EndedStatus`는 지우고 `BackgroundEndedStatus`를 쓴다.

- `inboxPayloads`에 `task: BackgroundTaskEnd`를 더하고 `InboxRow`에 `rowOf("task")`를 더한다. `_tag`가 있는
  까닭: 뒤의 계획이 끝난 하위 작업의 알림을 같은 `task` 보낸 쪽에 더하고, 그때 이 자리가 union이 된다.
- `put`은 그대로 둔다(id는 `uuidV7`). 새 메서드 `putOnce(entry)`를 더한다. `entry`는 `NewInboxEntry`에
  `readonly id: string`을 더한 것이다. 그 id의 행이 없으면 `waiting` 행을 넣고, 있으면 아무것도 하지 않는다
  (`INSERT … ON CONFLICT(id) DO NOTHING`). 돌려주는 값은 없다(`Effect<void, InboxStoreFailed>`). 자기 기록을
  따로 가진 보낸 쪽이 그 기록의 id로 부른다. 그러면 기록 하나에 inbox 행이 하나이고, 그 기록에서 inbox 행을
  바로 찾는다.
- `claim(sessionId, runId, sender)`: 셋째 인자로 보낸 쪽을 받는다. 그 보낸 쪽의 행만 잡고, 돌려주는 값의
  타입도 그 보낸 쪽의 것이다(`Extract<InboxEntry, { readonly sender: Sender }>`의 배열). 보낸 쪽을 받는
  `waiting` SQL을 하나 더 두거나 지금 것에 `AND sender = ${sender}`를 더한다(`pending`은 지금처럼 모든 보낸
  쪽의 행을 주므로, 보낸 쪽을 받지 않는 SQL도 남는다). 타입은 `as`로 좁히지 않는다(lint가 막는다). 타입
  가드로 좁힌다:
  `rows.map(toEntry).filter((entry): entry is Extract<InboxEntry, { readonly sender: Sender }> => entry.sender === sender)`.
- `wakes(sessionId)`: 그 대화에 `state = 'waiting'`이고 claim되지 않았고 `delivery = 'wake'`인 행이 있으면
  `true`다. `parent_notification_holds`에 그 대화가 있으면 `false`다. 보낸 쪽을 가리지 않는다.
- `release`, `deliverClaimed`, `deliver`, `settleAbandonedClaims`는 그대로 둔다. `release`와 `deliverClaimed`는
  그 run이 잡은 행을 보낸 쪽과 관계없이 모두 다룬다. 두 hook이 각각 불러도 결과가 같다.
- `dispatches.ts`의 `consume`은 `inbox.claim(toSessionId, runId, "conversation")`을 부른다. `toDispatches`의
  `filter`는 `pending`이 아직 쓰므로 둔다.

### 2. 끝난 백그라운드 작업은 inbox 행 하나가 된다

- 끝을 inbox에 넣는 함수 하나를 둔다(`tellEnd(taskId)` 같은 이름). 끝난 작업 행을 읽어
  (`SqlSchema.findOneOption`, `SELECT id, session_id, parent_run_id, kind, title, status, delivery FROM
  background_tasks WHERE id = … AND finished_at IS NOT NULL`) 있으면
  `inbox.putOnce({ id: <taskId>, sessionId, sender: "task", delivery: <행의 delivery>, payload:
  { _tag: "BackgroundEnd", taskId, parentRunId, kind, title, status } })`를 부르고 읽은 행을 돌려준다
  (`Option`). 행이 없으면(끝나지 않았거나 대화와 함께 지워졌다) 아무것도 하지 않는다. 이 함수는 서비스가
  만들어질 때의 처리보다 위에 정의한다(그 처리가 이것을 부른다).
- **transaction으로 묶지 않는다.** 끝을 적는 `UPDATE`는 지금처럼 혼자 돈다. 그 뒤에 `tellEnd`를 부른다.
  `putOnce`가 여러 번 불려도 행이 하나이므로 아래 세 곳이 순서와 관계없이 불러도 된다.
  - `finish`: 지금의 `UPDATE` 바로 뒤에 `tellEnd(taskId)`. `UPDATE`가 실패하면 `tellEnd`는 돌지 않는다.
  - 서비스가 만들어질 때: 지금의 `interrupted` `UPDATE` 뒤에, 끝났는데 inbox 행이 없는 작업을 모두 찾아
    하나씩 `tellEnd`한다:
    `SELECT b.id FROM background_tasks b WHERE b.finished_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM
    session_inbox i WHERE i.id = b.id) ORDER BY b.finished_at, b.id`. 방금 `interrupted`가 된 작업과, 끝을
    적고 inbox에 넣기 전에 죽은 프로세스가 남긴 작업이 여기서 행을 얻는다.
  - `waitResult`: 결과를 읽었으면 `tellEnd(taskId)`로 행이 있게 한 뒤(이 프로세스의 `finish`가 `UPDATE`와
    `tellEnd` 사이에 있을 수 있다) 그 행을 바로 delivered로 바꾼다:
    `inbox.deliver(sessionId, <tellEnd가 돌려준 행의 parent_run_id>, [taskId])`. `tellEnd`가 행을 찾지
    못했으면(끝을 저장하지 못한 작업) 아무것도 바뀌지 않는다. 뒤늦게 온 `finish`의 `putOnce`는 이미 있는
    행을 건드리지 않으므로 delivered로 남는다.
- `BackgroundTasks`에서 `consume`, `release`, `wakes`, `selectUntold`를 지운다. `EndRow`는 `tellEnd`가 읽는
  행의 schema로 고쳐 쓰거나 지운다. `BackgroundEnd` 타입은 `BackgroundTaskEnd`에서 `_tag`를 뺀 모양으로
  남긴다(`orchestrator-message.ts`가 쓴다. 지금의 interface를 그대로 둬도 된다).
- `BackgroundTasks.layer`는 `SessionInbox`를 요구하게 된다. `src/layers.ts`의 `stores`에
  `SessionInbox.layer`가 이미 있고, `BackgroundTasks.layer`는 그 아래에서 `Layer.provideMerge(stores)`를
  받는다. typecheck가 요구 사항이 남았다고 하면 `SessionDispatches.layer`가 하는 것처럼
  `BackgroundTasks.layer.pipe(Layer.provide(SessionInbox.layer))`로 준다.
- `InboxStoreFailed`는 `stored("write")`가 `BackgroundStoreFailed`로 바꾼다(지금의 `stored`는 `_tag`를 가진
  어떤 실패든 받는다).
- `background.ts`의 `EndedStatus`를 지우고 `background-end.ts`의 `BackgroundEndedStatus`를 쓰는 것은 이
  단계(Step 2)에서 한다.

### 3. run hook이 inbox에서 잡는다

`task-notifications.ts`를 고친다.

- `services`에서 `background`를 빼고 `inbox: SessionInbox["Service"]`를 더한다.
- `consume`의 `background`: `inbox.claim(sessionId, runId, "task")`의 각 행 payload를 `BackgroundEnd`로 바꾼다
  (`taskId`, `parentRunId`, `kind`, `title`, `status`). 순서는 inbox가 주는 대로다(`created_at, id`).
- `release`: `trace.releaseParentNotifications`와 `inbox.release(sessionId, runId)`.
- `wakes`: `trace.wakingParentNotificationSessions`와 `inbox.wakes(sessionId)`.
- `hookFor`의 `ended`: run이 끝났으면(`finishedRun(end)`) `inbox.deliverClaimed(sessionId, runId)`를 부르고,
  아니면 지금처럼 `release`를 부른다. Work Trace 알림 쪽은 지금 그대로다(끝난 run에는 아무것도 하지 않는다).
- `chat.ts`: `taskNotifications({ trace: workTrace, inbox: <SessionInbox>, crypto })`. `chat.ts`가
  `SessionInbox`를 아직 얻지 않으므로 `const sessionDispatches = yield* SessionDispatches;` 옆에서 얻는다.
  `chat.ts`에서 고치는 것은 세 곳뿐이다: `SessionInbox`의 import(`SessionDispatches`를 import하는 줄 옆),
  그것을 얻는 줄, `taskNotifications`의 인자.

### 4. migration

`migrations` 배열 끝에 `export const backgroundEndsInboxMigration` 한 단계를 더한다.

```sql
  -- The end of a background task is told through the session inbox like every other message that
  -- enters a conversation (decisions.md "대화에 들어오는 메시지는 세션 inbox 하나에 둔다"): one
  -- row per ended task, with the task's id. The task row keeps its result and the delivery it was
  -- started with; whether its end was told is the inbox row's state.
  INSERT INTO session_inbox (id, session_id, sender, delivery, payload, state, claimed_run_id,
    claimed_at, delivered_run_id, created_at, delivered_at)
  SELECT b.id, b.session_id, 'task', b.delivery,
    json_object('_tag', 'BackgroundEnd', 'taskId', b.id, 'parentRunId', b.parent_run_id,
      'kind', b.kind, 'title', b.title, 'status', b.status),
    CASE WHEN b.delivered_at IS NULL THEN 'waiting' ELSE 'delivered' END,
    NULL, NULL,
    CASE WHEN b.delivered_at IS NULL THEN NULL
      ELSE coalesce(b.delivered_to_run_id, b.parent_run_id) END,
    strftime('%Y-%m-%dT%H:%M:%fZ', b.finished_at / 1000.0, 'unixepoch'),
    CASE WHEN b.delivered_at IS NULL THEN NULL
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', b.delivered_at / 1000.0, 'unixepoch') END
  FROM background_tasks b
  WHERE b.finished_at IS NOT NULL;
  DROP INDEX background_tasks_untold;
  ALTER TABLE background_tasks DROP COLUMN delivered_to_run_id;
  ALTER TABLE background_tasks DROP COLUMN delivered_at;
```

이미 알린 끝도 delivered 행으로 옮긴다. 어느 run이 그 끝을 들었는지가 지워지는 열에만 있기 때문이다.
`background_tasks.delivery` 열은 남는다(작업을 시작할 때 정하고, 끝날 때 inbox 행에 옮겨 적는다).

### 달라지는 동작

이 다섯만 달라진다. 그 밖의 동작이 달라져야 테스트가 통과하면 STOP이다.

1. **멈춘 대화의 run은 끝난 백그라운드 작업도 듣지 않는다.** 지금은 다른 대화의 메시지만 그렇다. 사용자가
   멈춘 대화에서 사용자의 메시지 없이 도는 run(예: 승인에 답해 이어지는 run)이 끝난 작업을 들었다. 이제는
   사용자의 다음 메시지가 멈춤을 풀 때까지 기다린다. inbox의 규칙 하나를 따르게 한 것이고, 멈춤의 뜻
   ("사용자의 다음 메시지까지 알림을 둔다")과 같다.
2. **끝을 듣던 run이 끝나기 전에 앱이 죽으면, 그 끝을 다음 run이 다시 듣는다.** 지금은 run이 잡는 순간
   `delivered_at`을 적고 재시작 때 되돌리지 않아, 듣지 못한 채 알린 것으로 남았다. inbox의
   `settleAbandonedClaims`가 끝나지 못한 run의 claim을 지운다.
3. **끝난 run이 들은 끝은 run이 끝날 때 delivered가 된다.** 지금은 잡는 순간 적는다. run이 도는 동안 그 행은
   `waiting`이고 `claimed_run_id`가 그 run이다.
4. **자동으로 시작하려던 run이 끝을 잡은 뒤 시작을 거절당하면, 그 끝은 재시작 뒤에 다시 알려진다.**
   `chat.ts`는 자동 run의 첫 글을 만들 때 `notifications.consume`으로 끝을 잡는다. hook이 붙기 전에 run이
   거절되면 돌려주는 코드가 없다. 지금은 그 끝이 알린 것으로 남아 영영 전해지지 않는다. 이제는 claim이
   재시작까지 남고(그동안 `wakes`는 `false`다) 재시작 때 풀린다. 끝난 하위 작업의 알림이 지금 그렇게 돈다.
   이 계획은 그 거절 경로를 고치지 않는다("Maintenance notes"에 적는다).
5. **끝을 저장하지 못한 작업을 기다려 읽은 run이 있어도, 재시작 뒤 그 작업의 끝(`interrupted`)을 한 번
   알린다.** 지금은 `waitResult`가 실행 중으로 남은 행에도 `delivered_at`을 적어 다시 알리지 않았다.

덧붙임: 1번 때문에 뒤의 계획이 끝난 하위 작업의 알림을 옮길 때까지, 멈춘 대화의 run 하나가 끝난 하위 작업은
듣고 끝난 백그라운드 작업은 듣지 않는다. 시작할 때 `interrupted`가 된 작업 여럿의 순서는 `finished_at`이
같으므로 지금도 id 순이고, 뒤에도 그렇다(`tellEnd`를 그 순서로 부르지만 `created_at`이 같은 ms일 수 있어
inbox가 id로 가른다).

## Commands you will need

| Purpose               | Command                                                          | Expected on success    |
| --------------------- | ---------------------------------------------------------------- | ---------------------- |
| 서버 typecheck        | `vp run memory-agent#typecheck`                                  | exit 0, 오류·경고 없음 |
| 화면 typecheck        | `vp run agent#typecheck`                                         | exit 0                 |
| lint (저장소 루트)    | `vp lint`                                                        | exit 0                 |
| 서버 테스트 (고른 것) | `cd packages/memory-agent && vp test run --maxWorkers=4 <파일…>` | 모두 통과              |

새 worktree에서는 먼저 `vp install`과 `vp run turbovec#build`를 돌린다. `vp lint`는 `vp run agent#typecheck`를
한 번 돌린 뒤에 돌린다. 전체 테스트는 돌리지 않는다. 고친 파일의 테스트만 돌린다.
`tests/workflow/provider-retry.test.ts`의 "restores a pending wait after the layer is rebuilt without
recomputing it"는 여러 파일과 함께 돌 때 가끔 실패한다고 알려져 있다. 이 계획과 무관하다. 그것 하나만
실패하면 그 파일만 다시 돌려 통과를 확인하고 보고에 적는다.

## Scope

**고치는 파일**

- `packages/memory-agent/src/tools/background-end.ts` (새 파일)
- `packages/memory-agent/src/sessions/inbox.ts`
- `packages/memory-agent/src/sessions/dispatches.ts` (`claim` 호출 한 곳)
- `packages/memory-agent/src/tools/background.ts`
- `packages/memory-agent/src/agent/task-notifications.ts`
- `packages/memory-agent/src/agent/chat.ts` (`SessionInbox`의 import, 얻는 줄, `taskNotifications` 인자. 세 곳)
- `packages/memory-agent/src/layers.ts` (typecheck가 요구할 때만)
- `packages/memory-agent/src/db/migrations.ts` (배열 끝에 한 단계)
- `packages/memory-agent/tests/sessions/inbox.test.ts`
- `packages/memory-agent/tests/agents/background-tasks.test.ts`
- `packages/memory-agent/tests/background-tasks-migration.test.ts`
- `packages/memory-agent/tests/background-ends-inbox-migration.test.ts` (새 파일)
- `docs/decisions.md`, `packages/memory-agent/src/sessions/README.md`,
  `packages/memory-agent/src/tools/README.md`, `packages/memory-agent/src/agent/README.md`

**고치지 않는다**

- `packages/memory-agent/src/agent/orchestrator-message.ts`: 모델이 읽는 글. 한 글자도 바꾸지 않는다.
- `packages/memory-agent/src/agent/dispatch-notifications.ts`: 다른 대화 메시지의 hook. 그대로다.
- `packages/memory-agent/src/work-trace/store.ts`와 `parent_notifications`, `parent_notification_holds` 표:
  끝난 하위 작업의 알림은 뒤의 계획이 옮긴다.
- `packages/memory-agent/src/queue/`, `src/kanban/`: 사용자의 대기 메시지와 보드는 뒤의 계획이다.
- `packages/memory-agent/src/agent/notification-delivery.ts`: `deliveryFor`는 그대로다.
- `migrations` 배열의 앞 단계들.
- `apps/agent`: 화면은 이 열을 읽지 않는다.
- `plans/`.

## Git workflow

- 지금 있는 branch에서 일한다(worktree가 주어졌으면 그 branch). push하지 않는다. merge하지 않는다.
- 단계마다 commit 하나. 메시지는 한국어 conventional commit이다(예:
  `refactor(sessions): inbox가 보낸 쪽을 가려 잡는다`). 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`
- commit마다 typecheck와 lint가 통과해야 한다. commit hook이 `vp check --fix`를 돌린다.
- 자기가 고친 경로만 commit한다.

## Steps

### Step 1: inbox가 보낸 쪽을 가려 잡고, 깨울 행이 있는지 답한다

동작은 바뀌지 않는다.

1. `src/tools/background-end.ts`를 만든다("만들 것 1"의 코드).
2. `inbox.ts`: `inboxPayloads`에 `task`, `InboxRow`에 `rowOf("task")`, `putOnce`, `claim`의 `sender` 인자,
   `wakes`를 더한다. 파일 머리의 `inboxPayloads` 주석과 `claim` 주석을 새 뜻에 맞게 고친다. 이 단계에서
   `background.ts`는 고치지 않는다.
3. `dispatches.ts`: `inbox.claim(toSessionId, runId, "conversation")`.
4. `tests/sessions/inbox.test.ts`에 테스트 셋을 더한다. 그 파일의 `put` 도우미는 `conversation`·`next_run`
   행만 넣으므로, `task` 행을 넣는 도우미를 하나 더 둔다(`delivery`를 인자로 받는다):
   `inbox.put({ sessionId, sender: "task", delivery, payload: { _tag: "BackgroundEnd", taskId,
   parentRunId: "run-1", kind: "shell", title: "ls", status: "completed" } })`. `task` 행은 `"task"`로
   claim한다.
   - "claim takes only the named sender's rows": 한 대화에 `conversation` 행 하나와 `task` 행 하나를 넣는다.
     `claim(…, "run-a", "task")`가 `task` 행만 주고, 이어 `claim(…, "run-b", "conversation")`이 `conversation`
     행만 준다. `stateOf`로 두 행의 `claimed_run_id`가 각각 `run-a`, `run-b`인지 본다.
   - "a waiting row that wakes is reported until a run claims it, and not while notifications are held":
     `delivery: "next_run"` 행만 있을 때 `wakes`는 `false`. `delivery: "wake"` 행을 넣으면 `true`.
     `holdParentNotifications` 뒤에는 `false`, `resumeParentNotifications` 뒤에는 `true`. 그 행을 claim하면
     `false`.
   - "a row put once under an id is stored once": 같은 id(`"task-1"`)로 `putOnce`를 두 번 부른다(둘째는
     `title`을 다르게). `pending`이 행 하나를 주고, 그 `id`가 `"task-1"`, `payload.title`이 첫째의 것이다.
     그 행을 `deliver`한 뒤 같은 id로 `putOnce`를 또 불러도 `stateOf`가 `delivered`다.
   - 있는 테스트의 `inbox.claim(…)` 호출에는 `"conversation"`을 더한다. 단언은 바꾸지 않는다.

**Verify**:

- `vp run memory-agent#typecheck` → exit 0
- `vp run agent#typecheck` → exit 0
- `cd packages/memory-agent && vp test run --maxWorkers=4 tests/sessions tests/agent` → 모두 통과
  (`inbox.test.ts`는 10개)
- 루트 `vp lint` → exit 0

commit: `refactor(sessions): inbox가 보낸 쪽을 가려 잡고 깨울 행을 알린다`

### Step 2: 끝난 백그라운드 작업을 inbox에 넣고, 옛 열을 지운다

코드와 migration을 한 commit에 넣는다(열을 지우면 옛 코드가 돌지 않는다).

1. `migrations.ts`: `backgroundEndsInboxMigration`을 `export const`로 두고 배열 끝에 더한다("만들 것 4").
2. `background.ts`: "만들 것 2"대로 고친다.
3. `task-notifications.ts`, `chat.ts`: "만들 것 3"대로 고친다.
4. `rg --hidden -n 'delivered_to_run_id|background_tasks_untold' packages apps tools -g '!.git' -g '!node_modules' -g '!*.md'`
   로 남은 쓰임을 확인한다. 나와도 되는 것: `src/db/migrations.ts`(앞 단계와 새 단계),
   `src/work-trace/store.ts`, 그리고 `parent_notifications`를 읽는 파일들(`eval/live-delegation.ts`,
   `eval/tool-use.ts`, `tests/agents/agent-env.ts`, `tests/golden/driver.ts`, `tests/golden/rows.ts`,
   `tests/golden/__golden__/*.json`, `tests/fixtures/release-0.0.17.sql`): 이들은 `parent_notifications`의 같은
   이름 열이다. `background_tasks`의 열을 읽는 것이 `tests/background-tasks-migration.test.ts` 말고 더 있으면
   STOP이다.
5. `tests/agents/background-tasks.test.ts`를 고친다. 단언의 뜻은 그대로 두고 부르는 곳만 옮긴다.
   `SessionInbox`는 그 파일이 `BackgroundTasks`를 얻는 것과 같은 방식으로 얻는다(`yield* SessionInbox`, import는
   `../../src/sessions/inbox.ts`).
   - "an end is told once …": `tasks.wakes` → `inbox.wakes`. `tasks.consume(sessionId, run)` →
     `inbox.claim(sessionId, run, "task")`의 payload. 기대값 `told`의 각 원소에 `_tag: "BackgroundEnd"`를
     더하거나, payload에서 `_tag`를 빼고 비교한다(한쪽을 골라 파일 안에서 같게 쓴다). `tasks.release` →
     `inbox.release`. 마지막의 "A result the run waited for is its own" 부분은 `inbox.wakes`가 `false`인지에
     더해, 기다린 작업의 inbox 행이 `state: "delivered"`, `delivered_run_id`가 그 run인지 본다
     (`sqlGet("SELECT state, delivered_run_id FROM session_inbox WHERE id = ?", waited.taskId)`).
   - "the end of a task the board started …": 같은 식으로 옮긴다. `toMatchObject`의 기대값은 payload에 대고
     쓴다.
   - "cancel stops active work and restart never resends …": 프로세스가 죽은 것을 흉내 내는 `UPDATE` 옆에
     `DELETE FROM session_inbox WHERE id = ?`(같은 `receipt.taskId`)를 더한다. 끝을 저장하지 못하고 죽은
     프로세스는 inbox 행도 남기지 못했기 때문이다(`tellEnd`는 `UPDATE` 뒤에 돈다). 끝의 `tasks.wakes` →
     `inbox.wakes`. **`env.reopen` 뒤에는 서비스를 다시 얻는다**:
     `env.use(Effect.flatMap(SessionInbox, (inbox) => inbox.wakes(session.id)))`(그 테스트가 `BackgroundTasks`를
     다시 얻는 것과 같다). reopen 앞에서 얻은 `inbox`는 닫힌 서비스다. 이어서 그 작업의 inbox 행 payload의
     `status`가 `"interrupted"`인지도 본다
     (`sqlGet("SELECT json_extract(payload, '$.status') AS status FROM session_inbox WHERE id = ?", …)`).
   - "an end that cannot be saved reads as failed, without retry or a task left running"는 고치지 않는다.
     통과해야 한다(`result_writes`가 1). 실패하면 `UPDATE`가 transaction 안에 들어갔다는 뜻이다.
   - 테스트 하나를 더한다: "a run that finishes delivers the ends it took". 작업을 하나 끝내고
     `inbox.claim(sessionId, "run-x", "task")` 뒤 행이 `state: "waiting"`, `claimed_run_id: "run-x"`인지 보고,
     `inbox.deliverClaimed(sessionId, "run-x")` 뒤 `state: "delivered"`, `delivered_run_id: "run-x"`인지 본다.
6. `tests/background-tasks-migration.test.ts`: `SELECT`에서 `delivered_to_run_id`를 빼고, 대신 두 작업의 inbox
   행을 본다: `SELECT id, sender, state, delivered_run_id FROM session_inbox ORDER BY id`가
   `agent`와 `shell` 두 행이고 둘 다 `sender: "task"`, `state: "delivered"`, `delivered_run_id: "run"`이다.
   테스트 이름("…, told already")의 뜻이 이것이다.

**Verify**:

- `vp run memory-agent#typecheck` → exit 0
- `vp run agent#typecheck` → exit 0
- `cd packages/memory-agent && vp test run --maxWorkers=4 tests/agents tests/agent tests/sessions tests/chat tests/golden tests/background-tasks-migration.test.ts tests/notification-delivery-migration.test.ts tests/session-state-tables-migration.test.ts tests/session-inbox-migration.test.ts tests/database.test.ts tests/db-migrator-metadata.test.ts tests/code-skills.test.ts tests/run-command.test.ts tests/kanban-skills.test.ts tests/skill-review.test.ts src/db src/tools src/agent`
  → 모두 통과
- golden 파일(`tests/golden/__golden__/`)이 바뀌지 않았다: `git status --short packages/memory-agent/tests/golden`
  → 비어 있다. 바뀌어야 통과하면 STOP이다.
- 루트 `vp lint` → exit 0

commit: `refactor(tools): 끝난 백그라운드 작업의 알림을 세션 inbox에 둔다`

### Step 3: migration 테스트

새 파일 `tests/background-ends-inbox-migration.test.ts`. 본보기: `tests/session-inbox-migration.test.ts`
(`DatabaseSync(":memory:")`, `migrations.indexOf(<상수>)`, `migrations.slice(0, index).forEach((step) =>
db.exec(step))`).

경우:

- 새 DB에 배열 전체를 적용하면 `background_tasks`에 `delivered_to_run_id`, `delivered_at` 열이 없고
  `delivery` 열은 있다(`PRAGMA table_info(background_tasks)`의 `name`들). 인덱스 `background_tasks_untold`가
  없다(`sqlite_master`).
- 옛 데이터가 옮겨진다: `backgroundEndsInboxMigration` 앞까지 적용하고, 프로젝트 하나와 대화 하나, 작업 넷을
  넣는다:
  - `running`(끝나지 않음, `finished_at` NULL),
  - 끝났고 알리지 않음(`delivery = 'wake'`, `finished_at = 1767225600123`),
  - 끝났고 알리지 않음(`delivery = 'next_run'`, `parent_run_id = 'kanban:s:S1:1'`),
  - 끝났고 알림(`delivered_to_run_id = 'run-told'`, `delivered_at = 1767225601000`).

  그 단계를 적용한 뒤 `session_inbox`에 행이 셋이다(`running`의 것은 없다). 각 행의 `id`가 작업 id이고,
  `sender = 'task'`, `delivery`가 작업의 것, `json_extract(payload, '$._tag') = 'BackgroundEnd'`,
  `$.taskId`·`$.parentRunId`·`$.kind`·`$.title`·`$.status`가 작업의 값이다. 알리지 않은 둘은
  `state = 'waiting'`, `delivered_run_id`와 `delivered_at`이 NULL, 첫째의 `created_at`이
  `'2026-01-01T00:00:00.123Z'`다. 알린 것은 `state = 'delivered'`, `delivered_run_id = 'run-told'`,
  `delivered_at = '2026-01-01T00:00:01.000Z'`다.

- `PRAGMA foreign_key_check`가 비어 있다.

**Verify**:

- `cd packages/memory-agent && vp test run --maxWorkers=4 tests/background-ends-inbox-migration.test.ts` →
  모두 통과
- `vp run memory-agent#typecheck`, `vp run agent#typecheck` → exit 0
- 루트 `vp lint` → exit 0

commit: `test(db): 끝난 백그라운드 작업을 inbox로 옮기는 migration을 시험한다`

### Step 4: 문서

1. `docs/decisions.md`의 "대화에 들어오는 메시지는 세션 inbox 하나에 둔다 (2026-11-22)" 항목 끝에 "둘째 단계
   (2026-11-23)"를 더한다. 적을 것:
   - 끝난 백그라운드 작업의 알림이 inbox로 왔다. 작업 하나에 행 하나, 행의 id는 작업 id, `sender`는 task,
     `delivery`는 작업을 시작할 때 정한 값(wake나 next_run)이다.
   - `background_tasks`의 `delivered_to_run_id`·`delivered_at` 열과 인덱스 `background_tasks_untold`를
     지웠다. 옛 행은 migration 한 단계가 옮긴다(알린 것은 delivered 행으로).
   - inbox의 `claim`이 보낸 쪽을 받는다. `wakes`가 깨울 행이 있는지 답한다. `putOnce`는 id가 이미 있으면
     그대로 둔다. 끝을 적는 `UPDATE`와 inbox 넣기는 한 transaction이 아니고, 시작할 때 빠진 행을 채운다.
   - "달라지는 동작"의 다섯. 첫째(멈춘 대화의 run은 끝난 백그라운드 작업도 듣지 않는다)는 계획을 쓴 쪽이 정한
     기본값이고 사용자가 바꿀 수 있다고 적는다.
   - 대체하는 결정: "백그라운드 작업은 Work Trace에 남기지 않는다 (2026-11-12)"의 "이 행이 끝 알림도
     맡는다. `delivered_to_run_id`·`delivered_at`이 비어 있으면 아직 알리지 않은 끝이다" 부분.
2. `packages/memory-agent/src/sessions/README.md`의 `SessionInbox` 줄과 SQL 줄에 `claim`의 보낸 쪽, `wakes`,
   `putOnce`, `task` 보낸 쪽을 적는다.
3. `packages/memory-agent/src/tools/README.md`를 고친다.
   - `BackgroundTasks` / `BackgroundBinding` / … 줄(30행 근처): 서비스의 메서드 나열에서 `consume`, `release`,
     `wakes`를 빼고, 끝을 세션 inbox에 넣는다고 적는다. 새 파일 `background-end.ts`의
     `BackgroundEndedStatus`, `BackgroundTaskEnd`를 같은 Interface 절에 더한다.
   - "백그라운드 작업은 Work Trace task가 아니다 … 끝은 `background_tasks` 행의 `delivered_*`로 세션에 한 번
     알리고, 알리지 않은 run이 끝나지 못하면 `release`로 돌려준다 …" 줄(68행 근처): 끝은 세션 inbox의 행
     (`sender`는 task, id는 작업 id)으로 알린다고 고친다.
   - Side Effects 절이 `background_tasks`의 SQL을 적고 있으면 `session_inbox`에 넣는 것을 더한다.
4. `packages/memory-agent/src/agent/README.md`의 `taskNotifications` 줄(16행 근처): 백그라운드 작업의 끝은
   세션 inbox에서 잡는다고 고친다(`consume`·`release`·`wakes`라는 이름은 `taskNotifications`의 것으로 남는다).
5. `rg --hidden -n 'delivered_|BackgroundTasks|taskNotifications' -g '*.md' -g '!.git' -g '!node_modules' -g '!plans/**' packages apps docs`
   로 다른 문서를 찾는다. `docs/decisions.md`의 지난 항목은 고치지 않는다(기록이다). 폴더 `README.md`가 지금의
   구조를 틀리게 적고 있으면 고친다.

**Verify**: `vp run agent#typecheck` 뒤 루트 `vp lint` → exit 0. commit hook이 통과한다.

commit: `docs(sessions): 끝난 백그라운드 작업의 알림이 inbox로 온 것을 적는다`

## Test plan

- 새 테스트: `inbox.test.ts`에 셋(Step 1), `background-tasks.test.ts`에 하나(Step 2),
  `background-ends-inbox-migration.test.ts` 새 파일(Step 3).
- 고치는 테스트: `background-tasks.test.ts`의 셋(부르는 곳만), `background-tasks-migration.test.ts`의 단언
  하나(읽는 표만).
- 고치지 않고 통과해야 하는 테스트: `background-tasks.test.ts`의 "an end that cannot be saved reads as failed,
  without retry or a task left running".
- 바뀌지 않아야 하는 것: `tests/agent/dispatch-delivery.test.ts`, `tests/sessions/dispatches.test.ts`,
  `tests/agents/async-subagents.test.ts`, `tests/agents/subagents.test.ts`, `tests/agents/external-agents.test.ts`,
  golden 파일.

## Done criteria

- [ ] `vp run memory-agent#typecheck`, `vp run agent#typecheck`, 루트 `vp lint`가 모두 exit 0이다.
- [ ] Step 2의 테스트 명령과 Step 3의 테스트 명령이 모두 통과한다.
- [ ] `rg --hidden -n 'delivered_to_run_id|delivered_at' packages/memory-agent/src/tools/background.ts` → 결과
      없음.
- [ ] `rg --hidden -n 'background\.(consume|release|wakes)' packages/memory-agent/src` → 결과 없음.
- [ ] `git diff 3547b7e6..HEAD -- packages/memory-agent/src/agent/orchestrator-message.ts packages/memory-agent/src/agent/dispatch-notifications.ts packages/memory-agent/src/work-trace`
      → 비어 있다.
- [ ] commit이 넷이고, 각각 typecheck와 lint가 통과한 상태다.

## STOP conditions

멈추고 보고한다:

- "Current state"의 발췌가 실제 코드와 다르다(공백과 몇 줄의 번호 차이는 빼고).
- `orchestrator-message.ts`, `dispatch-notifications.ts`, `work-trace/store.ts`를 고쳐야 통과한다.
- golden 파일이 바뀌어야 통과한다. 모델이 읽는 글이나 저장되는 대화가 달라졌다는 뜻이다.
- "달라지는 동작"의 다섯 말고 다른 단언의 뜻을 바꿔야 통과하는 테스트가 있다. 특히 "멈춘 대화의 run이 끝난
  백그라운드 작업을 듣는다"를 단언하는 테스트가 있으면 고치지 말고 STOP이다(그 동작을 바꾸는 것은 사용자가
  정할 일이다).
- 끝을 적는 `UPDATE`를 transaction에 넣어야 통과하는 것이 있다.
- `ALTER TABLE … DROP COLUMN`이 실패한다(그 열을 쓰는 인덱스·trigger·view가 더 있다).
- `background.ts`가 inbox를 import해 순환 import 경고나 초기화 오류가 난다.
- 같은 Verify가 고친 뒤에도 두 번 실패한다.

## Maintenance notes

- 뒤의 계획이 끝난 하위 작업의 알림(`parent_notifications`)을 같은 `task` 보낸 쪽으로 옮긴다. 그때
  `inboxPayloads.task`가 `BackgroundTaskEnd`와 새 모양의 union이 되고, `task-notifications.ts`의 `consume`이
  한 번 잡은 행을 `_tag`로 갈라 쓴다. Work Trace 쪽의 `release`와 `wakingParentNotificationSessions`도 그때
  inbox의 것으로 바뀐다.
- inbox 행의 payload는 작업 행의 `title`·`status`를 옮겨 적은 것이다. 끝난 작업의 그 값은 바뀌지 않는다.
  비밀 값 지우기(`secrets/sweep.ts`)는 `background_tasks`도 `session_inbox`도 다루지 않는다(이 계획 앞에도
  같았다). 뒤에 둘 중 하나를 다루게 하면 다른 하나도 함께 다룬다.
- `wakes`는 보낸 쪽을 가리지 않는다. 다른 대화의 메시지가 쉬는 대화를 깨우게 하는 계획(R8의 `notify_session`
  깨우기)은 그 행을 `delivery: "wake"`로 넣기만 하면 `chat.ts`의 `notifications.wakes`가 그것을 본다. 다만 그
  자동 run이 무엇을 읽는지는 그 계획이 정한다.
- 이 migration은 열을 지운다. 이 단계를 모르는 옛 빌드는 새 DB 파일을 열지 못한다(스키마 버전이 더 높아
  거절된다). 저장소의 다른 열 삭제 단계와 같은 조건이다.
- `chat.ts`가 자동 run의 첫 글을 만들며 잡은 끝은, 그 run이 hook이 붙기 전에 거절되면 재시작까지 잡힌 채
  남는다("달라지는 동작" 4번). 끝난 하위 작업의 알림도 같다. 거절하는 자리에서 `notifications.release`를
  부르게 하는 것은 따로 할 일이다.
- 검토할 때 볼 것: 끝을 적는 `UPDATE`가 transaction 밖에 있는가, 시작할 때 inbox 행이 없는 끝난 작업마다 행이
  생기는가, `waitResult`가 읽은 끝이 다시 알려지지 않는가(`finish`의 `putOnce`가 뒤에 와도), `claim`이 다른
  보낸 쪽의 행을 잡지 않는가.
