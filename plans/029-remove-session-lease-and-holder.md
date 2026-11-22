# Plan 029: 세션 lease와 `holder`를 코드에서 걷어낸다

> **Executor instructions**: 이 계획을 단계 순서대로 따른다. 단계마다 Verify 명령을 돌려 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다. 임의로 풀지 않는다. 끝나면
> `plans/README.md`의 이 계획 행을 고친다(검토자가 표를 관리한다고 했으면 고치지 않는다).
>
> **이 저장소에서 찾을 때는 언제나 `rg --hidden -g '!.git' -g '!node_modules'`를 쓴다.** route 핸들러 폴더
> `apps/agent/app/.server`는 이름이 점으로 시작해서 `rg`가 기본으로 건너뛴다.
>
> **먼저 확인**: 계획 028이 들어와 있어야 한다.
> `rg --hidden -n 'refuseOtherHolder|checkHolder|useSessionLease' packages/memory-agent/src apps/agent/app -g '!*.test.ts' -g '!*.md'`
> 가 결과를 내면 028이 아직 없는 것이다. STOP이다.
>
> **Drift check**: 이 계획은 028 뒤의 코드를 고친다. 발췌의 줄 번호는 028 이전(`2dcc89aa`) 기준이라 몇
> 줄에서 수십 줄 어긋난다. 줄 번호가 아니라 이름과 발췌의 글자로 찾는다. 발췌한 정의가 저장소에 없으면
> STOP이다.
>
> **028이 실제로 남긴 것(2026-11-22, `66db16b7` 기준)**: `chat.ts`의 `cancel`, `discardInterrupts`,
> `compact`, `imageOrigin`은 인자 이름이 `_holder`다. 028이 더한 테스트(`tests/chat/session.test.ts`의 세
> 테스트, `tests/chat/two-pages.test.ts`)는 `holder`를 넘긴다. 화면의 `chat-approvals.tsx`,
> `subagent-panel.tsx`, `uncertain-runs.tsx`, `message.tsx`는 `readOnly` prop이 없고 `holder` prop만 남았다.
> `chat-session.ts`의 `answer`는 거절 `approval_not_pending`·`run_in_progress`를 버리고 대화를 다시 읽는다.
> 이 동작과 그 테스트는 인자만 맞추고 그대로 둔다.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (지우는 일이다. 동작은 028에서 이미 바뀌었다)
- **Depends on**: plans/028-any-tab-operates-a-session.md
- **Category**: tech-debt
- **Planned at**: commit `2dcc89aa`, 2026-11-22

## Why this matters

계획 028 뒤에 세션 lease는 아무것도 막지 않는다. 그런데 코드에는 그대로 남는다. 화면은 요청마다
`X-Session-Holder` 헤더를 보내고, 서버 함수 스무 개 남짓이 쓰지 않는 `holder` 인자를 받고, lease API와
`SessionLeases` 서비스가 살아 있고, run 상태 응답은 `lease` 필드를 싣는다. ACP 브리지는 여전히 lease를
잡아서 같은 대화에 에디터 연결을 하나만 받는다. 남겨 두면 다음 사람이 "이 인자가 무엇을 지키는가"를 다시
읽어야 하고, 새 코드가 `holder`에 기대기 시작한다.

사용자 결정(2026-11-22, `plans/consistency-rules.md`의 R15): "`holder`, `SessionLeases`, 20초 갱신, 423 응답,
ACP holder 갱신을 걷어낸다."

이 계획은 동작을 바꾸지 않는다. 한 가지만 달라진다: ACP 브리지가 같은 대화에 두 번째 에디터 연결을
거절하지 않는다(다른 탭과 같은 규칙이 된다).

## Current state

저장소: TypeScript monorepo. `packages/memory-agent`가 서버 로직, `apps/agent`가 React 화면과 route 핸들러
(`apps/agent/app/.server`)다. Effect v4, 명령은 `vp`(Vite+).

지울 것을 층별로 적는다. **지우는 방법은 정의를 먼저 지우고 typecheck가 가리키는 쓰임을 따라가는 것이다.**

### 서버: lease 저장소와 타입

- `packages/memory-agent/src/sessions/leases.ts`(137줄): `SessionLeases` 서비스, `makeLeases`,
  `defaultLeaseTtlMs`. 파일째 지운다. 테스트 `src/sessions/leases.test.ts`와
  `tests/session-leases-effect.test.ts`도 지운다.
