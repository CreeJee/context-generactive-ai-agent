# Plan 016: 칸반 보드를 화면을 덮는 Sheet가 아니라 본문 영역에 둔다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- apps/agent/app/entry/index.tsx apps/agent/app/entry/chat/board/project-board.tsx apps/agent/app/entry/chat/board-panel.tsx apps/agent/app/entry/chat/board/kanban-board.tsx apps/agent/app/entry/chat/chat-panel.tsx`
> 차이가 많이 나온다. 모두 예상된 것이다(아래 "앞선 계획이 바꾼 것"). 이 계획은 행 번호가 아니라
> 발췌의 글자로 자리를 찾는다. 발췌의 글자가 실제 코드에 없으면 STOP이다.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/015-card-panel-beside-board.md, plans/010-settings-menu-regroup.md
  (010은 `index.tsx`를 마지막으로 고치는 앞선 계획이다. 005·009·010이 모두 끝난 뒤에 한다)
- **Category**: usability
- **Planned at**: commit `d65cc285`, 2026-11-15

## Why this matters

칸반 보드는 두 가지다. 한 대화의 보드(세션 보드, URL `?board=1&card=…`)와 프로젝트의 모든 실행
중인 Plan을 모은 보드(프로젝트 보드, URL `?boards=1&boardCard=…`). 둘 다 화면 전체를 덮는
Sheet(모달 Dialog)로 열린다. 그래서 보드를 연 동안:

- 사이드바가 가려진다. 다른 대화로 가려면 보드를 닫아야 한다.
- 채팅 쪽의 패널(Work Trace 등)을 함께 볼 수 없다.
- 보드가 "잠깐 띄운 창"처럼 다뤄진다. 칸반으로 실행하는 동안에는 보드가 주된 화면이다.

사용자가 2026-11-15에 보드를 본문 영역의 보기로 두기로 정했다. "칸반 보드 화면 (2026-10-18)"의
"보드는 전체 폭 Sheet로 연다"를 바꾼다.

이 계획 뒤에는:

- 보드는 사이드바 오른쪽의 본문 영역에 그려진다. 사이드바는 그대로 보이고 쓸 수 있다.
- 보드가 열린 동안 대화 화면은 숨겨질 뿐 살아 있다. 대화의 lease, 실행, 쓰던 글이 유지된다.
- 보드는 머리줄의 "보드 닫기" 버튼이나 브라우저의 뒤로 가기로 닫는다.
- Esc는 열린 카드 패널만 닫는다. 보드는 닫지 않는다.
- URL은 그대로다(`board`, `card`, `boards`, `boardCard`).

## Current state

### 앞선 계획이 바꾼 것

- Plan 005·009·010: `index.tsx`의 사이드바, `main`, 설정 조립이 바뀌었다. 이 계획이 고치는 곳은
  `<SidebarInset>` 블록, 그 아래의 `<ProjectBoard>` 블록, `useQueryStates(locationParsers)`의 구조
  분해뿐이다.
- Plan 009: `chat-panel.tsx`에 채팅 헤더가 생겼다. 이 계획이 고치는 곳은 `<OpenBoardButton …>`을
  쓰는 한 곳뿐이다.
- Plan 012·014: 두 보드의 머리줄에 배지, "카드 추가", `GoalMergeStatus`가 더해졌다.
- Plan 015: 카드 패널이 `BoardSurface` 안의 `aside`다. 두 보드의 `onOpenChange`가 Esc를 세
  갈래(집은 카드, 열린 패널, 보드 닫기)로 나눈다.

### 관련 파일

- `apps/agent/app/entry/index.tsx` — `App`. URL을 읽고 `<SidebarInset>`에 `main`을 그리고, 그 아래에
  `<ProjectBoard>`를 그린다.
- `apps/agent/app/entry/chat/board/project-board.tsx` — `ProjectBoard`.
- `apps/agent/app/entry/chat/board-panel.tsx` — `OpenBoardButton`(버튼과 `BoardSheet`를 함께 그린다),
  `BoardSheet`, `useBoardLocation`.
- `apps/agent/app/entry/chat/chat-panel.tsx` — `OpenBoardButton`을 쓰는 곳.
- `apps/agent/app/entry/chat/board/kanban-board.tsx` — 키보드로 카드를 옮길 때의 화살표 키 처리.
- `apps/agent/app/entry/chat/board/project-board.browser.tsx` — 브라우저 테스트.

### 발췌

`index.tsx`(d65cc285의 190–193행) — URL 읽기:

