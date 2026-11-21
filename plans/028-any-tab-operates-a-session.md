# Plan 028: 대화를 어느 탭에서든 조작한다 (서버는 다른 탭의 조작을 거절하지 않고, 화면은 읽기 전용이 되지 않는다)

> **Executor instructions**: 이 계획을 단계 순서대로 따른다. 단계마다 Verify 명령을 돌려 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다. 임의로 풀지 않는다. 끝나면
> `plans/README.md`의 이 계획 행을 고친다(검토자가 표를 관리한다고 했으면 고치지 않는다).
>
> **이 저장소에서 찾을 때는 언제나 `rg --hidden -g '!.git' -g '!node_modules'`를 쓴다.** route 핸들러 폴더
> `apps/agent/app/.server`는 이름이 점으로 시작해서 `rg`가 기본으로 건너뛴다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat 2dcc89aa..HEAD -- packages/memory-agent/src/agent/chat.ts packages/memory-agent/src/workflow/actions.ts packages/memory-agent/tests apps/agent/app/.server/api/sessions.ts apps/agent/server/tests/dev-agent-chat-boundary.test.ts apps/agent/app/entry/chat apps/agent/app/entry/session apps/agent/app/entry/queries/session.ts`
> 바뀐 파일이 있으면 "Current state"의 발췌와 실제 코드를 비교한다. 다르면 STOP이다. 발췌와 실제 코드의
> 공백·줄바꿈 차이는 다른 것으로 보지 않는다. 줄 번호가 몇 줄 어긋나는 것도 마찬가지다.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 없음
- **Category**: tech-debt
- **Planned at**: commit `2dcc89aa`, 2026-11-22

## Why this matters

2026-11-02에 "세션 소유권(lease)을 없앤다"고 정하고 세 단계를 했다. 모든 탭이 run을 따라 읽고, 대기
메시지는 서버가 보내고, 초안은 세션마다 따로 저장한다. 그런데 서버는 아직 lease를 쥔 탭이 아니면 조작을
거절하고(`session_in_use`, HTTP 423), 화면은 두 번째 탭에서 입력창 대신 "다른 창에서 이 대화를 쓰고
있습니다" 막대를 보인다. 여러 탭이 입력한다는 전제로 고쳐 놓고 입력은 한 탭만 되는 상태다.

사용자가 2026-11-22에 정했다(`plans/consistency-rules.md`의 R15): lease를 끝까지 없앤다. 어느 탭이든
대화를 조작하고, 동시에 온 조작은 서버가 순서대로 처리한다. 판단 대기 함에서 승인에 답하기, 다른 대화가
메시지를 넣기 같은 뒤따르는 작업이 "그 대화를 연 탭"이 아닌 곳에서 조작하므로, lease가 남으면 그 길마다
예외가 필요하다.

이 계획은 동작만 바꾼다. 서버가 거절을 멈추고, 화면이 lease를 잡지 않는다. `holder` 인자, lease API,
`SessionLeases` 서비스, 응답의 `lease` 필드를 지우는 일은 계획 029가 한다. 그래서 이 계획이 끝나도 화면은
`X-Session-Holder` 헤더를 계속 보내고, 서버는 그것을 받되 쓰지 않는다.

## Current state

저장소: TypeScript monorepo. `packages/memory-agent`가 서버 로직, `apps/agent`가 React 화면과 route 핸들러
(`apps/agent/app/.server`)다. Effect v4를 쓴다. 명령은 `vp`(Vite+)로 돌린다.

### 서버가 이미 순서를 지키는 것 (바꾸지 않는다)

- 한 대화에서 run은 한 번에 하나다. `packages/memory-agent/src/agent/chat.ts`가 `liveRuns.claim`으로
  잡고, 이미 도는 run이 있으면 `{ error: "run_in_progress" }`로 거절한다.
- 화면은 보낸 메시지가 `run_in_progress`로 거절되면 대기열에 넣는다
  (`apps/agent/app/entry/chat/chat-panel.tsx:428-446`의 `onNotTaken`).
- 화면의 승인 답은 `resume`을 담은 run 요청이다. 서버는 그 답을 기다리는 승인과 맞춰 본다(`chat.ts`의
  `pendingResume`, `resumeRunId`, 1385-1398행 근처). 맞는 승인이 없으면 `resumeRunId`가 `undefined`가 되어
  사용자 메시지가 없는 보통 run 요청으로 다뤄진다. 그 요청은 `no_user_turn`으로 거절될 것으로 본다
  (`chat.ts:1526-1527`). **이 예상은 Step 1의 새 테스트가 확인한다.**
- 다른 대화가 넘겨받은 승인의 답(`answerApproval`)은 기다리는 승인이 없으면 `approval_not_pending`이다.

### 서버가 거절하는 곳

`packages/memory-agent/src/agent/chat.ts:758-763`:

```ts
/** Refuses a change while another page holds the session. */
const refuseOtherHolder = (sessionId: string, holder: string | null) =>
  Effect.when(
    Effect.fail({ error: "session_in_use" } as const),
    Effect.map(leases.permits(sessionId, holder), (permitted) => !permitted),
  );
