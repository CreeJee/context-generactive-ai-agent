# chat-state

## Overview

`chat-state`는 채팅 상태의 시작 시 준비와 화면 메시지(shown message)의 페이지를 맡는 디렉터리다. `ChatState` 서비스는 시작할 때 `chat_threads`가 없는 세션을 노드·첨부에서 복원하고, 이전 프로세스가 남긴 실행과 인터럽트를 정리한다. 권위 있는 transcript(`chat_thread_messages`, 메시지 한 개당 한 행) 옆에 화면 메시지 행(`chat_thread_display_messages`)을 둔다. 화면 메시지 하나는 transcript의 연속 구간이다. 행은 그 구간이 시작하는 메시지 순번(`first_message_seq`)과 화면 id(`display_id`)만 담고, 메시지 사본은 담지 않는다. 페이지는 자기 화면 메시지의 메시지 행만 transcript에서 읽는다. `snapshot.ts`의 `chatSnapshot`은 `RunStore`를 통해 이 페이지를 읽어 채팅 API의 `ChatSnapshot`(메시지, 다음 커서, 진행 중 run, 대기 중 승인)으로 바꾼다.

## Interface

- `ChatState` — Context.Service(`memory-agent/chat-state/chat-state/ChatState`), `ChatState.layer`. 시작 시 누락 스레드 복원·화면 메시지 준비·재시작 정리를 하고 `prepare(sessionId)`를 제공한다. SqlClient, Nodes, Attachments가 필요하다.
- `displayMessages` — `Effect` (SqlClient 필요). `{ isCurrent(threadId), rewrite(threadId, messages, from), prepare(threadId?) }`를 돌려준다.
  - `isCurrent`: 저장된 thread의 화면 메시지가 지금 transcript의 것인지(`display_format`이 현재 판이고 `display_revision`이 `revision`과 같은지).
  - `rewrite`: 메시지 `from`이 든 화면 메시지부터 다시 쓰고 최신으로 표시한다. `from`이 0이면 모두 다시 만든다. 호출자 트랜잭션 안에서 부른다.
  - `prepare`: 최신이 아닌 모든 thread(또는 `threadId`)의 화면 메시지를, 메시지 행의 role·id만 읽어(`json_extract`) 다시 만든다.
- `displayStarts` — dual 함수 `(messages, start)`. `start`부터 화면 메시지를 시작하는 메시지 순번들. `start`의 메시지는 화면 메시지를 시작해야 한다.
- `displayIds` — `({ threadId, messages, starts, taken })`. 새 화면 메시지의 id들. `taken`은 남겨 둔 화면 메시지가 가진 id다.
- `displayFormat` — 화면 메시지 행을 만드는 규칙의 판(지금 1). 다른 판으로 만든 thread는 다시 만든다.
- `MessageIdentity` — 묶을 때 읽는 메시지의 `role`과 `id`.
- `HistoryPageReader` — Context.Service, `.layer`. `read(HistoryPageRequest)`가 `HistoryPageSnapshot`을 돌려주거나 `HistoryPageReadFailed`로 실패한다.
- `HistoryPageRequest` — TaggedUnion `initial{threadId, limit}` | `older{threadId, limit, before}`. limit은 양의 정수다.
- `HistoryPageSnapshot` — TaggedUnion `not-ready{reason: unprepared|stale|unsupported-format}` | `unknown-cursor` | `page{shown, truncated, nextCursor}`. `shown`의 항목은 `{seq, displayId, messages}`이고 `messages`는 JSON 배열 텍스트다.
- `HistoryPageRows` — 페이지 SQL 행 스키마. 최소 1행이며 page 열(`seq`, `display_id`, `messages`)은 모두 null이거나 모두 값이 있다.
- `HistoryPageReadReason` / `HistoryPageReadFailed` — 읽기 실패 사유 `InvalidRequest` | `SqliteRead{phase:'query'}` | `InvalidSnapshot`.
- `HistoryPageUnavailable` — Schema.TaggedError. reason은 `not-ready`. 저장된 thread의 화면 메시지가 최신이 아닐 때 `chatSnapshot`이 낸다.
- `historyPageQueries` — `initial`/`older` 페이지를 읽는 단일 문 CTE SQL(state, page MATERIALIZED, 화면 메시지마다 메시지 행 `group_concat`, has_earlier).
- `chatSnapshot` — `Effect.fn("chatSnapshot")(threadId, limit, before)`. RunStore로 페이지·대기 인터럽트·활성 run을 읽어 `ChatSnapshot`을 만든다.
- `shownMessage` — 화면 메시지 하나(`id`, 비어 있지 않은 StoredMessage 배열)를 `ChatMessage`(role, parts)로 바꾼다.

## Invariants

- 기존 `chat_threads` 행은 권위 있는 원본이다. 덮어쓰지 않는다(`INSERT OR IGNORE`). 세션 id가 곧 thread id로 유지된다.
- 단일 프로세스가 DB를 소유한다고 가정한다. 시작 시 `running`/`interrupted` run은 `failed`(serverRestartedCode)로 바꾸고, 그 run의 pending 인터럽트는 같은 트랜잭션에서 `cancelled`로 바꾼다.
- 묶는 규칙:
  - 사용자 메시지는 새 화면 메시지를 시작한다.
  - assistant 메시지는 앞 assistant 화면 메시지에 붙거나 새로 시작한다. 그 화면 메시지의 첫 메시지 id와 같은 id이거나, `{그 id}-segment-`로 시작하는 id면 붙는다.
  - tool 결과는 다음 사용자 메시지 전까지 앞 assistant 화면 메시지에 붙는다. 앞에 assistant가 없는 tool 결과는 혼자 화면 메시지가 된다.
  - 붙는 대상은 늘 마지막 화면 메시지다. 그래서 화면 메시지는 transcript의 연속 구간이다.
  - 묶기는 모델 transcript를 고치지 않는다.
