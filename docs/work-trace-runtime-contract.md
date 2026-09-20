# Work Trace 런타임 계약

> 상태: WT-01 기준선 · 2026-09-20 · 기준 커밋 `f471284`

이 문서는 Work Trace 구현이 재사용할 현재 실행 계약과, 서로 다른 "resume" 의미의 경계를 기록한다. 구현 중 TanStack AI API는 설치된 `@tanstack/ai` 0.55.0과 `@tanstack/ai-persistence` 0.6.0의 소스 및 패키지 스킬을 기준으로 한다.

## 현재 실행 경로

### 메인 채팅

- TanStack `threadId`는 session id다.
- `ChatState.middleware()`는 `withPersistence(..., { snapshotStreaming: true })`를 사용한다.
- SQLite `chat_threads`는 전체 transcript를, `chat_runs`는 TanStack run 상태를, `chat_interrupts`는 승인·interrupt 상태를 저장한다.
- `LiveRuns`는 현재 프로세스에서 session당 하나의 producer를 소유한다.
- `memoryStream({ runId })` delivery log는 모든 chunk를 프로세스 메모리에 보관한다. 브라우저가 연결을 잃어도 producer는 계속 실행되고, reload된 client는 hydrate가 반환한 active run에 다시 붙는다.
- 명시적 cancel은 `requestRunCancel`과 in-process abort를 함께 사용한다. 단순 HTTP disconnect는 cancel 의도가 아니다.
- 서버 시작 시 남아 있는 `running` chat run은 `failed`/`server_restarted`가 된다. provider continuation과 in-memory delivery log는 복원되지 않는다.

### 서브에이전트

- `subagents.parent_run_id`는 부모 chat run만 가리킨다.
- child thread는 `subagent-${subagentId}`다.
- `runChild()`가 매 실행마다 임의 child `runId`를 만들지만 `subagents` 행이나 별도 invocation 행에 저장하지 않는다.
- child는 `ChatState.middleware()`를 사용하므로 transcript와 TanStack child `chat_runs`는 저장되지만, 부모 tool call ID와 child run 사이의 명시적 join은 없다.
- named subagent를 재호출하면 같은 `subagents` 행의 `last_task`, `last_answer`, 상태를 덮어쓴다. 각 작업 실행은 구조화된 이력으로 남지 않는다.
- 프로세스 시작 시 `running` subagent 행은 `interrupted`로 바뀐다. 자동 재개 또는 명시적 resume API는 없다.
- 실행 중 named child에 대한 `message_subagent`는 provider `steer`를 시도한다. idle child의 후속 메시지는 동일 thread transcript를 사용하는 새 child run이다.

## 세 가지 resume의 경계

### 1. Delivery rejoin

- 조건: 원 producer와 `memoryStream` log가 같은 프로세스에서 살아 있다.
- 동작: 같은 run에 다시 구독한다. provider를 다시 호출하거나 새 attempt를 만들지 않는다.
- 현재 지원: 메인 채팅.
- Work Trace 목표: 살아 있는 child attempt에도 같은 의미로 지원한다.

### 2. Interrupt continuation

- 조건: durable pending interrupt가 있고 앱 run continuation을 이어갈 수 있다.
- TanStack `config.resume`와 `withPersistence`가 담당한다.
- 승인 batch는 성공 boundary에서만 commit된다. 실패한 continuation은 pending 상태를 유지해 재시도할 수 있다.
- 이것은 dropped stream 재접속이나 서버 재시작 후 임의 작업 복원이 아니다.
- 현재 앱은 서버 재시작 시 소실된 continuation의 pending approval을 폐기한다. Work Trace logical resume도 이전 attempt의 미실행 승인을 자동 승계하지 않는다.

### 3. Logical task resume

- 조건: 서버 재시작, crash, 실패 또는 명시적 중단으로 원 provider continuation이 없다.
- 동작: 원 Task 아래 새 AgentRunAttempt와 새 child `runId`를 만든다. `resumed_from`으로 이전 attempt를 연결한다.
- 입력: 원 task, durable transcript, 완료가 확정된 tool result와 artifact, 마지막 checkpoint, 중단 사유 및 남은 작업 요약.
- 금지: 이전 token stream 복원으로 가장하기, 실행 여부가 불명확한 비멱등 tool 자동 재호출, pending approval 자동 승계.
- 동시성: Task당 active attempt 하나를 원자적으로 claim한다.

## TanStack persistence 계약

- `withPersistence`는 state persistence이며 delivery durability가 아니다.
- `RunStore.createOrResume`은 동일 `runId` insert-if-absent 계약이다. 기존 행의 status, startedAt, usage를 덮어쓰지 않는다. 이 메서드 이름은 앱 수준 logical resume를 뜻하지 않는다.
- TanStack `RunStatus`는 `running | interrupted | completed | failed | aborted`다. 여기서 `interrupted`는 durable human-in-the-loop pause이고 terminal이 아니다.
- `findActiveRun(threadId)`는 reload rejoin에 필요하다.
- `snapshotStreaming`은 부분 assistant transcript를 저장하지만 provider continuation이나 delivery event log를 영속화하지 않는다.
- `chat_runs`의 `sandboxKey`, `detachedSince`, `cancelRequested`, `driverEpoch`는 TanStack durable-run 계약 필드다. 앱 Work Trace 의미로 재해석하지 않는다.
- middleware terminal hook은 정확히 하나만 실행된다. 구조화된 trace 계측은 `onStart`, `onIteration`, `onBeforeToolCall`, `onAfterToolCall`, `onFinish`, `onAbort`, `onError`를 사용하되 transform hook 실패가 모델 stream을 깨지 않게 자체 격리한다.

