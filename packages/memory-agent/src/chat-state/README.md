# chat-state

## Overview

`chat-state`는 채팅 상태의 시작 시 준비와 UI 히스토리 투영(projection)을 맡는 디렉터리다. `ChatState` 서비스는 시작할 때 `chat_threads`가 없는 세션을 노드·첨부에서 복원하고, 이전 프로세스가 남긴 실행과 인터럽트를 정리한다. 권위 있는 transcript(`chat_thread_messages`, 메시지 한 개당 한 행) 옆에 버려도 되는 파생 테이블(`chat_history_projection`, `chat_history_groups`)을 두고, 화면에 보이는 메시지 단위의 그룹으로 페이지를 나눠 읽게 한다. `snapshot.ts`의 `chatSnapshot`은 `RunStore`를 통해 이 페이지를 읽어 채팅 API의 `ChatSnapshot`(메시지, 다음 커서, 진행 중 run, 대기 중 승인)으로 바꾼다.

## Interface

- `ChatState` — Context.Service(`memory-agent/chat-state/chat-state/ChatState`), `ChatState.layer`. 시작 시 마이그레이션·투영 준비·재시작 정리를 하고 `prepare(sessionId)`를 제공한다. SqlClient, Nodes, Attachments가 필요하다. 레이어가 `NodeCrypto`를 제공한다.
- `historyProjection` — `Effect.fn("HistoryProjection.make")`. 스키마를 설치하고 `{ prepare(threadId?), replace(snapshot) }`를 돌려준다. `replace`는 호출자 트랜잭션에 합류하거나 새 트랜잭션을 연다. SqlClient와 `SecureRandom`이 필요하다.
- `HistorySnapshot` — 투영할 transcript 스냅샷 인터페이스(`threadId`, 읽거나 저장한 시점의 `revision`, `messages`).
- `HistoryPageUnavailable` — Schema.TaggedError. reason은 `not-ready` | `id-collision` | `invalid-transcript`.
- `HistoryProjectionReader` — Context.Service, `.layer`. `read(HistoryPageRequest)`가 `HistoryPageSnapshot`을 돌려주거나 `HistoryProjectionReadFailed`로 실패한다. 파생 데이터만 읽는다.
- `HistoryPageRequest` — TaggedUnion `initial{threadId, limit}` | `older{threadId, limit, before}`. limit은 양의 정수다.
- `HistoryPageSnapshot` — TaggedUnion `not-ready{reason: unprepared|stale|unsupported-format}` | `unknown-cursor` | `page{groups, truncated, nextCursor}`.
- `HistorySnapshotRows` — SQL 스냅샷 행 스키마. 최소 1행이며 page 열은 모두 null이거나 모두 값이 있다.
- `HistoryProjectionReadReason` / `HistoryProjectionReadFailed` — 읽기 실패 사유 `InvalidRequest` | `SqliteRead{phase:'query'}` | `InvalidSnapshot`.
- `historyProjectionSchema` — 투영 테이블 2개와 `chat_threads` 트리거 2개(revision 변경 시 무효화, 삭제 시 정리)를 만드는 DDL(`CREATE ... IF NOT EXISTS`).
- `historyProjectionSql` — 준비·퍼블리시용 SQL 문 모음. `markUnready`, `hasPublication`, `addPublication`, `publication`, `publishIfCurrent`, `updateGroup`, `removeTail`, `removeOrdinal`, `groupIdentities`를 담는다.
- `historyProjectionSnapshots` — `initial`/`older` 페이지를 읽는 단일 문 CTE SQL(state, page MATERIALIZED, has_earlier).
- `groupHistoryMessages` — dual 함수 `(threadId, messages)`. 메시지를 화면 단위 `HistoryGroup`로 묶고 `HistoryGroupingResult`를 돌려준다.
- `historyProjectionMessages` — dual 함수 `(threadId, messages, retainedCursorIds)`. id 없는 메시지에 `stored:{threadId}:{ordinal}` 커서 id를 부여하고, 이미 공개된 커서는 유지한다. `HistoryMessagesResult`를 돌려준다.
- `HistoryGroup`, `HistoryGroupingResult`, `HistoryMessagesResult` — 그룹 타입과 `ready` | `id-collision` Data.TaggedEnum 결과.
- `chatSnapshot` — `Effect.fn("chatSnapshot")(threadId, limit, before)`. RunStore로 페이지·대기 인터럽트·활성 run을 읽어 `ChatSnapshot`을 만든다.
- `shownMessage` — 그룹 하나(`id`, 비어 있지 않은 StoredMessage 배열)를 `ChatMessage`(role, parts)로 바꾼다.

