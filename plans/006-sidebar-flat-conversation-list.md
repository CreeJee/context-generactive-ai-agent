# Plan 006: 프로젝트 그룹 안을 한 목록으로 펴고, 최근 대화만 먼저 보인다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- apps/agent/app/entry/navigation/sidebar.tsx`
> Plan 005가 이 파일의 헤더 줄, `SessionSection`의 prop, `ProjectSection` 삭제를 바꾼 것은 예상된
> 차이다. `ProjectSessionGroup`의 `CollapsibleContent` 안쪽(아래 발췌)이 다르면 STOP이다.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/005-sidebar-project-header-actions.md
- **Category**: tech-debt
- **Planned at**: commit `d65cc285`, 2026-11-14

## Why this matters

프로젝트 그룹을 펼치면 그 안이 다시 세 구역("진행 중", "대화", "보관함")으로 나뉘고, 구역마다
접히는 머리줄이 있다. 프로젝트 → 구역 → 대화의 세 단이다.

- 진행 중인 대화가 없는 것이 보통인데, 펼친 그룹마다 "진행 중 0"과 "진행 중인 대화가 없습니다"가
  두 줄을 차지한다.
- 행 수에 제한이 없다. 로컬 DB의 수치(2026-11-14): 한 프로젝트에 보관하지 않은 대화가 230개,
  그다음이 105개, 54개다. 그 그룹을 펼치면 아래 프로젝트들이 화면 밖으로 밀린다.

이 계획 뒤에는 그룹 안이 한 목록이다. 진행 중인 대화가 맨 위에 오고(회전 표시는 그대로),
나머지가 최근 순으로 이어진다. 처음에는 8개까지만 보이고 "더 보기"로 나머지를 편다. 보관함은
목록 끝의 접히는 한 줄로 남는다.

## Current state

### 관련 파일

- `apps/agent/app/entry/navigation/sidebar.tsx` — `ProjectSessionGroup`(본문), `SessionGroup`(구역 머리줄).
- `apps/agent/app/entry/navigation/sidebar-collapse.test.tsx` — jsdom 테스트.
- `apps/agent/app/entry/navigation/sidebar.browser.tsx` — 브라우저 테스트.
- `docs/decisions.md` — "사이드바 대화 목록: 진행 중인 대화를 맨 위에, 보관함은 아래 칸으로
  (2026-11-02)"가 지금의 세 구역을 정했다. 이 계획이 그 일부를 대체한다.

### 발췌

`sidebar.tsx`의 `ProjectSessionGroup` 본문(계획 작성 때 714–722, 842–921행. Plan 005 뒤에는 줄
번호가 다르다. `rg -n "진행 중인 대화가 없습니다" apps/agent/app/entry/navigation/sidebar.tsx`로 찾는다):

```tsx
const places = [
  ...new Set(group.sessions.flatMap((session) => sessionPlace(session) ?? [])),
].toSorted();
const filter = placeFilterOf(placeValue, places);
const shown = group.sessions.filter(shownIn(filter));
// `filter` builds `shown` either way; counting through it again reads clearer than another pass.
const leading = shown.filter((session) => atWork(session, working));
const rest = shown.filter((session) => !atWork(session, working));
```

```tsx
              <SessionGroup
                title={t({
                  message: "진행 중",
                  comment: "Conversation list section: conversations answering or running a board",
                })}
                count={leading.length}
                defaultOpen
              >
                {leading.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    <Trans>진행 중인 대화가 없습니다.</Trans>
                  </p>
                ) : (
                  <SidebarMenu>{leading.map(row)}</SidebarMenu>
                )}
              </SessionGroup>
              <SessionGroup
                title={t({
                  message: "대화",
                  comment: "Conversation list section: the conversations not at work",
                })}
                count={rest.length}
                defaultOpen
              >
                {rest.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    <Trans>다른 대화가 없습니다.</Trans>
                  </p>
                ) : (
                  <SidebarMenu>{rest.map(row)}</SidebarMenu>
                )}
              </SessionGroup>
              {group.archived.length > 0 && (
                <SessionGroup
                  title={t({
                    message: "보관함",
                    comment: "Conversation list section: archived conversations",
                  })}
                  count={group.archived.length}
                >
                  {/* 보관된 행: 누르면 복원·원본 삭제 메뉴 */}
                </SessionGroup>
              )}
```

