# Plan 036: 시작하지 못한 자동 run은 잡은 알림을 돌려준다

> **Executor instructions**: 이 계획을 단계 순서대로 따른다. 단계마다 Verify 명령을 돌려 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다. 임의로 풀지 않는다.
> `plans/README.md`는 고치지 않는다(검토자가 표를 관리한다).
>
> **이 저장소에서 찾을 때는 언제나 `rg --hidden -g '!.git' -g '!node_modules'`를 쓴다.** route 핸들러 폴더
> `apps/agent/app/.server`는 이름이 점으로 시작해 `rg`가 기본으로 건너뛴다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat a1af0fb8..HEAD -- packages/memory-agent/src/agent/chat.ts packages/memory-agent/src/agent/task-notifications.ts packages/memory-agent/src/sessions/orchestrator-notifications.ts packages/memory-agent/tests/support/provider.ts`
> 바뀐 파일이 있으면 "Current state"의 발췌와 실제 코드를 비교한다. 다르면 STOP이다. 공백과 몇 줄의 번호
> 차이는 다른 것으로 보지 않는다.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (run이 시작하지 못한 길에만 정리 하나를 더한다)
- **Depends on**: 033 (merge됨, `62753289`)
- **Category**: bug
- **Planned at**: commit `a1af0fb8`, 2026-11-24

## Why this matters

사용자가 2026-11-23에 알림 규칙 하나를 정했다(`docs/decisions.md` "알림은 규칙 하나로 전하고, 끝난
백그라운드 작업이 그것을 따른다 (2026-11-23)"). 그 1번: run이 알림을 잡는다. 그 run이 정상으로 끝나거나
승인을 기다리며 멈추면 전한 것으로 적는다. **실패하거나 취소되면 잡은 것을 지워 다음 run이 다시 받게
한다.**

한 곳이 이 규칙을 어긴다. 사용자의 메시지 없이 서버가 시작하는 run(자동 run)은 시작을 준비하는 도중에
알림을 잡는다. 그 뒤에 시작이 거절되거나 실패하면 run은 한 번도 돌지 않는다. 잡은 것을 돌려주는 코드는
run의 hook(`ended`)에만 있어서, 돌지 않은 run은 아무것도 돌려주지 않는다. 그 알림은 없는 run에 잡힌 채 앱을
다시 시작할 때까지 남는다.

그동안 생기는 일:

- 끝난 백그라운드 작업이나 끝난 하위 작업의 소식이 모델에게 가지 않는다. 사용자가 다음 메시지를 보내 새
  run이 돌아도 듣지 못한다. 그 행이 다른 run 것으로 표시돼 있기 때문이다.
- 대화를 깨울 알림이 있는지 묻는 `wakes`가 false를 답한다. 그래서 자동 run이 다시 시도되지도 않는다.

실제로 생기는 경우: 백그라운드 작업이 끝났을 때 provider를 쓸 수 없으면(로그아웃, 모델이 계정에서 사라짐)
자동 run의 모델 준비가 `ProviderUnavailable`이나 `ModelUnavailable`로 실패한다. 모델 준비는 알림을 잡은
**뒤**에 있다. 같은 순간에 사용자의 메시지가 먼저 run을 차지한 경우(`run_in_progress`)도 같다.

033의 결정 항목은 이것을 "거절하는 자리에서 claim을 바로 돌려주는 것은 따로 할 일이다"로 남겼다. 이 계획이
그것이다.

## Current state

모든 줄 번호는 commit `a1af0fb8` 기준이다.

### 알림을 잡는 곳: `packages/memory-agent/src/agent/chat.ts`의 `runContext`

`start` 안의 `runContext`(1750행부터)가 자동 run일 때 알림을 잡는다. `followup`은 자동 run에서만 비어 있지
않다.

```ts
// packages/memory-agent/src/agent/chat.ts:1815-1820
// A run the user started gets them before its first model call instead, in a message of
// their own (`Subagents.toolsFor`), so its system prompt stays the same.
const parentNotifications =
  yield *
  EffectArray.match(followup, {
    onEmpty: () => Effect.succeed(noTaskNotifications),
    onNonEmpty: () => notifications.consume(sessionId, runId),
  });
