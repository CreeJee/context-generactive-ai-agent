# Plan 015: 카드 패널을 보드를 덮는 Sheet가 아니라 보드 옆 칸으로 둔다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- apps/agent/app/entry/chat/board/card-peek.tsx apps/agent/app/entry/chat/board/board-surface.tsx apps/agent/app/entry/chat/board/kanban-board.tsx apps/agent/app/entry/chat/board/project-board.tsx apps/agent/app/entry/chat/board-panel.tsx`
> Plan 012·013·014의 변경은 예상된 차이다(아래 "앞선 계획이 바꾼 것"). 그 밖의 차이는 "Current
> state"의 발췌와 견준다. 다르면 STOP이다.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/013-card-panel-reject-and-editor.md (같은 파일 `card-peek.tsx`를 먼저 고친다)
- **Category**: usability
- **Planned at**: commit `d65cc285`, 2026-11-15

## Why this matters

보드에서 카드를 누르면 카드 패널이 뜬다. 지금 그 패널은 보드 Sheet 위에 겹쳐 뜨는 두 번째
Sheet다. Sheet는 뒤에 검정 80%와 흐림 배경을 깐다(`components/ui/sheet.tsx:29`). 그래서:

- 카드를 연 동안 보드가 거의 보이지 않는다. 카드가 어느 열에 있는지, 옆 카드가 무엇인지 볼 수 없다.
- 다른 카드를 보려면 패널을 닫고 다시 눌러야 한다.
- 패널이 포커스를 가져가므로 보드의 `j`/`k` 이동이 듣지 않는다.

사용자가 2026-11-15에 카드 패널을 보드와 나란히 두기로 정했다. "칸반 보드 화면 (2026-10-18)"의
"카드 상세·편집·판단 응답은 오른쪽 peek Sheet에서 한다"를 바꾼다.

이 계획 뒤에는:

- 카드 패널은 보드 오른쪽의 칸이다. 배경을 깔지 않고, 보드는 남은 폭에서 그대로 보이고 움직인다.
- 패널이 열린 채로 다른 카드를 누르면 패널의 내용만 바뀐다. 포커스는 보드의 카드에 남는다.
- 열려 있는 카드는 보드에서 테두리로 표시된다.
- 좁은 화면(`sm` 미만)에서는 패널이 폭 전체를 쓰고 보드는 가려진다.
- Esc는 패널을 닫는다. 패널이 닫혀 있으면 지금처럼 보드를 닫는다.

## Current state

### 앞선 계획이 바꾼 것

- Plan 012: `board-surface.tsx`에 `PlannerStalledBadge`, `ReplanWaitBadge`가 더해졌다.
  `project-board.tsx`의 머리줄에 "카드 추가"가 있고 `Collapsible`이 `open`을 받는다.
- Plan 013: `card-peek.tsx`의 승인 블록에 "거절"이 있고, `CardEditor`가 `planCards`를 받고, 드문 네
  항목이 "추가 조건" 안에 있다. `CardDetails`가 `loopCard`를 받는다.
- Plan 014: 머리줄에 `GoalMergeStatus`가 있다.

이 계획은 위 블록들의 내용을 건드리지 않는다. 감싸는 Sheet 부품만 바꾼다.

### 관련 파일

- `apps/agent/app/entry/chat/board/card-peek.tsx` — `CardPeek`. Sheet 부품을 쓴다.
- `apps/agent/app/entry/chat/board/board-surface.tsx` — 보드와 카드 패널을 함께 그린다.
- `apps/agent/app/entry/chat/board/kanban-board.tsx` — `KanbanBoard`, `SortableCard`.
- `apps/agent/app/entry/chat/board/project-board.tsx` — 프로젝트 보드의 Sheet와 Esc 처리.
- `apps/agent/app/entry/chat/board-panel.tsx` — 세션 보드의 Sheet(`BoardSheet`)와 Esc 처리.
- `apps/agent/app/components/ui/sheet.tsx` — 바꾸지 않는다. 부품의 class를 옮겨 적는 출처다.

### 발췌

`card-peek.tsx:431-440` — 패널의 바깥:

```tsx
return (
  <Sheet
    open
    onOpenChange={(open) => {
      if (!open) onClose();
    }}
  >
    <SheetContent className="w-full sm:max-w-md">{content()}</SheetContent>
  </Sheet>
);
```

`card-peek.tsx` 안에서 Sheet 부품을 쓰는 곳:

- 204–211행: 카드를 찾지 못했을 때의 `SheetHeader` / `SheetTitle` / `SheetDescription`.
- 217–227행: 카드의 머리. `SheetHeader` 안에 `SheetDescription`(상태 아이콘, 상태 이름, 카드 id,
  대화 이름)과 `SheetTitle`(카드 제목).
- 381–426행: `<SheetFooter className="flex-row justify-end">` 안의 보류, 편집 버튼.
- `CardEditor`의 631–640행: 새 카드일 때의 `SheetHeader` / `SheetTitle`("카드 추가") / `SheetDescription`.

`components/ui/sheet.tsx`의 부품이 붙이는 class(옮겨 적을 것):

| 부품               | 요소  | class                                                                      |
| ------------------ | ----- | -------------------------------------------------------------------------- |
| `SheetHeader`      | `div` | `flex flex-col gap-1 border-b p-4`                                         |
| `SheetTitle`       | 제목  | `font-heading text-sm font-medium`                                         |
| `SheetDescription` | 문단  | `text-xs/relaxed text-muted-foreground`                                    |
| `SheetFooter`      | `div` | `mt-auto flex flex-col gap-2 p-4`                                          |
| `SheetContent`     | 팝업  | `flex flex-col gap-4 bg-popover text-xs/relaxed text-popover-foreground …` |

`board-surface.tsx:383-389, 429-431, 465-469` — 보드와 패널을 그리는 곳:

```tsx
  return (
    <>
      <div className={className}>
        <KanbanBoard
          cards={cards}
          signalsOf={signalsOf}
          contextOf={contextOf}
          disabled={disabled}
          busy={request.isPending}
          onOpen={(item) => onPeek(refOf(item))}
```

```tsx
      {peekState !== null && peekKey !== null && peekSession !== null && (
        <CardPeek
          key={peekKey}
```

```tsx
          onClose={() => {
            onAddingChange(null);
            setEditingKey(null);
            onPeek(null);
          }}
```

두 보드 모두 `className="min-h-0 flex-1 pt-3"`을 넘긴다(`project-board.tsx:333`, `board-panel.tsx:686`).

`kanban-board.tsx:134-146, 310-318` — `KanbanBoard`의 props와 바깥 요소:

```tsx
export function KanbanBoard({
  cards,
  signalsOf,
  contextOf,
  disabled,
  busy,
  onOpen,
  onReorder,
  onSend,
  onAskChange,
  onRefused,
  onDraggingChange,
}: {
```

```tsx
      <div
        role="group"
        aria-label={t`칸반 보드`}
        onKeyDown={moveFocus}
        className={cn(
          "flex h-full min-h-0 snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-4 sm:snap-none",
```

`kanban-board.tsx:341-349, 559-578` — 카드를 그리는 곳과 `SortableCard`:

```tsx
{
  entries.map((item) => (
    <SortableCard
      key={item.key}
      item={item}
      signals={signalsOf(item)}
      disabled={disabled || contextOf(item).closed}
      busy={busy}
      onOpen={onOpen}
    />
  ));
}
```

```tsx
  return (
    <div
      ref={setNodeRef}
      // dnd-kit computes the offset while sorting; the class reads it from this property.
      style={{ "--board-card-offset": DndCss.Translate.toString(transform) ?? "none" }}
      {...listeners}
      className={cn(
        "group/board-card relative flex transform-(--board-card-offset) touch-manipulation items-start gap-1 rounded-md border bg-card p-3 transition-colors hover:border-foreground/20 hover:bg-accent/40",
        isDragging && "opacity-40",
        isTruthy(transition) && "transition-transform duration-200 ease-out",
      )}
    >
      <button
        type="button"
        data-board-card={item.key}
        className="min-w-0 flex-1 cursor-pointer rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpen(item)}
      >
```

