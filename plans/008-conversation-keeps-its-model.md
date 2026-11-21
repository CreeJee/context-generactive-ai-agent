# Plan 008: 대화가 자기 모델을 가진다 (저장, 실행, API)

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- packages/memory-agent/src/sessions packages/memory-agent/src/providers/active-provider.ts packages/memory-agent/src/agent/chat.ts packages/memory-agent/src/api/app-api/sessions.ts packages/memory-agent/src/api/app-api/providers.ts packages/memory-agent/src/db/migrations.ts apps/agent/app/.server/api/sessions.ts apps/agent/app/entry/api.ts`
> 출력이 있으면 "Current state"의 발췌와 실제 코드를 견준다. 다르면 STOP이다. `migrations.ts`는
> 다른 세션이 끝에 항목을 더했을 수 있다. 그 경우는 끝에 이어 붙이면 되므로 STOP이 아니다.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `d65cc285`, 2026-11-14

## Why this matters

지금 모델 선택은 앱 전체에 하나다(`config.json`의 `provider`·`model`·`reasoningEffort`). 한
대화에서 모델을 바꾸면 다른 모든 대화의 다음 답도 그 모델로 나온다. 사용자가 2026-11-14에
정했다: 모델은 대화마다 둔다.

이 계획은 서버와 클라이언트 API까지다. 화면의 선택기는 Plan 009가 만든다. 이 계획 뒤에는:

- 대화(`sessions` 행)가 자기 모델 선택을 가질 수 있다. 없으면 앱의 기본 선택을 따른다.
- 화면에서 새로 만든 대화는 그때의 기본 선택을 자기 것으로 가지고 시작한다. 그 뒤로 기본
  선택이 바뀌어도 그 대화는 바뀌지 않는다.
- 대화의 채팅 run, `/compact`, 컨텍스트 사용량 표시가 그 대화의 모델을 쓴다.
- 앱의 기본 선택(지금의 전역 선택)은 그대로 남는다. 새 대화의 시작값이고, 자기 모델이 없는 옛
  대화와 대화 밖의 일(요약, 해석, BTW, 제보, 역할 모델이 없는 Goal 역할)이 쓴다.

## Current state

### 관련 파일

- `packages/memory-agent/src/sessions/contracts.ts` — `Session` 스키마. 브라우저도 쓴다.
- `packages/memory-agent/src/sessions/sessions.ts` — `Sessions` 서비스(SQL).
- `packages/memory-agent/src/db/migrations.ts` — `migrations` 배열(841행부터). 끝에 SQL 문자열을 더한다.
- `packages/memory-agent/src/providers/contracts.ts` — `ModelSelection`(55–76행), `ModelUnavailable`(126–133행).
  이 파일은 `memory-agent/provider-contracts`로 브라우저에 나가는 진입점이다. 서버 모듈은 `import type`으로만 가져온다.
- `packages/memory-agent/src/providers/active-provider.ts` — `ActiveProvider`. 전역 선택과 역할 모델.
- `packages/memory-agent/src/agent/chat.ts` — `sessionModel`(646–650행)이 대화의 run이 쓸 모델을 정한다.
- `packages/memory-agent/src/api/app-api/sessions.ts` — `/api/sessions/*`의 HttpApi 선언.
- `packages/memory-agent/src/api/app-api/providers.ts` — 모델 거절 스키마(`ModelUnavailable` 112행).
- `apps/agent/app/.server/api/sessions.ts` — 그 handler.
- `apps/agent/app/entry/api.ts` — 브라우저의 API 호출 모음(`api` 객체, 537행부터).

### 발췌

`sessions/contracts.ts:8-24`:

```ts
export const Session = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  /** The external ACP agent this conversation talks to directly; null for the app's own model. */
  agent: Schema.NullOr(Schema.String),
  /** When the user archived it: out of the session list, still part of memory. */
  archivedAt: Schema.NullOr(Schema.String),
  /** The coding agent whose transcript this conversation was migrated from; null for one held here. */
  importedFrom: Schema.NullOr(Schema.String),
  /** The git worktree of the project's repository it ran in; null for the checkout itself. */
  worktreePath: Schema.NullOr(Schema.String),
  /** The branch it ran on, when that was recorded. */
  branch: Schema.NullOr(Schema.String),
});
```

`sessions/sessions.ts:23-46,101-121,139-153` (줄임):

```ts
const SessionRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  // ...
  worktree_path: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
});
function toSession(row: typeof SessionRow.Type): Session { /* 필드를 하나씩 옮긴다 */ }
// ...
  const columns = sql`sessions.id, sessions.project_id, sessions.title, sessions.created_at,
    sessions.agent, sessions.archived_at,
    (SELECT i.source FROM imported_sessions i WHERE i.session_id = sessions.id) AS imported_from,
    sessions.worktree_path, sessions.branch`;
  // ...
  const insert = SqlSchema.findOne({
    Request: NewSession,
    Result: SessionRow,
    execute: (row) => sql`
      INSERT INTO sessions (id, project_id, title, created_at, agent, worktree_path, branch)
      VALUES (${row.id}, ${row.projectId}, ${row.title}, ${row.createdAt}, ${row.agent},
        ${row.worktreePath}, ${row.branch})
      RETURNING ${columns}`,
  });
  // ...
    create: (projectId: string, title: string | null = null, agent: string | null = null) =>
      Effect.gen(function* () {
        yield* projects.get(projectId);
        const row = yield* insert({ /* id, projectId, title, createdAt, agent, worktreePath: null, branch: null */ });
        return toSession(row);
      }),
