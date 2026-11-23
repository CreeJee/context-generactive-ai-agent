# Plan 035: 세션 inbox의 이름을 orchestrator notifications로 바꾼다

> **Executor instructions**: 이 계획을 단계 순서대로 따른다. 단계마다 Verify 명령을 돌려 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다. 임의로 풀지 않는다.
> `plans/README.md`는 고치지 않는다(검토자가 표를 관리한다).
>
> **이 저장소에서 찾을 때는 언제나 `rg --hidden -g '!.git' -g '!node_modules'`를 쓴다.** route 핸들러 폴더
> `apps/agent/app/.server`는 이름이 점으로 시작해 `rg`가 기본으로 건너뛴다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat b1893738..HEAD -- packages/memory-agent/src/sessions packages/memory-agent/src/db/migrations.ts packages/memory-agent/src/layers.ts packages/memory-agent/src/index.ts packages/memory-agent/tests/sessions packages/memory-agent/tests/session-inbox-migration.test.ts packages/memory-agent/tests/agent/dispatch-delivery.test.ts packages/memory-agent/tests/agent/notify-session-record.test.ts`
> 바뀐 파일이 있으면 "Current state"의 발췌와 실제 코드를 비교한다. 다르면 STOP이다. 공백과 몇 줄의 번호
> 차이는 다른 것으로 보지 않는다.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (이름만 바꾼다. DB 표 하나를 새 이름으로 다시 만든다)
- **Depends on**: 030(세션 inbox 표와 서비스, `main`에 있다)
- **Blocks**: 033(끝난 백그라운드 작업의 알림). 033은 이 계획이 merge된 뒤 새 이름으로 고쳐 다시 찍는다.
- **Category**: tech-debt
- **Planned at**: commit `b1893738`, 2026-11-23

## Why this matters

사용자가 2026-11-23에 정했다(`plans/consistency-rules.md`의 R8).

1. **이름이 틀리게 읽힌다.** `session_inbox`는 사용자의 알림함처럼 읽힌다. 이 표는 사용자가 보는 알림이
   아니다. 앱이 사용자 대신 모델에게 전할 것(끝난 작업, 다른 대화가 남긴 메시지, 보드의 호출)을 두는 서버의
   표다. 모델도 이것을 도구로 열지 않는다. 서버가 모델을 부르기 전에 꺼내 모델 입력에 넣는다. 이 코드는
   그렇게 넣은 메시지를 이미 "orchestrator가 보낸 메시지"라고 부른다(`chat-store/schema.ts`의
   `OrchestratorNote`: "Why the app's orchestrator, not the user, sent a message"). 그래서 표의 이름을
   `orchestrator_notifications`로 한다.
2. **사용자가 보낸 메시지는 이 표에 오지 않는다.** 사용자가 답 도중에 보낸 메시지(`queued_messages`)는 쓴 쪽이
   사람이다. 고치고 지울 수 있고, 멈춘 뒤에는 본인이 확인해야 나가고, 순서 번호와 첨부가 있고, 사용자 turn으로
   들어간다. 그대로 `queued_messages`에 둔다. 그래서 이 표의 보낸 쪽(`sender`)에서 `user`를 뺀다.
3. **"언제 전하나"의 값은 둘이 같이 쓴다.** 끊고 바로(`interrupt`) / 쉬면 깨워서(`wake`) / 다음 run에
   (`next_run`). 사용자 메시지의 `steer`는 `interrupt`이고 `queue`는 `wake`다. 이 계획은 그 값의 타입을 한
   파일에 따로 둔다(`MessageDelivery`). 사용자 메시지 큐가 그 타입을 쓰게 하는 것은 뒤의 계획이다.

이 계획은 동작을 바꾸지 않는다. 이름, 표의 `sender` CHECK, 타입이 놓인 파일만 바뀐다.

## Current state

저장소: TypeScript monorepo. `packages/memory-agent`가 서버 로직이고 SQLite를 쓴다. Effect v4, 명령은
`vp`(Vite+).

### 서비스 파일 (`packages/memory-agent/src/sessions/inbox.ts`, 297줄)

머리의 선언:

```ts
/**
 * The messages that enter a conversation without the user typing them now, one table for every
 * sender (docs/decisions.md "대화에 들어오는 메시지는 세션 inbox 하나에 둔다"). A row waits until a
 * run of its conversation hands it to the model; the app restarts never lose one.
 */

