# loop

## Overview

`packages/memory-agent/src/loop`는 Effect AI(`effect/ai`) 위에서 채팅 run 하나를 돌리는 에이전트 루프다. 모델 step을 반복하고, step마다 도구 호출을 스케줄러로 실행하고, 승인이 필요한 호출은 interrupt로 사용자에게 묻는다. 이벤트는 AG-UI 1.0 이벤트 Stream으로 내보낸다.

run·thread·interrupt 행은 `RunStore`(SqlClient)가 `chat_threads`, `chat_thread_messages`(메시지 한 개당 한 행), `chat_runs`, `chat_interrupts`에 저장한다. resume run의 interrupt 응답 검증(`resume.ts`)과 SSE 재접속용 메모리 run 로그(`run-log.ts`)도 이 디렉터리에 있다. 앱 고유 기능(대기 메시지, 권한 검토, 메모리 기록, 압축 등)은 `RunHook`으로 주입한다.

## Interface

- `runChat` — `RunSpec<R>`와 `RunInput`으로 run 하나를 돌린다. 진행하면서 행을 저장하는 `Stream<AgUiEvent, never, R | RunStore | SecureRandom.SecureRandom>`를 돌려준다(본체는 `runChatBody`)
- `RunSpec` — run 설정: `model`(LanguageModel), `source`, `system`, `tools`(`RunTool[]`), `providerTools?`, `hooks`, `modelFailure`
- `RunInput` — run 입력: `threadId`, `runId`, 호출자가 합친 `conversation`, `resume`(`ResumeEntry[]`), 사용자 취소 시 완료되는 `cancel`
- `RunHook` — 앱이 run에 붙이는 선택적 훅들. 나열 순서대로 실행된다: `started`, `joining`, `request`, `admit`(gate), `answered`, `usage`, `stepEnded`, `continues`, `ended`
- `RunScope` — 훅이 받는 run 문맥(`threadId`, `runId`, 페이지로 이벤트를 보내는 `emit`, run을 붙잡지 않는 쓰기를 맡기는 `inBackground`). `inBackground`로 맡긴 쓰기는 맡긴 순서대로 하나씩 돌고, 다음 step은 기다리지 않는다. run은 끝(완료·대기·실패·취소)을 저장하기 전에 모두 기다리고, 실패한 쓰기는 다음 step이나 끝에서 run을 실패시킨다
- `RunFailed` — 계속할 수 없는 run의 TaggedError(`message`, `code?`). message는 사용자에게 보이고 run 행에 저장된다
- `asRunFailed` / `modelFailureOf` — 일반 에러를 `RunFailed`로 바꾼다. `modelFailureOf`는 모델이 보여 주는 실패 텍스트로 `RunSpec.modelFailure`를 만든다
- `StepEnded` / `StepRequest` / `AnsweredCall` — step 종료(`Model` | `Resume`), step 요청(system, history, 그 step이 제공하는 tools), 호출과 그 응답의 쌍
- `stepScheduler` / `StepScheduler` — 한 model step의 도구 호출을 Scope 안에서 fork 실행한다. `offer(call, admission)`, `responseEnded(complete)`
- `CallResult` / `CallAnswer` / `Admission` / `Run` / `StepCall` — 호출 결과 TaggedEnum(`Returned`/`Failed`/`Refused`/`Waiting`), gate 결정(`Run` 또는 결과), 호출 형태
- `RunStore` — `Context.Service`. `RunStore.layer`는 `make`와 `HistoryPageReader.layer`로 구성된다. thread·run·interrupt 행과 화면 메시지 행을 다룬다(thread, threadSaved, activeRun, saveThread, startRun, endRun, run, lastRun, pendingInterrupts, createInterrupts 등)
- `RunEnd` / `finishedRun` — run 종료 상태 TaggedEnum(`Completed`/`Interrupted`/`Failed`/`Aborted`). `finishedRun`은 Completed 또는 Interrupted일 때 true
- `InterruptAnswer` / `PendingInterrupt` / `InterruptCommitRejected` / `StoredRun` — interrupt 응답(`Resolved`/`Cancelled`), 대기 interrupt, batch commit 거부 에러(`duplicate-interrupt`/`missing-interrupt`/`interrupt-not-pending`), run 레코드
- `resumeAnswers` / `ResumeEntry` / `ResumeRejected` / `Resumed` — resume batch를 대기 interrupt에 맞춰 검증하고 응답 목록을 만든다. 거부 시 `ResumeRejected`(code: `stale`/`conflict`/`unknown-interrupt`/`invalid-payload`)
- `AgUiEvent` 외 chunks.ts 스키마 — AG-UI 1.0 이벤트 Schema 유니언(`RunStarted`, `RunFinished`, `RunError`, `TextMessage*`, `Reasoning*`, `ToolCall*`, `Custom`)과 `RunOutcome`(`success`/`interrupt`/`cancelled`)
- `reasoningMessageId` / `reasoningStepMessage` — reasoning 메시지 id를 `${message}:${block}` 형태로 만들고, id에서 소속 assistant 메시지를 되찾는다
- `memoryRunLogs` / `MemoryRunLogs` / `RunLog` / `RunLogEntry` / `RunLogFailed` / `runAcceptedEvent` — 프로세스 메모리 run 로그. `of`, `open`, `follow`와 `append`/`appendAll`/`read(offset)`/`close`를 가진다. `appendAll`은 쌓인 이벤트를 차례대로 한 번에 붙인다. 이벤트 이름 상수는 `run.accepted`
- 하위 디렉터리 없음