- `packages/memory-agent/src/sessions/lease-state.ts`(11줄): 파일째 지운다.

  ```ts
  /** Header a page sends with every change it makes to a session (send, approve, cancel). */
  export const sessionHolderHeader = "X-Session-Holder";

  /** Who may change a session, as seen by one page (holder). */
  export type { LeaseView } from "./contracts.ts";

  export type ClaimResult =
    | { readonly claimed: true }
    | { readonly claimed: false; readonly heldSince: number };
  ```

- `packages/memory-agent/src/sessions/contracts.ts:29-38`의 `LeaseView` schema와 타입.
- 내보내기: `src/index.ts:459`(`SessionLeases, defaultLeaseTtlMs, makeLeases`), `src/index.ts:469`
  (`sessionHolderHeader, ClaimResult, LeaseView`), `src/tools/definitions.ts:41`.
- layer: `src/layers.ts:113`(import), `179`(`leaseTtlMs` 옵션), `317`(`SessionLeases.layer(options.leaseTtlMs)`).
  `leaseTtlMs`를 넘기는 코드는 없다. `src/README.md:11`이 이 옵션을 적고 있으면 Step 4에서 고친다.

### 서버: `AgentChat`과 run 상태

- `packages/memory-agent/src/agent/chat.ts`:
  - `const leases = yield* SessionLeases;`와 import.
  - `yield* leases.onExpired((sessionId) => events.publishSession(sessionId, "run-state"));`와 그 위 주석.
  - `ChatRequest.holder`:

    ```ts
    export interface ChatRequest {
      /** The page holding the session, from `X-Session-Holder`. */
      readonly holder: string | null;
      readonly input: RunInput;
    ```

  - `holder: string | null`(또는 028이 바꾼 `_holder`) 인자를 받는 메서드 모두. 예: `lifecycleTraceTask`,
    `requestTraceResume`, `cancel`, `discardInterrupts`, `compact`, `imageOrigin`, `status`, `moveWorkflow`,
    `controlWorkflow`, `archive`, `deleteSession`, `enqueue`, `editQueued`, `answerApproval`,
    `continuePastUncertain`. 인자를 지우고 호출하는 쪽을 맞춘다.
  - `lease` 메서드(claim/release를 받는 것)와 `status` 안의 `const lease = yield* leases.view(sessionId, holder);`,
    결과의 `lease` 필드, 워크플로 동작 계산에 넘기는 `lease`.
- `packages/memory-agent/src/agent/run-state.ts:120-121`:

  ```ts
    /** Whether the asking page may change the session. */
    lease: LeaseView,
  ```

- `packages/memory-agent/src/workflow/actions.ts:21-24`의 `WorkflowActionContext.lease`와 `LeaseView` import.
- `packages/memory-agent/src/workflow/contracts.ts:576` 근처의 거절 이유 목록에서 `"session_in_use"`.

### 서버: HTTP API

- `packages/memory-agent/src/api/chat-api.ts`:
  - `const Locked = chatRefusal(423, ["session_in_use"]);`(66행)와 `refusals` 배열의 `Locked`.
  - `holderHeader`, `sessionHolderHeaders`(226-228행)와 endpoint의 `headers: sessionHolderHeaders`.
- `packages/memory-agent/src/api/chat-api-live.ts:59`의
  `{ holder: headers["x-session-holder"] ?? null, input: payload }`.
- `packages/memory-agent/src/api/app-api/sessions.ts`:
  - `LeaseRequest`(118-122행), `lease` endpoint(587행 근처), `LeaseView` import.
  - `const SessionInUse = appRefusal(423, ["session_in_use"]);`(149행)와 그것을 `error`에 넣은 endpoint
    열댓 곳.
  - endpoint 열세 곳의 `headers: sessionHolderHeaders`.
  - `status` endpoint의 `query: { holder: Schema.optional(Schema.String) }`와 그 위 주석의 "whether the
    asking page (`holder`) holds the session".
- `packages/memory-agent/src/api/app-api/trace.ts:49`의 `SessionInUse`와 `106`행의 `headers`.
- route 핸들러 `apps/agent/app/.server/api/sessions.ts`, `apps/agent/app/.server/api/trace.ts`:
  `headers["x-session-holder"] ?? null`을 넘기는 곳, `lease` 핸들러, `status`의 `query: { holder }`.
