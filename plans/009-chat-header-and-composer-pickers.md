# Plan 009: 채팅에 헤더를 두고, 입력창 아래줄에서 모델·추론·권한을 고른다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- apps/agent/app/entry/chat/chat-composer.tsx apps/agent/app/entry/chat/chat-panel.tsx apps/agent/app/entry/chat/btw-panel.tsx apps/agent/app/entry/chat/work-trace-panel.tsx apps/agent/app/entry/settings/model-selection-field.tsx apps/agent/app/entry/settings/pages/permission.tsx apps/agent/app/entry/navigation/account-model-panel.tsx`
> 출력이 있으면 "Current state"의 발췌와 실제 코드를 견준다. 다르면 STOP이다. `index.tsx`와
> `navigation/sidebar.tsx`는 Plan 004·005·006·007이 바꿨다. 그 차이는 예상된 것이다.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/008-conversation-keeps-its-model.md, plans/005-sidebar-project-header-actions.md
- **Category**: direction
- **Planned at**: commit `d65cc285`, 2026-11-14

## Why this matters

지금 채팅 화면에는 어떤 모델과 권한으로 보내는지가 보이지 않는다. 모델과 추론 강도는 사이드바
맨 위의 접힌 패널을 펴야 나온다. 권한 모드는 설정 창의 권한 페이지에 있다. 입력창 아래줄에는
이미지 버튼, 상태 글자, Chat/Goal/Plan 선택, 중지, 전송뿐이다.

채팅 화면에는 헤더도 없다. 대화 제목은 사이드바에서만 보인다. BTW와 Work Trace를 여는 버튼은
화면 오른쪽 위에 떠 있고(`fixed`), Work Trace 버튼에는 이름이 보이지 않는다.

Plan 008이 대화마다 모델을 저장하게 했다. 이 계획은 그것을 화면에 올린다.

- 입력창 아래줄에서 이 대화의 모델과 추론 강도를 고른다. 고르면 이 대화에만 저장된다.
- 같은 줄에서 프로젝트의 권한 모드를 고른다.
- 채팅 위에 헤더를 둔다: 대화 제목, 프로젝트 이름, BTW와 Work Trace 버튼.
- 사이드바 맨 위의 모델 패널을 없앤다. 새 대화의 기본 모델은 계정 관리 Sheet에서 고른다.

BTW는 기능을 그대로 둔다. 없앨지는 사용자가 아직 정하지 않았다. 이 계획은 버튼 자리만 옮긴다.

## Current state

### 관련 파일

- `apps/agent/app/entry/index.tsx` — 화면 뼈대. `selection`(앱의 기본 선택) state, `selectModel`,
  slash 명령의 `model`·`effort`, `SessionView` 조립, `AccountModelPanel` 조립, 계정 관리 `Sheet`,
  `BtwPanel`·`WorkTracePanel` 조립.
- `apps/agent/app/entry/chat/chat-panel.tsx` — `SessionView`(292–320행), `ChatPanel`, `DraftComposer`.
- `apps/agent/app/entry/chat/chat-composer.tsx` — `ChatComposer`. 아래줄은 308–438행.
- `apps/agent/app/entry/chat/btw-panel.tsx`, `chat/work-trace-panel.tsx` — 각자 떠 있는 버튼과 Sheet.
- `apps/agent/app/entry/settings/model-selection-field.tsx` — 출처 → 모델 → 추론을 고르는 폼.
  출처 목록을 만드는 코드가 여기 있다(92–107행).
- `apps/agent/app/entry/settings/pages/permission.tsx` — 권한 모드 `Select`와 전체 권한 확인 창.
- `apps/agent/app/entry/navigation/sidebar.tsx` — `ModelSection`(모델·추론 `Select` 두 개),
  `sessionLabel`(대화 제목 함수, `export` 없음).
- `apps/agent/app/entry/navigation/account-model-panel.tsx` — 사이드바 맨 위의 접히는 패널.
- `apps/agent/app/entry/queries/mutations/session.ts` — 대화 단위 mutation 훅.
- `apps/agent/app/entry/queries/global.ts` — `useCatalogQuery(target)`(117–118행): 한 출처의 모델 목록.
- `apps/agent/app/entry/api.ts` — Plan 008 뒤: `api.setSessionModel(session, holder, model)`,
  `Session.model: ModelSelection | null`.

### 발췌

`chat-composer.tsx:365-399` — 아래줄의 가운데. 선택기가 들어갈 자리는 `ToggleGroup` 다음이다:

