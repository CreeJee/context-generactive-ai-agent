# Plan 007: 판단 대기는 모든 프로젝트의 것을 모아 보인다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- apps/agent/app/entry/navigation/decision-inbox.tsx apps/agent/app/entry/queries/project.ts apps/agent/app/entry/index.tsx`
> Plan 004·005가 `index.tsx`를 바꾼 것은 예상된 차이다. `decision-inbox.tsx`나
> `queries/project.ts`가 바뀌었으면 "Current state"의 발췌와 견준다. 다르면 STOP이다.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/005-sidebar-project-header-actions.md
- **Category**: tech-debt
- **Planned at**: commit `d65cc285`, 2026-11-14

## Why this matters

사이드바의 "판단 대기"는 사람의 답이나 승인을 기다리는 칸반 카드를 모아 보이고, 개수를 배지로
보인다. 그런데 지금 열린 대화의 프로젝트 것만 읽는다. 대화 목록은 모든 프로젝트를 보이는데,
다른 프로젝트의 카드가 사람을 기다려도 사이드바에는 아무 표시가 없다. 그 카드를 가진 보드는
사람이 답할 때까지 그 카드를 진행하지 못한다.

Plan 005 뒤에는 "선택된 프로젝트"를 고르는 화면이 없으므로, 이 줄이 한 프로젝트에 묶여 있을
까닭도 없다. 이 계획 뒤에는 "판단 대기"가 목록에 있는 모든 프로젝트의 것을 모으고, 항목마다
프로젝트 이름을 보인다.

## Current state

### 관련 파일

- `apps/agent/app/entry/navigation/decision-inbox.tsx` — 사이드바 줄과 그 Sheet. 191행.
- `apps/agent/app/entry/queries/project.ts` — `projectQueries.decisions`, `projectQueries.boards`,
  `useDecisionInboxQuery`, `useProjectBoardsQuery`, 그리고 여러 프로젝트를 `useQueries`로 읽는
  본보기 `useAllWorkingSessions`(155–181행).
- `apps/agent/app/entry/index.tsx` — `DecisionInbox`를 조립한다.
- `apps/agent/app/entry/chat/decision-prompt.tsx` — 한 판단 요청에 답하는 폼. `projectId`를 받는다.

### 발췌

`decision-inbox.tsx:32-52`:

```tsx
export function DecisionInbox({
  projectId,
  holder,
  onOpenCard,
}: {
  readonly projectId: string;
  readonly holder: string;
  readonly onOpenCard: (sessionId: string, cardId: string) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const inbox = useDecisionInboxQuery(projectId);
  const boards = useProjectBoardsQuery(projectId);
  const items = inbox.data ?? [];
  // A list that did not load is not an empty one.
  const failed = inbox.isError || boards.isError;
  const approvals = (boards.data ?? []).flatMap((board) =>
    board.awaitingApproval.map((card) => ({ ...card, board })),
  );
  const approve = useBoardsKanbanMutation(holder)(projectId);
  const [approveError, setApproveError] = useState<string | null>(null);
  const count = items.length + approvals.length;
```

`decision-inbox.tsx:92-128` — 판단 항목 하나(줄임):

```tsx
            {items.map((item) => (
              <section key={item.requestId} aria-label={/* … 판단 */} className="space-y-1.5 rounded-md border p-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{item.cardTitle}</p>
                    <p className="truncate">
                      {item.sessionTitle ?? t`제목 없는 대화`} · {koreanLocalTime(item.createdAt)}
                    </p>
                  </div>
                  <Button /* 카드 보기 */ onClick={() => { setOpen(false); onOpenCard(item.sessionId, item.cardId); }}>
                  {/* ... */}
                </div>
                <DecisionPrompt projectId={projectId} holder={holder} request={item} disabled={false} />
              </section>
            ))}
```

`decision-inbox.tsx:134-184` — 승인 항목 하나. `approve.mutate({ sessionId: board.sessionId, action: KanbanAction.Intent({ intent: BoardIntent.Approve({ cardId }) }) }, { onError: … })`를 부른다.
`approve`는 `useBoardsKanbanMutation(holder)(projectId)`로, 프로젝트에 묶인 훅이다.

`decision-inbox.tsx:68-74` — Sheet의 설명:

```tsx
<Trans>
  이 프로젝트의 모든 대화와 Goal에서 사람의 판단이나 승인을 기다리는 카드입니다. 여기서 답하거나
  승인하고, 카드가 있는 보드로 이동합니다.
</Trans>
```

