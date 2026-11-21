# Plan 022: 생성한 이미지를 대화에 적는다 (서버)

> **Executor instructions**: 이 계획을 순서대로 따른다. 각 단계의 확인 명령을 실행하고
> 기대 결과를 본 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다.
> 임의로 고치지 않는다. `plans/README.md`는 고치지 않는다(검토자가 고친다).
>
> **Drift check (먼저 실행)**:
> `git diff --stat 7696fc99 HEAD -- packages/memory-agent/src/agent/live-runs.ts packages/memory-agent/src/agent/chat.ts packages/memory-agent/src/api/app-api/media.ts packages/memory-agent/src/api/app-api/sessions.ts packages/memory-agent/src/attachments apps/agent/app/.server/api/media.ts apps/agent/app/.server/api/sessions.ts packages/memory-agent/src/loop/store.ts`
> 출력이 있으면 "Current state"의 발췌와 실제 코드를 견준다. 발췌한 코드가 달라졌으면 STOP이다.
> (Plan 020과 021은 이 파일들 가운데 `attachments.ts`의 한 줄만 고친다. 그 한 줄 차이는 괜찮다.)

## Status

- **Priority**: P1
- **Effort**: M–L
- **Risk**: HIGH (모든 채팅 run이 쓰는 점유 장부와 대화 저장에 닿는다. 유료 호출의 결과를 다룬다)
- **Depends on**: Plan 019(그림을 node에 묶는 `linkStored`), Plan 008(대화마다 모델)
- **Category**: 기능
- **Planned at**: commit `7696fc99`의 코드, 2026-11-16

## Why this matters

입력창의 이미지 버튼을 켜고 보내면 서버가 이미지를 만든다. 지금은 만든 그림이 입력창 위에 한 번
보일 뿐 대화 기록에 들어가지 않는다. 그림은 어디에도 묶이지 않은 첨부로 저장되어, 앱을 다시 시작하면
첨부 정리가 파일을 지운다.

사용자는 2026-11-16에 설계 문서(`docs/designs/image-generation-in-conversation.md`)의 방법 A를 골랐다.
서버가 사용자가 쓴 글 그대로 이미지를 만들고, 그 결과를 대화에 "사용자 메시지(프롬프트), 도구 호출
`generate_image`, 도구 결과(그림)" 세 메시지로 적는다. 모델은 부르지 않는다. 승인 흐름과
`ImageMediaWorkflow`는 바꾸지 않는다.

설계 문서 6절의 나머지 질문은 권한 답으로 간다. 다음 턴의 모델은 그림을 보지 못한다(결과는 글자다).
프롬프트는 사용자 node로 남겨 기억에 들어간다. 이미지를 붙인 요청은 계속 막는다. 생성은 run이 아니다.

이 계획은 서버만 다룬다. 새 API 경로를 더하고 옛 경로(`POST /api/media/image`)는 남긴다. 화면이 새
경로를 쓰게 하는 일은 다음 계획이다.

## Design

### 흐름

새 경로 `POST /api/sessions/:session/images`의 handler가 세 단계를 차례로 한다.

1. **미리 보기** `chat.imageOrigin(session, holder)`: 다른 탭이 쥔 대화면 `session_in_use`, 없는 대화면
   `session_not_found`, 답변 중이면 `run_in_progress`로 거절한다. 통과하면 이 대화의 모델로 만든 시작
   경로 `chat:<provider>:<model>`을 돌려준다. 모델이 없으면 `image_route_unavailable`로 거절한다.
2. **생성** `workflow.generate(...)`: 지금의 `/api/media/image` handler와 똑같이 부르고, 실패도 똑같이
   거절로 바꾼다. 승인이 필요하다는 거절은 대화에 아무것도 적기 전에 화면으로 돌아간다.
3. **기록** `chat.recordImage(session, holder, { prompt, asset })`: node 셋과 메시지 셋을 적고 그림을
   결과 node에 묶는다.

### 기록이 run과 겹치지 않게 하는 방법

run은 대화를 메모리에 들고 있다가 step이 끝날 때마다 `saveThread`로 전체를 다시 저장한다.
`saveThread`는 저장된 목록과 처음 달라지는 자리부터 지우고 다시 쓴다. 그래서 run이 도는 동안 다른
곳에서 메시지를 덧붙이면 run의 다음 저장이 그 메시지를 지운다.

run끼리는 `createLiveRuns`의 장부가 한 대화에 하나만 돌게 막는다(`claim`). 이 계획은 그 장부에 "쓰는
중" 표시를 더한다. 기록은 수십 밀리초 동안 이 표시를 쥔다. 표시가 있는 동안 `claim`은 실패하고, run이
있는 동안 표시는 쥘 수 없다. 표시는 `get`과 `sessionIds`에 보이지 않는다. 그래서 화면과 사이드바는
이 대화를 답변 중으로 보지 않고, 없는 run을 따라가려 하지 않는다.

이미지 생성 자체(수십 초)는 대화를 점유하지 않는다. 생성하는 동안 다른 run(대기열, 끝난 백그라운드
작업의 후속)이 시작될 수 있다. 그러면 기록은 그 run이 끝나기를 기다렸다가 적는다.

