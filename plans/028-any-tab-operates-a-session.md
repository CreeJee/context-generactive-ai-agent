# Plan 028: 대화를 어느 탭에서든 조작한다 (서버는 다른 탭의 조작을 거절하지 않고, 화면은 읽기 전용이 되지 않는다)

> **Executor instructions**: 이 계획을 단계 순서대로 따른다. 단계마다 Verify 명령을 돌려 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다. 임의로 풀지 않는다. 끝나면
> `plans/README.md`의 이 계획 행을 고친다(검토자가 표를 관리한다고 했으면 고치지 않는다).
>
> **Drift check (먼저 실행)**:
> `git diff --stat 7d3ab2fe..HEAD -- packages/memory-agent/src/agent/chat.ts packages/memory-agent/src/workflow/actions.ts apps/agent/app/entry/chat apps/agent/app/entry/session apps/agent/app/entry/queries/session.ts`
> 바뀐 파일이 있으면 "Current state"의 발췌와 실제 코드를 비교한다. 다르면 STOP이다.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 없음
- **Category**: tech-debt
- **Planned at**: commit `7d3ab2fe`, 2026-11-22

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
`SessionLeases` 서비스를 지우는 일은 계획 029가 한다. 그래서 이 계획이 끝나도 화면은 `X-Session-Holder`
헤더를 계속 보내고, 서버는 그것을 받되 쓰지 않는다.

## Current state

저장소: TypeScript monorepo. `packages/memory-agent`가 서버, `apps/agent`가 React 화면이다. Effect v4를
쓴다. 명령은 `vp`(Vite+)로 돌린다.

### 서버가 이미 순서를 지키는 것 (바꾸지 않는다)

- 한 대화에서 run은 한 번에 하나다. `packages/memory-agent/src/agent/chat.ts`가 `liveRuns.claim`으로
  잡고, 이미 도는 run이 있으면 `{ error: "run_in_progress" }`로 거절한다(1348, 1608, 2335행).
- 승인 답은 기다리는 승인이 있을 때만 받는다. 없으면 `approval_not_pending`이다.
- 화면은 보낸 메시지가 `run_in_progress`로 거절되면 대기열에 넣는다
  (`apps/agent/app/entry/chat/chat-panel.tsx:428-446`의 `onNotTaken`).

그래서 lease 없이도 두 탭이 동시에 보내면 하나는 run이 되고 하나는 대기열로 간다.

### 서버가 거절하는 곳

`packages/memory-agent/src/agent/chat.ts:757-762`:

```ts
/** Refuses a change while another page holds the session. */
const refuseOtherHolder = (sessionId: string, holder: string | null) =>
  Effect.when(
    Effect.fail({ error: "session_in_use" } as const),
    Effect.map(leases.permits(sessionId, holder), (permitted) => !permitted),
  );
```

`yield* refuseOtherHolder(sessionId, holder);`를 부르는 곳이 같은 파일에 10곳 남짓 있다(1220, 1245,
2404, 2462, 2479, 2493, 2519, 2548행 등. `rg -n 'refuseOtherHolder' packages/memory-agent/src`로 모두
찾는다).

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

### 화면이 lease를 잡는 곳

- `apps/agent/app/entry/session/session-lease.ts`(199줄):
  - `pageHolder()`(36-42행): 이 페이지의 이름을 `sessionStorage`의 `context-agent:page-holder`에서 읽거나
    만든다. **남긴다.** `index.tsx` 등 여러 곳이 쓴다.
  - `useSessionLease(sessionId)`: lease를 claim하고, 20초마다 갱신하고, `pagehide`에 release를 보내고,
    `{ holder, lease, refused, continueHere }`를 돌려준다. **지운다.**
  - `PageLease` 타입(`checking`, `unreachable`, 서버의 `LeaseView`), Web Locks로 복제된 탭을 가리는
    `pageIdentity`. **지운다.**