```tsx
            <ComposerStatus mode={composerMode} />
            <ToggleGroup
              aria-label={t({
                message: "입력 방식",
                comment: "Accessible name of the Chat/Goal/Plan mode buttons in the composer",
              })}
              variant="outline"
              size="sm"
              spacing={0}
              value={[composerModeOf(run.workflow)]}
              /* ... */
            >
              {/* Chat / Goal / Plan */}
            </ToggleGroup>
            <div className="ml-auto flex items-center gap-3">
```

`chat-panel.tsx:292-320` — `SessionView`가 받는 값:

```tsx
export function SessionView({
  sessionId,
  imagesSupported,
  slash,
  sendingEnabled,
}: {
  sessionId: string;
  imagesSupported: boolean;
  slash: SlashSupport;
  sendingEnabled: boolean;
}) {
  const { holder, lease, refused, continueHere } = useSessionLease(sessionId);
  /* ... */
    <ChatPanel
      key={`${reading ? "read" : "write"}:sync:${syncRevision}`}
      sessionId={sessionId}
      holder={holder}
      /* ... */
      imagesSupported={imagesSupported}
      slash={slash}
      sendingEnabled={sendingEnabled}
    />
```

`index.tsx:563-578` — 대화가 열렸을 때의 본문. 이미지 가능 여부와 보내기 가능 여부를 앱의 기본
선택에서 계산한다:

```tsx
    .with({ projectId: P.string, sessionId: P.string }, ({ sessionId: id }) => (
      <SessionView
        key={id}
        sessionId={id}
        slash={slash}
        sendingEnabled={selectedSignedIn}
        imagesSupported={
          selection !== null &&
          sessions.find((session) => session.id === id)?.agent == null &&
          ((modelQueries[selection.provider].data?.models ?? [])
            .find((model) => model.id === selection.model)
            ?.capabilities.inputModalities.includes("image") ??
            false)
        }
      />
    ))
```

`index.tsx:535-539` — slash 명령이 앱의 기본 선택을 바꾼다:

```tsx
          model: ({ model }) => uiPromise(() => selectModel(model)),
          effort: ({ effort }) =>
            shownSelection === null
              ? Effect.void
              : uiPromise(() => selectModel(shownSelection.model, effort)),
```

`index.tsx:693-726`(계획 작성 때의 줄 번호) — 사이드바 맨 위의 패널:

```tsx
            <div className="min-h-0 shrink overflow-y-auto overscroll-contain">
              <AccountModelPanel
                provider={provider}
                auth={auth[provider]}
                selection={selection}
                modelName={/* ... */}
              >
                {signedIn ? (
                  <ModelSection
                    models={models}
                    selection={selection?.provider === provider ? selection : null}
                    busy={modelMutation.isPending}
                    error={modelError}
                    onSelect={(model, effort) => void selectModel(model, effort)}
                  />
                ) : (
                  /* 계정 연결 안내와 버튼 */
                )}
              </AccountModelPanel>
              {/* Plan 005 전에는 여기에 ProjectSection이 있었다 */}
            </div>
```

`index.tsx:813-835` — 계정 관리 Sheet. `ModelSection`이 옮겨 갈 곳:

```tsx
<Sheet open={accountsOpen} onOpenChange={setAccountsOpen}>
  <SheetContent side="left">
    <SheetHeader>{/* 제목 "계정 관리"와 설명 */}</SheetHeader>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <AccountManager /* ... */>
        <CompatibleAccounts activeProvider={selection?.provider ?? provider} />
      </AccountManager>
    </div>
  </SheetContent>
</Sheet>
```

`index.tsx:836-845` — 본문과 두 패널:

```tsx
<SidebarInset className="min-w-0">
  <SidebarReopen />
  {main}
</SidebarInset>;
{
  projectId && sessionId && selection && (
    <BtwPanel key={sessionId} projectId={projectId} sessionId={sessionId} />
  );
}
{
  projectId && sessionId && (
    <WorkTracePanel key={sessionId} projectId={projectId} sessionId={sessionId} />
  );
}
```

`index.tsx:131-139` — 사이드바가 접혔을 때 본문 왼쪽 위에 뜨는 버튼. 헤더와 겹친다:

```tsx
function SidebarReopen() {
  const { open, isMobile } = useSidebar();
  const { t } = useLingui();
  return open && !isMobile ? null : (
    <div className="absolute top-2 left-2 z-20">
      <SidebarTrigger aria-label={t`사이드바 펼치기`} title={t`사이드바 펼치기 (⌘B)`} />
    </div>
  );
}
```

`btw-panel.tsx:318-329`:

```tsx
{
  !open && (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="fixed top-3 right-12 z-30"
      aria-label={t`BTW 열기`}
      onClick={() => setOpen(true)}
    >
      <MessageCircleQuestionIcon /> BTW
    </Button>
  );
}
```

`work-trace-panel.tsx:375-386`:

```tsx
{
  !open && (
    <Button
      type="button"
      size="icon-sm"
      variant="outline"
      className="fixed top-3 right-3 z-30"
      aria-label={t`Work Trace 열기`}
      onClick={() => setOpen(true)}
    >
      <PanelRightOpenIcon />
    </Button>
  );
}
```

`model-selection-field.tsx:26-38,92-107` — 출처를 다루는 코드:

```tsx
const sourceKey = (source: CatalogTarget) =>
  source.provider === "openai-compatible"
    ? `${source.provider}:${source.account}`
    : source.provider;

const sourceOf = (selection: ModelSelection): CatalogTarget =>
  selection.provider === "openai-compatible"
    ? { provider: selection.provider, account: selection.account }
    : { provider: selection.provider };
// ...
const sources: ReadonlyArray<{ readonly source: CatalogTarget; readonly label: string }> = [
  ...subscriptionProviders.map((provider) => ({
    source: { provider },
    label: t(providerLabels[provider]),
  })),
  ...(compatible.data?.accounts ?? []).map((account) => ({
    source: { provider: "openai-compatible" as const, account: account.id },
    label: account.label,
  })),
];
```

같은 파일 159–163행 — 모델을 고르면 그 모델의 기본 추론 단계를 함께 잡는다:

```tsx
              onValueChange={(value) => {
                const next = models.find((candidate) => candidate.id === value);
                setModelId(next?.id ?? null);
                setEffort(next?.defaultReasoningEffort ?? null);
              }}
```

`settings/pages/permission.tsx:66-170` — `PermissionSettingsContent`. mutation
(`usePermissionModeMutation(project.id)`), `setMode`, `Select`(106–133행), 전체 권한 확인
`AlertDialog`(135–167행)가 한 컴포넌트에 있다. 권한 라벨은 같은 파일 41–45행의
`permissionModeLabels`다("매번 묻기", "자동 판단 (auto)", "전체 권한 (full)").

`queries/mutations/session.ts:287-303` — holder를 받는 대화 mutation 훅의 본보기
(`useCompactSessionMutation`). 새 훅은 이 모양을 따른다.

### 정해 둔 동작

- 이 대화가 쓸 모델 = 대화의 자기 모델(`session.model`), 없으면 앱의 기본 선택. 아래에서 "지금
  모델"이라 부른다.
- 아래줄의 모델 선택기는 지금 모델을 보이고, 바꾸면 `api.setSessionModel`로 **이 대화에만**
  저장한다. 앱의 기본 선택은 건드리지 않는다.
- `/model`과 `/effort`도 이 대화의 모델을 바꾼다. `/model`의 목록은 지금 모델의 출처(공급자,
  호환이면 그 엔드포인트 계정)의 모델들이다.
- 외부 에이전트와 직접 하는 대화(`session.agent`가 있음)에는 모델 선택기를 그리지 않는다.
- 권한 모드는 프로젝트의 값이다(`project.permissionMode`). 아래줄의 선택기는 설정의 권한 페이지와
  같은 값을 같은 방식으로 바꾼다(전체 권한은 확인 창을 거친다).
- 앱의 기본 선택(새 대화의 시작값)은 계정 관리 Sheet 안의 "새 대화의 기본 모델"에서 바꾼다.
  지금의 `ModelSection`을 그대로 옮긴다.

### 따라야 할 규칙

- UI는 `~/components/ui/*`의 shadcn 컴포넌트로만 만든다. 필요한 것은 이미 있다: `Popover`
  (`components/ui/popover.tsx`, 쓰임은 `chat/background-task-panel.tsx`), `Select`, `Button`,
  `PromptInputButton`, `Tooltip`, `AlertDialog`. 새 shadcn 컴포넌트가 필요해지면 STOP이다.
- 화면 문구는 Lingui 매크로로 쓴다. 한국어 합니다체. 아이콘만 있는 버튼에는 `aria-label`과
  `title`을 준다.
- 서버 호출은 `runUiEffect(Effect.gen(...))`과 `uiPromise`로 감싼다(`index.tsx`의 `selectModel`이
  본보기다).