## Invariants

- `RunHook` 훅은 나열된 순서대로 실행된다. `admit` gate가 `Option.none`을 돌려주면 다음 gate가 결정한다. 모든 gate가 통과시킨 호출만 실행된다
- 도구에 `plan`이 있으면 인수를 디코드한 뒤, 승인과 gate보다 먼저 묻는다. `Rewritten`이면 승인 interrupt와 `admit`이 바꾼 인수(와 그 JSON 문자열)를 보고, 호출도 그 인수로 돈다. `Ungated`면 `needsApproval` 도구라도 묻지 않고, `admit`의 `gated`가 false라서 권한 gate와 서브에이전트 relay가 건너뛴다. 다른 gate(반복 가드, trace)는 그대로 돈다. 저장된 assistant 메시지의 인수는 모델이 쓴 그대로다
- 한 step의 도구 호출 사이에 순서가 없다(`docs/decisions.md` 2026-10-27). `readOnlyToolNames`에 있는 read 호출은 gate가 허용하는 즉시 시작한다. write 호출은 응답이 완전히 끝난 뒤(`settle(true)`)에만 시작한다. `settle(false)`이면 write는 `response_incomplete` Refused로 답한다
- 이미 실행 중인 호출은 응답 때문에 끊지 않는다. step 중단(사용자 cancel, scope 닫힘)만 호출을 멈춘다
- `settle`은 모든 호출이 끝날 때까지 기다린 뒤 call 순서로 결과를 준다. gate·hook 실패는 모든 호출이 끝난 뒤 call 순서상 첫 실패로 step을 실패시킨다
- resume 검증은 TanStack과 같은 순서·code·메시지를 지킨다. 페이지가 같은 거부 문구를 읽어야 하기 때문이다. 거부된 resume은 run을 시작하지 않고 아무것도 바꾸지 않는다. batch는 한 run의 모든 대기 interrupt에 정확히 한 번씩 답해야 하며, 일부라도 틀리면 batch 전체를 거부한다
- cancelled 응답에는 payload가 없어야 한다. `tool_call` 승인 응답은 boolean이거나 `{approved}` 봉투이며 interrupt의 `responseSchema`로 검사한다. invalid-payload 문제는 interruptId 순으로 나열한다
- `InterruptCommitRejected`가 나면 그 batch는 하나도 기록하지 않는다. 기록 전에 모든 응답에 대해 pending 여부를 먼저 확인한다(`checkPending`)
- `RunError.message`와 `RunSpec.modelFailure` 결과에는 provider의 텍스트를 절대 담지 않는다(사용자에게 보이는 값)
- `saveThread`는 thread 행과 화면 메시지 행을 한 트랜잭션에서 함께 바꾸고, 빈 user 텍스트 메시지는 저장하지 않는다. 저장본과 구조로 비교하고(`firstChange`), 처음 달라진 순번부터만 지우고 다시 쓴다. 다른 writer(비밀 정리 등)가 바꾼 행도 이 비교로 덮어쓴다. 화면 메시지는 그 순번이 든 화면 메시지부터 다시 쓴다(`displayMessages.rewrite`). 저장 전에 화면 메시지가 최신이 아니었으면 처음부터 다시 만든다. 아무것도 바뀌지 않은 저장은 화면 메시지를 건드리지 않는다
- `RunStore`는 최근에 읽거나 저장한 thread 4개(`rememberedThreads`)의 메시지를 revision과 함께 기억한다. `thread()`와 `saveThread`의 저장본은 thread가 아직 그 revision이면 기억한 배열이고, 아니면 행을 읽어 디코드한다. 기억은 트랜잭션이 커밋된 뒤에만 남긴다(`sql.afterCommit`). 롤백된 revision 번호는 다음 변경이 다시 받기 때문이다. 저장이 남기는 기억은 읽기가 디코드할 값이다(새 메시지는 쓴 JSON 텍스트를 디코드한다). 같은 revision 이상을 이미 기억했으면 덮지 않는다
- 저장된 적 없는 thread는 빈 메시지 목록으로 본다. node에서 다시 만들지 않는다. 다시 만들면 `AgentChat`이 첫 run 직전에 기록한 user node가 중복된다
- `startRun`은 `ON CONFLICT(run_id) DO NOTHING`으로 기존 run을 이어 받고, 이미 집계된 usage를 돌려준다. `Interrupted` 종료는 terminal이 아니므로 `finished_at`을 쓰지 않는다
- run id는 thread 사이에서도 고유하다는 전제를 둔다(`run(runId)` 조회)
- run 로그 offset 형식은 `memory:v1:<encodeURIComponent(runId)>:<seq>`(seq ≥ 1)이다. `-1`은 처음부터, `now`는 현재 끝부터 읽는다. 닫힌 로그는 append를 `closed`로 거부하고, 두 번째 close는 아무것도 하지 않는다
- 메모리 run 로그는 종료 후 5분(`finishedLogTtl`)까지만 유지되고 최대 1024개(`maxLogs`)다. 초과하면 오래된 종료 로그부터 지운다. 실행 중인 로그는 지우지 않는다. 로그는 프로세스와 함께 사라지며, 재시작 후 재접속한 페이지는 저장된 transcript를 읽는다
- `AgUiEvent`는 TanStack 필드 없이 표준 AG-UI 1.0 형태만 쓴다. 클라이언트도 같은 Schema로 디코드하므로, 형태를 바꾸면 양쪽이 함께 바뀐다
- 시각은 `Clock.currentTimeMillis`로 읽는다(`Date.now` 직접 호출 안 함). `runChat`에는 `RunStore`와 `SecureRandom.SecureRandom` 서비스가 필요하다

