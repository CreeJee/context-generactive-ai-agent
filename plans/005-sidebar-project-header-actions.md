# Plan 005: 사이드바에서 프로젝트 고르기를 없애고, 프로젝트 헤더에 동작을 둔다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- apps/agent/app/entry/index.tsx apps/agent/app/entry/navigation apps/agent/app/entry/queries/mutations/project.ts`
> Plan 004가 `index.tsx`의 `openSettings` 두 줄을 바꾼 것은 예상된 차이다. 그 밖의 차이가
> 있으면 "Current state"의 발췌와 실제 코드를 견준다. 다르면 STOP이다.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/004-settings-dialog-picks-its-project.md
- **Category**: tech-debt
- **Planned at**: commit `d65cc285`, 2026-11-14

## Why this matters

사이드바의 대화 목록은 2026-11-12부터 모든 프로젝트를 그룹으로 보인다. 대화 행을 누르면 그
프로젝트의 대화가 바로 열린다. 그런데 그 위에 "프로젝트 선택" 영역이 따로 남아 있다.

- 접히는 "프로젝트" 영역에 프로젝트 콤보박스가 있다. 고르면 그 프로젝트의 첫 대화로 간다.
  목록에서 대화를 누르는 것과 같은 일이다.
- "새 대화" 버튼은 하나뿐이고, 선택된 프로젝트에만 대화를 만든다. 다른 프로젝트에 대화를
  만들려면 먼저 프로젝트를 골라야 한다.
- 그룹 헤더의 "사용 중" 배지는 선택된 프로젝트를 표시할 뿐, 누를 수 있는 것이 아니다.
- 프로젝트의 기억 공유 스위치와 보관 버튼도 선택된 프로젝트의 것만 보인다.

로컬 DB의 수치(2026-11-14): 목록에 뜨는 프로젝트 19개 모두 대화가 있다. 외부 에이전트와 직접
하는 대화는 800개 중 4개다.

이 계획 뒤에는 프로젝트를 "고르는" 화면이 없다. 프로젝트 그룹의 헤더가 그 프로젝트의 동작을
가진다: `+`(새 대화)와 `…`(설정, 칸반 보드, 기억 공유, 보관). URL의 `project` 값은 열린 대화가
속한 프로젝트로만 남는다.

## Current state

### 관련 파일

- `apps/agent/app/entry/index.tsx` — 화면 뼈대. URL 상태, 프로젝트·대화 mutation, 사이드바 조립.
- `apps/agent/app/entry/navigation/sidebar.tsx` — `ProjectSection`(213–355), `ProjectCombobox`(368–449),
  `OpenFolderButton`(456–547), `ProjectSessionGroup`(679–928), `SessionSection`(974–1254).
- `apps/agent/app/entry/navigation/project-board-button.tsx` — 사이드바의 "칸반 보드" 줄.
- `apps/agent/app/entry/queries/mutations/project.ts` — `useCreateSessionMutation(projectId)`(104–111),
  `useCrossRecallMutation`, `useHideProjectMutation`, `useRestoreProjectMutation`.
- `apps/agent/app/entry/settings/open-settings.tsx` — Plan 004 뒤: `openSettingsOverlay({ projectId, initialPage })`.
- `apps/agent/app/entry/navigation/sidebar-collapse.test.tsx` — jsdom 테스트 4개(`SessionSection`).
- `apps/agent/app/entry/navigation/sidebar.browser.tsx` — 브라우저 테스트. `ProjectSection`을 3번,
  `SessionSection`을 13번 쓴다.

### 발췌

`index.tsx:727-760` — 지울 `ProjectSection` 조립(줄임):

```tsx
<ProjectSection
  projects={projects}
  hiddenProjects={hiddenProjects}
  projectId={projectId}
  onSelect={selectProject}
  onAdd={addProject}
  onPickFolder={api.pickFolder}
  busy={projectBusy}
  error={projectError}
  onRestore={(restoredId) => void changeProject({/* restore 뒤 selectProject */})}
  onCrossRecall={(allowed) => void changeProject({/* crossRecallMutation */})}
  onHide={(hiddenId) =>
    void changeProject({
      change: () => hideProjectMutation.mutateAsync(hiddenId),
      failed: () => t`프로젝트를 보관하지 못했습니다. 잠시 뒤 다시 시도해 주십시오.`,
      done: () => {
        const left = projects.filter((project) => project.id !== hiddenId);
        void setLocation({ ...leaveProject, project: left.at(0)?.id ?? null });
      },
    })
  }
/>
```