`project-board.tsx:130-138` — 프로젝트 보드 Sheet의 Esc 처리:

```tsx
    <Sheet
      open
      onOpenChange={(next, details) => {
        // Esc while a card is picked up puts the card back; the board stays open.
        if (!next && dragging && details.reason === "escape-key") return details.cancel();
        if (!next) onClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-none">
```

`board-panel.tsx:473-481` — 세션 보드 Sheet의 Esc 처리. 위와 글자가 같다. 이 컴포넌트는
`peekCardId: string | null`, `adding: boolean`(state), `goalAsked`(`peekCardId === goalDecisionCardId`)를
가진다. `goalAsked`일 때는 카드 패널을 열지 않는다(`board-panel.tsx:681`).

### 알아 둘 것

- 보드 Sheet는 Base UI Dialog다. 그 안에 `SheetTitle`(Dialog의 제목 부품)을 하나 더 두면 보드
  Sheet의 제목과 섞인다. 그래서 카드 패널은 Sheet 부품을 모두 일반 요소로 바꿔야 한다.
- `CardPeek`는 `key={peekKey}`로 그려진다. 다른 카드를 누르면 패널이 새로 만들어지고 안의 state
  (옮길 대화, 거절 오류)가 비워진다. 이 동작은 그대로 둔다.
- 패널 안의 `AlertDialog`, `Select`, `Dialog`는 페이지의 다른 자리에 그려지는 팝업이다. 그 팝업의
  Esc는 팝업이 스스로 처리한다.
- Plan 016이 보드 Sheet 자체를 없앤다. 그때 Esc 처리는 다시 바뀐다. 이 계획은 Sheet가 있는
  상태에서 맞게 동작하면 된다.

### 따라야 할 규칙

- UI는 `apps/agent/app/components/ui/*`의 shadcn 컴포넌트로만 만든다. 새 컴포넌트를 들이지 않는다.
  shadcn 컴포넌트의 모양을 `className`으로 덮어쓰지 않는다(lint `shadcn/no-restyle`). `aside`,
  `header`, `footer`, `h3`, `div` 같은 일반 요소의 class는 자유롭게 쓴다.
- 화면 문구는 Lingui 매크로로 쓴다. 한국어 합니다체. 짧은 문구에는 `comment`를 단다.
- `let`, `while`, lint 끄기 주석, `unknown` 타입, `useRef`를 쓰지 않는다.
- 줄바꿈을 손으로 맞추지 않는다. 포맷은 `vp check --fix`가 한다.
- 코드 주석은 영어로, 지금 코드가 왜 그런지만 적는다.

## Commands you will need

| Purpose           | Command                                                                                                     | Expected on success |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------- |
| agent typecheck   | 저장소 루트에서 `vp run agent#typecheck`                                                                    | exit 0              |
| 포맷·lint         | 저장소 루트에서 `vp check`                                                                                  | exit 0              |
| 문구 catalog 갱신 | 저장소 루트에서 `vp run agent#i18n:extract`                                                                 | `ko.po`가 바뀐다    |
| 문구 catalog 검사 | 저장소 루트에서 `vp run agent#i18n:check`                                                                   | exit 0              |
| 문구 내용 검사    | 저장소 루트에서 `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`                        | exit 0              |
| 브라우저 테스트   | 저장소 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/board/` | all pass            |

- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**
- 브라우저 테스트가 브라우저를 띄우지 못하는 환경이면 그 사실을 보고에 적고 넘어간다. STOP이
  아니다. 처음 실행에서 페이지가 다시 로드되며 실패하면 한 번 더 돌린다.

## Scope

**In scope**:

- `apps/agent/app/entry/chat/board/card-peek.tsx`
- `apps/agent/app/entry/chat/board/board-surface.tsx`
- `apps/agent/app/entry/chat/board/kanban-board.tsx` (`selectedKey` prop과 카드의 표시만)
- `apps/agent/app/entry/chat/board/project-board.tsx` (`onOpenChange`만)
- `apps/agent/app/entry/chat/board-panel.tsx` (`BoardSheet`의 `onOpenChange`만)
- `apps/agent/app/entry/chat/board/project-board.browser.tsx`
- `apps/agent/app/locales/ko.po` (추출 명령이 고친다)
- `apps/agent/app/entry/chat/board/README.md`, `docs/decisions.md`(끝에 항목 하나)

**Out of scope**:

- `apps/agent/app/components/ui/sheet.tsx`. 배경의 진하기를 바꾸지 않는다. 다른 Sheet가 함께 쓴다.
- 보드 Sheet 자체. Plan 016이 다룬다.
- 카드 패널의 내용(승인, 판단, 상세, 편집기, 옮기기). 감싸는 부품만 바꾼다.
- 열의 폭 규칙. 펼친 열이 같은 폭을 나누는 것은 기록된 결정이다(`docs/decisions.md:2097`,
  `kanban-board.tsx:495-497`의 주석).
- URL의 `card`, `boardCard` 값.

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 typecheck와 `vp check`를 통과해야 한다. Step 1과 Step 2는 함께
  들어가야 화면이 맞으므로 한 commit으로 묶는다.
- 메시지는 한국어 conventional commit이다. 예: `feat(board): 카드 패널을 보드 옆 칸으로 둔다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: `CardPeek`를 일반 요소로 그린다