```

여기서 `notifications`는 `chat.ts` 693행의 값이다.

```ts
// packages/memory-agent/src/agent/chat.ts:693-697
const notifications = taskNotifications({
  trace: workTrace,
  notifications: orchestratorNotifications,
  crypto,
});
```

`consume`과 `release`는 `packages/memory-agent/src/agent/task-notifications.ts`에 있다. `release` 하나가 두
곳(끝난 하위 작업의 `parent_notifications`, 끝난 백그라운드 작업의 `orchestrator_notifications`)을 모두
돌려준다. 잡은 것이 없으면 아무것도 바꾸지 않는다.

```ts
// packages/memory-agent/src/agent/task-notifications.ts:27-44
const consume = (sessionId: string, runId: string) =>
  Effect.all({
    tasks: trace.consumeParentNotifications(sessionId, runId),
    background: Effect.map(notifications.claim(sessionId, runId, "task"), (entries) =>
      entries.map(({ payload }): BackgroundEnd => ({
        taskId: payload.taskId,
        parentRunId: payload.parentRunId,
        kind: payload.kind,
        title: payload.title,
        status: payload.status,
      })),
    ),
  });
const release = (sessionId: string, runId: string) =>
  Effect.all(
    [trace.releaseParentNotifications(sessionId, runId), notifications.release(sessionId, runId)],
    { discard: true },
  );
```

run이 돌았을 때는 같은 파일의 hook이 정리한다. 이것은 그대로 둔다.

```ts
// packages/memory-agent/src/agent/task-notifications.ts:77-81
      ended: (_scope, end) =>
        (finishedRun(end)
          ? Effect.asVoid(notifications.deliverClaimed(sessionId, runId))
          : release(sessionId, runId)
        ).pipe(Effect.ignore({ log: "Warn" })),
