# Plan 010: 설정 메뉴를 다시 묶고, 테마·제보·프로젝트 개선의 자리를 옮긴다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- apps/agent/app/entry/shared/theme.tsx apps/agent/app/entry/report/report-link.tsx apps/agent/app/routes/report.tsx apps/agent/app/entry/settings/pages/improvements.tsx apps/agent/app/entry/settings/shared.tsx`
> 출력이 있으면 "Current state"의 발췌와 실제 코드를 견준다. 다르면 STOP이다.
> `settings/settings-dialog.tsx`, `settings/open-settings.tsx`는 Plan 004가, `index.tsx`와
> `navigation/project-menu.tsx`는 Plan 005가 바꿨다. 그 차이는 예상된 것이다.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/004-settings-dialog-picks-its-project.md, plans/005-sidebar-project-header-actions.md
- **Category**: tech-debt
- **Planned at**: commit `d65cc285`, 2026-11-14

## Why this matters

사이드바 헤더에는 앱 이름 옆에 아이콘이 넷 있다: 제보, 테마, 설정, 접기. 제보 화면은 문제가 났을
때만 쓴다(로컬 DB의 `report_sessions`는 2행이다). 테마는 한 번 정하면 거의 바꾸지 않는다. 둘 다
늘 자리를 차지한다. 제보 아이콘은 잘못 누르면 제보용 대화 행이 하나 생기고, "앱으로 돌아가기"는
`/`로 가서 보던 대화를 잃는다.

설정 창의 왼쪽 메뉴는 다섯 묶음 12쪽이다. 한 쪽짜리 묶음이 셋이고("실행", "개선", "지침"),
권한이 "연결" 묶음에 들어 있다. 프로젝트마다 다른 쪽(MCP, 에이전트, 권한, Skills)과 앱 전체의
쪽이 섞여 있다. "프로젝트 개선"은 저장되는 설정값이 없는 실행 화면이다(찾기·중지 버튼과 보고서).

사용자가 2026-11-14에 정했다: 제보 아이콘을 헤더에서 뺀다. 프로젝트 개선은 설정에서 빼 프로젝트
`…` 메뉴로 옮긴다.

이 계획 뒤에는:

- 사이드바 헤더에 앱 이름, 설정, 접기만 있다.
- 설정 창에 "일반" 쪽이 생기고 테마와 문제 제보 링크가 거기 있다.
- 메뉴가 일반 / 도구 / 기억 / 프로젝트 / 실행으로 묶인다. 프로젝트 고르는 줄은 프로젝트에 묶인
  쪽에서만 보인다.
- 프로젝트 개선은 프로젝트 `…` 메뉴에서 자기 창으로 열린다.
- 제보 화면의 "앱으로 돌아가기"가 보던 대화로 돌아간다.

## Current state

### 관련 파일

- `apps/agent/app/entry/settings/settings-dialog.tsx` — 메뉴 묶음(`settingsGroups`), 쪽 본문(`pageBodies`), 창.
- `apps/agent/app/entry/settings/open-settings.tsx` — Plan 004 뒤: `openSettingsOverlay({ projectId, initialPage })`.
- `apps/agent/app/entry/settings/shared.tsx` — `pageTitles`, `PageHeader`.
- `apps/agent/app/entry/settings/pages/improvements.tsx` — `ImprovementSettings`. prop이 없다.
- `apps/agent/app/entry/settings/pages/conversation.tsx` — "긴 대화" 쪽. 쪽 하나의 본보기로 쓴다.
- `apps/agent/app/entry/shared/theme.tsx` — `ThemeSelect`. 테마를 고르고, 적용하고, 시스템 테마
  변경을 듣는다.
- `apps/agent/app/entry/shared/theme-script.ts` — 첫 화면이 그려지기 전에 테마를 적용하는 스크립트.
  `root.tsx:18`이 쓴다. 건드리지 않는다.
- `apps/agent/app/entry/report/report-link.tsx` — `reportHref`와 `ReportLink`.
- `apps/agent/app/entry/report/report-draft.test.tsx` — `reportHref`와 `ReportLink`를 시험한다(7–25행).
- `apps/agent/app/routes/report.tsx` — 제보 화면. 195행에 돌아가기 링크.
- `apps/agent/app/entry/index.tsx` — 사이드바 헤더(672–691행), slash `/settings`·`/report`.
- `apps/agent/app/entry/navigation/project-menu.tsx` — Plan 005가 만든 프로젝트 `…` 메뉴.