/** Who sent the message. */
export const InboxSender = Schema.Literals(["user", "task", "conversation", "board"]);
export type InboxSender = typeof InboxSender.Type;

/**
 * When the message is handed to the conversation: `interrupt` cuts into the run in progress,
 * `wake` starts a run when the conversation is idle, `next_run` waits for a run that starts anyway.
 */
export const InboxDelivery = Schema.Literals(["interrupt", "wake", "next_run"]);
export type InboxDelivery = typeof InboxDelivery.Type;

export const InboxState = Schema.Literals(["waiting", "delivered"]);
export type InboxState = typeof InboxState.Type;

/** What another conversation of the same project left for this one. */
export const ConversationMessage = Schema.Struct({ … });

export const inboxPayloads = {
  conversation: ConversationMessage,
} as const;
```

그 밖에 내보내는 것: 타입 `NewInboxEntry`, `InboxEntry`, 오류 `InboxStoreFailed`
(`Schema.TaggedError(…)("InboxStoreFailed", …)`), 서비스:

```ts
export class SessionInbox extends Context.Service<SessionInbox, Effect.Success<typeof make>>()(
  "memory-agent/sessions/inbox/SessionInbox",
) {
  static readonly layer = Layer.effect(SessionInbox, make).pipe(Layer.provide(NodeCrypto.layer));
}
```

파일 안에서만 쓰는 것: `InboxRow`, `rowOf`, `toEntry`, `stored`, SQL 여덟 개. SQL은 모두 표 이름
`session_inbox`를 쓴다(`INSERT INTO session_inbox`, `SELECT * FROM session_inbox`, `UPDATE session_inbox`).

### 그 이름을 쓰는 곳 (2026-11-23에 `rg`로 센 것)

- `packages/memory-agent/src/sessions/dispatches.ts`: `import { SessionInbox, type InboxEntry, type
  InboxStoreFailed } from "./inbox.ts";`, 도우미 `fromInbox`, `const inbox = yield* SessionInbox;`, 주석.
- `packages/memory-agent/src/layers.ts`: `import { SessionInbox } from "./sessions/inbox.ts";`와
  ```ts
      SessionDispatches.layer.pipe(Layer.provide(SessionInbox.layer)),
      SessionInbox.layer,
  ```
- `packages/memory-agent/src/index.ts`:
  ```ts
  export {
    ConversationMessage,
    InboxDelivery,
    InboxSender,
    InboxState,
    InboxStoreFailed,
    inboxPayloads,
    SessionInbox,
    type InboxEntry,
    type NewInboxEntry,
  } from "./sessions/inbox.ts";
  ```
- `packages/memory-agent/src/tools/code.ts`: 주석 한 줄
  ``// Leaves a message in the other conversation's `session_inbox`; it does not steer the run.``
- `packages/memory-agent/src/sessions/README.md`: 23–27행과 53행.
- 테스트: `tests/sessions/inbox.test.ts`(7개. `import { SessionInbox, Sessions } from "memory-agent";`),
  `tests/sessions/dispatches.test.ts`, `tests/agent/dispatch-delivery.test.ts`,
  `tests/agent/notify-session-record.test.ts`(셋은 SQL 글자열에 `session_inbox`),
  `tests/session-inbox-migration.test.ts`.
- `apps/agent`는 이 이름을 쓰지 않는다.

**다른 것과 헷갈리지 않는다.** `apps/agent/app/entry/navigation/decision-inbox.tsx`,
`packages/memory-agent/src/kanban/human-decision.ts`, `docs/kanban-orchestration.md`의 "통합 inbox"는 사람의
판단을 기다리는 함이다. 이 계획과 무관하다. 고치지 않는다.

### 표 (`packages/memory-agent/src/db/migrations.ts`의 `sessionInboxMigration`)

```sql
  CREATE TABLE session_inbox (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK (sender IN ('user', 'task', 'conversation', 'board')),
    delivery TEXT NOT NULL CHECK (delivery IN ('interrupt', 'wake', 'next_run')),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    state TEXT NOT NULL CHECK (state IN ('waiting', 'delivered')),
    claimed_run_id TEXT,
    claimed_at TEXT,
    delivered_run_id TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    CHECK ((claimed_run_id IS NULL) = (claimed_at IS NULL)),
    CHECK ((state = 'delivered') = (delivered_run_id IS NOT NULL)),
    CHECK ((state = 'delivered') = (delivered_at IS NOT NULL))
  );
  CREATE INDEX session_inbox_waiting ON session_inbox(session_id, state, created_at);
  CREATE INDEX session_inbox_claimed ON session_inbox(claimed_run_id)
    WHERE claimed_run_id IS NOT NULL;