`index.tsx:763-796` — 선택된 프로젝트가 있을 때만 그리는 메뉴와 목록:

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
        <ProjectBoardButton
          projectId={projectId}
          onOpen={() => void setLocation({ boards: true }, { history: "push" })}
        />
      </SidebarMenu>
    </SidebarGroup>
  );
}
{
  projectId && (
    <SessionSection
      groups={groups}
      working={working}
      /* ... */
      projectId={projectId}
      sessionId={sessionId}
      archiveError={archiveError}
      onCreate={(agent) => void createSession(agent)}
      /* ... */
      agents={slashAgents}
    />
  );
}
```

`index.tsx:481-495` — 새 대화는 선택된 프로젝트에만 만든다:

```tsx
const createSession = (agent?: string) =>
  runUiEffect(
    Effect.gen(function* () {
      if (!isTruthy(projectId)) return;
      const session = yield* uiPromise(() => createSessionMutation.mutateAsync(agent));
      setArchiveError(null);
      void setLocation({ session: session.id }, { history: "push" });
    }).pipe(
      Effect.catchTag("UnknownError", () =>
        Effect.sync(() =>
          setArchiveError(t`새 대화를 만들지 못했습니다. 잠시 뒤 다시 시도해 주십시오.`),
        ),
      ),
    ),
  );
```

`queries/mutations/project.ts:104-111`:

```ts
export function useCreateSessionMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agent?: string) => api.createSession(projectId, agent),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: projectQueries.sessions(projectId).queryKey }),
  });
}
```

`sidebar.tsx:738-775` — 그룹 헤더. 트리거 하나가 헤더 전체다:

```tsx
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="group sticky top-0 z-20 flex h-8 w-full items-center gap-1 rounded-md bg-sidebar px-2 text-xs font-semibold text-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          title={group.name}
        >
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90" />
          <span className="min-w-0 flex-1 truncate text-left">{group.name}</span>
          {!open && ( /* 대화 수 */ )}
          {leading.length > 0 && ( /* 진행 중 배지 */ )}
          {selected && <Badge variant="secondary">{t`사용 중`}</Badge>}
        </CollapsibleTrigger>