### 발췌

`settings-dialog.tsx:46-92` — 지금의 묶음(줄임):

```tsx
const settingsGroups = [
  {
    id: "connection",
    label: msg({ message: "연결" /* … */ }),
    pages: [
      { value: "web", icon: GlobeIcon },
      { value: "image", icon: ImageIcon },
      { value: "mcp", icon: PlugIcon },
      { value: "agents", icon: BotIcon },
      { value: "permission", icon: ShieldCheckIcon },
    ],
  },
  {
    id: "memory",
    label: msg({ message: "기억" /* … */ }),
    pages: [
      { value: "conversation", icon: MessagesSquareIcon },
      { value: "recall", icon: WaypointsIcon },
      { value: "imports", icon: HistoryIcon },
      { value: "embedding", icon: CpuIcon },
    ],
  },
  {
    id: "run",
    label: msg({ message: "실행" /* … */ }),
    pages: [{ value: "kanban", icon: KanbanIcon }],
  },
  {
    id: "improvement",
    label: msg({ message: "개선" /* … */ }),
    pages: [{ value: "improvements", icon: WrenchIcon }],
  },
  {
    id: "instructions",
    label: msg({ message: "지침" /* … */ }),
    pages: [{ value: "skills", icon: BookOpenIcon }],
  },
] as const;

type SettingsPage = (typeof settingsGroups)[number]["pages"][number]["value"];

const pageBodies: Record<SettingsPage, (project: Project | null) => ReactNode> = {
  improvements: () => <ImprovementSettings />,
  web: () => <KagiSettings />,
  /* … */
};
```

`settings-dialog.tsx:183` — 탭은 처음 값만 받는다(지금 어느 쪽인지 창이 모른다):

```tsx
        <Tabs defaultValue={initialPage} orientation="vertical" className="min-h-0 flex-1">
```

`index.tsx:672-691` — 사이드바 헤더:

```tsx
<SidebarHeader>
  <div className="flex items-center gap-1 pl-1">
    <span className="min-w-0 flex-1 truncate text-sm font-semibold">Context Agent</span>
    <ReportLink projectId={projectId} sessionId={sessionId} />
    <ThemeSelect />
    <Button variant="ghost" size="icon-sm" /* 설정 */ onClick={openSettings}>
      <SettingsIcon />
    </Button>
    <SidebarTrigger aria-label={t`사이드바 접기`} title={t`사이드바 접기 (⌘B)`} />
  </div>
</SidebarHeader>
```

`shared/theme.tsx:43-61` — 한 컴포넌트가 고르기와 적용을 함께 한다:

```tsx
export function ThemeSelect() {
  const { t } = useLingui();
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    setTheme(savedTheme());
  }, []);
  useEffect(() => {
    if (theme === null) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && media.matches),
      );
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
```

같은 파일 68–82행 — 고르면 `localStorage`의 `context-agent-theme`에 적는다.

`routes/report.tsx:91-95,195-197`:

```tsx
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const projectId = params.get("project");
    const sourceSessionId = params.get("session");
    if (!isTruthy(projectId) || !isTruthy(sourceSessionId)) return;
```

```tsx
<a href="/" className="text-sm text-primary underline">
  <Trans>← 앱으로 돌아가기</Trans>
</a>
```

`report/report-link.tsx:6-14` — 남길 함수:

```tsx
function reportHrefBody(projectId: string | null, sessionId: string | null): string {
  if (!isTruthy(projectId)) return "/report";
  const query = new URLSearchParams({ project: projectId });
  if (isTruthy(sessionId)) query.set("session", sessionId);
  return `/report?${query}`;
}
```

### 정해 둔 구성

| 묶음     | 쪽 (위에서부터)                       | 범위                             |
| -------- | ------------------------------------- | -------------------------------- |
| 일반     | 일반(새 쪽: 테마, 문제 제보), 긴 대화 | 앱                               |
| 도구     | 웹 검색, 이미지 생성                  | 앱                               |
| 기억     | 기억 범위, 대화 가져오기, 임베딩      | 앱                               |
| 프로젝트 | 권한, MCP 서버, 외부 에이전트, Skills | 고른 프로젝트                    |
| 실행     | 칸반 실행                             | 앱 + 보호 브랜치만 고른 프로젝트 |