```

이 표를 `REFERENCES`로 가리키는 표는 없다. 지금 코드가 넣는 행의 `sender`는 `conversation`뿐이다
(`inboxPayloads`에 그것 하나만 있다). `user`인 행은 있을 수 없다.

### migration 관례

- `migrations.ts`의 `migrations` 배열 끝에 SQL 글자열을 더한다. 배열의 길이가 스키마 버전이다. 앞의 단계는
  고치지 않는다(`sessionInboxMigration`도 그대로 둔다).
- 여러 문장이 필요한 단계는 `export const`로 이름 붙인다(본보기: `sessionInboxMigration`). migration 테스트가
  `migrations.indexOf(<상수>)`로 그 단계의 자리를 찾는다.
- 배열의 지금 마지막 단계는 `ALTER TABLE workflow_state_revisions DROP COLUMN mode;`를 담은 이름 없는
  글자열이다. 새 단계는 그 뒤에 온다.

### `tests/session-inbox-migration.test.ts`의 세 테스트

1. "the newest schema has the inbox and not the dispatch tables": 배열 전체를 적용한 뒤 `sqlite_master`에
   `session_inbox`가 있는지 본다. **이 계획 뒤에는 그 표가 없다.**
2. "its step moves the stored dispatches and their claims into the inbox": `sessionInboxMigration` 앞까지
   적용하고 그 단계만 돌린다. 이 계획 뒤에도 그대로 통과한다. 고치지 않는다.
3. "a delivered row without the run that delivered it is refused": 배열 전체를 적용한 뒤
   `INSERT INTO session_inbox …`를 한다. **이 계획 뒤에는 그 표가 없다.**

### 지킬 규칙 (`AGENTS.md`, `CLAUDE.md`에서)

- `let`, `while`을 쓰지 않는다. lint 규칙을 끄는 주석을 쓰지 않는다. `unknown`으로 타입을 뭉개지 않는다.
- 줄바꿈만 바꾸는 편집을 하지 않는다. 포맷은 commit hook이 맡는다.
- 이름, 주석, 문서에 만든 말을 쓰지 않는다. 쉬운 말을 쓴다. 코드 주석은 영어, 문서는 한국어다.
- 진단하려고 추적되는 파일을 잠깐 고치지 않는다.
- `docs/decisions.md`의 지난 항목은 고치지 않는다(기록이다). 새 항목을 더한다.

## 만들 것

### 이름 표

| 지금                                                    | 바꾼 뒤                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 표 `session_inbox`                                      | `orchestrator_notifications`                                                   |
| 인덱스 `session_inbox_waiting`                          | `orchestrator_notifications_waiting`                                           |
| 인덱스 `session_inbox_claimed`                          | `orchestrator_notifications_claimed`                                           |
| 파일 `src/sessions/inbox.ts`                            | `src/sessions/orchestrator-notifications.ts` (`git mv`)                        |
| 서비스 `SessionInbox`                                   | `OrchestratorNotifications`                                                    |
| 서비스 키 `"memory-agent/sessions/inbox/SessionInbox"`  | `"memory-agent/sessions/orchestrator-notifications/OrchestratorNotifications"` |
| `InboxSender` (`user`, `task`, `conversation`, `board`) | `NotificationSender` (`task`, `conversation`, `board`)                         |
| `InboxDelivery`                                         | `MessageDelivery` (새 파일 `src/sessions/message-delivery.ts`)                 |
| `InboxState`                                            | `NotificationState`                                                            |
| `inboxPayloads`                                         | `notificationPayloads`                                                         |
| `NewInboxEntry`                                         | `NewNotificationEntry`                                                         |
| `InboxEntry`                                            | `NotificationEntry`                                                            |
| `InboxStoreFailed` (tag `"InboxStoreFailed"`)           | `NotificationStoreFailed` (tag `"NotificationStoreFailed"`)                    |
| 파일 안의 `InboxRow`                                    | `NotificationRow`                                                              |
| `dispatches.ts`의 `fromInbox`, 변수 `inbox`             | `fromNotifications`, `notifications`                                           |
| 테스트 `tests/sessions/inbox.test.ts`                   | `tests/sessions/orchestrator-notifications.test.ts` (`git mv`)                 |

`ConversationMessage`, 메서드 이름(`put`, `pending`, `claim`, `release`, `deliverClaimed`, `deliver`),
`settleAbandonedClaims`, 열 이름은 바꾸지 않는다. `SessionDispatches`와 그 타입들도 그대로다.

### `src/sessions/message-delivery.ts` (새 파일)

```ts
import { Schema } from "effect";