```tsx
const [
  { project: projectId, session: sessionId, boards: boardsOpen, boardCard: boardCardKeyParam },
  setLocation,
] = useQueryStates(locationParsers);
```

`index.tsx`(d65cc285의 107–118행) — `locationParsers`에는 `card`와 `board`도 이미 있다:

```tsx
const locationParsers = {
  project: parseAsString,
  session: parseAsString,
  /** A board card the inbox opened; the session's board opens on it. */
  card: parseAsString,
  /** The session's board, opened from the project board's lane. */
  board: parseAsBoolean,
  /** The project board: every conversation's board as a lane, opened from the sidebar. */
  boards: parseAsBoolean,
  /** A card the project board peeks, as `sessionId:cardId`. */
  boardCard: parseAsString,
};
```

`index.tsx`(d65cc285의 130–139행) — 사이드바를 다시 펴는 버튼:

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

`index.tsx`(d65cc285의 836–865행) — 본문과 프로젝트 보드:

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
{
  projectId && (boardsOpen === true || boardCardKeyParam !== null) && (
    <ProjectBoard
      projectId={projectId}
      holder={pageHolder()}
      peek={boardCardKeyParam === null ? null : parseBoardCardKey(boardCardKeyParam)}
      onPeek={(card) =>
        void setLocation({
          boards: true,
          boardCard: card === null ? null : boardCardKey(card),
        })
      }
      onOpenSession={(session) =>
        void setLocation(
          { ...leaveProjectBoard, session, board: true, card: null },
          { history: "push" },
        )
      }
      onClose={() => void setLocation({ boards: null, boardCard: null })}
    />
  );
}
```

Plan 009가 `BtwPanel` 줄을 바꿨을 수 있다. 그 줄은 건드리지 않는다.

`board-panel.tsx` — `OpenBoardButton`(d65cc285의 204–246행):

```tsx
export function OpenBoardButton({
  projectId,
  sessionId,
  holder,
  disabled,
}: {
  readonly projectId: string;
  readonly sessionId: string;
  readonly holder: string;
  readonly disabled: boolean;
}) {
  const view = useBoardQuery(projectId, sessionId).data;
  const decisions = useDecisionsQuery(projectId, sessionId).data ?? [];
  const kanban = useKanbanQuery(projectId, sessionId);
  const kanbanAction = useKanbanMutation(projectId, sessionId, holder);
  const { location, setLocation, openBoard } = useBoardLocation();
  if (!isTruthy(view) || view.plan === null) return null;
  const open = location.board === true || location.card !== null;
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => openBoard(location.card)}>
        <KanbanSquareIcon data-icon="inline-start" />
        <Trans comment="Button that opens the kanban board of the Plan">보드</Trans>
      </Button>
      {open && (
        <BoardSheet
          projectId={projectId}
          sessionId={sessionId}
          holder={holder}
          disabled={disabled}
          view={view}
          plan={view.plan}
          decisions={decisions}
          loop={kanban.data?.active === true ? kanban.data : null}
          kanbanAction={kanbanAction}
          peekCardId={location.card}
          onPeek={openBoard}
          onClose={() => void setLocation({ board: null, card: null })}
        />
      )}
    </>
  );
}
```

`board-panel.tsx` — `BoardSheet`의 뼈대(d65cc285의 410–691행. 안의 내용은 Plan 012·014·015가 조금
바꿨다):

```tsx
/** The wide board over the page, with the card peek panel and the board's notices. */
function BoardSheet({ projectId, sessionId, holder, disabled, view, plan, decisions, loop,
  kanbanAction, peekCardId, onPeek, onClose }: { /* ... */ }) {
  /* state와 계산 */
  return (
    <Sheet open onOpenChange={/* Plan 015의 세 갈래 Esc 처리 */}>
      <SheetContent className="w-full sm:max-w-none">
        <SheetHeader>
          <SheetTitle>
            <Trans>칸반 보드</Trans>
          </SheetTitle>
          <SheetDescription>
            <span className="flex flex-wrap items-center gap-2">{/* 배지와 완료 수 */}</span>
          </SheetDescription>
          <Collapsible defaultOpen={/* ... */}>{/* 버튼 줄, Plan 닫기 Dialog, 접이식 내용 */}</Collapsible>
        </SheetHeader>
        <BoardSurface /* ... */ className="min-h-0 flex-1 pt-3" />
      </SheetContent>
    </Sheet>
  );
}
```

`project-board.tsx` — `ProjectBoard`의 뼈대(d65cc285의 129–338행):

```tsx
  return (
    <Sheet open onOpenChange={/* Plan 015의 세 갈래 Esc 처리 */}>
      <SheetContent className="w-full sm:max-w-none">
        <SheetHeader>
          <SheetTitle>
            <Trans>프로젝트 칸반 보드</Trans>
          </SheetTitle>
          <SheetDescription>
            {/* 주석 */}
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1">{/* 수 넷 */}</span>
          </SheetDescription>
          {waiting.length > 0 && <p role="status" /* 실행 중이 아닌 Plan */ />}
          <Collapsible /* ... */>{/* 필터, 카드 추가, 상태 패널 */}</Collapsible>
          {/* Drawn on the title row beside the sheet's close button … */}
          {rows.length > 0 && (
            <span className="absolute top-2 right-9">
              <BoardShortcuts />
            </span>
          )}
        </SheetHeader>
        {/* 불러오는 중, 불러오지 못함, 실행 중인 Plan 없음 */}
        {rows.length > 0 && <BoardSurface /* ... */ className="min-h-0 flex-1 pt-3" />}
      </SheetContent>
    </Sheet>
  );