```

`sidebar.tsx:1116-1175` — 목록 맨 위의 "새 대화" 버튼 묶음(`ButtonGroup`)과 외부 에이전트 메뉴.

`sidebar.tsx:1198-1199` — 대화가 없는 프로젝트는 선택된 것일 때만 그룹이 된다:

```tsx
        {groups
          .filter((group) => group.sessions.length > 0 || group.projectId === projectId)
```

`index.tsx:658-664` — 대화가 없을 때의 안내:

```tsx
    .with({ sessionId: null }, () => (
      <Placeholder
        icon={<FolderIcon />}
        title={t`새 대화를 시작해 주십시오`}
        description={t`왼쪽의 새 대화 버튼을 눌러 주십시오.`}
      />
    ))
```

### 그대로 두는 것

- URL의 `project`, `session` 값과 `index.tsx:241-252`, `311-322`의 두 effect. URL에 값이 없으면
  첫 프로젝트와 그 첫 대화를 채운다. 화면의 "선택" 기능이 아니라 첫 화면을 정하는 규칙이다.
- 대화 행의 링크(`/?project=…&session=…`, `sidebar.tsx:1045`).
- 그룹의 접힘 저장(`sessionGroupsOpenAtom`)과 sticky 배치(`top-0 z-20`, 안쪽 머리줄 `top-8 z-10`).
  `docs/decisions.md`의 2026-11-12 결정이다.
- `DecisionInbox`는 이 계획에서 지금 그대로 `projectId`에 묶어 둔다. Plan 007이 바꾼다.
- 위쪽 `AccountModelPanel`. Plan 009가 다룬다.

### 따라야 할 규칙

- UI는 `~/components/ui/*`의 shadcn 컴포넌트로만 만든다. 이 계획에 필요한 것은 모두 이미 있다:
  `DropdownMenu*`(`DropdownMenuCheckboxItem` 포함, `components/ui/dropdown-menu.tsx:236-251`),
  `SidebarMenuAction`, `Button`, `Collapsible*`, `Tooltip`. 새 shadcn 컴포넌트가 필요해지면 STOP이다.
- 화면 문구는 모두 Lingui 매크로로 쓴다. 한국어 합니다체. 아이콘 버튼에는 `aria-label`과
  `title`을 같은 문구로 준다(`sidebar.tsx:520-531`이 본보기다).
- 서버 호출은 `runUiEffect(Effect.gen(...))`과 `uiPromise`로 감싼다(`index.tsx:405-416`이 본보기다).
  그 위 줄에 `// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.`
  주석을 둔다.
- `button` 안에 `button`을 넣지 않는다. `CollapsibleTrigger`는 `button`이다.
- `let`, `while`, lint 끄기 주석, `unknown` 타입, 값을 숨겨 두는 `useRef`를 쓰지 않는다.
- 줄바꿈을 손으로 맞추지 않는다.

## Commands you will need

| Purpose           | Command                                                                              | Expected on success                   |
| ----------------- | ------------------------------------------------------------------------------------ | ------------------------------------- |
| agent typecheck   | 저장소 루트에서 `vp run agent#typecheck`                                             | exit 0                                |
| 포맷·lint         | 저장소 루트에서 `vp check`                                                           | exit 0                                |
| 문구 catalog 갱신 | 저장소 루트에서 `vp run agent#i18n:extract`                                          | `ko.po`가 바뀐다                      |
| 문구 catalog 검사 | 저장소 루트에서 `vp run agent#i18n:check`                                            | exit 0                                |
| 문구 내용 검사    | 저장소 루트에서 `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po` | exit 0                                |
| jsdom 테스트      | `cd apps/agent && vp test --run app/entry/navigation/sidebar-collapse.test.tsx`      | all pass (계획 작성 때 4 passed 확인) |

- 브라우저 테스트(`sidebar.browser.tsx`)는 샌드박스에서 Chromium이 뜨지 않을 수 있다
  (`docs/decisions.md` 2026-11-12 기록). 고친 뒤 typecheck로 확인하고, 실행은 운영자에게 맡긴다:
  저장소 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/navigation/sidebar.browser.tsx`.
  직접 돌려서 뜨면 결과를 보고에 적는다.
- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**

## Scope

**In scope**:

- `apps/agent/app/entry/index.tsx`
- `apps/agent/app/entry/navigation/sidebar.tsx`
- `apps/agent/app/entry/navigation/project-menu.tsx` (새 파일)
- `apps/agent/app/entry/navigation/project-board-button.tsx` (지운다)
- `apps/agent/app/entry/queries/mutations/project.ts` (`useCreateSessionMutation`만)
- `apps/agent/app/entry/navigation/sidebar-collapse.test.tsx`
- `apps/agent/app/entry/navigation/sidebar.browser.tsx`
- `apps/agent/app/locales/ko.po` (추출 명령이 고친다)
- `apps/agent/app/entry/navigation/README.md`, `apps/agent/README.md`("화면" 절의 사이드바 줄),
  `docs/decisions.md`(끝에 항목 하나)

**Out of scope**:

- 그룹 안의 "진행 중 / 대화 / 보관함" 구역과 작업 위치 필터. Plan 006이 바꾼다.
- `DecisionInbox`의 내용. Plan 007이 바꾼다.
- `AccountModelPanel`, `ModelSection`, `AccountSwitcher`. Plan 009가 바꾼다.
- 사이드바 헤더의 제보 링크와 테마. Plan 010이 바꾼다.
- 서버 코드와 `api.ts`. 새 API는 없다.
- `settings/settings-dialog.tsx`가 `sidebar.tsx`에서 가져다 쓰는 `MissingFolderNotice`. 지우지 않는다.

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `feat(sidebar): 프로젝트 헤더에서 새 대화를 만든다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 새 대화 mutation이 프로젝트를 인자로 받는다

`queries/mutations/project.ts`:

```ts
export function useCreateSessionMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, agent }: { readonly projectId: string; readonly agent?: string }) =>
      api.createSession(projectId, agent),
    onSuccess: (_session, { projectId }) =>
      client.invalidateQueries({ queryKey: projectQueries.sessions(projectId).queryKey }),
  });
}
```

`index.tsx`:

- `const createSessionMutation = useCreateSessionMutation();`
- `createSession`이 프로젝트를 받는다. 만든 대화의 프로젝트로 간다.

```tsx
const createSession = (targetProjectId: string, agent?: string) =>
  runUiEffect(
    Effect.gen(function* () {
      const session = yield* uiPromise(() =>
        createSessionMutation.mutateAsync({ projectId: targetProjectId, agent }),
      );
      setArchiveError(null);
      void setLocation(
        { ...leaveProject, project: targetProjectId, session: session.id },
        { history: "push" },
      );
    }).pipe(/* 지금의 catchTag 그대로 */),
  );