/**
 * When a message is handed to a conversation, whoever wrote it: `interrupt` cuts into the run in
 * progress, `wake` starts a run when the conversation is idle, `next_run` waits for a run that
 * starts anyway. The orchestrator's notifications carry one; the user's own waiting messages mean
 * the same by their mode (decisions.md "앱이 모델에게 전할 알림은 orchestrator notifications에 둔다").
 */
export const MessageDelivery = Schema.Literals(["interrupt", "wake", "next_run"]);
export type MessageDelivery = typeof MessageDelivery.Type;
```

`orchestrator-notifications.ts`는 이것을 import해 `delivery`의 타입으로 쓴다. 그 파일은 `MessageDelivery`를
다시 내보내지 않는다. `index.ts`가 `./sessions/message-delivery.ts`에서 내보낸다.

`packages/memory-agent/src/agent/notification-delivery.ts`의 `NotificationDelivery`(`wake`, `next_run`: 작업이
시작할 때 정하는 값)는 고치지 않는다.

### 파일 머리의 주석

`orchestrator-notifications.ts`의 머리 주석을 새 뜻으로 고친다:

```ts
/**
 * What the app's orchestrator hands a conversation's model without the user typing it: the end of a
 * task, a message another conversation left, the board's call. One table for every sender
 * (docs/decisions.md "앱이 모델에게 전할 알림은 orchestrator notifications에 둔다"). A row waits until
 * a run of its conversation hands it to the model; the app restarts never lose one. The user's own
 * waiting messages are not here: they stay in `queued_messages`.
 */
```

그 밖의 주석에서 "inbox"라는 말은 "notifications"나 "the table"로 바꾼다. 뜻은 바꾸지 않는다.

### migration

`migrations` 배열 끝에 `export const orchestratorNotificationsMigration` 한 단계를 더한다. `sender`의 CHECK를
바꾸려면 표를 다시 만들어야 하므로 이름 바꾸기(`ALTER TABLE … RENAME`)를 쓰지 않는다.

```sql
  -- What the app's orchestrator hands a conversation's model without the user typing it
  -- (decisions.md "앱이 모델에게 전할 알림은 orchestrator notifications에 둔다"): the session inbox
  -- under the name that says whose it is. A message the user sent stays in queued_messages, so
  -- 'user' is no sender here. Rows and their claims move as they are.
  CREATE TABLE orchestrator_notifications (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK (sender IN ('task', 'conversation', 'board')),
    delivery TEXT NOT NULL CHECK (delivery IN ('interrupt', 'wake', 'next_run')),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    state TEXT NOT NULL CHECK (state IN ('waiting', 'delivered')),
    claimed_run_id TEXT,
    claimed_at TEXT,
    delivered_run_id TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    CHECK ((claimed_run_id IS NULL) = (claimed_at IS NULL)),
    CHECK ((state = 'delivered') = (delivered_run_id IS NOT NULL)),
    CHECK ((state = 'delivered') = (delivered_at IS NOT NULL))
  );
  INSERT INTO orchestrator_notifications (id, session_id, sender, delivery, payload, state,
    claimed_run_id, claimed_at, delivered_run_id, created_at, delivered_at)
  SELECT id, session_id, sender, delivery, payload, state, claimed_run_id, claimed_at,
    delivered_run_id, created_at, delivered_at
  FROM session_inbox;
  DROP TABLE session_inbox;
  CREATE INDEX orchestrator_notifications_waiting
    ON orchestrator_notifications(session_id, state, created_at);
  CREATE INDEX orchestrator_notifications_claimed ON orchestrator_notifications(claimed_run_id)
    WHERE claimed_run_id IS NOT NULL;