## Invariants

- 기존 `chat_threads` 행은 권위 있는 원본이다. 덮어쓰지 않는다(`INSERT OR IGNORE`). 세션 id가 곧 thread id로 유지된다.
- 투영 SQL은 `chat_threads`나 `user_version`을 바꾸지 않는다. 투영 테이블은 버려도 되고 언제든 재생성할 수 있는 파생 데이터다.
- 단일 프로세스가 DB를 소유한다고 가정한다. 시작 시 `running`/`interrupted` run은 `failed`(serverRestartedCode)로 바꾸고, 그 run의 pending 인터럽트는 같은 트랜잭션에서 `cancelled`로 바꾼다.
- thread의 메시지가 바뀌면(행 INSERT·UPDATE·DELETE) migration의 트리거가 `chat_threads.revision`을 새 값으로 바꾸고, 투영 트리거가 그 변경에 `ready=0`으로 무효화한다. thread 행이 DELETE되면 메시지 행은 FK cascade로, 그룹과 투영 행은 트리거로 지워진다.
- 퍼블리시는 `publishIfCurrent`가 하나 이상의 행을 반환할 때만 성공한다. 이 조건은 thread가 아직 그룹을 만든 transcript의 `revision`이어야 한다는 뜻이다. 0행이면 트랜잭션 전체를 롤백하고 `not-ready`로 실패한다. revision은 모든 thread가 함께 쓰는 카운터(`chat_revision_counter`)에서 받으므로, 지운 뒤 다시 저장된 thread도 예전 revision을 다시 갖지 않는다.
- `prepare`는 revision과 transcript를 한 문장으로 읽는다. writer는 upsert 뒤 같은 트랜잭션에서 revision을 읽어 넘긴다.
- `replace`는 원본 writer의 트랜잭션 안에서 authoritative upsert 직후에 호출해야 한다. 그래야 실패 시 원본과 투영이 함께 롤백된다.
- `prepare`는 시작·임포트 때만 명시적으로 부른다. 페이지 읽기의 fallback으로 쓰지 않는다. 한 스레드가 `HistoryPageUnavailable`로 실패해도 다른 세션 준비는 막지 않는다.
- `replace`는 바뀐 identity만 먼저 지운 뒤 upsert한다. 그래서 `UNIQUE(thread_id, ui_id)` 충돌이 나지 않는다. JSON이 같으면 다시 쓰지 않는다.
- 퍼블리시마다 새 `publication` id(UUIDv4)를 `chat_history_projection`에 기록한다. writer는 최근에 저장한 스레드 4개의 퍼블리시(publication id와 그룹)를 기억한다. 저장된 publication이 기억한 것과 같을 때만 그 그룹을 믿는다. 롤백된 퍼블리시는 이전 id를 남기므로 기억한 것과 어긋나 다시 쓴다.
- 기억한 퍼블리시가 있으면 `replace`는 같은 ordinal에 같은 id와 같은 메시지(필드 값 `===`)를 가진 그룹을 인코딩하지도 쓰지도 않는다. id 없는 메시지는 매번 새 복사본이 되므로 객체가 아니라 필드로 비교한다. `prepare`가 만든 퍼블리시는 기억하지 않는다.
- `publication` 열이 없는 이전 테이블에는 설치 트랜잭션이 `ALTER TABLE ... ADD COLUMN`으로 열을 더한다.
- 이전 페이지의 커서 id는 다시 키를 매기지 않는다. 명시적 id가 충돌하면 `id-collision` 태그 결과를 돌려주고 퍼블리시하지 않는다. 첫 충돌만 보고한다.
- 그룹 규칙: 사용자 메시지는 새 그룹을 시작한다. 이후 assistant 세그먼트(`{id}-segment-`)와 연결된 tool 결과는 다음 사용자 메시지 전까지 그 assistant 그룹에 붙는다. 앞에 assistant가 없는 tool 결과는 혼자 그룹이 된다. 그룹화는 파생 투영에만 쓰고 모델 transcript는 고치지 않는다.
- id 없는 메시지의 레거시 id 형식은 `history-legacy-{sha256(threadId)}-{index}`이고, 커서 형식은 `stored:{threadId}:{ordinal}[:fallback:{n}]`이다. 두 형식을 바꾸면 이미 공개된 커서가 깨진다.
- 리더는 한 SQL 문으로 읽기 스냅샷을 잡는다. 비어 있거나 준비되지 않았거나 커서를 모르는 경우에도 state 행 하나를 null page 열과 함께 반환한다. 그래서 빈 transcript와 구분된다. format_version은 0이면 unprepared, 1이 아니면 unsupported-format이다.
- 리더는 모델 메시지 JSON을 파싱하지 않는다. 고른 그룹의 디코드는 `snapshot.ts`(`StoredHistoryGroup`)가 맡는다.
- `chatSnapshot`에서 `not-ready`일 때 한 번도 저장되지 않은 스레드는 빈 메시지를 돌려준다. 저장된 스레드면 `HistoryPageUnavailable{not-ready}`로 실패한다. `unknown-cursor`는 빈 메시지를 돌려준다.
- `ChatState.make`의 시작 순서: 누락 스레드 materialize 트랜잭션, 투영 `prepare()`, 재시작 run/인터럽트 정리 트랜잭션.

