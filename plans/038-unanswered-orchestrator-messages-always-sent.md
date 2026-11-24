# Plan 038: 답을 못 받은 orchestrator 메시지는 요청을 줄일 때도 빼지 않는다

> **Executor instructions**: 이 계획을 단계 순서대로 따른다. 단계마다 Verify 명령을 돌려 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다. 임의로 풀지 않는다.
> `plans/README.md`는 고치지 않는다(검토자가 표를 관리한다).
>
> **이 저장소에서 찾을 때는 언제나 `rg --hidden -g '!.git' -g '!node_modules'`를 쓴다.**
>
> **Drift check (먼저 실행)**:
> `git diff --stat 75f25592..HEAD -- packages/memory-agent/src/agent/compaction.ts packages/memory-agent/src/agent/compaction.test.ts`
> 바뀐 파일이 있으면 "Current state"의 발췌와 실제 코드를 비교한다. 다르면 STOP이다. 공백과 몇 줄의 번호
> 차이는 다른 것으로 보지 않는다.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (늘 보내는 메시지의 집합에 몇 개를 더한다. 빼는 규칙은 그대로다)
- **Depends on**: 없음. 계획 037보다 **먼저** 한다. 037의 기준이 이 계획에 기대고, 두 계획이
  `docs/decisions.md`와 `packages/memory-agent/src/agent/README.md`를 함께 고친다.
- **Category**: bug
- **Planned at**: commit `75f25592`, 2026-11-25

## Why this matters

앱은 끝난 작업이나 다른 대화가 남긴 메시지를 모델에게 알릴 때 대화에 메시지 하나를 넣는다(orchestrator가
보낸 메시지). 모델은 그 메시지가 실린 요청을 받아야 그 알림을 안다.

대화가 길어지면 요청을 줄인다(`packages/memory-agent/src/agent/compaction.ts`). 오래된 메시지를 빼고 요약이나
안내 한 줄로 대신한다. 이때 늘 보내는 메시지가 정해져 있다: 진행 중인 run을 시작한 메시지, 최신 사용자 턴 두
개, run의 최근 10 step. **모델이 아직 답하지 않은 orchestrator 메시지는 거기에 없다.**

보통은 문제가 없다. 그런 메시지는 대화의 끝에 있고, 끝은 마지막에 빠진다. 하지만 규칙으로 막혀 있지는 않다.
빠질 수 있는 경우:

- 알림 메시지를 넣은 run의 모델 호출이 실패했다. 메시지는 대화에 남는다. 사용자가 다음 메시지를 아주 길게
  보내면, 그 긴 메시지(최신 사용자 턴이라 늘 보낸다)만으로 남길 분량을 넘어서 그 앞의 모든 것이 빠진다. 답을
  못 받은 알림 메시지도 같이 빠진다. 모델은 그 알림을 한 번도 받지 못한 채 답한다.
- 한 단계에서 메시지가 여럿 들어갔고(끝난 작업의 알림, 다른 대화의 메시지, 대기하던 사용자 메시지) 뒤의 것이
  아주 길다.

사용자(2026-11-25): "메세지를 보내는즉시 트리거 메세지가 요약되면 난감하긴할것같은데 고려해서만들어야될듯"

계획 037은 "그 메시지 뒤에 모델의 답이 있으면 알림을 전한 것으로 적는다"로 바꾼다. 그 기준이 맞으려면 답을
못 받은 알림 메시지가 요청에서 빠지지 않아야 한다. 이 계획이 그것을 규칙으로 만든다.

## Current state

모든 줄 번호는 commit `75f25592` 기준이다.

### 요청을 줄이는 코드가 메시지에서 읽는 것

```ts
// packages/memory-agent/src/agent/compaction.ts:60-84
export interface ConversationMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly id?: string | undefined;
  readonly content?:
    | string
    | null
    | ReadonlyArray<{ readonly type: string; readonly content?: string }>
    | undefined;
  readonly toolCalls?: ReadonlyArray<ConversationToolCall> | undefined;
  readonly toolCallId?: string | undefined;
  /**
   * What the model reasoned before it wrote an assistant message. Providers that keep reasoning
   * between turns (GLM on vLLM) are sent it with the message.
   */
  readonly thinking?: ReadonlyArray<{ readonly content: string }> | undefined;
  /** Present when the orchestrator sent the user message; it is no user turn and has no user node. */
  readonly orchestrator?: OrchestratorNote | undefined;
}

/**
 * Whether a message starts a run: the user's, or the orchestrator's that starts one. Task
 * notifications the orchestrator added to the run in progress do not.
 */
const startsRun = (message: ConversationMessage) =>
  message.role === "user" && message.orchestrator?.next !== "run";
```