```

`DROP TABLE`이 옛 인덱스 둘도 지운다.

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

- `packages/memory-agent/src/sessions/inbox.ts` → `orchestrator-notifications.ts` (`git mv` 뒤 고친다)
- `packages/memory-agent/src/sessions/message-delivery.ts` (새 파일)
- `packages/memory-agent/src/sessions/dispatches.ts`
- `packages/memory-agent/src/layers.ts`
- `packages/memory-agent/src/index.ts`
- `packages/memory-agent/src/tools/code.ts` (주석 한 줄)
- `packages/memory-agent/src/db/migrations.ts` (배열 끝에 한 단계)
- `packages/memory-agent/tests/sessions/inbox.test.ts` → `orchestrator-notifications.test.ts`
- `packages/memory-agent/tests/sessions/dispatches.test.ts`
- `packages/memory-agent/tests/agent/dispatch-delivery.test.ts`
- `packages/memory-agent/tests/agent/notify-session-record.test.ts`
- `packages/memory-agent/tests/session-inbox-migration.test.ts` (테스트 1과 3)
- `packages/memory-agent/tests/orchestrator-notifications-migration.test.ts` (새 파일)
- `packages/memory-agent/src/sessions/README.md`, `docs/decisions.md`

**고치지 않는다**

- `sessionInboxMigration`과 `migrations` 배열의 앞 단계들.
- `packages/memory-agent/src/agent/` 전부(`dispatch-notifications.ts`, `task-notifications.ts`, `chat.ts`,
  `notification-delivery.ts`): 이들은 `SessionDispatches`를 쓰고 inbox의 이름을 쓰지 않는다.
- `packages/memory-agent/src/queue/`: 사용자 메시지 큐는 뒤의 계획이다.
- `packages/memory-agent/src/tools/background.ts`, `src/work-trace/`: 계획 033과 그 뒤의 것이다.
- 사람의 판단을 기다리는 함(`decision-inbox`, `human-decision`, "통합 inbox").
- `apps/agent`, `plans/`.

## Git workflow

- 지금 있는 branch에서 일한다(worktree가 주어졌으면 그 branch). push하지 않는다. merge하지 않는다.
- 단계마다 commit 하나. 메시지는 한국어 conventional commit이다. 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`
- commit마다 typecheck와 lint가 통과해야 한다. commit hook이 `vp check --fix`를 돌린다.
- 파일을 옮길 때는 `git mv`를 쓴다(이력이 이어진다).
- 자기가 고친 경로만 commit한다.

## Steps

### Step 1: 표, 서비스, 타입의 이름을 바꾼다

코드와 migration을 한 commit에 넣는다(표 이름이 바뀌면 옛 SQL이 돌지 않는다).

1. `migrations.ts`: `orchestratorNotificationsMigration`을 `export const`로 두고 배열 끝에 더한다("만들 것"의
   SQL). 앞에 한 줄 JSDoc을 둔다(본보기: `sessionInboxMigration` 위의
   `/** The step that creates the session inbox and moves the session dispatches into it. */`).
2. `src/sessions/message-delivery.ts`를 만든다.
3. `git mv packages/memory-agent/src/sessions/inbox.ts packages/memory-agent/src/sessions/orchestrator-notifications.ts`.
   그 파일에서 "이름 표"대로 고친다: 식별자, 서비스 키, SQL의 표 이름 여덟 곳, `NotificationSender`의 값
   (`user`를 뺀다), `MessageDelivery` import, 머리 주석과 그 밖의 주석.
4. `dispatches.ts`: import 경로와 이름, `fromNotifications`, `const notifications = yield*
   OrchestratorNotifications;`와 그 변수를 쓰는 곳. 머리 주석의 "The rows live in the session inbox
   (`SessionInbox`, sender `conversation`)"을 새 이름으로 고친다.
