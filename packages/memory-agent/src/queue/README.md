# queue

## Overview

`packages/memory-agent/src/queue`는 메시지 큐 계층이다. 에이전트 run이 답하는 동안 사용자가 보낸 후속 메시지(R03)를 SQLite `queued_messages` 테이블에 순서대로 보관한다. `queue.ts`의 `MessageQueue` 서비스는 추가·편집·저장·삭제·확인·다음 턴 예약 같은 상태 전이를 맡는다. `delivery.ts`의 `QueueDelivery`는 tool 호출 결과 직후 run hook(`RunHook.joining`)에서 대기 메시지를 사용자 턴으로 대화에 합류시키고 memory node로 기록한다. `queue-state.ts`는 브라우저에서도 쓰는 상태 타입(TaggedEnum)과 스트림 이벤트 이름을 정의하고, 페이지(`apps/agent`)와 공유한다.

## Interface

- `MessageQueue` — `Context.Service`(`queue.ts`)이며 `MessageQueue.layer`로 제공한다. `SqlClient.SqlClient`, `Crypto.Crypto`가 필요하다. run이 답하는 동안 보낸 후속 메시지를 에이전트에 닿을 때까지 순서대로 보관한다.
- `MessageQueue.list(sessionId, recentRunId)` — 아직 전달되지 않은 메시지와 `recentRunId`로 전달된 메시지를 `seq` 순으로 돌려준다.
- `MessageQueue.snapshot(sessionId, recentRunId?)` — `QueueSnapshot`(items와 `nextDelivery`)을 만든다. 첫 비종결 항목으로 ready/server/blocked/empty를 판단하는 참고용 뷰다.
- `MessageQueue.add(sessionId, text, attachmentIds, steered)` — 끝에 waiting 메시지를 추가한다. steered이면 앞선 waiting 메시지도 모두 steered로 바꾼다(트랜잭션).
- `MessageQueue.get(sessionId, id)` — 단건 조회이며, 없으면 `null`이다.
- `MessageQueue.edit` / `save` / `remove` / `confirm` — 편집 초안 저장, 편집 저장, 삭제, held·failed 메시지 재전송 확인을 한다. 거부하면 `QueueChangeRefused`로 실패한다.
- `MessageQueue.deliverable(sessionId)` — 큐 앞쪽의 waiting 접두부를 돌려준다. editing·held 메시지가 있으면 그 앞까지만 돌려준다.
- `MessageQueue.claimNext(sessionId)` — 현재 head를 원자적으로 골라 전달 또는 명시적 해제 때까지 예약한다. 세션에 예약이 이미 있으면 `null`이다.
- `MessageQueue.markDelivered(id, via, runId)` — 메시지를 delivered로 표시한다.
- `QueueChangeRefused` — `Schema.TaggedError`다. `id`와 `reason: "not_found" | "delivered" | "not_held" | "reserved"`를 가진다.
- `QueueDelivery` — `Context.Service`이며 `QueueDelivery.layer`로 제공한다. `MessageQueue`, `Nodes`, `Attachments`, `SecretRedactor`가 필요하다.
- `QueueDelivery.hookFor(binding)` — `RunHook`(`joining`)을 돌려준다. 대화 마지막 메시지가 tool이면 대기 메시지를 전달하고 CUSTOM 이벤트로 알린다.
- `QueueDelivery.toUserMessage(message)` — 큐 메시지를 모델이 받는 user 턴(텍스트, 첨부 이미지 URL 파트)으로 바꾼다.
- `DeliveryBinding` — `{ projectId, sessionId, runId }` 인터페이스다.
- `queueDeliveredEvent` — `"memory-agent.queue.delivered"` 문자열이다. 이번 run에서 큐 메시지가 에이전트에 닿았음을 페이지에 알리는 커스텀 스트림 이벤트 이름이며, `delivery.ts`에서도 재export한다.
- `QueueItemState` — Schema `TaggedUnion`의 타입과 그 `Data.taggedEnum` 생성자다: `waiting{steered}`, `editing{draft}`, `held{draft|null}`, `delivered{via, runId}`, `failed{reason}`.
- `QueuedMessage` — `{ id, seq, text, attachmentIds, state, createdAt }` Schema다.
- `NextDelivery` — Schema `TaggedUnion`의 타입과 그 `Data.taggedEnum` 생성자다: `ready`, `server`, `blocked{messageId, reason: "editing"|"held"}`, `empty`.
- `QueueSnapshot` — `{ items, nextDelivery }` Schema다.
- `QueueEdit` — 페이지가 요청하는 변경이다: `edit{draft}`, `save{text}`, `remove`, `confirm`. `QueueEdit`은 `Data.taggedEnum` 생성자, `QueueEditRequest`는 요청 본문이 읽는 Schema다.
- `QueueRequest` — 페이지가 run 도중 보내는 메시지 `{ text, attachmentIds, mode: "queue"|"steer" }` Schema다. 앱 API 계약이 쓰므로 `agent/chat.ts`에서 옮겼다.
- `DeliveryVia` — `"tool_boundary" | "steer" | "next_turn"` Schema다. `steer`는 codex 런타임이 제거되기 전의 옛 행에만 있다.