```

- slash 명령(`index.tsx:526-527`)은 지금 대화의 프로젝트에 만든다. 프로젝트가 없으면 아무것도
  하지 않는다:

```tsx
          new: () =>
            uiPromise(() => createSession(projectId ?? "")).pipe(
              Effect.when(Effect.succeed(isTruthy(projectId))),
              Effect.asVoid,
            ),
          agent: ({ agent }) =>
            uiPromise(() => createSession(projectId ?? "", agent)).pipe(
              Effect.when(Effect.succeed(isTruthy(projectId))),
              Effect.asVoid,
            ),
```

(같은 파일 530–534행의 `mode`가 같은 모양이다.)

- `SessionSection`에 넘기는 `onCreate`는 이 단계에서 `(agent) => void createSession(projectId, agent)`로
  둔다. `SessionSection`은 `projectId &&` 안에서만 그려지므로 그 안에서 `projectId`는 문자열이다.

**Verify**: `vp run agent#typecheck` → exit 0. `rg -n "useCreateSessionMutation\(" apps/agent/app` →
정의 하나, 호출 하나(`index.tsx`), 호출에 인자가 없다.

### Step 2: 프로젝트 메뉴 컴포넌트

`apps/agent/app/entry/navigation/project-menu.tsx`를 만든다. 한 프로젝트의 `…` 메뉴다. 자기
프로젝트의 mutation 훅을 자기가 부른다.

```tsx
export function ProjectMenu({
  project,
  onOpenBoard,
  onOpenSettings,
  onHidden,
  onProblem,
}: {
  readonly project: ListedProject;
  /** Opens the project's kanban board. */
  readonly onOpenBoard: () => void;
  /** Opens the settings on this project. */
  readonly onOpenSettings: () => void;
  /** The project left the list. */
  readonly onHidden: () => void;
  /** Why a change was refused, shown above the list. */
  readonly onProblem: (message: string) => void;
}) {
```

- 안에서 `useCrossRecallMutation(project.id)`, `useHideProjectMutation()`,
  `useProjectBoardsQuery(project.id)`를 쓴다.
- 트리거: `DropdownMenuTrigger`의 `render`에
  `<Button variant="ghost" size="icon-xs" aria-label={…} title={…} />`. 문구는
  "`${project.name}` 메뉴"(comment: "Button that opens a project's menu; name is the project's name").
  아이콘은 `EllipsisIcon`.
- 메뉴 항목, 위에서부터:
  1. "프로젝트 설정"(`SettingsIcon`) → `onOpenSettings()`.
  2. "칸반 보드"(`KanbanSquareIcon`) → `onOpenBoard()`. 오른쪽에 보드 수를
     `<Badge variant={running > 0 ? "default" : "secondary"}>`로 보인다. `running`과 보드 수는 지우는
     `project-board-button.tsx`의 계산을 그대로 옮긴다
     (`Arr.countBy(boards, (board) => board.kanbanActive)`, `boards.length`). 보드가 0개면 배지를 두지 않는다.
  3. `DropdownMenuSeparator`.
  4. `DropdownMenuCheckboxItem`: "다른 프로젝트가 이 기억을 찾도록 허용".
     `checked={!project.crossRecallExcluded}`,
     `onCheckedChange={(checked) => …crossRecall.mutateAsync(!checked)…}`. 실패하면
     `onProblem(errorMessage(refusalOf(failure.cause)))`(`errorMessage`는 `../settings/shared`,
     `refusalOf`는 `../api`). `index.tsx:744-749`의 지금 동작과 같다.
  5. "프로젝트 보관"(`ArchiveIcon`) → `hide.mutateAsync(project.id)` 뒤 `onHidden()`. 실패하면
     `onProblem(t\`프로젝트를 보관하지 못했습니다. 잠시 뒤 다시 시도해 주십시오.\`)`.