`queries/project.ts:155-181` — 여러 프로젝트를 읽는 본보기:

```ts
export function useAllWorkingSessions(
  projects: ReadonlyArray<{ readonly id: string }>,
): ReadonlyArray<ProjectWorking> {
  const answering = useQueries({
    queries: projects.map((project) => ({
      ...projectQueries.running(project.id),
      refetchInterval: followRunning,
    })),
  });
  const boards = useQueries({
    queries: projects.map((project) => ({
      ...projectQueries.boards(project.id),
      refetchInterval: followBoards,
    })),
  });
  return projects.map((project, index): ProjectWorking => {
    /* ... */
  });
}
```

`index.tsx`(Plan 005 뒤) — 조립:

```tsx
{
  projectId && (
    <SidebarGroup>
      <SidebarMenu>
        <DecisionInbox
          projectId={projectId}
          holder={pageHolder()}
          onOpenCard={(session, card) =>
            void setLocation({ ...leaveProjectBoard, session, card }, { history: "push" })
          }
        />
      </SidebarMenu>
    </SidebarGroup>
  );
}
```

### 알아 둘 것

- `projectQueries.decisions`와 `projectQueries.boards`는 `staleTime: 0`이다. 쿼리 키는
  `["app", "project", <id>, "decisions"]`, `["app", "project", <id>, "boards"]`다. 서버 이벤트가
  프로젝트별 키를 무효화한다. 키와 queryFn을 바꾸지 않는다.
- `boards`는 `useAllWorkingSessions`가 이미 모든 프로젝트에 대해 읽는다. 같은 키라 요청이 늘지
  않는다. `decisions`는 프로젝트 수만큼 요청이 는다(목록에 19개일 때 19개).
- 판단에 답하거나 승인하는 요청은 그 카드의 대화(session)로 간다. 다른 탭이 그 대화를 쓰고
  있으면 서버가 423으로 거절하고, 지금처럼 항목 아래에 오류 문구가 보인다.

### 따라야 할 규칙

- UI는 `~/components/ui/*`의 shadcn 컴포넌트로만 만든다. 새 컴포넌트를 들이지 않는다.
- 화면 문구는 Lingui 매크로로 쓴다. 한국어 합니다체.
- 훅은 반복문 안에서 부르지 않는다. 프로젝트마다 다른 훅이 필요하면 프로젝트마다 컴포넌트를 둔다.
- `let`, `while`, lint 끄기 주석, `unknown` 타입을 쓰지 않는다.
- 줄바꿈을 손으로 맞추지 않는다.

## Commands you will need

| Purpose           | Command                                                                              | Expected on success |
| ----------------- | ------------------------------------------------------------------------------------ | ------------------- |
| agent typecheck   | 저장소 루트에서 `vp run agent#typecheck`                                             | exit 0              |
| 포맷·lint         | 저장소 루트에서 `vp check`                                                           | exit 0              |
| 문구 catalog 갱신 | 저장소 루트에서 `vp run agent#i18n:extract`                                          | `ko.po`가 바뀐다    |
| 문구 catalog 검사 | 저장소 루트에서 `vp run agent#i18n:check`                                            | exit 0              |
| 문구 내용 검사    | 저장소 루트에서 `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po` | exit 0              |
| 테스트            | `cd apps/agent && vp test --run app/entry/navigation/decision-inbox.test.tsx`        | all pass            |

- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**

## Scope

**In scope**:

- `apps/agent/app/entry/navigation/decision-inbox.tsx`
- `apps/agent/app/entry/queries/project.ts` (훅 하나를 더한다)
- `apps/agent/app/entry/index.tsx` (`DecisionInbox`를 조립하는 곳만)
- `apps/agent/app/entry/navigation/decision-inbox.test.tsx` (새 파일)
- `apps/agent/app/locales/ko.po` (추출 명령이 고친다)
- `apps/agent/app/entry/navigation/README.md`, `docs/decisions.md`(끝에 항목 하나)

**Out of scope**:

- 서버. 모든 프로젝트의 판단을 한 번에 주는 엔드포인트를 만들지 않는다. 2026-11-12에 같은
  까닭으로 버린 안이다(프로젝트별 캐시 키와 이벤트 무효화를 다시 만들어야 한다).