- `packages/memory-agent/tests/agents/app-fetch.ts`: 테스트용 fetch. `sessionHolderHeader`를 읽고
  `chat.lease`, `chat.status(…, holder)`를 부른다.

### 서버: ACP 브리지

- `packages/memory-agent/src/acp/agent-bridge.ts`:
  - `leaseRenewMs`(68-69행), `BridgeSession.holder`(90-91행)와 `renew` fiber.
  - `open`의 앞부분:

    ```ts
        const holder = `acp-${yield* crypto.uuidV4()}`;
        const lease = yield* api.lease(sessionId, holder, "claim");
        if (lease.state !== "mine")
          return yield* AppRequestFailed.make({
            status: 423,
            code: "session_in_use",
            message: "session_in_use (423)",
            reason: AppRequestReason.cases.RequestRejected.make({}),
          });
        // A failed renewal is retried with backoff. When the retries run out, or on a defect, renewal
        // stops: the app drops the lease and shows the session read-only (decided 2026-10-18).
        const renew = yield* api.lease(sessionId, holder, "claim").pipe(
    ```

  - 닫을 때의 `Fiber.interrupt(session.renew)`와 `api.lease(session.id, session.holder, "release")`(745행 근처).
  - `headers: { "x-session-holder": session.holder }`(408행).
  - `ExplainedFailure`와 `failureMessages`의 `session_in_use`(108, 115행).
- `packages/memory-agent/src/acp/app-api.ts`: `sessionHolderHeader` import, `LeaseSummary`,
  `RunSummary.lease`, `post`의 `holder` 인자, `sessionState`의 `holder`, `lease`, `cancel` 등의 `holder`.
- 서버 메시지 목록: `vp run memory-agent#i18n:extract`가 `.po`를 맞춘다.

### 화면

- `apps/agent/app/entry/session/session-lease.ts`: 028 뒤에 `pageHolder()`만 남아 있다. 파일째 지운다.
- `apps/agent/app/entry/api.ts`: `holder: string` 인자와 `headers: { "x-session-holder": holder }`가
  수십 곳이다. `leaseAction`, `LeaseView` import와 재내보내기, `sessionRunState(session, holder)`의 `holder`.
- `packages/memory-agent/src/api/chat-session.ts`(화면이 쓰는 대화 Atom): `Send.holder`, `Answer.holder`
  (50-66행)와 `headers: { "x-session-holder": input.holder }`(183, 221행).
- `apps/agent/app/entry/queries/session.ts`, `queries/mutations/session.ts`, `queries/mutations/project.ts`:
  `holder` 인자.
- `holder` prop이나 인자를 받는 컴포넌트와 훅: `index.tsx`(`pageHolder()`를 넘기는 다섯 곳),
  `chat/chat-panel.tsx`, `chat/board-panel.tsx`, `chat/board/project-board.tsx`, `board-surface.tsx`,
  `card-peek.tsx`, `board-moves.ts`, `navigation/decision-inbox.tsx`, `session/use-run-state.ts`,
  `session/message-queue.ts`, `media/use-image-generation.ts`, `chat/use-agent-chat.ts`,
  `chat/uncertain-runs.tsx`, `subagent-panel.tsx`, `model-picker.tsx`, `decision-prompt.tsx`,
  `chat-approvals.tsx`.
- `session_in_use` 안내 문구와 분기: `api.ts`(1046-1051, 1088-1093행 근처), `chat/refusals.ts:37`,
  `session/message-queue.ts:32,40`, `media/use-image-generation.ts:22`, `chat/subagent-panel.tsx:60`,
  `chat/decision-prompt.tsx:193`, `chat/board/board-surface.tsx:167`.
- 테스트 fixture의 `lease` 필드와 `holder` 인자.

### 지킬 규칙 (`AGENTS.md`, `CLAUDE.md`에서)

- `let`, `while`을 쓰지 않는다. lint 규칙을 끄는 주석을 쓰지 않는다. `unknown`으로 타입을 뭉개지 않는다.
- 줄바꿈만 바꾸는 편집을 하지 않는다. 포맷은 commit hook이 맡는다.
- 메시지를 지우면 `vp run agent#i18n:extract`, `vp run memory-agent#i18n:extract`로 `.po`를 맞춘다.
- 인자가 둘 이상인 export 함수는 이 저장소에서 `Function.dual` 꼴이다(`queries/session.ts`의
  `useObservedRunStateQuery` 자리에 있던 꼴). 인자를 하나 빼면 `dual`의 arity 숫자도 하나 줄인다. 인자가
  하나만 남으면 `dual`을 벗기고 보통 함수로 둔다.