- mutation이 도는 동안 4·5번 항목은 `disabled`다.

**Verify**: `vp run agent#typecheck` → exit 0.

### Step 3: 그룹 헤더에 `+`와 `…`를 둔다

`sidebar.tsx`의 `ProjectSessionGroup`:

- 헤더를 한 줄 `div`로 감싸고 sticky와 배경을 그 `div`로 옮긴다. `CollapsibleTrigger`는 그 안에서
  `min-w-0 flex-1`을 가진다. 그 옆에 형제로 동작 버튼을 둔다.

```tsx
<div className="sticky top-0 z-20 flex h-8 items-center gap-0.5 rounded-md bg-sidebar pr-1">
  <CollapsibleTrigger
    className="group flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-xs font-semibold text-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
    title={group.name}
  >
    {/* chevron, 이름, 접혔을 때의 대화 수, 진행 중 배지 — 지금 그대로 */}
  </CollapsibleTrigger>
  {actions}
</div>
```

- `{selected && <Badge variant="secondary">{t\`사용 중\`}</Badge>}` 줄을 지운다.
- 새 prop `actions: React.ReactNode`를 받는다. `SessionSection`이 채운다.
- 폴더가 없어진 프로젝트(`folderMissing`)는 이름 오른쪽에 `FolderXIcon`을 `text-destructive`
  `span`으로 감싸 보이고, `title`에 "프로젝트 폴더가 없습니다"를 준다. 이를 위해 그룹이
  `folderMissing: boolean`을 받는다(아래 Step 4에서 채운다).

`SessionSection`:

- prop을 바꾼다.
  - 지운다: `agents`, `projectId`가 "선택"의 뜻으로 쓰이던 곳의 설명.
  - `onCreate: (projectId: string) => void`로 바꾼다.
  - 더한다: `projectActions: (projectId: string) => React.ReactNode` — 그 프로젝트의 `…` 메뉴.
  - 더한다: `header: React.ReactNode` — 목록 맨 위 줄(Step 4의 "프로젝트 추가" 버튼).
- `groups`의 원소에 `folderMissing: boolean`을 더한다.
- 1116–1175행의 "새 대화" `ButtonGroup`과 외부 에이전트 `DropdownMenu`를 지우고, 그 자리에
  `{header}`를 그린다.
- 각 그룹에 넘기는 `actions`:

```tsx
              actions={
                <>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={newLabel(group.name)}
                    title={newLabel(group.name)}
                    onClick={() => onCreate(group.projectId)}
                  >
                    <PlusIcon />
                  </Button>
                  {projectActions(group.projectId)}
                </>
              }
```

`newLabel`은 "`${name}`에 새 대화"(comment: "Button on a project's header that starts a conversation in it").

- 1198–1199행의 `.filter(...)`를 지운다. 목록에 있는 프로젝트는 대화가 없어도 그룹이 된다.
- 지금 열린 대화의 프로젝트(`projectId`)는 `selected`로 계속 넘긴다. 쓰임은 둘뿐이다: 저장된
  접힘이 없을 때 펼쳐 두기, 행의 `isActive`. prop 주석을 "The project of the open conversation"으로 고친다.
- `projectId` prop의 타입을 `string | null`로 바꾼다(열린 대화가 없을 수 있다).

**Verify**: `vp run agent#typecheck` → 이 단계에서는 `index.tsx`가 옛 prop을 넘겨 실패할 수 있다.
Step 4까지 한 commit으로 묶어도 된다. 묶으면 Step 4의 Verify로 확인한다.

### Step 4: `index.tsx`에서 프로젝트 고르기를 걷어낸다