```

부르는 곳은 같은 파일에 15곳이다.

- `yield* refuseOtherHolder(sessionId, holder);` 한 줄 꼴 14곳: 1218, 1243, 2402, 2460, 2477, 2491, 2518,
  2547, 2674, 2701, 2743, 2761, 2823, 2882행.
- pipe 꼴 1곳, `editQueued`(2892-2900행):

  ```ts
      editQueued: (sessionId: string, holder: string | null, id: string, edit: QueueEdit) =>
        refuseOtherHolder(sessionId, holder).pipe(
          Effect.andThen(applyEdit(sessionId, id, edit)),
          Effect.tap(() =>
            Effect.when(wakeNotifications(sessionId), Effect.succeed(!QueueEdit.$is("edit")(edit))),
          ),
          Effect.catchTag("QueueChangeRefused", ({ reason }) =>
            Effect.fail({ error: `queue_${reason}` } as const),
          ),
  ```

run을 시작하는 길은 따로 검사한다. 같은 파일 1332-1334행:

```ts
// Sending, approving and answering all come here; a read-only page may do none of them.
if (internalFollowup === null && !(yield * leases.permits(sessionId, request.holder)))
  return refused({ error: "session_in_use" });
```

워크플로 동작도 검사한다. `packages/memory-agent/src/workflow/actions.ts:44-49`:

```ts
function evaluateWorkflowActionBody(
  state: WorkflowState,
  request: WorkflowActionRequest,
  context: WorkflowActionContext = {},
): WorkflowActionDecision {
  if (context.lease?.state === "other") return { allowed: false, reason: "session_in_use" };
```

`lease`를 context로 넘기는 곳은 `chat.ts:2659` 하나이고, 읽는 곳은 위의 한 줄뿐이다.

route 핸들러에도 같은 검사가 하나 더 있다. `apps/agent/app/.server/api/sessions.ts:49-54`:

```ts
/** Refuses a change while another page holds the session. */
const checkHolder = (sessionId: string, holder: string | undefined) =>
  Effect.when(
    Effect.fail({ error: "session_in_use" } as const),
    Effect.map(leases.permits(sessionId, holder ?? null), (permitted) => !permitted),
  );
```

`answerDecision`(126행), `editBoard`(148행), `kanbanAction`(200행), `setModel`(314행)이 부른다. 같은 파일의
`leases`(41행 `const leases = yield* SessionLeases;`, import는 18행)는 53행에서만 쓰인다.

### 화면이 lease를 잡는 곳

- `apps/agent/app/entry/session/session-lease.ts`(199줄):
  - `holderKey`, `newHolder`, `pageHolder()`(36-42행): 이 페이지의 이름을 `sessionStorage`의
    `context-agent:page-holder`에서 읽거나 만든다. **이 셋만 남긴다.** `index.tsx` 등이 `pageHolder()`를 쓴다.
  - 나머지는 **모두 지운다**: `runLeaseAction`(13행), HMR dispose(14행), `leaseAction`(15-16행),
    `renewMs`, `holdIdentity`, `let identity`(58행), `pageIdentity`, `PageLease` 타입, `useSessionLease`.
- `apps/agent/app/entry/session/lease-actions.ts`(59줄)와 `lease-actions.test.ts`: `session-lease.ts`만 쓴다.
  **지운다.**
- `apps/agent/app/entry/chat/read-only-bar.tsx`(96줄): 입력창 자리에 그리는 막대. **지운다.**
- `apps/agent/app/entry/queries/session.ts:116-128`의 `useObservedRunStateQuery`: `session-lease.ts`만 쓴다.
  **지운다.**
- `apps/agent/app/entry/chat/chat-panel.tsx`:

  307-317행(바깥 컴포넌트):

  ```tsx
    const { holder, lease, refused, continueHere } = useSessionLease(sessionId);
    const [syncRevision, setSyncRevision] = useState(0);
    const reading = lease.state === "other" || lease.state === "free";
    return (
      <ChatPanel
        key={`${reading ? "read" : "write"}:sync:${syncRevision}`}
        sessionId={sessionId}
        holder={holder}
        lease={lease}
        refused={refused}
        onContinue={() => void continueHere()}
  ```

  364-366행(안쪽 `ChatPanel`):

  ```tsx
  const readOnly = lease.state !== "mine";
  const backendRestartRequired = useBackendRestartRequired();
  const mutationBlocked = readOnly || backendRestartRequired || !sendingEnabled;
  ```

  `readOnly`는 771, 785, 1049, 1069, 1083, 1091, 1158행에서 쓰이고, 1172-1173행이 막대를 그린다:

  ```tsx
            {isBlocked(lease) ? (
              <ReadOnlyBar lease={lease} refused={refused} onContinue={onContinue} />
            ) : (
              <DraftComposer
  ```

- `ChatPanel`의 `readOnly`를 prop으로 받는 자식(값은 모두 lease에서 온다):
  - `chat/chat-approvals.tsx`: 48, 58, 129, 146행
  - `chat/subagent-panel.tsx`: 37, 42, 105행
  - `chat/uncertain-runs.tsx`: 27, 34, 111행
  - `chat/message.tsx`: `MessageView`(776, 790, 852, 935행) → 670, 680, 692행 → `TaskSummaryCard`(460, 467,
    578, 599, 619행). fixture는 `chat/message.browser.tsx:21`(`readOnly: false`).
- **lease에서 오지 않는 `readOnly`는 그대로 둔다**: `chat/chat-composer.tsx:205`의
  `readOnly={mutationBlocked}`와 `chat/queue-panel.tsx`의 `readOnly`. `mutationBlocked`에서 온다.
- 다른 컴포넌트(보드, 판단 대기 함, 사이드바, 모델 선택)는 lease로 스스로를 막지 않는다. `pageHolder()`만
  넘긴다. 고치지 않는다.

### 지금 동작을 단언하는 테스트

- `packages/memory-agent/tests/chat/leases.test.ts`: 두 번째 탭의 승인 답, 메시지, 취소가
  `session_in_use`로 거절됨을 단언한다. 20-23행이 lease를 claim하고, 26행부터 탭 A가 메시지를 보낸다.
- `packages/memory-agent/tests/chat/session.test.ts:36-65`: "a sent turn shows its run, and a refused turn goes
  back to the page". 뒤 절반(55-63행)이 다른 탭의 claim으로 거절을 만든다.
- `packages/memory-agent/tests/compaction/agent-chat.test.ts:97-100`: `agent.lease(…, "tab-a", "claim")` 뒤
  `agent.compact(…, "tab-b")`가 `session_in_use`임을 단언한다.
- `packages/memory-agent/tests/integrations/archive.test.ts:65-75`: "respect another page's lease and safely
  stop a running answer before archive". 앞부분이 claim과 `session_in_use`를 단언한다.
- `packages/memory-agent/tests/workflow/state.test.ts:800-824`: "GET exposes the same policy with the
  requesting page's lease". `owner`와 `observer`가 각각 snapshot을 읽고 `moveWorkflow`를 부른다.
- `apps/agent/server/tests/dev-agent-chat-boundary.test.ts`: 로컬 HTTP 경계 테스트다. 두 가지를 섞어 단언한다.
  - 다른 origin의 요청은 403이고 아무 효과도 남기지 않는다(85행, 186행). lease와 무관하다. **그대로 둔다.**
  - lease를 쥔 페이지가 아니면 423이다(89, 93, 247, 248행). 테스트의 주석이 스스로 말한다(115-116행):
    "Leases enforce local page ownership, not login identity. The route currently still permits a
    same-origin script when a session has no live page lease." lease는 보안 경계가 아니라 탭 사이의 양보였다.
    **이 단언이 바뀐다.**
- 화면 테스트의 run 상태 fixture(`session/use-run-state.test.tsx:34`, `session/run-notice.test.ts:17`,
  `chat/chat-panel.browser.tsx:58`)에는 `lease` 필드가 있다. 서버 타입 `SessionRunState.lease`가 필수
  필드이므로 **이 셋은 고치지 않는다**(029가 필드와 함께 지운다).

### 지킬 규칙 (`AGENTS.md`, `CLAUDE.md`에서)

- `let`, `while`을 쓰지 않는다. lint 규칙을 끄는 주석을 쓰지 않는다.
- 줄바꿈만 바꾸는 편집을 하지 않는다. 포맷은 commit hook의 `vp check --fix`가 맡는다.
- 화면 글자는 Lingui 메시지다. 메시지를 지우거나 바꾸면 `vp run agent#i18n:extract`로 `.po`를 맞춘다.
- 사람이 정한 설계 결정은 `docs/decisions.md` 끝에 날짜와 함께 적는다.
- 이름, 주석, 문서에 "poisoned" 같은 만든 말을 쓰지 않는다. 쉬운 말을 쓴다.

## Commands you will need

| Purpose                | Command                                                                     | Expected on success    |
| ---------------------- | --------------------------------------------------------------------------- | ---------------------- |
| 서버 typecheck         | `vp run memory-agent#typecheck`                                             | exit 0, 오류·경고 없음 |
| 화면 typecheck         | `vp run agent#typecheck`                                                    | exit 0                 |
| lint (저장소 루트)     | `vp lint`                                                                   | exit 0                 |
| 서버 테스트 (고른 것)  | `cd packages/memory-agent && vp test run --maxWorkers=4 <파일…>`            | 모두 통과              |
| 화면 테스트 (jsdom)    | `cd apps/agent && vp test run <파일…>`                                      | 모두 통과              |
| 화면 테스트 (브라우저) | 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run <파일…>` | 모두 통과              |
| 메시지 목록 맞추기     | `vp run agent#i18n:extract`                                                 | exit 0                 |

전체 테스트는 돌리지 않는다. 고친 파일의 테스트만 돌린다. 브라우저 테스트가 처음에 페이지 reload로
실패하면 한 번 더 돌린다. `optimizeDeps`를 고치지 않는다.

## Scope

**In scope**:

- `packages/memory-agent/src/agent/chat.ts`
- `packages/memory-agent/src/workflow/actions.ts`
- `apps/agent/app/.server/api/sessions.ts` (`checkHolder`, 그 호출 넷, 쓰이지 않게 되는 `leases`와 import)
- 서버 테스트: `tests/chat/leases.test.ts`(→ `two-pages.test.ts`), `tests/chat/session.test.ts`,
  `tests/compaction/agent-chat.test.ts`, `tests/integrations/archive.test.ts`,
  `apps/agent/server/tests/dev-agent-chat-boundary.test.ts`(Step 1의 8번에 적은 줄만), 그리고 Step 1의
  `rg`가 찾는 `session_in_use` 단언
- `apps/agent/app/entry/chat/chat-panel.tsx`, `chat-approvals.tsx`, `subagent-panel.tsx`,
  `uncertain-runs.tsx`, `message.tsx`, `message.browser.tsx`
- `apps/agent/app/entry/chat/read-only-bar.tsx` (삭제)
- `apps/agent/app/entry/session/session-lease.ts`
- `apps/agent/app/entry/session/lease-actions.ts`, `lease-actions.test.ts` (삭제)
- `apps/agent/app/entry/queries/session.ts`
- `apps/agent/app/entry/chat/chat-panel.browser.tsx` (지운 prop과 읽기 전용 막대 단언만)
- `apps/agent/app/locales/ko.po` (extract 명령이 고친다)
- 문서와 주석(Step 3): `apps/agent/app/entry/session/README.md`, `apps/agent/app/entry/chat/README.md`,
  `apps/agent/app/entry/queries/README.md`, `apps/agent/app/.server/api/README.md`,
  `packages/memory-agent/src/workflow/README.md`, `apps/agent/README.md`, 그리고 고친 소스 파일 안의 주석
- `docs/decisions.md` (끝에 한 절 추가)

**Out of scope** (계획 029가 한다. 이 계획에서 건드리지 않는다):

- `packages/memory-agent/src/sessions/leases.ts`, `leases.test.ts`, `lease-state.ts`, `contracts.ts`의
  `LeaseView`, `tests/session-leases-effect.test.ts`.
- lease API(`POST /api/sessions/:session/lease`와 그 핸들러), 응답의 `lease` 필드, `SessionInUse` 423 선언
  (`src/api/app-api/sessions.ts`, `trace.ts`, `src/api/chat-api.ts`), `WorkflowActionContext.lease` 필드.
- 함수와 요청의 `holder` 인자, `X-Session-Holder` 헤더, `api.ts`와 `queries/mutations`의 `holder`.
- ACP 브리지(`src/acp/agent-bridge.ts`, `src/acp/app-api.ts`). 브리지는 여전히 lease를 claim하고, claim이
  `mine`이 아니면 스스로 423을 낸다(458-465행). 에디터 연결이 둘일 때의 그 거절은 029까지 남는다.
- 화면의 `session_in_use` 안내 문구(`api.ts`, `refusals.ts`, `message-queue.ts` 등). 서버가 더는 이 코드를
  내지 않지만 타입에 남아 있으므로 문구도 029에서 함께 지운다.
- 다른 origin의 요청을 403으로 막는 코드와 그 단언. lease와 무관한 보안 경계다.
- `packages/memory-agent/tests/agents/app-fetch.ts`, `apps/agent/app/.server`의 테스트,
  `session-lifecycle.test.ts`, `use-run-state.test.tsx`, `run-notice.test.ts`. 고칠 필요가 없다.

## Git workflow

- 지금 브랜치에서 작업한다(실행자는 자기 worktree에 있다). push하지 않는다.
- 단계마다 commit한다. 메시지는 한국어 conventional commit이다. 예:
  `feat(chat): 이미지 생성을 대화 경로로 보내고 끝나면 대화를 다시 읽는다`
- commit마다 두 typecheck가 통과해야 한다.

## Steps

### Step 1: 서버가 다른 탭의 조작을 거절하지 않는다

1. `packages/memory-agent/src/agent/chat.ts`에서 `refuseOtherHolder` 정의(758-763행)를 지운다.
2. `yield* refuseOtherHolder(sessionId, holder);` 14줄을 지운다.
3. `editQueued`는 `refuseOtherHolder(sessionId, holder).pipe(Effect.andThen(applyEdit(sessionId, id, edit)), …)`
   를 `applyEdit(sessionId, id, edit).pipe(…)`로 바꾼다. 뒤의 `Effect.tap`과 `Effect.catchTag`는 그대로 둔다.
4. 같은 파일 1332-1334행의 주석과 `leases.permits` 검사를 지운다.
5. `holder` 인자는 함수 서명에 그대로 둔다(029가 지운다). 쓰이지 않게 된 인자가 lint에 걸리면 그 인자
   이름만 `_holder`로 바꾼다. 서명의 순서와 타입은 바꾸지 않는다. `leases.view`, `leases.claim`,
   `leases.release`, `leases.onExpired`를 쓰는 곳도 그대로 둔다.
6. `packages/memory-agent/src/workflow/actions.ts:49`의 `context.lease?.state === "other"` 줄을 지운다.
   `WorkflowActionContext`의 `lease` 필드는 그대로 둔다.
7. `apps/agent/app/.server/api/sessions.ts`:
   - `checkHolder` 정의(49-54행), `const leases = yield* SessionLeases;`(41행), `SessionLeases` import(18행)를
     지운다.
   - `checkHolder(session, headers["x-session-holder"]).pipe(Effect.andThen(X), …)` 꼴(126, 200행)은
     `X.pipe(…)`로 바꾼다. 뒤따르는 `Effect.tap`, `Effect.catchTags`는 그대로 둔다.
   - `yield* checkHolder(…);` 줄(148, 314행)은 그 줄만 지운다.
   - 핸들러 인자에서 쓰지 않게 된 `headers`는 destructuring에서 뺀다.
   - 같은 파일의 `lease` 핸들러(351행 근처, `chat.lease`를 부른다)는 그대로 둔다.
8. 테스트를 고친다.
   - `tests/chat/leases.test.ts`를 `tests/chat/two-pages.test.ts`로 옮기고(`git mv`) 테스트 하나로 다시 쓴다.
     `describe` 이름은 "two pages", 테스트 이름은 "two pages both operate one session; a second answer to
     the same approval is refused". 지금 파일의 26행(`const owner = yield* openPage(sessionId, "tab-a");`)부터
     쓰고, `agent.lease`와 `leaseOf`를 부르는 줄은 쓰지 않는다.
     - 탭 A가 `"please use the shell"`을 보내 승인이 하나 기다린다(`owner.pending()`의 길이 1).
     - 탭 B(`openPage(sessionId, "tab-b")`)가 같은 승인을 본다(`reader.pending()`의 길이 1).
     - 탭 B가 `reader.resolve(() => true)`로 답한다. 성공하고 `reader.answer()`에 `"approved-output"`이 있다.
     - 탭 A가 같은 승인에 답한다: `Effect.flip(owner.resolve(() => true))`가 **실패 값을 돌려준다**(거절된다).
       그 값의 `error`가 `"no_user_turn"`일 것으로 본다. `toMatchObject({ error: "no_user_turn" })`로
       단언한다. 다른 거절 코드가 오면 그 코드로 단언하고 commit 메시지에 적는다. **거절되지 않고 성공하면
       STOP이다**(같은 승인에 두 번 답할 수 있다는 뜻이다).
     - `agent.cancel(sessionId, "tab-b")`를 `Effect.flip`으로 받아 `{ error: "no_running_run" }`임을
       단언한다(도는 run이 없다). `session_in_use`가 아니어야 한다.
   - `tests/chat/session.test.ts`의 "a sent turn shows its run, and a refused turn goes back to the page":
     55행의 `agentChat.lease(session, "tab-b", "claim")` 줄을 지우고, 거절의 원인을 빈 메시지로 바꾼다.
     `again`을 `{ holder: "tab-a", content: "   " }`로 하고 두 단언의 `session_in_use`를 `empty_message`로
     바꾼다. 빈 메시지가 서버에 닿기 전에 걸러져서 거절이 오지 않으면, 55-63행을 지우고 테스트 이름을
     "a sent turn shows its run"으로 줄인다. 어느 쪽을 했는지 commit 메시지에 적는다.
   - `tests/compaction/agent-chat.test.ts:97-100`: `agent.lease` 줄과 `session_in_use` 단언을 지운다. 바로
     아래의 없는 세션에 대한 단언은 남긴다.
   - `tests/integrations/archive.test.ts:65-75` 근처: `agent.lease(session, "tab-a", "claim")` 줄과
     `session_in_use` 단언, 그리고 그 뒤에 lease를 풀거나 다시 잡는 줄을 지운다. 답변 중인 대화를 멈추고
     보관하는 나머지 단언은 남긴다. 테스트 이름에서 "respect another page's lease and "를 뺀다.
   - `tests/workflow/state.test.ts:800-824`는 고치지 않는다. 그대로 통과할 것으로 본다(탭마다 snapshot을
     먼저 읽고 그 값과 비교한다). 실패하면 STOP이다.
   - `rg --hidden -n 'session_in_use' packages/memory-agent/tests packages/memory-agent/src -g '*.test.ts'`로
     남은 단언을 찾아, 거절을 기대하던 줄을 지운다. `lease: { state: "other" }`로 워크플로 동작이
     거절된다는 단언도 지운다.
   - `apps/agent/server/tests/dev-agent-chat-boundary.test.ts`: 403 단언(다른 origin)과 그 뒤의 "효과가
     남지 않았다" 단언은 한 글자도 바꾸지 않는다. 고치기 전에 `rg -c 'toBe\(403\)' <파일>`로 수를 세어 둔다.
     - 첫 테스트: `nonHolder`와 `missingHolder` 요청과 두 `toBe(423)` 단언(86-93행)을 지운다. `invocations`가
       0이고 세 표가 비어 있다는 단언은 `foreign` 요청 바로 뒤에 남는다. 115-122행(주석, `leases.release`,
       `unleased` 요청과 그 단언)을 지우고 그 자리에 다음을 넣는다: holder가 `"other-page"`이고 runId가
       `"other-page-run"`인 요청을 보내 `status`가 200임을 단언하고, 지금 코드처럼
       `yield* sdkCall(() => response.text());`로 본문을 끝까지 읽는다. 테스트 이름의
       "a leased local session"은 "a local session"으로 바꾼다.
     - 셋째 테스트("headerless local requests preserve lease and cross-session run authority"): 두
       `toBe(423)` 줄(247-248행)을 지운다. 다른 세션의 run id를 다시 쓰면 409라는 단언(249-251행)은 남긴다.
       그 뒤의 `leases.release` 줄을 지운다. 이름에서 "lease and "를 뺀다.
     - `leases.claim`을 부르는 줄(81, 155, 234행)은 남긴다(029가 지운다).
     - 이 파일의 다른 단언이 실패하면 STOP이다.

**Verify**:

- `rg --hidden -n 'refuseOtherHolder|checkHolder|leases\.permits' packages/memory-agent/src apps/agent/app -g '!*.test.ts'`
  → 결과 없음
- `rg --hidden -n '"session_in_use"' packages/memory-agent/src/agent/chat.ts packages/memory-agent/src/workflow/actions.ts apps/agent/app/.server/api/sessions.ts`
  → 결과 없음
- `vp run memory-agent#typecheck`와 `vp run agent#typecheck` → exit 0
- `cd packages/memory-agent && vp test run --maxWorkers=4 tests/chat tests/workflow src/workflow tests/compaction/agent-chat.test.ts tests/integrations/archive.test.ts`
  → 모두 통과
- `rg -c 'toBe\(403\)' apps/agent/server/tests/dev-agent-chat-boundary.test.ts` → 고치기 전과 같은 수
- `cd apps/agent && vp test run server/tests/dev-agent-chat-boundary.test.ts` → 3개 통과
- 루트에서 `vp lint` → exit 0

commit: `feat(chat): 서버가 다른 탭의 조작을 거절하지 않는다`

### Step 2: 화면이 lease를 잡지 않고 읽기 전용이 되지 않는다

1. `apps/agent/app/entry/chat/chat-panel.tsx` 바깥 컴포넌트(307-317행):
   - `useSessionLease(sessionId)` 대신 `const holder = pageHolder();`를 쓴다(`../session/session-lease`에서
     `pageHolder`를 import한다).
   - `reading`을 지우고 `key`를 `` `sync:${syncRevision}` ``로 바꾼다.
   - `ChatPanel`에 넘기던 `lease`, `refused`, `onContinue`를 지운다.
2. 안쪽 `ChatPanel`:
   - props에서 `lease`, `refused`, `onContinue`를 지운다.
   - `const readOnly = lease.state !== "mine";`을 지운다.
     `mutationBlocked`는 `backendRestartRequired || !sendingEnabled`가 된다.
   - `readOnly`를 쓰던 조건에서 `readOnly`만 뺀다. 예: `if (!settled || readOnly) return;` →
     `if (!settled) return;`, `disabled={readOnly || backendRestartRequired}` →
     `disabled={backendRestartRequired}`. effect의 의존 배열에서도 뺀다. 자식에 넘기던
     `readOnly={readOnly}`(1049, 1069, 1083, 1091행)는 지운다.
   - 1172-1173행의 `isBlocked(lease) ? <ReadOnlyBar … /> : (…)`를 없애고 `DraftComposer` 쪽만 남긴다.
   - `read-only-bar`와 `PageLease`의 import를 지운다.
3. `chat-approvals.tsx`, `subagent-panel.tsx`, `uncertain-runs.tsx`, `message.tsx`에서 `readOnly` prop과 그
   사용을 지운다(`disabled={readOnly || resuming || discarding}` → `disabled={resuming || discarding}`).
   `message.tsx`는 세 층이다: `MessageView`(prop 타입 776행, 비교 함수 790행, 인자 852행, 넘기는 곳
   935행), 가운데 컴포넌트(670, 680, 692행), `TaskSummaryCard`(460, 467, 578, 599, 619행). 비교 함수의
   `previous.readOnly === next.readOnly &&` 줄도 지운다. `message.browser.tsx:21`의 `readOnly: false`를
   지운다. 이 prop을 넘기는 다른 호출자는 typecheck가 알려 준다. 넘기는 값을 지운다.
   `chat-composer.tsx`와 `queue-panel.tsx`의 `readOnly`는 건드리지 않는다.
4. `apps/agent/app/entry/chat/read-only-bar.tsx`, `session/lease-actions.ts`,
   `session/lease-actions.test.ts`를 지운다(`git rm`).
5. `session/session-lease.ts`에는 `holderKey`, `newHolder`, `pageHolder`와 그것들이 쓰는 import만 남긴다.
   나머지("Current state"의 목록)를 모두 지운다. `pageHolder`의 주석은 "요청에 붙이는 이 페이지의 이름.
   `sessionStorage`에 두어 새로고침해도 같다"는 뜻으로 고친다(소유권과 `pageIdentity`를 말하지 않는다).
6. `queries/session.ts`에서 `useObservedRunStateQueryBody`와 `useObservedRunStateQuery`를 지운다.
7. `api.ts`의 `leaseAction`(738행 근처)은 그대로 둔다(029가 지운다).
8. `chat/chat-panel.browser.tsx`: 지운 prop(`refused`, `onContinue`, 패널에 넘기던 `lease`)을 뺀다. 읽기
   전용 막대를 단언하던 테스트가 있으면 지운다. run 상태 fixture 안의 `lease` 필드(58행)는 남긴다.
9. `vp run agent#i18n:extract`를 돌려 지운 메시지를 `.po`에서 뺀다.

**Verify**:

- `rg --hidden -n 'useSessionLease|PageLease|ReadOnlyBar|isBlocked|orderedLeaseActions|useObservedRunStateQuery' apps/agent/app -g '!*.md'`
  → 결과 없음
- `rg -n 'readOnly' apps/agent/app/entry/chat/chat-panel.tsx apps/agent/app/entry/chat/chat-approvals.tsx apps/agent/app/entry/chat/subagent-panel.tsx apps/agent/app/entry/chat/uncertain-runs.tsx apps/agent/app/entry/chat/message.tsx apps/agent/app/entry/chat/message.browser.tsx`
  → 결과 없음
- `rg -n 'readOnly=\{mutationBlocked\}' apps/agent/app/entry/chat/chat-composer.tsx` → 한 줄(그대로 있다)
- `vp run agent#typecheck` → exit 0
- `cd apps/agent && vp test run app/entry/session app/entry/shared/backend-restart.test.ts` → 모두 통과
- 루트에서
  `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/chat-panel.browser.tsx apps/agent/app/entry/chat/message.browser.tsx`
  → 모두 통과
- 루트에서 `vp lint` → exit 0

commit: `feat(chat): 화면이 대화 소유권을 잡지 않고 어느 탭에서든 입력한다`

### Step 3: 문서와 주석을 새 동작에 맞추고 결정을 적는다

1. 다음 README에서 지운 이름과 지운 동작(다른 탭은 읽기 전용, 소유 탭만 무엇을 한다, 423
   `session_in_use`로 거절한다)을 말하는 줄을 지우거나 새 동작으로 고친다. 검토 때 찾은 자리:
   - `apps/agent/app/entry/session/README.md` (`useSessionLease`, `PageLease`, `orderedLeaseActions`,
     `useObservedRunStateQuery`, lease 갱신)
   - `apps/agent/app/entry/chat/README.md` (42, 44, 61행 근처)
   - `apps/agent/app/entry/queries/README.md` (`useObservedRunStateQuery`)
   - `apps/agent/app/.server/api/README.md` (37, 39, 50행 근처)
   - `packages/memory-agent/src/workflow/README.md` (71행 근처)
   - `apps/agent/README.md` (91행 근처)
   - lease API와 `holder`를 말하는 줄은 그대로 둔다(아직 있다).
2. 고친 소스 파일에서 지운 동작을 말하는 주석을 고친다. 검토 때 찾은 자리: `chat.ts`의 982-984, 2625,
   2874행 근처, `apps/agent/app/entry/chat/use-agent-chat.ts:61`, `chat/approval.tsx:321`,
   `chat/board/project-board.tsx:84`. 찾는 명령:
   `rg --hidden -n -i 'read-only page|read-only tab|holds the session|owning page|owning tab|읽기 전용 탭|소유 탭' packages/memory-agent/src apps/agent/app -g '!*.test.*'`
   주석만 고친다. 그 파일의 코드는 건드리지 않는다. `src/sessions/leases.ts`의 주석은 건드리지 않는다.
3. `docs/decisions.md` 끝에 한 절을 더한다. 제목: `## 대화는 어느 탭에서든 조작한다 (2026-11-22)`. 내용:
   - 결정(사용자): 세션 소유권(lease)을 끝까지 없앤다. 어느 탭이든 대화를 조작하고, 동시에 온 조작은
     서버가 순서대로 처리한다.
   - 계기: 2026-11-02의 세 단계 뒤에도 서버가 다른 탭의 조작을 `session_in_use`로 거절했고, 두 번째 탭은
     입력창 대신 막대를 보였다.
   - 동시에 온 조작: run은 한 번에 하나(`run_in_progress`)이고 늦은 메시지는 대기열로 간다. 같은 승인의
     두 번째 답은 거절된다(Step 1의 테스트가 확인한 코드를 적는다).
   - lease는 보안 경계가 아니었다. 다른 origin을 막는 403 검사는 그대로다.
   - 대체하는 결정: "R03: 다른 창이 쓰는 세션은 읽기 전용으로 연다", 2026-10-18의 lease claim 재시도와
     "이 대화를 쓸 수 있는지 확인하지 못했습니다" 막대, "대화 보관"의 "다른 탭이 쓰고 있는 대화(423)는
     보관과 복원하지 않는다".
   - 남은 일: `holder` 인자, lease API, `SessionLeases`는 계획 029가 지운다. ACP 브리지는 그때까지 에디터
     연결 하나만 받는다.

**Verify**: `vp lint` → exit 0, `git diff --stat HEAD -- '*.ts' '*.tsx'`의 변경이 주석 줄뿐이다.

commit: `docs(decisions): 대화를 어느 탭에서든 조작하는 결정을 적는다`

## Test plan

- 새로 쓰는 것: `packages/memory-agent/tests/chat/two-pages.test.ts`(Step 1). 구조는 지금의
  `tests/chat/leases.test.ts`를 본뜬다(`testAgent`, `openPage`, `freshSession`).
- 고치는 것: `tests/chat/session.test.ts`, `tests/compaction/agent-chat.test.ts`,
  `tests/integrations/archive.test.ts`, `dev-agent-chat-boundary.test.ts`, 화면 테스트의 prop.
- 지우는 것: `lease-actions.test.ts`, 읽기 전용 막대 단언.

## Done criteria

- [ ] `vp run memory-agent#typecheck`와 `vp run agent#typecheck`가 exit 0
- [ ] 루트 `vp lint`가 exit 0
- [ ] Step 1과 Step 2의 Verify에 적은 `rg`가 적힌 결과를 낸다
- [ ] Step 1과 Step 2의 테스트 명령이 모두 통과하고, `two-pages.test.ts`가 있다
- [ ] `dev-agent-chat-boundary.test.ts`의 `toBe(403)` 수가 고치기 전과 같다
- [ ] `git status`에 In scope 밖의 파일이 없다
- [ ] `docs/decisions.md` 끝에 새 절이 있다
- [ ] `plans/README.md`의 028 행을 고쳤다

## STOP conditions

멈추고 보고한다:

- "Current state"의 발췌가 실제 코드와 다르다(공백과 몇 줄의 번호 차이는 빼고).
- Out of scope의 파일을 고쳐야 통과한다.
- `dev-agent-chat-boundary.test.ts`에서 403 단언이나 "효과가 남지 않았다" 단언을 고쳐야 통과한다.
- `two-pages.test.ts`에서 같은 승인의 두 번째 답이 거절되지 않고 성공한다.
- 두 탭이 동시에 보낼 때 run이 둘 시작되는 것을 테스트로 보았다.
- 이 계획이 이름을 적지 않은 테스트가 실패하고, 그 테스트가 `session_in_use`나 lease를 단언하지 않는다.
  거절이 다른 안전 장치 노릇을 하고 있었다는 뜻이므로 무엇이 실패했는지 그대로 보고한다.
- 같은 Verify가 고친 뒤에도 두 번 실패한다.

## Maintenance notes

- 이 계획 뒤에도 화면은 `X-Session-Holder` 헤더를 보내고 20초 갱신만 멈춘다. 서버의 lease 표에는 ACP
  브리지가 claim한 것만 남는다. 서버는 그것을 보고 아무것도 거절하지 않는다. 브리지 자신은 두 번째 에디터
  연결을 423으로 거절한다(029에서 없앤다).
- 계획 029가 `holder`와 lease 코드를 지운다. 그 전에 `holder`를 새로 쓰는 코드를 더하지 않는다.
- 서버에 닿지 못할 때 입력창을 막던 "확인하지 못했습니다" 막대가 사라진다. 보내기가 실패하면 메시지가
  입력창으로 돌아오고 안내가 뜨는 기존 동작(`putBack`)이 그 자리를 맡는다. 검토할 때 서버를 끈 채로
  보내 보아 확인한다.
- run이 끝난 뒤 대화를 다시 읽는 일(`chat-panel.tsx`의 `handleRunSettled`)을 이제 모든 탭이 한다. 전에는
  lease를 쥔 탭만 했다.
- 이미 답한 승인의 카드가 다른 탭에 잠깐 남을 수 있다. 눌러도 서버가 거절한다. "이미 답했다"는 안내
  문구를 따로 두는 일은 승인 통로를 합치는 계획(R3)에서 한다.
- 판단 대기 함에서 답하기(R2), 세션 inbox(R8) 계획이 이 동작에 기댄다.