- 사람이 정한 설계 결정은 `docs/decisions.md` 끝에 날짜와 함께 적는다.

## Commands you will need

| Purpose                | Command                                                                     | Expected on success    |
| ---------------------- | --------------------------------------------------------------------------- | ---------------------- |
| 서버 typecheck         | `vp run memory-agent#typecheck`                                             | exit 0, 오류·경고 없음 |
| 화면 typecheck         | `vp run agent#typecheck`                                                    | exit 0                 |
| lint (저장소 루트)     | `vp lint`                                                                   | exit 0                 |
| 서버 테스트 (고른 것)  | `cd packages/memory-agent && vp test run --maxWorkers=4 <파일…>`            | 모두 통과              |
| 화면 테스트 (jsdom)    | `cd apps/agent && vp test run <파일…>`                                      | 모두 통과              |
| 화면 테스트 (브라우저) | 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run <파일…>` | 모두 통과              |
| 메시지 목록 맞추기     | `vp run agent#i18n:extract`, `vp run memory-agent#i18n:extract`             | exit 0                 |

고친 파일의 테스트만 돌린다. 이 계획은 테스트 파일을 많이 건드리므로, 단계 끝에서
`git diff --name-only HEAD -- '*.test.ts' '*.test.tsx' '*.browser.tsx'`로 고친 테스트 파일을 뽑아 그것들을
돌린다.

## Scope

**In scope**: "Current state"에 적은 파일, 그리고 정의를 지운 뒤 두 typecheck가 가리키는 파일. 테스트와
테스트 지원 코드, README, `.po`를 포함한다.

**Out of scope**:

- `apps/agent/server/tests/dev-agent-chat-boundary.test.ts`의 403 단언(다른 origin). 이 파일에서 지우는
  것은 다음뿐이다: `leases.claim`을 부르는 줄, `X-Session-Holder`를 붙이는 줄, `request` 도우미의 `holder`
  인자(호출을 맞춘다), 5행 import의 `SessionLeases`, 66·138·205행 `Effect.all({ leases: SessionLeases, … })`의
  `leases: SessionLeases`와 그것을 받아 쓰던 이름. 이 파일은 `vp run agent#typecheck`의
  `tsc -p server/tests/tsconfig.json`이 본다.
- 다른 origin을 막는 코드(`SameSite` 관련).
- "release"라는 낱말이 들어간 다른 것들(`releaseNext`, `releaseResources`, 릴리스 계약 등). lease와
  무관하다. `rg -i lease`는 이것들을 함께 잡으므로 `rg -w -i 'lease|leases'`나 이름으로 찾는다.
- 카드 worktree의 `workspace.lease(cardRef)`(`src/kanban/card-queue.ts`). 다른 개념이다.
- 대기열, run 순서, 승인 처리의 동작.

## Git workflow

- 지금 브랜치에서 작업한다(실행자는 자기 worktree에 있다). push하지 않는다.
- 단계마다 commit한다. 한국어 conventional commit. 예: `refactor(chat): 세션 lease 서비스를 지운다`
- commit마다 두 typecheck가 통과해야 한다.

## Steps

### Step 1: ACP 브리지가 lease를 잡지 않는다

`packages/memory-agent/src/acp/agent-bridge.ts`와 `acp/app-api.ts`에서 "서버: ACP 브리지"에 적은 것을
지운다. `open`은 claim 없이 세션을 연다. `BridgeSession`에서 `holder`와 `renew`를 빼고, 닫을 때의 release와
`Fiber.interrupt(session.renew)`를 지운다. `app-api.ts`의 `sessionState`는 `holder` 없이
`/api/sessions/<id>`를 부르고 `RunSummary`에서 `lease`를 뺀다. `ExplainedFailure`의 `session_in_use`를
지우고 `vp run memory-agent#i18n:extract`를 돌린다. 브리지 테스트(`tests/agents/acp-bridge.test.ts`,
`tests/acp-app-api-effect.test.ts`)에는 lease를 단언하는 줄이 없다. 지울 단언이 없다.

- `agent-bridge.ts` 408행의 `headers: { "x-session-holder": session.holder }`는 `headers: {}`로 둔다. endpoint가
  `headers` schema를 선언하고 있는 동안에는 client 요청에 `headers` 키가 있어야 typecheck가 통과한다. 선언은
  Step 3에서 지우고, 그때 이 `headers: {}`도 지운다.