```

### 잡은 뒤에 시작이 끝날 수 있는 곳

`runContext`는 1985행에서 불린다. 그 뒤부터 run이 자기 log를 채우기 시작하는 2349행 사이에 `start`가 일찍
끝나는 길은 다음과 같다. 어느 길에도 `notifications.release`가 없다.

- 2146행 `runtime.model(…)`이 `ProviderUnavailable`이나 `ModelUnavailable`로 실패한다.
- 2274행 `if (Result.isFailure(admitted)) return refused(admitted.failure);`
- 2284행 `if (Option.isNone(runTools)) return refused({ error: "goal_ledger_unavailable" });`
- 2320행 `if (!isTruthy(claim)) return refused({ error: "run_in_progress" });`
- 그 사이의 다른 `yield*`가 실패하거나 fiber가 중단된다.

### `start`가 일찍 끝날 때 되돌리는 방식 (따를 본보기)

`start`는 일찍 끝나면 되돌릴 일을 `Ref`에 담고, scope의 finalizer가 그것을 돌린다. run이 자기 log를 따라가기
시작하면 `Ref`를 비운다.

```ts
// packages/memory-agent/src/agent/chat.ts:1302-1314
      return Effect.gen(function* () {
        // What an early end must undo. The run takes over the cancellation and the steering once
        // it is following its log.
        const claimedNext = yield* Ref.make<string | null>(null);
        const cancellationToRelease = yield* Ref.make<Effect.Effect<void>>(Effect.void);
        const stopSteeringOnExit = yield* Ref.make<Effect.Effect<void>>(Effect.void);
        yield* Effect.addFinalizer(() =>
          Effect.flatMap(Ref.get(claimedNext), (next) =>
            isTruthy(next) ? queue.releaseNext(sessionId, next) : Effect.void,
          ).pipe(Effect.catch(logFailure("Queued next turn was not released"))),
        );
        yield* Effect.addFinalizer(() => Effect.flatten(Ref.get(stopSteeringOnExit)));
        yield* Effect.addFinalizer(() => Effect.flatten(Ref.get(cancellationToRelease)));
```

```ts
// packages/memory-agent/src/agent/chat.ts:2349-2354
yield *
  Effect.forkIn(filledLog(delivered, log, { sessionId, runId }), scope, {
    startImmediately: true,
  });
yield * Ref.set(cancellationToRelease, Effect.void);
yield * Ref.set(stopSteeringOnExit, Effect.void);
return ChatStart.Following({ log, after: "-1" });
```

finalizer는 등록한 순서의 반대로 돈다. `cancellationToRelease`의 finalizer가 마지막에 등록돼 가장 먼저 돈다.

### 자동 run이 거절을 받는 곳

```ts
// packages/memory-agent/src/agent/chat.ts:2849-2863
const send = (runId: string, kind: InternalFollowup) =>
  api.start({ input: { runId, messages: [] } }, sessionId, kind).pipe(
    Effect.flatMap(
      ChatStart.$match({
        Refused: ({ refusal }) => Effect.succeed(Result.fail(refusal.error)),
        Following: (following) => Effect.succeed(Result.succeed(following)),
      }),
    ),
    Effect.catchTags({
      SessionNotFound: notStarted("session_not_found"),
      ProjectNotFound: notStarted("project_not_found"),
      ProviderUnavailable: notStarted("provider_unavailable"),
      ModelUnavailable: notStarted("provider_unavailable"),
    }),
  );
```

자동 run은 끝난 작업이 `background.completions`로 알려질 때 깨어난다(`chat.ts` 719행). 2893행의
`notifications.wakes(sessionId)`가 true일 때만 시작한다.

### 테스트에서 모델 준비를 실패시키는 길

`packages/memory-agent/tests/support/provider.ts`의 `TestProviderOptions.runModel`이 run의 모델을 만드는
함수를 바꾼다. `runtime.model`이 이것이다. 본보기는 `packages/memory-agent/tests/chat/turns.test.ts`
266–291행이다.

```ts
// packages/memory-agent/tests/chat/turns.test.ts:266-291
/** How many runs let their model go, as a run lets its pinned account go. */
const released = MutableRef.make(0);

testAgent({
  testProvider: {
    runModel: (_selection, run) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => MutableRef.increment(released)));
        const scripted = yield* scriptedModel([{ text: "hello" }]);
        return {
          model: yield* scripted.forRun(run),
          source: scriptedSource,
          shownFailure: shownScriptedFailure,
          promptCacheFor: Duration.hours(1),
        };
      }),
  },
})("a run's model", (it) => {
  it.effect("is let go once, when the run's stream ends", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      yield* eventsOf(yield* post(yield* freshSession, "hello"));
      expect(MutableRef.get(released)).toBe(1);
    }),
  );
});
```

`ModelUnavailable`은 `packages/memory-agent/src/providers/contracts.ts`에 있다. 만드는 꼴은
`ModelUnavailable.make({ provider: "openai", model })`이다(`tests/support/provider.ts` 412행).

백그라운드 작업을 테스트에서 시작하는 꼴은 `packages/memory-agent/tests/agents/background-tasks.test.ts`
183–199행이다.

```ts
// packages/memory-agent/tests/agents/background-tasks.test.ts:19-26
/** A run of the session to start background work from; run and call IDs are global. */
const runOf = Effect.fnUntraced(function* (sessionId: string, abortSignal?: AbortSignal) {
  return {
    sessionId,
    runId: `${sessionId}:run`,
    abortSignal: abortSignal ?? (yield* Effect.abortSignal),
  };
});
```

```ts
// packages/memory-agent/tests/agents/background-tasks.test.ts:192-198
const receipt =
  yield *
  tasks.start(yield * runOf(sessionId), `${sessionId}:call`, "shell", "pwd", Effect.succeed("/"));
