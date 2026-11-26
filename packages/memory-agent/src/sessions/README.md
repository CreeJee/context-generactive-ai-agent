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
- `OrchestratorNotifications` (`orchestrator-notifications.ts`) — 앱의 orchestrator가 사용자 대신 대화의 모델에게 전할 알림(끝난 작업, 다른 대화가 남긴 메시지, 보드의 호출)을 두는 `orchestrator_notifications` 표의 영속 저장소다(docs/decisions.md "앱이 모델에게 전할 알림은 orchestrator notifications에 둔다"). 행은 누가 보냈는가(`sender`: task·conversation·board)와 언제 전달하는가(`delivery`: interrupt·wake·next_run)를 가진다. 사용자가 보낸 메시지는 이 표에 없고 `queued_messages`에 있다. 지금 행을 넣는 보낸 쪽은 conversation(다른 대화가 남긴 메시지, `SessionDispatches`)과 task(끝난 백그라운드 작업, `tools/background.ts`)다. task 행의 payload는 `tools/background-end.ts`의 `BackgroundTaskEnd`다. `put(entry)`는 waiting 행을 쓰고 쓴 행을 돌려준다. `putOnce(entry)`는 보낸 쪽이 정한 id로 waiting 행을 넣고, 그 id의 행이 이미 있으면 그대로 둔다. 자기 기록을 따로 가진 보낸 쪽이 그 기록의 id로 부른다(끝난 백그라운드 작업은 작업 id). 그래서 기록 하나에 알림 행이 하나다. `pending(sessionId)`은 기다리는 행을 오래된 것부터 돌려준다. `wakes(sessionId)`는 기다리고 `delivery`가 wake인 행이 있는지 답한다. 보낸 쪽을 가리지 않고, 사용자가 알림을 멈춘 대화에는 false다. `untold(sessionId, sender, told)`는 기다리는 행 가운데 보낸 쪽이 `sender`이고 대화가 아직 전하지 않은 것(`told`에 id가 없는 것)을 그 보낸 쪽의 타입으로 돌려주고 아무것도 쓰지 않으며, `heard(sessionId, runId, delivered)`는 run이 끝났을 때 `delivered`에 id가 있는 기다리는 행을 그 run이 전한 것으로(delivered) 바꾼다. `deliver(sessionId, runId, ids)`는 기다리는 행을 바로 delivered로 바꾼다. `untold`는 사용자가 알림을 멈춘 대화(`parent_notification_holds`)에 아무 행도 주지 않는다. 저장소를 열 때 알림을 따로 정리하지 않는다: 행은 모델이 그 알림을 전하는 메시지에 답할 때까지 기다린다. 실패는 `NotificationStoreFailed`로 낸다
- `NotificationSender`·`NotificationState` — 알림 행의 보낸 쪽과 상태(waiting·delivered)를 적은 Schema.Literals
- `MessageDelivery` (`message-delivery.ts`) — 메시지를 대화에 언제 전하는가를 적은 Schema.Literals다: interrupt(도는 run을 끊고 바로), wake(쉬는 대화를 깨워서), next_run(어차피 시작하는 다음 run에). 알림 행의 `delivery`가 이 타입이다. 사용자 메시지 큐의 mode도 같은 뜻이지만(steer는 interrupt, queue는 wake) 아직 이 타입을 쓰지 않는다
- `notificationPayloads` — 보낸 쪽에서 payload Schema로 가는 객체 리터럴. 여기에 있는 보낸 쪽만 저장하고 읽는다. `conversation`의 payload는 `ConversationMessage`(projectId, fromSessionId, fromRunId, body)다. `task`의 payload는 둘 가운데 하나이고 `_tag`가 가른다: 끝난 백그라운드 작업(`BackgroundEnd`, `tools/background-end.ts`)과 Work Trace task의 상태 변화(`TaskStatus`, `work-trace/task-status.ts`)
- `taskStatusWrites(sql)` — Work Trace 저장소가 자기 연결로 하는 쓰기 둘이다. task의 상태를 적는 transaction 안에서 알림을 같이 넣으려고 서비스를 거치지 않는다. `putOnce`는 정한 id로 waiting인 상태 변화 행을 넣고 그 id의 행이 이미 있으면 그대로 둔다. `redact(taskId)`는 지운 task의 상태 변화 행에서 summary와 detail을 지운다. 실패는 `NotificationStoreFailed`로 감싸지 않고 연결의 실패 그대로 낸다
- `NotificationEntry`·`NewNotificationEntry` — 읽은 알림 행과 `put`에 넘기는 값의 타입. `sender`가 payload의 모양을 가른다
- `SessionDispatches` (`dispatches.ts`) — 한 대화가 같은 프로젝트의 다른 대화에 남기는 session dispatch에서 받는 대화 검사와 `notify_session` 도구를 맡는다. 저장과 읽기는 `OrchestratorNotifications`가 한다(`sender`가 conversation이고 `delivery`가 next_run인 행). `notify(project, { toSessionId, body })`는 대상 검증(자기 자신·없는 세션·다른 프로젝트·report 대화 거절)을 통과하면 `orchestrator_notifications`에 waiting 행을 넣는다. `pending`·`untold`(보낸 쪽 conversation으로 부른다)·`heard`·`deliver`는 `OrchestratorNotifications`의 같은 메서드를 부르고, 행을 돌려주는 것은 `SessionDispatch`로 바꿔 돌려준다. `OrchestratorNotifications`의 `NotificationStoreFailed`는 `DispatchStoreFailed`로 바꿔 낸다. `notifyToolFor`는 run의 `notify_session` 도구를 묶는다. `SessionDispatches.layer`는 SqlClient와 `OrchestratorNotifications`를 요구한다
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
- 알림을 전했는지는 대화에서 읽는다(docs/decisions.md "알림은 대화에 한 번 넣고, 모델이 답하면 전한 것으로 적는다"). 알림을 전하는 메시지가 그 알림의 id를 가진다(`StoredUserMessage.toldNotifications`). 알림 행에는 어느 run이 가져갔는지를 적지 않는다. run이 가진 대화에 id가 있는 알림은 다시 넣지 않으므로 같은 알림이 두 번 들어가지 않는다.
- 알림 행은 전한 것으로 적을 때까지 waiting이다. `untold`는 아무것도 쓰지 않고, `deliver`·`heard`만 state·delivered_run_id·delivered_at을 쓴다. `heard`는 run이 끝나 대화를 저장한 뒤에 불린다: completed·interrupted로 끝난 run은 그 대화가 전하는 알림을 모두, 실패·취소로 끝난 run은 그 메시지 뒤에 모델의 답이 있는 것만 적는다. 메시지가 대화에 저장되지 않았으면 행은 그대로 기다리고 다음 run이 다시 넣는다.
- `pending`과 `wakes`는 run이 메시지를 대화에 넣은 뒤에도 그 행을 센다: 전한 것으로 적을 때까지 기다리는 행이다.
- `untold`는 보낸 쪽 하나의 행만 준다. run의 hook이 보낸 쪽마다 따로 있기 때문이다(`agent/task-notifications.ts`는 task, `agent/dispatch-notifications.ts`는 conversation). `heard`는 보낸 쪽을 가리지 않는다. 두 hook이 각각 불러도 결과가 같다.
- `putOnce`는 이미 있는 행을 건드리지 않는다. delivered가 된 행을 같은 id로 다시 넣어도 delivered로 남는다.
- `untold`는 사용자가 알림을 멈춘 대화(`parent_notification_holds`)에 아무 행도 주지 않고, 멈춤이 풀린 뒤의 run이 그 행을 받는다. 기다리는 행의 delivered_run_id·delivered_at은 null이다.
- dispatch를 보낸 대화와 프로젝트는 알림 행의 payload 안에 있는 값이다. 보낸 대화가 지워져도 이미 남긴 메시지는 전달된다. 받는 대화(`session_id`)가 지워지면 행도 지워진다. 자기에게 보내는 것은 `notify`의 검사만 막는다.

## Side Effects

- SQLite `sessions` 테이블 INSERT (create, createImported; RETURNING), `imported_sessions` INSERT (createImported)
- SQLite `orchestrator_notifications` INSERT (put; RETURNING, putOnce; ON CONFLICT DO NOTHING), UPDATE (deliver·heard; RETURNING), SELECT (pending·untold·heard·wakes); `parent_notification_holds` SELECT (untold·wakes)
- SQLite `sessions`·`report_sessions` SELECT (dispatch의 받는 대화 검사 `targetOf`)
- SQLite `sessions` 테이블 UPDATE: archived_at (setArchived), model_selection (setModel), worktree_path·branch coalesce (recordOrigin)
- SQLite `sessions`·`imported_sessions` SELECT (get, list) 및 `nodes` 테이블에서 kind='user' 첫 메시지 SELECT (제목 보정)
- `Projects.get` 호출로 프로젝트 조회
- NodeCrypto로 UUIDv4 난수 생성 (세션 id), UUIDv7 생성 (알림 행 id)
- `Clock.currentTimeMillis`로 현재 시각 읽기

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
