# Plan 034: 도구 승인의 답은 승인과 거절 둘이다 (`editedArgs`를 서버에서 지운다)

> **Executor instructions**: 이 계획을 단계 순서대로 따른다. 단계마다 Verify 명령을 돌려 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다. 임의로 풀지 않는다.
> `plans/README.md`는 고치지 않는다(검토자가 표를 관리한다).
>
> **이 저장소에서 찾을 때는 언제나 `rg --hidden -g '!.git' -g '!node_modules'`를 쓴다.** route 핸들러 폴더
> `apps/agent/app/.server`는 이름이 점으로 시작해 `rg`가 기본으로 건너뛴다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat cbc8ed50..HEAD -- packages/memory-agent/src/loop packages/memory-agent/src/chat-store/schema.ts packages/memory-agent/tests/loop packages/memory-agent/tests/golden`
> 바뀐 파일이 있으면 "Current state"의 발췌와 실제 코드를 비교한다. 다르면 STOP이다. 공백과 몇 줄의 번호
> 차이는 다른 것으로 보지 않는다.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (화면이 한 번도 보내지 않은 값을 지운다)
- **Depends on**: 없음(033과 고치는 파일이 겹치지 않는다)
- **Category**: tech-debt
- **Planned at**: commit `cbc8ed50`, 2026-11-23

## Why this matters

`plans/consistency-rules.md`의 R3: 같은 종류의 질문은 어디서 생겼든 같은 선택지를 가진다. 도구 승인은 지금
묻는 경로에 따라 받는 답이 다르다.

| 누가 물었나                     | 서버가 받는 답                                 |
| ------------------------------- | ---------------------------------------------- |
| 메인 대화(`tool_call` 승인)     | 승인 / 거절 / 인자를 고쳐서 승인(`editedArgs`) |
| 서브에이전트·카드·외부 에이전트 | 승인 / 거절                                    |

화면은 어디서도 `editedArgs`를 보내지 않는다. 대화의 승인 카드, 서브에이전트 패널, 판단 대기 함 모두
`approved: true`나 `approved: false`만 보낸다. "인자를 고쳐서 승인"은 서버에만 있고 사용자가 쓸 길이 없다.

사용자가 2026-11-23에 정했다: **서버에서 `editedArgs`를 지운다. 도구 승인의 답은 어디서든 승인과 거절
둘이다.** 인자를 바꾸고 싶으면 거절하고 모델에게 말로 고쳐 달라고 한다. 버린 안: 화면에 인자 편집을 만들고
다른 경로의 승인에도 `editedArgs`를 받게 넓히기.

이 계획은 그것만 한다. 묻는 경로 셋을 계약 하나로 합치는 일(R3의 나머지)과 판단 대기 함(R2)은 뒤의 계획이다.

## Current state

저장소: TypeScript monorepo. `packages/memory-agent`가 서버 로직이다. Effect v4, 명령은 `vp`(Vite+).

### `editedArgs`가 있는 곳

`rg --hidden -n 'editedArgs' packages apps -g '!.git' -g '!node_modules' -g '!*.md'`가 주는 것은 다음이 전부다.

- `packages/memory-agent/src/loop/run.ts` (여섯 줄)
- `packages/memory-agent/src/chat-store/schema.ts` (한 줄)
- `packages/memory-agent/tests/golden/__golden__/`의 다섯 파일: `approval-approved.json`,
  `approval-declined.json`, `goal-approval.json`(두 곳), `mixed-step.json`, `rejections.json`. 저장된 승인
  요청의 `responseSchema` 안에 있다.

`apps/agent`에는 없다. 테스트 코드(`*.test.ts`)에도 없다.

### `packages/memory-agent/src/loop/run.ts`

승인의 답을 담는 값(200행 근처):

```ts
type Approval = Data.TaggedEnum<{
  /**
   * `approvedArgs`: the arguments the approval showed, or the user's edits of them. The call runs
   * only with exactly these.
   */
  Approved: {
    readonly editedArgs: Option.Option<JsonValue>;
    readonly approvedArgs: JsonValue;
  };
  Declined: {};
  Cancelled: {};
}>;
const Approval = Data.taggedEnum<Approval>();