```

기다리는 도우미는 `packages/memory-agent/tests/agents/agent-env.ts`의 `until(condition, what)`이다. 조건은
`() => boolean`이나 `Effect<boolean>`이고 6초까지 기다린다. 같은 파일의 `send(sessionId, text)`는 사용자
메시지 하나를 보내고 run이 끝나면 답의 글을 돌려준다. `freshSession`도 거기 있다.

### 지킬 규칙 (`AGENTS.md`, `CLAUDE.md`에서)

- `let`, `while`을 쓰지 않는다. lint 규칙을 끄는 주석을 쓰지 않는다. `unknown`으로 타입을 뭉개지 않는다.
- Effect v4 표준 꼴을 따른다. 뜻 없는 감싸기(`(x) => f(x)`)를 남기지 않는다.
- 줄바꿈만 바꾸는 편집을 하지 않는다. 포맷은 commit hook이 맡는다.
- 이름, 주석, 문서에 만든 말을 쓰지 않는다. 코드 주석은 영어, 문서는 한국어다.
- 진단하려고 추적되는 파일을 임시로 고치지 않는다.

## Commands you will need

| Purpose               | Command                                                          | Expected on success    |
| --------------------- | ---------------------------------------------------------------- | ---------------------- |
| 서버 typecheck        | `vp run memory-agent#typecheck`                                  | exit 0, 오류·경고 없음 |
| 화면 typecheck        | `vp run agent#typecheck`                                         | exit 0                 |
| lint (저장소 루트)    | `vp lint`                                                        | exit 0                 |
| 서버 테스트 (고른 것) | `cd packages/memory-agent && vp test run --maxWorkers=4 <파일…>` | 모두 통과              |

새 worktree에서는 먼저 `vp install`과 `vp run turbovec#build`를 돌린다. `vp lint`는 `vp run agent#typecheck`를
한 번 돌린 뒤에 돌린다. 전체 테스트는 돌리지 않는다.

## Scope

**고치는 파일**

- `packages/memory-agent/src/agent/chat.ts` (`start` 안의 세 곳)
- `packages/memory-agent/tests/agents/unstarted-followup.test.ts` (새 파일)
- `packages/memory-agent/src/agent/README.md` (알림을 설명하는 곳에 한 문장. 그런 곳이 없으면 고치지 않는다)
- `docs/decisions.md` (끝에 항목 하나)

**고치지 않는다**

- `packages/memory-agent/src/agent/task-notifications.ts`: `release`와 hook은 그대로 쓴다.
- `packages/memory-agent/src/sessions/orchestrator-notifications.ts`, `packages/memory-agent/src/work-trace/`.
- `packages/memory-agent/src/sessions/dispatches.ts`: 다른 대화의 메시지는 run의 hook(`joining`)에서만
  잡는다. 돌지 않은 run은 그것을 잡지 않는다.
- `packages/memory-agent/tests/support/`: 있는 옵션(`runModel`)만 쓴다.
- DB migration, `apps/agent`, `plans/`.

## Git workflow

- 지금 있는 branch에서 일한다(worktree가 주어졌으면 그 branch). push하지 않는다. merge하지 않는다.
- commit은 둘이다(Step 1과 2를 한 commit, Step 3을 한 commit). 메시지는 한국어 conventional commit이고 끝에
  다음 줄을 붙인다: `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`
- commit마다 typecheck와 lint가 통과해야 한다. 자기가 고친 경로만 commit한다.

## Steps

### Step 1: 실패하는 테스트를 먼저 쓴다

새 파일 `packages/memory-agent/tests/agents/unstarted-followup.test.ts`를 만든다. 테스트 하나다.

틀:

```ts
import { Duration, Effect, MutableRef } from "effect";
import { expect } from "vite-plus/test";
import { ModelUnavailable } from "../../src/providers/contracts.ts";
import { OrchestratorNotifications } from "../../src/sessions/orchestrator-notifications.ts";
import {
  scriptedModel,
  scriptedSource,
  shownScriptedFailure,
} from "../../src/testing/scripted-model.ts";
import { BackgroundTasks } from "../../src/tools/background.ts";
import { selectTestModel } from "../support/provider.ts";
import { sqlGet } from "../support/sql.ts";
import { testAgent } from "../support/test-env.ts";
import { freshSession, send, until } from "./agent-env.ts";

/** While true no run gets its model, as when the provider went away. */
const modelGone = MutableRef.make(false);
/** How many runs were refused their model. */
const unstarted = MutableRef.make(0);

testAgent({
  testProvider: {
    runModel: (selection, run) =>
      MutableRef.get(modelGone)
        ? Effect.suspend(() => {
            MutableRef.increment(unstarted);
            return Effect.fail(
              ModelUnavailable.make({ provider: "openai", model: selection.model }),
            );
          })
        : Effect.gen(function* () {
            const scripted = yield* scriptedModel([{ text: "hello" }]);
            return {
              model: yield* scripted.forRun(run),
              source: scriptedSource,
              shownFailure: shownScriptedFailure,
              promptCacheFor: Duration.hours(1),
            };
          }),
  },
})("an automatic run that does not start", (it) => {
  it.effect("gives back the ended background task it took, and the next run hears it", () =>
    Effect.gen(function* () {
      // … 아래 순서대로
    }),
  );
});
```