```

`chat-panel.tsx`(d65cc285의 1130–1137행) — 버튼을 쓰는 곳:

```tsx
            boardAction={
              <OpenBoardButton
                projectId={projectId}
                sessionId={sessionId}
                holder={holder}
                disabled={readOnly || backendRestartRequired}
              />
            }
```

`kanban-board.tsx`(d65cc285의 270–281행) — 집은 카드의 화살표 키:

```tsx
  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (activeKey !== null) {
      // The board sits in a dialog, whose popup keeps arrow keys from reaching the document where
      // dnd-kit's keyboard sensor listens. Hand them over so a picked-up card moves.
      if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        event.currentTarget.ownerDocument.dispatchEvent(
          new KeyboardEvent("keydown", { key: event.key, code: event.code, bubbles: true }),
        );
      }
      return;
    }
```

`components/ui/sidebar.tsx:415-424` — 본문 영역:

```tsx
function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        "relative flex w-full flex-1 flex-col bg-background …",
```

### 알아 둘 것

- 대화 화면(`SessionView`, `chat-panel.tsx:292`)은 마운트돼 있는 동안 그 대화의 lease를 쥔다
  (`useSessionLease`). 그래서 보드가 열려도 대화 화면을 언마운트하지 않고 숨기기만 한다.
- 세션 보드의 `disabled`는 지금 채팅이 넘긴다(`readOnly || backendRestartRequired`. `readOnly`는 이
  페이지가 lease를 쥐지 못했다는 뜻이다). 보드를 `App`이 그리면 이 값을 받을 길이 없다. 그래서
  세션 보드도 프로젝트 보드처럼 `disabled={false}`로 그리고, 서버의 거절에 맡긴다. 다른 창이 그
  대화를 쓰고 있으면 서버가 423 `session_in_use`로 거절하고, 보드는 "다른 창에서 이 대화를 쓰고
  있습니다."를 알림으로 보인다(`board-surface.tsx`의 `errorText`). 프로젝트 보드가 이미 이렇게 한다.
- 보드의 요청에 쓰는 `holder`는 `pageHolder()`다. 대화 화면이 lease에 쓰는 값과 같다
  (`session/session-lease.ts:36, 94`).
- 집은 카드의 화살표 키: 보드가 Dialog 안에 있을 때는 Dialog가 화살표 키를 문서까지 보내지 않아
  보드가 같은 키를 문서에 다시 보냈다. Dialog가 없어지면 원래 키가 문서까지 간다. 다시 보내는
  코드를 남기면 키 한 번에 카드가 두 칸 움직인다. 그래서 지운다.
- `BoardShortcuts`의 툴팁 문구 "Esc: 옮기기 취소"는 그대로 맞다.
- 단축키 버튼은 제목 줄의 닫기 버튼 옆에 두는 것이 기록된 결정이다(`docs/decisions.md:2094`).
  프로젝트 보드는 이미 그렇다. 세션 보드는 버튼 줄에 두고 있다. 이 계획이 세션 보드의 것도 제목
  줄로 옮긴다.
- 사이드바의 대화 링크는 `/?project=…&session=…`로 가는 링크다(d65cc285의
  `navigation/sidebar.tsx:1045`). 다른 query 값을 모두 버리므로, 보드를 연 채로 사이드바에서 대화를
  누르면 보드가 닫히고 그 대화가 열린다. 이 계획은 그 링크를 고치지 않는다.

### 따라야 할 규칙

- UI는 `apps/agent/app/components/ui/*`의 shadcn 컴포넌트로만 만든다. 새 컴포넌트를 들이지 않는다.
  shadcn 컴포넌트의 모양을 `className`으로 덮어쓰지 않는다(lint `shadcn/no-restyle`). `section`,
  `header`, `h2`, `div`의 class는 자유롭게 쓴다.
- 화면 문구는 Lingui 매크로로 쓴다. 한국어 합니다체. 짧은 문구에는 `comment`를 단다.
- `let`, `while`, lint 끄기 주석, `unknown` 타입, `useRef`를 쓰지 않는다.
- 줄바꿈을 손으로 맞추지 않는다. 포맷은 `vp check --fix`가 한다.
- 코드 주석은 영어로, 지금 코드가 왜 그런지만 적는다.

## Commands you will need

| Purpose           | Command                                                                                               | Expected on success |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------- |
| agent typecheck   | 저장소 루트에서 `vp run agent#typecheck`                                                              | exit 0              |
| 포맷·lint         | 저장소 루트에서 `vp check`                                                                            | exit 0              |
| 문구 catalog 갱신 | 저장소 루트에서 `vp run agent#i18n:extract`                                                           | `ko.po`가 바뀐다    |
| 문구 catalog 검사 | 저장소 루트에서 `vp run agent#i18n:check`                                                             | exit 0              |
| 문구 내용 검사    | 저장소 루트에서 `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`                  | exit 0              |
| 브라우저 테스트   | 저장소 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/` | all pass            |
| agent 단위 테스트 | `cd apps/agent && vp test --run app/entry/chat`                                                       | all pass            |

- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**
- 브라우저 테스트가 브라우저를 띄우지 못하는 환경이면 그 사실을 보고에 적고 넘어간다. STOP이
  아니다. 처음 실행에서 페이지가 다시 로드되며 실패하면 한 번 더 돌린다.

## Scope

**In scope**:

- `apps/agent/app/entry/chat/board/board-frame.tsx` (새 파일)
- `apps/agent/app/entry/chat/board/project-board.tsx`
- `apps/agent/app/entry/chat/board-panel.tsx`
- `apps/agent/app/entry/chat/board/kanban-board.tsx` (`moveFocus`의 화살표 키 블록만)
- `apps/agent/app/entry/chat/chat-panel.tsx` (`<OpenBoardButton …>`을 쓰는 한 곳만)
- `apps/agent/app/entry/index.tsx` (URL 구조 분해, `<SidebarInset>` 블록, `<ProjectBoard>` 블록, 작은
  컴포넌트 하나)
- `apps/agent/app/entry/chat/board/project-board.browser.tsx`
- `apps/agent/app/locales/ko.po` (추출 명령이 고친다)
- `apps/agent/app/entry/chat/board/README.md`, `apps/agent/app/entry/chat/README.md`, `docs/decisions.md`

**Out of scope**:

- URL의 값과 그것을 바꾸는 곳(`leaveProjectBoard`, `leaveProject`, 사이드바의 링크, 판단 대기 함).
- `BoardSurface`, `CardPeek`, 보드의 열과 카드.
- `WorkTracePanel`, `BtwPanel`. 지금처럼 Sheet로 뜬다.
- 서버.
- 사이드바에 "보드가 열려 있다"는 표시를 더하는 일.

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 typecheck와 `vp check`를 통과해야 한다. Step 2–4는 서로 물려
  있으므로 한 commit으로 묶어도 된다.
- 메시지는 한국어 conventional commit이다. 예: `feat(board): 칸반 보드를 본문 영역에 둔다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 보드의 틀 `BoardFrame`

`apps/agent/app/entry/chat/board/board-frame.tsx`를 만든다.

```tsx
import type { ReactNode } from "react";
import { Trans } from "@lingui/react/macro";
import { XIcon } from "lucide-react";
import { Button } from "../../../components/ui/button";

/**
 * A board in the page's main area: a title row with the board's tools and its close button, the
 * board's status below it, and the board itself filling the rest. It is not a dialog, so the
 * sidebar and the rest of the page stay usable beside it.
 */
