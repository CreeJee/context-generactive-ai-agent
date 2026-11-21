# Plan 017: 카드 패널이 카드 작업 폴더와 브랜치를 보인다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- packages/memory-agent/src/kanban/worktree.ts packages/memory-agent/src/kanban/git-worktrees.ts packages/memory-agent/src/kanban/board-actions.ts packages/memory-agent/src/kanban/contracts.ts packages/memory-agent/src/api/app-api/sessions.ts apps/agent/app/.server/api/sessions.ts apps/agent/app/entry/chat/board/card-peek.tsx apps/agent/app/entry/chat/board/board-surface.tsx`
> `card-peek.tsx`와 `board-surface.tsx`는 Plan 012·013·015가 바꿨다. 예상된 차이다. 서버 파일이
> 바뀌었으면 "Current state"의 발췌와 견준다. 다르면 STOP이다.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/015-card-panel-beside-board.md (같은 파일 `card-peek.tsx`. 013의 "실행 기록"
  항목 다음에 새 항목을 둔다)
- **Category**: usability
- **Planned at**: commit `d65cc285`, 2026-11-15

## Why this matters

칸반 카드는 프로젝트의 복사본 폴더(git worktree)에서 실행된다. 카드가 사람의 판단을 기다릴 때
화면은 그 폴더에서 손으로 확인하거나 고치라고 말한다.

- "카드 작업 폴더에 실제로 반영됐는지 확인해 주십시오." (`chat/decision-prompt.tsx:35`)
- "카드 작업 폴더에 merge가 진행 중인 채로 남아 있습니다." (`:39`)
- 답 가운데 "직접 해결함, 다시 검증" (`:89`)

그런데 그 폴더가 어디인지, 카드의 브랜치 이름이 무엇인지는 화면에도 API에도 없다. 사용자는
`~/.context-generactive-agent-worktrees/<Goal id>/<카드 id>`라는 규칙을 알고 Goal id를 따로 찾아야
한다. 로컬 DB의 판단 요청 49건 가운데 16건(UncertainSideEffect 5, IntegrationConflict 2,
MergeConflict 9)이 폴더를 봐야 답할 수 있는 종류다.

판단 요청의 내용(`DecisionKind`)에는 경로를 넣지 않는 것이 기존 설계다
(`kanban/human-decision-schema.ts:8`: "The metadata is safe to show: no provider text or paths").
사용자가 2026-11-15에 정했다: 경로는 판단 내용에 넣지 않고, 카드 패널이 따로 읽는 항목으로 보인다.

이 계획 뒤에는:

- 카드 패널의 상세에 "작업 폴더"와 "브랜치"가 나온다. 폴더가 지금 있는 카드에만 나온다.
- 서버에 읽기 하나가 생긴다: `GET /api/sessions/:session/kanban/cards/:card/folder`.
- 판단 요청, 보드 전체 읽기(`/kanban`), 제보 묶음에는 경로가 들어가지 않는다.

## Current state

### 관련 파일

서버:

- `packages/memory-agent/src/kanban/worktree.ts` — 카드 작업 폴더의 계약. `CardRef`, `CardWorktree`,
  `CardWorkspace`(`present` 포함), `cardWorkspace(worktrees, mode)`, `sequentialWorkspace`.
- `packages/memory-agent/src/kanban/git-worktrees.ts` — git 구현. 브랜치 이름 함수가 비공개로 있다.
- `packages/memory-agent/src/kanban/board-actions.ts` — `KanbanBoardActions`. `view`, `kanbanOf`.
- `packages/memory-agent/src/kanban/contracts.ts` — 화면용 Schema(`KanbanCardView` 등).
- `packages/memory-agent/src/api/app-api/sessions.ts` — 세션 API의 정의(HttpApi).
- `apps/agent/app/.server/api/sessions.ts` — 세션 API의 handler.
- `packages/memory-agent/src/kanban/kanban-flow.test.ts` — `KanbanBoardActions`를 실제 git 폴더로 돌리는 테스트.

화면:

- `apps/agent/app/entry/api.ts` — `api.kanban` 등 서버 호출.
- `apps/agent/app/entry/queries/keys.ts`, `apps/agent/app/entry/queries/session.ts` — 쿼리 키와 훅.
- `apps/agent/app/entry/chat/board/card-peek.tsx`, `board-surface.tsx`.

### 발췌

`kanban/worktree.ts:21-31` — 카드와 그 폴더:

```ts
export interface CardRef extends GoalRef {
  readonly cardId: string;
}

/** A worktree as the card's file tools and code skills see it. */
export interface CardWorktree {
  /** Where the project sits inside the worktree; the card's file tools and code skills start here. */
  readonly toolRoot: string;
  /** Folders the card's tools must not reach, such as the user's checkout and other worktrees. */
  readonly deniedRoots: readonly string[];
}
```

`kanban/worktree.ts:243-244` — 지금 있는 폴더를 읽는 메서드(`CardWorkspace` 안):

```ts
  /** The card's worktree as it is now; `WorktreeMissing` when it is gone. */
  readonly present: (card: CardRef) => Effect.Effect<CardWorktree, CardWorktreeFailed>;
```

`kanban/worktree.ts:362-388` — 차례 실행 모드(작업 폴더가 프로젝트 자신)와 모드로 고르는 함수:

```ts
const projectItself = (card: CardRef): CardWorktree => ({
  toolRoot: card.projectRoot,
  deniedRoots: [],
});
export const sequentialWorkspace: CardWorkspace = {
  lease: (card) => Effect.succeed(projectItself(card)),
  present: (card) => Effect.succeed(projectItself(card)),
  /* ... */
};

/** Where a Goal's cards run, by the mode its board started in. */
export const cardWorkspace: {
  (mode: KanbanMode): (worktrees: CardWorkspace) => CardWorkspace;
  (worktrees: CardWorkspace, mode: KanbanMode): CardWorkspace;
} = EffectFunction.dual(/* ... */);
```

`kanban/git-worktrees.ts:107-110` — 브랜치 이름:

```ts
const goalBranchName = (goal: string) => `ctx/goal/${goal}`;
/** The folder of the Goal's card branches; as a ref pattern it matches every one of them. */
const cardBranchFolder = (goal: string) => `ctx/card/${goal}`;
const cardBranchName = (goal: string, card: string) => `${cardBranchFolder(goal)}/${card}`;
```

`kanban/board-actions.ts:37, 150` — 이미 있는 import와 서비스:

```ts
import { cardWorkspace, CardWorktrees, GoalRetarget, WorktreeDisposition } from "./worktree.ts";
```

```ts
const worktrees = yield * CardWorktrees;
```

`kanban/board-actions.ts:209-215` — 세션이 칸반 보드일 때만 Goal을 주는 함수:

```ts
/** The board when the session's Goal runs as one; storage failures still fail. */
const kanbanOf = (sessionId: string) =>
  board(sessionId).pipe(
    Effect.asSome,
    // `board` refuses only with `not_kanban`.
    Effect.catchTag("KanbanActionRefused", () => Effect.succeedNone),
  );
```

`kanban/board-actions.ts:704-712` — `view`의 앞부분. 새 메서드를 이 메서드 다음에 둔다:

```ts
    /**
     * The session's kanban board as the loop sees it: why it stopped each card. None when the
     * session's Goal does not run as a board.
     */
    view: Effect.fn("KanbanBoardActions.view")(function* (sessionId: string) {
      const goal = yield* kanbanOf(sessionId);
      if (Option.isNone(goal)) return Option.none<KanbanBoardView>();
      const { goalInstanceId, mode, hold } = goal.value;
```

`goal.value`는 `projectRoot`도 가진다(`board-actions.ts:251`이
`{ projectRoot: goal.projectRoot, goalInstanceId: goal.goalInstanceId, cardId }`를 만든다).

`api/app-api/sessions.ts:395-400, 468-472` — 읽기 endpoint와 경로 값이 둘인 endpoint의 본보기:

```ts
    /** Whether the Goal runs as a kanban board, and why its cards stopped. */
    HttpApiEndpoint.get("kanban", "/api/sessions/:session/kanban", {
      params: session,
      success: KanbanView,
      error: [UnknownSession, SessionStorageFailed],
    }),
```

```ts
    HttpApiEndpoint.get("subagentTranscript", "/api/sessions/:session/subagents/:subagent", {
      params: { ...session, subagent: Schema.String },
      success: SubagentTranscript,
      error: UnknownSubagent,
    }),
```

`apps/agent/app/.server/api/sessions.ts:156-173` — `kanban` handler:

```ts
      kanban: ({ params: { session } }) =>
        sessions.get(session).pipe(
          Effect.andThen(actions.view(session)),
          Effect.map(
            Option.match({
              onNone: () => ({ active: false }) as const,
              onSome: (board) => ({ active: true, ...board }) as const,
            }),
          ),
          Effect.catchTags({
            SessionNotFound: kanbanRefusal.SessionNotFound,
            KanbanStorageFailed: kanbanRefusal.KanbanStorageFailed,
            WorkflowStorageError: kanbanRefusal.WorkflowStorageError,
            GoalScheduleStorageFailed: kanbanRefusal.GoalScheduleStorageFailed,
            SqlError: kanbanRefusal.SqlError,
            SchemaError: kanbanRefusal.SchemaError,
          }),
        ),
```

`apps/agent/app/entry/api.ts:635-636, 959-960`:

```ts
  kanban: (session: string): Promise<KanbanView> =>
    appCall((client) => client.sessions.kanban({ params: { session } })),
```

```ts
  subagentTranscript: (session: string, subagent: string) =>
    appCall((client) => client.sessions.subagentTranscript({ params: { session, subagent } })),
```

`apps/agent/app/entry/queries/keys.ts:63-64`와 `queries/session.ts:50-55, 96-100`:

```ts
    kanban: (projectId: string, sessionId: string) =>
      [...appQueryKeys.session.root(projectId, sessionId), "kanban"] as const,
```

```ts
  kanban: (projectId: string, sessionId: string) =>
    queryOptions({
      queryKey: appQueryKeys.session.kanban(projectId, sessionId),
      queryFn: () => api.kanban(sessionId),
      staleTime: 0,
    }),
```

```ts
const useKanbanQueryBody = (projectId: string, sessionId: string) =>
  useQuery(sessionQueries.kanban(projectId, sessionId));
```

`card-peek.tsx` — `CardDetails`의 "실행 기록" 항목(Plan 013이 더했다)과 그 뒤의 "마지막 변경" 항목.
새 항목 둘을 그 사이에 둔다. `CardPeek`는 `projectId`, `kanbanActive`, `peek`, `entry`를 props로 받는다.

`board-surface.tsx` — `<CardPeek … projectId={projectId} holder={holder} …>`. 패널의 대화는
`peekSession`(문자열)이다.

### 알아 둘 것

- 카드 작업 폴더는 카드가 시작할 때 만들어지고, 카드가 끝나면(Done) 없어진다. 취소된 카드의 폴더도
  없어진다. 막힌 카드와 사람의 판단을 기다리는 카드의 폴더는 남는다(`worktree.ts:33-39`의
  `WorktreeDisposition` 주석). 그래서 "지금 폴더가 있는가"를 서버에 물어야 한다.
- `present`는 git을 한 번 실행한다(`git worktree list --porcelain`). 보드 전체 읽기(`view`)에 카드마다
  넣으면 카드 수만큼 git이 돈다. 그래서 카드 패널이 열릴 때 그 카드 하나만 읽는 별도 endpoint로 둔다.
- 차례 실행 모드(`mode === "sequential"`)에서는 카드가 프로젝트 폴더에서 바로 실행된다. 폴더는
  프로젝트 폴더이고 브랜치는 없다.
- dev 백엔드는 dev를 시작할 때 한 번만 빌드된다. 서버 변경은 dev를 다시 시작해야 반영된다. 실행하는
  쪽은 dev를 건드리지 않고, 끝난 뒤 보고에 "dev를 다시 시작해야 한다"고 적는다.