저장되는 assistant 메시지에는 `stopReason`이 있을 수 있다
(`packages/memory-agent/src/chat-store/schema.ts` 96행:
`stopReason: Schema.optionalKey(Schema.Literals(["error", "aborted"]))`). 실패하거나 취소된 답에만 있다. 그런
답은 모델에게 다시 보내지 않는다(`packages/memory-agent/src/model/history.ts`의 `isFailed`). 위 interface에는
`stopReason`이 없다.

### 늘 보내는 메시지

```ts
// packages/memory-agent/src/agent/compaction.ts:595-631
/**
 * Where the run in progress starts: the latest message that started a run, or past the end when
 * there is none.
 */
const runStart = (messages: ReadonlyArray<ConversationMessage>) =>
  Option.getOrElse(EffectArray.findLastIndex(messages, startsRun), () => messages.length);

/** Where the latest step starts. Its results are what the model asked for to go on. */
const latestStep = (messages: ReadonlyArray<ConversationMessage>) =>
  Option.getOrElse(
    EffectArray.findLastIndex(messages, (message) => message.role === "assistant"),
    () => 0,
  );
// … recentStepsStart …

/**
 * Messages sent as they are wherever the conversation is cut: the one that started the run in
 * progress, and the latest user turns.
 */
const alwaysSent = (messages: ReadonlyArray<ConversationMessage>) =>
  HashSet.add(
    HashSet.fromIterable(userTurns(messages).slice(-recentRawUserTurns)),
    runStart(messages),
  );
```

`alwaysSent`가 주는 것은 메시지의 **자리 번호** 집합이다. `prepare`(910행부터)가 한 번 부르고
(`const kept = alwaysSent(messages);`, 933행), 그 `kept`를 세 곳이 쓴다: 빠지는 사용자 턴을 세는
`leftOutTurns`, 끊을 자리에 빠질 것이 있는지 보는 `leavesOut`, 보낼 것을 만드는 `sending`. `sending`은 끊긴 앞에
있어도 `kept`에 든 메시지를 제자리 순서대로 보낸다.

```ts
// packages/memory-agent/src/agent/compaction.ts:962-977
const sending = (outgoing: ReadonlyArray<M | CompactionMessage>, at: Cut) => {
  const left = messages
    .slice(at.summarized, at.cut)
    .filter((_, index) => !HashSet.has(kept, at.summarized + index));
  const notes = [
    ...(left.length > 0 ? [leftOutNote(left, toolResultId)] : []),
    ...Option.toArray(stillSaid(leftOutTurns(at.cut))),
  ];
  return [
    ...Option.toArray(Option.map(at.summary, ({ text }) => summaryMessage(text))),
    ...(notes.length > 0 ? [{ role: "user" as const, content: notes.join("\n\n") }] : []),
    ...outgoing.slice(0, at.cut).filter((_, index) => HashSet.has(kept, index)),
    ...outgoing.slice(at.cut),
  ];
};
```