```

`sessions/sessions.ts:127-133` — 한 열을 고치고 행을 돌려주는 본보기:

```ts
const archive = SqlSchema.findOneOption({
  Request: Schema.Struct({ id: Schema.String, archivedAt: Schema.NullOr(Schema.String) }),
  Result: SessionRow,
  execute: ({ id, archivedAt }) =>
    sql`UPDATE sessions SET archived_at = ${archivedAt} WHERE id = ${id} RETURNING ${columns}`,
});
```

`providers/active-provider.ts:38-74` (줄임):

```ts
const selected = Effect.flatMap(config.read, (settings) =>
  isTruthy(settings.provider)
    ? Effect.flatMap(registry.get(settings.provider), ({ models }) => models.selected)
    : Effect.succeed(null),
);
// ...
const chooseFor = Effect.fn("ActiveProvider.chooseFor")(function* (
  role: ModelRole,
  selection: ModelSelection | null,
) {
  if (selection !== null) {
    const { models } = yield* registry.configurationOf(selection);
    yield* Effect.fromOption(
      Arr.findFirst(
        yield* models.list,
        (model) =>
          model.id === selection.model &&
          model.supportedReasoningEfforts.includes(selection.reasoningEffort),
      ),
      () => ModelUnavailable.make(selection),
    );
  }
  yield* config.update({ [roleModelKeys[role]]: selection ?? undefined });
  return selection;
});
```

`agent/chat.ts:646-650`:

```ts
/** On a kanban board the session's chat is the planner, so it runs on the planner's model. */
const sessionModel = (sessionId: string) =>
  Effect.flatMap(kanbanBoard(sessionId), (board) =>
    board ? active.selectedFor("planner") : active.selected,
  );
```

`sessionModel`의 호출은 세 곳이다(`rg -n "sessionModel\(" packages/memory-agent/src/agent/chat.ts`):

- 1326행, run 시작: `const selection = external === null ? yield* sessionModel(sessionId) : null;`
  같은 `Effect.gen`의 1294행에 `const { projectId, agent: external, title } = yield* sessions.get(sessionId);`가 있다.
- 2444행, `/compact`: 바로 위 2442행에 `yield* sessions.get(sessionId);`가 있다.
- 2481행, 상태 읽기: 2470행에 `yield* sessions.get(sessionId);`가 있다.

세 곳 모두 같은 흐름에서 이미 `sessions.get`을 부르므로, 그 오류(`SessionNotFound` 등)는 이미
그 흐름의 오류 타입에 들어 있다.

`api/app-api/sessions.ts:504-509` — holder 헤더를 받는 엔드포인트의 본보기:

```ts
    HttpApiEndpoint.post("compact", "/api/sessions/:session/compact", {
      params: session,
      headers: sessionHolderHeaders,
      success: CompactResult,
      error: [SessionInUse, UnknownSession, RunInProgress, SelectedProviderUnavailable],
    }),