- shadcn 컴포넌트의 `className`에는 배치 클래스만 준다. 일반 요소(`div`, `header`)에는 색과
  글자 class를 줄 수 있다.
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
| 채팅 jsdom 테스트 | `cd apps/agent && vp test --run app/entry/chat`                                      | all pass            |
| 설정 테스트       | `cd apps/agent && vp test --run app/entry/settings`                                  | all pass            |

- 브라우저 테스트(`chat/btw-panel.browser.tsx`, `chat/chat-panel.browser.tsx`,
  `navigation/sidebar.browser.tsx`)는 샌드박스에서 뜨지 않을 수 있다. typecheck로 확인하고 실행은
  운영자에게 맡긴다.
- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**

## Scope

**In scope**:

- `apps/agent/app/entry/index.tsx`
- `apps/agent/app/entry/chat/chat-composer.tsx`, `chat/chat-panel.tsx`
- `apps/agent/app/entry/chat/chat-header.tsx` (새 파일)
- `apps/agent/app/entry/chat/model-picker.tsx` (새 파일)
- `apps/agent/app/entry/chat/btw-panel.tsx`, `chat/work-trace-panel.tsx` (버튼의 class와 `title`만)
- `apps/agent/app/entry/settings/model-selection-field.tsx` (출처 코드를 내보낸다)
- `apps/agent/app/entry/settings/pages/permission.tsx`, `settings/permission-mode-select.tsx` (새 파일)
- `apps/agent/app/entry/queries/mutations/session.ts` (훅 하나)
- `apps/agent/app/entry/navigation/sidebar.tsx` (`sessionLabel`을 `export`, `ModelSection`의 제목 문구)
- `apps/agent/app/entry/navigation/account-model-panel.tsx` (쓰임이 없으면 지운다)
- 위 파일들의 브라우저 테스트(`*.browser.tsx`)에서 바뀐 prop과 지운 컴포넌트를 맞추는 수정
- `apps/agent/app/locales/ko.po` (추출 명령이 고친다)
- `apps/agent/app/entry/chat/README.md`, `navigation/README.md`, `apps/agent/README.md`("화면" 절),
  `docs/decisions.md`(끝에 항목 하나)

**Out of scope**:

- 서버와 `api.ts`. Plan 008이 끝냈다.
- BTW의 기능, Work Trace의 내용. 버튼 자리만 옮긴다.
- 입력창 위에 쌓이는 줄들(워크플로 바, 대기열, 알림). 따로 다룰 일이다.
- slash 명령의 목록과 이름(`/mode` 등). 따로 다룰 일이다.
- 사이드바 아래의 `AccountSwitcher`와 계정 전환의 동작.
- 설정 메뉴의 묶음. Plan 010이 바꾼다.
- 칸반 역할 모델, skill 고르기 모델의 폼(`ModelSelectionField`의 겉모양).

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `feat(chat): 입력창 아래줄에서 이 대화의 모델을 고른다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 대화의 모델을 바꾸는 훅

`queries/mutations/session.ts`에 `useCompactSessionMutation`(287–303행)과 같은 모양으로 더한다.

- 이름 `useSessionModelMutation`, 인자 `(projectId, sessionId, holder)`. 이웃 훅이 dual 형태면
  같은 형태로 쓴다.
- `mutationFn: (model: ModelSelection | null) => api.setSessionModel(sessionId, holder, model)`.
  `holder`가 이웃 훅에서 함수인지 문자열인지 보고 같은 것을 쓴다.
- `onSuccess`: 그 프로젝트의 대화 목록(`projectQueries.sessions(projectId).queryKey`)과 그 대화의
  실행 상태(`sessionQueries.runState(...)`의 키)를 무효화한다. 컨텍스트 창 크기가 모델을 따른다.

**Verify**: `vp run agent#typecheck` → exit 0.

### Step 2: 출처 코드를 내보낸다

`settings/model-selection-field.tsx`:

- `sourceKey`, `sourceOf`를 `export`한다.
- 92–107행의 `sources`와 `sourceLabel`을 훅으로 뺀다. 같은 파일에 둔다.

```tsx
/** Where a model can come from: each subscription provider and each compatible endpoint. */
export function useModelSources() {
  const { t } = useLingui();
  const compatible = useCompatibleAccountsQuery();
  const sources: ReadonlyArray<{ readonly source: CatalogTarget; readonly label: string }> = [
    /* 지금의 두 map 그대로 */
  ];
  const sourceLabel = (target: CatalogTarget) =>
    sources.find((candidate) => sourceKey(candidate.source) === sourceKey(target))?.label ??
    t(providerLabels[target.provider]);
  return { sources, sourceLabel };
}
```