- `chat/decision-prompt.tsx`, `chat/board/*`. 받는 prop은 그대로다.
- 프로젝트 보드(`ProjectBoard`). 한 프로젝트의 보드인 채로 둔다.

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `feat(sidebar): 판단 대기가 모든 프로젝트의 카드를 모은다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 모든 프로젝트의 판단과 승인 대기를 읽는 훅

`queries/project.ts`에 `useAllWorkingSessions` 다음에 더한다.

```ts
/** One project's cards waiting for a person: decisions to answer and added cards to approve. */
export type ProjectWaiting = {
  readonly projectId: string;
  readonly name: string;
  readonly decisions: Awaited<ReturnType<typeof api.decisionInbox>>;
  readonly boards: Awaited<ReturnType<typeof api.projectBoards>>;
};

/**
 * Cards waiting for a person, across every listed project. The reads keep each project's own
 * `decisions` and `boards` keys, so events still refresh only the project they touched.
 */
export function useAllWaitingDecisions(
  projects: ReadonlyArray<{ readonly id: string; readonly name: string }>,
) {
  const decisions = useQueries({
    queries: projects.map((project) => projectQueries.decisions(project.id)),
  });
  const boards = useQueries({
    queries: projects.map((project) => projectQueries.boards(project.id)),
  });
  return {
    waiting: projects.map((project, index): ProjectWaiting => ({
      projectId: project.id,
      name: project.name,
      decisions: decisions[index]?.data ?? [],
      boards: boards[index]?.data ?? [],
    })),
    /** Some read failed: a list that did not load is not an empty one. */
    failed: decisions.some((read) => read.isError) || boards.some((read) => read.isError),
    refetch: () => {
      decisions.forEach((read) => void read.refetch());
      boards.forEach((read) => void read.refetch());
    },
  };
}
```

`useDecisionInboxQuery`는 다른 쓰임이 없으면 지운다(`rg -n "useDecisionInboxQuery" apps/agent/app`로
확인한다). `useProjectBoardsQuery`는 다른 곳이 쓰므로 둔다.

**Verify**: `vp run agent#typecheck` → exit 0.

### Step 2: `DecisionInbox`가 프로젝트 목록을 받는다

`decision-inbox.tsx`:

- prop을 바꾼다.

```tsx
export function DecisionInbox({
  projects,
  holder,
  onOpenCard,
}: {
  /** Every listed project; the inbox gathers what waits in each. */
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly holder: string;
  readonly onOpenCard: (projectId: string, sessionId: string, cardId: string) => void;
}) {
```

- `const { waiting, failed, refetch } = useAllWaitingDecisions(projects);`
- 개수: 모든 프로젝트의 `decisions.length`와 `boards`의 `awaitingApproval.length`를 더한다.
- Sheet 본문은 프로젝트별로 그린다. 기다리는 것이 있는 프로젝트만. 프로젝트가 둘 이상 보일 때
  프로젝트 이름을 작은 머리줄로 둔다(`<h4 className="text-xs font-medium text-foreground">`).
- 프로젝트 하나의 항목들을 그리는 컴포넌트 `ProjectWaitingList`를 같은 파일에 만든다. 지금의
  `items.map(...)`과 `approvals.map(...)` 두 블록, `approve` 훅, `approveError` state를 그 안으로
  옮긴다. 이 컴포넌트가 `useBoardsKanbanMutation(holder)(waiting.projectId)`를 부른다. 그래서 훅이
  반복문 밖에 있다.

```tsx
function ProjectWaitingList({
  waiting,
  holder,
  onOpenCard,
}: {
  readonly waiting: ProjectWaiting;
  readonly holder: string;
  readonly onOpenCard: (sessionId: string, cardId: string) => void;
}) {
```

안의 `DecisionPrompt`에는 `projectId={waiting.projectId}`를 넘긴다.

- `LoadFailed`의 `onRetry`는 `refetch`다.
- Sheet 설명의 "이 프로젝트의 모든 대화와 Goal에서"를 "모든 프로젝트의 대화와 Goal에서"로 바꾼다.

`index.tsx`:

```tsx
<SidebarGroup>
  <SidebarMenu>
    <DecisionInbox
      projects={projects.map((project) => ({ id: project.id, name: project.name }))}
      holder={pageHolder()}
      onOpenCard={(project, session, card) =>
        void setLocation({ ...leaveProject, project, session, card }, { history: "push" })
      }
    />
  </SidebarMenu>
</SidebarGroup>
```

- `projectId &&` 조건을 뗀다. 프로젝트가 하나도 없으면 `projects`가 빈 배열이고 개수는 0이다.
- `leaveProject`는 `index.tsx:123-128`의 상수다(`session`, `card`, `board`, `boards`, `boardCard`를
  비운다). 그 위에 `project`, `session`, `card`를 덮어쓴다.

