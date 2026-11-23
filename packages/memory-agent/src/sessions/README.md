# sessions

## Overview

`sessions` 디렉터리는 프로젝트 안의 대화(세션) 레코드를 SQLite `sessions` 테이블에 만들고, 조회하고, 보관(archive)하는 `Sessions` Effect 서비스를 담는다. `title.ts`는 첫 사용자 메시지로 제목을 만든다. `Sessions`는 `Projects` 서비스와 `SqlClient`에 기대며, 라우터와 워커가 세션 생성, 가져오기(import), 소유권 검사에 쓴다.

## Interface

- `Session` — 세션 Schema.Struct(id, projectId, title, createdAt, agent, archivedAt, importedFrom, worktreePath, branch, model)와 같은 이름의 타입. `model`은 대화가 자기 모델로 가진 `ModelSelection`이고, null이면 앱의 선택된 모델을 따른다. 앱 API 계약이 쓰므로 `contracts.ts`에 두고 `sessions.ts`가 다시 내보낸다
- `SessionOrigin` — 대화가 실행된 worktreePath·branch(둘 다 nullable) 인터페이스
- `ImportedTranscript` — 대화를 옮겨 온 다른 도구 transcript의 source·externalId 인터페이스
- `SessionNotFound` — id를 가진 Schema.TaggedError, get·setArchived가 행이 없을 때 실패로 냄
- `Sessions` — Context.Service("memory-agent/sessions/sessions"); `Sessions.layer`는 NodeCrypto.layer를 제공하고 SqlClient·Projects를 요구
- `Sessions.get(id)` — id로 세션 조회, 없으면 SessionNotFound, 제목 없으면 첫 메시지로 채움
- `Sessions.create(projectId, title?, agent?, model?)` — 프로젝트 존재 확인(ProjectNotFound) 뒤 UUIDv4 id·현재 ISO 시각으로 INSERT. `model`을 주면 `model_selection` 열에 JSON으로 적고, 주지 않으면 null이다
- `Sessions.createImported(projectId, title, createdAt, transcript, origin)` — 다른 도구 transcript에서 옮긴 대화를 원래 시작 시각으로 INSERT하고, 같은 transaction에서 transcript 매핑(`imported_sessions`)을 쓴다 (프로젝트 확인 없음)
- `Sessions.recordOrigin(id, origin)` — worktree_path·branch를 coalesce로 비어 있을 때만 채움
- `Sessions.list(projectId, archived = false)` — created_at DESC, id 순; archived=true면 보관된 것만. 하위 에이전트 세션(`parent_session_id`가 있는 행)은 목록에 넣지 않는다
- `Sessions.setArchived(id, archived)` — archived_at을 현재 시각 또는 null로 바꾸고 세션 반환
- `Sessions.setModel(id, model)` — 대화에 자기 모델을 주거나, null이면 지워 앱의 선택된 모델을 다시 따르게 하고 세션 반환(없으면 SessionNotFound). 그 공급자가 모델을 목록에 가지고 있는지는 확인하지 않는다. 호출자가 `ActiveProvider.checked`로 확인한다
- `ClaimResult` — claim 결과 union: { claimed: true } | { claimed: false, heldSince }
- `firstMessageTitle(text)` — 공백을 접고 60자(code point)를 넘으면 잘라 "…"을 붙이며, 빈 문자열이면 "이미지 대화"
- `SessionInbox` (`inbox.ts`) — 사용자가 지금 치지 않았는데 대화에 들어오는 메시지를 두는 세션 inbox(`session_inbox` 표)의 영속 저장소다(docs/decisions.md "대화에 들어오는 메시지는 세션 inbox 하나에 둔다"). 행은 누가 보냈는가(`sender`: user·task·conversation·board)와 언제 전달하는가(`delivery`: interrupt·wake·next_run)를 가진다. `put(entry)`는 waiting 행을 쓰고 쓴 행을 돌려준다. `pending(sessionId)`은 기다리고 어느 run도 claim하지 않은 행을 오래된 것부터 돌려준다. `claim(sessionId, runId)`은 그 행들을 run이 잡고(행의 `claimed_run_id`·`claimed_at` 열), `release`는 claim을 지워 다시 기다리게 하며, `deliverClaimed`는 run이 끝났을 때 잡았던 행을 delivered로 바꾸고 claim을 지운다. `deliver(sessionId, runId, ids)`는 기다리는 행을 바로 delivered로 바꾼다. `claim`은 사용자가 알림을 멈춘 대화(`parent_notification_holds`)에 아무 행도 주지 않는다. 저장소를 열 때 죽은 프로세스가 남긴 claim을 정리한다: 끝난 run(`chat_runs.status`가 completed·interrupted)의 claim은 delivered로 바꾸고 나머지는 claim만 지운다. 실패는 `InboxStoreFailed`로 낸다
- `InboxSender`·`InboxDelivery`·`InboxState` — inbox 행의 보낸 쪽, 전달 시점, 상태(waiting·delivered)를 적은 Schema.Literals
- `inboxPayloads` — 보낸 쪽에서 payload Schema로 가는 객체 리터럴. 여기에 있는 보낸 쪽만 저장하고 읽는다. 지금은 `conversation` 하나이고 그 payload가 `ConversationMessage`(projectId, fromSessionId, fromRunId, body)다
- `InboxEntry`·`NewInboxEntry` — 읽은 inbox 행과 `put`에 넘기는 값의 타입. `sender`가 payload의 모양을 가른다
- `SessionDispatches` (`dispatches.ts`) — 한 대화가 같은 프로젝트의 다른 대화에 남기는 session dispatch에서 받는 대화 검사와 `notify_session` 도구를 맡는다. 저장과 읽기는 `SessionInbox`가 한다(`sender`가 conversation이고 `delivery`가 next_run인 행). `notify(project, { toSessionId, body })`는 대상 검증(자기 자신·없는 세션·다른 프로젝트·report 대화 거절)을 통과하면 inbox에 waiting 행을 넣는다. `pending`·`consume`(inbox의 `claim`)·`release`·`deliverClaimed`·`deliver`는 inbox의 같은 메서드를 부르고 행을 `SessionDispatch`로 바꿔 돌려준다. inbox의 `InboxStoreFailed`는 `DispatchStoreFailed`로 바꿔 낸다. `notifyToolFor`는 run의 `notify_session` 도구를 묶는다. `SessionDispatches.layer`는 SqlClient와 `SessionInbox`를 요구한다
- 문구 — Lingui 런타임 매크로 메시지(`msg`)로 쓰는 곳에 두고 `src/i18n.ts`로 푼다. `src/locales/ko.po`로 추출되고 `lint/wording`가 검사한다