기록은 요청이 끊겨도 끝까지 간다. 돈을 낸 그림이 화면이 닫혔다는 이유로 버려지면 안 되기 때문이다.
`start`가 쓰는 방식(`Effect.forkIn(scope, { startImmediately: true })` 뒤 `Fiber.join`)을 그대로 쓴다.

### 적는 모양

- 사용자 node: `kind: "user"`, 글은 비밀 가리기(`redactor.redactText`)를 거친 프롬프트.
- 도구 호출 node: `kind: "tool_call"`, 글은 인수 JSON 글자, `detail: { toolName: "generate_image", toolCallId }`.
- 도구 결과 node: `kind: "tool_result"`, 글은 결과 JSON 글자,
  `detail: { toolName: "generate_image", toolCallId, ok: true }`, `links: [{ kind: "returns", nodeId: <호출 node> }]`.
  그림을 `attachments.linkStored(<결과 node>, [asset.attachment.id])`로 묶는다.
- 메시지 셋(`StoredMessage`):
  - `{ role: "user", id, createdAt, content: <가린 프롬프트> }`
  - `{ role: "assistant", id, createdAt, content: null, toolCalls: [{ id: toolCallId, type: "function", function: { name: "generate_image", arguments: <인수 JSON 글자> } }], source: { provider: asset.provider, model: asset.executorMediaRouteId }, finishReason: "tool_calls" }`
  - `{ role: "tool", id, createdAt, toolCallId, content: <결과 JSON 글자> }`
- 인수 JSON: `{ "prompt": <가린 프롬프트> }`
- 결과 JSON: `{ "preview": { "attachmentId": asset.attachment.id, "mimeType": asset.attachment.mimeType }, "route": asset.executorMediaRouteId, "model": <모델 이름>, "estimatedCostUsd": <있을 때만> }`.
  `<모델 이름>`은 `asset.executorMediaModel`이 `explicit`이면 그 `model`, `provider_managed`면
  `"provider_managed"`다(`ImageExecutorModel.$match` 또는 `Match.valueTags`로 가른다).
  `preview`의 모양은 `packages/memory-agent/src/attachments/previews.ts`의 `picturesIn`이 읽는 모양과 같다.
- assistant 메시지에 `source`를 적는 까닭: replay는 `source`가 지금 모델과 다른 메시지를 다른 모델의
  것으로 보고 도구 호출 id를 그 공급자가 받는 모양으로 바꿔 보낸다(`src/model/history.ts`의 `isForeign`).
  우리가 만든 id가 어느 공급자의 규칙에도 맞을 필요가 없어진다.

## Current state

경로는 저장소 루트 기준이다.

### 점유 장부: `packages/memory-agent/src/agent/live-runs.ts` (72줄 전체가 이 모양이다)

```ts
export const createLiveRuns = Effect.gen(function* () {
  const bySession = yield* Ref.make(HashMap.empty<string, LiveRun>());

  return {
    get: (sessionId: string): Effect.Effect<LiveRun | null> =>
      Effect.map(Ref.get(bySession), (runs) => Option.getOrNull(HashMap.get(runs, sessionId))),

    /** The sessions whose run is producing now. */
    sessionIds: Effect.map(Ref.get(bySession), (runs): readonly string[] => [
      ...HashMap.keys(runs),
    ]),

    /** Claims a session until the returned stream finishes. */
    claim: Effect.fnUntraced(function* (options: {/* sessionId, runId, controller, … */}) {
      // …
      const claimed = yield* Ref.modify(bySession, (runs) =>
        HashMap.has(runs, sessionId) ? [false, runs] : [true, HashMap.set(runs, sessionId, run)],
      );
      if (!claimed) return null;
      // … release는 bySession에서 이 run을 지운다
    }),
  };
});
```

`claim`이 `null`을 돌려주면 부른 쪽은 `run_in_progress`로 거절한다
(`packages/memory-agent/src/agent/chat.ts:1568`, `:2292`). 이 처리는 이미 있다.

### 본보기로 삼을 `AgentChat`의 동작: `packages/memory-agent/src/agent/chat.ts`

다른 탭이 쥔 대화를 거절하는 함수(`:731-736`)와 답변 중 거절(`:857`).

```ts
/** Refuses a change while another page holds the session. */
const refuseOtherHolder = (sessionId: string, holder: string | null) =>
  Effect.when(
    Effect.fail({ error: "session_in_use" } as const),
    Effect.map(leases.permits(sessionId, holder), (permitted) => !permitted),
  );
```

```ts
/** Refuses a change while the session is answering. */
const runInProgress = () => Effect.fail({ error: "run_in_progress" } as const);
```

대화의 모델(`:650-657`). 대화에 제 모델이 없으면 앱이 고른 모델을 따른다. `null`일 수 있다.

```ts
const sessionModel = (sessionId: string) =>
  Effect.flatMap(kanbanBoard(sessionId), (board) =>
    board
      ? active.selectedFor("planner")
      : Effect.flatMap(sessions.get(sessionId), (session) =>
          session.model === null ? active.selected : Effect.succeed(session.model),
        ),
  );
```

run이 아닌 대화 동작의 본보기 `compact`(`:2446-2466`).