export function BoardFrame({
  title,
  leading,
  tools,
  header,
  onEscape,
  onClose,
  children,
}: {
  readonly title: string;
  /** Drawn before the title; the page leaves room there for the button that reopens the sidebar. */
  readonly leading?: ReactNode;
  /** Drawn on the title row before the close button. */
  readonly tools?: ReactNode;
  /** The board's status and actions, under the title. */
  readonly header: ReactNode;
  /** Esc pressed inside the board; the board decides what it closes. */
  readonly onEscape: () => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex h-full min-h-0 flex-col gap-4 text-xs/relaxed"
      onKeyDown={(event) => {
        // A dialog or menu opened from the board is drawn elsewhere in the page; its Esc is its own.
        if (event.key !== "Escape") return;
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        onEscape();
      }}
    >
      <header className="flex flex-col gap-1 border-b p-4">
        <div className="flex items-center gap-2">
          {leading}
          <h2 className="font-heading text-sm font-medium">{title}</h2>
          <span className="ml-auto flex items-center gap-1">
            {tools}
            <Button type="button" size="sm" variant="outline" onClick={onClose}>
              <XIcon data-icon="inline-start" />
              <Trans comment="Button that closes the kanban board and shows the conversation again">
                보드 닫기
              </Trans>
            </Button>
          </span>
        </div>
        {header}
      </header>
      {children}
    </section>
  );
}
```

**Verify**: `vp run agent#typecheck` → exit 0.