## Side Effects

- SQLite(SqlClient) 읽기: `chat_threads`(revision, 존재 여부), `chat_thread_messages`(순번 순서로 이어 붙인 메시지, 기억한 revision이 아닐 때만), `chat_runs`(status·usage·error, running run, 최신 run), `chat_interrupts`(pending 목록, status)
- SQLite 쓰기: `chat_threads` upsert(updated_at), 저장본과 처음 달라진 메시지부터의 `chat_thread_messages` 삭제·삽입(500행씩), `chat_thread_display_messages` 꼬리 재작성과 `chat_threads.display_revision` 갱신을 한 트랜잭션에서 수행
- SQLite 쓰기: `chat_runs` INSERT(status `running`, started_at)와 종료 시 UPDATE(status, finished_at, detached_since, error, error_code, usage)
- SQLite 쓰기: `chat_interrupts`에 pending 행 INSERT(`ON CONFLICT DO NOTHING`)와 resume 시 응답 commit
- SQLite 읽기·쓰기: `store.ts`의 `chatMetadata`(`ChatMetadata`)가 `chat_metadata`를 namespace·key로 upsert하고, 세션의 턴 요약을 `turn_summary_blocks`에서 위치 순으로 읽는다. 요약 교체는 앞 `from`개를 남기고 나머지를 지운 뒤 새 블록을 한 트랜잭션에서 넣는다
- 도구 실행: `stepScheduler`가 호출마다 fiber를 run Scope에 fork한다. Scope를 닫으면 실행 중인 호출이 interrupt된다
- LanguageModel 호출(외부 provider 네트워크)이 run step마다 일어난다(`RunSpec.model`)
- 프로세스 메모리 상태: `memoryRunLogs`의 SynchronizedRef/SubscriptionRef 맵. 새 로그를 만들 때 오래된 로그를 정리한다
- id 생성에 `SecureRandom` 서비스를 쓰고, 시각을 `Clock`으로 읽는다

## Verification

- Run: `vp run memory-agent#typecheck`
- Run: `vp run memory-agent#test:unit`
- Run: `vp run memory-agent#test:feature`