`card-peek.tsx`:

1. `../../../components/ui/sheet` import를 지운다. `lucide-react`에서 `XIcon`을 import한다.
2. Sheet 부품을 아래처럼 바꾼다. 안의 내용과 조건은 그대로 둔다.

| 지금                                             | 바꾼 뒤                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `<SheetHeader>`                                  | `<header className="flex flex-col gap-1 border-b p-4 pr-10">`      |
| `<SheetTitle>`                                   | `<h3 className="font-heading text-sm font-medium">`                |
| `<SheetDescription>`                             | `<div className="text-xs/relaxed text-muted-foreground">`          |
| `<SheetFooter className="flex-row justify-end">` | `<footer className="mt-auto flex flex-row justify-end gap-2 p-4">` |

`pr-10`은 오른쪽 위 닫기 버튼의 자리다. 닫는 태그도 함께 바꾼다. 3. 맨 끝의 `return`을 바꾼다.

```tsx
return (
  <aside
    aria-label={t({
      message: "카드 패널",
      comment: "Name of the panel beside the board that shows one card",
    })}
    className="relative flex min-h-0 w-full shrink-0 flex-col gap-4 border-l bg-background text-xs/relaxed sm:w-96"
  >
    <span className="absolute top-2 right-2">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t({
          message: "카드 패널 닫기",
          comment: "Button that closes the card panel beside the board",
        })}
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </span>
    {content()}
  </aside>
);
```

4. `CardPeek` 함수 위의 주석을 고친다.

```tsx
/**
 * The panel beside the board: a card's details, its decision prompts and its editor, or the form
 * for a new card. The board stays visible and usable next to it; the parent closes it on Esc.
 */
```

**Verify**: `rg -n "Sheet" apps/agent/app/entry/chat/board/card-peek.tsx` → 결과 없음.
(typecheck는 Step 2 뒤에 본다.)

### Step 2: `BoardSurface`가 보드와 패널을 나란히 둔다

`board-surface.tsx`:

1. `import { cn } from "cn";`을 더한다(`kanban-board.tsx`가 같은 import를 쓴다).
2. `<div className={className}>…</div>`와 그 아래의 `CardPeek` 블록을 한 줄 배치로 묶는다.
   `CardPeek` 블록(`{peekState !== null && … && (<CardPeek … />)}`)을 통째로 잘라 아래 표시한
   자리에 붙인다. `Alert`와 두 `Dialog`는 지금 자리(바깥 `<>` 안)에 둔다.

```tsx
<div className={cn("flex min-h-0", className)}>
  <div className={cn("min-w-0 flex-1", peekKey !== null && "hidden sm:block")}>
    <KanbanBoard
    /* 지금의 props 그대로, 아래 3번의 두 줄만 바꾸고 더한다 */
    />
  </div>
  {/* CardPeek 블록을 여기에 붙인다 */}
</div>
```