- 화면 메시지를 시작하는 메시지가 무엇을 시작하는지는 그 메시지만으로 정해진다. 그래서 `rewrite`는 `from` 앞에서 시작하는 마지막 화면 메시지와 그 앞을 그대로 둔다. 다시 묶기는 그 화면 메시지의 첫 메시지부터 한다.
- 화면 id:
  - 첫 메시지의 id가 비어 있지 않고 아직 아무도 쓰지 않았으면 그 id다.
  - 아니면 기준 id와 `{기준}:fallback:{n}` 중 처음 빈 것이다. 기준 id는 첫 메시지의 id이고, 없으면 `stored:{threadId}:{seq}`다.
  - 만든 id는 thread의 어느 메시지에도 실린 id를 피한다.
  - 한 번에 만드는 화면 메시지 사이에서는 메시지가 가진 id가 먼저다.
- 남겨 둔 화면 메시지의 id는 다시 매기지 않는다. 새 메시지의 id가 이미 쓰였으면 새 메시지가 fallback id를 받는다. id 충돌로 페이지를 잃지 않는다.
- `stored:{threadId}:{seq}[:fallback:{n}]` 형식은 이미 공개된 커서다. 바꾸면 열린 페이지의 커서가 깨진다.
- 최신 판정:
  - 화면 메시지는 `display_revision`이 thread의 `revision`과 같을 때 최신이다.
  - 메시지 행이 바뀌면 트리거가 `revision`을 새 값으로 바꾼다. 그래서 `RunStore`가 아닌 writer가 메시지를 넣거나 지우면 화면 메시지는 최신이 아니게 된다.
  - 메시지 행 UPDATE가 각 메시지의 role과 id를 그대로 두면 트리거가 `display_revision`도 새 revision으로 옮긴다. 비밀 정리가 글을 가리는 경우가 그렇다. 페이지는 가려진 글을 행에서 읽는다.
- `prepare`는 시작·임포트 때만 명시적으로 부른다. 페이지 읽기의 fallback으로 쓰지 않는다. 메시지 순번이 0부터 이어지지 않거나 role이 user/assistant/tool이 아닌 thread는 페이지 없이 둔다. 그래도 다른 thread 준비는 막지 않는다.
- 페이지 SQL은 한 문장으로 state와 page를 함께 읽는다.
  - 비어 있거나 최신이 아니거나 커서를 모르는 경우에도 state 행 하나를 null page 열과 함께 돌려준다. 그래서 빈 transcript와 구분된다.
  - `display_format`이 0(없음)이면 unprepared, 현재 판이 아니면 unsupported-format, `display_revision`이 다르면 stale이다.
- 화면 메시지의 메시지 구간은 다음 화면 메시지의 `first_message_seq` 전까지다. 화면 메시지 순번(`seq`)은 0부터 빈틈없이 이어진다.
- 리더는 모델 메시지 JSON을 파싱하지 않는다. 화면 메시지의 메시지 디코드는 `snapshot.ts`(`StoredShownMessages`)가 맡는다.
- `chatSnapshot`에서 `not-ready`일 때 한 번도 저장되지 않은 스레드는 빈 메시지를 돌려준다. 저장된 스레드면 `HistoryPageUnavailable{not-ready}`로 실패한다. `unknown-cursor`는 빈 메시지를 돌려준다.
- `ChatState.make`의 시작 순서: 누락 스레드 materialize 트랜잭션, 화면 메시지 `prepare()`, 재시작 run/인터럽트 정리 트랜잭션.

## Side Effects

- SQLite 쓰기(시작 시): `sessions`에 있고 `chat_threads`에 없는 행에 `INSERT OR IGNORE INTO chat_threads`를 실행하고, 새로 만든 thread에만 메시지 행을 넣는다(트랜잭션).
- SQLite 쓰기(시작 시): `UPDATE chat_interrupts SET status='cancelled'`, `UPDATE chat_runs SET status='failed', error, error_code`를 한 트랜잭션에서 실행한다.
- SQLite 쓰기:
  - `rewrite`가 `chat_thread_display_messages`의 꼬리를 지우고 새 행을 500행씩 넣는다. 그리고 `chat_threads`의 `display_revision`·`display_format`을 갱신한다.
  - `prepare`는 thread마다 트랜잭션 하나로 `rewrite(…, 0)`을 한다.
- SQLite 읽기:
  - `sessions`, `chat_threads`, `chat_thread_display_messages`.
  - `chat_thread_messages`: `prepare`는 `json_extract`로 role·id만, 페이지는 자기 구간의 행만 읽는다.
  - Nodes 서비스로 세션 노드를, Attachments 서비스로 노드별 첨부를 읽는다.
- `Clock.currentTimeMillis`로 updated_at, resolved_at, finished_at 시각을 읽는다.
- `chatSnapshot`은 `RunStore`(`historyPage`, `threadSaved`, `pendingInterrupts`, `activeRun`)를 거쳐 DB를 읽는다.

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