```ts
    compact: (sessionId: string, holder: string | null) =>
      Effect.gen(function* () {
        yield* refuseOtherHolder(sessionId, holder);
        yield* sessions.get(sessionId);
        if (isTruthy(yield* liveRuns.get(sessionId))) return yield* runInProgress();
        // …
      }).pipe(
        Effect.catchTags({
          SessionNotFound: unknownSession,
          ProviderUnavailable: unavailableProvider,
        }),
      ),
```

사용자 턴을 적는 곳(`:1469-1481`). `keptTurn`은 `(yield* redactor.redactText(turn.text)).text`다.

```ts
const persistUserTurn = Effect.gen(function* () {
  if (keptTurn === null) return;
  const appended = yield* nodes.append({
    projectId,
    sessionId,
    kind: "user",
    text: keptTurn,
  });
  yield* Ref.set(userNode, appended);
  yield* attachments.link(appended.id, attached);
  if (title === null) yield* events.publishProject(projectId, "sessions");
});
```

요청이 끊겨도 끝까지 가게 하는 방식(`start`의 끝, `:2327-2335`). `scope`는 `:680`의
`const scope = yield* Effect.scope;`다.

```ts
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.flatMap(Fiber.join),
```

`AgentChat` 안에서 쓸 수 있는 서비스: `events`(`:436`), `nodes`(`:538`), `redactor`(`:544`),
`attachments`(`:562`), `crypto`(`:677`, `SecureRandom`), `sessions`, `runStore`, `liveRuns`, `leases`.

### 도구 호출과 결과를 node로 적는 모양: `packages/memory-agent/src/memory/record.ts:216-252`

```ts
                  nodes.append({
                    ...base,
                    kind: "tool_call",
                    text: callTexts[index] ?? "",
                    detail: { toolName: name, toolCallId: id },
                    links: isTruthy(assistant) ? [{ kind: "calls", nodeId: assistant.id }] : [],
                    refs: callRefs[index] ?? [],
                  }),
```

```ts
const resultNode =
  yield *
  nodes.append({
    ...base,
    runId: callNode.runId ?? binding.runId,
    kind: "tool_result",
    text: resultTexts[index] ?? "",
    detail: {
      toolName: name,
      toolCallId: id,
      ok: result.value.ok,
      permission: permissions[index],
    },
    links: [{ kind: "returns", nodeId: callNode.id }],
  });
yield * attachments.linkStored(resultNode.id, result.value.pictures);
```

`base`는 `{ projectId, sessionId, runId }`다. `runId`는 `NewNode`에서 선택 항목이다
(`packages/memory-agent/src/memory/nodes.ts:91-108`). 이미지 기록에는 run이 없으므로 `runId`를 주지 않는다.

### 대화 저장: `packages/memory-agent/src/loop/store.ts:251-286`

`saveThread(threadId, messages)`는 메시지 목록 전체를 받아 저장된 것과 처음 달라지는 자리부터 다시 쓴다.
화면에 보이는 메시지 묶음도 같은 호출이 다시 만든다. 저장된 목록은 `runStore.thread(sessionId)`로 읽는다
(`compact`가 그렇게 읽는다). 덧붙이려면 `saveThread(sessionId, [...stored, 새 메시지 셋])`을 부른다.

메시지 모양은 `packages/memory-agent/src/chat-store/schema.ts`의 `StoredUserMessage`, `StoredAssistantMessage`,
`StoredToolMessage`, `StoredToolCall`, `MessageSource`다. `createdAt`은
`packages/memory-agent/src/agent/page-turns.ts:21`처럼 `DateTime.formatIso(now)`로 만든다.

### 지금의 이미지 경로

계약 `packages/memory-agent/src/api/app-api/media.ts`: `GenerateImage`(payload), `GeneratedImage`(success),
거절 셋 `ApprovalRequired`(409 `image_approval_required`), `RouteUnavailable`(422 `image_route_unavailable`),
`ExecutionFailed`(502 `image_execution_failed`). 거절 셋은 `const`이고 내보내지 않는다. `mediaRefusals`
배열만 내보낸다.

handler `apps/agent/app/.server/api/media.ts`(전체):

```ts
return handlers.handle("generateImage", ({ payload }) =>
  Effect.gen(function* () {
    const selected = yield* Effect.orDie(active.selected);
    if (selected === null)
      return yield* Effect.fail({
        error: "image_route_unavailable",
        reason: "no chat model selected",
      } as const);
    // The paid request stops when the page goes away and the handler is interrupted.
    const signal = yield* Effect.abortSignal;
    const asset = yield* workflow.generate({
      ...payload,
      initiatorChatRouteId: `chat:${selected.provider}:${selected.model}`,
      signal,
    });
    return { ...asset, url: `/api/attachments/${encodeURIComponent(asset.attachment.id)}` };
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      ImageMediaApprovalRequired: (failure) =>
        Effect.fail({
          error: "image_approval_required",
          ...Struct.pick(failure, ["reason", "approval"]),
        } as const),
      ImageMediaUnavailable: ({ reason }) =>
        Effect.fail({ error: "image_route_unavailable", reason } as const),
      ImageMediaExecutionFailed: () => Effect.fail({ error: "image_execution_failed" } as const),
    }),
  ),
);
```

