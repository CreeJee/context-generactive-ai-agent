# session

## Overview

`apps/agent` 프론트엔드(React)의 채팅 세션 화면이 쓰는 클라이언트 측 훅과 표시 로직을 모은 디렉터리다. 세션 소유권(lease) 획득·갱신·반납, 메시지 큐 조회와 편집, 실행(run)·워크플로 상태 조회와 취소, 작업 추적(work trace) SSE 구독, 실행 결과 안내(`RunNotice`)와 실패 문구를 맡는다. 서버 상태는 `apps/agent/app/entry/queries/session`의 TanStack Query 훅과 `apps/agent/app/entry/api`로 읽고, Promise 경계는 `apps/agent/app/entry/shared/ui-effect`의 `runUiEffect`/`uiPromise`로 Effect에 감싼다.

## Interface

- `useSessionLease(sessionId)` — 세션 소유권 훅. claim, 20초 갱신, pagehide 때 release beacon, 관찰 모드에서 free가 되면 재claim을 맡고 `{ holder, lease, revision, refused, continueHere }`를 돌려준다
- `pageHolder()` — sessionStorage `context-agent:page-holder`에 저장된 이 페이지의 holder 토큰을 읽고, 없으면 새 UUIDv4를 만든다
- `pageIdentity()` — Web Locks로 다른 열린 페이지와 겹치지 않는 holder를 확정하는 모듈 단위 memoized Promise
- `PageLease` — `{ state: "checking" } | LeaseView` 타입
- `orderedLeaseActions()` — 세션별 Semaphore(1)로 같은 세션의 lease 작업을 순서대로 실행하는 함수. `dispose`를 붙여 돌려주고, ManagedRuntime + RcMap으로 만든다
- `useMessageQueue` (dual: `(sessionId, holder, _generating)`) — 큐 스냅샷 훅. `items`, `nextDelivery`, `refresh`, `add(text, attachmentIds, mode)`, `change(id, edit)`를 돌려준다
- `AddOutcome` — `queued | not-running | failed` Data.TaggedEnum. 실행 중 쓴 메시지가 어떻게 처리됐는지 나타낸다
- `isPending(message)` / `isTakenIn(message)` — 큐 메시지 상태 판별. 아직 전달 전인지, `next_turn` 외 경로로 실행에 전달됐는지 본다
- `useRunState` (dual: `(sessionId, holder, generating, page)`) — run/workflow 스냅샷 훅. `cancel`, `refresh`, `setWorkflowPhase`, `controlWorkflow`, `notice`, context/workflow/execution/providerRetry/actions/uncertainRuns를 돌려준다
- `RunNotice` — `cancelled | cancel-pending | restarted | resuming{at} | failed{message,code} | detached | stopped | no-answer` TaggedEnum
- `noticeOf` (dual: `(state, page)`) — `SessionRunState`와 `PageView`로 보여 줄 `RunNotice`를 고르거나 null을 돌려준다
- `PageView` — `{ waitingForApproval, answered }` 페이지 측 정보 인터페이스
- `RunNoticeView({ notice })` — `RunNotice`를 Alert/Marker UI로 그리는 React 컴포넌트. detached일 때 `window.location.reload()` 버튼을 둔다
- `failureLabel(failure: AttemptFailure)` — 실패 이유 태그와 단계를 한국어 한 줄로 만든다. `Match.tagsExhaustive` 사용
- `useDelegatedWork` (dual: `(sessionId, _generating)`) — 서브에이전트와 relay된 승인 목록 스냅샷 훅
- `requesterLabel` — `ApprovalRequester.match`로 승인 요청자(subagent/external_agent) 문구를 만든다
- `useWorkTrace(sessionId)` — 세션 trace 쿼리와 EventSource 구독을 묶은 훅. `{ tasks, connection }`을 돌려준다
- `taskForToolCall` (dual: `(tasks, toolCallId)`) — `parentToolCallId`가 같은 마지막 durable task를 찾는다
- `TraceConnection` — `"connecting" | "live" | "reconnecting"` 타입
- `useProjectTraceConnection` (dual: `(projectId, sessionId, live)`) — 라이브 패널이 보일 때 work-trace SSE로 프로젝트 trace 쿼리를 무효화하고 연결 상태를 돌려준다
- `sessionDraftsAtom` — localStorage 키 `context-agent-session-drafts`에 세션별 미전송 텍스트를 담는 jotai `atomWithStorage`

## Invariants