```

`api/app-api/providers.ts:112` 근처 — 모델 거절 스키마. 지금은 `export`가 없다:

```ts
const ModelUnavailable = refusalWith({
```

`apps/agent/app/.server/api/sessions.ts:44-49,84-98`:

```ts
    /** Refuses a change while another page holds the session. */
    const checkHolder = (sessionId: string, holder: string | undefined) =>
      Effect.when(
        Effect.fail({ error: "session_in_use" } as const),
        Effect.map(leases.permits(sessionId, holder ?? null), (permitted) => !permitted),
      );
// ...
      create: ({ payload: { projectId, title, agent } }) =>
        Effect.gen(function* () {
          yield* Option.match(Option.fromNullishOr(agent), {
            onNone: () => Effect.void,
            onSome: (external) => checkAgent(projectId, external),
          });
          const created = yield* sessions.create(projectId, title ?? null, agent ?? null);
          yield* events.publishProject(projectId, "sessions");
          return created;
        }).pipe(
          Effect.catchTag(
            "ProjectNotFound",
            () => Effect.fail({ error: "project_not_found" } as const),
            (failure) => Effect.die(failure),
          ),
        ),
```

`apps/agent/app/.server/api/providers.ts:220-234` — 모델 거절을 응답으로 바꾸는 본보기:

```ts
      select: ({ params: { model }, payload: { provider, reasoningEffort } }) =>
        registry.get(provider).pipe(
          Effect.flatMap((configured) => configured.models.select(model, reasoningEffort)),
          Effect.catchTags({
            ...catalogRefusal,
            ModelUnavailable: (unavailable) =>
              Effect.fail({
                error: "model_unavailable",
                provider: unavailable.provider,
                model: unavailable.model,
                reasoningEffort: unavailable.reasoningEffort ?? null,
              } as const),
          }),
        ),
```

`apps/agent/app/entry/api.ts:731-734` — holder 헤더를 싣는 호출의 본보기:

```ts
  compactSession: (session: string, holder: string) =>
    appCall((client) =>
      client.sessions.compact({ params: { session }, headers: { "x-session-holder": holder } }),
    ),
```

### 정해 둔 동작

- 저장: `sessions.model_selection TEXT`. `ModelSelection`을 JSON으로 적는다. `NULL`은 "자기 모델
  없음, 앱의 기본 선택을 따른다"다. 옛 대화는 모두 `NULL`이다. 채우는 migration은 두지 않는다.
- 읽기: 적힌 값이 지금의 `ModelSelection` 스키마로 읽히지 않으면 `null`로 읽는다. 대화 목록
  전체가 한 행 때문에 실패하면 안 된다.
- 대화의 run이 쓸 모델의 순서: 칸반 보드가 도는 대화면 계획자 모델(지금 그대로) → 대화의 자기
  모델 → 앱의 기본 선택.
- 화면이 만드는 대화(`POST /api/sessions`)만 기본 선택을 자기 것으로 가지고 시작한다. 외부
  에이전트 대화(`agent`가 있는 것)는 가지지 않는다. 그 밖에 대화를 만드는 곳(가져오기, 칸반
  카드, 서브에이전트, ACP)은 바꾸지 않는다. 그 대화들은 `NULL`로 시작한다.
- 대화의 모델을 바꾸는 요청은 그 대화를 쥔 탭만 한다(다른 탭이면 423 `session_in_use`). 답변
  중에도 바꿀 수 있고 다음 run부터 쓰인다. 지금의 전역 선택과 같다.
- 바꿀 때 그 공급자(호환이면 그 엔드포인트 계정)가 그 모델과 추론 단계를 목록에 가지고 있는지
  확인한다. 역할 모델의 확인(`chooseFor`)과 같은 확인이다. `null`을 보내면 자기 모델을 지운다.

### 따라야 할 규칙

- 이 패키지의 서버 코드는 Effect로 쓴다. 먼저 `node_modules/effect/AGENTS.md`를 읽는다.
  서비스는 `Context.Service`, 오류는 `Schema.TaggedError`, SQL은 `SqlSchema`(위 본보기)다.
- JSON은 `JSON.parse`/`JSON.stringify`를 직접 부르지 않고 `Schema.fromJsonString(...)`으로 다룬다.
  동기 decode(`decodeSync`)를 쓰지 않는다. 읽기는 `Schema.decodeUnknownOption`, 쓰기는
  `Schema.encodeEffect`를 쓴다(`apps/agent/app/entry/session/session-drafts.ts:18-20`,
  `apps/agent/vite.config.ts`의 `Schema.encodeEffect(Schema.fromJsonString(Schema.String))`이 본보기다).
- `let`, `while`, lint 끄기 주석, `unknown` 타입을 쓰지 않는다. 조건부 실행은 `Effect.when`,
  값 고르기는 삼항이나 `Option.match`다. 뜻 없는 `(x) => f(x)` 감싸기를 두지 않는다.
- 태그 유니온은 생성자·`match`·guard로만 다룬다. `_tag` 글자를 손으로 쓰지 않는다.
- 함수에 객체 인자를 새로 만들지 않는다(lint `anti-slop/no-object-parameters`). 지금 코드처럼
  위치 인자를 쓴다.
- 줄바꿈을 손으로 맞추지 않는다.

## Commands you will need

| Purpose                | Command                                                                                               | Expected on success |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------- |
| memory-agent typecheck | 저장소 루트에서 `vp run memory-agent#typecheck`                                                       | exit 0, 경고도 없음 |
| agent typecheck        | 저장소 루트에서 `vp run agent#typecheck`                                                              | exit 0              |
| 포맷·lint              | 저장소 루트에서 `vp check`                                                                            | exit 0              |
| 대화 저장 테스트       | `cd packages/memory-agent && vp test --run tests/sessions/model.test.ts`                              | all pass            |
| migration 테스트       | `cd packages/memory-agent && vp test --run tests/db-migrator-metadata.test.ts tests/database.test.ts` | all pass            |
| 공급자 테스트          | `cd packages/memory-agent && vp test --run tests/provider-contracts.test.ts`                          | all pass            |
| 서버 문구 검사         | 저장소 루트에서 `vp run memory-agent#i18n:check`                                                      | exit 0              |

- `vp check`는 Effect 진단을 건너뛴다. `vp run memory-agent#typecheck`도 반드시 돌린다. 그
  경고도 실패로 본다.
- 단계마다 건드린 테스트만 돌린다. memory-agent 전체 suite는 돌리지 않는다.
- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**
- **`~/.context-generactive-agent/agent.db`를 열거나 고치지 않는다.** 테스트는 자기 임시 DB를 쓴다.

## Scope

**In scope**:

- `packages/memory-agent/src/db/migrations.ts` (배열 끝에 항목 하나)
- `packages/memory-agent/src/sessions/contracts.ts`, `sessions/sessions.ts`
- `packages/memory-agent/src/providers/active-provider.ts`
- `packages/memory-agent/src/agent/chat.ts` (`sessionModel`만)
- `packages/memory-agent/src/api/app-api/sessions.ts`, `api/app-api/providers.ts`(`export` 하나)
- `apps/agent/app/.server/api/sessions.ts`
- `apps/agent/app/entry/api.ts` (`api.setSessionModel` 하나)
- `packages/memory-agent/tests/sessions/model.test.ts` (새 파일), `tests/provider-contracts.test.ts`
- `Session` 객체를 손으로 만드는 테스트 fixture 세 곳(필드 하나 추가):
  `apps/agent/app/entry/session/session-lifecycle.test.ts`,
  `apps/agent/app/entry/navigation/sidebar-collapse.test.tsx`,
  `apps/agent/app/entry/navigation/sidebar.browser.tsx`
- 문서: `packages/memory-agent/src/sessions/README.md`, `providers/README.md`, `agent/README.md`,
  `apps/agent/README.md`(API 표), `apps/agent/app/.server/api/README.md`, `docs/decisions.md`(끝에 항목 하나)

**Out of scope**:

- 화면. 선택기와 사이드바의 모델 영역은 Plan 009가 바꾼다.
- 전역 선택의 저장과 `/api/models/*`. 그대로 둔다.
- `active.selected`를 쓰는 다른 곳: `btw/chat.ts`, `memory/interpret.ts`, `improve/interpret.ts`,
  `report/bundle.ts`, `report/diagnosis.ts`, `agent/turn-summaries.ts`, `.server/api/media.ts`.
  대화 밖의 일이거나 따로 다룰 일이다.
- 역할 모델(`plannerModel` 등)과 칸반 카드의 모델.
- 대화를 만드는 다른 경로(가져오기, 칸반 카드 대화, 서브에이전트, ACP).
- 계정 선택. 구독 공급자의 계정은 지금처럼 그 공급자의 선택된 프로필이다.

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 두 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `feat(sessions): 대화가 자기 모델 선택을 저장한다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 열과 계약

`db/migrations.ts`의 `migrations` 배열 끝(마지막 `` `, `` 다음, `];` 앞)에 더한다.

```ts
  `
  -- The model a conversation runs on, as JSON of its provider, model and effort (decisions.md
  -- "모델은 대화마다 둔다"). NULL follows the app's selected model, as every conversation did
  -- before this column.
  ALTER TABLE sessions ADD COLUMN model_selection TEXT;
  `,
```

`sessions/contracts.ts`의 `Session`에 필드를 더한다. `ModelSelection`은
`"../providers/contracts.ts"`에서 가져온다.

```ts
  /** The model this conversation runs on; null follows the app's selected model. */
  model: Schema.NullOr(ModelSelection),
```

파일 위 주석("This module imports no server code")은 그대로 맞다. `providers/contracts.ts`도
브라우저에 나가는 파일이다.

`sessions/sessions.ts`:

- `SessionRow`에 `model_selection: Schema.NullOr(Schema.String)`.
- 적힌 글자를 읽는 함수를 `toSession` 위에 둔다.

```ts
const decodeModel = Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection));
/** The stored model; text that no longer reads as one counts as none. */
const storedModel = (text: string | null): ModelSelection | null =>
  text === null ? null : Option.getOrNull(decodeModel(text));
```

- `toSession`에 `model: storedModel(row.model_selection)`.
- `columns`에 `sessions.model_selection`을 더한다.
- `NewSession`에 `modelSelection: Schema.NullOr(Schema.String)`, `insert`의 열과 값에 더한다.
- `create`에 넷째 위치 인자 `model: ModelSelection | null = null`. 쓰기 전에 글자로 바꾼다.

```ts
const modelSelection =
  model === null ? null : yield * Schema.encodeEffect(Schema.fromJsonString(ModelSelection))(model);
```

- `createImported`의 `insert` 호출에 `modelSelection: null`.
- `setModel`을 더한다. `archive`와 같은 모양의 `SqlSchema.findOneOption`(요청
  `{ id, modelSelection }`, `UPDATE sessions SET model_selection = … WHERE id = … RETURNING ${columns}`)을
  만들고, 서비스에 내보낸다.

```ts
    /** Gives the conversation a model of its own, or with null lets it follow the app's again. */
    setModel: (id: string, model: ModelSelection | null) =>
      Effect.gen(function* () {
        const modelSelection =
          model === null
            ? null
            : yield* Schema.encodeEffect(Schema.fromJsonString(ModelSelection))(model);
        return yield* found(id)(yield* storeModel({ id, modelSelection }));
      }),
```

두 곳의 글자 변환이 같으므로 `make` 안의 작은 함수 하나로 묶는다.

`Session` 객체를 손으로 만드는 곳에 `model: null`을 더한다: In scope의 테스트 fixture 세 곳. 그
밖에 typecheck가 가리키는 곳이 있으면 같은 방식으로 더한다.

**Verify**: `vp run memory-agent#typecheck` → exit 0. `vp run agent#typecheck` → exit 0.
`cd packages/memory-agent && vp test --run tests/db-migrator-metadata.test.ts tests/database.test.ts` → all pass.

### Step 2: 모델 확인을 따로 떼어 낸다

`providers/active-provider.ts`의 `chooseFor` 안의 확인을 함수로 뺀다.

```ts
/** Fails unless the selection's provider lists that model with that effort. */
const checked = Effect.fn("ActiveProvider.checked")(function* (selection: ModelSelection) {
  const { models } = yield* registry.configurationOf(selection);
  yield* Effect.fromOption(
    Arr.findFirst(
      yield* models.list,
      (model) =>
        model.id === selection.model &&
        model.supportedReasoningEfforts.includes(selection.reasoningEffort),
    ),
    () => ModelUnavailable.make(selection),
  );
  return selection;
});
```

`chooseFor`는 `if (selection !== null) yield* checked(selection);`로 줄인다. 반환 객체에 `checked`를
더한다.

**Verify**: `vp run memory-agent#typecheck` → exit 0.
`cd packages/memory-agent && vp test --run tests/provider-contracts.test.ts` → all pass(동작이 바뀌지 않았다).

### Step 3: 대화의 run이 자기 모델을 쓴다

`agent/chat.ts:646-650`:

```ts
/**
 * The model a session's chat runs on. On a kanban board the chat is the planner, so it runs on
 * the planner's model; otherwise on the conversation's own model, or the app's selected one.
 */
const sessionModel = (sessionId: string) =>
  Effect.flatMap(kanbanBoard(sessionId), (board) =>
    board
      ? active.selectedFor("planner")
      : Effect.flatMap(sessions.get(sessionId), (session) =>
          session.model === null ? active.selected : Effect.succeed(session.model),
        ),
  );
```

- `sessions`는 이 `make` 안에 이미 있다(2442행이 쓴다). 646행보다 위에서 정의됐는지 확인한다.
  아래에 있으면 `sessionModel`을 그 정의 다음으로 옮긴다.
- 세 호출부의 오류 타입이 달라지면 typecheck가 알려 준다. 세 곳 모두 같은 흐름에서
  `sessions.get`을 이미 부르므로 새 오류가 생기지 않아야 한다. 새 오류 타입 때문에 handler의
  오류 선언을 넓혀야 하면 STOP이다.

**Verify**: `vp run memory-agent#typecheck` → exit 0. `vp run agent#typecheck` → exit 0.

### Step 4: 대화의 모델을 바꾸는 엔드포인트

`api/app-api/providers.ts:112`의 `const ModelUnavailable`을 `export const ModelUnavailable`로 바꾼다.
같은 파일의 `ProviderUnavailable`(86행)과 `ModelListFailed`(109행)도 `export`한다.

`api/app-api/sessions.ts`:

- import에 `ModelUnavailable`, `ProviderUnavailable`, `ModelListFailed`를 더한다(`SelectedProviderUnavailable`을
  가져오는 줄). `ModelSelection`은 `"../../providers/contracts.ts"`에서 가져온다.
- `compact` 엔드포인트 다음에 더한다.

```ts
    /**
     * Gives the conversation a model of its own, or with null lets it follow the app's selected
     * model again. The next run uses it; a run in progress keeps the model it started with.
     */
    HttpApiEndpoint.post("setModel", "/api/sessions/:session/model", {
      params: session,
      headers: sessionHolderHeaders,
      payload: Schema.Struct({ model: Schema.NullOr(ModelSelection) }),
      success: Session,
      error: [SessionInUse, UnknownSession, ModelUnavailable, ProviderUnavailable, ModelListFailed],
    }),
```

- 이 파일에 거절 목록(`sessionRefusals` 같은 배열, 300–308행 근처)이 있으면, 새로 쓰는 거절이
  그 목록에 들어가야 하는지 이웃 엔드포인트를 보고 맞춘다.

`apps/agent/app/.server/api/sessions.ts`:

- `const active = yield* ActiveProvider;`를 더한다(`ActiveProvider`는 `"memory-agent"`에서 가져온다.
  `apps/agent/app/.server/api/media.ts:4,11`이 같은 방식이다).
- handler를 더한다.

```ts
      setModel: ({ params: { session }, headers, payload: { model } }) =>
        Effect.gen(function* () {
          yield* checkHolder(session, headers["x-session-holder"]);
          // A model of its own must be one its provider lists; none needs no check.
          yield* Option.match(Option.fromNullishOr(model), {
            onNone: () => Effect.void,
            onSome: (chosen) => Effect.asVoid(active.checked(chosen)),
          });
          const changed = yield* sessions.setModel(session, model);
          yield* events.publishProject(changed.projectId, "sessions");
          yield* events.publishSession(session, "run-state");
          return changed;
        }).pipe(/* 아래 오류 변환 */),
```

같은 파일 86–89행의 `agent` 확인이 같은 모양이다. `as`로 타입을 좁히지 않는다.

- 오류 변환: `SessionNotFound` → `{ error: "session_not_found" }`, `ModelUnavailable` → 위
  `providers.ts:225-231`과 같은 본문, `ProviderUnavailable` → `{ error: "provider_unavailable" }`,
  `ProviderOperationFailed` → `{ error: "model_list_failed" }`. 남는 오류(`SqlError`, `SchemaError`)는
  이웃 handler가 하는 방식(`Effect.orDie` 또는 `refusalsOnly`)을 따른다. 이웃이 쓰는 방식을 확인하고
  같은 것을 쓴다.
- `create` handler: 외부 에이전트 대화가 아니면 기본 선택을 넘긴다.

```ts
const model = isTruthy(agent) ? null : yield * Effect.orDie(active.selected);
const created = yield * sessions.create(projectId, title ?? null, agent ?? null, model);
```

`isTruthy`가 이 파일에 없으면 `agent == null` 대신 `Option.isSome(Option.fromNullishOr(agent))`로
쓴다. 느슨한 비교(`==`)를 쓰지 않는다.

`apps/agent/app/entry/api.ts`의 `api`에 더한다(`compactSession` 근처).

```ts
  /** null lets the conversation follow the app's selected model again. */
  setSessionModel: (session: string, holder: string, model: ModelSelection | null) =>
    appCall((client) =>
      client.sessions.setModel({
        params: { session },
        headers: { "x-session-holder": holder },
        payload: { model },
      }),
    ),
```

**Verify**: `vp run memory-agent#typecheck` → exit 0. `vp run agent#typecheck` → exit 0.
`rg -n "setModel" apps/agent/app/.server/api/sessions.ts packages/memory-agent/src/api/app-api/sessions.ts apps/agent/app/entry/api.ts` → 세 파일 모두에서 한 줄 이상.

### Step 5: 테스트

`packages/memory-agent/tests/sessions/model.test.ts`를 만든다. 틀은 같은 폴더의
`dispatches.test.ts`(1–30행)를 따른다: `testAgent()(function (it) { it.effect(..., () => Effect.gen(function* () { const env = yield* TestEnv; ... })) })`,
서비스는 `env.use(Effect.flatMap(Sessions, (sessions) => ...))`로 부른다, SQL은
`../support/sql.ts`의 `sqlRun`/`sqlGet`이다.

세 가지:

1. `sessions.create(project.id, null, null, selection)`으로 만든 대화를 `sessions.get`과
   `sessions.list`가 같은 `model`로 돌려준다. `selection`은
   `{ provider: "openai", model: "gpt-6-astra", reasoningEffort: "high" }`.
2. `sessions.setModel(id, selection)` 뒤 `get`이 그 모델을, `setModel(id, null)` 뒤 `null`을 돌려준다.
3. `sqlRun("UPDATE sessions SET model_selection = ? WHERE id = ?", "not json", id)` 뒤 `sessions.get`이
   실패하지 않고 `model: null`을 돌려준다.

`tests/provider-contracts.test.ts`에 `checked`의 경우를 하나 더한다: 그 파일이 `chooseFor`가 없는
모델을 거절하는 것을 이미 시험하고 있으면, 같은 준비로 `checked`가 `ModelUnavailable`로 실패하는
것을 한 번 단언한다. 그런 준비가 그 파일에 없으면 더하지 않는다(`chooseFor`의 기존 테스트가
`checked`를 지나간다).

**Verify**: `cd packages/memory-agent && vp test --run tests/sessions/model.test.ts` → 3 passed.

### Step 6: 문서

- `packages/memory-agent/src/sessions/README.md`: `Session.model`, `create`의 넷째 인자, `setModel`.
- `packages/memory-agent/src/providers/README.md`의 Invariants에 한 줄: 대화의 자기 모델은
  `sessions.model_selection`에 있고 전역 선택을 바꾸지 않는다. `ActiveProvider.checked`.
- `packages/memory-agent/src/agent/README.md:46`의 문장을 고친다: 보드가 없으면 대화의 자기 모델,
  그것도 없으면 선택된 모델.
- `apps/agent/README.md`의 API 표에 `POST /api/sessions/:session/model` 한 줄.
- `apps/agent/app/.server/api/README.md`에 `setModel`과 `create`가 기본 선택을 넘긴다는 것.
- `docs/decisions.md` 끝에 항목 하나, 제목 "모델은 대화마다 둔다 (2026-11-14)"로 시작한다. 계기
  (한 대화에서 바꾸면 모든 대화가 바뀌던 것, 사용자 결정), 결정("정해 둔 동작"의 여섯 항목),
  대체하는 결정("OpenAI 호환 엔드포인트의 계정화 (2026-10-18)"의 "모델 선택은 기존 전역
  `provider`·`model`을 유지한다" 중 대화의 run에 관한 부분. 전역 선택은 기본값으로 남는다),
  그대로인 것(역할 모델, 대화 밖의 일이 쓰는 모델, 계정 선택).

**Verify**: `vp check` → exit 0. `vp run memory-agent#i18n:check` → exit 0(서버 문구를 더하지 않았다).

### Step 7: 운영자에게 알린다

최종 보고에 적는다: dev 백엔드는 dev를 시작할 때 한 번만 빌드되므로 dev를 다시 시작해야
반영된다. 다시 시작하면 migration이 `sessions`에 열을 더한다. 직접 재시작하지 않는다.

## Test plan

- 새 파일 `tests/sessions/model.test.ts`의 3개(Step 5).
- run이 실제로 그 모델로 도는지는 자동 테스트를 더하지 않는다. `sessionModel`의 세 갈래는 타입이
  묶고, 실제 공급자를 부르는 테스트는 이 계획의 크기를 넘는다. 운영자가 확인할 것: dev를 다시
  시작하고 새 대화를 만든 뒤
  `sqlite3 -readonly ~/.context-generactive-agent/agent.db "select model_selection from sessions order by created_at desc limit 1"`
  → 지금 기본 선택의 JSON이 나온다.

## Done criteria

- [ ] 저장소 루트에서 `vp run memory-agent#typecheck`, `vp run agent#typecheck`, `vp check` 모두 exit 0
- [ ] `cd packages/memory-agent && vp test --run tests/sessions/model.test.ts tests/db-migrator-metadata.test.ts tests/database.test.ts tests/provider-contracts.test.ts` exits 0
- [ ] `rg -n "model_selection" packages/memory-agent/src/db/migrations.ts packages/memory-agent/src/sessions/sessions.ts` → 두 파일 모두에서 한 줄 이상
- [ ] `rg -n "JSON\.(parse|stringify)" packages/memory-agent/src/sessions/sessions.ts` → 결과 없음
- [ ] `rg -n " as ModelSelection" apps/agent/app/.server/api/sessions.ts` → 결과 없음
- [ ] `git status --short`에 In scope 밖의 수정이 없다
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다.
- `sessionModel`을 바꾸자 `chat.ts` 밖의 파일이나 handler의 오류 선언을 넓혀야 한다.
- migration 테스트가 "열을 더한 뒤의 스키마"를 golden 파일과 견주고 있어 golden을 고쳐야 한다.
  고치기 전에 멈추고 어느 파일인지 보고한다.
- `Session`에 필드를 더하자 In scope에 없는 **소스**(테스트가 아닌) 파일이 `Session` 객체를 손으로
  만들고 있어 고쳐야 한다. 어느 파일인지 보고한다.
- `providers/contracts.ts`를 `sessions/contracts.ts`가 가져오면 순환 import 경고나 브라우저 번들
  경고가 난다.
- 확인 명령이 고친 뒤에도 두 번 실패한다.

## Maintenance notes

- 옛 대화(`model_selection`이 `NULL`)는 앱의 기본 선택을 따른다. 기본 선택이 바뀌면 그 대화들의
  다음 답도 바뀐다. 화면에서 그 대화의 모델을 한 번 고르면 고정된다.
- 대화의 모델이 가리키는 호환 계정이 지워지면 run 시작이 지금의 거절(`model_unavailable_for_account`
  또는 공급자 오류)로 끝난다. 화면(Plan 009)이 그때 다시 고르게 한다.
- `.server/api/media.ts`는 이미지 생성의 시작 경로를 전역 선택으로 적는다. 대화의 모델로 바꾸는
  일은 Plan 011의 설계에 넣는다.
- 리뷰에서 볼 곳: 읽히지 않는 `model_selection`이 목록 전체를 실패시키지 않는가. `create`가 외부
  에이전트 대화에 모델을 넣지 않는가. `setModel`이 holder를 확인하는가.