### 따라야 할 규칙

- 서버 코드는 Effect v4 방식으로 쓴다. `Effect.fn("이름")(function* …)`, `Option`, `Schema`. `if`로
  짧게 갈라도 되는 곳은 기존 코드(`view`)의 모양을 따른다.
- 태그 유니온은 생성자와 `match`로 다룬다. `_tag`를 손으로 쓰지 않는다.
- `let`, `while`, lint 끄기 주석, `unknown` 타입을 쓰지 않는다.
- 화면: shadcn 컴포넌트만 쓴다. 문구는 Lingui 매크로, 한국어 합니다체.
- 줄바꿈을 손으로 맞추지 않는다. 포맷은 `vp check --fix`가 한다.
- 코드 주석은 영어로, 지금 코드가 왜 그런지만 적는다.

## Commands you will need

| Purpose                | Command                                                                                                     | Expected on success |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------- |
| memory-agent typecheck | 저장소 루트에서 `vp run memory-agent#typecheck`                                                             | exit 0, 경고 없음   |
| agent typecheck        | 저장소 루트에서 `vp run agent#typecheck`                                                                    | exit 0              |
| 포맷·lint              | 저장소 루트에서 `vp check`                                                                                  | exit 0              |
| 서버 테스트            | `cd packages/memory-agent && vp test --run src/kanban/kanban-flow.test.ts`                                  | all pass            |
| git 구현 테스트        | `cd packages/memory-agent && vp test --run src/kanban/git-worktrees.test.ts`                                | all pass            |
| 문구 catalog 갱신      | 저장소 루트에서 `vp run agent#i18n:extract`                                                                 | `ko.po`가 바뀐다    |
| 문구 catalog 검사      | 저장소 루트에서 `vp run agent#i18n:check`                                                                   | exit 0              |
| 문구 내용 검사         | 저장소 루트에서 `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`                        | exit 0              |
| 브라우저 테스트        | 저장소 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/board/` | all pass            |

- lint는 저장소 루트에서 돌린다. 패키지 안에서 돌리면 pre-commit이 보는 규칙 일부가 빠진다.
- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**

## Scope

**In scope**:

- `packages/memory-agent/src/kanban/worktree.ts` (브랜치 이름 함수 셋을 옮겨 받는다)
- `packages/memory-agent/src/kanban/git-worktrees.ts` (그 셋을 import로 바꾼다)
- `packages/memory-agent/src/kanban/contracts.ts` (`CardFolderView`)
- `packages/memory-agent/src/kanban/board-actions.ts` (`cardFolder`)
- `packages/memory-agent/src/kanban/kanban-flow.test.ts` (테스트 하나)
- `packages/memory-agent/src/api/app-api/sessions.ts` (endpoint 하나)
- `packages/memory-agent/src/index.ts` (새 타입을 내보내야 하면)
- `apps/agent/app/.server/api/sessions.ts` (handler 하나)
- `apps/agent/app/entry/api.ts`, `apps/agent/app/entry/queries/keys.ts`, `apps/agent/app/entry/queries/session.ts`
- `apps/agent/app/entry/chat/board/card-peek.tsx`, `board-surface.tsx`, `card-peek.browser.tsx`
- `apps/agent/app/locales/ko.po` (추출 명령이 고친다)
- `packages/memory-agent/src/kanban/README.md`, `packages/memory-agent/src/api/README.md`,
  `apps/agent/app/entry/chat/board/README.md`, `docs/decisions.md`(끝에 항목 하나)

**Out of scope**:

- `kanban/human-decision-schema.ts`, `kanban/human-decision.ts`. 판단 내용에 경로를 넣지 않는다.
- `KanbanCardView`, `KanbanBoardView`, `view`. 보드 전체 읽기에 경로를 넣지 않는다.
- 제보 묶음(`apps/agent/app/entry/report`, 서버의 report 코드).
- 폴더를 Finder나 편집기로 여는 버튼. 경로를 보이는 데서 멈춘다.
- 진행 중인 카드가 하는 일을 보드에서 보는 것(Work Trace와 잇기). 별도로 다룬다.
- DB migration. 저장하는 값이 없다.

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 두 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `feat(kanban): 카드 작업 폴더와 브랜치를 읽는 API를 둔다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 브랜치 이름을 계약 파일로 옮긴다

