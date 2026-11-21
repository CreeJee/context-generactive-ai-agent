# Plan 004: 설정 창이 프로젝트를 스스로 고르고, 바뀐 값을 바로 보인다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- apps/agent/app/entry/settings apps/agent/app/entry/index.tsx`
> 출력이 있으면 "Current state"의 발췌와 실제 코드를 견준다. 다르면 STOP이다.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d65cc285`, 2026-11-14

## Why this matters

설정 창은 열 때 사이드바에서 "선택된 프로젝트" 객체를 한 번 받아 닫을 때까지 그대로 쓴다.
그래서 두 가지가 생긴다.

1. 권한 모드를 바꿔 저장해도 창에는 옛 값이 남는다. 저장은 프로젝트 목록 쿼리를 다시 읽게
   하지만, 창이 든 프로젝트 객체는 열 때의 것이다. 사용자는 저장이 안 된 줄 안다.
2. 다른 프로젝트의 MCP·에이전트·권한·Skills·보호 브랜치를 보려면 창을 닫고, 사이드바에서
   프로젝트를 바꾸고, 다시 열어야 한다.

또 전역 설정인 "skill 고르기 모델"이 프로젝트가 없으면 아예 보이지 않는다.

이 계획 뒤에는 설정 창이 프로젝트 id만 받고, 프로젝트 목록 쿼리에서 그 프로젝트를 읽는다.
창 안에서 대상 프로젝트를 바꿀 수 있다. Plan 005(사이드바에서 프로젝트 고르기를 없앤다)가
이 계획에 기댄다.

## Current state

### 관련 파일

- `apps/agent/app/entry/settings/open-settings.tsx` — 설정 창을 overlay로 연다.
- `apps/agent/app/entry/settings/settings-dialog.tsx` — 창 본체. 왼쪽 메뉴와 페이지 본문.
- `apps/agent/app/entry/settings/shared.tsx` — `PageHeader`, `NoProject`, `pageTitles`.
- `apps/agent/app/entry/settings/pages/permission.tsx` — 권한 페이지. `project.permissionMode`를 읽는다.
- `apps/agent/app/entry/settings/pages/skills.tsx` — Skills 페이지. 전역 필드 `SkillRouterField`를 가진다.
- `apps/agent/app/entry/settings/pages/kanban.tsx` — 칸반 페이지. 보호 브랜치만 프로젝트별이다.
- `apps/agent/app/entry/index.tsx` — 유일한 호출부(419행).
- `apps/agent/app/entry/queries/global.ts` — `useProjectsQuery()`(82행). 프로젝트 목록.
- `apps/agent/app/root.tsx:62-78` — `QueryClientProvider`가 `OverlayProvider`를 감싼다. 그래서
  overlay로 연 설정 창 안에서도 쿼리 훅을 쓸 수 있다(페이지들이 이미 쓴다).

### 발췌

`apps/agent/app/entry/settings/open-settings.tsx` 전체:

```tsx
import { overlay } from "overlay-kit";
import type { ListedProject } from "../api";
import { SettingsOverlay } from "./settings-dialog";

/** Open a settings view with the currently selected project. */
export function openSettingsOverlay({
  project,
  initialPage = "web",
}: {
  readonly project: ListedProject | null;
  readonly initialPage?: "web";
}) {
  overlay.open(({ isOpen, close, unmount }) => (
    <SettingsOverlay
      project={project}
      initialPage={initialPage}
      open={isOpen}
      onClose={() => {
        close();
        unmount();
      }}
    />
  ));
}
```

`apps/agent/app/entry/index.tsx:418-419`:

```tsx
const openSettings = () =>
  openSettingsOverlay({ project: projects.find((item) => item.id === projectId) ?? null });