- 닫을 때의 `Effect.all([Fiber.interrupt(session.renew), Effect.ignore(api.lease(…, "release"))], …)`(735-752행
  근처)에서 두 effect를 지우면 할 일이 남지 않는다. 빈 `Effect.all`이나 빈 `Effect.forEach`를 남기지 않고
  `Ref.set(sessions, HashMap.empty())`만 남긴다.

**Verify**:

- `rg -n -i 'holder|lease' packages/memory-agent/src/acp -g '!*.test.ts' -g '!*.md' | rg -v -i 'release'` →
  `x-session-holder`가 없는 `headers: {}` 말고는 결과 없음(README는 Step 4에서 고친다)
- `vp run memory-agent#typecheck` → exit 0
- `cd packages/memory-agent && vp test run --maxWorkers=4 src/acp tests/acp-app-api-effect.test.ts tests/agents/acp-bridge.test.ts`
  → 모두 통과

commit: `refactor(acp): 브리지가 세션 lease를 잡지 않는다`

### Step 2: 화면이 `holder`를 보내지 않는다

1. `apps/agent/app/entry/session/session-lease.ts`를 지운다.
2. `apps/agent/app/entry/api.ts`에서 `holder` 인자와 `"x-session-holder"` 헤더를 모두 지운다. `leaseAction`,
   `LeaseView`의 import와 재내보내기를 지운다. endpoint가 `headers`나 `query` schema를 선언하고 있는
   동안에는 client 요청에 그 키가 있어야 typecheck가 통과한다. 그래서 이 단계에서는 `headers: {}`를 넘기고,
   `sessionRunState`(703행 근처의 `query: { holder }`)는 `query: {}`를 넘긴다. Step 3에서 지운다.
3. `packages/memory-agent/src/api/chat-session.ts`의 `Send.holder`, `Answer.holder`를 지우고, 두 헤더(183,
   221행)는 같은 까닭으로 `headers: {}`로 둔다. Step 3에서 지운다.
4. 두 typecheck를 돌려 오류가 가리키는 쓰임을 고친다. `holder`를 넘기던 prop과 인자를 지운다. `dual`의
   arity를 맞춘다("지킬 규칙").
5. 테스트의 `holder` 인자를 지운다(`{ holder: "tab-a", content: "hi" }` → `{ content: "hi" }`).
6. `holder`나 lease를 **예시 값**으로만 쓰는 테스트는 단언을 지우지 않고 예시를 바꾼다:
   - `apps/agent/app/entry/shared/backend-restart.test.ts`: 전송 계층이 헤더, form 필드, JSON body를 그대로
     보내는지 보는 테스트다. 서버 API와 상관없이 값이 지나가는지만 본다. 헤더 이름 `x-session-holder`는
     `x-test-header`로(23, 39, 56-60, 160, 169행), form 필드 `holder`는 `note`로(118, 126행) 바꾼다. 203-222행은
     경로 `/api/sessions/target/lease`를 `/api/sessions/target/note`로, body
     `'{"holder":"page","action":"claim"}'`을 `'{"note":"page"}'`로, 테스트 이름의 "JSON lease uploads"를 "JSON
     uploads"로 바꾼다. 단언은 바꾼 값으로 유지한다.
   - `apps/agent/app/entry/session/session-lifecycle.test.ts` 97행: `toMatchObject`의 `headers`에서
     `"x-session-holder": "holder-1"` 키만 지운다. `"content-type"`은 남긴다. `"holder-1"`을 넘기던 인자와
     `toHaveBeenCalledWith(sessionId, "holder-1")`의 둘째 인자도 지운다.
   - 같은 파일 116-121행(테스트 "keeps lease failures as errors")과 `session/use-run-state.test.tsx` 167행은
     `session_in_use`를 "서버가 거절한 오류"의 예시로 쓴다. 이 단계에서는 그대로 둔다. Step 3에서 고친다.
   - `apps/agent/app/entry/chat/chat-panel.browser.tsx` 140행 근처의 `/api/sessions/s1/lease` mock 분기는
     화면이 더는 부르지 않으므로 지운다.

**Verify**:

- `rg --hidden -n -w 'holder|pageHolder' apps/agent/app -g '!*.md'` → `apps/agent/app/.server`의 줄만 남는다
  (`backend-restart.test.ts`도 예시 이름을 바꿨으므로 나오지 않는다)