`ImageMediaAsset`(`packages/memory-agent/src/providers/image-media-contracts.ts`)의 항목: `attachment`,
`initiatorChatModel`, `executorMediaRouteId`, `executorMediaModel`(`provider_managed` 또는
`explicit { model }`의 tagged union), `provider`(`"openai"`), `accountId`, `executionMode`, 선택 항목
`estimatedCostUsd`, `usage`, `providerRequestId`.

### 대화 경로의 본보기: `setModel`

계약 `packages/memory-agent/src/api/app-api/sessions.ts:527-533`:

```ts
    HttpApiEndpoint.post("setModel", "/api/sessions/:session/model", {
      params: session,
      headers: sessionHolderHeaders,
      payload: Schema.Struct({ model: Schema.NullOr(ModelSelection) }),
      success: Session,
      error: [SessionInUse, UnknownSession, ModelUnavailable, ProviderUnavailable, ModelListFailed],
    }),
```

같은 파일에 `SessionInUse`(423 `session_in_use`, `:142`), `RunInProgress`(409 `run_in_progress`, `:251`),
`UnknownSession`, `sessionsRefusals`(`:291`)가 있다. handler는 `apps/agent/app/.server/api/sessions.ts:309`의
`setModel`이다. holder는 `headers["x-session-holder"] ?? null`로 읽는다.

### 저장소 규칙

- `let`, `while`, `unknown`, lint 끄기 주석을 쓰지 않는다. 반복은 Effect의 조합자(`Effect.retry`,
  `Effect.repeat`, `Effect.forEach`)로 쓴다.
- tagged union은 생성자와 `Match.valueTags`, `$match`, `Predicate.isTagged`로 다룬다.
- id는 `effect/crypto`의 `SecureRandom`(`crypto.uuidV7` 등 `chat.ts`가 이미 쓰는 방식)으로 만든다.
- JSON 글자는 `JSON.stringify`를 직접 쓰지 말고 `chat.ts`나 `record.ts`가 쓰는 Schema 기반 인코더를
  쓴다(typecheck가 `TS377026`으로 막는다). 같은 파일의 기존 사용처를 찾아 같은 방식으로 쓴다.
- 조건 한 줄짜리 가드는 `Effect.when`, 값에 따른 갈림은 `if`를 쓴다. 뜻 없는 `(x) => f(x)` 감싸기를
  쓰지 않는다.
- 주석과 코드의 말은 영어, 문서는 한국어 평서문이다.

## Commands you will need

| Purpose           | Command                                                                      | Expected on success                          |
| ----------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| 서버 typecheck    | 저장소 루트에서 `vp run memory-agent#typecheck`                              | exit 0, 출력에 `error TS`와 `warning`이 없다 |
| agent typecheck   | 저장소 루트에서 `vp run agent#typecheck`                                     | exit 0, 출력에 `error TS`와 `warning`이 없다 |
| 포맷·lint         | 저장소 루트에서 `vp check`                                                   | exit 0                                       |
| 문구 catalog 검사 | 저장소 루트에서 `vp run agent#i18n:check`와 `vp run memory-agent#i18n:check` | exit 0                                       |
| 서버 테스트       | `cd packages/memory-agent && vp test --run <파일들>`                         | all pass                                     |

- **`vp run dev`, `vp pack`, `react-router build`를 돌리지 않는다.**
- **이미지 API를 실제로 부르지 않는다.** 테스트는 `ImageMediaAsset`을 손으로 만든다.
- 새 worktree에서는 `pnpm install --frozen-lockfile`을 먼저 한다. `./+types/*`를 못 찾으면 `apps/agent`에서
  `react-router typegen`을 한다. 서버 테스트가 `NativeOwnerFailed: native-incompatible`로 건너뛰면 저장소
  루트에서 `vp run turbovec#build`를 한다.

## Scope

**In scope**:

- `packages/memory-agent/src/agent/live-runs.ts`
- `packages/memory-agent/src/agent/chat.ts` (동작 둘을 더한다. `start`와 그 밖의 기존 동작은 고치지 않는다)
- `packages/memory-agent/src/agent/image-record.ts` (새 파일. 메시지와 JSON을 만드는 순수 함수)
- `packages/memory-agent/src/api/app-api/media.ts` (거절 셋을 내보내기만 한다)
- `packages/memory-agent/src/api/app-api/sessions.ts` (경로 하나)
- `apps/agent/app/.server/api/sessions.ts` (handler 하나)
- `apps/agent/app/.server/api/media.ts` (실패를 거절로 바꾸는 부분을 함께 쓰게 꺼낼 때만)
- `packages/memory-agent/tests/agent/live-runs.test.ts`, `packages/memory-agent/tests/sessions/image-record.test.ts` (새 파일)
- `packages/memory-agent/src/agent/README.md`, `packages/memory-agent/src/api/README.md`,
  `apps/agent/app/.server/api/README.md`, `docs/decisions.md`

**Out of scope**:

- `ImageMediaWorkflow`와 `packages/memory-agent/src/providers/` 전부.
- `start`, `claim`을 부르는 두 곳, 대기열, `saveThread`의 구현.
- 화면(`apps/agent/app/entry/`). 다음 계획이다.
- 옛 경로 `POST /api/media/image`를 지우는 일. 화면이 옮겨 간 뒤 다음 계획이 지운다.
- 이미지를 붙인 요청, 사용량 표시, 키 유무 표시(설계 문서 5절).

## Git workflow