- `ProjectSection`의 import와 727–760행의 조립을 지운다.
- `ProjectBoardButton`의 import와 773–776행을 지운다. `DecisionInbox`는 남긴다.
- `permissionMutation`은 남긴다(slash `/mode`가 쓴다). `crossRecallMutation`,
  `hideProjectMutation`, `projectBusy`, `projectError`, `changeProject`는 쓰임이 없어지면 지운다.
  `restoreProjectMutation`은 아래 보관 목록이 쓴다.
- `selectProject`와 326–329행의 effect는 쓰임을 확인하고, 남은 쓰임(폴더 열기의 `onSelect`)이
  있으면 둔다.
- `SessionSection`을 `projectId &&` 조건 없이 항상 그린다. 넘기는 값:

```tsx
<SessionSection
  groups={groups}
  working={working}
  loading={sessionsLoading}
  failed={sessionsFailed}
  onRetry={retrySessions}
  projectId={projectId}
  sessionId={sessionId}
  archiveError={archiveError}
  onCreate={(target) => void createSession(target)}
  onArchive={archiveSession}
  onDelete={deleteSession}
  onRestore={restoreSession}
  header={
    <OpenFolderButton
      projects={projects}
      onAdd={addProject}
      onSelect={selectProject}
      onPickFolder={api.pickFolder}
      label={t({ message: "프로젝트 추가", comment: "Button that adds a project from a folder" })}
    />
  }
  projectActions={(id) => {
    const project = projects.find((item) => item.id === id);
    return project === undefined ? null : (
      <ProjectMenu
        project={project}
        onOpenBoard={() =>
          void setLocation({ ...leaveProject, project: id, boards: true }, { history: "push" })
        }
        onOpenSettings={() => openSettingsOverlay({ projectId: id, initialPage: "permission" })}
        onHidden={() => {
          if (id !== projectId) return;
          const left = projects.filter((item) => item.id !== id);
          void setLocation({ ...leaveProject, project: left.at(0)?.id ?? null });
        }}
        onProblem={setArchiveError}
      />
    );
  }}
/>
```

- `useAllProjectSessions`에 넘기는 목록과 `groups`에 `folderMissing`을 싣는다.
  `queries/project.ts`의 `ProjectSessions` 타입을 바꾸지 말고, `index.tsx`에서 합친다:

```tsx
const listed = groups.map((group) => ({
  ...group,
  folderMissing: projects.find((item) => item.id === group.projectId)?.folderMissing === true,
}));
```

- `sessionsFailed`/`sessionsLoading`(218–222행)은 `sessionsQuery`(선택 프로젝트의 읽기)에 기댄다.
  그대로 둔다.
- 보관된 프로젝트: 목록 아래에 접히는 구역 하나를 둔다. `SessionSection` 밖, 바로 다음에 그린다.
  `hiddenProjects.length > 0`일 때만. `sidebar.tsx`에 작은 컴포넌트 `ArchivedProjects`를 더한다:
  `Collapsible`(기본 닫힘) + 머리줄 "보관된 프로젝트"와 개수(지금의 `SessionGroup` 머리줄과 같은
  class를 쓴다) + 프로젝트마다 `SidebarMenuItem` 한 줄(이름, 오른쪽에 `ArchiveRestoreIcon` 버튼
  "보관 해제"). 누르면 `restoreProjectMutation.mutateAsync(id)`, 실패하면
  `setArchiveError(t\`프로젝트를 보관에서 꺼내지 못했습니다. 잠시 뒤 다시 시도해 주십시오.\`)`.
- 658–664행의 안내 문구를 바꾼다: "왼쪽에서 프로젝트 이름 옆의 + 버튼을 눌러 주십시오."

**Verify**: `vp run agent#typecheck` → exit 0.
`rg -n "ProjectSection|ProjectBoardButton|사용 중" apps/agent/app/entry/index.tsx` → 결과 없음.

### Step 5: 쓰이지 않게 된 코드를 지운다

- `sidebar.tsx`: `ProjectSection`, `ProjectCombobox`, `projectSectionOpenAtom`, 그리고 이들만 쓰던
  import(`Combobox*`, `Switch`, `DataList`/`DataListItem`이 `ModelSection`에서 아직 쓰이는지 확인하고
  쓰이는 것은 둔다). `MissingFolderNotice`와 `OpenFolderButton`, `AddProjectDialog`는 남긴다.