- `rg -n 'x-session-holder' apps/agent/app/entry packages/memory-agent/src/api/chat-session.ts` → 결과 없음
- 두 typecheck → exit 0
- 고친 테스트 파일을 돌린다 → 모두 통과
- 루트 `vp lint` → exit 0

commit: `refactor(app): 화면이 요청에 페이지 이름을 붙이지 않는다`

### Step 3: 서버에서 lease와 `holder`를 지운다

1. `src/sessions/leases.ts`, `lease-state.ts`, 두 lease 테스트 파일을 지운다(`git rm`).
2. `contracts.ts`의 `LeaseView`, `run-state.ts`의 `lease` 필드, `workflow/actions.ts`의 `lease` context,
   `workflow/contracts.ts`의 `"session_in_use"`, `index.ts`와 `tools/definitions.ts`의 내보내기, `layers.ts`의
   import·옵션·layer를 지운다.
3. `chat.ts`에서 "서버: `AgentChat`과 run 상태"에 적은 것을 지운다.
4. API: `chat-api.ts`, `chat-api-live.ts`, `app-api/sessions.ts`, `app-api/trace.ts`에서 "서버: HTTP API"에
   적은 것을 지운다. `error` 배열에서 `SessionInUse`를 뺀다. 배열이 `SessionInUse` 하나뿐이었으면 그 `error`
   키를 지운다.
5. route 핸들러 `apps/agent/app/.server/api/sessions.ts`, `trace.ts`와 `tests/agents/app-fetch.ts`를 맞춘다.
6. 화면: `session_in_use` 문구와 분기("화면" 절의 목록)를 지운다. Step 1·2에서 둔 `headers: {}`와
   `query: {}`를 지운다(`agent-bridge.ts`, `chat-session.ts`, `apps/agent/app/entry/api.ts`).
   `session-lifecycle.test.ts` 116-121행은 `respond({ error: "run_in_progress" }, 409)`와
   `{ status: 409, code: "run_in_progress" }`로 바꾸고 테스트 이름을 "keeps refusals as errors"로 바꾼다.
   `use-run-state.test.tsx` 167행은 `code: "run_in_progress"`로 바꾼다(status 409는 그대로). fixture의 `lease` 필드를 지운다(`use-run-state.test.tsx`, `run-notice.test.ts`,
   `chat-panel.browser.tsx` 등 typecheck가 가리키는 곳).
