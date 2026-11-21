# Plan 024: 대화의 세션 요약도 그 대화가 쓰는 모델로 만든다

> **Executor instructions**: 이 계획을 단계대로 따른다. 단계마다 검증 명령을 돌리고, 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 적힌 일이 생기면 멈추고 보고한다. 즉석에서 다른
> 길을 만들지 않는다. 끝나면 `plans/README.md`에서 이 계획의 행을 고친다. 단, 검토자가 보낸
> 실행이고 "색인은 검토자가 고친다"는 말을 들었다면 고치지 않는다.
>
> **Drift check (run first)**: `git diff --stat df4e066f..HEAD -- packages/memory-agent/src/agent/turn-summaries.ts packages/memory-agent/src/agent/chat.ts packages/memory-agent/tests/compaction/agent-chat.test.ts packages/memory-agent/eval/live-compaction.ts`
> 범위 안의 파일이 이 계획을 쓴 뒤 바뀌었다면, 아래 "Current state"의 발췌를 실제 코드와 비교한다.
> 다르면 STOP이다.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `df4e066f`, 2026-11-21

## Why this matters

2026-11-14부터 대화마다 자기 모델을 가진다. 대화의 run, `/compact`, 컨텍스트 사용량은 그 대화의
모델을 쓴다. 그런데 세션 요약(`TurnSummaries.catchUp`)만 앱의 전역 기본 모델(`active.selected`)로
돈다. 그래서 세 가지가 어긋난다.

- 로컬 모델로 하는 대화의 요약이 클라우드 모델로 나간다.
- 요약을 시작할 비율을 다른 모델의 창 크기로 계산한다.
- 전역 모델에 로그인하지 않았으면, 대화 모델은 멀쩡해도 요약이 `"unavailable"`로 끝난다.

`/compact` 한 호출 안에서도 예산은 대화 모델로 재고(`chat.ts:2496`), 요약은 전역 모델로 만든다
(`chat.ts:2503` → `turn-summaries.ts:61`). 이 계획이 끝나면 요약을 부르는 쪽이 모델을 넘기고,
`TurnSummaries`는 전역 선택을 읽지 않는다.

## Current state

- `packages/memory-agent/src/agent/turn-summaries.ts` — 세션 요약 서비스. `catchUp`이 전역 선택을 읽는다.

```ts
// turn-summaries.ts:59-64
  const catchUp = (sessionId: string, whole: boolean): Effect.Effect<SummaryOutcome> =>
    Effect.gen(function* () {
      const selection = yield* active.selected;
      if (!isTruthy(selection)) return "unavailable" as const;
      const auth = yield* active.auth(selection);
      if (!AuthConnectionState.$is("signed-in")(auth)) return "unavailable" as const;
```

```ts
// turn-summaries.ts:106-127
  // Retried after the next run; a failure here never reaches the conversation.
  const inBackground = (sessionId: string) =>
    Effect.catchDefect(catchUp(sessionId, false), (defect) =>
      logDefect("Turn summaries stopped")(Cause.die(defect)),
    ).pipe(Effect.forkIn(scope), Effect.when(Effect.succeed(automatic)), Effect.asVoid);

  return {
    catchUp,
    ...
    hookFor: (sessionId: string): RunHook => ({
      ended: (_scope, end) =>
        Effect.when(inBackground(sessionId), Effect.succeed(finishedRun(end))).pipe(Effect.asVoid),
    }),
  };
```

- `packages/memory-agent/src/agent/chat.ts` — run 조립과 `/compact`.
  - 대화가 쓰는 모델을 고르는 함수가 이미 있다.

```ts
// chat.ts:665-676
/**
 * The model a session's chat runs on. On a kanban board the chat is the planner, so it runs on
 * the planner's model; otherwise on the conversation's own model, or the app's selected one.
 */
const sessionModel = (sessionId: string) =>
  Effect.flatMap(kanbanBoard(sessionId), (board) =>
    board
      ? active.selectedFor("planner")
      : Effect.flatMap(sessions.get(sessionId), (session) =>
          session.model === null ? active.selected : Effect.succeed(session.model),
        ),
  );
```

