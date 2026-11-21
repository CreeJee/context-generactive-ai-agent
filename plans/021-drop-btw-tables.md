# Plan 021: BTW의 DB 표를 지운다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. `plans/README.md`는 고치지 않는다(검토자가 고친다).
>
> **Drift check (먼저 실행)**:
>
> 1. `ls packages/memory-agent/src/btw 2>&1` → 디렉터리가 없다(Plan 020이 들어가 있다). 있으면 STOP.
> 2. `grep -n "btw_attachments" packages/memory-agent/src/attachments/attachments.ts` → 한 줄이 나온다.
> 3. `tail -8 packages/memory-agent/src/db/migrations.ts`와 "Current state"의 발췌를 견준다. `migrations`
>    배열의 마지막 step이 `ALTER TABLE sessions ADD COLUMN model_selection TEXT;`가 아니면 STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED (되돌릴 수 없는 삭제다. 앱이 DB를 열 때 저장된 BTW 스레드를 지운다)
- **Depends on**: Plan 020
- **Category**: 기능 정리
- **Planned at**: Plan 020을 적용한 뒤의 코드(020의 시작 commit `7696fc99`), 2026-11-16

## Why this matters

Plan 020이 BTW 곁질문 기능의 화면과 서버 코드를 지웠다. DB의 표 `btw_threads`, `btw_thread_messages`,
`btw_attachments`는 남겨 두었다. 사용자는 2026-11-16에 저장된 BTW 스레드도 쓸모가 없으니 정리하라고
정했다. 이제 이 표들을 읽거나 쓰는 코드가 없으므로 표를 지우고, 첨부 정리가 `btw_attachments`를 보는
조건도 뺀다. 사용자의 로컬 DB에는 BTW 스레드가 2개, BTW에 붙인 이미지가 0개 있다.

이 삭제는 되돌릴 수 없다. 사용자가 정한 일이다.

## Current state

경로는 `packages/memory-agent/` 기준이다.

### migration step의 목록: `src/db/migrations.ts`

`migrations`는 SQL 문자열의 배열이다. 앱이 DB를 열 때 `user_version` 다음 step부터 차례로 돌린다
(`src/db/database.ts`). **이미 있는 step은 한 글자도 고치지 않는다.** 새 step은 배열의 끝에 더한다.
지금 배열의 끝은 이렇다.

```ts
  `
  -- The model a conversation runs on, as JSON of its provider, model and effort (decisions.md
  -- "모델은 대화마다 둔다"). NULL follows the app's selected model, as every conversation did
  -- before this column.
  ALTER TABLE sessions ADD COLUMN model_selection TEXT;
  `,
];
```

표를 지우는 step의 선례는 이름 붙여 내보낸 상수다(`src/db/migrations.ts:725-732`).

```ts
export const textIndexDropMigration = `
  -- Trigram and morph matching read the lexical index now, so the FTS5 tables and the Kiwi morph
  -- terms have no reader. The freed pages stay in the file until a VACUUM.
  DROP TRIGGER nodes_fts_insert;
  DROP TABLE nodes_fts;
  DROP TABLE nodes_morph;
  DROP TABLE node_morphs;
`;
```

BTW 표를 만드는 옛 step(고치지 않는다): `btw_threads`와 `btw_attachments`는 2254–2277행 부근의 step,
`btw_thread_messages`는 `btwThreadMessagesMigration`(583–603행)이다. 표의 관계는 이렇다.

- `btw_threads.parent_session_id`가 `sessions(id)`를 가리킨다(ON DELETE CASCADE).
- `btw_thread_messages.thread_id`와 `btw_attachments.thread_id`가 `btw_threads(id)`를 가리킨다.
- index `btw_threads_parent`, `btw_attachments_attachment`와 trigger `btw_threads_binding_immutable`은 각
  표에 딸려 있다. 표를 지우면 함께 지워진다.

`tanStackRowsMigration` step과 함께 도는 `migrateTanStackRows`(`src/chat-store/tanstack-migration.ts`)는
`btw_threads`를 읽고 쓴다. 그 step은 표를 지우는 새 step보다 앞에서 돌므로 그대로 둔다.

### 첨부 정리: `src/attachments/attachments.ts:142-152`