### Step 2: `ProjectBoard`가 `BoardFrame`을 쓴다

`project-board.tsx`:

1. `../../../components/ui/sheet` import를 지우고 `import { BoardFrame } from "./board-frame";`,
   `import type { ReactNode } from "react";`를 더한다.
2. props에 더한다: `readonly leading?: ReactNode;`(주석:
   `/** Drawn before the title; see {@link BoardFrame}. */`). 구조 분해에도 더한다.
3. `return`의 바깥을 바꾼다. `SheetHeader` 안에 있던 것 가운데 `SheetTitle`과 맨 끝의
   `BoardShortcuts` `<span>`(그 위의 주석 포함)을 뺀 나머지가 `header`로 간다. `SheetHeader` 아래에
   있던 것(불러오는 중, 불러오지 못함, 실행 중인 Plan 없음, `BoardSurface`)이 `children`이다. 내용은
   고치지 않는다.

```tsx
return (
  <BoardFrame
    title={t`프로젝트 칸반 보드`}
    leading={leading}
    tools={rows.length > 0 ? <BoardShortcuts /> : null}
    onEscape={() => {
      // Esc closes the open card panel; a picked-up card's Esc is dnd-kit's own.
      if (dragging || (peek === null && adding === null)) return;
      setAdding(null);
      onPeek(null);
    }}
    onClose={onClose}
    header={
      <>
        <div className="text-xs/relaxed text-muted-foreground">
          {/* SheetDescription 안에 있던 주석과 <span className="flex flex-wrap …">수 넷</span> */}
        </div>
        {/* waiting.length > 0 && <p role="status" …> 블록 */}
        {/* <Collapsible …> 블록 */}
      </>
    }
  >
    {/* SheetHeader 아래에 있던 네 블록 */}
  </BoardFrame>
);
```

4. 함수 위 주석은 그대로 둔다(Sheet를 말하지 않는다).

**Verify**: `rg -n "Sheet" apps/agent/app/entry/chat/board/project-board.tsx` → 주석의
"wide sheet" 같은 낱말만 남거나 결과 없음. 컴포넌트 이름(`<Sheet`, `SheetContent` 등)은 없어야 한다.
남은 주석에서 "sheet"가 지금 코드와 맞지 않으면 "board"로 고친다.

### Step 3: 세션 보드를 `SessionBoard`로 내보낸다

`board-panel.tsx`:

1. `OpenBoardButton`을 버튼만 남긴다.

```tsx
/**
 * Opens the Plan's board in the page's main area (`?board=1`), at the card it last showed. The
 * page draws the board, so it opens whether or not the bar is unfolded.
 */
export function OpenBoardButton({
  projectId,
  sessionId,
}: {
  readonly projectId: string;
  readonly sessionId: string;
}) {
  const view = useBoardQuery(projectId, sessionId).data;
  const { location, openBoard } = useBoardLocation();
  if (!isTruthy(view) || view.plan === null) return null;
  return (
    <Button type="button" size="sm" variant="ghost" onClick={() => openBoard(location.card)}>
      <KanbanSquareIcon data-icon="inline-start" />
      <Trans comment="Button that opens the kanban board of the Plan">보드</Trans>
    </Button>
  );
}
```

2. `BoardSheet`의 이름을 `SessionBoardBody`로 바꾼다(비공개 그대로). props에서 `disabled`를 빼고
   함수 안 첫 줄 근처에 상수를 둔다.

```tsx
// The page cannot tell whether another window holds the conversation; the server refuses then
// and the board shows why, as the project board does.
const disabled = false;
```

props에 `readonly leading?: ReactNode;`를 더한다. 3. `SessionBoardBody`의 `return`을 Step 2와 같은 방식으로 바꾼다.