- `apps/agent/app/entry/session/lease-actions.ts`(59줄)와 `lease-actions.test.ts`: lease 요청을 세션마다
  순서대로 보내는 함수. `session-lease.ts`만 쓴다. **지운다.**
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

- `readOnly` prop을 받는 자식: `chat/chat-approvals.tsx`(48, 58, 129, 146행), `chat/subagent-panel.tsx`
  (37, 42, 105행), `chat/uncertain-runs.tsx`(27, 34, 111행). 값은 모두 `ChatPanel`의 `readOnly`에서 온다.

### 지금 동작을 단언하는 테스트

- `packages/memory-agent/tests/chat/leases.test.ts`: "a page that does not hold the session can read it but
  not send, approve or cancel". 두 번째 탭의 승인 답, 메시지, 취소가 `session_in_use`로 거절됨을 단언한다.
- `packages/memory-agent/tests/chat/session.test.ts:55-63`: 다른 탭이 claim한 뒤 보내면
  `session_in_use`임을 단언한다.
- `apps/agent/app/entry/chat/chat-panel.browser.tsx`, `apps/agent/app/entry/session/use-run-state.test.tsx`,
  `run-notice.test.ts`, `apps/agent/app/entry/shared/backend-restart.test.ts`: lease 값(`state: "mine"`
  등)을 fixture로 넘긴다.
- `apps/agent/server/tests/dev-agent-chat-boundary.test.ts`: 로컬 HTTP 경계 테스트다. 두 가지를 섞어
  단언한다.
  - 다른 origin의 요청은 403이고 아무 효과도 남기지 않는다(85행, 186행). lease와 무관하다. **그대로 둔다.**
  - lease를 쥔 페이지가 아니면 423이다(89, 93, 247, 248행). 테스트의 주석이 스스로 말한다(114-115행):
    "Leases enforce local page ownership, not login identity. The route currently still permits a
    same-origin script when a session has no live page lease." lease는 보안 경계가 아니라 탭 사이의 양보였다.
    **이 단언이 바뀐다.**

### 지킬 규칙 (`AGENTS.md`, `CLAUDE.md`에서)

- `let`, `while`을 쓰지 않는다. lint 규칙을 끄는 주석을 쓰지 않는다.
- 줄바꿈만 바꾸는 편집을 하지 않는다. 포맷은 commit hook의 `vp check --fix`가 맡는다.
- 화면 글자는 Lingui 메시지다. 메시지를 지우거나 바꾸면 `vp run agent#i18n:extract`로 `.po`를 맞춘다.
- 사람이 정한 설계 결정은 `docs/decisions.md` 끝에 날짜와 함께 적는다.
- 이름, 주석, 문서에 "poisoned" 같은 만든 말을 쓰지 않는다. 쉬운 말을 쓴다.

## Commands you will need

| Purpose                | Command                                                                     | Expected on success      |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------ |
| 서버 typecheck         | `vp run memory-agent#typecheck`                                             | exit 0, 오류·경고 없음   |
| 화면 typecheck         | `vp run agent#typecheck`                                                    | exit 0, `3/3 successful` |
| lint (저장소 루트)     | `vp lint`                                                                   | exit 0                   |
| 서버 테스트 (고른 것)  | `cd packages/memory-agent && vp test run --maxWorkers=4 <파일…>`            | 모두 통과                |
| 화면 테스트 (jsdom)    | `cd apps/agent && vp test run <파일…>`                                      | 모두 통과                |
| 화면 테스트 (브라우저) | 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run <파일…>` | 모두 통과                |
| 메시지 목록 맞추기     | `vp run agent#i18n:extract`                                                 | exit 0                   |

전체 테스트는 돌리지 않는다. 고친 파일의 테스트만 돌린다. 브라우저 테스트가 처음에 페이지 reload로
실패하면 한 번 더 돌린다. `optimizeDeps`를 고치지 않는다.

## Scope

**In scope**:

- `packages/memory-agent/src/agent/chat.ts`
- `packages/memory-agent/src/workflow/actions.ts`
- `packages/memory-agent/tests/chat/leases.test.ts` (이름을 `two-pages.test.ts`로 바꿔 다시 쓴다)
- `packages/memory-agent/tests/chat/session.test.ts`
- 서버 테스트 중 `session_in_use`를 단언하는 다른 파일(Step 1의 `rg`로 찾은 것만)
- `apps/agent/server/tests/dev-agent-chat-boundary.test.ts` (Step 1의 7번에 적은 줄만)
- `apps/agent/app/entry/chat/chat-panel.tsx`, `chat-approvals.tsx`, `subagent-panel.tsx`, `uncertain-runs.tsx`
- `apps/agent/app/entry/chat/read-only-bar.tsx` (삭제)
- `apps/agent/app/entry/session/session-lease.ts`
- `apps/agent/app/entry/session/lease-actions.ts`, `lease-actions.test.ts` (삭제)
- `apps/agent/app/entry/queries/session.ts`
- 위 화면 파일의 테스트: `chat/chat-panel.browser.tsx`, `session/use-run-state.test.tsx`,
  `session/run-notice.test.ts`, `shared/backend-restart.test.ts` (lease fixture가 타입 오류를 낼 때만)
- `apps/agent/app/locales/ko.po` (extract 명령이 고친다)
- `apps/agent/app/entry/session/README.md`, `apps/agent/app/entry/chat/README.md`,
  `apps/agent/app/entry/queries/README.md` (지운 이름이 적힌 줄)
- `docs/decisions.md` (끝에 한 절 추가)

**Out of scope** (계획 029가 한다. 이 계획에서 건드리지 않는다):

- `packages/memory-agent/src/sessions/leases.ts`, `lease-state.ts`, `contracts.ts`의 `LeaseView`.
- lease API(`POST /api/sessions/:session/lease`), 응답의 `lease` 필드, `SessionInUse` 423 선언
  (`src/api/app-api/sessions.ts`, `trace.ts`, `src/api/chat-api.ts`).
- 함수와 요청의 `holder` 인자, `X-Session-Holder` 헤더, `api.ts`와 `queries/mutations`의 `holder`.
- ACP 브리지의 lease 갱신(`src/acp/agent-bridge.ts`, `src/acp/app-api.ts`).
- 화면의 `session_in_use` 안내 문구(`api.ts`, `refusals.ts`, `message-queue.ts` 등). 서버가 더는 이 코드를
  내지 않지만 타입에 남아 있으므로 문구도 029에서 함께 지운다.
- 다른 origin의 요청을 403으로 막는 코드와 그 단언. lease와 무관한 보안 경계다.

## Git workflow

- 지금 브랜치에서 작업한다(실행자는 자기 worktree에 있다). push하지 않는다.
- 단계마다 commit한다. 메시지는 한국어 conventional commit이다. 예:
  `feat(chat): 이미지 생성을 대화 경로로 보내고 끝나면 대화를 다시 읽는다`
- commit마다 typecheck가 통과해야 한다.

## Steps

### Step 1: 서버가 다른 탭의 조작을 거절하지 않는다

1. `packages/memory-agent/src/agent/chat.ts`에서 `refuseOtherHolder` 정의(757-762행)와 그것을 부르는
   `yield* refuseOtherHolder(sessionId, holder);` 줄을 모두 지운다.
2. 같은 파일 1332-1334행의 주석과 `leases.permits` 검사를 지운다.
3. `holder` 인자는 함수 서명에 그대로 둔다(029가 지운다). 쓰이지 않게 된 인자가 lint에 걸리면 이름을
   `_holder`로 바꾼다. 서명의 순서와 타입은 바꾸지 않는다.
4. `leases.view`, `leases.claim`, `leases.release`, `leases.onExpired`를 쓰는 곳은 그대로 둔다.
5. `packages/memory-agent/src/workflow/actions.ts:49`의 `context.lease?.state === "other"` 줄을 지운다.
   `WorkflowActionContext`의 `lease` 필드는 그대로 둔다.