7. 두 typecheck가 깨끗해질 때까지 가리키는 쓰임을 고친다. 테스트에서 `agent.lease(…)`를 부르는 줄,
   `leases.claim(…)`을 부르는 줄, 메서드에 넘기던 holder 인자(`agent.compact(id, null)` → `agent.compact(id)`)를
   지운다. `tests/workflow/state.test.ts` 800-824행의 테스트("GET exposes the same policy with the requesting
   page's lease")는 `["owner", "observer"]` 둘을 도는 뜻이 없어진다. 한 번만 부르고 이름에서 "with the
   requesting page's lease"를 뺀다. 단언은 남긴다.
8. Verify가 잡지 않는 남은 자리를 고친다:
   - `tools/navigation-verification.mjs`의 `/lease` mock 분기와 `lease: { state: "mine" }` 필드.
   - `packages/memory-agent/src/sessions/contracts.ts` 4-6행의 `lease-state.ts`를 말하는 주석,
     `src/api/app-api/sessions.ts` 267-268행의 `SessionInUse`를 말하는 주석. 지운 것을 가리키는 문장만 고친다.
9. `vp run agent#i18n:extract`와 `vp run memory-agent#i18n:extract`를 돌린다.

**Verify**:

- `rg --hidden -n 'SessionLeases|LeaseView|LeaseRequest|sessionHolderHeader|x-session-holder|session_in_use|leaseTtlMs|ClaimResult' packages/memory-agent apps/agent -g '!node_modules' -g '!*.md' -g '!build'`
  → 결과 없음
- `rg --hidden -n -w 'holder|_holder' packages/memory-agent/src/agent packages/memory-agent/src/api apps/agent/app packages/memory-agent/tests/chat -g '!*.md'`
  → 결과 없음
- `rg -n -i -w 'lease' tools/navigation-verification.mjs apps/agent/app/entry/chat/chat-panel.browser.tsx`
  → 결과 없음
- 두 typecheck → exit 0
- `cd packages/memory-agent && vp test run --maxWorkers=4 tests/chat tests/workflow tests/compaction tests/integrations/archive.test.ts tests/agents`
  → 모두 통과
- `cd apps/agent && vp test run server/tests/dev-agent-chat-boundary.test.ts app/entry/session` → 모두 통과
- 고친 브라우저 테스트 파일을 돌린다 → 모두 통과
- 루트 `vp lint` → exit 0

commit: `refactor(chat): 세션 lease와 holder 인자를 지운다`

### Step 4: 문서

1. lease, `holder`, `X-Session-Holder`, 423 `session_in_use`를 말하는 README 줄을 지우거나 고친다. 찾는 명령:
   `rg --hidden -n -i -w 'lease|leases|holder|session_in_use' apps packages docs/app-state-streams.md -g '*.md' -g '!node_modules'`
   (`docs/decisions.md`의 지난 기록은 고치지 않는다.) 이 명령의 범위 밖에 있는 `tools/README.md` 17행 근처와
   `docs/httpapi-migration.md`(25, 104행 근처)도 같은 식으로 고친다. `docs/httpapi-migration.md`가 지난 작업의
   기록으로 쓰인 문단이면 고치지 않고 그대로 둔다.
2. `docs/decisions.md` 끝의 "대화는 어느 탭에서든 조작한다 (2026-11-22)" 절(028이 썼다)에 한 줄을 더한다:
   "`holder` 인자, `X-Session-Holder` 헤더, lease API, `SessionLeases`, run 상태의 `lease` 필드를 지웠다. ACP
   브리지도 lease를 잡지 않아 같은 대화에 에디터 연결을 여럿 받는다."

**Verify**: `rg --hidden -n 'SessionLeases|useSessionLease|X-Session-Holder' apps packages -g '*.md' -g '!node_modules'`
→ 결과 없음

commit: `docs: 세션 lease를 지운 것을 문서에 반영한다`

## Test plan

- 새 테스트는 쓰지 않는다. 지우는 계획이다.
- 지우는 테스트: `src/sessions/leases.test.ts`, `tests/session-leases-effect.test.ts`. ACP 브리지 테스트에는
  지울 단언이 없다.
- 028의 `tests/chat/two-pages.test.ts`와 `tests/chat/session.test.ts`의 "an approval another page answered
  closes here, and a late answer to it is dropped"가 그대로 통과해야 한다(인자만 맞춘다). 이 둘이 "두 탭이
  함께 조작한다"와 "답한 승인은 다른 탭에서도 닫힌다"를 지킨다. 단언을 지우거나 약하게 해야 통과하면
  STOP이다.

## Done criteria

- [ ] 두 typecheck가 exit 0, 루트 `vp lint`가 exit 0
- [ ] Step 3의 두 `rg`가 결과를 내지 않는다
- [ ] 각 단계의 테스트 명령이 모두 통과한다
- [ ] `dev-agent-chat-boundary.test.ts`의 `toBe(403)` 수가 고치기 전과 같다
- [ ] `plans/README.md`의 029 행을 고쳤다

## STOP conditions

멈추고 보고한다:

- 028이 들어와 있지 않다("먼저 확인").
- `holder` 값이 lease 말고 다른 일에 쓰이는 곳을 찾았다(예: 어느 페이지가 run을 시작했는지 기록한다,
  스트림을 페이지별로 나눈다). 그 자리와 쓰임을 보고한다. 지우지 않는다.
- 타입 오류를 없애려면 API 응답의 다른 필드나 요청 형태를 바꿔야 한다.
- 다른 origin을 막는 403 단언을 고쳐야 통과한다.
- 같은 Verify가 고친 뒤에도 두 번 실패한다.

## Maintenance notes

- 이 계획 뒤에 요청은 "어느 페이지가 보냈는가"를 싣지 않는다. 페이지를 가려야 하는 기능이 생기면(예:
  보낸 탭에만 안내를 띄운다) lease를 되살리지 말고 그 기능에 맞는 값을 따로 둔다.
- `sessionStorage`의 `context-agent:page-holder` 키는 더는 쓰지 않는다. 남은 값은 탭을 닫으면 사라진다.
  지우는 코드를 두지 않는다.
- 세션 inbox(R8), 판단 대기 함(R2) 계획은 `holder` 없는 API 위에서 쓴다.
