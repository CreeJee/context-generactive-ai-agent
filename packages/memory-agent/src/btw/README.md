# btw

## Overview

`packages/memory-agent/src/btw`는 메인 대화에서 갈라져 나온 BTW(by the way) 곁질문 스레드를 담당한다. `BtwChat` 서비스는 질문마다 메인 대화(`nodes.session`)를 새로 읽어 시스템 프롬프트에 붙인다. 그 뒤 같은 프로젝트 메모리의 읽기 전용 도구(`find_memory`, `read_evidence`, `trace_evidence`)만으로 `runChat` 루프를 돌린다. 답변·도구 호출·결과는 `btw_threads.messages` 한 곳에만 저장된다. run/interrupt/metadata 행, 기록기, 인덱서, 해석기, 승격 훅은 관여하지 않는다. `BtwThreads`는 SQLite의 `btw_threads`·`btw_attachments` 테이블과 첨부 정리를 맡는다.

## Interface

- `BtwChat` — Effect `Context.Service`(`memory-agent/btw/chat/BtwChat`)이며 `ask`, `messages`, `create`, `list`, `remove`를 제공한다. `BtwChat.layer`는 `Layer.effect(BtwChat, make).pipe(...)`이다
- `BtwChat.ask(threadId, question: BtwQuestion)` — 거부 사유(`Refusal`) 또는 `Stream<AgUiEvent>`를 `Result`로 돌려준다. 거부 사유: `run_in_progress`, `provider_auth_unavailable`, `login_required`, `model_selection_required`, `empty_message`, `unknown_attachment`, `images_not_supported`
- `BtwChat.messages(threadId)` — 저장된 메시지를 패널 표시 단위로 묶어 오래된 순으로 `shownMessage` 형태로 돌려준다. id가 없으면 `btw:${threadId}:${index}`를 쓴다
- `BtwChat.remove(threadId)` — 실행 중인 답변을 취소하고 종료를 기다린다. 그래도 남아 있으면 `BtwRunInProgress`로 실패하고, 아니면 스레드를 삭제한다
- `BtwThreads` — Effect `Context.Service`(`memory-agent/btw/store/BtwThreads`)이며 `BtwThreads.layer = Layer.effect(BtwThreads, make)`이다. 요구 서비스: `SqlClient`, `Sessions`, `Attachments`, `Crypto`
- `BtwThreads.get/messages/saveMessages/create/list/link/remove` — 스레드 조회, 메시지 읽기·저장, 생성, 부모 세션별 목록(최신순), 첨부 연결, 삭제와 고아 첨부 정리
- `btwToolNames` / `BtwToolName` — 허용 도구 이름 `["find_memory", "read_evidence", "trace_evidence"]`과 그 `Schema.Literals`
- `BtwThread` — 스레드 스키마 `{ id, parentSessionId, projectId, title: string|null, createdAt: string, updatedAt: epoch ms }`
- `BtwError` — `reason` 유니온(`BtwThreadNotFound`, `BtwParentNotFound`, `BtwRunInProgress`, `BtwStorageFailed`)을 감싼 TaggedError
- `BtwThreadNotFound` / `BtwParentNotFound` / `BtwRunInProgress` / `BtwStorageFailed` — 개별 TaggedError. `BtwStorageFailed.operation`은 `purge_attachments` | `create_thread` | `read_transcript`이다
- `btwEvidenceRunTools({ env, projectId })` — `memoryReadRunTools`를 `scope: "project"`로 감싼 읽기 전용 도구 목록이다. 런 바인딩이 없다
- `btwToolGuardHook` — 서버 측 허용 목록 `RunHook`이다. 허용되지 않은 도구 호출은 실행하지 않고 `{ error: "btw_tool_not_allowed", tool }`를 결과로 돌려준다
- `btwInstructions` — BTW 시스템 프롬프트 문자열(읽기 전용, 메모리는 단서, 메인 대화에 추가되지 않음 등)
- `parentConversationPrompt` — `EffectFunction.dual` 함수다. 메인 대화의 user/assistant 노드 가운데 예산 안의 최신 메시지를 오래된 순으로 노드 id와 함께 렌더링한다
- `parentContextBudget` — 메인 대화 문맥 예산 상수 `24_000`자
- 하위 디렉터리: 없음

## Invariants

