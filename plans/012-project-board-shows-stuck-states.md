# Plan 012: 프로젝트 보드가 멈춘 상태와 Goal 판단을 접지 않고 보인다

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. 끝나면 `plans/README.md`의 이 계획 행을 고친다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat d65cc285..HEAD -- apps/agent/app/entry/chat/board/project-board.tsx apps/agent/app/entry/chat/board/board-surface.tsx apps/agent/app/entry/chat/board/board-moves.ts apps/agent/app/entry/chat/board-panel.tsx`
> 출력이 있으면 "Current state"의 발췌와 실제 코드를 견준다. 다르면 STOP이다.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (004–011과 닿는 파일이 없다)
- **Category**: usability
- **Planned at**: commit `d65cc285`, 2026-11-15

## Why this matters

프로젝트 칸반 보드는 프로젝트의 실행 중인 Plan을 한 화면에 모은다. 그런데 사람이 손을 써야
하는 상태가 모두 처음에 접혀 있는 "대화 순서와 상태" 패널 안에 있다.

- 보드 루프가 멈췄다는 표시와 "다시 시작" 버튼
- "자동 Plan 작성 멈춤"
- "일시 중지 · 새 카드 멈춤"
- "카드 추가"

머리줄에는 수 넷(실행 중인 대화, 칸반 실행, 완료, 판단 대기)만 있다. 보드를 열어도 보드가
멈췄는지 알 수 없다.

두 가지가 더 있다.

- Plan 작성자가 다시 짜지 않아 사람을 기다리는 카드 수("확인 필요 카드")는 세션 보드에는 있고
  프로젝트 보드에는 없다.
- Goal 수준의 판단(카드 id가 `@goal`인 요청. 보호 브랜치 merge, 사용자 브랜치 merge 충돌)은
  머리줄의 "판단 대기" 수에는 들어가지만 프로젝트 보드 어디에서도 답할 수 없다. 어느 카드의
  패널에도 나오지 않기 때문이다. 로컬 DB에서 판단 요청 49건 가운데 10건이 이 종류다.

같은 표시가 여러 벌이기도 하다. "자동 Plan 작성 멈춤" 배지와 그 설명문이 세 곳에 복사돼 있다.

이 계획 뒤에는:

- 사람을 기다리는 대화가 있으면 "대화 순서와 상태" 패널이 처음부터 펼쳐진다. 버튼에는 그런
  대화의 수가 붙는다.
- 대화 줄에 "확인 필요 카드" 배지와 Goal 수준 판단의 답 버튼이 나온다.
- "카드 추가"가 머리줄에 있다.
- "자동 Plan 작성 멈춤" 배지와 "확인 필요 카드" 배지는 한 곳에서 정의한다.

## Current state

### 관련 파일

- `apps/agent/app/entry/chat/board/project-board.tsx` — `ProjectBoard`와 `ConversationRow`. 494행.
- `apps/agent/app/entry/chat/board/board-surface.tsx` — `KanbanRunningBadge`, `SurfaceBoard`,
  `ActiveKanban`, `BoardSurface`. 569행.
- `apps/agent/app/entry/chat/board/board-moves.ts` — 보드의 순수 로직과 상수.
- `apps/agent/app/entry/chat/board-panel.tsx` — 세션 보드(`BoardSheet`), 채팅 요약(`WorkflowBoard`,
  `BoardTally`). `ReplanWaitBadge`와 `goalDecisionCardId`가 여기에 비공개로 있다. 849행.
- `apps/agent/app/entry/chat/decision-prompt.tsx` — `DecisionPrompt({ projectId, holder, request, disabled })`.
  판단 하나와 그 답 버튼을 그린다. `role="group"`이고 `aria-label`은 판단의 제목이다.
- `apps/agent/app/entry/chat/board/hold-reason.ts` — `waitsForUser(reason)`.
- `apps/agent/app/entry/chat/board/project-board.browser.tsx` — 프로젝트 보드의 브라우저 테스트.

### 발췌

`project-board.tsx:84-86, 197` — 판단 목록과 접힌 패널:

```tsx
const inbox = useDecisionInboxQuery(projectId).data ?? [];
// Cards awaiting approval wait for the user too, as the inbox counts them.
const awaiting = everyRow.reduce((sum, row) => sum + row.awaitingApproval.length, 0);
```

```tsx
          <Collapsible>
            <div className="mt-1 flex flex-wrap items-center gap-1">