- 지금 브랜치에 commit한다. 브랜치를 바꾸지 않는다.
- `git add -A`를 쓰지 않는다. 이 계획의 경로만 올린다.
- 단계마다 commit한다. 각 commit은 두 typecheck와 `vp check`를 통과해야 한다.
- 메시지는 한국어 conventional commit이다. 예: `feat(chat): 생성한 이미지를 대화에 적는다`
- push하지 않고 PR을 열지 않는다.

## Steps

### Step 1. 점유 장부에 "쓰는 중" 표시를 더한다

`packages/memory-agent/src/agent/live-runs.ts`를 고친다.

1. 장부에 "쓰는 중"인 대화의 집합을 더한다. run의 표와 이 집합은 **한 `Ref` 안에** 둔다(두 `Ref`로
   나누면 확인과 등록 사이에 틈이 생긴다). 예: `Ref.make({ runs: HashMap.empty<string, LiveRun>(), writers: HashSet.empty<string>() })`.
2. `get`과 `sessionIds`는 `runs`만 읽는다. 돌려주는 값은 지금과 같다.
3. `claim`은 그 대화가 `runs`에 있거나 `writers`에 있으면 `null`을 돌려준다. 그 밖은 지금과 같다.
   `release`는 지금처럼 `runs`에서 제 run만 지운다.
4. 새 동작을 더한다.

```ts
    /**
     * Runs `write` while nothing else may start on the session: a run saves the whole conversation
     * after each step, so a message appended beside one would be overwritten. Null when a run or
     * another write holds the session. The hold is not a run: `get` and `sessionIds` do not show it.
     */
    writing: <A, E, R>(sessionId: string, write: Effect.Effect<A, E, R>): Effect.Effect<A | null, E, R> => …
```

`Ref.modify`로 "run도 writer도 없으면 `writers`에 넣는다"를 한 번에 하고, 넣지 못했으면 `null`을
돌려준다. 넣었으면 `write`를 돌리고 `Effect.ensuring`으로 `writers`에서 뺀다.

새 테스트 `packages/memory-agent/tests/agent/live-runs.test.ts`를 쓴다(`@effect/vitest`의 `it.effect`,
`expect`는 `vite-plus/test`에서 가져온다. `packages/memory-agent/tests/btw-thread-messages-migration.test.ts`가
같은 import를 쓴다. 그 파일이 지워졌으면 `tests/tanstack-rows-migration.test.ts`를 본다).

- `"a write holds the session against a run"`: `writing` 안에서 `claim`을 부르면 `null`이다. `writing`이
  끝난 뒤의 `claim`은 `null`이 아니다.
- `"a run holds the session against a write"`: `claim`한 뒤 `writing`은 `null`을 돌려주고 `write`를 돌리지
  않는다(`Ref`로 돌았는지 센다). `release` 뒤에는 돈다.
- `"a write is not shown as a run"`: `writing` 안에서 `get`은 `null`, `sessionIds`는 `[]`다.
- `"a failed write lets go of the session"`: `write`가 실패해도 그 뒤 `claim`이 `null`이 아니다.

`claim`의 인수는 `{ sessionId, runId, controller: new AbortController() }`면 된다.

**Verify**:

- `cd packages/memory-agent && vp test --run tests/agent/live-runs.test.ts` → 4 passed.
- `vp run memory-agent#typecheck` → 오류와 경고 없음.
- `vp check` → exit 0.

commit한다.

### Step 2. 메시지와 JSON을 만드는 순수 함수

새 파일 `packages/memory-agent/src/agent/image-record.ts`를 쓴다. 서비스 없이 값만 만든다.

- `imageToolName = "generate_image"`를 내보낸다.
- `imageCallArguments(prompt: string)`: 인수 값 `{ prompt }`.
- `imageResult(asset: ImageMediaAsset)`: "Design"의 결과 값. `estimatedCostUsd`는 있을 때만 넣는다
  (`optionalProperty`를 쓴다. `packages/memory-agent/src/providers/image-media.ts:394-405`가 쓰는 방식이다).
- `imageMessages(input: { prompt; asset; ids: { user; assistant; tool; toolCall }; createdAt; argumentsText; resultText })`:
  "Design"의 메시지 셋을 `StoredMessage`의 배열로 돌려준다. JSON 글자는 인수로 받는다(글자로 바꾸는
  일은 Step 3이 한다).

**Verify**: `vp run memory-agent#typecheck` → 오류와 경고 없음. commit은 Step 3과 함께 한다.

### Step 3. `AgentChat`에 동작 둘을 더한다

`packages/memory-agent/src/agent/chat.ts`의 `compact` 정의 바로 뒤에 더한다.

**`imageOrigin(sessionId, holder)`**

```ts
    /**
     * Before a paid image generation for the conversation: refuses another page's session and a
     * session that is answering, and gives the chat route the generation starts from.
     */
    imageOrigin: (sessionId: string, holder: string | null) =>
```

- `refuseOtherHolder`, `sessions.get`, `liveRuns.get`이 있으면 `runInProgress()`. `compact`와 같은 순서다.
- `sessionModel(sessionId)`가 `null`이면 `{ error: "image_route_unavailable", reason: "no chat model selected" }`로
  실패한다. 아니면 `` `chat:${selected.provider}:${selected.model}` ``을 돌려준다. 이 글자의 타입은
  `CrossProviderMediaRunApproval["initiatorChatRouteId"]`다(`apps/agent/app/.server/api/media.ts`가 같은
  글자를 만든다).