```ts
// One statement decides and deletes, so a link added meanwhile keeps its blob.
const deleteOrphans = SqlSchema.findAll({
  Request: Schema.Void,
  Result: AttachmentRow,
  execute: () => sql`
      DELETE FROM attachments AS a
      WHERE NOT EXISTS (SELECT 1 FROM node_attachments n WHERE n.attachment_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM btw_attachments b WHERE b.attachment_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM queued_message_attachments q WHERE q.attachment_id = a.id)
      RETURNING *`,
});
```

표를 지운 뒤 이 문장은 "no such table: btw_attachments"로 실패한다. 조건을 반드시 함께 뺀다.

### 끝까지 migrate한 뒤 BTW 표를 읽는 테스트

`tests/btw-thread-messages-migration.test.ts`(45줄, 테스트 하나): `btwThreadMessagesMigration` 바로 앞까지
step을 돌리고 `btw_threads`에 행 셋을 넣은 뒤 `migrateDatabase(db)`로 끝까지 올리고, `btw_thread_messages`의
행과 `btw_threads`의 열을 읽어 견준다. 표를 지우면 이 읽기가 실패한다.

`tests/tanstack-rows-migration.test.ts:45-61`: `btw_threads`에 행 하나를 넣고 `migrateDatabase(db)` 뒤에
이렇게 읽는다.

```ts
expect(
  yield *
    messages(
      "SELECT '[' || group_concat(message, ',' ORDER BY seq) || ']' AS messages FROM btw_thread_messages WHERE thread_id = 'btw'",
    ),
).toEqual([moved]);
expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length });
```

### 문서

- `src/attachments/README.md:36`: 첨부를 가리키는 표를 `node_attachments`, `btw_attachments`,
  `queued_message_attachments` 셋으로 적는다.
- `docs/decisions.md`의 맨 끝 항목 `## BTW 곁질문을 없앤다 (2026-11-16)`(Plan 020이 썼다)은 표를 남긴다고
  적는다.

### 저장소 규칙

- 테스트를 고칠 때는 그 테스트가 지키려던 뜻을 먼저 읽는다(`git log --follow -- <파일>`의 첫 commit).
  뜻에 맞게 고치고 commit 메시지에 그 commit을 적는다.
- lint 끄기 주석, `let`, `while`, `unknown`을 쓰지 않는다. 줄바꿈을 손으로 고치지 않는다.
- SQL step의 주석은 영어로 쓰고, 무엇을 왜 하는지 한두 줄로 적는다(위 선례와 같은 모양).

## Commands you will need

| Purpose         | Command                                              | Expected on success                          |
| --------------- | ---------------------------------------------------- | -------------------------------------------- |
| 서버 typecheck  | 저장소 루트에서 `vp run memory-agent#typecheck`      | exit 0, 출력에 `error TS`와 `warning`이 없다 |
| agent typecheck | 저장소 루트에서 `vp run agent#typecheck`             | exit 0, 출력에 `error TS`와 `warning`이 없다 |
| 포맷·lint       | 저장소 루트에서 `vp check`                           | exit 0                                       |
| 서버 테스트     | `cd packages/memory-agent && vp test --run <파일들>` | all pass                                     |

- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**
- 서버 테스트가 `NativeOwnerFailed: native-incompatible`로 건너뛰면 저장소 루트에서
  `vp run turbovec#build`를 한다.
- 사용자의 실제 DB(`~/.context-generactive-agent/agent.db`)를 열지 않는다. 테스트는 메모리 DB를 쓴다.

## Scope

**In scope**:

- `packages/memory-agent/src/db/migrations.ts` (상수 하나와 배열 끝의 한 줄을 더하기만 한다)
- `packages/memory-agent/src/attachments/attachments.ts` (`deleteOrphans`의 한 줄)
- `packages/memory-agent/tests/btw-thread-messages-migration.test.ts` (지운다)
- `packages/memory-agent/tests/btw-tables-drop-migration.test.ts` (새 파일)
- `packages/memory-agent/tests/tanstack-rows-migration.test.ts`
- `packages/memory-agent/src/attachments/README.md`, `packages/memory-agent/src/db/README.md`(BTW 표나
  step 목록을 말하는 줄이 있을 때만), `docs/decisions.md`

**Out of scope**:

- `migrations` 배열의 이미 있는 step 전부, `btwThreadMessagesMigration`, `src/chat-store/tanstack-migration.ts`.
- `tests/fixtures/release-0.0.17.sql`. 옛 release의 schema다.
- `VACUUM`. 비운 페이지는 파일에 남는다(선례와 같다).
- `docs/designs/`와 그 밖의 옛 문서.