- `navigation/project-board-button.tsx`를 지운다.
- `SessionSection`에서 쓰이지 않게 된 import(`ButtonGroup`, `BotIcon`이 행 배지에서 아직 쓰이는지 확인).

**Verify**: `vp run agent#typecheck` → exit 0. `vp check` → exit 0.
`rg -n "ProjectCombobox|projectSectionOpenAtom|project-board-button" apps/agent/app` → 결과 없음.

### Step 6: 테스트를 고친다

`sidebar-collapse.test.tsx`:

- `SessionSection`에 넘기는 prop을 새 모양에 맞춘다(`header={null}`, `projectActions={() => null}`,
  `onCreate`, `agents` 제거, 그룹에 `folderMissing: false`).
- 테스트 하나를 더한다: "프로젝트 헤더의 + 버튼은 그 프로젝트 id로 `onCreate`를 부른다".
  두 프로젝트 그룹을 그리고, 둘째 프로젝트의 `+`(aria-label에 둘째 프로젝트 이름이 든 버튼)를
  누르고, `onCreate`가 둘째 프로젝트 id로 한 번 불렸다고 단언한다.
- 테스트 하나를 더한다: "대화가 없는 프로젝트도 그룹으로 보인다". 대화 0개인 그룹을 열린
  프로젝트가 아닌 채로 넘기고, 그 이름의 헤더가 있다고 단언한다.

`sidebar.browser.tsx`:

- `ProjectSection`을 그리는 테스트("project settings retain aligned rows when expanded", 139행)를
  지우고 import에서 `ProjectSection`을 뺀다.
- "a project without conversations is a group only while it is the selected project"(709행)와
  "a non-selected project without conversations shows no group"(743행)을 새 동작에 맞는 테스트
  하나로 바꾼다: 대화가 없는 프로젝트도 그룹으로 보인다.
- 나머지 `SessionSection` 렌더의 prop을 새 모양에 맞춘다.
- "the project header stays pinned above the section headings"(673행)는 sticky가 헤더 줄 `div`로
  옮겨졌으므로, 단언이 트리거 `button`의 style을 읽고 있으면 그 부모 줄을 읽게 고친다.
- 이 파일의 테스트 6개는 이 계획을 시작하기 전부터 실패한다(2026-11-15 확인. 16개 중 10개 통과).
  이름은 다음과 같다. "each listed project is a collapsible group with its own conversations",
  "a group keeps its fold across a fresh render", "the project header stays pinned above the
  section headings", "a project without conversations is a group only while it is the selected
  project", "a non-selected project without conversations shows no group", "archiving and deleting
  name the conversation's own project". 이 실패는 STOP이 아니다.
  원인: 프로젝트 그룹 헤더를 `getByRole("button", { name: "Alpha" })`처럼 이름 전체로 찾는데,
  헤더 버튼의 이름에는 접힌 그룹의 "대화 N개"와 고른 프로젝트의 "사용 중"이 붙는다. 같은 테스트
  안에서 `getByRole("button", { name: /^Alpha/ })`로 찾는 줄은 통과한다.
  이 Step에서 함께 고친다: 그룹 헤더를 이름 전체로 찾는 곳을 `/^Alpha/`, `/^Gamma/`처럼 앞머리
  정규식으로 바꾼다. 단언의 대상과 기대값은 바꾸지 않는다. 브라우저가 뜨면 파일 전체를 돌려
  결과를 보고에 적는다. 정규식으로 바꾼 뒤에도 실패하는 테스트는 더 고치지 않고, 이름과 실패
  메시지를 보고에 적는다.

**Verify**: `cd apps/agent && vp test --run app/entry/navigation/sidebar-collapse.test.tsx` → 6 passed.
`vp run agent#typecheck` → exit 0(브라우저 테스트 파일도 타입이 맞아야 한다).

### Step 7: 문구와 문서

- `vp run agent#i18n:extract` → `vp run agent#i18n:check`, `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`.
- `apps/agent/app/entry/navigation/README.md`: `ProjectSection`·`ProjectBoardButton` 설명을 지우고
  `ProjectMenu`, 헤더의 `+`, 보관된 프로젝트 구역을 적는다.
