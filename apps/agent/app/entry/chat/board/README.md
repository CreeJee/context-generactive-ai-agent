# board

## Overview

`apps/agent` 프론트엔드(React)의 칸반 보드 UI 디렉터리다. 한 대화의 Plan(세션 보드 시트 `BoardSheet`, `apps/agent/app/entry/chat/board-panel.tsx`) 또는 프로젝트의 모든 실행 중 Plan(`ProjectBoard`, `apps/agent/app/entry/index.tsx`의 `App`이 렌더)을 같은 7개 상태 열에 보여 준다. 카드 드래그(@dnd-kit), 카드 peek 패널, 카드 편집·이동·다른 대화로 옮기기를 맡는다. 드롭 규칙, 낙관적 대기 이동, 보류 사유 문구 같은 순수 로직은 `board-moves.ts`, `hold-reason.ts`에 있다. 서버 호출은 `apps/agent/app/entry/queries`의 React Query mutation/query 훅에 맡긴다.

## Interface

- `BoardSurface` — 하나 또는 여러 Plan의 열, 카드 peek, 거절 알림, 실행 중 카드 변경 요청 프롬프트, 다른 대화로 옮기기 확인을 그리는 공용 보드 컴포넌트다. props는 projectId, holder, boards, shown, peek, onPeek, adding, onDraggingChange, className 등이다
- `SurfaceBoard` — 보드 위 한 Plan의 묶음이다(sessionId, label, view, plan, decisions, loop, rank). label과 rank는 Plan 하나만 보일 때 null이다
- `ActiveKanban` / `BoardPlan` — `KanbanView`의 active 변형과 `BoardView["plan"]`의 non-null 타입 별칭
- `errorText` / `editErrorText` — `ApiErrorCode`(또는 `isApiError` Error)를 한국어 안내 문구로 바꾼다. 모르는 코드는 "보드를 바꾸지 못했어요."로 떨어진다
- `ProjectBoard` — 프로젝트의 모든 실행 중 Plan을 우선순위 트리 순서로 한 보드에 보여 준다. `useProjectBoardsQuery`, `useDecisionInboxQuery`, `useGoalOrderMutation`을 쓰고 `BoardSurface`를 렌더한다
- `KanbanBoard` — 상태 열 7개와 dnd-kit 드래그(마우스, 터치 홀드, 그립 키보드), j/k/h/l·화살표 포커스 이동, 열 접기를 맡는다. 드롭 결과는 onReorder, onSend, onAskChange, onRefused 콜백으로 부모에 넘긴다
- `CardPeek` — 오른쪽 Sheet peek 패널이다. 카드 상세, DecisionPrompt, 보류 사유와 검증 의견, 편집기, 새 카드 폼, 다른 대화로 옮기기 Select, Hold/Release/Requeue 버튼을 보여 준다
- `Peek` — peek 내용을 나타내는 TaggedEnum이다: `New` 또는 `Card{cardId, editing}`
- `TransferTarget` — 카드를 옮길 수 있는 같은 프로젝트의 다른 대화 정보(sessionId, label)
- `CardFace` / `CardSignals` — 보드와 드래그 오버레이가 함께 쓰는 카드 앞면이다. CardSignals는 판단 대기, 변경 요청 대기, 요청 중, 사유, 의존 카드 제목, 그룹을 담는다
- `StatusIcon` / `AuthorAvatar` / `authorLabel` / `riskLabels` — 상태 아이콘, 마지막 변경자(User/Orchestrator) 아바타와 라벨, 위험도 라벨
- `BoardCard` / `BoardCardRef` / `boardCardKey` / `parseBoardCardKey` — 보드 카드 타입과 (sessionId, cardId) 참조, `${sessionId}:${cardId}` 키 생성과 파싱
- `BoardItem` / `boardItem` — sessionId와 보드 전체에서 고유한 key를 붙인 카드다. boardItem은 `Function.dual` 생성자다
- `cardStatusLabels` / `boardColumns` — `CardStatus` 한국어 라벨과 왼쪽에서 오른쪽 열 순서(backlog, ready, in_progress, verify, human_decision, done, blocked)
- `DropOutcome` / `DropContext` / `dropOutcome` — 카드를 열에 놓았을 때의 의미(Reorder, Send{intent, lands}, AskChange, Refused{reason})를 정하는 TaggedEnum, 그 문맥, dual 판정 함수
- `inProjectOrder` — Goal rank 순서로 정렬하고, 같은 rank 안에서는 원래 Plan 순서를 지킨다. rank가 null인 항목은 뒤로 간다
- `foreignCardDrop` — 다른 대화의 카드 위에 놓은 드롭을 이유와 함께 거절하는 DropOutcome
- `canTransfer` — 카드 상태가 backlog, ready, blocked일 때만 다른 대화 Plan으로 옮길 수 있다
- `PendingMove` / `withPending` — 서버 응답 전 요청(Status, Order, Leaving)을 나타내는 TaggedEnum과, 그 요청을 서버 카드 목록에 반영해 보여 주는 dual 함수
- `verdictText` / `holdReasonText` / `holdReasonNote` — memory-agent의 `VerdictFailure`, `CardHoldReason`(내부 `CardFailure` 포함)을 태그별 한국어 문구로 바꾼다. 모델이 쓴 의견은 holdReasonNote가 따로 돌려준다
- 하위 디렉터리 없음