```tsx
return (
  <BoardFrame
    title={t`칸반 보드`}
    leading={leading}
    tools={<BoardShortcuts />}
    onEscape={() => {
      // Esc closes the open card panel; a picked-up card's Esc is dnd-kit's own.
      if (dragging || !(adding || (peekCardId !== null && !goalAsked))) return;
      setAdding(false);
      onPeek(null);
    }}
    onClose={onClose}
    header={
      <>
        <div className="text-xs/relaxed text-muted-foreground">
          {/* SheetDescription 안에 있던 <span className="flex flex-wrap items-center gap-2">…</span> */}
        </div>
        {/* <Collapsible …> 블록. 안의 <BoardShortcuts />는 지운다(위 tools로 옮겼다) */}
      </>
    }
  >
    {/* <BoardSurface … /> */}
  </BoardFrame>
);
```

함수 위 주석을 고친다: `/** The conversation's board in the page's main area, with its status and the board's notices. */`

4. `SessionBoardBody` 위에 내보내는 컴포넌트를 더한다. 읽기는 `OpenBoardButton`이 하던 그대로다.

```tsx
/**
 * The conversation's board as the page's main area shows it (`?board=1`, a card open beside it
 * with `?card=…`). It reads the board itself, so the page needs only the conversation.
 */
export function SessionBoard({
  projectId,
  sessionId,
  holder,
  peekCardId,
  leading,
  onPeek,
  onClose,
}: {
  readonly projectId: string;
  readonly sessionId: string;
  readonly holder: string;
  readonly peekCardId: string | null;
  readonly leading?: ReactNode;
  readonly onPeek: (cardId: string | null) => void;
  readonly onClose: () => void;
}) {
  const { t } = useLingui();
  const board = useBoardQuery(projectId, sessionId);
  const decisions = useDecisionsQuery(projectId, sessionId).data ?? [];
  const kanban = useKanbanQuery(projectId, sessionId);
  const kanbanAction = useKanbanMutation(projectId, sessionId, holder);
  const view = board.data;
  if (!isTruthy(view) || view.plan === null)
    return (
      <BoardFrame
        title={t`칸반 보드`}
        leading={leading}
        header={null}
        onEscape={() => {}}
        onClose={onClose}
      >
        {isTruthy(view) ? (
          <p className="px-4 text-muted-foreground">
            <Trans>이 대화에는 아직 Plan이 없습니다. Plan이 생기면 보드에 카드가 올라옵니다.</Trans>
          </p>
        ) : board.isError ? (
          <LoadFailed className="px-4" onRetry={() => void board.refetch()}>
            <Trans>보드를 불러오지 못했습니다.</Trans>
          </LoadFailed>
        ) : (
          <p className="px-4 text-muted-foreground">
            <Trans>보드를 불러오는 중입니다.</Trans>
          </p>
        )}
      </BoardFrame>
    );
  return (
    <SessionBoardBody
      projectId={projectId}
      sessionId={sessionId}
      holder={holder}
      view={view}
      plan={view.plan}
      decisions={decisions}
      loop={kanban.data?.active === true ? kanban.data : null}
      kanbanAction={kanbanAction}
      peekCardId={peekCardId}
      leading={leading}
      onPeek={onPeek}
      onClose={onClose}
    />
  );
}
```

5. import를 정리한다: `../../components/ui/sheet`를 지우고 `./board/board-frame`의 `BoardFrame`,
   `react`의 `type ReactNode`를 더한다. 쓰이지 않게 된 import는 `vp check`가 알려 준다.

`chat-panel.tsx`:

6. `<OpenBoardButton …>`에서 `holder`와 `disabled` 두 줄을 지운다.

**Verify**:

- `vp run agent#typecheck` → exit 0 (Step 4까지 끝낸 뒤에 통과해도 된다).
- `rg -n "<Sheet|SheetContent|BoardSheet" apps/agent/app/entry/chat/board-panel.tsx` → 결과 없음.

### Step 4: `App`이 보드를 본문 영역에 그린다

`index.tsx`:

1. URL 구조 분해에 두 값을 더한다.

```tsx
const [
  {
    project: projectId,
    session: sessionId,
    board: boardOpen,
    card: cardParam,
    boards: boardsOpen,
    boardCard: boardCardKeyParam,
  },
  setLocation,
] = useQueryStates(locationParsers);
```

2. `SidebarReopen` 다음에 작은 컴포넌트를 더한다.