- `Effect.catchTags({ SessionNotFound: unknownSession, ProviderUnavailable: unavailableProvider })`를 붙인다.

**`recordImage(sessionId, holder, { prompt, asset })`**

```ts
    /**
     * Writes a generated image into the conversation as the user's prompt, a `generate_image` call
     * and its result, with the picture tied to the result's node so cleanup keeps it. Waits for a
     * run that started meanwhile, and finishes even if the page that asked has gone: the image is
     * already paid for.
     */
    recordImage: (
      sessionId: string,
      holder: string | null,
      image: { readonly prompt: string; readonly asset: ImageMediaAsset },
    ) =>
```

1. `refuseOtherHolder(sessionId, holder)`, `const session = yield* sessions.get(sessionId)`.
2. 쓰는 일 `write`를 만든다.
   - `const kept = (yield* redactor.redactText(image.prompt)).text`
   - id 넷(user, assistant, tool 메시지와 toolCall)을 `crypto`로 만든다. `chat.ts`가 다른 곳에서 id를
     만드는 방식을 그대로 쓴다.
   - 인수 값과 결과 값을 JSON 글자로 바꾼다("저장소 규칙"의 JSON 줄을 따른다).
   - 사용자 node, 호출 node, 결과 node를 "Design"의 모양으로 `nodes.append`한다. `projectId`는
     `session.projectId`다. `runId`는 주지 않는다. 결과 node의 `detail`에 `permission`은 넣지 않는다.
     타입이 `permission`을 요구하면 STOP이다.
   - `attachments.linkStored(resultNode.id, [image.asset.attachment.id])`
   - `const stored = yield* runStore.thread(sessionId)`, 그리고
     `runStore.saveThread(sessionId, [...stored, ...imageMessages(...)])`
   - `events.publishProject(session.projectId, "sessions")`와 `events.publishSession(sessionId, "run-state")`
   - 메시지 id 셋을 돌려준다: `{ userMessageId, assistantMessageId, toolMessageId }`.
3. `liveRuns.writing(sessionId, write)`를 부른다. `null`이면(run이나 다른 쓰기가 쥐고 있다) 기다렸다가
   다시 한다. 기다림: `liveRuns.get(sessionId)`가 run을 주면 그 `ended`를 기다리고, 없으면
   `Effect.sleep("50 millis")`. `let`과 `while` 없이 쓴다. 예: `null`을 tagged 실패로 바꾸고
   `Effect.retry`의 `while`로 그 실패만 다시 하게 하며, 다시 하기 전에 위 기다림을 한다. 횟수 제한은
   두지 않는다(매번 실제 run 하나가 끝나기를 기다린다).
4. 전체를 `Effect.forkIn(scope, { startImmediately: true })` 뒤 `Effect.flatMap(Fiber.join)`으로 돌린다.
   holder 거절과 `SessionNotFound`는 fork 앞에서 난다.
5. `Effect.catchTags({ SessionNotFound: unknownSession })`를 붙인다. 저장의 실패(`nodes`, `attachments`,
   `runStore`가 내는 오류)는 `{ error: "image_record_failed" } as const`로 바꾼다. 어떤 오류가 나는지는
   타입을 보고 `Effect.catchTags`로 하나씩 받는다. 뭉뚱그려 `Effect.catch`로 받지 않는다. 받기 전에
   `logFailure("Generated image was not recorded")`(같은 파일의 기존 도우미)로 적는다.

새 테스트 `packages/memory-agent/tests/sessions/image-record.test.ts`를 쓴다. 본보기는
`packages/memory-agent/tests/sessions/model.test.ts`(`testAgent()(function (it) { … })`, `TestEnv`, `env.use(...)`)와
`packages/memory-agent/tests/memory/record.test.ts`의 Plan 019 테스트 둘(첨부를 저장하고 `purgeOrphans` 뒤에
남는지 보는 방법)이다. `ImageMediaAsset`은 `attachments.save(<작은 PNG bytes>)`로 저장한 첨부와 손으로
채운 나머지 항목(`initiatorChatModel: "gpt-6-astra"`, `executorMediaRouteId: "media:test"`,
`executorMediaModel`은 `provider_managed`, `provider: "openai"`, `accountId: "test"`,
`executionMode: "direct_adapter"`)으로 만든다.

- `"a generated image is written as the prompt, a call and its result"`: `recordImage` 뒤
  `runStore.thread(session.id)`의 끝 세 메시지가 차례로 user(내용이 프롬프트), assistant(`toolCalls[0].function.name`이
  `"generate_image"`, `content`가 `null`), tool(`toolCallId`가 그 호출의 id, 내용을 JSON으로 읽으면
  `preview.attachmentId`가 첨부의 id)이다. 앞에 있던 메시지는 그대로다.
- `"the picture survives cleanup"`: `recordImage` 뒤 `attachments.purgeOrphans`를 돌려도 그 첨부를
  `attachments`에서 읽을 수 있다.