## Invariants

- 제목은 이미 redact된 저장 메시지 텍스트로만 만들고 새 모델 요청을 하지 않는다 (`title.ts` 주석).
- 제목 보정(`withTitle`)은 title이 null이고 importedFrom도 null인 세션에만 한다; 가져온 세션은 첫 메시지로 제목을 채우지 않는다.
- `createImported`는 원 도구가 시작한 createdAt을 그대로 쓴다; 목록이 created_at DESC로 정렬되므로 실제 일어난 자리에 놓이게 하기 위함이다.
- `importedFrom`은 세션 열이 아니라 그 세션의 transcript 매핑(`imported_sessions.source`)에서 읽는다. 세션 하나에 매핑은 많아야 하나다.
- `recordOrigin`은 이미 기록된 worktree_path·branch를 덮어쓰지 않는다 (coalesce).
- `model_selection` 열에 적힌 글자가 지금의 `ModelSelection`으로 읽히지 않으면 그 대화의 `model`은 null이다. 한 행 때문에 목록이나 조회가 실패하지 않는다. 옛 대화는 모두 null이다.
- `createImported`는 `model_selection`을 채우지 않는다.
- `setArchived`는 메시지·메모리·검색을 건드리지 않고 archived_at만 바꾼다; 보관된 세션도 메모리의 일부로 남는다.
- `list`는 archived 여부로 서로 배타적인 집합을 돌려준다: 기본은 보관 안 된 것만, archived=true면 보관된 것만.
- `create`는 `projects.get`으로 프로젝트 등록 여부를 먼저 확인한다; `createImported`는 확인하지 않는다.
- 세션 id는 `SecureRandom.uuidV4`로 만들고 시각은 `Clock.currentTimeMillis`에서 ISO 문자열로 만든다 (`Date.now` 직접 사용 없음).
- `contracts.ts`는 브라우저 번들이 쓰므로 서버 코드를 import하지 않는다.
- inbox 행의 claim은 그 행의 두 열(`claimed_run_id`, `claimed_at`)이다. 별도 표가 아니다. run이 행을 잡고 있는 동안 state는 waiting이다. 잡히지 않은 행만 잡을 수 있으므로 같은 run이 두 번 받지 않고 다른 run이 가로채지도 않는다.
- inbox 행은 전달이 끝날 때까지 waiting이다. `claim`은 state를 바꾸지 않고, `deliver`·`deliverClaimed`와 시작 때의 claim 정리만 state·delivered_run_id·delivered_at을 쓴다. 이때 claim 열도 비우므로 delivered 행에는 claim이 없다. run이 실패·취소로 끝나면 claim을 지워 다시 기다린다.
- `pending`은 claim된 행을 빼고 돌려준다: run이 잡은 행은 그 run이 끝날 때까지 대기 목록에 없다.
- `claim`은 사용자가 알림을 멈춘 대화(`parent_notification_holds`)에 아무 행도 주지 않고, 멈춤이 풀린 뒤 다른 run이 그 행을 잡는다. `release`는 claim 열만 비운다: 돌려준 행의 delivered_run_id·delivered_at은 null로 남는다.
- dispatch를 보낸 대화와 프로젝트는 inbox 행의 payload 안에 있는 값이다. 보낸 대화가 지워져도 이미 남긴 메시지는 전달된다. 받는 대화(`session_id`)가 지워지면 행도 지워진다. 자기에게 보내는 것은 `notify`의 검사만 막는다.

## Side Effects

- SQLite `sessions` 테이블 INSERT (create, createImported; RETURNING), `imported_sessions` INSERT (createImported)
- SQLite `session_inbox` INSERT (put; RETURNING), UPDATE (claim·release·deliver·deliverClaimed·시작 claim 정리; RETURNING), SELECT (pending·claim); `parent_notification_holds` SELECT (claim); `chat_runs` SELECT (시작 claim 정리)
- SQLite `sessions`·`report_sessions` SELECT (dispatch의 받는 대화 검사 `targetOf`)
- SQLite `sessions` 테이블 UPDATE: archived_at (setArchived), model_selection (setModel), worktree_path·branch coalesce (recordOrigin)
- SQLite `sessions`·`imported_sessions` SELECT (get, list) 및 `nodes` 테이블에서 kind='user' 첫 메시지 SELECT (제목 보정)
- `Projects.get` 호출로 프로젝트 조회
- NodeCrypto로 UUIDv4 난수 생성 (세션 id), UUIDv7 생성 (inbox 행 id)
- `Clock.currentTimeMillis`로 현재 시각 읽기

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