6. 테스트를 고친다.
   - `tests/chat/leases.test.ts`를 `tests/chat/two-pages.test.ts`로 옮기고(`git mv`), 테스트 하나로 다시
     쓴다. 이름: "two pages both operate one session; the first answer to an approval wins". 내용:
     - 탭 A가 `"please use the shell"`을 보내 승인이 하나 기다린다(지금 테스트의 앞부분 그대로).
     - 탭 B(`openPage(sessionId, "tab-b")`)가 같은 승인을 보고 `reader.resolve(() => true)`로 답한다.
       성공하고 답에 `"approved-output"`이 들어 있다.
     - 그 뒤 탭 A가 같은 승인에 답하면 `approval_not_pending`으로 거절된다
       (`Effect.flip(owner.resolve(() => true))`가 `{ error: "approval_not_pending" }`와 맞는다). 지원 코드
       `tests/support/chat-client.ts`의 `resolve`가 이미 답한 승인을 다르게 다루면(예: 기다리는 승인이
       없어 아무것도 보내지 않으면) 이 단언은 빼고, 그 이유를 테스트 주석 한 줄로 적는다.
     - `agent.cancel(sessionId, "tab-b")`가 `session_in_use`로 실패하지 않는다. 도는 run이 없으면
       `{ error: "no_running_run" }`이다.
     - lease API(`agent.lease`, `status.lease`)를 부르는 줄은 쓰지 않는다.
   - `tests/chat/session.test.ts:55-63`: 다른 탭이 claim한 뒤 보낸 메시지가 거절된다는 단언을, 그 메시지가
     run으로 받아들여진다는 단언으로 바꾼다. 그 테스트가 "거절된 메시지를 돌려놓는다"만 보려던 것이면
     거절 원인을 `run_in_progress`가 아닌 다른 실제 거절로 바꾸지 말고, 그 단락을 지우고 commit 메시지에
     적는다.
   - `rg -n 'session_in_use' packages/memory-agent/tests packages/memory-agent/src -g '*.test.ts'`로 남은
     단언을 찾아 같은 방식으로 고친다. `workflow` 테스트에서 `lease: { state: "other" }`가 거절된다는
     단언은 지운다.

7. `apps/agent/server/tests/dev-agent-chat-boundary.test.ts`를 고친다. 403 단언(다른 origin)과 그 뒤의
   "효과가 남지 않았다" 단언은 한 글자도 바꾸지 않는다.
   - 첫 테스트: `nonHolder`와 `missingHolder` 요청과 두 `toBe(423)` 단언(86-93행)을 지운다. 그 바로 뒤의
     `invocations`가 0이고 세 표가 비어 있다는 단언은 `foreign` 요청 바로 뒤에 남는다. 114-121행의 주석과
     `leases.release`, `unleased` 요청은 지우고, 대신 `"other-page"` holder로 보낸 요청이 200임을 단언한다
     (lease를 쥐지 않은 페이지도 run을 시작한다). 테스트 이름의 "a leased local session"은
     "a local session"으로 바꾼다.
   - 셋째 테스트("headerless local requests preserve lease and cross-session run authority"): 두
     `toBe(423)` 줄(247-248행)을 지운다. 다른 세션의 run id를 다시 쓰면 409라는 단언(249-251행)은 남긴다.
     그 뒤의 `leases.release`는 지운다. 이름에서 "lease and"를 뺀다.
   - `leases.claim`을 부르는 줄(81, 155, 234행)은 남겨도 통과한다. 남긴다(029가 지운다).
   - 이 파일의 다른 단언이 실패하면 STOP이다.

**Verify**:

- `rg -n 'refuseOtherHolder|leases\.permits' packages/memory-agent/src` → 결과 없음
  (`src/sessions/leases.ts`의 `permits` 정의는 남는다. `leases\.permits` 호출만 없어야 한다.)
- `rg -n '"session_in_use"' packages/memory-agent/src/agent/chat.ts packages/memory-agent/src/workflow/actions.ts`
  → 결과 없음