## Invariants

- 카드 키는 `${sessionId}:${cardId}`다. 세션 id가 UUID이므로 `parseBoardCardKey`는 첫 콜론에서 나눈다. 카드 id에는 어떤 문자든 올 수 있다. 카드 id는 Plan 사이에서 겹칠 수 있으므로 보드에서는 항상 key(`BoardItem.key`)로 식별해야 한다
- 드롭 판정 규칙(`dropOutcome`)은 다음과 같다. closed Plan은 거절한다. 같은 열이면 Reorder다. in_progress는 AskChange다. human_decision, verify, done은 거절한다. ready→backlog는 Hold다. backlog→ready는 `card.hold`가 있을 때만 Release다. 이때 의존 카드가 모두 done이면 ready, 아니면 backlog에 놓인다. blocked→ready는 Requeue다. 나머지 열은 오케스트레이터 전용이라 거절한다
- Send(Hold/Release/Requeue)는 `kanbanActive`(칸반 루프 활성)일 때만 허용된다. 클라이언트 판정은 미리보기일 뿐이고 서버가 intent를 다시 검사한다(주석 근거)
- `dependenciesDone`은 자기 자신 id와 Plan에 없는 의존 id를 무시한다
- 순서 바꾸기는 같은 Plan, 같은 열 안에서만 한다. 다른 대화의 카드 위 드롭은 `foreignCardDrop`으로 거절한다. Goal 순서는 상태 패널에서 바꾼다
- 다른 대화로 옮기기(Transfer)는 `canTransfer`가 참인 상태(backlog, ready, blocked)에서만 UI에 노출된다. 옮긴 카드는 그 대화 Plan의 새 카드가 되고 의존은 끊긴다(UI 문구)
- `withPending`은 서버 응답 전 요청만 화면에 반영한다. 거절되면 pending이 사라지므로 카드는 서버 위치로 돌아간다. Leaving 상태의 카드는 실제로 옮겨질 때까지 제자리에 있다
- `BoardSurface`는 드롭과 이동용 mutation(`request`)과 peek 액션용 mutation(`action`)을 따로 둔다. 그래서 peek 액션의 pending은 peek만 막고 보드는 막지 않는다. 이 분리를 유지해야 한다
- in_progress 카드에 대한 `EditCard`는 보드 편집이 아니라 `BoardIntent.ChangeRequest`로 보낸다. `CancelCard`는 항상 `BoardIntent.Cancel` intent로 보낸다. AddCard, MoveCard, ClosePlan은 `useBoardsEditMutation`으로 보낸다
- `inProjectOrder`는 rank가 있는 항목을 rank 오름차순으로 먼저 놓고, rank가 null인 항목을 뒤에 놓는다. 같은 rank 안에서는 원래 인덱스 순서를 지킨다(안정 정렬)
- hold-reason 문구는 태그로만 고른다. 모델이 쓴 글(검증자 note, GoalChanged note)은 `holdReasonNote`로만 돌려준다. 이 글을 사유 문구에 섞지 말고 의견으로 따로 보여야 한다
- `Match.valueTags`와 `Record<CardStatus|AgentFailureCode|CardRisk, ...>` 테이블은 모든 경우를 다룬다. memory-agent의 `CardHoldReason`, `VerdictFailure`, `CardFailure`, `CardStatus`에 태그나 값이 추가되면 이 파일들도 함께 바꿔야 한다
- 키보드 드래그는 `data-board-grip` 그립에서만 시작한다(`GripKeyboardSensor`). 카드 자체에서 Enter/Space를 누르면 카드를 연다. 충돌 판정은 `pointerWithin`을 먼저 쓰고, 결과가 없을 때 `closestCorners`를 쓴다
- 보드 열은 `boardColumns`의 7개 상태 고정 순서를 따른다. `ProjectBoard`도 같은 7개 열을 쓴다

## Side Effects

- `BoardSurface`: `useBoardsKanbanMutation`(kanban intent: Reorder, Hold, Release, Requeue, ChangeRequest, Cancel, Transfer)과 `useBoardsEditMutation`(보드 편집)으로 서버 API에 네트워크 요청을 보낸다
- `BoardSurface`: 거절 알림을 `Effect.runFork(Effect.sleep("5 seconds"))` 타이머로 5초 뒤 지운다. notice가 바뀌거나 언마운트되면 `Fiber.interrupt`로 타이머를 중단한다
- `ProjectBoard`: `useProjectBoardsQuery`, `useDecisionInboxQuery`로 서버를 조회하고, `useGoalOrderMutation`으로 Goal 순서를 바꾸는 요청을 보낸다(그래프 근거)
- `KanbanBoard`: jotai `atomWithStorage("context-agent-board-collapsed-columns")`로 접은 열 목록을 브라우저 저장소(localStorage)에 브라우저별로 저장한다
- `CardPeek`: `DecisionPrompt`를 렌더하고 onSubmit, onIntent, onTransfer 콜백으로 부모의 서버 요청을 시작한다. 자체 네트워크 호출은 없다
- `board-moves.ts`, `hold-reason.ts`, `card-face.tsx`는 순수 함수와 표시 컴포넌트이고 부수 효과가 없다

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