- `ModelSelectionField`는 이 훅을 쓴다. 겉모양과 동작은 바뀌지 않는다.

**Verify**: `vp run agent#typecheck` → exit 0. `cd apps/agent && vp test --run app/entry/settings` → all pass.

### Step 3: 권한 선택을 따로 떼어 낸다

`settings/permission-mode-select.tsx`를 만든다. `pages/permission.tsx`의
`PermissionSettingsContent`에서 mutation, `setMode`, `Select`, 확인 `AlertDialog`,
`permissionModeLabels`·`permissionModes`를 옮긴다.

```tsx
export function PermissionModeSelect({
  project,
  id,
  size,
  onError,
}: {
  readonly project: Project;
  /** The trigger's id, for a label. */
  readonly id?: string;
  /** The trigger's size; the composer uses the small one. */
  readonly size?: "sm" | "default";
  /** Why the change was refused. */
  readonly onError: (message: string | null) => void;
}) {
```

- `Select`의 `value`는 `project.permissionMode`, trigger의 `aria-label`은 지금 그대로 "권한 모드".
- `pages/permission.tsx`는 `Field` 안에서 `<PermissionModeSelect project={project} id="project-permission-mode" onError={setError} />`를
  그리고, 자기 `error` state와 `PageError`는 그대로 둔다.
- `SelectTrigger`의 너비 class(`w-36`)는 설정 페이지에서만 필요하다. `size`가 `"sm"`일 때는 너비를
  주지 않는다.

**Verify**: `vp run agent#typecheck` → exit 0. `cd apps/agent && vp test --run app/entry/settings` → all pass
(Plan 004의 `settings-dialog.test.tsx`가 `#project-permission-mode`를 찾는다. 계속 통과해야 한다).

### Step 4: 모델 선택기

`chat/model-picker.tsx`를 만든다.

```tsx
/**
 * The conversation's model: its own, or the app's selected one until it has one. Choosing here
 * saves the model on this conversation only.
 */
export function SessionModelPicker({
  projectId,
  sessionId,
  holder,
  model,
  disabled,
}: {
  readonly projectId: string;
  readonly sessionId: string;
  readonly holder: string;
  /** The model the conversation runs on now; null when the app has none selected either. */
  readonly model: ModelSelection | null;
  readonly disabled: boolean;
}) {
```

- 트리거: `Popover`의 trigger로 `PromptInputButton variant="ghost"`. 안의 글자는
  `모델 표시 이름 · 추론 라벨`이다. 표시 이름은 지금 모델의 출처 목록(`useCatalogQuery(sourceOf(model))`)에서
  찾고, 없으면 `model.model`을 쓴다. 추론 라벨은 `effortChoices(model, found)`에서 지금 단계의
  `label`을 찾고, 선택지가 없으면 붙이지 않는다. `model`이 `null`이면 "모델 고르기"를 보인다.
  `aria-label`은 "이 대화의 모델"(comment: "Composer button that opens this conversation's model picker").
- Popover 안: `Select` 세 개를 세로로 둔다. `ModelSelectionField`의 세 `Select`와 같은 구성이다.
  - 출처: `useModelSources()`의 `sources`. state `source`(처음 값은 `model`의 출처). 바꾸면 모델과
    추론을 비우고 **저장하지 않는다**.
  - 모델: `useCatalogQuery(source)`의 목록. 고르면 바로 저장한다:
    `{ ...source, model: next.id, reasoningEffort: next.defaultReasoningEffort }`.
  - 추론: `effortChoices`가 준 것이 있을 때만. 고르면 바로 저장한다(지금 모델에 단계만 바꾼 것).
- 저장: `useSessionModelMutation(projectId, sessionId, holder)`의 `mutateAsync`를 `runUiEffect`로
  부른다. 실패하면 Popover 안 아래에 `text-destructive` 한 줄:
  "모델을 바꾸지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주십시오."
- 목록 읽기가 실패하면(`catalog.isError`) `ModelSelectionField`와 같은 문구를 보인다:
  "모델 목록을 읽지 못했습니다. 그 제공자에 로그인했는지 확인해 주십시오."
- `disabled`이거나 저장 중이면 세 `Select`가 `disabled`다.

**Verify**: `vp run agent#typecheck` → exit 0.

### Step 5: 아래줄에 자리를 만든다

`chat/chat-composer.tsx`:

- `ChatComposer`에 prop 하나를 더한다.

```tsx
  /** Pickers the page puts on the footer, after the mode buttons: model and permission. */
  controls?: React.ReactNode;
```