- `"an image is recorded after the run that holds the session ends"`: 이 테스트를 `AgentChat` 밖에서 run을
  쥐게 만들 방법이 `TestEnv`에 없으면 쓰지 않고 그 사실을 보고에 적는다. Step 1의 장부 테스트가 이
  규칙을 본다.

**Verify**:

- `cd packages/memory-agent && vp test --run tests/sessions/image-record.test.ts tests/agent/live-runs.test.ts tests/memory/record.test.ts tests/chat/attachments.test.ts` → all pass.
- `grep -rl "agents/app-fetch" packages/memory-agent/tests | head -3`이 내는 파일을 돌린다 → all pass
  (기존 run 흐름이 그대로인지 본다).
- `vp run memory-agent#typecheck` → 오류와 경고 없음. `vp check` → exit 0.

Step 2와 Step 3을 한 commit으로 올린다.

### Step 4. 경로와 handler

1. `packages/memory-agent/src/api/app-api/media.ts`: `ApprovalRequired`, `RouteUnavailable`, `ExecutionFailed`를
   `export const`로 바꾼다. 다른 것은 고치지 않는다.
2. `packages/memory-agent/src/api/app-api/sessions.ts`: `setModel` 뒤에 경로를 더한다.

```ts
    /**
     * A paid image made from the user's prompt as written and kept in the conversation as the
     * prompt, a `generate_image` call and its result. The page asks the user before it calls.
     */
    HttpApiEndpoint.post("generateImage", "/api/sessions/:session/images", {
      params: session,
      headers: sessionHolderHeaders,
      payload: GenerateImage,
      success: GeneratedImage,
      error: [
        SessionInUse,
        UnknownSession,
        RunInProgress,
        ApprovalRequired,
        RouteUnavailable,
        ExecutionFailed,
        ImageRecordFailed,
      ],
    }),
```

`GenerateImage`, `GeneratedImage`와 거절 셋은 `./media.ts`에서 가져온다. `ImageRecordFailed`는 이 파일에
`const ImageRecordFailed = appRefusal(500, ["image_record_failed"]);`로 더하고 `sessionsRefusals`에 넣는다.
`./media.ts`를 가져오면 import가 돌게 되는지 본다(`media.ts`는 `sessions.ts`를 가져오지 않는다).
`appRefusalStatus`는 "한 코드에 한 상태"를 요구한다. 같은 거절 값을 두 그룹이 쓰는 것은 괜찮다.
typecheck나 테스트가 코드 중복을 막으면 STOP이다. 3. `apps/agent/app/.server/api/sessions.ts`: handler `generateImage`를 더한다. `ImageMediaWorkflow`를
그룹 handler의 처음에서 `yield*`로 얻는다(`apps/agent/app/.server/api/media.ts`가 그렇게 한다).

```ts
      generateImage: ({ params: { session }, headers, payload }) =>
        Effect.gen(function* () {
          const holder = headers["x-session-holder"] ?? null;
          const initiatorChatRouteId = yield* chat.imageOrigin(session, holder);
          // The paid request stops when the page goes away and the handler is interrupted.
          const signal = yield* Effect.abortSignal;
          const asset = yield* workflow.generate({ ...payload, initiatorChatRouteId, signal });
          yield* chat.recordImage(session, holder, { prompt: payload.prompt, asset });
          return { ...asset, url: `/api/attachments/${encodeURIComponent(asset.attachment.id)}` };
        }).pipe(Effect.scoped, /* media.ts와 같은 catchTags */),
```

실패를 거절로 바꾸는 `catchTags` 묶음은 `media.ts`의 것과 같아야 한다. 두 handler가 함께 쓰도록
`apps/agent/app/.server/api/media.ts`에서 함수 하나로 꺼내 내보내도 된다. `chat`의 이름과 그 밖의
거절 처리(`session_in_use`, `session_not_found`, `run_in_progress`)는 이 파일의 다른 handler가 하는
방식을 따른다. 4. 화면의 클라이언트(`apps/agent/app/entry/api.ts`)는 고치지 않는다.

**Verify**:

- `vp run memory-agent#typecheck`, `vp run agent#typecheck` → 오류와 경고 없음.
- `vp check` → exit 0. `vp run agent#i18n:check`, `vp run memory-agent#i18n:check` → exit 0.
- `cd apps/agent && vp test --run app` → all pass.
- 거절 코드나 경로의 목록을 통째로 적어 둔 테스트가 실패하면 그 목록에 새 항목만 더한다.

commit한다.

### Step 5. 문서

- `packages/memory-agent/src/agent/README.md`: `live-runs.ts`의 "쓰는 중" 표시, `image-record.ts`,
  `AgentChat.imageOrigin`과 `recordImage`를 적는다. 불변식 한 줄: "run 밖에서 대화에 메시지를 덧붙이는
  코드는 `liveRuns.writing` 안에서만 쓴다."
- `packages/memory-agent/src/api/README.md`와 `apps/agent/app/.server/api/README.md`: 새 경로와 handler.
- `docs/decisions.md`의 맨 끝에 항목을 더한다.