`kanban/worktree.ts`의 `CardRef` 정의 다음에 더한다.

```ts
/** The Goal's branch in the user's repository. */
export const goalBranchName = (goal: string) => `ctx/goal/${goal}`;
/** The folder of the Goal's card branches; as a ref pattern it matches every one of them. */
export const cardBranchFolder = (goal: string) => `ctx/card/${goal}`;
/** A card's branch; it keeps the card's work when the worktree is gone. */
export const cardBranchName = (goal: string, card: string) => `${cardBranchFolder(goal)}/${card}`;
```

`kanban/git-worktrees.ts`에서 같은 세 정의(107–110행)를 지우고, `./worktree.ts` import 목록에
`cardBranchFolder`, `cardBranchName`, `goalBranchName`을 더한다.

**Verify**:

- `vp run memory-agent#typecheck` → exit 0.
- `cd packages/memory-agent && vp test --run src/kanban/git-worktrees.test.ts` → all pass.

### Step 2: `CardFolderView`와 `KanbanBoardActions.cardFolder`

1. `kanban/contracts.ts`의 `KanbanCardView` 다음에 더한다.

```ts
/**
 * Where a card's work is on disk, for the person asked to look at it or fix it by hand. It is read
 * apart from the board and the decisions, so a path never rides along in them.
 */
export const CardFolderView = Schema.Struct({
  /** The folder the card's tools run in. */
  folder: Schema.String,
  /** The card's branch; null when the cards run in the project itself. */
  branch: Schema.NullOr(Schema.String),
});
export type CardFolderView = typeof CardFolderView.Type;
```

2. `kanban/board-actions.ts`: `./contracts.ts`에서 `CardFolderView` 타입을, `./worktree.ts`에서
   `cardBranchName`을 import한다(기존 import 줄에 더한다. `KanbanCardView`를 가져오는 줄을 본보기로
   한다). `view` 메서드 다음에 더한다.

```ts
    /**
     * Where the card's work is on disk now. None when the session's Goal does not run as a board,
     * or the card has no folder: it has not started, or it finished and the folder was removed.
     */
    cardFolder: Effect.fn("KanbanBoardActions.cardFolder")(function* (
      sessionId: string,
      cardId: string,
    ) {
      const goal = yield* kanbanOf(sessionId);
      if (Option.isNone(goal)) return Option.none<CardFolderView>();
      const { projectRoot, goalInstanceId, mode } = goal.value;
      const branch = mode === "worktree" ? cardBranchName(goalInstanceId, cardId) : null;
      return yield* cardWorkspace(worktrees, mode)
        .present({ projectRoot, goalInstanceId, cardId })
        .pipe(
          Effect.map((worktree) =>
            Option.some<CardFolderView>({ folder: worktree.toolRoot, branch }),
          ),
          // Whatever kept the folder from being found, there is none to point the person at.
          Effect.catchTag("CardWorktreeFailed", () => Effect.succeedNone),
        );
    }),
```

3. `packages/memory-agent/src/index.ts`가 `KanbanCardView`를 내보내는 줄(422행 근처, `type KanbanCardView,`)
   옆에 `type CardFolderView,`를 더한다.

**Verify**: `vp run memory-agent#typecheck` → exit 0, 경고 없음.

### Step 3: endpoint와 handler

1. `api/app-api/sessions.ts`: `../../kanban/contracts.ts` import에 `CardFolderView`를 더한다.
   `kanban` endpoint 다음에 더한다.

```ts
    /** Where a card's work is on disk; null when the card has no folder now. */
    HttpApiEndpoint.get("cardFolder", "/api/sessions/:session/kanban/cards/:card/folder", {
      params: { ...session, card: Schema.String },
      success: Schema.NullOr(CardFolderView),
      error: [UnknownSession, SessionStorageFailed],
    }),
```