- 398행의 `</ToggleGroup>` 다음, `<div className="ml-auto …">` 앞에 `{controls}`를 그린다.

`chat/chat-panel.tsx`:

- `DraftComposer`가 `ChatComposer`의 prop을 어떻게 넘기는지 확인한다(280행 근처). 나머지 prop을
  펼쳐 넘기면 고칠 것이 없다. 하나씩 넘기면 `controls`를 더한다.
- `ChatPanel`과 `SessionView`에 `composerControls?: React.ReactNode`를 더하고 `DraftComposer`의
  `controls`로 넘긴다.

**Verify**: `vp run agent#typecheck` → exit 0. `cd apps/agent && vp test --run app/entry/chat` → all pass.

### Step 6: 채팅 헤더

`btw-panel.tsx`와 `work-trace-panel.tsx`의 버튼에서 `className="fixed top-3 right-12 z-30"`와
`className="fixed top-3 right-3 z-30"`를 지운다. Work Trace 버튼에 `title={t\`Work Trace 열기\`}`를
더한다. 그 밖은 건드리지 않는다.

`navigation/sidebar.tsx`의 `sessionLabel`을 `export`한다.

`chat/chat-header.tsx`를 만든다.

```tsx
/** The open conversation's name and project, with the panels that open beside it. */
export function ChatHeader({
  title,
  projectName,
  children,
}: {
  readonly title: string;
  readonly projectName: string | null;
  /** The buttons at the header's end: BTW and Work Trace. */
  readonly children: React.ReactNode;
}) {
  const { open, isMobile } = useSidebar();
  return (
    <header
      className={cn(
        "flex h-11 shrink-0 items-center gap-2 border-b px-4",
        // The button that reopens a folded sidebar sits over the header's start.
        (!open || isMobile) && "pl-12",
      )}
    >
      <h2 className="min-w-0 truncate text-sm font-medium">{title}</h2>
      {projectName !== null && (
        <span className="shrink-0 truncate text-xs text-muted-foreground">{projectName}</span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">{children}</div>
    </header>
  );
}
```

- `useSidebar`는 `~/components/ui/sidebar`, `cn`은 `~/lib/utils`다.

`index.tsx`:

- 열린 대화를 찾는다. Plan 005 뒤의 그룹 목록에서 찾는다(보관된 것도 URL로 열릴 수 있다).

```tsx
const openSession =
  groups
    .flatMap((group) => [...group.sessions, ...group.archived])
    .find((session) => session.id === sessionId) ?? null;
const hydrated = useHydrated();
```

`useHydrated`는 `./shared/use-hydrated`다.

- 대화가 열린 갈래(563–578행)를 헤더와 본문의 세로 묶음으로 바꾼다.

```tsx
<div className="flex h-full min-h-0 flex-col">
  <ChatHeader
    title={openSession === null ? t`제목 없는 대화` : sessionLabel(hydrated)(openSession)}
    projectName={projects.find((item) => item.id === projectId)?.name ?? null}
  >
    {selection && <BtwPanel key={id} projectId={projectId} sessionId={id} />}
    <WorkTracePanel key={id} projectId={projectId} sessionId={id} />
  </ChatHeader>
  <div className="min-h-0 flex-1">
    <SessionView /* ... */ />
  </div>
</div>
```

이 갈래 안에서 `projectId`는 문자열이다(`P.string`으로 걸렀다). 패턴에서 `projectId`도 꺼낸다.

- 840–845행의 두 패널 조립을 지운다.
- `SidebarReopen`은 그대로 둔다.

**Verify**: `vp run agent#typecheck` → exit 0.
`rg -n "fixed top-3" apps/agent/app/entry/chat` → 결과 없음.

### Step 7: 대화의 모델을 화면에 잇는다

`index.tsx`:

- 지금 모델: `const sessionSelection = openSession?.model ?? selection;`
- 그 출처의 모델 목록: `const sessionCatalog = useCatalogQuery(sessionSelection === null ? null : sourceOf(sessionSelection));`
  (`sourceOf`는 `./settings/model-selection-field`).
- 훅: `const sessionModelMutation = useSessionModelMutation(projectId ?? "", sessionId ?? "", pageHolder);`
  (`holder`의 모양은 Step 1에서 정한 대로).
- `SessionView`에 넘기는 값을 지금 모델로 계산한다.
  - `sendingEnabled`: `sessionSelection !== null && signedInAuth(auth[sessionSelection.provider])`.
  - `imagesSupported`: `openSession?.agent`가 없고, `sessionCatalog.data?.models`에서
    `sessionSelection.model`을 찾아 `capabilities.inputModalities.includes("image")`.
  - `composerControls`:

```tsx
        composerControls={
          <>
            {openSession !== null && openSession.agent === null && (
              <SessionModelPicker
                projectId={projectId}
                sessionId={id}
                holder={pageHolder()}
                model={sessionSelection}
                disabled={false}
              />
            )}
            {openProject !== undefined && (
              <PermissionModeSelect project={openProject} size="sm" onError={setModelError} />
            )}
          </>
        }
```

    `openProject`는 `projects.find((item) => item.id === projectId)`다. `setModelError`가 받은 문구를
    보일 곳이 없어지면(아래에서 사이드바 패널을 지운다) 대신 `setArchiveError`를 넘긴다. 목록 위의
    알림 자리다.

- slash 명령:
  - `slash.context.models`: `sessionCatalog.data?.models`를 `{ id, label: displayName }`으로.
  - `slash.context.efforts`: 지금의 `slashEfforts` 계산에서 `shownSelection`·`shownModel` 대신
    `sessionSelection`과 `sessionCatalog`에서 찾은 모델을 쓴다.
  - `model`: 지금 모델의 출처에 그 모델을 얹어 저장한다. 추론 단계는 그 모델의 기본값이다.
    `sessionSelection`이 없거나 모델을 못 찾으면 아무것도 하지 않는다.
  - `effort`: `sessionSelection`에 `reasoningEffort`만 바꿔 저장한다.
  - 둘 다 `uiPromise(() => sessionModelMutation.mutateAsync(next))`를 쓴다.
- 사이드바 맨 위의 `AccountModelPanel` 조립(위 발췌)과 그 바깥 `div`, 그 뒤의 `SidebarSeparator`
  하나를 지운다. 헤더 다음에 구분선이 두 줄 겹치지 않게 한다.
- 계정 관리 Sheet의 `AccountManager` 위에 `ModelSection`을 둔다. `signedIn`일 때만 그린다. 넘기는
  값은 지금 그대로다(`models`, `selection`, `busy`, `error`, `onSelect`).
- `navigation/sidebar.tsx`의 `ModelSection`에서 `Section`의 `title`을 "새 대화의 기본 모델"로 바꾸고
  (comment: "Section in the account sheet: the model new conversations start with"), 그 제목을
  화면에도 보이게 `Section` 위에 `<h3 className="px-4 pt-3 text-xs font-medium">`으로 그린다.
- `navigation/account-model-panel.tsx`의 쓰임을 확인한다: `rg -n "account-model-panel" apps/agent/app`.
  남은 쓰임이 테스트뿐이면 파일과 그 테스트를 지운다. 다른 소스가 `accountSummary`를 쓰면 파일을
  두고 `AccountModelPanel`만 지운다.

**Verify**: `vp run agent#typecheck` → exit 0.
`rg -n "AccountModelPanel" apps/agent/app --glob '!*.md'` → 결과 없음.
`rg -n "selectModel\(" apps/agent/app/entry/index.tsx` → 정의와 `ModelSection`의 `onSelect` 쓰임만 남는다.

### Step 8: 브라우저 테스트, 문구, 문서

- `rg -n "AccountModelPanel|fixed top-3|ModelSection" apps/agent/app --glob '*.browser.tsx'`로 고칠
  브라우저 테스트를 찾고 prop과 구조를 맞춘다. `ModelSection`을 그리는 테스트는 제목이 바뀐 것만
  맞춘다.
- `vp run agent#i18n:extract` → `vp run agent#i18n:check`, `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`.
- `apps/agent/app/entry/chat/README.md`: `ChatHeader`, `SessionModelPicker`, `ChatComposer`의 `controls`.
- `apps/agent/app/entry/navigation/README.md`: 모델 패널이 없어지고 `ModelSection`이 계정 관리
  Sheet에 있다는 것.
- `apps/agent/README.md`의 "화면" 절: 사이드바 줄에서 "모델과 추론 강도"를 빼고, 대화 줄에
  헤더와 아래줄의 선택기를 적는다. Slash 명령 줄에 `/model`·`/effort`가 이 대화의 모델을 바꾼다는 것.