```

`apps/agent/app/entry/settings/settings-dialog.tsx:94,152-162,180-183`:

```tsx
type SettingsPage = (typeof settingsGroups)[number]["pages"][number]["value"];
// ...
export function SettingsOverlay({
  project,
  open,
  onClose,
  initialPage = "web",
}: {
  project: ListedProject | null;
  initialPage?: SettingsPage;
  open: boolean;
  onClose: () => void;
}) {
// ...
        {project?.folderMissing === true && (
          <MissingFolderAlert project={project} onArchived={onClose} />
        )}
        <Tabs defaultValue={initialPage} orientation="vertical" className="min-h-0 flex-1">
```

`apps/agent/app/entry/settings/pages/permission.tsx:107` — 창이 든 객체의 값을 그대로 보인다:

```tsx
        <Select
          value={project.permissionMode}
```

`apps/agent/app/entry/queries/mutations/project.ts:66-73` — 저장은 목록 쿼리만 다시 읽게 한다:

```ts
export function usePermissionModeMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (mode: Parameters<typeof api.setPermissionMode>[1]) =>
      api.setPermissionMode(projectId, mode),
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.projects().queryKey }),
  });
}
```

`apps/agent/app/entry/settings/pages/skills.tsx:82-92` — 프로젝트가 없으면 전역 필드도 없다:

```tsx
export function SkillSettings({ project }: { project: Project | null }) {
  const { t } = useLingui();
  if (!(project !== null))
    return (
      <FieldGroup>
        <PageHeader title={t(pageTitles.skills)} description={t(description)} />
        <NoProject />
      </FieldGroup>
    );
  return <SkillSettingsContent project={project} />;
}
```

`apps/agent/app/entry/settings/shared.tsx:123-129`:

```tsx
export function NoProject() {
  return (
    <FieldDescription>
      <Trans>사이드바에서 프로젝트를 고르면 그 프로젝트의 설정이 보입니다.</Trans>
    </FieldDescription>
  );
}
```

`apps/agent/app/entry/settings/pages/kanban.tsx:353-357`:

```tsx
      {project === null ? (
        <p className="text-sm text-muted-foreground">
          <Trans>보호 브랜치는 프로젝트마다 정합니다. 프로젝트를 고른 뒤 다시 열어 주십시오.</Trans>
        </p>
      ) : (
```

### 따라야 할 규칙

- UI는 `~/components/ui/*`의 shadcn 컴포넌트로만 만든다. 이 계획은 새 shadcn 컴포넌트를
  들이지 않는다. `Select`는 `settings/pages/permission.tsx:106-133`의 쓰임을 그대로 따른다
  (`items` prop에 `{ value, label }` 목록을 주고, `SelectItem`을 같은 목록으로 그린다).
- 화면 문구는 모두 Lingui 매크로(`<Trans>`, `useLingui`의 `t`)로 쓴다. 한국어 합니다체다
  ("…해 주십시오", "…합니다"). 짧은 라벨에는 `comment`를 붙인다(위 발췌들이 본보기다).
- shadcn 컴포넌트의 `className`에는 배치 클래스(`w-48`, `flex`, `gap-2` 등)만 준다. 색·글자
  크기를 주면 lint(`shadcn/no-restyle`)에 걸린다.
- `let`, `while`, lint 끄기 주석, `unknown` 타입, 값을 숨겨 두는 `useRef`를 쓰지 않는다.
- 줄바꿈을 손으로 맞추지 않는다. 포맷은 `vp check`가 맡는다.

## Commands you will need

| Purpose           | Command                                                                      | Expected on success                     |
| ----------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| agent typecheck   | 저장소 루트에서 `vp run agent#typecheck`                                     | exit 0                                  |
| 포맷·lint         | 저장소 루트에서 `vp check`                                                   | exit 0                                  |
| 문구 catalog 갱신 | 저장소 루트에서 `vp run agent#i18n:extract`                                  | `apps/agent/app/locales/ko.po`가 바뀐다 |
| 문구 catalog 검사 | 저장소 루트에서 `vp run agent#i18n:check`                                    | exit 0                                  |
| 문구 내용 검사    | 저장소 루트에서 `node lint/wording/check/main.ts check`                      | exit 0                                  |
| 테스트            | `cd apps/agent && vp test --run app/entry/settings/settings-dialog.test.tsx` | all pass                                |

- 단계마다 건드린 테스트만 돌린다. 전체 suite는 돌리지 않는다.
- lint는 저장소 루트에서 돌린다.
- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.** 운영자의 dev가 같은 checkout을 쓴다.

## Scope

**In scope**:

- `apps/agent/app/entry/settings/open-settings.tsx`
- `apps/agent/app/entry/settings/settings-dialog.tsx`
- `apps/agent/app/entry/settings/shared.tsx` (`NoProject`의 문구만)
- `apps/agent/app/entry/settings/pages/skills.tsx`
- `apps/agent/app/entry/settings/pages/kanban.tsx` (353–357행의 문구만)
- `apps/agent/app/entry/index.tsx` (418–419행만)
- `apps/agent/app/entry/settings/settings-dialog.test.tsx` (새 파일)
- `apps/agent/app/locales/ko.po` (추출 명령이 고친다. 손으로 고치지 않는다)
- `apps/agent/app/entry/settings/README.md`, `docs/decisions.md` (끝에 항목 하나)

**Out of scope**:

- 설정 메뉴의 묶음과 순서. Plan 010이 바꾼다.
- `pages/mcp.tsx`, `pages/agents.tsx`, `pages/permission.tsx`의 본문. 받는 `project` prop의
  모양은 그대로다. 살아 있는 객체를 받게 될 뿐이다.
- 사이드바(`navigation/sidebar.tsx`). Plan 005가 바꾼다.
- 서버 코드 전부.

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 `git add <path>`로 올린다.
- 단계마다 commit한다. 각 commit은 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `fix(settings): 설정 창이 프로젝트 목록에서 지금 값을 읽는다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 창이 프로젝트 id를 받고 목록에서 읽는다

`settings-dialog.tsx`:

- `SettingsPage` 타입을 `export`한다.
- `SettingsOverlay`의 `project: ListedProject | null` prop을 `projectId: string | null`로 바꾼다.
- 창 안에서 고른 프로젝트를 state로 둔다. 목록은 쿼리에서 읽는다.

```tsx
const projects = useProjectsQuery().data ?? [];
const [chosenId, setChosenId] = useState(projectId);
const project = projects.find((item) => item.id === chosenId) ?? null;
```

- `useProjectsQuery`는 `../queries/global`에서 가져온다.
- 아래쪽의 `project` 쓰임(`MissingFolderAlert`, `SettingsPageBody`)은 이 `project`를 그대로 쓴다.
- `ListedProject` import가 더는 쓰이지 않으면 지운다.

`open-settings.tsx`:

```tsx
export function openSettingsOverlay({
  projectId,
  initialPage,
}: {
  readonly projectId: string | null;
  readonly initialPage?: SettingsPage;
}) {
```

- `SettingsPage`는 `./settings-dialog`에서 `import type`으로 가져온다.
- `initialPage`의 기본값은 `SettingsOverlay` 쪽(`"web"`)에만 둔다. 여기서는 그대로 넘긴다.
- 주석을 고친다: "Opens the settings on a project; the dialog reads it from the project list."

`index.tsx:418-419`:

```tsx
const openSettings = () => openSettingsOverlay({ projectId });
```

**Verify**: `vp run agent#typecheck` → exit 0.
`rg -n "openSettingsOverlay\(" apps/agent/app` → 호출 한 곳, `{ projectId }`를 넘긴다.

### Step 2: 창 안에서 대상 프로젝트를 고른다

`settings-dialog.tsx`의 `DialogHeader` 다음, `MissingFolderAlert` 앞에 줄 하나를 둔다. 목록에
프로젝트가 하나 이상일 때만 그린다.

- 왼쪽에 라벨 "프로젝트"(`<FieldLabel htmlFor="settings-project">`, `~/components/ui/field`),
  오른쪽에 `Select`. `items`는 `projects.map((item) => ({ value: item.id, label: item.name }))`.
- `value={chosenId}`, `onValueChange={(value) => setChosenId(value)}`.
- `SelectTrigger`에 `id="settings-project"`와 `className="w-56"`, `SelectValue`의 placeholder는
  "프로젝트 고르기"(comment: "Placeholder of the settings dialog's project picker").
- 줄 아래에 설명 한 줄(`FieldDescription`): "MCP 서버, 외부 에이전트, 권한, Skills, 보호 브랜치는
  여기서 고른 프로젝트의 설정입니다."
- 감싸는 요소는 `<div className="flex items-center gap-3">`처럼 배치 클래스만 가진 일반 `div`다.

`shared.tsx`의 `NoProject` 문구를 바꾼다: "위에서 프로젝트를 고르면 그 프로젝트의 설정이 보입니다."

`pages/kanban.tsx:355`의 문구를 바꾼다: "보호 브랜치는 프로젝트마다 정합니다. 위에서 프로젝트를
골라 주십시오."

**Verify**: `vp run agent#typecheck` → exit 0. `vp run agent#i18n:extract` 뒤
`vp run agent#i18n:check` → exit 0. `rg -n "사이드바에서 프로젝트를 고르면" apps/agent/app` → 결과 없음.

### Step 3: skill 고르기 모델은 프로젝트 없이도 보인다

`pages/skills.tsx`의 `SkillSettings`에서 프로젝트가 없는 분기에 `SkillRouterField`를 넣는다.

```tsx
if (!(project !== null))
  return (
    <FieldGroup>
      <PageHeader title={t(pageTitles.skills)} description={t(description)} />
      <SkillRouterField />
      <NoProject />
    </FieldGroup>
  );
```

`SkillSettingsContent` 안의 `<SkillRouterField />`는 그대로 둔다.

**Verify**: `vp run agent#typecheck` → exit 0.

### Step 4: 회귀 테스트

`apps/agent/app/entry/settings/settings-dialog.test.tsx`를 만든다. jsdom 준비와 렌더는
`apps/agent/app/entry/navigation/sidebar-collapse.test.tsx`(1–150행)를 본보기로 한다: 같은 방식으로
jsdom 전역을 설치하고, `createRoot`와 `act`로 그리고, `I18nProvider`로 감싼다. 쿼리는
`QueryClientProvider`로 감싸고 `new QueryClient({ defaultOptions: { queries: { retry: false } } })`를
쓴다. 서버 호출은 `apps/agent/app/entry/queries/mutations/global.test.tsx:65-70`처럼
`vi.spyOn(api, "<이름>")`로 대신한다. 모듈 전체를 mock하지 않는다(lint
`anti-slop/no-module-mocking`).

테스트 하나만 쓴다:

- 프로젝트 목록 쿼리(`globalQueries.projects().queryKey`)에 `permissionMode: "ask"`인 프로젝트
  하나를 `client.setQueryData`로 넣는다.
- `<PermissionSettings project={...} />`가 아니라 **`SettingsOverlay`를 `projectId`와
  `initialPage="permission"`으로** 그린다.
- 같은 쿼리 키에 `permissionMode: "auto"`로 바꾼 목록을 `act` 안에서 `setQueryData`한다.
- 권한 `Select`의 trigger(`#project-permission-mode`)가 이제 auto의 라벨("자동 판단"을 담은
  글자)을 보인다고 단언한다. 정확한 라벨은 `pages/permission.tsx:40-46`의
  `permissionModeLabels`에서 읽는다.

이 테스트는 Step 1 전의 코드에서는 실패한다(창이 옛 객체를 든다). 그것이 이 테스트의 목적이다.

**Verify**: `cd apps/agent && vp test --run app/entry/settings/settings-dialog.test.tsx` → 1 passed.

### Step 5: 문서

- `apps/agent/app/entry/settings/README.md`: `openSettingsOverlay`가 `projectId`와 `initialPage`를
  받는다는 것, 창이 프로젝트 목록 쿼리에서 프로젝트를 읽고 안에서 바꿀 수 있다는 것.
- `docs/decisions.md` 끝에 항목 하나(한국어, 제목에 날짜). 계기(권한을 바꿔도 옛 값이 남던 것,
  다른 프로젝트 설정을 보려면 창을 닫아야 하던 것), 결정(창은 id만 받는다, 목록 쿼리에서 읽는다,
  창 안의 선택 상자로 대상을 바꾼다, skill 고르기 모델은 프로젝트 없이 보인다). 만들어 낸
  용어를 쓰지 않는다.

**Verify**: `vp check` → exit 0. `node lint/wording/check/main.ts check` → exit 0.

## Test plan

- 새 테스트 하나: `settings-dialog.test.tsx`의 "권한 모드가 바뀐 프로젝트 목록을 따라간다".
- 타입으로 잡히는 것(prop 이름, `initialPage`의 범위)은 테스트하지 않는다.

## Done criteria

- [ ] 저장소 루트에서 `vp run agent#typecheck`, `vp check`, `vp run agent#i18n:check` 모두 exit 0
- [ ] `cd apps/agent && vp test --run app/entry/settings/settings-dialog.test.tsx` exits 0
- [ ] `rg -n "project: ListedProject \| null" apps/agent/app/entry/settings/open-settings.tsx apps/agent/app/entry/settings/settings-dialog.tsx` → 결과 없음
- [ ] `rg -n "initialPage\?: \"web\"" apps/agent/app` → 결과 없음
- [ ] `git status --short`에 In scope 밖의 수정이 없다 (다른 세션의 수정은 건드리지 않는다)
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다.
- `openSettingsOverlay`의 호출부가 `index.tsx` 말고 더 있다.
- overlay 안에서 `useProjectsQuery`가 `QueryClientProvider`를 찾지 못한다(`root.tsx`의 감싸는
  순서가 바뀌었다).
- jsdom에서 `SettingsOverlay`를 그릴 수 없어 테스트가 `Dialog`의 portal 때문에 값을 찾지 못한다.
  두 번 시도해도 안 되면 멈추고, 시도한 방법과 오류를 보고한다. 단언을 느슨하게 바꾸지 않는다.
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- Plan 005가 프로젝트 헤더의 메뉴에서 `openSettingsOverlay({ projectId, initialPage: "permission" })`로
  이 창을 연다. `initialPage`의 타입을 다시 좁히지 않는다.
- Plan 010이 메뉴 묶음을 바꾸고 기본 첫 페이지를 바꾼다. 이 계획이 넣은 프로젝트 선택 줄은
  그때 "프로젝트" 묶음의 페이지에서만 보이게 옮길 수 있다.
- 리뷰에서 볼 곳: 창이 프로젝트 객체를 state나 prop으로 붙들지 않는가. 붙드는 것은 id뿐이어야 한다.