5. `layers.ts`: import와 두 줄.
6. `index.ts`: 내보내는 이름과 경로. `MessageDelivery`는 `./sessions/message-delivery.ts`에서 내보낸다.
7. `tools/code.ts`: 주석의 `` `session_inbox` ``를 `` `orchestrator_notifications` ``로.
8. 테스트:
   - `git mv packages/memory-agent/tests/sessions/inbox.test.ts packages/memory-agent/tests/sessions/orchestrator-notifications.test.ts`.
     그 파일의 `SessionInbox`를 `OrchestratorNotifications`로, SQL의 `session_inbox`를
     `orchestrator_notifications`로, 변수 `inbox`를 `notifications`로 고친다. 테스트 이름의 "inbox"는
     "notifications"로 고친다(예: "rows put in an inbox wait there, oldest first" → "notifications put for a
     conversation wait there, oldest first"). 단언은 바꾸지 않는다.
   - `tests/sessions/dispatches.test.ts`, `tests/agent/dispatch-delivery.test.ts`,
     `tests/agent/notify-session-record.test.ts`: SQL 글자열과 주석의 `session_inbox`를
     `orchestrator_notifications`로.
   - `tests/session-inbox-migration.test.ts`:
     - 테스트 1: `IN (…)` 목록에 `'orchestrator_notifications'`를 더하고 기대값을
       `[{ name: "orchestrator_notifications" }]`로 고친다. 이름을 "the newest schema has neither the inbox
       nor the dispatch tables, only the orchestrator's notifications"로 고친다.
     - 테스트 3: `INSERT INTO session_inbox`를 `INSERT INTO orchestrator_notifications`로.
     - 테스트 2는 고치지 않는다.
9. `rg --hidden -n 'session_inbox|SessionInbox|Inbox(Sender|Delivery|State|Entry|StoreFailed|Row)|inboxPayloads|NewInboxEntry|sessions/inbox|fromInbox' packages apps -g '!.git' -g '!node_modules' -g '!*.md'`
   로 남은 쓰임을 확인한다. 나와도 되는 것: `src/db/migrations.ts`(`sessionInboxMigration`과 새 단계의
   `FROM session_inbox`, `DROP TABLE session_inbox`), `tests/session-inbox-migration.test.ts`(테스트 1의 목록과
   테스트 2). 그 밖에 나오면 고친다. `apps`에서 나오면 STOP이다.

**Verify**:

- `vp run memory-agent#typecheck` → exit 0
- `vp run agent#typecheck` → exit 0
- `cd packages/memory-agent && vp test run --maxWorkers=4 tests/sessions tests/agent tests/session-inbox-migration.test.ts tests/database.test.ts tests/db-migrator-metadata.test.ts tests/notification-delivery-migration.test.ts tests/golden src/db`
  → 모두 통과 (`orchestrator-notifications.test.ts`는 7개)
- `git status --short packages/memory-agent/tests/golden` → 비어 있다. 바뀌어야 통과하면 STOP이다.
- 루트 `vp lint` → exit 0

commit: `refactor(sessions): 세션 inbox의 이름을 orchestrator notifications로 바꾼다`

### Step 2: migration 테스트

새 파일 `tests/orchestrator-notifications-migration.test.ts`. 본보기: `tests/session-inbox-migration.test.ts`
(`DatabaseSync(":memory:")`, `migrations.indexOf(<상수>)`, `migrations.slice(0, index).forEach((step) =>
db.exec(step))`, 프로젝트와 대화를 넣는 `twoConversations`).

경우:

- **행이 그대로 옮겨진다.** `orchestratorNotificationsMigration` 앞까지 적용하고, 프로젝트 하나와 대화 둘을
  넣고, `session_inbox`에 행 셋을 넣는다: 기다리는 것, run이 잡은 것(`claimed_run_id = 'run-8'`,
  `claimed_at = '2026-01-05'`), 전한 것(`state = 'delivered'`, `delivered_run_id = 'run-9'`,
  `delivered_at = '2026-01-04'`). 셋 다 `sender = 'conversation'`, `delivery = 'next_run'`이다. 그 단계를
  적용한 뒤 `SELECT * FROM orchestrator_notifications ORDER BY id`가 넣은 열 값 그대로의 세 행이다.
  `sqlite_master`에 표 `session_inbox`와 인덱스 `session_inbox_waiting`, `session_inbox_claimed`가 없고,
  인덱스 `orchestrator_notifications_waiting`, `orchestrator_notifications_claimed`가 있다.
- **`user`는 보낸 쪽이 아니다.** 배열 전체를 적용한 뒤 `sender = 'user'`인 행의 `INSERT`가 던진다
  (`expect(() => …).toThrow()`). `sender = 'task'`와 `'board'`인 행은 들어간다.
- `PRAGMA foreign_key_check`가 비어 있다.

**Verify**:

- `cd packages/memory-agent && vp test run --maxWorkers=4 tests/orchestrator-notifications-migration.test.ts`
  → 모두 통과
- `vp run memory-agent#typecheck`, `vp run agent#typecheck` → exit 0
- 루트 `vp lint` → exit 0

commit: `test(db): 세션 inbox를 orchestrator notifications로 옮기는 migration을 시험한다`

### Step 3: 문서

1. `docs/decisions.md` 끝에 새 항목 "앱이 모델에게 전할 알림은 orchestrator notifications에 둔다
   (2026-11-23)"를 더한다. 이 제목은 코드 주석이 가리키므로 글자 그대로 쓴다. 적을 것:
   - 결정(사용자, 2026-11-23): 표 `session_inbox`의 이름을 `orchestrator_notifications`로 바꾼다. 까닭: 사용자의
     알림함처럼 읽혔다. 이 표는 앱이 사용자 대신 모델에게 전할 것을 두는 서버의 표다. 코드가 그렇게 넣은
     메시지를 이미 orchestrator가 보낸 메시지라고 부른다(`OrchestratorNote`).
   - 모델은 이 표를 도구로 열지 않는다. 서버가 모델을 부르기 전에 꺼내 넣는다. 까닭: 모델이 도구를 부르지
     않으면 알림이 전해지지 않고, 쉬는 대화를 깨우는 일은 서버만 할 수 있다. 모델이 먼저 읽는 길(끝난
     백그라운드 작업의 결과를 기다리는 도구)은 그대로 있다.
   - 사용자가 답 도중에 보낸 메시지는 `queued_messages`에 남는다. 쓴 쪽이 사람이라 규칙이 다르다: 고치고
     지울 수 있고, 멈춘 뒤에는 본인이 확인해야 나가고, 순서 번호와 첨부가 있고, 사용자 turn으로 들어간다.
     그래서 `sender`에서 `user`를 뺐다.
   - "언제 전하나"의 값(`interrupt`, `wake`, `next_run`)은 타입 하나(`MessageDelivery`)로 알림과 사용자
     메시지가 같이 쓴다. 사용자 메시지의 `steer`는 `interrupt`, `queue`는 `wake`와 같은 뜻이다. 사용자 메시지
     큐가 이 타입을 쓰게 하는 것은 뒤의 일이다.
   - 바뀐 이름: "이름 표"의 표·서비스·타입.
   - 대체하는 결정: "대화에 들어오는 메시지는 세션 inbox 하나에 둔다 (2026-11-22)"의 표·서비스 이름과,
     보낸 쪽에 사용자가 있다고 한 부분. 그 밖은 그대로다.
   - 버린 안: 이름 `model_inbox`, `session_notices`, `pending_inputs`, `pending_orchestrator_jobs`. 모델이 여는
     도구. 사용자 메시지까지 한 표에 두기.
2. `packages/memory-agent/src/sessions/README.md`의 23–27행과 53행을 새 이름으로 고친다. 23행의 `sender` 나열에서
   `user`를 빼고, 사용자가 보낸 메시지는 `queued_messages`에 있다고 한 문장을 더한다. `MessageDelivery`와 새
   파일 `message-delivery.ts`를 Interface 절에 더한다.
3. `rg --hidden -n -i 'session_inbox|SessionInbox|세션 inbox|세션 수신함' -g '*.md' -g '!.git' -g '!node_modules' -g '!plans/**' packages apps docs`
   로 다른 문서를 찾는다. `docs/decisions.md`의 지난 항목은 고치지 않는다. 폴더 `README.md`가 옛 이름을 적고
   있으면 고친다.

**Verify**: `vp run agent#typecheck` 뒤 루트 `vp lint` → exit 0. commit hook이 통과한다.

commit: `docs(sessions): 세션 inbox의 새 이름과 사용자 메시지를 따로 두는 결정을 적는다`

## Test plan

- 새 테스트: `tests/orchestrator-notifications-migration.test.ts`(Step 2).
- 고치는 테스트: 이름과 SQL 글자열만(Step 1). 단언의 뜻은 하나도 바뀌지 않는다.
  `session-inbox-migration.test.ts`의 테스트 1만 기대값(표 이름)이 바뀐다.
- 바뀌지 않아야 하는 것: golden 파일, `session-inbox-migration.test.ts`의 테스트 2.

## Done criteria

- [ ] `vp run memory-agent#typecheck`, `vp run agent#typecheck`, 루트 `vp lint`가 모두 exit 0이다.
- [ ] Step 1과 Step 2의 테스트 명령이 모두 통과한다.
- [ ] Step 1의 9번 `rg`가 허락된 두 파일에서만 나온다.
- [ ] `rg --hidden -n -i 'inbox' packages/memory-agent/src/sessions packages/memory-agent/src/layers.ts packages/memory-agent/src/tools/code.ts -g '!*.md'`
      → 결과 없음.
- [ ] `git diff b1893738..HEAD --stat -- packages/memory-agent/src/agent packages/memory-agent/src/queue packages/memory-agent/src/work-trace packages/memory-agent/src/tools/background.ts apps`
      → 비어 있다.
- [ ] commit이 셋이고, 각각 typecheck와 lint가 통과한 상태다.

## STOP conditions

멈추고 보고한다:

- "Current state"의 발췌가 실제 코드와 다르다(공백과 몇 줄의 번호 차이는 빼고).
- `apps/agent`나 `src/agent/`가 inbox의 이름을 써서 고쳐야 한다.
- golden 파일이 바뀌어야 통과한다.
- 단언의 뜻을 바꿔야 통과하는 테스트가 있다(표 이름과 식별자 말고).
- migration이 실패한다(`sender`가 `user`인 행이 있거나, `session_inbox`를 가리키는 표·trigger·view가 있다).
- 새 이름이 이미 있는 이름과 겹친다(`rg`로 `OrchestratorNotifications|NotificationSender|NotificationState|NotificationEntry|NotificationStoreFailed|notificationPayloads|MessageDelivery`
  를 찾았을 때 이 계획이 만든 것 말고 나온다).
- 같은 Verify가 고친 뒤에도 두 번 실패한다.

## Maintenance notes

- 계획 033(끝난 백그라운드 작업의 알림)은 옛 이름으로 쓰여 있다. 이 계획이 merge된 뒤 검토자가 새 이름으로
  고쳐 다시 찍는다. 033의 migration은 `orchestrator_notifications`에 넣는다.
- `MessageDelivery`를 사용자 메시지 큐(`src/queue`)가 쓰게 하는 것은 따로 할 일이다. 지금 큐는 `mode`
  (`queue`, `steer`)와 열 `steered`로 같은 뜻을 적는다.
- `NotificationDelivery`(`src/agent/notification-delivery.ts`)는 `MessageDelivery`의 두 값(`wake`, `next_run`)
  이다. 작업의 끝은 답을 끊지 않기 때문에 따로 있다. 둘을 잇는 것(한쪽에서 다른 쪽을 만든다)은 필요해질 때
  한다.
- 이 migration은 표를 새 이름으로 다시 만든다. 이 단계를 모르는 옛 빌드는 새 DB 파일을 열지 못한다(스키마
  버전이 더 높아 거절된다). 저장소의 다른 migration과 같은 조건이다.
- 검토할 때 볼 것: 옮겨진 행의 claim 열이 그대로인가, 옛 인덱스가 남지 않았는가, `user`를 보낸 쪽으로 받는
  코드나 CHECK가 남지 않았는가, 사람의 판단을 기다리는 함(`decision-inbox`)을 건드리지 않았는가.