```md
## 생성한 이미지는 대화에 도구 호출과 결과로 적는다 (2026-11-16)

- 계기: 만든 이미지가 입력창 위에 한 번 보일 뿐 대화 기록에 들어가지 않았고, 어디에도 묶이지 않아 앱을 다시 시작하면 지워졌다. 설계는 `docs/designs/image-generation-in-conversation.md`에 있다.
- 결정: 사용자가 방법 A를 골랐다. 서버가 사용자가 쓴 글 그대로 이미지를 만들고(`POST /api/sessions/:session/images`), 대화에 사용자 메시지, `generate_image` 도구 호출, 도구 결과 세 메시지를 적는다. 모델은 부르지 않는다. `ImageMediaWorkflow`와 승인 흐름은 그대로다.
  - 그림은 결과를 기록하는 node에 묶어 첨부 정리가 지우지 않는다.
  - 프롬프트는 사용자 node로 남아 기억에 들어간다.
  - 다음 턴의 모델은 그림을 보지 못한다. 결과는 글자다.
  - 생성은 run이 아니다. 생성하는 동안 대화를 점유하지 않고, 기록하는 짧은 동안만 run이 시작되지 못하게 한다(`liveRuns.writing`). 그 사이 시작한 run이 있으면 끝나기를 기다렸다가 적는다.
  - 기록은 요청이 끊겨도 끝까지 간다. 이미 돈을 낸 그림이기 때문이다.
- 버린 안: 방법 B(모델이 도구로 부른다). 모델이 프롬프트를 다시 쓰고, 새 승인 종류가 필요하다.
- 버린 안: 생성하는 동안 대화를 run처럼 점유하기. 없는 run이 화면에 답변 중으로 보인다.
- 남은 것: 화면이 새 경로를 쓰게 하는 일, 옛 경로 `POST /api/media/image`를 지우는 일.
```

**Verify**: `vp check` → exit 0. commit한다.

## Test plan

- `tests/agent/live-runs.test.ts`(새 파일, 4개): 쓰는 중 표시가 run을 막고, run이 쓰기를 막고, 표시가
  run으로 보이지 않고, 실패해도 풀린다.
- `tests/sessions/image-record.test.ts`(새 파일, 2–3개): 메시지 셋의 모양과 순서, 정리 뒤에도 그림이
  남는다.
- 기존 run 흐름 테스트(`agents/app-fetch`를 쓰는 파일), `tests/memory/record.test.ts`,
  `tests/chat/attachments.test.ts`가 그대로 통과한다.
- 실제 이미지 API와 실제 채팅 공급자는 부르지 않는다.

## Done criteria

- [ ] `vp run memory-agent#typecheck`, `vp run agent#typecheck` → exit 0, `error TS`와 `warning` 없음
- [ ] `vp check` → exit 0
- [ ] `vp run agent#i18n:check`, `vp run memory-agent#i18n:check` → exit 0
- [ ] Step 1, 3, 4의 테스트 명령 → all pass
- [ ] `grep -n "writing" packages/memory-agent/src/agent/live-runs.ts` → 정의가 나온다
- [ ] `grep -n "/api/sessions/:session/images" packages/memory-agent/src/api/app-api/sessions.ts` → 한 줄
- [ ] `git diff --stat <시작 commit> HEAD -- packages/memory-agent/src/providers packages/memory-agent/src/loop apps/agent/app/entry`
      → 출력 없음
- [ ] `git diff <시작 commit> HEAD -- packages/memory-agent/src/agent/chat.ts | grep -c '^-[^-]'` → `0`
      (`chat.ts`에서 지운 줄이 없다. import 줄을 고쳐 지운 줄이 생기면 그 줄을 보고에 적는다)
- [ ] `git status --short` → 비어 있다

## STOP conditions

- Drift check가 맞지 않는다.
- `claim`을 부르는 두 곳이나 `start`를 고쳐야만 한다.
- `ImageMediaWorkflow`나 `packages/memory-agent/src/providers/`를 고쳐야만 한다.
- `nodes.append`가 run 없는 `tool_call`·`tool_result` node를 받지 않는다(타입이나 DB 제약).
- `saveThread`에 `source`가 있는 assistant 메시지나 `content: null`을 넣으면 실패한다.
- 기존 run 흐름 테스트가 실패한다.
- 같은 거절 코드를 두 그룹이 쓰는 것을 계약이 막는다.

## Maintenance notes

- 다음 계획(화면): 입력창이 새 경로를 부르고, 응답 뒤 대화를 다시 읽고, 입력창 위의 그림과 진행 줄을
  없애고, 도구 카드가 `path` 없는 `preview`도 그리게 하고, `generate_image`의 이름표를 더하고, 생성 중에는
  보내기를 막는다. 그 뒤 옛 경로를 지운다.
- 손으로 확인할 것(자동 테스트가 없다): 이미지를 만든 대화에서 다음 메시지를 보냈을 때 OpenAI와
  Anthropic이 요청을 받는지. 지금 run의 도구 목록에 `generate_image`가 없는데 과거 호출로는 들어 있다.
  도구가 사라진 MCP 호출과 같은 경우다. 공급자가 거절하면 `src/model/history.ts`가 이 쌍을 글로 바꿔
  보내게 한다.
- "쓰는 중" 표시가 있는 수십 밀리초에 시작하려던 run은 `run_in_progress`로 거절된다. 대기열의 메시지는
  이 경우 "확인 대기"로 남는다. 드문 일이고 잃는 것은 없다.
- 제목이 없는 대화에서 이미지부터 만들면 제목이 생기지 않는다. 제목은 run이 만든다.