- run의 hook 목록을 만드는 곳에는 그 run의 `selection`(대화 모델)이 이미 있다. `chat.ts:2229-2260`
  근처에 `summaries.hookFor(sessionId),`가 있고, 같은 목록의 `contextUsageHook`이
  `selection.model`을 쓴다.
- `/compact`:

```ts
// chat.ts:2491-2504
    compact: (sessionId: string, holder: string | null) =>
      Effect.gen(function* () {
        yield* refuseOtherHolder(sessionId, holder);
        yield* sessions.get(sessionId);
        if (isTruthy(yield* liveRuns.get(sessionId))) return yield* runInProgress();
        const budget = budgetFor((yield* windowFor(yield* sessionModel(sessionId))).tokens);
        const result: CompactResult = yield* compactByHand(
          runStore.chatMetadata,
          sessionId,
          yield* runStore.thread(sessionId),
          compactionSources(sessionId),
          budget,
          () => summaries.catchUp(sessionId, true),
        );
```

- `catchUp`을 부르는 다른 곳:
  - `packages/memory-agent/tests/compaction/agent-chat.test.ts` 170, 175, 194, 215번 줄 근처:
    `summaries.catchUp(at.sessionId, false)`. 이 테스트 파일은 `selectTestModel`
    (`tests/support/provider.ts`)로 기본 테스트 모델을 고른다.
  - `packages/memory-agent/eval/live-compaction.ts:175`: `services.summaries.catchUp(services.sessionId, true)`.
    이 eval은 `provider.models.select(model, effort)`로 전역 선택을 정하고, 대화는 자기 모델 없이
    (`NULL`) 만든다.
- 모델 선택 타입은 `ModelSelection`이다(`packages/memory-agent/src/providers/contracts.ts`에서 export).
  `active.selected`의 결과 타입이 `ModelSelection | null`이다. 같은 타입을 쓴다.
- 이 저장소의 Effect 규칙(루트 `CLAUDE.md`): Effect v4 표준 방식으로 쓴다. 조건 하나로 effect를 막을
  때는 `Effect.when`, 복합 조건이나 일찍 돌아가기는 `if`를 쓴다. `let`과 `while`은 쓰지 않는다.
  `(x) => f(x)` 같은 의미 없는 감싸기를 만들지 않는다.
- 결정 기록 `docs/decisions.md`의 "모델은 대화마다 둔다 (2026-11-14)"는 "그대로인 것"에 "대화 밖의
  일(요약, 해석, BTW, 제보, 이미지 생성)이 쓰는 모델"이라고 적었다. 이 계획은 그중 "요약"을 바꾼다.

## Commands you will need

| Purpose        | Command                                                                | Expected on success                          |
| -------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| 서버 typecheck | 저장소 루트에서 `vp run memory-agent#typecheck`                        | exit 0, 출력에 `error TS`와 `warning`이 없다 |
| 포맷·lint      | 저장소 루트에서 `vp check`                                             | exit 0                                       |
| 서버 테스트    | `cd packages/memory-agent && vp test --run tests/compaction src/agent` | all pass                                     |

- `vp run dev`, `vp pack`을 돌리지 않는다.
- 새 worktree에서는 먼저 `pnpm install --frozen-lockfile`을 한다. 서버 테스트가
  `NativeOwnerFailed: native-incompatible`로 건너뛰면 저장소 루트에서 `vp run turbovec#build`를 한다.
- lint는 패키지 안이 아니라 저장소 루트에서 돌린다. 패키지 안에서 돌리면 저장소의 커스텀 규칙이 빠진다.

## Scope

**In scope**:

- `packages/memory-agent/src/agent/turn-summaries.ts`
- `packages/memory-agent/src/agent/chat.ts` (`compact`와 hook 목록의 `summaries.hookFor` 줄만)
- `packages/memory-agent/tests/compaction/agent-chat.test.ts`
- `packages/memory-agent/eval/live-compaction.ts` (175번 줄 근처의 호출만)
- `packages/memory-agent/src/agent/README.md` (`TurnSummaries` 설명 줄)
- `docs/decisions.md` (새 항목 하나를 끝에 더한다)

