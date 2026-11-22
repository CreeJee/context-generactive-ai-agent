# session

## Overview

`apps/agent` 프론트엔드(React)의 채팅 세션 화면이 쓰는 클라이언트 측 훅과 표시 로직을 모은 디렉터리다. 요청에 붙이는 페이지 이름(`pageHolder`), 메시지 큐 조회와 편집, 실행(run)·워크플로 상태 조회와 취소, 작업 추적(work trace) SSE 구독, 실행 결과 안내(`RunNotice`)와 실패 문구를 맡는다. 서버 상태는 `apps/agent/app/entry/queries/session`의 TanStack Query 훅과 `apps/agent/app/entry/api`로 읽고, Promise 경계는 `apps/agent/app/entry/shared/ui-effect`의 `runUiEffect`/`uiPromise`로 Effect에 감싼다.

## Interface

- `pageHolder()` — sessionStorage `context-agent:page-holder`에 저장된 이 페이지의 holder 토큰을 읽고, 없으면 새 UUIDv4를 만든다
- `useMessageQueue` (dual: `(sessionId, holder, _generating)`) — 큐 스냅샷 훅. `items`, `nextDelivery`, `refresh`, `add(text, attachmentIds, mode)`, `change(id, edit)`를 돌려준다
- `AddOutcome` — `queued | not-running | failed` Data.TaggedEnum. 실행 중 쓴 메시지가 어떻게 처리됐는지 나타낸다
- `isPending(message)` / `isTakenIn(message)` — 큐 메시지 상태 판별. 아직 전달 전인지, `next_turn` 외 경로로 실행에 전달됐는지 본다
- `useRunState` (dual: `(sessionId, holder, generating, page)`) — run/workflow 스냅샷 훅. `cancel`, `refresh`, `moveWorkflow`, `controlWorkflow`, `notice`, context/workflow/execution/providerRetry/actions/uncertainRuns를 돌려준다
- `RunNotice` — `cancelled | cancel-pending | restarted | resuming{at} | failed{detail,code} | discarded | detached | stopped | no-answer | reconciled` TaggedEnum. `failed`는 코드 문구를 보이고 `detail`(run 원문)은 접어 둔다. `discarded`는 사용자가 끊어진 승인을 폐기한 run이다
- `noticeOf` (dual: `(state, page)`) — `SessionRunState`와 `PageView`로 보여 줄 `RunNotice`를 고르거나 null을 돌려준다
- `PageView` — `{ waitingForApproval, answered }` 페이지 측 정보 인터페이스
- `RunNoticeView({ notice, onResend })` — `RunNotice`를 Alert/Marker UI로 그리는 React 컴포넌트. detached일 때 `window.location.reload()` 버튼을, failed·stopped·restarted일 때 마지막 사용자 turn을 다시 보내는 "다시 보내기" 버튼(`onResend`가 null이 아닐 때)을 둔다
- `failureLabel(failure: AttemptFailure)` — 실패 이유 태그와 단계를 한국어 한 줄로 만든다. `Match.tagsExhaustive` 사용
- `useDelegatedWork` (dual: `(sessionId, _generating)`) — 서브에이전트와 relay된 승인 목록 스냅샷 훅
- `requesterLabel` — `ApprovalRequester.match`로 승인 요청자(subagent/external_agent) 문구를 만든다
- 문구 — 쓰이는 자리에 Lingui 메시지(`<Trans>`, `` t`…` ``, `msg`)로 쓴다. `app/locales/ko.po`로 추출되고 `lint/wording`이 검사한다.
- `useWorkTrace(sessionId)` — 세션 trace 쿼리와 EventSource 구독을 묶은 훅. `{ tasks, connection, failed }`를 돌려준다
- `activeTaskStatuses` / `runningTasks(tasks)` — 끝나지 않은 작업의 상태 목록과, 그 상태이면서 보관·삭제 요청이 없는 작업만 남기는 필터
- `taskForToolCall` (dual: `(tasks, toolCallId)`) — `parentToolCallId`가 같은 마지막 durable task를 찾는다
- `TraceConnection` — `"connecting" | "live" | "reconnecting"` 타입
- `sessionDrafts(sessionId)` — 세션의 미전송 텍스트 Effect atom 묶음 `{ text, follow }`. `text`를 쓰면 localStorage 키 `context-agent-session-draft:<sessionId>`에 저장하고, 빈 문자열이면 키를 지운다. 페이지가 `follow`를 마운트하면 저장된 값을 읽고, 탭이 다시 보일 때(`visibilitychange`)마다 다시 읽는다
- `draftsIn({ storage, shown })` — `sessionDrafts`를 만드는 함수. 테스트가 storage와 다시 보임 신호를 바꿔 끼운다