```

`project-board.tsx:234-253` — 패널을 여는 버튼:

```tsx
<span className="flex items-center gap-1">
  {rows.length > 0 && (
    <CollapsibleTrigger
      render={
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={rows.length > 1 ? "group" : "group -ml-2"}
        />
      }
    >
      <ChevronRightIcon
        data-icon="inline-start"
        className="transition-transform group-data-[panel-open]:rotate-90"
      />
      <Trans>대화 순서와 상태</Trans>
    </CollapsibleTrigger>
  )}
</span>
```

`project-board.tsx:262-287` — 대화 줄을 그리는 곳:

```tsx
                {rows.map((row, index) => (
                  <ConversationRow
                    key={row.sessionId}
                    projectId={projectId}
                    holder={holder}
                    row={row}
                    surface={surfaceOf(row.sessionId)}
                    decisions={
                      Arr.countBy(inbox, (item) => item.sessionId === row.sessionId) +
                      row.awaitingApproval.length
                    }
                    moving={order.isPending}
                    onMoveUp={/* ... */}
                    onMoveDown={/* ... */}
                    onAdd={() => setAdding(row.sessionId)}
                    onOpenSession={() => onOpenSession(row.sessionId)}
                  />
                ))}
```

`project-board.tsx:412-435` — 대화 줄의 상태 표시:

```tsx
{
  row.kanbanActive ? (
    <KanbanRunningBadge paused={loop?.goalPaused === true} />
  ) : (
    <Badge variant="outline">{t(planStatusLabels[row.plan.status])}</Badge>
  );
}
{
  loop !== null && loop.plannerStalled && (
    <Badge
      variant="outline"
      title={t`Plan 작성자가 연속으로 카드를 고쳤지만 새로 충족된 결과가 없어 자동 Plan 작성을 멈췄습니다. 이미 맡은 카드는 계속 실행됩니다. 대화에서 방향을 알려 주면 다시 Plan을 짭니다.`}
    >
      <Trans comment="Badge: the automatic Plan writer has stopped">자동 Plan 작성 멈춤</Trans>
    </Badge>
  );
}
{
  loop !== null && loop.loop._tag !== "Healthy" && (
    <LoopHealthStatus
      label={t({ message: "보드 루프", comment: "Name of the board loop in its health status" })}
      health={loop.loop}
      disabled={kanbanAction.isPending}
      onRestart={() => act(KanbanAction.RestartLoop())}
    />
  );
}
```

`project-board.tsx:470-481` — 대화 줄의 "카드 추가":

```tsx
<Button type="button" size="sm" variant="outline" disabled={surface === null} onClick={onAdd}>
  <PlusIcon data-icon="inline-start" />
  <Trans comment="Button that opens the form for a new card in this conversation">카드 추가</Trans>
</Button>
```

`board-panel.tsx:182-197` — 옮길 배지:

```tsx
/** The cards whose replan the planner left undone: they wait for the user. */
function ReplanWaitBadge({ loop }: { readonly loop: ActiveKanban }) {
  const { t } = useLingui();
  const waiting = Arr.countBy(loop.cards, (card) => waitsForUser(card.reason));
  if (waiting === 0) return null;
  return (
    <Badge
      variant="outline"
      title={t`계속 실패해 다시 짜 달라고 요청한 카드를 Plan 작성자가 고치지 않았습니다. 카드를 고치거나 다시 대기열에 넣어 주십시오.`}
    >
      <Trans comment="Badge: blocked cards the planner did not replan, waiting for the user">
        확인 필요 카드 {waiting}
      </Trans>
    </Badge>
  );
}
```

`board-panel.tsx:315-324`와 `:489-498` — "자동 Plan 작성 멈춤" 배지의 두 복사본. 위
`project-board.tsx:417-424`와 글자까지 같다(들여쓰기만 다르다).

`board-panel.tsx:693-694`:

```tsx
/** The card id Goal-level requests carry (memory-agent `goalDecisionCardId`). */
const goalDecisionCardId = "@goal";
```

`board-surface.tsx:46-64` — 새 배지를 둘 자리의 본보기. 이 파일은 `useLingui`가 아니라
`@lingui/core/macro`의 `t`를 쓴다:

```tsx
export type ActiveKanban = Extract<KanbanView, { readonly active: true }>;