**Out of scope**:

- `sessionModel`의 우선순위(planner → 대화 모델 → 기본값). 바꾸지 않는다.
- 해석(`memory/interpret.ts`), 제보(`report/`), 스킬 검토가 쓰는 모델. 다른 계획에서 다룬다.
- run 안에서 앞 step을 요약하는 `compactionHook`. 이미 run의 모델로 돈다.

## Git workflow

- 지금 브랜치에 commit한다. 브랜치를 바꾸지 않는다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 각 commit은 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예(이 저장소 `git log`): `fix(compaction): retrieval appendix를 user 역할로 보낸다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1: `TurnSummaries`가 모델을 인자로 받는다

`turn-summaries.ts`에서:

- `catchUp`의 시그니처를 `(sessionId: string, whole: boolean, selection: ModelSelection | null)`로 바꾼다.
  본문 첫 줄의 `const selection = yield* active.selected;`를 지운다. 바로 다음의
  `if (!isTruthy(selection)) return "unavailable" as const;`는 그대로 둔다.
- `inBackground`와 `hookFor`도 `selection`을 받아 `catchUp`에 넘긴다:
  `hookFor: (sessionId: string, selection: ModelSelection | null): RunHook`.
- doc comment에 "요약은 부르는 쪽이 넘긴 모델, 곧 그 대화가 쓰는 모델로 만든다"는 뜻을 한 줄 더한다.
- `active`(`ActiveProvider`)는 `active.auth`, `active.runtime`, `sessionSummarizer`의 `services`에서
  계속 쓰므로 남긴다.

**Verify**: `vp run memory-agent#typecheck` → `chat.ts`, `agent-chat.test.ts`, `live-compaction.ts`의
`catchUp`/`hookFor` 호출에서만 인자 수 오류가 난다. 그 밖의 오류는 없다.

### Step 2: 부르는 쪽이 대화의 모델을 넘긴다

- `chat.ts`의 hook 목록: `summaries.hookFor(sessionId),` → `summaries.hookFor(sessionId, selection),`.
  이 `selection`은 같은 목록의 `contextUsageHook`이 쓰는 그 변수다.
- `chat.ts`의 `compact`: `sessionModel(sessionId)`을 한 번만 읽어 이름을 붙이고(예: `const selected = yield* sessionModel(sessionId);`),
  `windowFor(selected)`와 `summaries.catchUp(sessionId, true, selected)` 둘 다에 쓴다.
- `eval/live-compaction.ts`: 이 eval의 대화는 자기 모델이 없어 전역 선택을 따른다. 그 값을 넘긴다.
  setup에서 `ActiveProvider`의 `selected`를 읽어 `services`에 담고(예: `selection: yield* (yield* ActiveProvider).selected`),
  호출을 `services.summaries.catchUp(services.sessionId, true, services.selection)`로 바꾼다.
  `ActiveProvider`는 `../src/providers/active-provider.ts`에서 가져온다.
- `tests/compaction/agent-chat.test.ts`: 네 호출 모두 그 테스트가 고른 기본 테스트 모델을 넘긴다.
  `ActiveProvider`의 `selected`를 읽어 넘기면 된다(테스트 블록 안에서 한 번 읽어 변수로).

**Verify**: `vp run memory-agent#typecheck` → exit 0, `error TS`·`warning` 없음.
`cd packages/memory-agent && vp test --run tests/compaction src/agent` → all pass.

### Step 3: 회귀 테스트 하나

`tests/compaction/agent-chat.test.ts`의 "automatic summaries wait until the conversation fills the
configured share" 테스트를 본보기로 테스트 하나를 더한다.