테스트 몸의 순서:

1. `yield* selectTestModel();` `const sessionId = yield* freshSession;`
2. `yield* send(sessionId, "hello");` 대화의 마지막 run이 `completed`여야 자동 run이 시작한다.
3. `MutableRef.set(modelGone, true);`
4. `BackgroundTasks`의 `start`로 작업 하나를 시작한다. 첫 인자는
   `{ sessionId, runId: \`${sessionId}:run\`, abortSignal: yield* Effect.abortSignal }`, 나머지는 위 발췌와
   같다(`\`${sessionId}:call\``, `"shell"`, `"pwd"`, `Effect.succeed("/")`). 돌려받은 `receipt.taskId`가 알림
   행의 id다.
5. `yield* until(() => MutableRef.get(unstarted) > 0, "the automatic run to be refused its model");`
   자동 run은 모델을 준비하기 전에 알림을 잡으므로, 이때 알림은 이미 한 번 잡혔다.
6. `yield* until((yield* OrchestratorNotifications).wakes(sessionId), "the end to be given back");`
   `wakes`는 아무 run도 잡지 않은 깨울 행이 있을 때만 true다. 고치기 전에는 여기서 6초 뒤 실패한다.
7. 행을 읽어 확인한다.
   `expect(yield* sqlGet("SELECT state, claimed_run_id FROM orchestrator_notifications WHERE id = ?", receipt.taskId)).toEqual({ state: "waiting", claimed_run_id: null });`
8. `MutableRef.set(modelGone, false);` `yield* send(sessionId, "next");`
9. 다음 run이 그 끝을 들었는지 확인한다.
   `expect(yield* sqlGet("SELECT state FROM orchestrator_notifications WHERE id = ?", receipt.taskId)).toEqual({ state: "delivered" });`
   이 단언이 `waiting`으로 실패하면, `send`가 돌아온 뒤 run의 hook이 아직 끝나지 않은 것이다. 그때는 9를
   `until(Effect.map(sqlGet(…), (row) => row?.state === "delivered"), "the next run to deliver the end")`
   꼴로 바꾼다(`row`의 타입이 그 비교를 허락하지 않으면 6과 같이 `wakes`가 false인 것과 7의 꼴로 본다).

`until`의 타입이 5나 6의 인자를 받지 않으면 `packages/memory-agent/tests/support/wait-until.ts`의
`WaitCondition`을 읽고 맞는 꼴로 쓴다. 뜻은 바꾸지 않는다.

**Verify**: `cd packages/memory-agent && vp test run --maxWorkers=4 tests/agents/unstarted-followup.test.ts` →
테스트가 **실패**한다. 실패한 곳이 6번의 기다림("the end to be given back")이어야 한다. 5번에서 실패하면
자동 run이 시작하지 않은 것이다. STOP conditions를 본다. 이 단계는 commit하지 않는다.

### Step 2: 시작하지 못한 run이 알림을 돌려주게 한다

`packages/memory-agent/src/agent/chat.ts`의 `start`에서 세 곳을 고친다.

1. `Ref` 하나와 finalizer 하나를 더한다. `stopSteeringOnExit`를 만드는 줄(1307행) 다음에 `Ref`를 만들고,
   `claimedNext`의 finalizer(1308–1312행) 다음, `stopSteeringOnExit`의 finalizer(1313행) 앞에 finalizer를
   등록한다. 그 자리에 두면 취소와 steering 정리가 끝난 뒤에 돈다.

   ```ts
   const notificationsToRelease = yield * Ref.make<Effect.Effect<void>>(Effect.void);
   ```

   ```ts
   yield * Effect.addFinalizer(() => Effect.flatten(Ref.get(notificationsToRelease)));
   ```

   1303–1304행의 주석("What an early end must undo. …")에 알림도 든다는 것을 영어 한 구절로 더한다. 예:
   `The run takes over the cancellation, the steering and the notifications it took once it is following its log.`