## Invariants

- 큐 순서는 세션별 `seq`다. `insert`는 `seq`를 세션의 `max(seq)+1`로 정한다. 조회는 모두 `ORDER BY seq`이고 전달 순서를 바꾸지 않는다.
- 전달 대상은 waiting 접두부뿐이다. 첫 editing·held 메시지(`min(seq)`)부터 전달이 멈추고, 그 뒤의 메시지는 모두 기다린다.
- steered 메시지를 `add`하면 같은 트랜잭션에서 그 세션의 기존 waiting 행을 모두 `steered = 1`로 바꾼다. steered 메시지는 앞선 메시지를 앞질러 모델에 닿을 수 없다.
- `setState`는 편집을 포함한 모든 상태 변경에서 `steered = 0`으로 되돌린다. 상태가 바뀐 메시지는 steered 경로에서 빠진다.
- `change`는 `pending` 검사, 변경 적용, 재조회를 하나의 `sql.withTransaction`에서 수행한다. `remove`도 `pending` 검사와 DELETE를 한 트랜잭션에서 수행한다.
- `pending`은 없는 메시지(`not_found`), 그 세션에 예약된 메시지(`reserved`), 이미 delivered인 메시지(`delivered`)를 거부한다. delivered 메시지는 다시 바꿀 수 없다.
- `confirm`은 held·failed에서만 waiting으로 바꾼다. waiting·editing·delivered에서는 `not_held`로 거부한다.
- `edit`에서 held는 held로 남고, 그 밖의 상태는 editing이 된다. `save`에서 held는 held로 남고, 그 밖의 상태는 waiting으로 돌아간다. 두 경우 모두 자리(`seq`)를 유지한다.
- `MessageQueue` 레이어를 만들 때(새 프로세스) waiting·editing 행을 모두 `held`, `steered = 0`으로 바꾼다. 재시작 뒤에는 사용자가 확인하기 전까지 아무 메시지도 보내지 않는다.
- 다음 턴 예약은 메모리의 `Ref<HashMap<sessionId, {id, holdOnRelease}>>`에 둔다. 확인과 변경을 하나의 `Ref.modify`에서 하므로 두 fiber가 같은 예약을 잡지 못한다. 세션당 예약은 하나이며, 이 상태는 DB에 저장하지 않는다.
- `snapshot`은 참고용(advisory)이다. 실제 전달 경로는 항상 현재 큐 상태에서 다시 고른다.
- delivered 행의 `delivered_via`가 null이면 `"next_turn"`으로 매핑한다. 테이블 제약이 delivered 행의 전달 방식을 보장한다.
- `QueueDelivery`는 대화 마지막 메시지의 role이 `"tool"`일 때만(`afterTool`) 메시지를 합류시킨다. tool 호출 결과 직후, 다음 모델 단계 전에만 전달한다.
- 전달 순서는 메시지마다 `markDelivered(id, "tool_boundary", runId)` 다음 `record`(node 기록)다. 그다음 찾은 메시지가 있을 때만 `announce`를 하고, 마지막으로 user 턴으로 변환한다. 모두 큐 순서를 따른다.
- 전달된 메시지는 모두 증거로 `nodes.append`(kind `"user"`)에 기록한다. 기록 전에 `SecretRedactor.redactText`로 붙여 넣은 키를 지운다.
- 그사이 삭제된 첨부는 user 턴과 node 링크에서 조용히 빠진다(`attachments.get` 결과의 null은 걸러진다).
- hook의 오류는 `Effect.mapError(asRunFailed)`로 run 실패로 바꾼다.
- `queue-state.ts`는 브라우저에서도 쓰는 모양이다. 서버 전용 모듈(SQL, Node)을 import하면 안 된다.

## Side Effects

- SQLite `queued_messages` 테이블을 SELECT한다(`findOne`, `list`, `deliverable`, `head`).
- SQLite `queued_messages`에 INSERT ... RETURNING을 한다(`add`).
- SQLite `queued_messages`를 UPDATE한다: 상태·text·draft·failure·steered·updated_at 변경(`setState`), steered 일괄 설정(`add`).
- SQLite `queued_messages`에서 DELETE한다(`remove`).
- 레이어 생성 시 SQLite UPDATE를 한 번 수행해 waiting·editing을 held로 바꾼다.
- `Crypto.randomUUIDv4`로 메시지 id를 만든다.
- `Clock.currentTimeMillis`로 `created_at`, `updated_at`을 기록한다.
- 프로세스 메모리의 `Ref` 예약 맵(HashMap)을 변경한다(`claimNext` 등).
- `QueueDelivery`가 `Nodes.append`로 memory node(kind `user`)를 기록한다.
- `QueueDelivery`가 `Attachments.get`, `Attachments.link`로 첨부를 조회하고 node에 연결한다.
- `QueueDelivery`가 `SecretRedactor.redactText`로 텍스트를 가린다.
- `QueueDelivery`가 run 스트림에 CUSTOM 이벤트 `memory-agent.queue.delivered`(`{ ids }`)를 emit한다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