`SessionGroup`(같은 파일) — 구역 머리줄. `sticky top-8 z-10`으로 프로젝트 헤더 아래에 붙는다:

```tsx
function SessionGroup({ title, count, defaultOpen = false, children }: { /* ... */ }) {
  // ...
    <SidebarGroup>
      <Collapsible defaultOpen={defaultOpen}>
        <CollapsibleTrigger className="group sticky top-8 z-10 flex h-8 w-full items-center gap-1 rounded-md bg-sidebar px-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring">
```

행을 그리는 `row`는 `SessionSection`이 만들어 그룹에 넘긴다. 열린 대화의 행은
`isActive={session.id === sessionId && session.projectId === projectId}`다. 진행 중인 행은 제목
오른쪽에 `Spinner`가 붙는다. 이 둘은 바꾸지 않는다.

### 그대로 두는 것

- 작업 위치 필터(행 위의 `DropdownMenu`). `places.length > 0`일 때만 보이는 지금 그대로다.
- 그룹 헤더의 진행 중 배지와 접혔을 때의 대화 수.
- 보관된 행의 복원·원본 삭제 메뉴.
- `row`의 내용(제목, worktree 배지, 에이전트 배지, 회전 표시, `…` 메뉴).

### 따라야 할 규칙

- UI는 `~/components/ui/*`의 shadcn 컴포넌트로만 만든다. 새 컴포넌트를 들이지 않는다.
- 화면 문구는 Lingui 매크로로 쓴다. 한국어 합니다체.
- shadcn 컴포넌트의 `className`에는 배치 클래스만 준다.
- `let`, `while`, lint 끄기 주석, 값을 숨겨 두는 `useRef`를 쓰지 않는다. 배열은
  `filter`/`slice`로 다룬다. 같은 배열을 두 번 훑어 새 배열을 만들면 `allocation/*` lint 경고가
  날 수 있다. 경고가 나면 지금 코드처럼 주석으로 까닭을 적는 것이 아니라 한 번에 나누는
  `Array.partition`(`effect`의 `Array`, 이 파일이 이미 import한다)을 쓴다.
- 줄바꿈을 손으로 맞추지 않는다.

## Commands you will need

| Purpose           | Command                                                                              | Expected on success |
| ----------------- | ------------------------------------------------------------------------------------ | ------------------- |
| agent typecheck   | 저장소 루트에서 `vp run agent#typecheck`                                             | exit 0              |
| 포맷·lint         | 저장소 루트에서 `vp check`                                                           | exit 0              |
| 문구 catalog 갱신 | 저장소 루트에서 `vp run agent#i18n:extract`                                          | `ko.po`가 바뀐다    |
| 문구 catalog 검사 | 저장소 루트에서 `vp run agent#i18n:check`                                            | exit 0              |
| 문구 내용 검사    | 저장소 루트에서 `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po` | exit 0              |
| jsdom 테스트      | `cd apps/agent && vp test --run app/entry/navigation/sidebar-collapse.test.tsx`      | all pass            |

- 브라우저 테스트는 샌드박스에서 뜨지 않을 수 있다. 고친 뒤 typecheck로 확인하고 실행은
  운영자에게 맡긴다: `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/navigation/sidebar.browser.tsx`.
- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**

## Scope

**In scope**:

- `apps/agent/app/entry/navigation/sidebar.tsx` (`ProjectSessionGroup`의 본문과 `SessionGroup`)
- `apps/agent/app/entry/navigation/sidebar-collapse.test.tsx`
- `apps/agent/app/entry/navigation/sidebar.browser.tsx`
- `apps/agent/app/locales/ko.po` (추출 명령이 고친다)
- `apps/agent/app/entry/navigation/README.md`, `apps/agent/README.md`("화면" 절), `docs/decisions.md`(끝에 항목 하나)

**Out of scope**:

- `index.tsx`와 `queries/project.ts`. 읽는 데이터는 그대로다.
- 서버의 대화 목록 API. 쪽 나눔을 넣지 않는다(아래 Maintenance notes).
- 작업 위치 필터의 모양.
- 그룹 헤더(Plan 005가 정했다).

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `feat(sidebar): 프로젝트 그룹 안을 한 목록으로 편다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 한 목록과 "더 보기"

`ProjectSessionGroup`에서:

- 파일 위쪽에 상수를 둔다.

```tsx
/** How many conversations a project's group lists before "show more". */
const firstRows = 8;
```

- 순서: `leading`(진행 중) 다음에 `rest`. 둘을 이은 것이 `ordered`다.
- 그룹마다 펼침 state 하나: `const [expanded, setExpanded] = useState(false);`. 브라우저에
  저장하지 않는다. 새로 열면 다시 8개다.
- 보일 행을 정한다. 진행 중인 대화와 지금 열린 대화는 8개 밖이어도 늘 보인다.

```tsx
const head = ordered.slice(0, firstRows);
const tail = ordered.slice(firstRows);
// The open conversation and those at work never hide behind "show more".
const kept = tail.filter((session) => atWork(session, working) || isOpenSession(session));
const hidden = tail.length - kept.length;
const rows = expanded ? ordered : [...head, ...kept];
```

`isOpenSession`은 그 대화가 지금 열려 있는지다. `ProjectSessionGroup`은 지금 `sessionId`를 받지
않으므로 prop `openSessionId: string | null`을 더하고, `SessionSection`이 `selected`일 때만
`sessionId`를, 아니면 `null`을 넘긴다.

- 두 `SessionGroup`("진행 중", "대화")과 그 빈 문구 두 개를 지우고, 한 목록을 그린다.

```tsx
<SidebarMenu>{rows.map(row)}</SidebarMenu>;
{
  !expanded && hidden > 0 && (
    <Button
      variant="ghost-muted"
      size="sm"
      className="mx-2 justify-start"
      onClick={() => setExpanded(true)}
    >
      <Trans comment="Button that lists the rest of a project's conversations; {hidden} is how many more">
        {hidden}개 더 보기
      </Trans>
    </Button>
  );
}
{
  expanded && tail.length > 0 && (
    <Button
      variant="ghost-muted"
      size="sm"
      className="mx-2 justify-start"
      onClick={() => setExpanded(false)}
    >
      <Trans comment="Button that folds a project's conversation list back to its first rows">
        접기
      </Trans>
    </Button>
  );
}
```

- 작업 위치 필터로 `shown`이 비었을 때의 문구("이 작업 위치의 대화가 없습니다.")는 그대로 둔다.
- 보관함 `SessionGroup`은 그대로 목록 끝에 둔다.

**Verify**: `vp run agent#typecheck` → exit 0.
`rg -n "진행 중인 대화가 없습니다|다른 대화가 없습니다" apps/agent/app/entry/navigation/sidebar.tsx` → 결과 없음.

### Step 2: `SessionGroup`을 보관함 전용으로 줄인다

`SessionGroup`의 쓰임이 보관함 하나만 남는다. `defaultOpen` prop과 그 기본값을 지우고
(`<Collapsible>`은 닫힌 채 시작한다), 함수 위 주석을 사실에 맞게 고친다: 이 머리줄은 프로젝트의
보관된 대화 구역이고, 프로젝트 헤더 아래(`top-8`)에 붙는다. 이름은 그대로 둔다.

Plan 005가 `ArchivedProjects`를 같은 머리줄 class로 만들었다면 건드리지 않는다.