- 이름: `"summarizes with the model it is given, not the app's selection"`.
- 내용: `selection`으로 `null`을 넘기면 `catchUp`이 `"unavailable"`을 돌려주고 요약이 생기지 않는다.
  그리고 같은 대화에 기본 테스트 모델을 넘기면(`setStartPercent(0)` 뒤) `"done"`이고 요약이 생긴다.
  이것이 "넘긴 모델을 쓴다"를 단언한다.
- 전역 선택을 비우는 방법이 테스트 지원 코드에 이미 있으면(예: `tests/support/provider.ts`), 전역
  선택이 없을 때도 넘긴 모델로 `"done"`이 되는 단언을 더한다. 없으면 이 단언은 만들지 않는다. 새
  지원 코드를 만들지 않는다.

**Verify**: `cd packages/memory-agent && vp test --run tests/compaction/agent-chat.test.ts` → 새 테스트 포함 all pass.

### Step 4: 문서

- `src/agent/README.md` 32번 줄의 `TurnSummaries` 설명에 "요약은 `catchUp`·`hookFor`에 넘긴 모델(그
  대화가 쓰는 모델)로 만든다"를 더한다.
- `docs/decisions.md` 끝에 새 항목을 더한다. 다른 항목처럼 `## 제목 (2026-11-21)` 형식이다.
  - 제목: `세션 요약도 그 대화가 쓰는 모델로 만든다 (2026-11-21)`
  - 계기: 대화 모델이 생긴 뒤에도 요약만 전역 기본 모델로 돌아, 로컬 모델 대화의 요약이 다른
    공급자로 나가고, 요약 시작 비율을 다른 모델의 창으로 쟀다. `/compact` 한 호출 안에서 예산과 요약의
    모델이 달랐다.
  - 결정: 요약은 run과 `/compact`가 쓰는 모델(칸반 보드면 계획자 모델 → 대화의 모델 → 앱의 기본
    선택)로 만든다. `TurnSummaries`는 전역 선택을 읽지 않고 부르는 쪽이 넘긴다.
  - 대체하는 결정: "모델은 대화마다 둔다 (2026-11-14)"의 "그대로인 것" 중 "요약".
  - 확인: `tests/compaction/agent-chat.test.ts`의 새 테스트.

**Verify**: 저장소 루트에서 `vp check` → exit 0.

## Test plan

- 새 테스트 1개(Step 3), 본보기는 같은 파일의 "automatic summaries wait…" 테스트.
- `cd packages/memory-agent && vp test --run tests/compaction src/agent` → all pass.

## Done criteria

- [ ] `vp run memory-agent#typecheck` exit 0, `error TS`·`warning` 없음
- [ ] `vp check` exit 0
- [ ] `cd packages/memory-agent && vp test --run tests/compaction src/agent` all pass, 새 테스트 포함
- [ ] `grep -n "active.selected" packages/memory-agent/src/agent/turn-summaries.ts` 결과 없음
- [ ] `grep -n "summaries.catchUp(sessionId, true)" packages/memory-agent/src/agent/chat.ts` 결과 없음
- [ ] 범위 밖 파일이 바뀌지 않았다(`git status`)

## STOP conditions

- `catchUp`이나 `hookFor`를 위 목록 밖에서 부르는 곳이 있다(`grep -rn "catchUp\|summaries.hookFor" packages apps`로 확인).
- hook 목록을 만드는 곳에 `selection`이라는 변수가 없거나, 그것이 대화의 모델이 아니다.
- 테스트 지원 코드에서 기본 테스트 모델을 얻을 방법이 `ActiveProvider.selected` 말고는 없고, 그것도
  `null`이다.
- 같은 검증이 합리적으로 한 번 고친 뒤에도 두 번 실패한다.

## Maintenance notes

- 해석(`memory/interpret.ts`), 제보 진단, 스킬 검토도 지금 전역 기본 모델이나 역할 모델을 따로 읽는다.
  "보조 작업이 어느 모델을 쓰는가"를 한 표로 모으는 일은 별도 계획에서 한다. 그때 이 계획이 넘기게 한
  인자 모양(`selection: ModelSelection | null`)과 맞춘다.
- 검토자는 `compact`가 예산과 요약에 같은 값을 쓰는지 본다.