2. `apps/agent/app/.server/api/sessions.ts`: `kanban` handler 다음에 더한다.

```ts
      cardFolder: ({ params: { session, card } }) =>
        sessions.get(session).pipe(
          Effect.andThen(actions.cardFolder(session, card)),
          Effect.map(Option.getOrNull),
          Effect.catchTags({
            SessionNotFound: kanbanRefusal.SessionNotFound,
            KanbanStorageFailed: kanbanRefusal.KanbanStorageFailed,
            WorkflowStorageError: kanbanRefusal.WorkflowStorageError,
            SqlError: kanbanRefusal.SqlError,
            SchemaError: kanbanRefusal.SchemaError,
          }),
        ),
```

`catchTags`의 목록은 typecheck에 맞춘다. `cardFolder`가 내지 않는 오류를 적으면 typecheck가
알려 주고, 빠진 오류가 있어도 알려 준다. `kanbanRefusal`에 있는 것만 쓴다.

**Verify**: `vp run memory-agent#typecheck`, `vp run agent#typecheck` → 둘 다 exit 0.

### Step 4: 서버 테스트

`kanban/kanban-flow.test.ts`에 테스트 하나를 더한다. 이 파일에서
`const view = Effect.map(actions.view(board.sessionId), Option.getOrUndefined);`가 있는 테스트를
본보기로 한다(d65cc285의 760–800행 근처). 그 테스트는 카드 하나짜리 Plan을 칸반으로 시작하고,
카드가 검증 단계에서 멈춰 있는 동안(`yield* Deferred.await(verifying);` 다음) 보드를 읽는다.

새 테스트는 같은 준비를 쓰고, 카드가 검증에서 멈춰 있는 동안 아래를 단언한 뒤, 본보기와 같은
방법으로 검증을 풀어 테스트를 끝낸다.

```ts
const actions = yield * KanbanBoardActions;
const folder = yield * actions.cardFolder(board.sessionId, "a");
expect(Option.getOrThrow(folder).branch).toBe(`ctx/card/${board.goalInstanceId}/a`);
expect(Option.getOrThrow(folder).folder).toContain(board.goalInstanceId);
// A card the board never started has no folder.
expect(Option.isNone(yield * actions.cardFolder(board.sessionId, "missing"))).toBe(true);
```

테스트 이름: `"names a running card's folder and branch, and none for a card without a folder"`.

**Verify**: `cd packages/memory-agent && vp test --run src/kanban/kanban-flow.test.ts` → all pass
(새 테스트 포함).

### Step 5: 화면이 읽는다

1. `apps/agent/app/entry/api.ts`의 `kanban` 다음에 더한다.

```ts
  /** Where a card's work is on disk; null when the card has no folder now. */
  cardFolder: (session: string, card: string) =>
    appCall((client) => client.sessions.cardFolder({ params: { session, card } })),
```

2. `queries/keys.ts`의 `session.kanban` 다음에 더한다.

```ts
    cardFolder: (projectId: string, sessionId: string, cardId: string) =>
      [...appQueryKeys.session.kanban(projectId, sessionId), "folder", cardId] as const,
```

키를 `kanban` 키 아래에 두는 까닭: 보드의 요청이 끝날 때와 서버 이벤트가 `kanban` 키를
무효화하면 폴더 읽기도 함께 다시 읽힌다.

3. `queries/session.ts`의 `sessionQueries.kanban` 다음에 더한다.

```ts
  cardFolder: (projectId: string, sessionId: string, cardId: string) =>
    queryOptions({
      queryKey: appQueryKeys.session.cardFolder(projectId, sessionId, cardId),
      queryFn: () => api.cardFolder(sessionId, cardId),
      staleTime: 0,
    }),
```

훅도 더한다(`useKanbanQuery` 다음).

```ts
/** The open card's folder; read only while the card can have one. */
export const useCardFolderQuery = (
  projectId: string,
  sessionId: string,
  cardId: string,
  enabled: boolean,
) => useQuery({ ...sessionQueries.cardFolder(projectId, sessionId, cardId), enabled });
```

**Verify**: `vp run agent#typecheck` → exit 0.