3. `KanbanBoard`의 props를 고친다.

```tsx
          // A card opened from the board shows its details; only "수정 요청 남기기" opens the editor.
          onOpen={(item) => {
            setEditingKey(null);
            onPeek(refOf(item));
          }}
          selectedKey={adding !== null || peek === null ? null : boardCardKey(peek)}
```

4. `BoardSurface` 함수 위 주석의 "the card peek panel"은 그대로 두고, 끝에 한 문장을 더한다:
   `The panel sits beside the columns, so the board stays usable while a card is open.`

`kanban-board.tsx`:

5. `KanbanBoard`의 props에 더한다(`onOpen` 다음).

```tsx
  /** The card open in the panel beside the board; it is marked among the cards. */
  readonly selectedKey: string | null;
```

구조 분해에도 `selectedKey`를 더한다. 6. `<SortableCard …>`에 `selected={item.key === selectedKey}`를 더한다. 7. `SortableCard`의 props에 `readonly selected: boolean;`을 더하고 구조 분해한다. 바깥 `div`의
`cn(...)`에 한 줄을 더한다.

```tsx
        selected && "border-primary ring-1 ring-primary",
```

카드 버튼(`data-board-card`가 붙은 `button`)에 `aria-current={selected ? "true" : undefined}`를 더한다.

**Verify**:

- `vp run agent#typecheck` → exit 0. `vp check` → exit 0.
- `rg -n "selectedKey" apps/agent/app/entry/chat/board` → `kanban-board.tsx`와 `board-surface.tsx`.

### Step 3: Esc는 열린 카드 패널부터 닫는다

보드 Sheet가 Esc를 받는다. 카드를 집고 있으면 지금처럼 카드만 되돌린다. 카드 패널이 열려 있으면
패널만 닫는다. 둘 다 아니면 보드를 닫는다.

1. `project-board.tsx`의 `onOpenChange`를 바꾼다.

```tsx
      onOpenChange={(next, details) => {
        if (!next && details.reason === "escape-key") {
          // Esc puts a picked-up card back, or closes the open card panel; the board stays open.
          if (dragging) return details.cancel();
          if (peek !== null || adding !== null) {
            setAdding(null);
            onPeek(null);
            return details.cancel();
          }
        }
        if (!next) onClose();
      }}
```

2. `board-panel.tsx`의 `BoardSheet`의 `onOpenChange`를 바꾼다. Goal 수준 판단을 가리키는
   `peekCardId`(`goalAsked`)는 카드 패널을 열지 않으므로 뺀다.

```tsx
      onOpenChange={(next, details) => {
        if (!next && details.reason === "escape-key") {
          // Esc puts a picked-up card back, or closes the open card panel; the board stays open.
          if (dragging) return details.cancel();
          if (adding || (peekCardId !== null && !goalAsked)) {
            setAdding(false);
            onPeek(null);
            return details.cancel();
          }
        }
        if (!next) onClose();
      }}
```

`goalAsked`는 이 `return` 문보다 위에서 정의돼 있다(`board-panel.tsx:462`).

**Verify**: `vp run agent#typecheck` → exit 0.

### Step 4: 테스트

`project-board.browser.tsx`의 기존 테스트에서, 카드 "로그 포맷"을 누른 다음의 단언에 두 줄을 더한다.

```tsx
yield *
  sdkCall(() =>
    expect.element(screen.getByRole("complementary", { name: "카드 패널" })).toBeVisible(),
  );
// The panel is not a dialog of its own: only the board's sheet is one.
expect(document.querySelectorAll('[data-slot="sheet-content"]').length).toBe(1);
```

그 아래의 기존 단언(제목 "로그 포맷", "옮길 대화" 고르기, 확인 Dialog, 보낸 요청)은 고치지 않는다.
통과해야 한다.

Plan 013이 만든 `card-peek.browser.tsx`도 고치지 않고 통과해야 한다.

**Verify**: 브라우저 테스트 명령 → 두 파일 모두 통과.

### Step 5: 문구와 문서