2. `runContext`에서 알림을 잡기 **전에** 돌려줄 일을 `Ref`에 담는다(1817–1820행). 잡은 뒤에 담으면 그
   사이에 중단됐을 때 남는다. 잡은 것이 없을 때 `release`는 아무것도 바꾸지 않는다.

   ```ts
   const parentNotifications =
     yield *
     EffectArray.match(followup, {
       onEmpty: () => Effect.succeed(noTaskNotifications),
       onNonEmpty: () =>
         Ref.set(
           notificationsToRelease,
           notifications
             .release(sessionId, runId)
             .pipe(
               Effect.catch(logFailure("Notifications of a run that did not start not given back")),
             ),
         ).pipe(Effect.andThen(notifications.consume(sessionId, runId))),
     });
   ```

   `logFailure`가 `release`의 오류 타입을 받지 않아 typecheck가 실패하면(오류에 `_tag`가 없을 때),
   `task-notifications.ts`의 hook처럼 `Effect.ignore({ log: "Warn" })`를 쓴다.

3. run이 자기 log를 따라가기 시작하는 곳(2352–2353행)에서 `Ref`를 비운다. 그 뒤로는 run의 hook이 정리한다.

   ```ts
   yield * Ref.set(cancellationToRelease, Effect.void);
   yield * Ref.set(stopSteeringOnExit, Effect.void);
   yield * Ref.set(notificationsToRelease, Effect.void);
   ```

`return refused(…)` 자리들은 고치지 않는다. `start`의 scope가 닫힐 때 finalizer가 돌기 때문에, 거절로
끝나든 오류로 끝나든 중단되든 같은 정리가 돈다.

**Verify**:

- `vp run memory-agent#typecheck` → exit 0
- `cd packages/memory-agent && vp test run --maxWorkers=4 tests/agents/unstarted-followup.test.ts` → 통과
- `cd packages/memory-agent && vp test run --maxWorkers=4 tests/agents tests/chat tests/sessions` → 모두 통과
- `vp run agent#typecheck` 뒤 저장소 루트에서 `vp lint` → exit 0

Step 1의 테스트와 Step 2의 코드를 한 commit으로 묶는다. 예:
`fix(agent): 시작하지 못한 자동 run이 잡은 알림을 돌려준다`

### Step 3: 결정을 적는다

`docs/decisions.md`의 **맨 끝**에 항목을 더한다. 제목은 정확히 다음과 같다.

`## 시작하지 못한 자동 run은 잡은 알림을 돌려준다 (2026-11-24)`

담을 것(문서는 한국어, 평범한 말로):

- 계기: 자동 run은 시작을 준비하며 알림을 잡는다. 그 뒤 시작이 거절되거나 실패하면(모델을 준비하지 못함,
  다른 run이 먼저 대화를 차지함, Goal의 장부를 열지 못함) 잡은 알림이 없는 run에 잡힌 채 재시작까지 남았다.
  그동안 다음 run도 그 소식을 듣지 못했고 자동 run도 다시 시도되지 않았다.
- 결정: 알림 규칙의 1번("실패하거나 취소되면 claim을 지워 다음 run이 다시 받게 한다")을 시작하지 못한 run에도
  적용한다. `AgentChat.start`가 일찍 끝나면 그 run id로 잡은 알림(끝난 하위 작업, 끝난 백그라운드 작업)을
  돌려준다. run이 자기 log를 따라가기 시작한 뒤에는 지금처럼 run의 hook이 정리한다.
- 돌려준 뒤: 그 알림은 다음 run이 듣는다. 돌려주는 것만으로 자동 run을 다시 시작하지는 않는다. 다음에 그
  대화를 깨우는 일(다른 작업의 끝, run의 끝, 사용자의 메시지)이 있을 때 다시 본다.
- 대체하는 것: "알림은 규칙 하나로 전하고, 끝난 백그라운드 작업이 그것을 따른다 (2026-11-23)"의 달라진 동작
  4번 가운데 "claim이 재시작까지 남고 … 재시작 때 풀린다" 부분. 그 항목의 글은 고치지 않는다.