### Step 6: 카드 패널에 보인다

`card-peek.tsx`:

1. `CardPeek`의 props에 더한다.

```tsx
  /** The conversation the panel's card belongs to. */
  readonly sessionId: string;
```

2. 모듈 수준(`riskItems` 근처)에 더한다.

```tsx
/** Only a card that started and has not finished can have a folder of its own. */
const folderStatuses: readonly CardStatus[] = [
  "in_progress",
  "verify",
  "human_decision",
  "blocked",
];
```

`CardPeek` 안, 다른 훅들 옆에 더한다.

```tsx
const openCardId = Peek.$is("Card")(peek) ? peek.cardId : null;
const folder = useCardFolderQuery(
  projectId,
  sessionId,
  openCardId ?? "",
  kanbanActive &&
    openCardId !== null &&
    entry !== null &&
    folderStatuses.includes(entry.card.status),
).data;
```

import: `import { useCardFolderQuery } from "../../queries/session";`. `CardStatus`는 이 파일이
이미 `../../api`에서 가져온다. 3. `<CardDetails … />`에 `folder={folder ?? null}`을 더한다. `CardDetails`의 props에 더한다.

```tsx
  /** Where the card's work is on disk; null when it has no folder now or it was not read. */
  readonly folder: { readonly folder: string; readonly branch: string | null } | null;
```

4. `CardDetails`의 "실행 기록" 항목 다음, "마지막 변경" 항목 앞에 더한다.

```tsx
{
  folder !== null && (
    <DataListItem
      term={<Trans comment="Card field: the folder the card's work is in">작업 폴더</Trans>}
    >
      <code className="font-mono break-all select-all">{folder.folder}</code>
    </DataListItem>
  );
}
{
  folder !== null && folder.branch !== null && (
    <DataListItem
      term={<Trans comment="Card field: the git branch the card's work is on">브랜치</Trans>}
    >
      <code className="font-mono break-all select-all">{folder.branch}</code>
    </DataListItem>
  );
}
```

`board-surface.tsx`:

5. `<CardPeek …>`에 `sessionId={peekSession}`을 더한다.

`card-peek.browser.tsx`(Plan 013이 만들었다):

6. `base`에 `sessionId: "session-a"`를 더한다. 두 테스트의 카드는 시작하지 않은 카드(`backlog`)이거나
   새 카드라 폴더를 읽지 않는다. 서버 대역은 필요 없다.

**Verify**:

- `vp run agent#typecheck` → exit 0. `vp check` → exit 0.
- 브라우저 테스트 명령 → 통과.

### Step 7: 문구와 문서

- `vp run agent#i18n:extract` → `vp run agent#i18n:check`, `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`.
- `packages/memory-agent/src/kanban/README.md`: `KanbanBoardView` 줄(14행) 근처에 `CardFolderView`와
  `KanbanBoardActions.cardFolder`를 적는다. 브랜치 이름 함수가 `worktree.ts`에 있다고 적는다.
- `packages/memory-agent/src/api/README.md`: 세션 API 목록에 새 endpoint를 더한다(기존 `kanban`
  항목의 형식을 따른다).
- `apps/agent/app/entry/chat/board/README.md`: `CardPeek` 항목에 "작업 폴더와 브랜치를 따로 읽어
  보인다"를 더한다. Side Effects에 `CardPeek`가 `useCardFolderQuery`로 서버를 읽는다고 고친다("자체
  네트워크 호출은 없다"는 문장이 더는 맞지 않는다).
- `docs/decisions.md` 끝에 항목 하나. 제목: `## 카드 작업 폴더는 카드 패널이 따로 읽어 보인다 (오늘 날짜)`.
  내용: 사용자 결정(2026-11-15). 계기(판단 문구가 카드 작업 폴더를 보라고 하지만 그 위치가 어디에도
  없었다), 결정(읽기 하나를 따로 둔다. 판단 내용과 보드 전체 읽기에는 경로를 넣지 않는다. 폴더가
  지금 없으면 null이다. 차례 실행 모드는 프로젝트 폴더와 브랜치 없음이다), 버린 안(`KanbanCardView`에
  경로를 넣기: 보드를 읽을 때마다 카드 수만큼 git이 돈다. `DecisionKind`에 경로를 넣기: 판단
  내용에 경로를 넣지 않는 기존 설계와 어긋난다).

