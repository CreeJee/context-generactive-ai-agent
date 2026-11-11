# events

## Overview

`apps/agent/app/entry/events`는 웹 앱 프런트엔드가 서버의 SSE 스트림(`/api/events`)을 구독해 TanStack Query 캐시를 무효화하는 계층이다. `changed`·`ready` 이벤트의 Schema는 앱 API 계약(`memory-agent/app-api`의 `AppChangedEvent`, `AppReadyEvent`)을 쓴다. `event-source.ts`는 네이티브 `EventSource`를 감싸 페이로드를 동기 디코드하고, 끊긴 스트림을 스스로 다시 연다. `invalidation.ts`·`query-keys.ts`는 revision 기준으로 이벤트를 `apps/agent/app/entry/queries/keys`의 쿼리 키 목록으로 바꾼다. `providers.tsx`·`context.ts`는 React Provider와 Context로 연결 상태와 세션 스코프(projectId/sessionId)를 하위 컴포넌트에 노출한다.

## Interface

- `appEvents(options)` — 탭이 보이는 동안 스트림 하나를 열어 두는 Effect이다. 끝나지 않고, interrupt하면 source를 닫는다. `ready`·`changed` 이벤트를 디코드해 콜백으로 넘기고, 연결 상태를 `onStatus`로 알린다. 끊기면 1·2·5·10초 뒤, 그 뒤로는 30초마다 다시 연다. 기다리는 동안 window `online`, 탭이 다시 보임, `reconnectNow`가 오면 곧바로 연다.
- `ConnectAppEventsOptions` — `url`, `createSource`, `page`(`visibilitychange`·`hidden`을 읽을 document와 `online`을 받을 window, 기본값은 브라우저의 것), `onChanged`, `onReady`, `onStatus` 옵션 인터페이스이다.
- `EventConnection` — 연결 상태 union이다. `connecting`(처음, 그리고 숨겼던 탭이 다시 보일 때), `live`, `reconnecting`(끊긴 지 30초 안), `unreachable`(30초 넘게 연결하지 못함, `nextAttempt`를 가짐).
- `NextAttempt` — `unreachable`의 다음 시도이다. `waiting`은 `seconds` 뒤에 시도하고 `reconnectNow()`로 당길 수 있다. `trying`은 지금 시도하는 중이다.
- `createEventInvalidator` — `Function.dual(2)` 형태이다. `(invalidate, root)`를 받아 `{ ready(revision), changed(event) }` 무효화기를 만든다.
- `QueryKey` — `readonly unknown[]` 쿼리 키 타입이다.
- `invalidationKeys(event)` — `AppChangedEvent`를 무효화할 `AppQueryKey` 목록으로 매핑한다.
- `appQueryKeys` / `AppQueryKey` — `../queries/keys`에서 재수출한 쿼리 키 팩토리와 타입이다.
- `AppEventsProvider` — `/api/events` 스트림 하나를 구독하는 React Provider이다. 스트림은 global·project·session 무효화를 모두 싣는다. `EventConnectionContext`로 연결 상태를 제공한다. 연결이 끊겨 다시 연결하는 동안(`reconnecting`)에는 화면 위에 다시 연결하는 중이라는 띠를 spinner와 함께 띄운다. 30초가 지나면(`unreachable`) spinner를 멈추고 서버에 연결할 수 없다는 문구, "다음 시도 n초 뒤", "지금 다시 연결" 버튼을 보인다. 서버 재시작 띠가 떠 있으면 그 띠에 맡긴다. 다시 연결되면 `ready`가 놓친 변경을 무효화한다.
- `SessionEventsProvider` — `projectId`/`sessionId`를 `SessionEventScopeContext`로 제공하는 Provider이다.
- `EventConnectionContext` / `useEventConnection()` — 연결 상태 Context와 hook이다. 기본값은 `{ _tag: "connecting" }`이다.
- `SessionEventScopeContext` / `useSessionEventScope()` — 세션 스코프 Context와 hook이다. 기본값은 `{ projectId: null, sessionId: null }`이다.
- `useProjectScope(consumer)` — 현재 projectId를 반환한다. 값이 없으면 `ProjectScopeMissing`을 throw한다.
- `ProjectScopeMissing` — 세션 뷰가 프로젝트 스코프 밖에서 렌더링될 때 쓰는 TaggedError이다. `consumer`는 `chat`,`delegated_work`,`message_queue`,`relayed_approval`,`run_state`,`session_lease`,`work_trace` 중 하나이다.