## Git workflow

- 지금 브랜치에 commit한다. 브랜치를 바꾸지 않는다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- Step 1과 Step 2는 한 commit이다(표를 지우는 step과 정리 조건은 따로 들어가면 테스트가 깨진다).
  Step 3은 따로 commit한다.
- 메시지는 한국어 conventional commit이다. 예: `refactor(db): BTW 표를 지운다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1. 표를 지우는 step을 더하고 정리 조건을 뺀다

`src/db/migrations.ts`의 `textIndexDropMigration` 정의 바로 뒤에 상수를 더한다.

```ts
/** The step that drops the BTW side threads, which no code reads since BTW was removed. */
export const btwTablesDropMigration = `
  -- BTW side threads were removed (decisions.md "BTW 곁질문을 없앤다"), so their tables have no
  -- reader or writer. The stored threads go with them. An image only a BTW message carried becomes
  -- an orphan, which the next attachment cleanup deletes. Children first, then the parent.
  DROP TABLE btw_attachments;
  DROP TABLE btw_thread_messages;
  DROP TABLE btw_threads;
`;
```

`migrations` 배열의 맨 끝, `ALTER TABLE sessions ADD COLUMN model_selection TEXT;` step의 닫는 `` `, `` 다음
줄에 `btwTablesDropMigration,`을 더한다. 다른 step은 건드리지 않는다.

`src/attachments/attachments.ts`의 `deleteOrphans`에서 이 한 줄을 지운다.

```ts
        AND NOT EXISTS (SELECT 1 FROM btw_attachments b WHERE b.attachment_id = a.id)
```

**Verify**: `vp run memory-agent#typecheck` → 오류와 경고 없음.

### Step 2. 테스트

1. `tests/btw-thread-messages-migration.test.ts`를 `git rm`으로 지운다. 그 step의 결과는 이제 끝까지
   migrate한 DB에서 볼 수 없고, 옮긴 행은 새 step이 지운다.
2. `tests/btw-tables-drop-migration.test.ts`를 새로 쓴다. 지운 파일과 같은 모양을 따른다
   (`DatabaseSync(":memory:")`, `Effect.acquireRelease`, `migrations.indexOf(...)`로 그 step 앞까지 돌리기,
   `migrateDatabase(db)`). 테스트 하나다.
   - 이름: `"opening a database drops the BTW tables and the threads they held"`
   - `const index = migrations.indexOf(btwTablesDropMigration);`, 그 앞의 step을 모두 돌리고
     `PRAGMA user_version = ${index}`를 적는다.
   - 프로젝트 하나, 대화 하나, `btw_threads` 행 하나, `btw_thread_messages` 행 하나, `btw_attachments` 행
     하나를 넣는다. 이 시점의 `btw_threads`에는 `messages` 열이 없다. 열은
     `id, parent_session_id, created_at, updated_at`이다. `btw_thread_messages`는 `thread_id, seq, message`,
     `btw_attachments`는 `thread_id, attachment_id`다. 프로젝트와 대화를 넣는 문장은 지운 파일의 것을
     그대로 쓰되, 그 뒤에 더해진 NOT NULL 열 때문에 실패하면 `PRAGMA table_info`로 열을 보고 맞춘다.
   - `yield* migrateDatabase(db);`
   - 단언 1: `SELECT name FROM sqlite_master WHERE name LIKE 'btw%'`의 결과가 `[]`다(표, index, trigger가
     모두 없다).
   - 단언 2: `SELECT id FROM sessions`의 결과가 넣은 대화 하나다(대화는 남는다).
   - 단언 3: `PRAGMA user_version`이 `migrations.length`다.
   - 단언 4: `PRAGMA foreign_key_check`의 결과가 `[]`다.
3. `tests/tanstack-rows-migration.test.ts`: `btw_thread_messages`를 읽는 `expect` 블록 하나를 지운다.
   `btw_threads`에 행을 넣는 부분은 남긴다(그 step이 BTW 행이 있어도 실패하지 않는다는 것을 계속
   본다). 테스트 이름의 `, BTW threads included`를 `, with BTW threads present`로 바꾼다.

다른 테스트가 끝까지 migrate한 DB의 표 목록을 통째로 적어 두고 견주다가 실패하면, 그 목록에서 BTW 표
셋과 그 index·trigger만 뺀다. 그 밖의 실패는 STOP이다.

**Verify**:

- `cd packages/memory-agent && vp test --run tests/btw-tables-drop-migration.test.ts tests/tanstack-rows-migration.test.ts tests/database.test.ts tests/db-migrator-metadata.test.ts tests/chat/attachments.test.ts tests/memory/record.test.ts`
  → all pass.
- `cd packages/memory-agent && vp test --run tests/*-migration.test.ts` → all pass.
- `vp run memory-agent#typecheck`, `vp run agent#typecheck` → 오류와 경고 없음.
- `vp check` → exit 0.

Step 1과 Step 2를 한 commit으로 올린다.

### Step 3. 문서

1. `src/attachments/README.md:36`: SQL 설명과 표 목록에서 `btw_attachments`를 뺀다. 첨부를 가리키는 표는
   `node_attachments`와 `queued_message_attachments` 둘이다.
2. `src/db/README.md`에 BTW 표나 이름 붙은 step의 목록이 있으면 지금에 맞게 고친다. 없으면 건드리지
   않는다.
3. `docs/decisions.md`의 `## BTW 곁질문을 없앤다 (2026-11-16)` 항목에서 "결정"의 아래 세 줄
   (표를 남긴다는 줄, 첨부 정리 줄, "이제 이 표들에 쓰는 코드는 없다" 줄)과 "남은 것" 줄을 아래로
   바꾼다. "계기"와 "결정"의 첫 줄은 그대로 둔다.

```md
- DB의 `btw_threads`, `btw_thread_messages`, `btw_attachments` 표도 지운다. 앱이 DB를 열 때 migration step 하나가 지운다. 저장되어 있던 BTW 스레드는 함께 사라지고 되살릴 수 없다. 사용자가 정했다.
- 표를 만들고 옮기던 옛 migration step은 그대로 둔다. 옛 DB가 지금 판으로 올라오는 길이다.
- 첨부 정리는 `btw_attachments`를 더 보지 않는다. BTW 메시지에만 붙어 있던 이미지는 다음 정리에서 지워진다.
```

**Verify**:

- `vp check` → exit 0.
- `grep -c "남은 것: 표를 지우는 migration" docs/decisions.md` → `0`.
- `grep -c "^## BTW 곁질문을 없앤다 (2026-11-16)" docs/decisions.md` → `1`.

commit한다.

## Test plan

- 새 테스트 `tests/btw-tables-drop-migration.test.ts` 하나: BTW 행이 든 DB를 끝까지 올리면 BTW 표가
  없고, 대화는 남고, FK 검사가 깨끗하다.
- `tests/tanstack-rows-migration.test.ts`는 BTW 행이 있는 옛 DB가 여전히 끝까지 올라오는지를 본다.
- `tests/chat/attachments.test.ts`는 정리 문장이 표 없이도 도는지를 본다.

## Done criteria

- [ ] `vp run memory-agent#typecheck`, `vp run agent#typecheck` → exit 0, `error TS`와 `warning` 없음
- [ ] `vp check` → exit 0
- [ ] Step 2의 테스트 명령 둘 → all pass
- [ ] `grep -rn "btw_attachments" packages/memory-agent/src --include=*.ts` → `src/db/migrations.ts`의 줄만
      나온다
- [ ] `git diff <시작 commit> HEAD -- packages/memory-agent/src/db/migrations.ts | grep -c '^-[^-]'` → `0`
      (이미 있는 step에서 지워진 줄이 없다)
- [ ] `git diff --stat <시작 commit> HEAD -- packages/memory-agent/src/chat-store packages/memory-agent/tests/fixtures`
      → 출력 없음
- [ ] `git status --short` → 비어 있다

## STOP conditions

- Drift check가 맞지 않는다.
- 표를 지우는 step이 FK 오류로 실패한다(다른 표가 BTW 표를 가리키고 있다). 어느 표인지 보고한다.
- `src`의 다른 코드가 BTW 표를 읽거나 쓴다(`migrations.ts`와 `tanstack-migration.ts`는 뺀다).
- 이미 있는 migration step을 고쳐야만 테스트가 통과한다.

## Maintenance notes

- 이 step이 돈 뒤에는 BTW 스레드를 되살릴 수 없다. merge하기 전에 필요하면 DB 파일을 복사해 둔다.
- `tanstack-migration.ts`의 BTW 부분과 `btwThreadMessagesMigration`은 옛 DB를 올리는 길이라 남는다.
  step 목록을 한 번에 줄이는 일이 생기면 그때 함께 없앤다.