- BTW 스레드는 `btwToolNames`의 세 도구만 호출할 수 있다. 도구 목록은 `btwEvidenceRunTools`만 넘긴다. 그 밖의 이름은 `btwToolGuardHook`가 실행 없이 거부한다. 쓰기·승격·워크플로·파일·셸·서브에이전트는 제공하지 않는다
- `btwEvidenceRunTools`에는 런 바인딩이 없다. 검색·사용·승격 기록이 남지 않아야 한다
- BTW 실행은 `btwStore`를 쓴다. `thread`/`saveThread`는 `btw_threads.messages`를 가리킨다. `startRun`/`endRun`/interrupt 계열은 no-op이다. run·interrupt·metadata 행을 남기지 않는다
- 스레드의 부모 세션 바인딩은 생성 후 바뀌지 않는다(`create` 주석). 생성 시 부모 세션이 없으면 `BtwParentNotFound`로 실패한다
- `saveMessages`는 UPDATE만 한다. 진행 중인 답변이 삭제된 스레드를 되살리지 않는다. 빈 사용자 텍스트 메시지는 저장 전에 거른다
- `remove`는 실행 중인 답변을 먼저 취소하고 `live.ended`를 기다린 뒤 삭제한다. 그때도 live run이 남아 있으면 `BtwRunInProgress`로 실패한다
- 같은 threadId에는 동시에 한 run만 있다. `liveRuns.get` 검사 뒤 `liveRuns.claim`이 null이면 자원을 해제하고 `run_in_progress`로 거부한다
- `ask`의 거부 검사 순서: 스레드 존재 → live run → 인증 error/미로그인 → 모델 선택 → 빈 메시지 → 첨부 확인 → 이미지 지원 여부
- 모델 능력 조회가 실패하면 이미지 미지원으로 간주해 `images_not_supported`로 거부한다
- openai-compatible 공급자에서 `compatibleToolCalling`이 false면 도구 목록을 비운다
- 답변은 요청이 아니라 서비스 scope(`Effect.scope`)에 fork된다. 패널을 닫아도 계속 실행된다. 명시적 삭제나 서비스 종료(`service_shutdown`)만 취소한다
- run 종료 시 `claim.release`가 실행된다. `released`는 cancellation 해제 후 모델 scope(`modelScope`)를 닫는다
- 메시지 그룹핑은 TanStack `modelMessagesToUIMessages`와 같아야 한다. 답변 그룹은 같은 id나 `${id}-segment-` 접두 assistant와 tool 결과를 다음 질문 전까지 흡수한다
- 메인 대화 문맥은 메시지당 4,000자(코드포인트)로 자른다. 잘린 메시지에는 `read_evidence <id>` 안내를 붙인다. 생략된 이전 메시지 수를 표시한다
- BTW 스레드는 노드·검색·해석과 분리되어 재열람용으로만 저장된다. 메인 대화나 검색 가능한 메모리에 추가되지 않는다
- `remove`는 스레드 행 DELETE를 먼저 한다. 그 뒤 `attachments.purgeOrphans`를 실행한다. 파일 정리 실패는 참조 없는 blob만 남기며 다음 orphan purge가 지운다

## Side Effects

- SQLite 읽기: `btw_threads` JOIN `sessions`로 스레드 조회·목록(`created_at DESC, id`), `btw_threads.messages` 조회
- SQLite 쓰기: `INSERT INTO btw_threads`(id는 `Crypto.randomUUIDv4`, created_at ISO, updated_at epoch ms), `UPDATE btw_threads SET messages, updated_at`, `INSERT OR IGNORE INTO btw_attachments`, `DELETE FROM btw_threads ... RETURNING id`
- 첨부 파일 시스템: `attachments.purgeOrphans`로 참조 없는 이미지 blob 삭제, `attachments.get`으로 첨부 조회
- 네트워크: `active.runtime(selection).model(...)`와 `runChat`로 LLM 공급자 호출, `active.models(...).acceptsImages`로 모델 능력 조회
- 백그라운드 fiber: 서비스 scope에 `Stream.runIntoQueue` fork, unbounded `Queue`로 이벤트 전달
- 취소·자원: `RunCancellations.allocate("service_shutdown")`, `liveRuns.claim`/`release`/`cancel`, `Scope.make`/`Scope.close`로 모델 자원 고정과 해제
- 설정 읽기: `GlobalConfig.read`(openai-compatible 도구 호출 여부)
- 시각: `Clock.currentTimeMillis`
- 로그: 모델 능력 조회 실패 시 `Effect.logDebug("btw_model_capabilities_unavailable")`

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