**Verify**: `vp run agent#typecheck` → exit 0. `rg -n "defaultOpen" apps/agent/app/entry/navigation/sidebar.tsx` → 결과 없음.

### Step 3: 테스트

`sidebar-collapse.test.tsx`:

- "a conversation at work leads its group with a spinner, and the header badges the count"가 "진행 중"
  머리줄을 찾고 있으면, 대신 행 링크의 순서로 단언한다: 그 그룹의 첫 행 링크가 진행 중인 대화의
  것이다.
- 테스트를 더한다: "그룹은 처음 8개만 보이고 더 보기로 나머지를 편다". 대화 10개인 그룹을 펼친
  채 그리고, 행 링크가 8개이며 "2개 더 보기" 버튼이 있다고 단언한다. 누른 뒤 10개다.
- 테스트를 더한다: "열린 대화는 8개 밖이어도 보인다". 대화 10개 중 마지막 것을 `sessionId`로
  넘기고, 행 링크가 9개이며 그 대화의 링크가 있다고 단언한다.

`sidebar.browser.tsx`:

- "the project header stays pinned above the section headings"(계획 작성 때 673행)는 안쪽 머리줄로
  "진행 중"이나 "대화"를 쓰고 있으면 "보관함"으로 바꾼다(보관된 대화가 하나 있는 그룹으로).
- "a conversation at work leads its group and shows its spinner"(860행)는 위 jsdom 테스트와 같은
  방식으로 순서를 단언하게 고친다.
- 이 파일의 테스트 3개는 이 계획을 시작하기 전부터 실패한다(2026-11-15, Plan 005 검토 때 확인.
  13개 중 10개 통과). 이 실패는 STOP이 아니다. 이 Step에서 아래처럼 찾는 방법만 고친다. 단언의
  대상과 기대값은 바꾸지 않는다. 그룹 헤더는 이 파일의 `headerName(name)`으로 찾는다(Plan 005가
  둔 도우미. 헤더의 `+` 버튼 이름도 프로젝트 이름으로 시작해서 필요하다).
  1. "each listed project is a collapsible group with its own conversations":
     `screen.getByText("대화 1개")`는 찾지 못한다. "대화 1개"는 숫자 `span`의 `aria-label`이다.
     `screen.getByLabelText("대화 1개")`로 바꾼다.
  2. "a group keeps its fold across a fresh render": 두 번째 `render`의 `again.getByRole(...)`이
     버튼 둘을 잡는다. 첫 render가 문서에 남아 있어서다. 두 번째 `render` 앞에서 첫 render를
     내린다(`yield* sdkCall(() => screen.unmount())`). 이 테스트는 `localStorage`에 적힌 접힘을 새
     render가 읽는지를 보므로 뜻이 그대로다. 이 테스트에는 Plan 018이 둔 `storedFolds()` 단언 둘이
     있다. 지금까지 한 번도 실행되지 않았으므로, 통과하는지 보고에 적는다.
  3. "archiving and deleting name the conversation's own project":
     `screen.getByRole("listitem", { name: /알파 대화/u })`는 찾지 못한다. 목록 항목은 내용으로
     이름이 정해지지 않는다. `row`를 없애고 `screen.getByRole("button", { name: "알파 대화 메뉴" })`를
     바로 누른다. 같은 테스트 뒤쪽에 같은 모양이 있으면 같은 방식으로 고친다.
     고친 뒤 브라우저가 뜨면 파일 전체를 돌려 통과 수와 실패한 테스트 이름을 보고에 적는다. 위
     방법으로도 실패하는 테스트는 더 고치지 않고 실패 메시지를 보고에 적는다.