- 같은 세션의 lease claim/release는 `orderedLeaseActions`의 세션별 `Semaphore.make(1)`로 직렬화된다. `session-lease.ts`의 모든 `leaseAction` 호출은 이 모듈 단위 러너를 거쳐야 한다
- `orderedLeaseActions`는 실패 시 `LeaseActionFailed`를 풀어 원래 Promise rejection 값을 다시 던진다. React 호출자가 네이티브 rejection을 받는다는 계약이다(주석 근거)
- lease 갱신 주기 `renewMs = 20_000`은 서버의 90초 lease 안쪽이어야 한다. 갱신 실패는 `loopRetrySchedule`로 재시도하고(2026-10-18 결정), 재시도가 바닥나면 lease를 `{ state: "free" }`로 두고 관찰 경로가 재claim하게 한다
- holder는 sessionStorage에 두어 새로고침해도 같은 페이지로 취급한다. 복제된 탭은 Web Lock `context-agent:holder:${holder}`가 이미 잡혀 있으면 새 holder로 바꾼다. 이 lock은 페이지가 사라질 때만 풀린다(`Effect.never`)
- `pageIdentity`가 끝나기 전(`identified === false`)에는 claim하지 않는다
- 관찰 모드(`lease.state !== "checking" && !owning`)에서만 `useObservedRunStateQuery`를 켠다. 관찰 결과가 `free`면 claim을 시도하고, 경쟁하는 페이지 중 하나만 서버가 승인한다
- `noticeOf`에서 `serverRestartedCode` 오류 검사를 `lastRun.status` switch보다 먼저 한다. restart는 오류로 기록되고 status는 나중에 바뀔 수 있기 때문이다
- `useRunState.notice`의 우선순위는 `cancelPending`, `generating`(null), `noticeOf(state, page)` 순서다
- `failureLabel`의 reason 매핑은 `Match.tagsExhaustive`로, stage 매핑은 `Record<AttemptFailureStage, string>`로 둔다. memory-agent에 새 태그나 stage가 생기면 여기도 바꿔야 한다
- `useWorkTrace`의 refresh는 `refreshing`/`dirty` 플래그로 invalidate를 한 번에 하나만 돌리고, 도중에 들어온 변경은 루프에서 다시 반영한다. 언마운트할 때 `active = false`로 두고 fiber를 interrupt한다
- 문서가 hidden이면 EventSource를 닫고 `connecting`으로 둔다. 다시 보이면 trace 쿼리를 invalidate한 뒤 cursor로 다시 연결한다
- `useMessageQueue.change`는 편집이 거부되거나 실패해도 오류를 삼키고 refresh해서 서버가 가진 큐를 보여 준다. `add`는 `not_running` ApiError를 `AddOutcome["not-running"]`로 바꾼다
- HMR dispose 때 `runLeaseAction.dispose()`로 lease 러너의 ManagedRuntime을 정리한다

## Side Effects

- sessionStorage 읽기/쓰기: 키 `context-agent:page-holder` (`pageHolder`, `newHolder`)
- localStorage: jotai `atomWithStorage` 키 `context-agent-session-drafts`
- Web Locks API: `navigator.locks.request("context-agent:holder:<holder>", { ifAvailable: true })`. 페이지가 살아 있는 동안 계속 잡고 있다
- 네트워크: `api.leaseAction(sessionId, holder, "claim" | "release")` 호출. pagehide 때는 `navigator.sendBeacon("/api/sessions/<id>/lease", { holder, action: "release" })`를 보낸다
- 타이머: lease 갱신 fiber (`Schedule.spaced(20_000)`, `Effect.delay`, `loopRetrySchedule` 재시도)
- 네트워크: TanStack Query mutation으로 큐 enqueue/edit, run 취소, workflow phase/control 변경 요청
- EventSource SSE: `api.workTraceStreamUrl(sessionId[, cursor])`의 `open`, `trace`, `progress`, `snapshot`, `error` 이벤트를 받아 쿼리를 invalidate한다
- DOM 이벤트 리스너: `window` `pagehide`, `work-trace:changed`, `document` `visibilitychange`
- TanStack Query 캐시: `invalidateQueries`로 세션 trace와 프로젝트 trace를 무효화하고, `getQueryData`로 cursor를 읽는다
- `window.location.reload()`: `RunNoticeView`의 detached 상태 다시 연결 버튼
- 암호 난수: `browserCrypto.randomUUIDv4()`로 holder 토큰을 만든다

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