## Invariants

- 무효화기는 revision 단조성을 지킨다. `changed`에서 `event.revision <= 마지막 revision`이면 무시한다. 첫 `ready`이거나 `ready` revision이 기억한 값과 다르면 root 키 전체를 무효화한다. 근거는 "ready repairs missed events" 주석이다.
- 첫 `ready`는 초기 쿼리와 구독 사이의 공백을 메우려고 반드시 root를 무효화한다. revision이 `null`인 동안의 `changed`는 항상 적용된다.
- `invalidationKeys`의 키 연쇄는 주석에 근거한다. global `auth`는 `auth`와 `accountsRoot`를 함께 무효화한다. global `downloads`는 `downloads`와 `embedding`을 함께 무효화한다(적재가 끝나면 임베딩 모델이 도는 곳도 바뀐다). project `sessions`는 `sessions`·`boards`·`running`을 함께 무효화한다. session `run-state`는 project running·runState·board·session decisions·project decisions·project boards·kanban을 함께 무효화한다. 근거는 "Board changes are saved Plan changes"와 "Card decisions move cards" 주석이다. topic을 추가하면 이 매핑도 함께 바꿔야 한다.
- session scope의 마지막 분기는 `relayed-approvals`를 암묵적으로 `approvals`로 매핑한다. `SessionEventTopic`에 새 값을 넣으면 이 fallthrough가 잘못 매핑할 수 있다.
- 디코드는 네이티브 EventSource 경계에서 동기(`Schema.decodeUnknownResult` + `Schema.fromJsonString`)로 한다. MessageEvent가 아니거나 약속한 이벤트가 아닌 페이로드는 throw하지 않고 버린다.
- `useProjectScope`는 React render가 실패를 반환할 수 없어서 throw한다. 근거는 주석이다. 세션 뷰는 반드시 projectId가 있는 `SessionEventsProvider` 아래에서 렌더링해야 한다.
- `AppEventsProvider`는 SSE 스트림 하나(`/api/events`)로 모든 scope를 받는다. 탭이 hidden이면 연결을 끊고, visible이 되면 재연결한다. 끊긴 동안 숨긴 탭은 시도하지 않고, 다시 보이면 곧바로 시도한다.
- 다시 연결은 브라우저가 아니라 `appEvents`가 맡는다. 네이티브 `EventSource`는 HTTP 오류 응답(백엔드가 내려가 dev proxy가 답한 502 등) 뒤에는 다시 시도하지 않으므로, `error`가 오면 source를 닫고 정해진 간격으로 새 source를 연다. 그래서 띠가 다음 시도까지 남은 시간을 말할 수 있다. 열렸던 스트림이 끊기면 간격을 1초부터 다시 센다. 30초는 처음 끊긴 때부터 센다.
- 연결 상태는 `appEvents`의 Effect 안에서만 바뀌고, React는 `onStatus`로 받은 값을 그린다. `open` 리스너는 source를 만드는 같은 단계에서 등록해, 연결 결과가 리스너보다 먼저 오지 않게 한다. 재연결 뒤에도 같은 invalidator 인스턴스를 유지하므로 revision 비교가 이어진다.

## Side Effects

- 네트워크: `new EventSource(url)`로 `/api/events` SSE 연결을 연다. `error`, 탭 숨김, unmount 때 `source.close()`로 닫고, 끊긴 동안 시간이 되면 새 source를 연다.
- DOM: `document`에 `visibilitychange`, `window`에 `online` 리스너를 등록하고 해제한다. `document.hidden`을 읽는다.
- TanStack Query 캐시: `queryClient.invalidateQueries({ queryKey })`로 쿼리를 무효화해 재요청을 일으킨다.
- React 상태: `setConnection`으로 연결 상태(`EventConnection`)를 갱신한다. `unreachable`인 동안은 남은 초를 1초마다 갱신한다.
- 무효화기 클로저 안에 마지막 revision을 가변 상태로 보관한다.

## Verification

- Run: `vp run agent#typecheck` (저장소 루트)
- Run: `vp test` (`apps/agent`에서)
- Run: `vp run test:browser` (저장소 루트, 브라우저 테스트). 띠만 볼 때는 `vp test --config apps/agent/vite.browser.config.ts --run providers`