```tsx
/** Room in a board's title row for the button that reopens the sidebar, while that button shows. */
function ReopenRoom() {
  const { open, isMobile } = useSidebar();
  return open && !isMobile ? null : <span aria-hidden className="w-8 shrink-0" />;
}
```

3. `main`을 만든 다음(`return` 앞)에 더한다.

```tsx
// One board per URL: the project board wins when both are named.
const projectBoardShown = boardsOpen === true || boardCardKeyParam !== null;
const sessionBoardShown = !projectBoardShown && (boardOpen === true || cardParam !== null);
```

4. `<SidebarInset>` 블록을 바꾸고, 그 아래의 `{projectId && (boardsOpen === true || …) && (<ProjectBoard … />)}`
   블록을 지운다(안으로 옮긴다). `ProjectBoard`의 `onPeek`, `onOpenSession`, `onClose`는 지금 것을
   그대로 옮긴다.

```tsx
          <SidebarInset className="min-w-0">
            <SidebarReopen />
            {/* The conversation stays mounted under an open board, so its lease, run and draft go on. */}
            <div
              className={
                projectId && (projectBoardShown || (sessionId && sessionBoardShown))
                  ? "hidden"
                  : "contents"
              }
            >
              {main}
            </div>
            {projectId && projectBoardShown && (
              <ProjectBoard
                projectId={projectId}
                holder={pageHolder()}
                leading={<ReopenRoom />}
                peek={boardCardKeyParam === null ? null : parseBoardCardKey(boardCardKeyParam)}
                onPeek={/* 지금 것 그대로 */}
                onOpenSession={/* 지금 것 그대로 */}
                onClose={() => void setLocation({ boards: null, boardCard: null })}
              />
            )}
            {projectId && sessionId && sessionBoardShown && (
              <SessionBoard
                key={sessionId}
                projectId={projectId}
                sessionId={sessionId}
                holder={pageHolder()}
                leading={<ReopenRoom />}
                peekCardId={cardParam}
                onPeek={(card) =>
                  void setLocation({ ...leaveProjectBoard, board: true, card })
                }
                onClose={() => void setLocation({ board: null, card: null })}
              />
            )}
          </SidebarInset>
```

5. import: `import { SessionBoard } from "./chat/board-panel";`.

**Verify**:

- `vp run agent#typecheck` → exit 0. `vp check` → exit 0.
- `rg -n "<ProjectBoard|<SessionBoard" apps/agent/app/entry/index.tsx` → 각각 한 줄, 둘 다
  `<SidebarInset` 줄과 `</SidebarInset>` 줄 사이에 있다.

### Step 5: 집은 카드의 화살표 키를 다시 보내지 않는다

`kanban-board.tsx`의 `moveFocus` 첫 블록을 바꾼다.

```tsx
// While a card is picked up the arrow keys move it; dnd-kit reads them from the document.
if (activeKey !== null) return;
```

**Verify**: `rg -n "dispatchEvent" apps/agent/app/entry/chat/board/kanban-board.tsx` → 결과 없음.
`vp run agent#typecheck` → exit 0.

### Step 6: 테스트

`project-board.browser.tsx`:

1. 기존 테스트의 첫 단언들 앞에 더한다.

```tsx
// The board is a region of the page, not a dialog over it.
yield *
  sdkCall(() =>
    expect.element(screen.getByRole("region", { name: "프로젝트 칸반 보드" })).toBeVisible(),
  );
expect(document.querySelectorAll('[data-slot="sheet-content"]').length).toBe(0);
```

2. Plan 015가 더한 `expect(document.querySelectorAll('[data-slot="sheet-content"]').length).toBe(1);`
   줄과 그 위의 주석을 지운다.
3. 나머지 단언은 고치지 않는다. 통과해야 한다.

**Verify**: 브라우저 테스트 명령 → 통과. `cd apps/agent && vp test --run app/entry/chat` → 통과.

### Step 7: 문구와 문서

- `vp run agent#i18n:extract` → `vp run agent#i18n:check`, `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`.
- `apps/agent/app/entry/chat/board/README.md`: Overview의 "세션 보드 시트 `BoardSheet`"를 "세션 보드
  `SessionBoard`"로 고치고, 두 보드가 `App`의 본문 영역(`SidebarInset`)에 그려진다고 적는다. Interface에
  `BoardFrame`을 더한다. `KanbanBoard` 항목이나 Invariants에 Dialog를 말하는 문장이 있으면 지금
  코드에 맞게 고친다.
- `apps/agent/app/entry/chat/README.md` 26행: `OpenBoardButton`은 버튼만 맡고, 보드는 `SessionBoard`를
  `App`이 그린다고 고친다.
