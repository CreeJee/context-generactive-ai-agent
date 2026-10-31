# events

## Overview

`events` 디렉터리는 memory-agent의 앱 변경 이벤트 버스를 담당한다. 세션·프로젝트·전역 범위에서 무엇이 바뀌었는지 알리는 이벤트에 단조 증가 revision 번호를 매기고 Effect `PubSub`로 퍼뜨린다. 이 이벤트를 SSE 이벤트(`AppEventFrame`) Stream으로 내고, 앱 API의 `EventsGroup`이 `text/event-stream`으로 보낸다. 이벤트는 실제 데이터가 아니라 페이지 재로딩을 유도하는 advisory 힌트다. `AppEvents` 서비스 레이어는 `SqlClient`로 세션의 `project_id`를 찾아 세션 이벤트에 붙인다.

## Interface

- `AppEvents` — `Context.Service` 태그(`memory-agent/events/app-events/AppEvents`). `AppEvents.layer`는 `SqlClient.SqlClient`가 필요한 `Layer.effect`
- `AppEventsApi` — publish/publishSession/publishProject/publishGlobal/revision 및 sessionStream/projectStream/globalStream/allStream 스트림 메서드를 가진 서비스 인터페이스
- `makeAppEvents` — DB 없이 세션→프로젝트 조회가 항상 null인 `Effect.Effect<AppEventsApi>` (publishSession은 항상 null 반환)
- `AppChangedEvent` / `AppReadyEvent` / `AppHeartbeatEvent` / `AppEventFrame` — 브라우저도 쓰는 `contracts.ts`의 Schema. `AppChangedEvent`는 `scope`("session"|"project"|"global")로 구분되는 판별 유니온이고 각 변형은 `topic`과 `revision`을 포함한다. `AppEventFrame`은 SSE 이벤트 하나(`ready`, `id`가 revision인 `changed`, `heartbeat`)
- `AppEventInput` — `AppChangedEvent`에서 `revision`을 뺀 publish 입력 유니온
- `SessionEventTopic` — "all"|"run-state"|"queue"|"subagents"|"relayed-approvals" (`contracts.ts`, 아래 둘도 같다)
- `ProjectEventTopic` — "all"|"sessions"
- `GlobalEventTopic` — "all"|"auth"|"imports"|"embedding"|"projects"|"kanban"
- `AppEventsApi.publishSession` — 세션의 projectId를 조회해 세션 이벤트 발행. 세션을 모르면 null
- `AppEventsApi.sessionStream`/`projectStream`/`globalStream`/`allStream` — 실행될 때 구독하고, scope·id로 거른 `AppEventFrame` Stream을 돌려줌 (`ready`, `changed`, `heartbeat`)
- `AppEventsApi.revision` — 현재 revision 번호 조회
- 하위 디렉터리 없음

## Invariants

- revision 증가와 `PubSub.publish`는 하나의 `SynchronizedRef.modifyEffect` 락 안에서 함께 일어나야 한다. 그래야 모든 구독자가 revision 순서대로 이벤트를 받는다.
- SSE 구독(`PubSub.subscribe`)과 시작 revision 읽기도 같은 publish 락 안에서 수행해야 한다. Stream을 돌려주기 전에 구독을 마쳐야 직후 발행된 이벤트를 잃지 않는다.
- 스트림의 첫 프레임은 `ready` 이벤트로 구독 시점의 `revision`을 보낸다. 이후 `changed` 프레임은 SSE `id:`에 `event.revision`을 싣는다.
- 스트림은 소유 Scope의 abort signal(`ownerSignal`)이 중단되거나 읽는 쪽이 멈추면 끝난다. 페이지가 연결을 끊으면 HTTP 계층이 응답 본문을 취소해 멈춘다. 종료 시 `Stream.ensuring`으로 구독 Scope를 닫는다.
- 이벤트는 advisory다. `publishSession`의 세션→프로젝트 조회 실패는 `Effect.logWarning`으로만 남기고 null을 반환하며 오류를 전파하지 않는다. 놓친 힌트는 페이지 재로딩만 늦춘다.
- projectId가 truthy가 아니면(`isTruthy`) 세션 이벤트를 발행하지 않는다.
- `AppEvents.layer`는 `SqlClient.SqlClient`를 요구하고 `sessions` 테이블의 `id`, `project_id` 컬럼에 의존한다.
- heartbeat는 15,000ms(`heartbeatMs`) 간격이며 `DateTime.now`(Clock)로 시각을 읽는다.

## Side Effects

- SQLite 읽기: `SELECT project_id FROM sessions WHERE id = ?` (`publishSession` 호출 시)
- 인메모리 상태 변경: `PubSub.unbounded` 이벤트 버스와 `SynchronizedRef` revision 카운터
- 타이머: SSE 연결마다 15초 heartbeat `Effect.sleep` 반복
- 로그: 세션 조회 실패 시 `Effect.logWarning("Session event was not published")`
- 소유 `Scope`가 있으면 `Effect.abortSignal`로 AbortSignal을 얻어 스트림 종료에 사용. SSE마다 별도 `Scope.make()`로 구독 수명 관리

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