- 확인: `packages/memory-agent/tests/agents/unstarted-followup.test.ts`.
- 마지막 줄: `구현: 계획 036.`

`packages/memory-agent/src/agent/README.md`에 자동 run이나 알림을 잡는 것을 설명하는 문단이 있으면, 시작하지
못한 run은 잡은 알림을 돌려준다는 한 문장을 그 문단에 더한다. 없으면 README는 고치지 않는다.

**Verify**: `rg -n '시작하지 못한 자동 run은 잡은 알림을 돌려준다' docs/decisions.md` → 한 줄.
저장소 루트에서 `vp lint` → exit 0.

commit 예: `docs(decisions): 시작하지 못한 자동 run이 알림을 돌려주는 것을 적는다`

## Test plan

- 새 테스트 하나: `tests/agents/unstarted-followup.test.ts` "gives back the ended background task it took,
  and the next run hears it". 모델을 준비하지 못해 시작하지 못한 자동 run 뒤에 (a) 알림 행이 다시 기다리고
  잡은 run이 없으며 (b) 다음 run이 그 끝을 전한 것으로 적는다.
- 끝난 하위 작업(`parent_notifications`)은 따로 시험하지 않는다. 같은 `release` 한 번이 둘을 함께 돌려준다.
- 돌려 볼 기존 테스트: `tests/agents`, `tests/chat`, `tests/sessions`.

## Done criteria

- [ ] `vp run memory-agent#typecheck` exit 0
- [ ] `vp run agent#typecheck` exit 0
- [ ] 저장소 루트 `vp lint` exit 0
- [ ] `cd packages/memory-agent && vp test run --maxWorkers=4 tests/agents tests/chat tests/sessions` 모두 통과
- [ ] `rg -n 'notificationsToRelease' packages/memory-agent/src/agent/chat.ts` → 네 줄(만들기, finalizer,
      담기, 비우기)
- [ ] `git diff --stat a1af0fb8..HEAD`에 Scope의 파일만 있다
- [ ] `docs/decisions.md` 끝에 새 항목이 있다

## STOP conditions

- Drift check에서 발췌와 실제 코드가 다르다.
- Step 1의 테스트가 5번("the automatic run to be refused its model")에서 실패한다. 자동 run이 시작하지 않은
  것이다. 까닭을 찾아 보고한다(추측으로 테스트를 바꾸지 않는다).
- Step 1의 테스트가 고치기 전에 **통과**한다. 이 계획이 고치려는 일이 이미 없다는 뜻이다.
- Step 2 뒤에 기존 테스트가 실패한다. 그 테스트가 "시작하지 못한 run의 알림이 잡힌 채 남는다"를 단언하고
  있으면 새 동작에 맞게 고치고 보고한다. 다른 까닭이면 STOP이다.
- `Scope`에 없는 파일을 고쳐야만 통과한다.
- 사용자가 정해야 할 일이 생긴다. 다른 사람이나 바깥에 묻지 않는다. `NEEDS-DECISION`으로 보고한다.

## Maintenance notes

- 끝난 하위 작업의 알림(`parent_notifications`)을 `orchestrator_notifications`로 옮길 때, `release` 하나가
  둘을 돌려주는 지금 꼴이 한 표의 `release`로 줄어든다. 이 계획의 `Ref`와 finalizer는 그대로 남는다.
- 보드의 호출(`kanbanAttention`)은 run을 시작하기 전에 지우고 시작이 거절돼도 돌려놓지 않는다. 이 계획은
  그것을 고치지 않는다. 보드를 알림 표로 옮기는 계획에서 다룬다.
- 드문 경우 하나: `start`가 run을 시작시킨 뒤(2335행 뒤) log를 열다가 실패하면, 이 finalizer와 run의 hook이
  둘 다 `release`를 부른다. 두 번 불러도 결과는 같다.
- 검토할 때 볼 것: `Ref`를 비우는 줄이 `return ChatStart.Following` 바로 앞에 있는가. 그 줄이 빠지면 정상으로
  시작한 자동 run의 알림이 `start`가 끝나는 순간 돌려져 다음 model call에서 한 번 더 전해진다.