저장된 대화는 요청을 줄여도 바뀌지 않는다(`compactEffect` 위 주석의 마지막 문장: "The saved conversation is
never changed.").

### 테스트의 본보기

`packages/memory-agent/src/agent/compaction.test.ts`의 `describe("request history", …)`(341행부터). 도우미
`firstSent(messages, sources, budget)`(33–48행)가 그 대화에서 모델에게 보내는 메시지를 준다. 따를 테스트는
365–381행과 385–430행이다.

```ts
// packages/memory-agent/src/agent/compaction.test.ts:365-381
it.effect("leaves out the oldest messages, pointing to memory, when nothing else is enough", () =>
  Effect.gen(function* () {
    const long = "배포 절차를 설명해요. ".repeat(100);
    const messages: StoredMessage[] = Array.from({ length: 10 }, (_, index) => [
      { role: "user" as const, content: `질문 ${index}: ${long}` },
      { role: "assistant" as const, content: `답 ${index}: ${long}` },
    ]).flat();
    messages.push({ role: "user", content: "마지막 질문" });
    const sent = yield* firstSent(messages, noSources, {
      leaveOutAt: 3_000,
      inputCeiling: noLimit,
    });
    expect(sent.length).toBeLessThan(messages.length);
    expect(sent[0]?.content).toContain("find_memory");
    expect(sent.at(-1)).toEqual({ role: "user", content: "마지막 질문" });
  }),
);
```

orchestrator 메시지는 그 파일 410–414행처럼 만든다.

```ts
// packages/memory-agent/src/agent/compaction.test.ts:410-414
const notice: StoredMessage = {
  role: "user",
  content: "<orchestrator>\nNotification n-1; completed\n</orchestrator>",
  orchestrator: { next: "run", ended: { background: 1, subagent: 0 } },
};
```

### 지킬 규칙 (`AGENTS.md`, `CLAUDE.md`에서)

- `let`, `while`을 쓰지 않는다. lint 규칙을 끄는 주석을 쓰지 않는다. `unknown`으로 타입을 뭉개지 않는다.
- Effect v4 표준 꼴을 따른다. 줄바꿈만 바꾸는 편집을 하지 않는다.
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

- `packages/memory-agent/src/agent/compaction.ts` (`ConversationMessage`에 키 하나, 함수 하나, `alwaysSent`)
- `packages/memory-agent/src/agent/compaction.test.ts` (테스트 하나)
- `packages/memory-agent/src/agent/README.md` (62행의 문장에 한 구절)
- `docs/decisions.md` (끝에 항목 하나)

**고치지 않는다**

- `compaction.ts`의 다른 규칙(끊는 자리, pointer로 바꾸기, 요약). `sending`, `leavesOut`, `prepare`의 몸.
- `packages/memory-agent/src/agent/compaction-policy.ts`, `packages/memory-agent/src/model/`,
  `packages/memory-agent/src/loop/`, `packages/memory-agent/src/sessions/`, `apps/agent`, `plans/`.

## Git workflow

- 지금 있는 branch에서 일한다(worktree가 주어졌으면 그 branch). push하지 않는다. merge하지 않는다.
- commit은 둘이다(Step 1과 2를 한 commit, Step 3을 한 commit). 메시지는 한국어 conventional commit이고 끝에
  다음 줄을 붙인다: `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`
- commit마다 typecheck와 lint가 통과해야 한다. 자기가 고친 경로만 commit한다.

## Steps

### Step 1: 실패하는 테스트를 먼저 쓴다

`packages/memory-agent/src/agent/compaction.test.ts`의 `describe("request history", …)` 안, 385–430행의 테스트
("never leaves out the run's latest steps; …") 다음에 테스트 하나를 더한다.

```ts
// A run whose model call failed leaves its notification in the conversation unanswered. Until the
// model answers, the request is the only place it reads the notification.
it.effect("never leaves out the orchestrator's messages the model has not answered", () =>
  Effect.gen(function* () {
    const long = "배포 절차를 설명해요. ".repeat(100);
    const earlier: StoredMessage[] = Array.from({ length: 6 }, (_, index) => [
      { role: "user" as const, content: `질문 ${index}: ${long}` },
      { role: "assistant" as const, content: `답 ${index}: ${long}` },
    ]).flat();
    const notice = (text: string): StoredMessage => ({
      role: "user",
      content: `<orchestrator>\n${text}\n</orchestrator>`,
      orchestrator: { next: "run", ended: { background: 1, subagent: 0 } },
    });
    const answered = notice("Background shell task b-1 completed");
    const unanswered = notice("Background shell task b-2 completed");
    const messages: StoredMessage[] = [
      ...earlier.slice(0, 2),
      answered,
      ...earlier.slice(2),
      { role: "user", content: "이어서 진행해줘" },
      unanswered,
      // The answer the failed run was writing; no request sends it again.
      { role: "assistant", content: "쓰다가", stopReason: "error" },
      // Long enough that everything before it that may be left out is.
      { role: "user", content: `다시 해 줘. ${long.repeat(3)}` },
    ];
    const sent = yield* firstSent(messages, noSources, {
      leaveOutAt: 3_000,
      inputCeiling: noLimit,
    });
    expect(sent).toContainEqual(unanswered);
    expect(sent).not.toContainEqual(answered);
  }),
);
```

**Verify**: `cd packages/memory-agent && vp test run --maxWorkers=4 src/agent/compaction.test.ts` → 새 테스트만
**실패**한다. 실패한 단언이 `expect(sent).toContainEqual(unanswered)`여야 한다.

- 새 테스트가 고치기 전에 통과하면 끊는 자리가 `unanswered`까지 가지 않은 것이다. 마지막 사용자 메시지를
  `long.repeat(6)`으로 늘려 다시 본다. 그래도 통과하면 STOP이다.
- `expect(sent).not.toContainEqual(answered)`에서 실패하면 `answered`가 빠지지 않은 것이다. `earlier`의 길이를
  10으로 늘려 다시 본다. 그래도 실패하면 STOP이다.

이 단계는 commit하지 않는다.

### Step 2: 답을 못 받은 orchestrator 메시지를 늘 보내게 한다

`packages/memory-agent/src/agent/compaction.ts`.

1. `ConversationMessage`의 `orchestrator` 키 다음에 키 하나를 더한다.

   ```ts
   /** Present on an assistant message whose run failed or was cancelled; no request sends it again. */
   readonly stopReason?: string | undefined;
   ```

2. `alwaysSent` 바로 위에 함수 하나를 더한다.

   ```ts
   /**
    * Where the orchestrator's messages the model has not answered are: those after its latest answer
    * that did not fail. Until the model answers, the request is the only place it reads them.
    */
   const unanswered = (messages: ReadonlyArray<ConversationMessage>) => {
     const lastAnswer = Option.getOrElse(
       EffectArray.findLastIndex(
         messages,
         (message) => message.role === "assistant" && message.stopReason === undefined,
       ),
       () => -1,
     );
     return messages.flatMap((message, index) =>
       index > lastAnswer && message.role === "user" && message.orchestrator !== undefined
         ? [index]
         : [],
     );
   };
   ```

3. `alwaysSent`가 그것도 담게 한다. 위 주석에 한 구절을 더한다.

   ```ts
   /**
    * Messages sent as they are wherever the conversation is cut: the one that started the run in
    * progress, the latest user turns, and the orchestrator's messages the model has not answered.
    */
   const alwaysSent = (messages: ReadonlyArray<ConversationMessage>) =>
     HashSet.union(
       HashSet.add(
         HashSet.fromIterable(userTurns(messages).slice(-recentRawUserTurns)),
         runStart(messages),
       ),
       HashSet.fromIterable(unanswered(messages)),
     );
   ```

4. `compactEffect` 위 주석(1114–1125행)의 "except the one that started the run in progress, the latest user
   turns and the run's latest steps"에 "the orchestrator's messages the model has not answered"를 더한다.

**Verify**:

- `vp run memory-agent#typecheck` → exit 0
- `cd packages/memory-agent && vp test run --maxWorkers=4 src/agent/compaction.test.ts` → 모두 통과
- `cd packages/memory-agent && vp test run --maxWorkers=4 tests/chat tests/golden` → 모두 통과
- `vp run agent#typecheck` 뒤 저장소 루트에서 `vp lint` → exit 0

Step 1의 테스트와 Step 2의 코드를 한 commit으로 묶는다. 예:
`fix(agent): 답을 못 받은 orchestrator 메시지는 요청을 줄일 때도 보낸다`

### Step 3: 문서

**3-1. `docs/decisions.md`의 맨 끝에 항목을 더한다.** 제목은 정확히 다음과 같다.

`## 답을 못 받은 orchestrator 메시지는 요청을 줄일 때도 빼지 않는다 (2026-11-25)`

담을 것(문서는 한국어, 평범한 말로):

- 계기: 앱이 모델에게 알릴 것은 대화에 orchestrator 메시지로 들어간다. 요청을 줄일 때 늘 보내는 메시지는
  진행 중인 run을 시작한 메시지, 최신 사용자 턴 두 개, run의 최근 10 step이었다. 모델이 아직 답하지 않은
  orchestrator 메시지는 거기에 없어서, 그 뒤에 아주 긴 메시지가 오면 한 번도 보내지 않은 채 빠질 수 있었다.
- 사용자(2026-11-25): "메세지를 보내는즉시 트리거 메세지가 요약되면 난감하긴할것같은데 고려해서만들어야될듯".
- 결정: 모델의 마지막 답(실패하거나 취소된 답은 치지 않는다) 뒤에 있는 orchestrator 메시지는 요청을 줄일
  때도 그대로 보낸다. 모델이 답한 뒤에는 다른 메시지와 같은 규칙으로 빠질 수 있다.
- 코드: `packages/memory-agent/src/agent/compaction.ts`의 `alwaysSent`. 저장된 대화는 바뀌지 않는다.
- 관련: 계획 037은 알림 메시지 뒤에 모델의 답이 있으면 그 알림을 전한 것으로 적게 바꾼다. 이 항목이 그
  기준을 받친다. 037의 결정 항목은 아직 없으므로 제목을 인용하지 않고 "계획 037"이라고만 적는다.
- 알려진 드문 경우: 답으로 치는 기준이 "실패 표시가 없는 assistant 메시지"라서, 모델을 부르지 않고 대화에
  붙는 assistant 메시지(그림 만들기)나 모델을 바꿀 때 글로 바뀌어 실리는 실패한 답이 그 뒤에 있으면 그 앞의
  orchestrator 메시지는 이 규칙으로 지켜지지 않는다.
- 확인: `packages/memory-agent/src/agent/compaction.test.ts`의 "never leaves out the orchestrator's messages
  the model has not answered".
- 마지막 줄: `구현: 계획 038.`

**3-2. `packages/memory-agent/src/agent/README.md` 62행.** "진행 중인 run을 시작한 메시지와 최신 사용자 턴 두
개(`recentRawUserTurns`)는 끊긴 앞에 있어도 순서대로 보낸다."를 아래로 바꾼다. 다른 문장은 건드리지 않는다.

"진행 중인 run을 시작한 메시지, 최신 사용자 턴 두 개(`recentRawUserTurns`), 모델이 아직 답하지 않은
orchestrator 메시지(모델의 마지막 답 뒤에 있는 것)는 끊긴 앞에 있어도 순서대로 보낸다."

**Verify**: `rg -n '답을 못 받은 orchestrator 메시지는 요청을 줄일 때도 빼지 않는다' docs/decisions.md` → 한 줄.
저장소 루트에서 `vp lint` → exit 0.

commit 예: `docs(decisions): 답을 못 받은 orchestrator 메시지를 늘 보내는 것을 적는다`

## Test plan

- 새 테스트 하나: `src/agent/compaction.test.ts` "never leaves out the orchestrator's messages the model has
  not answered". 모델 호출이 실패한 run이 남긴 알림 메시지는 뒤에 아주 긴 사용자 메시지가 와도 보내고, 이미
  답한 알림 메시지는 다른 메시지처럼 빠진다.
- 돌려 볼 기존 테스트: `src/agent/compaction.test.ts`, `tests/chat`, `tests/golden`.

## Done criteria

- [ ] `vp run memory-agent#typecheck` exit 0
- [ ] `vp run agent#typecheck` exit 0
- [ ] 저장소 루트 `vp lint` exit 0
- [ ] `cd packages/memory-agent && vp test run --maxWorkers=4 src/agent/compaction.test.ts tests/chat tests/golden` 모두 통과
- [ ] `rg -n 'const unanswered' packages/memory-agent/src/agent/compaction.ts` → 한 줄
- [ ] `git diff --stat <시작할 때의 HEAD>..HEAD`에 Scope의 파일만 있다(시작할 때 `git rev-parse HEAD`를 적어 둔다)
- [ ] `docs/decisions.md` 끝에 새 항목이 있다

## STOP conditions

- Drift check에서 발췌와 실제 코드가 다르다.
- Step 1의 테스트가 고치기 전에 통과하고, 마지막 사용자 메시지를 늘려도 통과한다.
- Step 2 뒤에 `compaction.test.ts`의 기존 테스트가 실패한다. 그 테스트의 대화에 답을 못 받은 orchestrator
  메시지가 있어서 보내는 것이 늘어난 경우면, 무엇이 달라졌는지 보고에 적고 기대값을 고친다. 다른 까닭이면
  STOP이다.
- `tests/golden`의 결과 파일이 바뀐다.
- `Scope`에 없는 파일을 고쳐야만 통과한다.
- 사용자가 정해야 할 일이 생긴다. 다른 사람이나 바깥에 묻지 않는다. `NEEDS-DECISION`으로 보고한다.

## Maintenance notes

- "모델이 답했는가"를 대화에서 읽는 기준은 계획 037의 `toldIn`
  (`packages/memory-agent/src/agent/orchestrator-message.ts`)과 같다: 실패하지 않은 assistant 메시지가 뒤에
  있는가. 한쪽 기준을 바꾸면 다른 쪽도 같이 바꾼다. 두 파일이 읽는 메시지 타입이 달라(`StoredMessage`와
  `ConversationMessage`) 함수는 따로 뒀다.
- 답으로 치는 기준의 빈 곳 둘(빚): (1) `agent/image-record.ts`의 `imageMessages`는 모델을 부르지 않고
  assistant 메시지를 대화에 붙인다. (2) model handoff는 지난 대화를 요청에 실을 때 실패한 답을 실패 표시
  없는 글로 바꾼다(`agent/model-handoff.ts`의 `assistantText`). 어느 쪽이든 그 앞의 orchestrator 메시지가
  답을 받은 것으로 보인다. 고치려면 모델이 쓴 답만 가리는 표시가 메시지에 있어야 한다.
- 답을 못 받은 orchestrator 메시지는 보통 한두 개다. 그 수가 늘 보내는 분량을 키울 만큼 많아질 길이 생기면
  (예: 깨우지 않는 알림이 실패한 run마다 쌓인다) 이 규칙을 다시 본다.
- 검토할 때 볼 것: `alwaysSent`가 주는 것이 자리 번호라는 것. `unanswered`가 메시지가 아니라 번호를 주는가.