## 결정 GQ-1: 별도 app-owned attempt 테이블

`chat_runs`는 TanStack 계약의 source of truth로 유지하고, Work Trace는 별도 `agent_run_attempts`를 둔다.

이유:

1. 하나의 논리 Task에 여러 child chat run이 생길 수 있다.
2. TanStack `createOrResume`은 같은 run record의 멱등 생성이지 새 logical attempt 생성이 아니다.
3. Work Trace에는 `resumed_from`, `invocation_id`, `parent_tool_call_id`, adoption과 resumability처럼 SDK run에 없는 필드가 필요하다.
4. TanStack status 의미와 앱 task/attempt 상태를 결합하면 SDK upgrade와 interrupt 처리에서 충돌한다.

관계:

```text
Task
└─ Invocation
   └─ AgentRunAttempt
      ├─ chat_run_id → chat_runs.run_id
      ├─ thread_id → chat_threads.thread_id
      └─ resumed_from_attempt_id → AgentRunAttempt
```

`chat_runs`가 없는 legacy 기록은 nullable reference와 legacy 표시로 유지한다. 신규 child attempt는 실행 전에 child run ID를 생성하고 두 저장소에 동일 ID를 사용한다.

## 결정 GQ-2: 별도 session trace SSE

Work Trace는 별도 session-scoped trace endpoint를 사용한다. 기존 chat SSE에만 custom event를 싣지 않는다.

이유:

1. 여러 child run이 부모 답변과 독립적으로 동시에 event를 만든다.
2. trace는 부모 chat stream이 끝난 뒤에도 조회·replay되어야 한다.
3. Work Trace 패널은 세션의 이전 Task와 resume lineage를 읽어야 한다.
4. chat stream reconnect와 trace replay cursor의 수명 및 권한은 다르다.

새 endpoint는 기존 SSE framing과 offset/rejoin 패턴을 재사용하지만, source of truth는 SQLite `run_events`다. 연결 시 snapshot/cursor를 받고 이후 이벤트를 tail한다. 프로세스 재시작 뒤에도 cursor 이후 replay가 가능해야 한다. chat message 카드에는 trace ID/reference만 연결한다.

## 상태와 UX 용어

| 표시          | 실제 의미                                                          | 새 attempt             |
| ------------- | ------------------------------------------------------------------ | ---------------------- |
| 다시 연결     | producer가 살아 있는 동일 run의 delivery/trace stream에 rejoin     | 만들지 않음            |
| 승인 후 계속  | pending interrupt에 응답하여 같은 앱 작업을 continuation           | 일반적으로 만들지 않음 |
| 이어서 작업   | continuation이 소실된 Task를 durable checkpoint에서 logical resume | 만듦                   |
| 처음부터 다시 | 과거 attempt를 입력 근거로 사용하지 않는 명시적 restart            | 만듦                   |

UI와 API는 위 용어를 혼용하지 않는다.

## WT-01 이후 구현 불변식

1. parent tool call, Invocation, child attempt와 child chat run을 명시적 ID로 연결한다.
2. named agent의 identity와 작업 Invocation/Attempt 이력을 분리한다.
3. 하나의 Task에는 active attempt가 최대 하나다.
4. 이전 attempt는 resume 후에도 immutable history로 남는다.
5. 완료가 확인된 tool result만 resume context에서 재사용한다.
6. 실행 여부가 불명확한 비멱등 tool은 `uncertain`으로 표시하고 자동 실행하지 않는다.
7. 이전 attempt의 pending approval은 새 attempt에서 다시 확인한다.
8. trace event는 영속화 후 전달하며 live UI와 review UI가 같은 event를 읽는다.
9. operational trace는 memory graph와 분리한다.

## 검증 명령

빠른 계약 검증:

```bash
pnpm --filter memory-agent exec vp test tests/chat-persistence.test.ts tests/runs.test.ts tests/subagents.test.ts
pnpm --filter memory-agent exec tsc
pnpm --filter agent exec react-router typegen
pnpm --filter agent exec tsc
```

변경 단계별 관련 테스트:

```bash
pnpm --filter memory-agent exec vp test tests/chat-persistence.test.ts
pnpm --filter memory-agent exec vp test tests/runs.test.ts
pnpm --filter memory-agent exec vp test tests/subagents.test.ts
pnpm --filter agent exec vp test app/entry/run-notice.test.ts app/entry/interrupt-recovery.test.ts
```

전체 release gate:

```bash
pnpm ready
```

`chat-persistence.test.ts`의 TanStack conformance suite는 message full-replace, run insert-if-absent, durable-run 필드 round-trip, interrupt ordering/commit을 검증한다. 이후 attempt/event store에는 별도 migration, transition, concurrency와 replay 테스트를 추가한다.
