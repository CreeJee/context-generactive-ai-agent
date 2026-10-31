# events

## Overview

`apps/agent/app/entry/events`는 웹 앱 프런트엔드가 서버의 SSE 스트림(`/api/events`)을 구독해 TanStack Query 캐시를 무효화하는 계층이다. `changed`·`ready` 이벤트의 Schema는 앱 API 계약(`memory-agent/app-api`의 `AppChangedEvent`, `AppReadyEvent`)을 쓴다. `event-source.ts`는 네이티브 `EventSource`를 감싸 페이로드를 동기 디코드한다. `invalidation.ts`·`query-keys.ts`는 revision 기준으로 이벤트를 `apps/agent/app/entry/queries/keys`의 쿼리 키 목록으로 바꾼다. `providers.tsx`·`context.ts`는 React Provider와 Context로 연결 상태와 세션 스코프(projectId/sessionId)를 하위 컴포넌트에 노출한다.

## Interface

- `connectAppEvents(options)` — `EventSource`를 열고 `ready`·`changed` 이벤트를 디코드해 콜백으로 넘긴다. 반환값은 멱등 close 함수이다. `createSource` 주입과 `AbortSignal`을 지원한다.
- `ConnectAppEventsOptions` — `url`, `signal`, `createSource`, `onChanged`, `onReady`, `onStatus`, `onDecodeError` 옵션 인터페이스이다.
- `EventConnectionState` — `"connecting" | "live" | "reconnecting"` 연결 상태 타입이다.
- `AppEventDecodeFailed` — 이벤트 디코드 실패 TaggedError이다. 필드는 `event`(`changed`/`ready`)와 `reason`(`not_message`/`invalid_payload`)이고, 페이로드는 보관하지 않는다.
- `createEventInvalidator` — `Function.dual(2)` 형태이다. `(invalidate, root)`를 받아 `{ ready(revision), changed(event) }` 무효화기를 만든다.
- `QueryKey` — `readonly unknown[]` 쿼리 키 타입이다.
- `invalidationKeys(event)` — `AppChangedEvent`를 무효화할 `AppQueryKey` 목록으로 매핑한다.
- `appQueryKeys` / `AppQueryKey` — `../queries/keys`에서 재수출한 쿼리 키 팩토리와 타입이다.
- `AppEventsProvider` — `/api/events` 스트림 하나를 구독하는 React Provider이다. 스트림은 global·project·session 무효화를 모두 싣는다. `EventConnectionContext`로 연결 상태를 제공한다.
- `SessionEventsProvider` — `projectId`/`sessionId`를 `SessionEventScopeContext`로 제공하는 Provider이다.
- `EventConnectionContext` / `useEventConnection()` — 연결 상태 Context와 hook이다. 기본값은 `"connecting"`이다.
- `SessionEventScopeContext` / `useSessionEventScope()` — 세션 스코프 Context와 hook이다. 기본값은 `{ projectId: null, sessionId: null }`이다.
- `useProjectScope(consumer)` — 현재 projectId를 반환한다. 값이 없으면 `ProjectScopeMissing`을 throw한다.
- `ProjectScopeMissing` — 세션 뷰가 프로젝트 스코프 밖에서 렌더링될 때 쓰는 TaggedError이다. `consumer`는 `chat`,`delegated_work`,`message_queue`,`relayed_approval`,`run_state`,`session_lease`,`work_trace` 중 하나이다.

## Invariants

- 무효화기는 revision 단조성을 지킨다. `changed`에서 `event.revision <= 마지막 revision`이면 무시한다. 첫 `ready`이거나 `ready` revision이 기억한 값과 다르면 root 키 전체를 무효화한다. 근거는 "ready repairs missed events" 주석이다.
- 첫 `ready`는 초기 쿼리와 구독 사이의 공백을 메우려고 반드시 root를 무효화한다. revision이 `null`인 동안의 `changed`는 항상 적용된다.
- `invalidationKeys`의 키 연쇄는 주석에 근거한다. global `auth`는 `auth`와 `accountsRoot`를 함께 무효화한다. project `sessions`는 `sessions`와 `boards`를 함께 무효화한다. session `run-state`는 runState·board·session decisions·project decisions·project boards·kanban을 함께 무효화한다. 근거는 "Board changes are saved Plan changes"와 "Card decisions move cards" 주석이다. topic을 추가하면 이 매핑도 함께 바꿔야 한다.
- session scope의 마지막 분기는 `relayed-approvals`를 암묵적으로 `approvals`로 매핑한다. `SessionEventTopic`에 새 값을 넣으면 이 fallthrough가 잘못 매핑할 수 있다.
- 디코드는 네이티브 EventSource 경계에서 동기(`Schema.decodeUnknownResult` + `Schema.fromJsonString`)로 한다. 실패는 throw하지 않고 `onDecodeError` 콜백으로만 전달한다.
- `connectAppEvents`의 close는 멱등이다. 이미 abort된 signal을 받으면 즉시 close한다.
- `useProjectScope`는 React render가 실패를 반환할 수 없어서 throw한다. 근거는 주석이다. 세션 뷰는 반드시 projectId가 있는 `SessionEventsProvider` 아래에서 렌더링해야 한다.
- `AppEventsProvider`는 SSE 스트림 하나(`/api/events`)로 모든 scope를 받는다. 탭이 hidden이면 연결을 끊고, visible이 되면 재연결한다. 재연결 뒤에도 같은 invalidator 인스턴스를 유지하므로 revision 비교가 이어진다.

## Side Effects

- 네트워크: `new EventSource(url)`로 `/api/events` SSE 연결을 연다. 탭 visibility 변화와 unmount 때 `source.close()`로 닫는다.
- DOM: `document`에 `visibilitychange` 리스너를 등록하고 해제한다. `document.hidden`을 읽는다.
- AbortSignal에 `abort` 리스너를 등록하고 해제한다.
- TanStack Query 캐시: `queryClient.invalidateQueries({ queryKey })`로 쿼리를 무효화해 재요청을 일으킨다.
- React 상태: `setConnection`으로 연결 상태(`connecting`/`live`/`reconnecting`)를 갱신한다.
- 무효화기 클로저 안에 마지막 revision을 가변 상태로 보관한다.

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트)