- `apps/agent/README.md`의 "화면" 절에서 사이드바 줄을 고친다: 프로젝트 선택 대신, 프로젝트
  이름 옆 `+`로 새 대화, `…`로 설정·칸반 보드·기억 공유·보관. 외부 에이전트와 직접 대화는
  `/agent` 명령으로 시작한다는 것.
- `docs/decisions.md` 끝에 항목 하나. 계기(목록이 이미 모든 프로젝트를 보이는데 고르기가 따로
  있던 것, 위 수치), 결정(프로젝트 고르기 화면 없음, 헤더의 `+`와 `…`, 대화가 없는 프로젝트도
  그룹, "사용 중" 배지 제거, 보관된 프로젝트는 목록 아래 구역, 외부 에이전트 새 대화는
  `/agent`만), 대체하는 결정("프로젝트 보관 해제·폴더 열기·콤보박스 선택 (2026-10-25)"의
  콤보박스, "칸반 보드 목록 접근 경로 (2026-10-21)"의 사이드바 줄, 2026-11-12 "사이드바 UI 방향"의
  "사이드바 `ProjectSection`은 …만 담는다").

**Verify**: `vp check` → exit 0. 세 문구 명령 모두 exit 0.

## Test plan

- `sidebar-collapse.test.tsx`: 기존 4개를 새 prop에 맞추고, 2개를 더한다(위 Step 6).
- `sidebar.browser.tsx`: 고치되 실행은 운영자 환경에서 한다.
- 메뉴 항목이 mutation을 부르는지는 테스트하지 않는다. 타입이 묶어 준다.

## Done criteria

- [ ] 저장소 루트에서 `vp run agent#typecheck`, `vp check`, `vp run agent#i18n:check` 모두 exit 0
- [ ] `cd apps/agent && vp test --run app/entry/navigation/sidebar-collapse.test.tsx` → 6 passed
- [ ] `rg -n "ProjectSection|ProjectCombobox|ProjectBoardButton" apps/agent/app --glob '!*.md'` → 결과 없음
- [ ] `rg -n "사용 중" apps/agent/app/entry/navigation/sidebar.tsx` → 결과 없음
- [ ] `rg -n "새 대화 상대|외부 에이전트와 직접" apps/agent/app/entry/navigation` → 결과 없음
- [ ] `git status --short`에 In scope 밖의 수정이 없다
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다(Plan 004의 두 줄은 예외).
- Plan 004가 아직 들어가지 않았다(`openSettingsOverlay`가 `project` 객체를 받는다).
- 헤더 줄에 버튼을 두면 `CollapsibleTrigger` 안에 버튼이 들어가는 구조밖에 만들 수 없다.
- `shadcn/no-restyle` lint가 헤더 줄의 class를 거부하고, 배치 클래스만으로는 sticky 배경을
  만들 수 없다. lint 끄기 주석을 쓰지 말고 멈춘다.
- `SessionSection`이나 `sessionsQuery`를 `projectId`가 `null`일 때도 돌게 하려면 `queries/project.ts`를
  고쳐야 한다.
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- 잃는 것: 사이드바에서 외부 에이전트와 직접 하는 대화를 시작하는 메뉴. 열린 대화에서 `/agent <이름>`
  으로 같은 프로젝트에 만든다. 대화가 하나도 없는 프로젝트에서는 `+`로 대화를 만든 뒤 `/agent`를 친다.
- 잃는 것: 사이드바에 늘 보이던 칸반 보드 수. 프로젝트 `…` 메뉴 안으로 갔다. 실행 중인 보드는
  그룹 헤더의 진행 중 배지로 계속 보인다.
- `ProjectMenu`가 프로젝트마다 `useProjectBoardsQuery`를 부른다. 같은 쿼리 키를
  `useAllWorkingSessions`가 이미 모든 프로젝트에 대해 읽으므로 요청은 늘지 않는다.
- Plan 006이 같은 `ProjectSessionGroup`의 본문을 바꾼다. Plan 010이 `…` 메뉴에 "프로젝트 개선"을 더한다.
- 리뷰에서 볼 곳: `button` 안의 `button`이 없는가. 프로젝트를 보관했을 때 열려 있던 대화가 그
  프로젝트의 것이면 다른 프로젝트로 옮겨 가는가.