- `vp run memory-agent#typecheck` → exit 0
- `cd packages/memory-agent && vp test run --maxWorkers=4 tests/chat tests/workflow src/workflow` → 모두 통과
- `rg -c 'toBe\(403\)' apps/agent/server/tests/dev-agent-chat-boundary.test.ts` → 고치기 전과 같은 수
  (고치기 전에 먼저 세어 둔다)
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
     `disabled={backendRestartRequired}`. effect의 의존 배열에서도 뺀다.
   - 1172-1173행의 `isBlocked(lease) ? <ReadOnlyBar … /> : (…)`를 없애고 `DraftComposer` 쪽만 남긴다.
   - `read-only-bar`와 `PageLease`의 import를 지운다.
3. `chat-approvals.tsx`, `subagent-panel.tsx`, `uncertain-runs.tsx`에서 `readOnly` prop과 그 사용을 지운다
   (`disabled={readOnly || resuming || discarding}` → `disabled={resuming || discarding}`). 이 prop을 넘기는
   다른 호출자는 typecheck가 알려 준다. 넘기는 값을 지운다.
4. `apps/agent/app/entry/chat/read-only-bar.tsx`, `session/lease-actions.ts`,
   `session/lease-actions.test.ts`를 지운다(`git rm`).
5. `session/session-lease.ts`에는 `holderKey`, `newHolder`, `pageHolder`만 남긴다. `useSessionLease`,
   `PageLease`, `pageIdentity`, `holdIdentity`, `leaseAction`, `renewMs`와 쓰지 않게 된 import를 지운다.
   `pageHolder`의 주석에서 "session ownership"과 `pageIdentity`를 말하는 부분은 "요청에 붙이는 이 페이지의
   이름"으로 고친다.
6. `queries/session.ts`에서 `useObservedRunStateQueryBody`와 `useObservedRunStateQuery`를 지운다.
7. `api.ts`의 `leaseAction`(738행 근처)은 그대로 둔다(029가 지운다). 쓰는 곳이 없어 lint에 걸리지는
   않는다(객체의 메서드다).
8. 테스트 fixture에서 지운 prop(`lease`, `refused`, `onContinue`, `readOnly`)을 뺀다. 읽기 전용 막대를
   단언하던 테스트는 지운다. `chat-panel.browser.tsx`에 "두 번째 탭" 테스트가 있으면, 입력창이 그대로
   보인다는 단언으로 바꾼다.
9. `vp run agent#i18n:extract`를 돌려 지운 메시지를 `.po`에서 뺀다.
10. README 세 곳에서 지운 이름(`useSessionLease`, `PageLease`, `orderedLeaseActions`,
    `useObservedRunStateQuery`, `ReadOnlyBar`)이 적힌 줄을 지우거나 새 동작으로 고친다.

**Verify**:

- `rg -n 'useSessionLease|PageLease|ReadOnlyBar|orderedLeaseActions|useObservedRunStateQuery' apps/agent/app`
  → 결과 없음
- `rg -n 'readOnly' apps/agent/app/entry/chat/chat-panel.tsx apps/agent/app/entry/chat/chat-approvals.tsx apps/agent/app/entry/chat/subagent-panel.tsx apps/agent/app/entry/chat/uncertain-runs.tsx`
  → `chat-panel.tsx`의 `readOnly={mutationBlocked}`(입력창에 넘기는 값) 한 줄만 남는다
- `vp run agent#typecheck` → exit 0
- `cd apps/agent && vp test run app/entry/session app/entry/shared/backend-restart.test.ts` → 모두 통과
- 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/chat-panel.browser.tsx`
  → 모두 통과
- 루트에서 `vp lint` → exit 0

commit: `feat(chat): 화면이 대화 소유권을 잡지 않고 어느 탭에서든 입력한다`

### Step 3: 결정을 적는다

`docs/decisions.md` 끝에 한 절을 더한다. 제목: `## 대화는 어느 탭에서든 조작한다 (2026-11-22)`. 내용:

- 결정(사용자): 세션 소유권(lease)을 끝까지 없앤다. 어느 탭이든 대화를 조작하고, 동시에 온 조작은 서버가
  순서대로 처리한다.
- 계기: 2026-11-02의 세 단계 뒤에도 서버가 다른 탭의 조작을 `session_in_use`로 거절했고, 두 번째 탭은
  입력창 대신 막대를 보였다.
- 동시에 온 조작: run은 한 번에 하나(`run_in_progress`)이고 늦은 메시지는 대기열로 간다. 승인 답은 먼저
  온 것만 받는다(`approval_not_pending`).
- 대체하는 결정: "R03: 다른 창이 쓰는 세션은 읽기 전용으로 연다", 2026-10-18의 lease claim 재시도와
  "이 대화를 쓸 수 있는지 확인하지 못했습니다" 막대, "대화 보관"의 "다른 탭이 쓰고 있는 대화(423)는
  보관과 복원하지 않는다".
- 남은 일: `holder` 인자, lease API, `SessionLeases`는 계획 029가 지운다.

commit: `docs(decisions): 대화를 어느 탭에서든 조작하는 결정을 적는다`

## Test plan

- 새로 쓰는 것: `packages/memory-agent/tests/chat/two-pages.test.ts`(Step 1). 구조는 지금의
  `tests/chat/leases.test.ts`를 본뜬다(`testAgent`, `openPage`, `freshSession`).
- 고치는 것: `tests/chat/session.test.ts`, 화면 테스트의 fixture.
- 지우는 것: `lease-actions.test.ts`, 읽기 전용 막대 단언.

## Done criteria

- [ ] `vp run memory-agent#typecheck`와 `vp run agent#typecheck`가 exit 0
- [ ] 루트 `vp lint`가 exit 0
- [ ] Step 1과 Step 2의 Verify에 적은 `rg`가 적힌 결과를 낸다
- [ ] Step 1과 Step 2의 테스트 명령이 모두 통과하고, `two-pages.test.ts`가 있다
- [ ] `git status`에 In scope 밖의 파일이 없다
- [ ] `docs/decisions.md` 끝에 새 절이 있다
- [ ] `plans/README.md`의 028 행을 고쳤다

## STOP conditions

멈추고 보고한다:

- "Current state"의 발췌가 실제 코드와 다르다.
- Out of scope의 파일을 고쳐야 통과한다.
- `dev-agent-chat-boundary.test.ts`에서 403 단언이나 "효과가 남지 않았다" 단언을 고쳐야 통과한다.
- `refuseOtherHolder`를 지운 뒤, lease와 무관해 보이는 테스트가 실패한다(예: 보관, 대기열, Goal 시작).
  거절이 다른 안전 장치 노릇을 하고 있었다는 뜻이므로 무엇이 실패했는지 그대로 보고한다.
- 두 탭이 동시에 보낼 때 run이 둘 시작되는 것을 테스트로 보았다.
- 같은 Verify가 고친 뒤에도 두 번 실패한다.

## Maintenance notes

- 이 계획 뒤에도 화면은 `X-Session-Holder` 헤더를 보내고 20초 갱신만 멈춘다. 서버의 lease 표는 비어
  있게 된다(claim하는 페이지가 없다). ACP 브리지는 아직 claim하지만 거절이 없어 동작에 영향이 없다.
- 계획 029가 `holder`와 lease 코드를 지운다. 그 전에 `holder`를 새로 쓰는 코드를 더하지 않는다.
- 서버에 닿지 못할 때 입력창을 막던 "확인하지 못했습니다" 막대가 사라진다. 보내기가 실패하면 메시지가
  입력창으로 돌아오고 안내가 뜨는 기존 동작(`putBack`)이 그 자리를 맡는다. 검토할 때 서버를 끈 채로
  보내 보아 확인한다.
- 판단 대기 함에서 답하기(R2), 세션 inbox(R8) 계획이 이 동작에 기댄다.