- `vp run agent#i18n:extract` → `vp run agent#i18n:check`, `node lint/wording/check/main.ts check apps/agent/app/locales/ko.po`.
- `apps/agent/app/entry/chat/board/README.md`: `CardPeek` 항목의 "오른쪽 Sheet peek 패널이다"를
  "보드 오른쪽 칸에 그리는 카드 패널이다(Sheet가 아니다)"로 고친다. `KanbanBoard` 항목에
  `selectedKey`를 더한다. Invariants에 한 줄을 더한다: "카드 패널은 Sheet 부품을 쓰지 않는다. 보드를
  담은 쪽(Sheet든 본문 영역이든)의 제목과 섞이지 않게 일반 요소로 그린다."
- `docs/decisions.md` 끝에 항목 하나. 제목: `## 카드 패널은 보드 옆 칸이다 (오늘 날짜)`. 내용: 사용자
  결정(2026-11-15). 계기(두 번째 Sheet의 배경이 보드를 가렸고, 다른 카드를 보려면 닫아야 했고,
  키보드 이동이 끊겼다), 결정(패널은 보드와 같은 줄의 오른쪽 칸이다. 카드를 누르면 패널의 내용이
  바뀌고 포커스는 보드에 남는다. 열린 카드는 테두리로 표시한다. 좁은 화면에서는 패널이 폭 전체를
  쓴다. Esc는 패널을 먼저 닫는다), 바뀐 기록("칸반 보드 화면 (2026-10-18)"의 peek Sheet).

**Verify**: `vp check` → exit 0. 세 문구 명령 모두 exit 0.

## Test plan

- 기존 브라우저 테스트에 단언 둘: 카드 패널이 `complementary` 영역으로 보이고, Sheet 팝업은 보드의
  것 하나뿐이다.
- Plan 013의 브라우저 테스트가 그대로 통과한다(패널의 내용이 바뀌지 않았다는 확인).
- Esc 처리는 테스트하지 않는다. Plan 016이 다시 바꾼다.

## Done criteria

- [ ] 저장소 루트에서 `vp run agent#typecheck`, `vp check`, `vp run agent#i18n:check` 모두 exit 0
- [ ] `rg -n "Sheet" apps/agent/app/entry/chat/board/card-peek.tsx` → 결과 없음
- [ ] `rg -n "<aside" apps/agent/app/entry/chat/board/card-peek.tsx` → 한 줄
- [ ] 브라우저 테스트 통과 (브라우저를 띄울 수 없었으면 보고에 적는다)
- [ ] `git status --short`에 In scope 밖의 수정이 없다
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다(Plan 012·013·014의 변경은 예외).
- Plan 013이 아직 들어가지 않았다(`card-peek.tsx`에 `planCards`가 없다).
- Sheet의 `onOpenChange`가 `details.reason`과 `details.cancel()`을 주지 않는다.
- 브라우저 테스트에서 보드의 열이 보이지 않거나 높이가 0이 된다(배치가 깨진 것이다. class를 임의로
  더해 맞추지 말고 보고한다).
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- 이 계획은 화면을 띄워 보지 않고 썼다. 운영자가 dev에서 볼 것: 패널을 연 채로 보드의 열이 제
  높이로 스크롤되는가. 열 일곱 개가 좁아진 폭에서 가로로 스크롤되는가. 패널의 본문이 길 때 패널
  안에서만 스크롤되는가. 카드를 끌 때 패널 위로 끌려 나오는 카드가 자연스러운가.
- 패널의 폭은 `sm:w-96`(24rem)이다. 전에는 최대 28rem이었다. 좁으면 여기 한 곳을 고친다.
- 패널이 열리면 보드의 폭이 줄어 열이 좁아진다. 열의 최소 폭은 `sm:min-w-44`라 넘치면 가로
  스크롤이 생긴다.
- Plan 016이 보드 Sheet를 본문 영역의 틀로 바꾸면서 Step 3의 Esc 처리를 틀의 키 처리로 옮긴다.
- 리뷰에서 볼 곳: `card-peek.tsx`에 Sheet 부품이 남지 않았는가. `Alert`(거절 알림)와 두 `Dialog`가
  한 줄 배치의 밖에 그대로 있는가.