- Plan 005가 "choosing an archived project releases it…" 브라우저 테스트를 지웠다(`ProjectSection`이
  없어졌다). 대신할 테스트를 `sidebar-collapse.test.tsx`에 하나 더한다: "an archived project is
  released from its row". `ArchivedProjects`를 보관된 프로젝트 하나(`name: "Gamma"`)와
  `onRestore`(부른 id를 배열에 모으는 함수)로 그린다. 머리줄 "보관된 프로젝트"를 눌러 펼치고,
  `aria-label`이 "Gamma 보관 해제"인 버튼을 누른 뒤, 모은 id가 `["gamma"]`라고 단언한다. 이 파일의
  `renderSection`·`click` 도우미가 `SessionSection` 전용이면, 같은 방식의 작은 도우미를 더한다.

**Verify**: `cd apps/agent && vp test --run app/entry/navigation/sidebar-collapse.test.tsx` → all pass,
새 테스트 2개 포함. `vp run agent#typecheck` → exit 0.

### Step 4: 문구와 문서

- `vp run agent#i18n:extract` → `vp run agent#i18n:check`, `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`.
- `apps/agent/app/entry/navigation/README.md`: 그룹 안의 구성(한 목록, 8개, 더 보기, 보관함).
- `apps/agent/README.md`의 "화면" 절에 대화 목록 줄이 세 구역을 말하고 있으면 고친다.
- `docs/decisions.md` 끝에 항목 하나. 계기(펼친 그룹마다 "진행 중 0"이 두 줄, 한 그룹에 230개),
  결정(한 목록, 진행 중 먼저, 처음 8개와 더 보기, 진행 중과 열린 대화는 늘 보임, 펼침은 저장하지
  않음, 보관함은 목록 끝의 접히는 줄), 대체하는 결정("사이드바 대화 목록: 진행 중인 대화를 맨
  위에, 보관함은 아래 칸으로 (2026-11-02)"의 "세 섹션은 같은 급이다"와 "비어 있어도 섹션은 남아"),
  유지하는 것(회전 표시, 헤더 배지, sticky 헤더).

**Verify**: `vp check` → exit 0. 세 문구 명령 모두 exit 0.

## Test plan

- `sidebar-collapse.test.tsx`에 2개를 더하고 1개를 고친다(Step 3).
- 브라우저 테스트는 고치되 실행은 운영자 환경에서 한다.

## Done criteria

- [ ] 저장소 루트에서 `vp run agent#typecheck`, `vp check`, `vp run agent#i18n:check` 모두 exit 0
- [ ] `cd apps/agent && vp test --run app/entry/navigation/sidebar-collapse.test.tsx` exits 0, 새 테스트 2개 포함
- [ ] `rg -n "진행 중인 대화가 없습니다|다른 대화가 없습니다" apps/agent/app --glob '!*.po'` → 결과 없음
- [ ] `rg -n "firstRows" apps/agent/app/entry/navigation/sidebar.tsx` → 정의 하나와 쓰임
- [ ] `git status --short`에 In scope 밖의 수정이 없다
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- `ProjectSessionGroup`의 본문이 위 발췌와 다르다(Plan 005의 헤더 줄 변경은 예외).
- Plan 005가 아직 들어가지 않았다(`ProjectSection`이 `sidebar.tsx`에 남아 있다).
- `allocation/*` lint가 `Array.partition`으로도 사라지지 않는다. lint 끄기 주석을 쓰지 말고 멈춘다.
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- 서버는 여전히 프로젝트의 모든 대화를 한 번에 준다(`GET /api/sessions?project=`). 화면에서 8개만
  그릴 뿐이다. 프로젝트 19개 × 대화 수백 개를 읽는 비용은 그대로다. 목록 API에 쪽 나눔을 넣는
  일은 이 계획의 범위가 아니다. 넣게 되면 "더 보기"가 다음 쪽을 읽게 바꾼다.
- 8이라는 수는 근거가 약하다. 화면 높이 900px에서 프로젝트 3–4개가 한 화면에 들어오게 고른
  값이다. 바꿀 때는 `firstRows` 한 곳만 고친다.
- 리뷰에서 볼 곳: 진행 중인 대화가 "더 보기" 뒤에 숨지 않는가. 열린 대화의 행이 늘 보이는가.