**Verify**: `vp run agent#typecheck` → exit 0.
`rg -n "useDecisionInboxQuery\(projectId\)|projectId=\{projectId\}" apps/agent/app/entry/navigation/decision-inbox.tsx` → 결과 없음.

### Step 3: 테스트

`apps/agent/app/entry/navigation/decision-inbox.test.tsx`를 만든다. jsdom 준비와 렌더는
`sidebar-collapse.test.tsx`(1–150행)를 본보기로 한다. `SidebarProvider`와 `SidebarMenu`로 감싼다
(`DecisionInbox`가 `SidebarMenuItem`을 그린다). `QueryClientProvider`로 감싸고, 서버 호출 없이
`client.setQueryData(projectQueries.decisions(id).queryKey, [...])`와
`client.setQueryData(projectQueries.boards(id).queryKey, [...])`로 값을 넣는다. `staleTime: 0`이라
마운트 때 다시 읽으려 하므로, `vi.spyOn(api, "decisionInbox")`와 `vi.spyOn(api, "projectBoards")`가
프로젝트 id에 따라 같은 값을 돌려주게 한다(`queries/mutations/global.test.tsx:65-70`의 방식).

테스트 하나:

- 프로젝트 둘. 첫째는 판단 1개, 둘째는 판단 2개.
- 사이드바 줄의 배지가 `3`을 보인다고 단언한다.

판단 항목의 모양(`HumanDecisionRequest`)은 `api.decisionInbox`의 반환 타입에서 읽는다. 타입이
요구하는 필드만 채운다.

**Verify**: `cd apps/agent && vp test --run app/entry/navigation/decision-inbox.test.tsx` → 1 passed.

### Step 4: 문구와 문서

- `vp run agent#i18n:extract` → `vp run agent#i18n:check`, `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`.
- `apps/agent/app/entry/navigation/README.md`: `DecisionInbox`가 모든 프로젝트를 읽는다는 것.
- `docs/decisions.md` 끝에 항목 하나. 계기(다른 프로젝트의 승인 대기가 사이드바에 보이지 않던
  것), 결정(모든 목록 프로젝트의 `decisions`·`boards`를 프로젝트별 키 그대로 읽는다, 항목에
  프로젝트 이름, 카드 보기는 그 프로젝트의 대화로 간다), 버린 안(모든 프로젝트를 한 번에 주는
  엔드포인트), 늘어나는 것(프로젝트 수만큼의 `decisions` 요청).

**Verify**: `vp check` → exit 0. 세 문구 명령 모두 exit 0.

## Test plan

- 새 테스트 하나: 두 프로젝트의 판단 수를 더한 배지.
- 항목을 그리는 모양과 승인 버튼은 옮겼을 뿐이라 테스트하지 않는다.

## Done criteria

- [ ] 저장소 루트에서 `vp run agent#typecheck`, `vp check`, `vp run agent#i18n:check` 모두 exit 0
- [ ] `cd apps/agent && vp test --run app/entry/navigation/decision-inbox.test.tsx` exits 0
- [ ] `rg -n "이 프로젝트의 모든 대화와 Goal" apps/agent/app --glob '!*.po'` → 결과 없음
- [ ] `rg -n "useAllWaitingDecisions" apps/agent/app` → 정의 하나, 쓰임 하나
- [ ] `git status --short`에 In scope 밖의 수정이 없다
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다(`index.tsx`의 Plan 004·005 변경은 예외).
- Plan 005가 아직 들어가지 않았다(`index.tsx`에 `ProjectBoardButton`이 남아 있다).
- `useBoardsKanbanMutation`의 모양이 `(holder)(projectId)`가 아니다.
- `api.decisionInbox`가 돌려주는 항목에 대화 id(`sessionId`)가 없다.
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- 페이지를 열 때 `decisions` 요청이 프로젝트 수만큼 나간다. 지금은 19개다. 프로젝트가 수십 개로
  늘면 서버가 프로젝트별로 묶어 주는 읽기를 다시 따져 본다. 그때도 쿼리 키는 프로젝트별로 둔다.
- 보이지 않는 탭은 이벤트 연결을 닫고, 다시 보일 때 저장된 상태를 다시 읽는다(`docs/decisions.md`
  2026-09-24). 그때 이 요청들도 다시 나간다.
- 리뷰에서 볼 곳: 훅이 `map` 안에서 불리지 않는가. "카드 보기"가 다른 프로젝트의 카드에서도 그
  프로젝트의 대화를 여는가.