## Side Effects

- SQLite 쓰기(시작 시): `sessions`에 있고 `chat_threads`에 없는 행에 `INSERT OR IGNORE INTO chat_threads`를 실행하고, 새로 만든 thread에만 메시지 행을 넣는다(트랜잭션).
- SQLite 쓰기(시작 시): `UPDATE chat_interrupts SET status='cancelled'`, `UPDATE chat_runs SET status='failed', error, error_code`를 한 트랜잭션에서 실행한다.
- SQLite DDL: `historyProjection()`이 생성 시 `chat_history_projection`, `chat_history_groups` 테이블과 `chat_threads` 트리거 2개를 `CREATE ... IF NOT EXISTS`로 설치한다.
- SQLite 쓰기: `replace`가 `chat_history_groups`를 삭제·삽입·업서트하고 `chat_history_projection`의 ready/format_version/publication을 갱신한다.
- SQLite DDL: `chat_history_projection`에 `publication` 열이 없으면 `ALTER TABLE`로 더한다.
- `SecureRandom.uuidV4`로 퍼블리시 id를 만든다.
- 프로세스 메모리: `historyProjection()` 인스턴스가 `Ref`에 최근 스레드 4개의 퍼블리시 그룹을 들고 있다.
- SQLite 읽기: `sessions`, `chat_threads`, `chat_thread_messages`, `chat_history_*`를 읽는다. Nodes 서비스로 세션 노드를, Attachments 서비스로 노드별 첨부를 읽는다.
- `Clock.currentTimeMillis`로 updated_at, resolved_at, finished_at 시각을 읽는다.
- `chatSnapshot`은 `RunStore`(`historyPage`, `threadSaved`, `pendingInterrupts`, `activeRun`)를 거쳐 DB를 읽는다.
- `groupHistoryMessages`는 `sha256(threadId)`를 동기 해시로 계산한다(순수 계산).

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