/** Whether the board's loop runs this Plan, or holds new cards while the user paused the Goal. */
export function KanbanRunningBadge({ paused }: { readonly paused: boolean }) {
  return paused ? (
    <Badge
      variant="outline"
      title={t`Goal을 일시 중지해서 새 카드를 맡기지 않습니다. 이미 진행 중인 카드는 끝까지 실행합니다. 계속하면 다시 맡깁니다.`}
    >
      {/* ... */}
```

`navigation/sidebar.tsx:1087-1100` — `DropdownMenu`의 본보기:

```tsx
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuAction showOnHover aria-label={menuLabel(session)} />}
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuItem onClick={() => onArchive(session.projectId, session.id)}>
```

`navigation/sidebar.tsx:252` — 열림 상태를 밖에서 쥐는 `Collapsible`의 본보기:
`<Collapsible open={open} onOpenChange={setOpen}>`.

### 알아 둘 것

- `surface.loop`은 칸반 루프가 도는 대화에만 값이 있다(`ActiveKanban | null`). `loop.loop`은 루프의
  상태(`Healthy`, `Retrying`, `Exhausted`, `Defected`), `loop.plannerStalled`와 `loop.goalPaused`는
  boolean, `loop.cards[].reason`은 카드가 멈춘 까닭이다.
- 판단 목록의 항목은 `sessionId`와 `cardId`를 가진다. Goal 수준 요청의 `cardId`는 `"@goal"`이다.
  `navigation/decision-inbox.tsx`가 같은 항목을 `DecisionPrompt`의 `request`로 넘기고 있으므로
  타입이 맞는다.
- 세션 보드는 Goal 수준 판단을 접이식 패널 안의 `GoalSchedulePanel`에서 그린다
  (`board-panel.tsx:838-846`). 이 계획은 그쪽을 바꾸지 않는다.

### 따라야 할 규칙

- UI는 `apps/agent/app/components/ui/*`의 shadcn 컴포넌트로만 만든다. 새 컴포넌트를 들이지 않는다.
  shadcn 컴포넌트에 `className`으로 모양을 덮어쓰지 않는다(lint `shadcn/no-restyle`). 배치용
  class(`ml-auto`, `basis-full` 등)는 기존 코드가 쓰는 만큼만 쓴다.
- 화면 문구는 Lingui 매크로로 쓴다. 한국어 합니다체. 번역자가 헷갈릴 짧은 문구에는 `comment`를 단다.
- 태그 유니온의 `_tag`를 손으로 읽지 않는다. 새 코드는 `Predicate.isTagged(value, "Healthy")`를 쓴다.
  기존 줄의 `loop.loop._tag !== "Healthy"`는 건드리지 않는다.
- `let`, `while`, lint 끄기 주석, `unknown` 타입, `useRef`를 쓰지 않는다.
- 줄바꿈을 손으로 맞추지 않는다. 포맷은 `vp check --fix`가 한다.
- 코드 주석은 영어로, 지금 코드가 왜 그런지만 적는다.

## Commands you will need

| Purpose           | Command                                                                                                                              | Expected on success |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| agent typecheck   | 저장소 루트에서 `vp run agent#typecheck`                                                                                             | exit 0              |
| 포맷·lint         | 저장소 루트에서 `vp check`                                                                                                           | exit 0              |
| 문구 catalog 갱신 | 저장소 루트에서 `vp run agent#i18n:extract`                                                                                          | `ko.po`가 바뀐다    |
| 문구 catalog 검사 | 저장소 루트에서 `vp run agent#i18n:check`                                                                                            | exit 0              |
| 문구 내용 검사    | 저장소 루트에서 `node lint/wording/check/main.ts check`                                                                              | exit 0              |
| 브라우저 테스트   | 저장소 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/board/project-board.browser.tsx` | all pass            |

- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**
- 브라우저 테스트가 브라우저를 띄우지 못하는 환경이면 그 사실을 보고에 적고 넘어간다. STOP이
  아니다. 처음 실행에서 페이지가 다시 로드되며 실패하면 한 번 더 돌린다.

## Scope

**In scope**:

- `apps/agent/app/entry/chat/board/project-board.tsx`
- `apps/agent/app/entry/chat/board/board-surface.tsx`
- `apps/agent/app/entry/chat/board/board-moves.ts`
- `apps/agent/app/entry/chat/board-panel.tsx` (배지 두 곳, `ReplanWaitBadge`, `goalDecisionCardId`만)
- `apps/agent/app/entry/chat/board/project-board.browser.tsx`
- `apps/agent/app/locales/ko.po` (추출 명령이 고친다)
- `apps/agent/app/entry/chat/board/README.md`, `docs/decisions.md`(끝에 항목 하나)

**Out of scope**:

- 서버(`packages/memory-agent`, `apps/agent/app/.server`). 읽는 값은 지금 API가 이미 준다.
- `BoardTally`(`board-panel.tsx:105-180`). 채팅 요약 줄의 글자 표시는 그대로 둔다.
- 세션 보드의 접이식 패널과 `GoalSchedulePanel`.
- `chat/board/card-peek.tsx`, `chat/board/kanban-board.tsx`.
- 보드를 Sheet로 여는 방식. Plan 016이 다룬다.

## Git workflow

- 이 checkout은 여러 세션이 함께 쓴다. **브랜치를 바꾸지 않는다.** 지금 브랜치에 commit한다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `feat(board): 프로젝트 보드가 사람을 기다리는 대화를 펼쳐 보인다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: 함께 쓰는 배지와 상수를 한 곳에 둔다

1. `board/board-moves.ts`에 더한다(파일 끝이나 다른 상수 옆).

```ts
/** The card id Goal-level requests carry (memory-agent `goalDecisionCardId`). */
export const goalDecisionCardId = "@goal";
```

`board-panel.tsx:693-694`의 비공개 상수를 지우고, 같은 파일의 `./board/board-moves` import에
`goalDecisionCardId`를 더한다.

2. `board/board-surface.tsx`의 `KanbanRunningBadge` 다음에 더한다.

```tsx
/** The board stopped waking its planner; the badge's title says what still runs. */
export function PlannerStalledBadge() {
  return (
    <Badge
      variant="outline"
      title={t`Plan 작성자가 연속으로 카드를 고쳤지만 새로 충족된 결과가 없어 자동 Plan 작성을 멈췄습니다. 이미 맡은 카드는 계속 실행됩니다. 대화에서 방향을 알려 주면 다시 Plan을 짭니다.`}
    >
      <Trans comment="Badge: the automatic Plan writer has stopped">자동 Plan 작성 멈춤</Trans>
    </Badge>
  );
}

/** The cards whose replan the planner left undone: they wait for the user. */
export function ReplanWaitBadge({ loop }: { readonly loop: ActiveKanban }) {
  const waiting = Arr.countBy(loop.cards, (card) => waitsForUser(card.reason));
  if (waiting === 0) return null;
  return (
    <Badge
      variant="outline"
      title={t`계속 실패해 다시 짜 달라고 요청한 카드를 Plan 작성자가 고치지 않았습니다. 카드를 고치거나 다시 대기열에 넣어 주십시오.`}
    >
      <Trans comment="Badge: blocked cards the planner did not replan, waiting for the user">
        확인 필요 카드 {waiting}
      </Trans>
    </Badge>
  );
}
```

- `board-surface.tsx`의 import를 고친다: `import { Array as Arr, Effect, Fiber } from "effect";`,
  `import { holdReasonText, waitsForUser } from "./hold-reason";`.
- 문구는 기존 것을 글자 그대로 옮긴다. 한 글자라도 바뀌면 catalog의 id가 바뀐다.

3. 복사본을 지우고 새 컴포넌트를 쓴다.

- `board-panel.tsx`: `ReplanWaitBadge` 함수 정의(182–197행)를 지운다. `./board/board-surface`
  import에 `PlannerStalledBadge`, `ReplanWaitBadge`를 더한다. 315–324행과 489–498행의
  `<Badge …>…자동 Plan 작성 멈춤…</Badge>` 블록을 각각 `<PlannerStalledBadge />`로 바꾼다. 조건
  (`loop !== null && loop.plannerStalled &&`)은 그대로 둔다.
- `board-panel.tsx`에서 `waitsForUser`와 `Arr`는 `BoardTally`가 계속 쓴다. import를 지우지 않는다.
- `project-board.tsx`: 417–424행의 블록을 `<PlannerStalledBadge />`로 바꾼다. `./board-surface`
  import에 `PlannerStalledBadge`, `ReplanWaitBadge`를 더한다.

**Verify**:

- `vp run agent#typecheck` → exit 0.
- `rg -n "Plan 작성자가 연속으로 카드를 고쳤지만" apps/agent/app --glob '!*.po'` → `board-surface.tsx` 한 줄.
- `rg -n "goalDecisionCardId = " apps/agent/app` → `board-moves.ts` 한 줄.

### Step 2: 대화 줄에 "확인 필요 카드"와 Goal 수준 판단을 보인다

`project-board.tsx`:

1. import를 더한다: `import type { HumanDecisionRequest } from "../../api";`,
   `import { DecisionPrompt } from "../decision-prompt";`, `./board-moves`에서 `goalDecisionCardId`.
2. `ProjectBoard` 안, `surfaceOf` 다음에 더한다.

```tsx
/** Goal-level requests name no card, so no card's peek shows them; the conversation's line does. */
const goalDecisionsOf = (sessionId: string) =>
  inbox.filter((item) => item.sessionId === sessionId && item.cardId === goalDecisionCardId);
```

3. `<ConversationRow …>`에 prop을 더한다: `goalDecisions={goalDecisionsOf(row.sessionId)}`.
4. `ConversationRow`의 prop 타입에 더한다.

```tsx
  /** Goal-level decisions waiting for the user; answered on this line. */
  readonly goalDecisions: readonly HumanDecisionRequest[];
```

5. `ConversationRow` 안, `<PlannerStalledBadge />` 줄 다음에 더한다.

```tsx
{
  loop !== null && <ReplanWaitBadge loop={loop} />;
}
```

6. `ConversationRow`의 `actionError` 문단 바로 앞에 더한다.

```tsx
{
  goalDecisions.length > 0 && (
    <div className="flex basis-full flex-col gap-2">
      {goalDecisions.map((request) => (
        <DecisionPrompt
          key={request.requestId}
          projectId={projectId}
          holder={holder}
          request={request}
          disabled={false}
        />
      ))}
    </div>
  );
}
```

**Verify**: `vp run agent#typecheck` → exit 0.

### Step 3: 사람을 기다리는 대화가 있으면 패널이 처음부터 펼쳐진다

`project-board.tsx`:

1. import: `import { Array as Arr, Predicate } from "effect";`, `import { waitsForUser } from "./hold-reason";`.
2. 파일 위쪽의 `onBoard` 다음에 더한다.

```tsx
/**
 * Whether the conversation's board waits for the user: a loop that is not healthy, a stalled
 * planner, a paused Goal, cards the planner left unreplanned, or a Goal-level decision.
 */
const needsUser = (surface: SurfaceBoard | null, goalDecisions: number) => {
  const loop = surface?.loop ?? null;
  return (
    goalDecisions > 0 ||
    (loop !== null &&
      (!Predicate.isTagged(loop.loop, "Healthy") ||
        loop.plannerStalled ||
        loop.goalPaused ||
        loop.cards.some((card) => waitsForUser(card.reason))))
  );
};
```

3. `ProjectBoard` 안, `goalDecisionsOf` 다음에 더한다.

```tsx
const attention = Arr.countBy(rows, (row) =>
  needsUser(surfaceOf(row.sessionId), goalDecisionsOf(row.sessionId).length),
);
// Null until the user folds or unfolds the panel; until then it follows what waits for them.
const [panelOpen, setPanelOpen] = useState<boolean | null>(null);
```

`useState`는 컴포넌트의 다른 `useState`들 옆(94–97행 근처)에 둔다. 훅을 조건문이나 계산 뒤에
두어도 동작은 같지만, 기존 코드의 배치를 따른다. `attention` 계산은 `surfaceOf` 뒤여야 한다.

4. `<Collapsible>`을 `<Collapsible open={panelOpen ?? attention > 0} onOpenChange={setPanelOpen}>`으로 바꾼다.
5. `CollapsibleTrigger` 안, `<Trans>대화 순서와 상태</Trans>` 다음에 더한다.

```tsx
{
  attention > 0 && (
    <Badge variant="outline">
      <Trans comment="Badge on the status panel's button: conversations that wait for the user">
        확인할 대화 {attention}
      </Trans>
    </Badge>
  );
}
```

**Verify**: `vp run agent#typecheck` → exit 0.

### Step 4: "카드 추가"를 머리줄로 올린다

`project-board.tsx`:

1. import를 더한다.

```tsx
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
```

2. `<span className="flex items-center gap-1">`(234행) 안, `CollapsibleTrigger` 블록 **앞**에 더한다.

```tsx
{
  rows.length === 1 && (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={surfaces.length === 0}
      onClick={() => setAdding(rows[0]?.sessionId ?? null)}
    >
      <PlusIcon data-icon="inline-start" />
      <Trans comment="Button that opens the form for a new card">카드 추가</Trans>
    </Button>
  );
}
{
  rows.length > 1 && (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" size="sm" variant="outline" />}>
        <PlusIcon data-icon="inline-start" />
        <Trans comment="Button that opens the form for a new card">카드 추가</Trans>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {rows.map((row) => (
          <DropdownMenuItem
            key={row.sessionId}
            disabled={surfaceOf(row.sessionId) === null}
            onClick={() => setAdding(row.sessionId)}
          >
            {titleOf(row)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

3. `ConversationRow`에서 "카드 추가" 버튼(470–481행)과 `onAdd` prop(타입, 구조 분해, 넘기는 곳)을
   지운다. `ConversationRow`가 `PlusIcon`을 더 쓰지 않아도 `ProjectBoard`가 쓰므로 import는 남는다.

**Verify**:

- `vp run agent#typecheck` → exit 0.
- `rg -n "onAdd" apps/agent/app/entry/chat/board/project-board.tsx` → 결과 없음.

### Step 5: 테스트

`project-board.browser.tsx`를 고친다.

1. 서버 대역이 테스트마다 다른 값을 주게 한다. 파일의 `server` 함수 위에 더한다.

```ts
/** What the stub serves beyond the fixed boards; a test sets it and puts it back. */
const served: { kanbanA: object; decisions: readonly object[] } = {
  kanbanA: { active: false },
  decisions: [],
};
```

`server` 안의 두 줄을 바꾼다.

```ts
if (pathname === "/api/projects/project-1/decisions")
  return Promise.resolve(Response.json(served.decisions));
const session = /^\/api\/sessions\/(session-[abc])\/(board|kanban)$/.exec(pathname);
if (session?.[2] === "kanban")
  return Promise.resolve(
    Response.json(session[1] === "session-a" ? served.kanbanA : { active: false }),
  );
```

2. 테스트를 더한다.

```tsx
it.live("project board unfolds the status panel when a conversation waits for the user", () =>
  Effect.gen(function* () {
    vi.stubGlobal("fetch", server);
    served.kanbanA = stalledBoard;
    const screen = yield* sdkCall(() => render(<Harness onOpenSession={() => {}} />));

    // Nothing was clicked: the stalled planner shows because the panel opened by itself.
    yield* sdkCall(() => expect.element(screen.getByText("자동 Plan 작성 멈춤")).toBeVisible());
    yield* sdkCall(() => expect.element(screen.getByText("확인할 대화 1")).toBeVisible());

    // The header's button names the conversation the new card goes to.
    yield* sdkCall(() => screen.getByRole("button", { name: "카드 추가" }).click());
    yield* sdkCall(() => screen.getByRole("menuitem", { name: "결제 모듈" }).click());
    yield* sdkCall(() =>
      expect.element(screen.getByRole("heading", { name: "카드 추가" })).toBeVisible(),
    );
    served.kanbanA = { active: false };
    vi.unstubAllGlobals();
  }),
);
```

`stalledBoard`는 파일 위쪽에 상수로 둔다. `/api/sessions/:session/kanban`의 응답 모양은
`packages/memory-agent/src/kanban/contracts.ts`의 `KanbanBoardView`에 `active: true`를 더한
것이다.

```ts
/** session-a's loop as the server reports it once its planner stalled. */
const stalledBoard = {
  active: true,
  goalInstanceId: "goal-a",
  mode: "sequential",
  goalChange: null,
  cards: [],
  schedule: null,
  loop: { _tag: "Healthy" },
  plannerStalled: true,
  goalPaused: false,
  unjudgedOutcomes: [],
};
```

`loop`의 모양은 `rg -n "LoopHealth" packages/memory-agent/src --glob '!*.test.ts' | head`로
정의를 찾아 `Healthy`의 필드를 확인한다. 필드가 더 있으면 채운다.

3. 기존 테스트("project board shows the executing Plans in order…")는 고치지 않는다. 그 테스트의
   자료에는 사람을 기다리는 대화가 없어 패널이 접힌 채로 시작하고, "대화 순서와 상태"를 눌러 연다.

**Verify**: 브라우저 테스트 명령 → 2 passed.

### Step 6: 문구와 문서

- `vp run agent#i18n:extract` → `vp run agent#i18n:check`, `node lint/wording/check/main.ts check`.
- `apps/agent/app/entry/chat/board/README.md`의 Interface에 `PlannerStalledBadge`, `ReplanWaitBadge`,
  `goalDecisionCardId`를 더하고, `ProjectBoard` 항목에 "사람을 기다리는 대화가 있으면 상태 패널이
  펼쳐진 채로 열린다. 대화 줄에서 Goal 수준 판단에 답한다"를 더한다.
- `docs/decisions.md` 끝에 항목 하나. 제목: `## 프로젝트 보드는 사람을 기다리는 대화를 펼쳐 보인다 (오늘 날짜)`.
  내용: 계기(보드 루프 멈춤, 자동 Plan 작성 멈춤, 일시 중지, Goal 수준 판단이 접힌 패널 안에만
  있거나 아예 없었다), 결정(패널은 사람을 기다리는 대화가 있으면 펼쳐서 연다. 사용자가 접거나 펴면
  그 뒤로는 그 선택을 따른다. Goal 수준 판단은 대화 줄에서 답한다. "카드 추가"는 머리줄에 둔다),
  바뀐 기록("칸반 보드 화면을 덜어낸다 (2026-10-31)"의 "접이식 패널은 동작 줄 오른쪽 버튼으로
  연다"는 그대로이고, 처음 열림 상태만 바뀐다).

**Verify**: `vp check` → exit 0. 세 문구 명령 모두 exit 0.

## Test plan

- 새 브라우저 테스트 하나: Plan 작성이 멈춘 대화가 있으면 누르지 않아도 배지가 보이고, 머리줄의
  "카드 추가"가 대화를 골라 새 카드 폼을 연다.
- Goal 수준 판단의 답 버튼은 `DecisionPrompt`를 그대로 쓰므로 따로 테스트하지 않는다.

## Done criteria

- [ ] 저장소 루트에서 `vp run agent#typecheck`, `vp check`, `vp run agent#i18n:check` 모두 exit 0
- [ ] `rg -n "Plan 작성자가 연속으로 카드를 고쳤지만" apps/agent/app --glob '!*.po'` → 한 줄
- [ ] `rg -n "function ReplanWaitBadge" apps/agent/app` → `board-surface.tsx` 한 줄
- [ ] `rg -n "goalDecisionsOf|needsUser" apps/agent/app/entry/chat/board/project-board.tsx` → 정의와 쓰임이 있다
- [ ] 브라우저 테스트 2 passed (브라우저를 띄울 수 없었으면 보고에 적는다)
- [ ] `git status --short`에 In scope 밖의 수정이 없다
- [ ] `plans/README.md`의 행을 고쳤다

## STOP conditions

- "Current state"의 발췌가 실제 코드와 다르다.
- `DecisionPrompt`의 `request`에 판단 목록의 항목을 넘기면 typecheck가 실패한다.
- `Collapsible`이 `open`과 `onOpenChange`를 받지 않는다.
- 확인 명령이 고친 뒤에도 두 번 실패한다.
- In scope 밖의 파일을 고쳐야 한다.

## Maintenance notes

- `needsUser`의 조건이 "사람을 기다린다"의 정의다. 서버가 `KanbanBoardView`에 사람을 기다리는 새
  상태를 더하면 여기에도 더한다. Plan 014는 Goal의 merge가 실패한 상태를 여기에 더한다.
- 패널의 열림 상태는 보드를 닫으면 잊는다. 다시 열면 다시 "기다리는 대화가 있는가"를 따른다.
- 리뷰에서 볼 곳: 옮긴 두 배지의 문구가 글자 그대로인가(`ko.po`에 새 msgid가 생기지 않아야 한다.
  새로 생기는 것은 "확인할 대화 {attention}" 하나다). `ConversationRow`의 "카드 추가"가 지워졌는가.
- Plan 016이 이 파일의 Sheet를 본문 영역의 틀로 바꾼다. 이 계획이 더한 머리줄 내용은 그대로 옮겨진다.