/** The answer to an approval that showed the arguments `shown`. */
const approvalOf = (shown: JsonValue) =>
  InterruptAnswer.$match({
    Resolved: ({ response }) =>
      response.approved
        ? Approval.Approved({
            editedArgs: Option.fromNullishOr(response.editedArgs),
            approvedArgs: response.editedArgs ?? shown,
          })
        : Approval.Declined(),
    Cancelled: () => Approval.Cancelled(),
  });
```

호출 하나의 모양(307행 근처):

```ts
/** A call as the scheduler gets it, with what its admission needs to know. */
interface OfferedCall {
  readonly call: StepCall;
  /** The arguments as the model wrote them. */
  readonly written: string;
  readonly sent: SentArguments;
  /** The user's approval changed the arguments. */
  readonly edited: boolean;
}
```

인자가 도구의 schema에 맞지 않을 때 모델이 읽는 글(`invalidInput`, 333행 근처)의 끝부분:

```ts
    `Received arguments: ${sent.text}`,
    ...(edited
      ? [
          "An approval edit or middleware changed these arguments before the check. The changed input failed the check.",
        ]
      : []),
  ].join("\n");
```

승인을 묻는 interrupt(354행 근처):

```ts
/** The interrupt that asks the user to approve a call of a tool that needs it. */
const approvalRequest = (call: StepCall, tool: RunTool) =>
  Effect.map(asJson(toolParameters(tool.tool)), (editedArgs): StoredInterruptPayload => ({
    id: `approval_${call.id}`,
    reason: "tool_call",
    message: `Approval required to run ${call.name}`,
    toolCallId: call.id,
    responseSchema: {
      oneOf: [
        {
          type: "object",
          properties: { approved: { const: true }, editedArgs },
          required: ["approved"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { approved: { const: false } },
          required: ["approved"],
          additionalProperties: false,
        },
      ],
    },
    metadata: { kind: "approval", toolName: call.name, input: call.params },
  }));
```

부르는 곳은 한 군데다(743행 근처):

```ts
yield *
  Effect.when(
    Effect.flatMap(approvalRequest(planned.call, tool), (request) =>
      decided(CallResult.Waiting({ request })),
    ),
    Effect.succeed(tool.tool.needsApproval === true && planned.gated && Option.isNone(approval)),
  );
```

모델이 쓴 호출에 고친 인자를 덮는 곳(642행 근처):

```ts
/** The call the model made, with the arguments the user's approval edited, if it did. */
const offeredCall = (id: string, name: string, written: string): OfferedCall => {
  const text = written.trim() || "{}";
  const parsed = decodeJson(text);
  const edits = Option.flatMap(
    HashMap.get(approvals, id),
    Approval.$match({
      Approved: ({ editedArgs }) => editedArgs,
      Declined: Option.none<JsonValue>,
      Cancelled: Option.none<JsonValue>,
    }),
  );
  const sentParams = Option.match(parsed, {
    onNone: (): JsonValue => ({}),
    onSome: (params) => (Predicate.isObject(params) ? params : {}),
  });
  return {
    call: { id, name, params: Option.getOrElse(edits, () => sentParams) },
    written,
    sent: { text, parsed: Option.isSome(parsed) },
    edited: Option.isSome(edits),
  };
};
```

승인한 인자와 지금의 인자가 다르면 돌리지 않는 검사(722행 근처). **이 검사는 남는다.** `approvedArgs`는 승인
카드가 보여 준 인자다:

```ts
const approvedArgs = Option.flatMap(
  approval,
  Approval.$match({
    Approved: ({ approvedArgs }) => Option.some(approvedArgs),
    Declined: Option.none<JsonValue>,
    Cancelled: Option.none<JsonValue>,
  }),
);
```

### 그 밖의 곳

`packages/memory-agent/src/chat-store/schema.ts`(167행 근처):

```ts
/**
 * `chat_interrupts.response`. Its own interrupt's `responseSchema` checks it further, as an
 * approval may carry edited arguments of that tool.
 */
export const StoredInterruptResponse = Schema.Union([
  Schema.Struct({
    approved: Schema.Literal(true),
    editedArgs: Schema.optionalKey(Schema.Record(Schema.String, JsonValue)),
  }),
  Schema.Struct({ approved: Schema.Literal(false) }),
]);
```

`packages/memory-agent/src/loop/scheduler.ts`(18행 근처)의 주석:

```ts
  /** The arguments the call runs with: as the model sent them, or as the user edited them. */
  readonly params: JsonValue;
```

`packages/memory-agent/src/loop/resume.ts`는 답을 그 interrupt에 저장된 `responseSchema`로 검사한다
(`approvalResponse` → `checkedResponse`). **이 파일은 고치지 않는다.** 새 승인 요청의 schema에서 `editedArgs`가
빠지면 `additionalProperties: false` 때문에 `editedArgs`를 담은 답은 거절된다.

문서: `packages/memory-agent/src/chat-store/README.md`의 `StoredInterruptResponse` 줄이 "`approved: true`(선택
`editedArgs`)"라고 적는다.

### 테스트

- `packages/memory-agent/tests/loop/run.test.ts`: "refuses a resume that does not answer the waiting call, and
  starts no run"이 잘못된 답을 거절하는 본보기다. 그 안의 `refused` 도우미와 단언 꼴:

  ```ts
  expect(
    yield *
      refused([{ interruptId: "approval_w1", status: "resolved", payload: { approved: "yes" } }]),
  ).toEqual([
    {
      type: "RUN_ERROR",
      code: "invalid-payload",
      message:
        "Approval approval_w1 must be a boolean or decision envelope. One or more interrupt resolutions are invalid.",
      timestamp: 0,
    },
  ]);
  expect(yield * ran).toEqual([]);
  ```

- golden: `cd packages/memory-agent && vp test run --maxWorkers=4 tests/golden`. 다시 쓰기는 같은 명령에 `-u`.

### 지킬 규칙 (`AGENTS.md`, `CLAUDE.md`에서)

- `let`, `while`을 쓰지 않는다. lint 규칙을 끄는 주석을 쓰지 않는다. `unknown`으로 타입을 뭉개지 않는다.
- Effect v4 표준 꼴을 따른다. 뜻 없는 감싸기(`(x) => f(x)`)를 남기지 않는다.
- 줄바꿈만 바꾸는 편집을 하지 않는다. 포맷은 commit hook이 맡는다.
- 이름, 주석, 문서에 만든 말을 쓰지 않는다. 코드 주석은 영어, 문서는 한국어다.

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

- `packages/memory-agent/src/loop/run.ts`
- `packages/memory-agent/src/loop/scheduler.ts` (주석 한 줄)
- `packages/memory-agent/src/chat-store/schema.ts`
- `packages/memory-agent/src/chat-store/README.md`
- `packages/memory-agent/tests/loop/run.test.ts` (단언 하나를 더한다)
- `packages/memory-agent/tests/golden/__golden__/`의 다섯 파일(`-u`로 다시 쓴다)
- `docs/decisions.md` (끝에 항목 하나)

**고치지 않는다**

- `packages/memory-agent/src/loop/resume.ts`
- `packages/memory-agent/src/permissions/`, `packages/memory-agent/src/approvals/`: 다른 두 경로는 이미 승인과
  거절만 받는다.
- `apps/agent`: 화면은 바뀌지 않는다.
- DB migration: 저장된 `chat_interrupts.payload`(옛 `responseSchema`)와 `response`는 그대로 둔다.
- `plans/`.

## Git workflow

- 지금 있는 branch에서 일한다(worktree가 주어졌으면 그 branch). push하지 않는다. merge하지 않는다.
- commit은 둘이다(Step 1, Step 2). 메시지는 한국어 conventional commit이고 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`
- commit마다 typecheck와 lint가 통과해야 한다. 자기가 고친 경로만 commit한다.

## Steps

### Step 1: `editedArgs`를 지운다

1. `run.ts`:
   - `Approval.Approved`에서 `editedArgs`를 지운다. `approvedArgs`만 남는다. 주석을 고친다:
     "`approvedArgs`: the arguments the approval showed. The call runs only with exactly these."
   - `approvalOf`: 승인이면 `Approval.Approved({ approvedArgs: shown })`.
   - `approvalRequest`: `responseSchema`의 첫 갈래에서 `editedArgs`를 지운다
     (`properties: { approved: { const: true } }`). 도구의 인자 schema를 읽을 일이 없어졌으므로 `Effect`가
     아니라 값을 돌려주는 함수로 바꾸고 `tool` 인자를 지운다: `const approvalRequest = (call: StepCall):
     StoredInterruptPayload => ({ … })`. 부르는 곳은 `decided(CallResult.Waiting({ request:
     approvalRequest(planned.call) }))`가 된다.
   - `offeredCall`: `edits`를 지운다. `params`는 `sentParams`다. 돌려주는 값에서 `edited`를 지운다. 함수의
     주석을 고친다: "The call the model made, with its arguments as a JSON value."
   - `OfferedCall`에서 `edited`를 지운다. `invalidInput`에서 `edited`를 받는 것과 "An approval edit or
     middleware changed these arguments …" 갈래를 지운다.
   - 이 일로 쓰이지 않게 된 import나 상수(`asJson`, `toolParameters` 등)가 있으면 지운다. 다른 곳이 쓰면 둔다.
2. `scheduler.ts`의 주석: "The arguments the call runs with, as the model sent them."
3. `schema.ts`: `StoredInterruptResponse`의 첫 갈래에서 `editedArgs`를 지운다. 주석을 고친다:
   "`chat_interrupts.response`: whether the user approved. Its own interrupt's `responseSchema` checks it
   first."
4. `chat-store/README.md`의 `StoredInterruptResponse` 줄: "`approved: true` 또는 `approved: false` 유니온".
5. `tests/loop/run.test.ts`의 "refuses a resume that does not answer the waiting call, and starts no run"에
   단언 하나를 더한다(`expect(yield* ran).toEqual([])` 앞). 인자를 고쳐서 승인하는 답은 거절된다:

   ```ts
   expect(
     yield *
       refused([
         {
           interruptId: "approval_w1",
           status: "resolved",
           payload: { approved: true, editedArgs: { path: "other" } },
         },
       ]),
   ).toEqual([
     {
       type: "RUN_ERROR",
       code: "invalid-payload",
       message: expect.stringContaining("Approval approval_w1 envelope is invalid"),
       timestamp: 0,
     },
   ]);
   ```

   그 테스트의 마지막 단언(`runs`가 `run-1` 하나)은 그대로 통과해야 한다.

6. golden을 다시 쓴다: `cd packages/memory-agent && vp test run --maxWorkers=4 tests/golden -u`.
   `git diff --stat packages/memory-agent/tests/golden`이 "Current state"의 다섯 파일만 보여야 하고, 각 diff는
   `responseSchema` 안의 `"editedArgs": { … }` 덩어리가 사라진 것뿐이어야 한다. 다른 파일이나 다른 줄이
   바뀌면 STOP이다.

**Verify**:

- `rg --hidden -n 'editedArgs' packages apps -g '!.git' -g '!node_modules'` → `tests/loop/run.test.ts`의 새
  단언 한 곳만
- `vp run memory-agent#typecheck` → exit 0
- `vp run agent#typecheck` → exit 0
- `cd packages/memory-agent && vp test run --maxWorkers=4 tests/loop tests/golden tests/chat tests/permission src/loop`
  → 모두 통과
- 루트 `vp lint` → exit 0

commit: `refactor(loop): 도구 승인의 답에서 고친 인자를 지운다`

### Step 2: 결정을 적는다

`docs/decisions.md` 끝에 항목을 더한다. 제목: `## 도구 승인의 답은 승인과 거절 둘이다 (2026-11-23)`. 적을 것:

- 결정(사용자): 도구 승인의 답은 어디서 물었든 승인과 거절 둘이다. 서버의 `editedArgs`(인자를 고쳐서
  승인)를 지웠다. 인자를 바꾸고 싶으면 거절하고 모델에게 말로 고쳐 달라고 한다.
- 계기: 메인 대화의 승인만 `editedArgs`를 받았고 서브에이전트·카드·외부 에이전트의 승인은 받지 않았다.
  화면은 어디서도 그것을 보내지 않았다. 같은 질문이 경로마다 다른 선택지를 가졌다
  (`plans/consistency-rules.md` R3).
- 버린 안: 화면에 인자 편집을 만들고 모든 경로의 승인에 `editedArgs`를 받게 하기. 도구마다 편집 화면이
  필요하고, 고친 인자로 실행하는 길은 승인한 것과 실행하는 것이 같은지 검사하는 자리를 늘린다.
- 남은 것: 승인한 인자와 실행할 인자가 다르면 돌리지 않는 검사(`run.ts`의 `approvedArgs`)는 그대로다. 묻는
  경로 셋을 계약 하나로 합치는 일은 뒤에 한다.
- 호환: 이미 저장된 승인 요청은 옛 `responseSchema`를 갖고 있어 `editedArgs`를 담은 답이 검사를 지나지만,
  서버는 그 값을 읽지 않고 보여 준 인자로 돌린다.

**Verify**: `vp run agent#typecheck` 뒤 루트 `vp lint` → exit 0. commit hook이 통과한다.

commit: `docs(decisions): 도구 승인의 답은 승인과 거절 둘이다`

## Test plan

- 새 단언 하나: `editedArgs`를 담은 답은 `invalid-payload`로 거절되고 아무 도구도 돌지 않는다.
- 다시 쓰는 golden 다섯: 승인 요청의 `responseSchema`만 달라진다.
- 바뀌지 않아야 하는 것: `tests/loop/run.test.ts`의 나머지("does not run an approved call whose plan now
  gives other arguments" 포함), `tests/chat`, `tests/permission`.

## Done criteria

- [ ] `vp run memory-agent#typecheck`, `vp run agent#typecheck`, 루트 `vp lint`가 모두 exit 0이다.
- [ ] Step 1의 테스트 명령이 모두 통과한다.
- [ ] `rg --hidden -n 'editedArgs' packages apps -g '!.git' -g '!node_modules'`의 결과가
      `tests/loop/run.test.ts` 한 곳뿐이다.
- [ ] `rg --hidden -n '\bedited\b' packages/memory-agent/src/loop` → 결과 없음.
- [ ] `git diff cbc8ed50..HEAD --stat -- packages/memory-agent/src/loop/resume.ts apps` → 비어 있다.
- [ ] commit이 둘이다.

## STOP conditions

멈추고 보고한다:

- "Current state"의 발췌가 실제 코드와 다르다(공백과 몇 줄의 번호 차이는 빼고).
- `editedArgs`를 보내거나 읽는 코드가 "Current state"에 적은 곳 말고 또 있다(특히 `apps/agent`나 ACP
  브리지).
- golden에서 다섯 파일 말고 다른 파일이 바뀌거나, `responseSchema` 밖의 줄이 바뀐다.
- `resume.ts`를 고쳐야 통과한다.
- 새 단언의 거절 코드가 `invalid-payload`가 아니다.
- 같은 Verify가 고친 뒤에도 두 번 실패한다.

## Maintenance notes

- 뒤의 계획(R3의 나머지)이 묻는 경로 셋(`tool_call`, `permission_review`, `RelayedApprovals`)을 계약 하나로
  합친다. 이제 셋 모두 답이 승인/거절이라 `responseSchema`도 하나로 맞출 수 있다
  (`permissions/gate.ts`의 `reviewResponseSchema`가 그 모양이다).
- `OfferedCall.edited`가 사라지면서 "middleware가 인자를 바꿨다"는 안내도 사라진다. 지금 인자를 바꾸는 길은
  도구의 `plan`(`Rewritten`)뿐이고, 그것은 승인 카드가 바꾼 인자를 보여 준다.
- 검토할 때 볼 것: 승인한 인자와 실행할 인자가 다르면 돌리지 않는 검사가 그대로인가, golden의 diff가
  `editedArgs` 덩어리뿐인가.