- 처음 열리는 쪽은 "일반"이다.
- 프로젝트 고르는 줄(Plan 004가 넣었다)은 "프로젝트" 묶음의 쪽과 "칸반 실행"에서만 보인다.
- "프로젝트 개선"은 메뉴에 없다. 프로젝트 `…` 메뉴의 "프로젝트 개선"이 자기 창을 연다. 내용은
  지금의 `ImprovementSettings` 그대로다(열린 프로젝트 전부를 본다).

### 따라야 할 규칙

- UI는 `~/components/ui/*`의 shadcn 컴포넌트로만 만든다. 새 shadcn 컴포넌트를 들이지 않는다.
- 화면 문구는 Lingui 매크로로 쓴다. 한국어 합니다체.
- 쪽은 `FieldGroup` 안에 `PageHeader`와 `Field`들을 둔다(`pages/conversation.tsx`가 본보기다).
- shadcn 컴포넌트의 `className`에는 배치 클래스만 준다.
- `let`, `while`, lint 끄기 주석, `unknown` 타입, 값을 숨겨 두는 `useRef`를 쓰지 않는다.
- 줄바꿈을 손으로 맞추지 않는다.

## Commands you will need

| Purpose           | Command                                                                              | Expected on success |
| ----------------- | ------------------------------------------------------------------------------------ | ------------------- |
| agent typecheck   | 저장소 루트에서 `vp run agent#typecheck`                                             | exit 0              |
| 포맷·lint         | 저장소 루트에서 `vp check`                                                           | exit 0              |
| 문구 catalog 갱신 | 저장소 루트에서 `vp run agent#i18n:extract`                                          | `ko.po`가 바뀐다    |
| 문구 catalog 검사 | 저장소 루트에서 `vp run agent#i18n:check`                                            | exit 0              |
| 문구 내용 검사    | 저장소 루트에서 `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po` | exit 0              |
| 설정·제보 테스트  | `cd apps/agent && vp test --run app/entry/settings app/entry/report`                 | all pass            |

- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**

## Scope

**In scope**:

- `apps/agent/app/entry/settings/settings-dialog.tsx`, `settings/open-settings.tsx`, `settings/shared.tsx`(`pageTitles`)
- `apps/agent/app/entry/settings/pages/general.tsx` (새 파일)
- `apps/agent/app/entry/settings/open-improvements.tsx` (새 파일)
- `apps/agent/app/entry/shared/theme.tsx`
- `apps/agent/app/entry/report/report-link.tsx`, `report/report-draft.test.tsx`
- `apps/agent/app/routes/report.tsx` (돌아가기 링크만)
- `apps/agent/app/entry/index.tsx` (사이드바 헤더, `openSettings`, `ThemeSync` 한 줄)
- `apps/agent/app/entry/navigation/project-menu.tsx` (메뉴 항목 하나)
- `apps/agent/app/entry/settings/settings-dialog.test.tsx` (Plan 004의 테스트. prop이 바뀌면 맞춘다)
- `apps/agent/app/locales/ko.po` (추출 명령이 고친다)
- `apps/agent/app/entry/settings/README.md`, `settings/pages/README.md`, `apps/agent/README.md`("화면" 절),
  `docs/decisions.md`(끝에 항목 하나)

**Out of scope**:

- 각 쪽의 본문(`pages/*.tsx`). `improvements.tsx`도 고치지 않는다.
- 임베딩 쪽의 진단 표시, MCP 쪽의 구성. 따로 다룰 일이다.
- 제보 화면의 나머지(`routes/report.tsx`의 다른 부분, `entry/report/*`).
- `shared/theme-script.ts`와 `root.tsx`.
- 서버.

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `refactor(settings): 메뉴를 일반·도구·기억·프로젝트·실행으로 묶는다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 테마를 적용하는 것과 고르는 것을 나눈다

`shared/theme.tsx`:

- 적용 함수를 밖으로 뺀다.

```tsx
/** Puts the theme on the page: dark when chosen, or when the system is dark and it is followed. */
function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" ||
      (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches),
  );
}
```

- `ThemeSync`를 만든다. 화면에 아무것도 그리지 않는다. 마운트될 때 저장된 테마를 적용하고,
  시스템 테마가 바뀌면 그때 저장된 테마를 다시 읽어 적용한다.

```tsx
/** Keeps the page on the saved theme, also when the system's own theme changes. */
export function ThemeSync() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyTheme(savedTheme());
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  return null;
}
```

- `ThemeSelect`를 `ThemeField`로 바꾼다. 설정 쪽 안의 한 줄이다.
  - `Field orientation="horizontal"` 안에 `FieldContent`(`FieldLabel htmlFor="app-theme"` "화면
    테마", `FieldDescription` "이 브라우저에 저장됩니다.")와 `Select`를 둔다.
    `pages/permission.tsx:94-134`의 `Field`와 `Select` 구성이 본보기다.
  - state는 지금처럼 `useState<Theme | null>(null)`와 마운트 때 `savedTheme()`을 읽는 effect다.
  - 고르면 `localStorage`에 적고(지금의 try/catch 그대로) `applyTheme(selected.value)`를 부른다.
  - 아이콘만 보이던 trigger는 라벨이 보이는 보통 trigger로 바꾼다(`className="w-36"`).
    `MonitorIcon`·`MoonIcon`·`SunIcon`과 `triggerLabel`은 쓰임이 없어지면 지운다.
- `ThemeSelect`의 `export`를 지운다.

`index.tsx`: `ThemeSelect` import와 676행을 지우고, `<AppEventsProvider>` 바로 안쪽에
`<ThemeSync />`를 둔다.

**Verify**: `vp run agent#typecheck` → 이 단계에서는 `ThemeField`를 쓰는 곳이 없어 unused 경고가
날 수 있다. Step 2와 한 commit으로 묶는다.