**Verify**: `vp check` → exit 0. 세 문구 명령 모두 exit 0.

## Test plan

- 서버 테스트 하나: 실행 중인 카드의 폴더와 브랜치 이름, 폴더가 없는 카드는 none.
- 화면: 기존 브라우저 테스트가 새 prop과 함께 그대로 통과한다. 항목 둘을 그리는 것은 표시뿐이라
  따로 테스트하지 않는다.

## Done criteria

- [ ] 저장소 루트에서 `vp run memory-agent#typecheck`, `vp run agent#typecheck`, `vp check`, `vp run agent#i18n:check` 모두 exit 0
- [ ] `cd packages/memory-agent && vp test --run src/kanban/kanban-flow.test.ts src/kanban/git-worktrees.test.ts` exits 0
- [ ] `rg -n "cardFolder" packages/memory-agent/src apps/agent/app --glob '!*.md' -l` → `board-actions.ts`, `app-api/sessions.ts`, `.server/api/sessions.ts`, `api.ts`, `keys.ts`, `queries/session.ts`, 테스트
- [ ] `rg -n "cardFolder|CardFolderView" apps/agent/app/entry/report packages/memory-agent/src/kanban/human-decision-schema.ts packages/memory-agent/src/kanban/human-decision.ts` → 결과 없음
- [ ] `rg -n "const (goalBranchName|cardBranchName|cardBranchFolder)" packages/memory-agent/src/kanban/git-worktrees.ts` → 결과 없음
- [ ] `git status --short`에 In scope 밖의 수정이 없다
- [ ] `plans/README.md`의 행을 고쳤다. 보고에 "서버를 바꿨으므로 dev를 다시 시작해야 한다"를 적었다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다(Plan 012·013·015의 화면 변경은 예외).
- Plan 013이나 015가 아직 들어가지 않았다(`card-peek.tsx`에 "실행 기록" 항목이나 `<aside`가 없다).
- `goal.value`에 `projectRoot`가 없다.
- `Effect.catchTag("CardWorktreeFailed", …)`가 typecheck에서 실패한다(`present`의 오류 타입이 다르다).
- 서버 테스트의 본보기에서 "카드가 검증에서 멈춰 있는 동안"을 만드는 준비를 새 테스트로 옮길 수
  없다(본보기의 준비가 그 테스트 안의 지역 값에 60행 넘게 얽혀 있다). 그때는 테스트 없이 넘어가지
  말고 멈춘다.
- DB migration이 필요해 보인다.
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- 경로는 이 endpoint에만 있다. 제보 묶음이나 판단 요청에 같은 값을 더하려는 변경이 오면 이 계획의
  결정(경로는 카드 패널이 따로 읽는다)을 먼저 본다.
- `cardFolder`는 폴더를 찾지 못한 까닭을 구분하지 않는다. git이 실패해도 "폴더 없음"으로 답한다.
  화면에 항목이 나오지 않을 뿐이다. 까닭을 보여야 하면 응답을 태그 유니온으로 바꾼다.
- 폴더 읽기는 카드 패널을 열 때와 `kanban` 키가 무효화될 때 다시 나간다. 요청마다 git 프로세스
  하나다.
- 이어서 할 만한 것: 진행 중인 카드가 지금 무엇을 하는지 보드에서 보기. 서버에
  `kanban_card_runs.trace_attempt_id`가 있으므로 같은 방식(카드 하나를 따로 읽기)으로 Work Trace의
  작업 id를 줄 수 있다. 이 계획은 다루지 않는다.
- 리뷰에서 볼 곳: `view`와 `KanbanCardView`가 바뀌지 않았는가. 새 endpoint의 오류 목록이 `kanban`
  endpoint와 같은가. 시작하지 않은 카드에서 폴더 요청이 나가지 않는가.