- `docs/decisions.md` 끝에 항목 하나. 계기(채팅 화면에서 모델과 권한이 보이지 않던 것, 떠 있는
  버튼), 결정("정해 둔 동작"의 여섯 항목과 헤더의 구성), 대체하는 결정("사이드바 하단 계정
  전환기 (2026-10-12)"의 "위쪽 패널은 모델 설정만 둔다", "프로필·프로젝트 사이드바 접힘과 계정
  관리 (2026-10-12)"의 접힌 프로필 표시), 그대로인 것(BTW의 기능 — 없앨지는 미정, 계정 전환기).

**Verify**: `vp check` → exit 0. 세 문구 명령 모두 exit 0.

## Test plan

- 새 자동 테스트를 더하지 않는다. 선택기의 동작은 Base UI `Select`와 `Popover`를 눌러야 확인되고,
  그것은 브라우저 테스트의 일이다. 샌드박스에서 브라우저 테스트를 띄울 수 없다.
- 기존 테스트가 계속 통과해야 한다: `app/entry/chat`, `app/entry/settings`.
- 운영자가 확인할 것(dev를 다시 시작한 뒤):
  1. 대화 A에서 아래줄의 모델을 바꾼다. 대화 B를 연다. B의 모델은 그대로다.
  2. A로 돌아온다. 바꾼 모델이 보인다. 메시지를 보내면 그 모델로 답한다.
  3. 새 대화를 만든다. 계정 관리 Sheet의 "새 대화의 기본 모델"과 같은 모델로 시작한다.
  4. 아래줄의 권한을 "전체 권한"으로 바꾸면 확인 창이 뜬다.
  5. 사이드바를 접어도 헤더의 제목이 펼치기 버튼에 가리지 않는다.
  6. BTW와 Work Trace가 헤더의 버튼으로 열린다.

## Done criteria

- [ ] 저장소 루트에서 `vp run agent#typecheck`, `vp check`, `vp run agent#i18n:check` 모두 exit 0
- [ ] `cd apps/agent && vp test --run app/entry/chat app/entry/settings` exits 0
- [ ] `rg -n "AccountModelPanel" apps/agent/app --glob '!*.md'` → 결과 없음
- [ ] `rg -n "fixed top-3" apps/agent/app/entry/chat` → 결과 없음
- [ ] `rg -n "SessionModelPicker|ChatHeader|PermissionModeSelect" apps/agent/app/entry/index.tsx` → 셋 모두 쓰인다
- [ ] `git status --short`에 In scope 밖의 수정이 없다
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다(`index.tsx`와 `sidebar.tsx`의 앞선 계획 변경은 예외).
- Plan 008이 들어가지 않았다(`api.setSessionModel`이 없거나 `Session`에 `model`이 없다).
- Plan 005가 들어가지 않았다(`index.tsx`에 `ProjectSection`이 남아 있다).
- `PromptInputFooter` 안에 `Popover`나 `Select`를 두면 `shadcn/*` lint가 거부하고 배치 클래스만으로
  풀리지 않는다. lint 끄기 주석을 쓰지 말고 멈춘다.
- 입력창 `form`(`chat-composer.tsx:194-202`)의 `onKeyDown`이나 `Command` 감싸기 때문에 Popover 안의
  `Select`가 키보드로 열리지 않거나 Enter가 메시지를 보낸다. 고치려면 그 `form`의 키 처리를 바꿔야
  한다. 멈추고 증상을 보고한다.
- `BtwPanel`이나 `WorkTracePanel`을 헤더 안으로 옮기자 Sheet가 헤더의 높이에 갇힌다(portal로
  나가지 않는다).
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- 잃는 것: 사이드바 맨 위에서 늘 보이던 "공급자 / 모델"과 연결 오류 아이콘. 지금 계정은 사이드바
  아래의 계정 전환기가 보인다. 연결 오류를 거기에 표시하는 일은 이 계획에 넣지 않았다.
- 자기 모델이 없는 옛 대화는 선택기에 앱의 기본 선택을 보인다. 거기서 한 번 고르면 그 대화에
  저장된다.
- 계정 전환기에서 계정을 바꾸면 앱의 기본 선택이 바뀐다. 자기 모델을 가진 대화는 바뀌지 않는다.
  그 대화의 공급자에서 로그아웃했으면 `sendingEnabled`가 꺼지고, 선택기에서 다른 모델을 고르면
  다시 보낼 수 있다.
- BTW를 없애기로 정해지면 헤더의 `BtwPanel` 한 줄과 `chat/btw-panel.tsx`, `use-btw-thread.ts`,
  서버의 `btw` API를 함께 지운다. 따로 계획한다.
- 리뷰에서 볼 곳: 아래줄의 선택이 앱의 기본 선택을 바꾸지 않는가. `/model`이 다른 출처의 모델을
  섞지 않는가. 좁은 화면에서 아래줄이 두 줄로 넘치지 않는가.