### Step 2: "일반" 쪽

`settings/shared.tsx`의 `pageTitles`에 더한다.

```tsx
  general: msg({ message: "일반", comment: "Settings page name: theme and problem reporting" }),
```

`settings/pages/general.tsx`를 만든다.

```tsx
/** Settings of the app itself: how it looks, and where to report a problem. */
export function GeneralSettings({ reportLink }: { readonly reportLink: string }) {
```

- `FieldGroup` 안에 `PageHeader`(제목 `t(pageTitles.general)`, 설명 "앱의 모양과 문제 제보입니다."),
  `ThemeField`, 그리고 제보 줄.
- 제보 줄: `Field orientation="horizontal"` 안에 `FieldContent`(`FieldLabel` "문제 제보",
  `FieldDescription` "증상과 진단 정보를 모아 개발자에게 보냅니다. 열려 있는 대화에 대한 제보
  화면으로 이동합니다.")와 링크. 링크는 일반 `<a href={reportLink} className="text-sm text-primary underline">`에
  `<Trans>제보 화면 열기</Trans>`를 넣는다(`routes/report.tsx:195`와 같은 class다).

**Verify**: Step 3 뒤에 함께 확인한다.

### Step 3: 메뉴를 다시 묶는다

`settings/settings-dialog.tsx`:

- `settingsGroups`를 "정해 둔 구성"의 표대로 바꾼다. 묶음 id와 라벨:
  `general`("일반"), `tools`("도구"), `memory`("기억"), `project`("프로젝트"), `run`("실행").
  각 라벨에 `comment`를 붙인다(지금의 것들이 본보기다). "일반" 쪽의 아이콘은 `SlidersHorizontalIcon`
  (`lucide-react`)이다. `improvements` 쪽과 `WrenchIcon` import를 지운다.
- `pageBodies`에서 `improvements`를 지우고 `general`을 더한다. `general`은 제보 링크가 필요하다.
  본문 함수가 둘째 위치 인자로 링크를 받게 한다.

```tsx
const pageBodies: Record<SettingsPage, (project: Project | null, reportLink: string) => ReactNode> =
  {
    general: (_project, reportLink) => <GeneralSettings reportLink={reportLink} />,
    web: () => <KagiSettings />,
    /* … */
  };
```

`SettingsPageBody`도 `reportLink`를 받아 넘긴다.

- `SettingsOverlay`에 prop `reportLink: string`을 더하고, `initialPage`의 기본값을 `"general"`로 바꾼다.
- 지금 쪽을 state로 둔다.

```tsx
  const [page, setPage] = useState<SettingsPage>(initialPage);
  // …
        <Tabs value={page} onValueChange={setPage} orientation="vertical" className="min-h-0 flex-1">
```

`onValueChange`가 주는 값의 타입이 `SettingsPage`가 아니면, `settingsGroups`의 쪽 목록에서 그
값을 찾아 찾은 것만 `setPage`한다. `as`로 좁히지 않는다.

- 프로젝트 고르는 줄(Plan 004)은 `project` 묶음의 쪽이거나 `kanban`일 때만 그린다.

```tsx
const projectPages: ReadonlyArray<SettingsPage> = [
  "permission",
  "mcp",
  "agents",
  "skills",
  "kanban",
];
```

- `MissingFolderAlert`도 같은 조건에서만 그린다.
- 창의 설명 문구("대화 밖에서 쓰는 도구와 연결을 관리합니다.")는 그대로 둔다.

`settings/open-settings.tsx`: `reportLink: string`을 받아 넘긴다.

`index.tsx`:

```tsx
const openSettings = () =>
  openSettingsOverlay({ projectId, reportLink: reportHref(projectId, sessionId) });
```

Plan 005가 넣은 `ProjectMenu`의 `onOpenSettings`도 `reportLink`를 넘기게 고친다
(`openSettingsOverlay({ projectId: id, initialPage: "permission", reportLink: reportHref(projectId, sessionId) })`).

**Verify**: `vp run agent#typecheck` → exit 0.
`rg -n "\"improvements\"|ImprovementSettings" apps/agent/app/entry/settings/settings-dialog.tsx` → 결과 없음.
`cd apps/agent && vp test --run app/entry/settings` → all pass(Plan 004의 테스트는 `initialPage="permission"`을
주므로 영향이 없어야 한다. `reportLink`가 필수 prop이 됐으므로 테스트의 렌더에 `reportLink="/report"`를 더한다).

### Step 4: 프로젝트 개선을 자기 창으로

`settings/open-improvements.tsx`를 만든다. `open-settings.tsx`와 같은 방식(overlay-kit)이다.

```tsx
/** Opens the improvement reports of the open projects' repositories, outside the settings. */
export function openImprovementsOverlay() {
  overlay.open(({ isOpen, close, unmount }) => (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (next) return;
        close();
        unmount();
      }}
    >
      <DialogContent className="flex h-[min(40rem,calc(100dvh-2rem))] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{/* "프로젝트 개선" */}</DialogTitle>
          <DialogDescription>
            {/* "열린 프로젝트 전체의 사용 기록에서 찾습니다." */}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-2">
          <QuerySection>
            <ImprovementSettings />
          </QuerySection>
        </div>
      </DialogContent>
    </Dialog>
  ));
}
```

- `DialogContent`의 class는 `settings-dialog.tsx:171`과 같다. `QuerySection`은 `../queries/boundary`다.
- 제목과 설명은 `<Trans>`로 쓴다. `ImprovementSettings` 안의 `PageHeader`가 같은 제목을 한 번 더
  보인다. 그대로 둔다(본문은 고치지 않는다).

`navigation/project-menu.tsx`: "칸반 보드" 다음에 항목을 더한다. "프로젝트 개선"(`WrenchIcon`) →
`openImprovementsOverlay()`. prop을 더하지 않고 이 파일이 직접 import해 부른다.

**Verify**: `vp run agent#typecheck` → exit 0.
`rg -n "openImprovementsOverlay" apps/agent/app` → 정의 하나, 쓰임 하나.

### Step 5: 사이드바 헤더와 제보 링크

`index.tsx`: 675행의 `<ReportLink … />`를 지우고 import에서 `ReportLink`를 뺀다(`reportHref`는 남긴다.
slash `/report`와 `openSettings`가 쓴다).

`report/report-link.tsx`: `ReportLink` 컴포넌트와 그것만 쓰던 import(`useLingui`, `FlagIcon`)를
지운다. `reportHref`는 그대로 둔다.

`report/report-draft.test.tsx`: `ReportLink`를 그리는 단언(21행 근처)과 import를 지운다.
`reportHref`의 단언은 남긴다. 테스트 하나가 통째로 `ReportLink`만 다루면 그 테스트를 지운다.

`routes/report.tsx`: 돌아가기 링크가 보던 대화로 간다.

```tsx
const [backLink, setBackLink] = useState("/");
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const project = params.get("project");
  const session = params.get("session");
  if (!isTruthy(project)) return;
  const query = new URLSearchParams({ project });
  if (isTruthy(session)) query.set("session", session);
  setBackLink(`/?${query}`);
}, []);
```

195행의 `href="/"`를 `href={backLink}`로 바꾼다. 서버가 그리는 첫 화면은 `/`이고, 브라우저가
넘겨받은 뒤 바뀐다. 그래서 hydration이 어긋나지 않는다.

**Verify**: `vp run agent#typecheck` → exit 0.
`rg -n "ReportLink|ThemeSelect" apps/agent/app --glob '!*.md'` → 결과 없음.
`cd apps/agent && vp test --run app/entry/report` → all pass.

### Step 6: 문구와 문서

- `vp run agent#i18n:extract` → `vp run agent#i18n:check`, `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`.
- `apps/agent/app/entry/settings/README.md`, `settings/pages/README.md`: 묶음, "일반" 쪽,
  `openImprovementsOverlay`, 프로젝트 줄이 보이는 조건.
- `apps/agent/README.md`의 "화면" 절: 설정 줄의 묶음을 새 구성으로 고친다. 테마와 문제 제보가
  설정의 "일반"에 있다는 것, 프로젝트 개선이 프로젝트 `…` 메뉴에 있다는 것.
- `docs/decisions.md` 끝에 항목 하나. 계기(헤더의 아이콘 넷, 한 쪽짜리 묶음 셋, 설정값이 없는
  개선 쪽, 사용자 결정 둘), 결정("정해 둔 구성"의 표와 세 항목, 헤더에 남는 것, 돌아가기 링크),
  대체하는 결정("설정 창 구성 (2026-09-17)"의 왼쪽 메뉴 묶음, "동작 개선 실험을 열린 프로젝트
  개선으로 전환 (2026-10-20)"에서 개선 화면의 자리).

**Verify**: `vp check` → exit 0. 세 문구 명령 모두 exit 0.

## Test plan

- 새 자동 테스트를 더하지 않는다. 묶음과 쪽의 대응은 `Record<SettingsPage, …>` 타입이 묶는다.
- 기존 테스트가 통과해야 한다: `app/entry/settings`(Plan 004의 것), `app/entry/report`.
- 운영자가 확인할 것:
  1. 설정을 열면 "일반"이 먼저 보이고, 테마를 바꾸면 바로 바뀐다. 새로고침해도 남는다.
  2. 시스템 테마를 따르게 두고 OS의 테마를 바꾸면 따라 바뀐다(설정 창이 닫혀 있어도).
  3. "웹 검색" 쪽에는 프로젝트 줄이 없고, "권한" 쪽에는 있다.
  4. 프로젝트 `…` 메뉴의 "프로젝트 개선"이 창을 연다.
  5. `/report`로 제보 화면에 갔다가 "앱으로 돌아가기"를 누르면 보던 대화가 열린다.

## Done criteria

- [ ] 저장소 루트에서 `vp run agent#typecheck`, `vp check`, `vp run agent#i18n:check` 모두 exit 0
- [ ] `cd apps/agent && vp test --run app/entry/settings app/entry/report` exits 0
- [ ] `rg -n "ReportLink|ThemeSelect" apps/agent/app --glob '!*.md'` → 결과 없음
- [ ] `rg -n "ThemeSync" apps/agent/app/entry/index.tsx` → 한 줄
- [ ] `rg -n "id: \"(connection|improvement|instructions)\"" apps/agent/app/entry/settings/settings-dialog.tsx` → 결과 없음
- [ ] `git status --short`에 In scope 밖의 수정이 없다
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다(Plan 004·005의 변경은 예외).
- Plan 004가 들어가지 않았다(`SettingsOverlay`가 `project` 객체를 받는다) 또는 Plan 005가 들어가지
  않았다(`navigation/project-menu.tsx`가 없다).
- `Tabs`를 `value`/`onValueChange`로 제어하면 `TabsContent`의 전환(`data-ending-style:hidden`)이
  깨진다.
- `ImprovementSettings`가 설정 창 밖에서 그려지지 않는다(설정 창의 context에 기댄다).
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- 결함 자동 전송을 끄는 체크박스는 제보 화면에 있다(`docs/decisions.md` 2026-10-18 무렵의 결정).
  헤더 아이콘이 없어졌으므로 거기로 가는 길은 `/report` 명령과 설정 "일반"의 링크 둘이다.
- 남은 정리 후보(이 계획에 넣지 않았다): 임베딩 쪽의 진단 표시를 접힌 "상태" 구역으로 모으기,
  "긴 대화"(컨트롤 1개)와 "기억 범위"(2개)를 한 쪽으로 합치기, 이미지 생성 쪽의 키 유무 표시.
- Plan 009가 계정 관리 Sheet에 "새 대화의 기본 모델"을 뒀다. 그것을 "일반" 쪽으로 옮기려면 창이
  `index.tsx`의 `selection` state를 알아야 한다. 옮기지 않는 쪽이 간단하다.
- 리뷰에서 볼 곳: 설정 창을 닫은 뒤에도 시스템 테마 변경이 반영되는가(`ThemeSync`가 창 밖에
  있는가). 프로젝트 줄이 앱 전체의 쪽에서 보이지 않는가.