- `docs/decisions.md` 끝에 항목 하나. 제목: `## 칸반 보드는 본문 영역의 보기다 (오늘 날짜)`. 내용:
  사용자 결정(2026-11-15). 계기(보드가 화면을 덮어 사이드바와 다른 패널을 쓸 수 없었다), 결정(두
  보드는 사이드바 옆 본문 영역에 그린다. 대화 화면은 숨길 뿐 언마운트하지 않는다. Esc는 카드
  패널만 닫고, 보드는 "보드 닫기"나 뒤로 가기로 닫는다. URL은 그대로다. 세션 보드는 `disabled`를
  받지 않고 서버의 거절에 맡긴다), 바뀐 기록("칸반 보드 화면 (2026-10-18)"의 전체 폭 Sheet와
  "Base UI Dialog popup이 화살표 키 전파를 막으므로 … 보드가 document로 넘긴다").

**Verify**: `vp check` → exit 0. 세 문구 명령 모두 exit 0.

## Test plan

- 기존 브라우저 테스트: 보드가 `region`으로 보이고 Sheet 팝업이 없다. 나머지 흐름(Goal 순서, 대화
  열기, 카드 패널, 옮기기)이 그대로 통과한다.
- `index.tsx`의 조립과 키보드로 카드 옮기기는 자동 테스트가 없다. 아래 "Maintenance notes"의 손
  확인 목록을 보고에 옮겨 적는다.

## Done criteria

- [ ] 저장소 루트에서 `vp run agent#typecheck`, `vp check`, `vp run agent#i18n:check` 모두 exit 0
- [ ] `rg -n "components/ui/sheet" apps/agent/app/entry/chat/board apps/agent/app/entry/chat/board-panel.tsx` → 결과 없음
- [ ] `rg -n "BoardFrame" apps/agent/app/entry/chat --glob '!*.md'` → 정의 하나, `project-board.tsx`와 `board-panel.tsx`의 쓰임
- [ ] `rg -n "dispatchEvent" apps/agent/app/entry/chat/board/kanban-board.tsx` → 결과 없음
- [ ] 브라우저 테스트 통과 (브라우저를 띄울 수 없었으면 보고에 적는다)
- [ ] `git status --short`에 In scope 밖의 수정이 없다
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- 발췌의 글자가 실제 코드에 없다(행 번호가 다른 것은 괜찮다).
- Plan 015가 아직 들어가지 않았다(`card-peek.tsx`에 `<aside`가 없다).
- Plan 005·009·010 가운데 아직 하지 않은 것이 있다(`plans/README.md`의 표로 확인한다). 이 계획을
  먼저 하면 그 계획들의 `index.tsx` 발췌가 실제 코드와 달라진다.
- `index.tsx`에서 `main`이 `<SidebarInset>` 말고 다른 곳에도 그려진다.
- `chat-panel.tsx`에서 `OpenBoardButton`을 쓰는 곳이 둘 이상이다.
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- 이 계획은 화면을 띄워 보지 않고 썼다. 운영자가 dev에서 볼 것:
  1. 프로젝트 보드를 연 채로 사이드바에서 다른 대화를 누르면 보드가 닫히고 그 대화가 열리는가.
  2. 보드를 닫으면 대화 화면이 쓰던 글과 스크롤 자리를 지닌 채 돌아오는가.
  3. 사이드바를 접었을 때 "사이드바 펼치기" 버튼이 보드의 제목과 겹치지 않는가.
  4. 카드 손잡이에서 Space로 집고 화살표를 한 번 누르면 카드가 한 칸만 움직이는가.
  5. 보드가 열린 동안 Work Trace 패널을 열 수 있는가.
- 대화 화면은 보드 아래에서 `display: none`으로 숨는다. 숨은 동안에도 그 대화의 이벤트를 받고
  다시 그린다. 보드를 오래 열어 두는 것이 느리게 느껴지면 숨은 동안 그리기를 줄이는 것을 따로 본다.
- 세션 보드는 이제 다른 창이 그 대화를 쓰고 있어도 버튼이 눌린다. 서버가 거절하고 알림이 뜬다.
  버튼을 미리 막고 싶다면 lease 상태를 `App`에서도 읽을 수 있게 하는 일이 먼저다.
- 리뷰에서 볼 곳: `main`을 감싼 `div`가 보드가 없을 때 `contents`인가(그래야 본문의 배치가 전과
  같다). `SessionBoard`에 `key={sessionId}`가 있는가(대화가 바뀌면 "카드 추가" 폼 같은 state를 비운다).