## Invariants

- holder는 sessionStorage에 두어 새로고침해도 같다. 서버는 holder로 요청을 거절하지 않는다. 어느 탭이든 대화를 조작한다
- draft는 세션마다 키가 따로라서 탭은 자기가 쓰는 세션의 키만 쓴다. 탭끼리 입력을 따라가지 않는다. 같은 세션은 마지막에 입력한 탭의 값이 남는다(2026-11-02)
- `draft`·`text`·`follow`는 각각 `Atom.family`로 만든다. family는 만든 값을 약하게만 쥐므로, atom 묶음 객체를 family 값으로 두면 GC 뒤 새 atom이 생겨 입력 중인 값이 빈 값으로 깜빡이고 IME 조합이 깨진다. 마운트된 atom은 registry가 쥔다
- 마운트 전에는 draft를 읽지 않는다. 서버 렌더와 첫 클라이언트 렌더가 같은 빈 값이어야 하기 때문이다
- 탭이 다시 보일 때는 이 탭이 그 뒤로 입력하지 않은 draft만 저장값으로 바꾼다. 빈 draft는 입력하지 않은 것으로 본다. 그래서 다른 탭이 보낸 글은 사라지고, 보내고 비운 탭은 다른 탭이 쓴 글을 받는다
- 예전 키 `context-agent-session-drafts`(세션별 Record)는 읽을 때 세션별 키로 옮기고 지운다. 세션별 키에 이미 값이 있으면 덮지 않는다
- `noticeOf`에서 `serverRestartedCode` 오류 검사를 `lastRun.status` switch보다 먼저 한다. restart는 오류로 기록되고 status는 나중에 바뀔 수 있기 때문이다
- `useRunState.notice`의 우선순위는 `cancelPending`, `generating`(null), `noticeOf(state, page)` 순서다. `cancelPending`은 멈추기를 요청했지만 멈추지 않았던 run이 run 상태에 아직 진행 중으로 보일 때만 참이다(쿼리 데이터에서 계산한다)
- `failureLabel`의 reason 매핑은 `Match.tagsExhaustive`로, stage 매핑은 `Record<AttemptFailureStage, string>`로 둔다. memory-agent에 새 태그나 stage가 생기면 여기도 바꿔야 한다
- `useWorkTrace`의 refresh는 `refreshing`/`dirty` 플래그로 invalidate를 한 번에 하나만 돌리고, 도중에 들어온 변경은 루프에서 다시 반영한다. 언마운트할 때 `active = false`로 두고 fiber를 interrupt한다
- 문서가 hidden이면 EventSource를 닫고 `connecting`으로 둔다. 다시 보이면 trace 쿼리를 invalidate한 뒤 cursor로 다시 연결한다
- `useMessageQueue.change`는 편집이 거부되거나 실패하면 refresh해서 서버가 가진 큐를 보여 주고, 그 이유 문구(`MessageDescriptor`)를 돌려준다. 받아들여지면 null이다. ChatPanel은 이유를 입력창 위 알림으로 보인다. `add`는 `not_running` ApiError를 `AddOutcome["not-running"]`로 바꾼다

## Side Effects

- sessionStorage 읽기/쓰기: 키 `context-agent:page-holder` (`pageHolder`, `newHolder`)
- localStorage: 키 `context-agent-session-draft:<sessionId>` 읽기/쓰기/삭제, 예전 키 `context-agent-session-drafts` 읽기·삭제. 접근이 막히면 읽기는 빈 값, 쓰기는 무시한다
- 네트워크: TanStack Query mutation으로 큐 enqueue/edit, run 취소, workflow phase/control 변경 요청
- EventSource SSE: `api.workTraceStreamUrl(sessionId[, cursor])`의 `open`, `trace`, `progress`, `snapshot`, `error` 이벤트를 받아 쿼리를 invalidate한다
- DOM 이벤트 리스너: `window` `pagehide`, `work-trace:changed`, `document` `visibilitychange`
- TanStack Query 캐시: `invalidateQueries`로 세션 trace와 그 아래 작업 상세 쿼리를 무효화하고, `getQueryData`로 cursor를 읽는다
- `window.location.reload()`: `RunNoticeView`의 detached 상태 다시 연결 버튼
- 암호 난수: `browserCrypto.uuidV4()`로 holder 토큰을 만든다

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
