# Plan 031: 처음 Plan의 승인자를 프로젝트 권한 모드가 정한다 (정렬 질문은 언제나 먼저 하고, 입력창의 Plan 모드를 없앤다)

> **Executor instructions**: 이 계획을 단계 순서대로 따른다. 단계마다 Verify 명령을 돌려 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다. 임의로 풀지 않는다. 끝나면
> `plans/README.md`의 이 계획 행을 고친다(검토자가 표를 관리한다고 했으면 고치지 않는다).
>
> **이 저장소에서 찾을 때는 언제나 `rg --hidden -g '!.git' -g '!node_modules'`를 쓴다.** route 핸들러 폴더
> `apps/agent/app/.server`는 이름이 점으로 시작해서 `rg`가 기본으로 건너뛴다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat 1f5e564c..HEAD -- packages/memory-agent/src/workflow/tools.ts packages/memory-agent/src/agent/chat.ts packages/memory-agent/src/kanban/tools.ts packages/memory-agent/src/workflow/instructions.test.ts packages/memory-agent/tests/workflow/execution.test.ts apps/agent/app/entry/chat`
> 바뀐 파일이 있으면 "Current state"의 발췌와 실제 코드를 비교한다. 다르면 STOP이다. 발췌와 실제 코드의
> 공백·줄바꿈 차이는 다른 것으로 보지 않는다. 줄 번호가 몇 줄 어긋나는 것도 마찬가지다. 계획 028이 먼저
> 들어가 `chat.ts`의 `refuseOtherHolder` 줄이 사라진 것도 다른 것으로 보지 않는다.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 없음 (028·029·030과 순서 무관)
- **Category**: correctness
- **Planned at**: commit `1f5e564c`, 2026-11-22

## Why this matters

대화가 Goal을 맡아 Plan을 만들 때 "누가 Plan을 승인하는가"를 정하는 손잡이가 둘이다.

- 도구 호출과 실행 중에 더해진 카드는 **프로젝트 권한 모드**(`ask` 사용자 / `auto` 검토 모델 / `full`
  승인 없음)가 정한다.
- 처음 Plan은 **입력창의 Goal/Plan 모드**(`WorkflowState.mode`)가 정한다. Goal 모드는 사용자에게 이해한
  내용을 먼저 묻고(정렬 질문) 답을 받으면 승인 없이 보드를 시작한다. Plan 모드는 정렬 질문 없이 Goal을
  추론해 같은 run에서 Plan까지 저장하고 "승인하고 실행" 버튼을 기다린다.

그래서 `ask` 프로젝트의 Goal 모드는 파일 쓰기 한 번은 묻고 카드 스무 장짜리 Plan은 묻지 않고 시작한다.
Plan 모드는 무엇을 원하는지 맞추지 않은 채 Plan을 만든다.

사용자가 정했다(`plans/consistency-rules.md`의 R1, 2026-11-21과 2026-11-22):

- 승인자는 프로젝트 권한 모드 하나가 정한다. 입력창의 Goal/Plan 모드를 없앤다.
- **정렬 질문은 모든 권한 모드에서 먼저 한다.** Goal을 처음 저장하는 run은 Plan을 만들지 않고 이해한
  내용을 사용자에게 말한다. 사용자가 답한 뒤의 run이 Plan을 만든다. (사용자: "M1이 원래 의도였다.")
- 그 Plan은 `ask`에서 사용자가 "승인하고 실행"을 눌러야 시작한다. `auto`와 `full`에서는 사용자가 정렬
  질문에 답한 run이 끝날 때 서버가 시작한다.

이 계획은 동작과 입력창을 바꾼다. 저장된 값 `mode`와 타입 `WorkflowMode`, move `"plan"`, DB 열을 지우는
일은 하지 않는다. 뒤따르는 계획이 한다. 그래서 이 계획이 끝나도 상태에는 `mode`가 남아 있고, 아무도 그
값으로 동작을 가르지 않는다.

## Current state

저장소: TypeScript monorepo. `packages/memory-agent`가 서버 로직, `apps/agent`가 React 화면이다. Effect
v4를 쓴다. 명령은 `vp`(Vite+)로 돌린다. 화면 글자는 Lingui 메시지(`msg`, `t`, `<Trans>`)다.

낱말:

- **Goal**: 사용자가 맡긴 결과. **Plan**: 그 Goal을 이루는 카드 목록. **보드**: Plan의 카드를 카드
  에이전트가 실행하는 칸반 보드.
- **정렬 질문**: Plan 작성자(대화의 모델)가 Goal을 draft로 저장한 뒤 "이렇게 이해했다, 맞는가"를 사용자에게
  말하고 턴을 끝내는 것.
- **owner**: 서버. "owner가 승인한다"는 서버가 사용자 대신 Plan을 실행 상태로 옮긴다는 뜻이다.

### 모드가 동작을 가르는 곳은 서버에 둘, 화면에 넷이다

**서버 1. 모델 지침** — `packages/memory-agent/src/workflow/tools.ts`의 `workflowInstructions`.

- 382행: `const common = \`Workflow phase: ${state.phase} (${state.mode} mode).`
- 403-404행:

  ```ts
  // Shaping reads as its mode: the planner of a Goal mode Goal, or one the user approves.
  return Match.value(state.phase === "shaping" ? state.mode : state.phase).pipe(
  ```

- 410-422행 `Match.when("goal", …)`: Goal 모드 지침. 뼈대는 이렇다(전문은 파일에서 읽는다).

  ```
  ${common}
  The user delegated an outcome, not merely a request to describe a goal. You are its planner, not its executor. First agree with the user on what is wanted; after that they leave the work to the board without approving the Plan.
  ${goalAlignment}
  In the run that first saves the Goal, save it as a draft whose outcomes each have a stable id, save no Plan, and end your turn by telling the user ${goalAlignmentMessage}. The board never starts in that run: it starts only after the user had a turn to answer the Goal.
  When the user has answered, record the answer in the Goal with edit_goal: … When the user agrees and no blocking question is left, make the Goal active and save a ready Plan whose cards together serve every outcome (each card names the outcome ids it serves). When that run ends the owner approves the Plan and starts its kanban board, where card agents execute the cards and a verifier judges each outcome. Each card agent reads the Goal's statement, constraints, non-goals and assumptions with its card, so keep them true for every card. Do not implement the cards, verify outcomes or record progress yourself.
  ${plannerOwnWork}
  ${cardCapabilities}

  ${goal}
  ```

- 423-438행 `Match.when("plan", …)`: Plan 모드 지침. "You are planning, not executing. If no Goal is
  recorded, infer the smallest useful Goal from the user's request and save it before the Plan; the user
  does not need to enter Goal mode first." 로 시작하고, Plan의 모양("Produce ordered steps with stable
  unique ids, dependencies …")을 말하고, 끝에 `${goal}`과 `${plan}`을 붙인다. `plan`은 그 분기 안에서
  만드는 지역 값이다:

  ```ts
  const plan = isTruthy(state.plan)
    ? `Plan v${state.plan.version} (${state.plan.status}, based on Goal v${state.plan.goalVersion}): ${state.plan.summary}`
    : "Plan: not recorded yet.";
  ```

- `goalAlignment`(341행), `goalAlignmentMessage`(349행), `plannerOwnWork`(333행)는 같은 파일의 상수다.
  바꾸지 않는다.

**서버 2. 보드 자동 시작** — `packages/memory-agent/src/agent/chat.ts`.

- 624-635행:

  ```ts
  /**
   * A Goal mode Plan its planner saved ready for the current Goal, with no question that blocks
   * it left open.
   */
  const goalModeReady = (state: WorkflowState) =>
    state.phase === "shaping" &&
    state.mode === "goal" &&
    state.goal !== null &&
    (state.goal.status === "active" || state.goal.status === "draft") &&
    !state.goal.openQuestions.some((question) => question.blocking) &&
    state.plan?.status === "ready" &&
    state.plan.goalVersion === state.goal.version;
  ```

- 725-730행 `goalsUserAnswered`: 대화마다 "사용자의 턴으로 시작한 가장 새 run이 시작할 때 있던 Goal의
  instance id"를 메모리에 둔다. 1478-1485행이 채운다. **바꾸지 않는다**(주석의 "Goal mode" 낱말만 고친다).
- 2991-3006행, run이 끝난 뒤 도는 `automatic`:

  ```ts
  const reconciled = yield * workflows.reconcile(sessionId);
  // Goal mode runs its planner's cards without a Plan approval, once the user answered the
  // Goal: a ready Plan saved for the current Goal is approved as the user would approve it
  // in Plan mode when the run that ended began with a user's turn and that Goal. The run
  // that first saves a Goal never starts its board.
  const answered = (yield * Ref.get(goalsUserAnswered))[sessionId];
  const workflow =
    !restarted &&
    goalModeReady(reconciled) &&
    answered !== undefined &&
    answered === yield * workflows.goalInstanceId(sessionId)
      ? yield *
        workflows.move(sessionId, "run").pipe(
          Effect.tap(() => events.publishSession(sessionId, "run-state")),
          Effect.catchTag("WorkflowTransitionRefused", () => Effect.succeed(reconciled)),
        )
      : reconciled;
  ```

  이 블록 위 2964행쯤에 `const session = yield* sessions.get(sessionId);`가 있다. `session.projectId`가
  프로젝트 id다.

- 프로젝트 권한 모드는 `projects.get(projectId)`가 돌려주는 `Project.permissionMode`(`"ask" | "auto" |
  "full"`, `packages/memory-agent/src/projects/contracts.ts:13`)다. `projects`는 `chat.ts`의 같은 범위에
  이미 있다(1336행 `const project = yield* projects.get(projectId);`). 없는 프로젝트는 `ProjectNotFound`로
  실패한다.

**서버가 이미 권한 모드를 따르는 것 (바꾸지 않는다)**: 보드가 도는 동안 Plan 작성자가 더한 카드의 승인.
`packages/memory-agent/src/kanban/orchestrator.ts`의 `settleApprovals`(1042-1094행)가
`project.permissionMode`로 가른다(`full` 승인, `ask` 사용자에게 남김, `auto` 검토 모델). 워크플로 모드를
읽지 않는다. 그런데 모델에게 주는 설명은 다르게 적혀 있다 — `packages/memory-agent/src/kanban/tools.ts:331`:

```
Cards you add while the board runs wait for approval (awaitingApproval) before the loop assigns them: by the user, or by the project's permission mode when the owner approved the Plan in Goal mode. The cards already approved keep running meanwhile; do not add the same cards again.
```

**화면 1. 입력창의 모드 버튼** — `apps/agent/app/entry/chat/chat-composer.tsx`.

- 35-42행:

  ```ts
  const workflowModes = ["chat", "goal", "plan"] as const satisfies readonly WorkflowMove[];

  /** What each mode button does, shown on hover. */
  const modeTitles = {
    goal: msg`결과를 맡기면 보드에서 Plan의 카드를 바로 실행합니다`,
    plan: msg`프로젝트를 변경하지 않은 채 Plan을 만듭니다. 승인하면 보드에서 실행합니다`,
    chat: msg({ message: "일반 대화", comment: "Hover text of the Chat mode button: plain chat" }),
  } satisfies Record<(typeof workflowModes)[number], MessageDescriptor>;
  ```

- 275-279행 placeholder:

  ```ts
  : run.workflow?.phase === "shaping" && run.workflow.mode === "goal"
    ? t`달성할 결과를 입력해 주십시오`
    : run.workflow?.phase === "shaping"
      ? t`변경 없이 조사해 세울 Plan의 내용을 입력해 주십시오`
      : t`메시지를 입력해 주십시오. /로 명령을 부르고 이미지는 붙여넣거나 끌어다 놓습니다`
  ```

- 341-372행 `ToggleGroup`: `workflowModes`를 돌며 버튼을 그린다. `aria-label`의 comment가
  "Accessible name of the Chat/Goal/Plan mode buttons in the composer"다.

**화면 2. 워크플로 바** — `apps/agent/app/entry/chat/workflow-panel.tsx`.

- 51-60행:

  ```ts
  /** The modes the composer offers: plain chat, or who approves the Plan (Plan or Goal). */
  export const modeLabels: Readonly<Record<"chat" | WorkflowMode, string>> = {
    chat: "Chat",
    plan: "Plan",
    goal: "Goal",
  };

  /** The mode the composer shows: plain chat, or the mode a workflow shapes and runs in. */
  export const composerModeOf = (state: WorkflowState | null): "chat" | WorkflowMode =>
    state === null || state.phase === "chat" ? "chat" : state.mode;
  ```

- 131-141행 `stageGuides`: 단계(`shaping`, `running`)마다 모드별 안내 두 개.

  ```ts
  const stageGuides = {
    shaping: {
      plan: msg`요청을 입력하면 프로젝트를 바꾸지 않고 조사한 뒤 Plan을 만듭니다. 승인하면 칸반 보드에서 카드로 실행합니다.`,
      goal: msg`달성할 결과를 입력하면 그에 맞는 카드를 Plan 작성자가 만들어 바로 실행합니다. Goal은 결과가 모두 확인되면 끝납니다.`,
    },
    running: {
      plan: msg`보드가 카드를 실행하고 결과마다 확인합니다. Plan 작성자가 더한 카드는 승인한 뒤에 실행됩니다.`,
      goal: msg`보드가 카드를 실행하고 결과마다 확인합니다. 결과가 모두 확인될 때까지 Plan 작성자가 카드를 더합니다.`,
    },
  } satisfies Record<"shaping" | "running", Record<WorkflowMode, MessageDescriptor>>;
  ```

- 286행 `const { goal, plan, phase, mode } = state;`, 297-299행:

  ```ts
  const reviewing = phase === "shaping" && mode === "plan" && isTruthy(plan);
  const executable =
    !completed && isTruthy(plan) && !kanbanRunning && (mode === "plan" || continuing);
  ```

  `executable`이 "승인하고 실행"(또는 "보드에서 이어서 실행") 버튼을 보인다. Goal 모드에서는 안 보인다.

- 314행 제목 `{modeLabels[mode]} · {t(stageLabels[phase])}`, 331행 주석 "Goal mode approves its planner's
  Plan by itself; …", 414행 `t(stageGuides[phase][mode])`.
- 453-455행 "Plan 수정" 버튼의 `disabled`도 `mode`를 읽는다:

  ```tsx
  disabled={
    actions?.moves[mode].allowed !== true || busy || disabled || controlling
  }
  ```

- `kanbanRunning`은 보드가 살아 있으면 참이다. 도는 보드의 Plan을 고치면 phase는 `shaping`으로 돌아가고
  보드는 살아 있다(`packages/memory-agent/tests/workflow/execution.test.ts`의 "a Plan revised on a running
  board keeps its planner on the board"). 그때 지금 식으로는 `executable`이 거짓이라 승인 버튼이 없다. Goal
  모드에서는 서버가 대신 승인했으므로 문제가 없었다. 이 계획 뒤 `ask`에서는 사용자가 눌러야 하므로 버튼이
  있어야 한다.

**화면 3. 대화 패널** — `apps/agent/app/entry/chat/chat-panel.tsx`.

- 386-389행 `leaving` 상태의 `move: "chat" | WorkflowMode`.
- 491-518행 `moveWorkflow(move: WorkflowMove)`: 성공하면 `` t`${ph({ mode: modeLabels[move] })} 모드로
  바꿨습니다.` ``를 알린다(`move === "run"`이면 다른 문구).
- 527-530행:

  ```ts
  const revisePlan = () =>
    run.workflow?.phase === "running"
      ? setLeaving({ move: run.workflow.mode, revise: true })
      : askForRevision();
  ```

- 724행 `const leavingMode = modeLabels[leaving?.move ?? "plan"];`
- 915-916행 슬래시 명령 처리:

  ```ts
  const request = command.request || (command.move === "plan" ? chatPrompts.planDefault : "");
  ```

- 1205-1209행 `onWorkflowMode`, 1255-1270행 "모드를 바꿀까요?" 대화상자. 설명 문구가 모드마다 다르다:

  ```tsx
  {
    leaving?.move === "goal" ? (
      <Trans>Plan 작성자가 Plan을 다시 준비하면 바로 이어서 실행합니다.</Trans>
    ) : leaving?.move === "plan" ? (
      <Trans>고친 Plan을 다시 승인하면 이어서 실행합니다.</Trans>
    ) : (
      <Trans>Plan이나 Goal 모드에서 다시 승인하면 이어서 실행합니다.</Trans>
    );
  }
  ```

**화면 4. 슬래시 명령** — `apps/agent/app/entry/chat/slash-commands.ts`.

- 21-25행 `workflow: { readonly move: "goal" | "plan" | "run"; readonly request: string }`.
- 79-81행:

  ```ts
  { name: "goal", description: msg`결과를 맡기고 자율적으로 진행하기`, argument: Argument.none() },
  { name: "plan", description: msg`변경 없이 조사한 뒤 Plan 만들기`, argument: Argument.none() },
  { name: "execute", description: msg`준비된 Plan 승인하고 실행하기`, argument: Argument.none() },
  ```

- 280-284행 `case "goal": case "plan":`이 `SlashCommand.workflow({ move: spec.name, request: rest })`를 만든다.
- `apps/agent/app/entry/chat/prompts.ts:9-10`의 `planDefault`는 `/plan`만 쓴다.

### 지금 동작을 단언하는 테스트

- `packages/memory-agent/src/workflow/instructions.test.ts`: `state(phase, mode = "plan")`로 상태를 만든다.
  28-37행이 `planner("shaping", "goal")`, `planner("shaping", "plan")`, `planner("running", "plan")`에
  `cardCapabilities`가 있음을 본다. 120-163행의 테스트는 shaping 지침에 `"non-blocking open question"`이
  있음을 본다(지금은 Plan 모드 지침에만 있는 문장이다).
- `packages/memory-agent/tests/workflow/execution.test.ts`: 테스트 프로젝트의 권한 모드는 기본값 `ask`다
  (`packages/memory-agent/src/projects/projects.ts:234`). 이 네 테스트는 Goal 모드의 자동 시작에 기댄다.
  - 145행 "Goal mode runs the cards its planner saved once the run ends"
  - 167행 "Goal mode starts no board in the run that first saves the Goal"(뒤쪽에서 답한 run이 보드를
    시작함을 본다)
  - 194행 "Goal mode starts no board while a question that blocks the Goal is open"
  - 269행 "a Goal mode approval runs its Plan on the board that kept running"
- 권한 모드를 바꾸는 예: `packages/memory-agent/tests/permission/auto-review.test.ts:15`
  `yield* (yield* Projects).setPermissionMode(project.id, "auto");`
- `apps/agent/app/entry/chat/workflow-panel.test.tsx`: 33-38행(`workflowModeLabel`이 "Goal"/"Plan"/"Chat"),
  39-58행(제목 "Plan · Plan 작성 중", "Goal · 실행 중", "Plan · 완료"), 87-93행 "leaves a Goal mode Plan to
  its own approval"(Goal 모드에서 "승인하고 실행"이 없음).
- `apps/agent/app/entry/chat/slash-commands.test.ts:96-98`: `/plan`이 `move: "plan"` 명령이 됨. 명령 목록에
  없는 이름은 `slash-commands.ts:257-258`에서 `SlashParse.not_command()`가 된다("/"로 시작하는 보통
  메시지로 본다).
- `apps/agent/app/entry/chat/workflow-panel.test.tsx:57-67` "leaves the Plan to a running board's loop instead
  of offering to continue it": shaping, `kanbanRunning`, `run`의 intent가 `continue`이면 버튼이 없다. 이
  테스트는 그대로 통과해야 한다.
- `apps/agent/app/entry/chat/chat-composer.test.tsx:69`: `expect(phaseButtons).toHaveLength(3);`(입력창의
  모드 버튼 셋).
- `apps/agent/app/entry/chat/chat-panel.browser.tsx:317`과 `:343`(브라우저 테스트)이 워크플로 바의 제목을
  본다: `bar.getByText("Plan · Plan 작성 중")`, `name: /Plan · 실행 중/`. fixture는 `mode: "plan"`이다.
- 다른 서버 테스트도 `workflows.move(…, "goal")`이나 `"plan"`을 부른다(`tests/goal/deferred-goal.test.ts`,
  `tests/agents/async-subagents.test.ts`, `tests/integrations/skills.test.ts`,
  `tests/workflow/goal-transition.test.ts`, `tests/workflow/state.test.ts`, `tests/chat/run-and-queue.test.ts`,
  `src/kanban/kanban-flow.test.ts`, `src/kanban/orchestrator.test.ts`). 이 호출은 그대로 둔다. move
  `"plan"`과 `"goal"`은 이 계획 뒤에도 둘 다 받는다.

### 지킬 규칙 (`AGENTS.md`, `CLAUDE.md`에서)

- `let`, `while`을 쓰지 않는다. lint 규칙을 끄는 주석을 쓰지 않는다. `unknown` 타입을 쓰지 않는다.
- 줄바꿈만 바꾸는 편집을 하지 않는다. 포맷은 commit hook의 `vp check --fix`가 맡는다.
- 화면 글자는 Lingui 메시지다. 메시지를 지우거나 바꾸면 `vp run agent#i18n:extract`로 `.po`를 맞춘다.
  화면 문구는 합니다체다.
- 사람이 정한 설계 결정은 `docs/decisions.md` 끝에 날짜와 함께 적는다.
- 이름, 주석, 문서에 만든 말을 쓰지 않는다. 쉬운 말을 쓴다. 코드 주석은 영어, 문서는 한국어다.
- 진단하려고 추적되는 파일을 임시로 고치지 않는다.

## Commands you will need

| Purpose                | Command                                                                                                              | Expected on success    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 서버 typecheck         | `vp run memory-agent#typecheck`                                                                                      | exit 0, 오류·경고 없음 |
| 화면 typecheck         | `vp run agent#typecheck`                                                                                             | exit 0                 |
| lint (저장소 루트)     | `vp lint`                                                                                                            | exit 0                 |
| 서버 테스트 (고른 것)  | `cd packages/memory-agent && vp test run --maxWorkers=4 <파일…>`                                                     | 모두 통과              |
| 화면 테스트 (jsdom)    | `cd apps/agent && vp test run <파일…>`                                                                               | 모두 통과              |
| 메시지 목록 맞추기     | `vp run agent#i18n:extract`                                                                                          | exit 0                 |
| 화면 테스트 (브라우저) | 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/chat-panel.browser.tsx` | 모두 통과              |

전체 테스트는 돌리지 않는다. 아래에 적은 파일만 돌린다. 브라우저 테스트가 처음에 페이지 reload로 실패하면
한 번 더 돌린다. `optimizeDeps`를 고치지 않는다.

서버 테스트 묶음(이 계획에서 "서버 묶음"이라 부른다):

```
src/workflow/instructions.test.ts tests/workflow/execution.test.ts tests/workflow/state.test.ts tests/workflow/goal-transition.test.ts tests/goal/deferred-goal.test.ts tests/chat/run-and-queue.test.ts tests/agents/async-subagents.test.ts tests/integrations/skills.test.ts src/kanban/kanban-flow.test.ts src/kanban/orchestrator.test.ts
```

화면 테스트 묶음("화면 묶음"):

```
app/entry/chat/workflow-panel.test.tsx app/entry/chat/slash-commands.test.ts app/entry/chat/chat-composer.test.tsx
```

## Scope

**In scope**

- `packages/memory-agent/src/workflow/tools.ts` (`workflowInstructions`의 shaping 지침)
- `packages/memory-agent/src/agent/chat.ts` (`goalModeReady`, `automatic`의 자동 시작, 주석)
- `packages/memory-agent/src/kanban/tools.ts` (331행의 한 문장)
- `packages/memory-agent/src/workflow/instructions.test.ts`, `packages/memory-agent/tests/workflow/execution.test.ts`
- `apps/agent/app/entry/chat/chat-composer.tsx`, `workflow-panel.tsx`, `chat-panel.tsx`, `slash-commands.ts`,
  `prompts.ts`와 그 테스트(`workflow-panel.test.tsx`, `slash-commands.test.ts`, `chat-composer.test.tsx`)
- `apps/agent/app/entry/chat/chat-panel.browser.tsx`: 제목을 보는 두 줄만. fixture의 `mode`는 그대로 둔다.
- `plans/README.md`의 이 계획 행
- Lingui `.po` 파일(추출 명령이 고친다)
- 문서: `packages/memory-agent/src/workflow/README.md`, `apps/agent/app/entry/chat/README.md`,
  `docs/kanban-orchestration.md`, `docs/decisions.md`

**Out of scope (건드리지 않는다)**

- `WorkflowMode` 타입, `WorkflowMove`의 `"plan"`, `WorkflowState.mode`, `decodedPlace`, `Standing.mode`,
  `goalTransitions.Navigated`, `workflow/state-rows.ts`, DB의 `mode` 열. 값은 남기고 읽지 않게만 한다.
- `apps/agent/app/entry/session/workflow-test-fixtures.ts`의 `mode: "plan"`, `chat-panel.browser.tsx`의
  fixture. 상태 타입에 `mode`가 남아 있으므로 그대로 둔다.
- 화면에 남는 "모드" 낱말: `chat-panel.tsx`의 `` `${mode} 모드` ``(179행쯤), "… 모드로 바꿨습니다"(499행),
  "답변이 끝난 뒤 모드를 바꿀 수 있습니다"·"워크플로 모드를 바꾸지 못했습니다"(513-514행), "… 모드로
  바꿀까요?"(1255행쯤). Chat과 Goal 사이를 오가는 말로 여전히 맞다. 고치지 않는다.
- `goalsUserAnswered`가 값을 채우는 방식(1478-1485행).
- `kanban/orchestrator.ts`의 `settleApprovals`. 이미 권한 모드를 따른다.
- `auto`에서 검토 모델이 처음 Plan을 심사하게 하기. R1은 `auto`와 `full`을 같게 정했다(사용자가 정렬
  질문에 답하면 시작).
- 판단 대기 함에 "처음 Plan 승인"을 보이기(R2의 계획이 한다).
- 위 "다른 서버 테스트"의 `workflows.move(…, "goal" | "plan")` 호출.

## Git workflow

- 지금 브랜치에서 작업한다(실행자는 자기 worktree에 있다). push하지 않는다.
- 단계마다 commit한다. 메시지는 한국어 conventional commit이다. 예:
  `feat(workflow): 처음 Plan의 승인자를 프로젝트 권한 모드가 정한다`
- commit마다 두 typecheck가 통과해야 한다.

## Steps

### Step 0: 고치기 전에 테스트가 통과하는지 본다

`cd packages/memory-agent && vp test run --maxWorkers=4 <서버 묶음>`과
`cd apps/agent && vp test run <화면 묶음>`을 돌린다.

**Verify**: 모두 통과. 고치기 전에 실패하는 테스트가 있으면 이름을 적어 두고 계속한다. 끝에 보고한다.
그 테스트는 이 계획의 Done criteria에서 뺀다.

### Step 1: 서버 — shaping 지침을 하나로 합치고, 자동 시작을 권한 모드로 가른다

**1-a. `packages/memory-agent/src/workflow/tools.ts`**

1. 382행의 `common` 첫 줄에서 모드를 뺀다: `` `Workflow phase: ${state.phase}. `` (뒤 줄은 그대로).
2. 403-404행을 `return Match.value(state.phase).pipe(`로 바꾸고 위의 주석 한 줄을 지운다.
3. `Match.when("goal", …)`과 `Match.when("plan", …)` 두 분기를 `Match.when("shaping", …)` 하나로 바꾼다.
   `plan` 지역 값은 그 분기 안에 그대로 둔다. 지침 본문은 아래 글 그대로다. `…`로 줄인 곳은 없다.
   "When the user has answered, record the answer in the Goal with edit_goal:"부터 "ask once more."까지는
   지금 Goal 모드 지침의 문장을 한 글자도 바꾸지 않고 옮긴 것이다.

   ```ts
   Match.when("shaping", () => {
     const plan = isTruthy(state.plan)
       ? `Plan v${state.plan.version} (${state.plan.status}, based on Goal v${state.plan.goalVersion}): ${state.plan.summary}`
       : "Plan: not recorded yet.";
     return `${common}
   The user delegated an outcome, not merely a request to describe a goal. You are its planner, not its executor. First agree with the user on what is wanted; the Plan comes only after that.
   ${goalAlignment}
   In the run that first saves the Goal, save it as a draft whose outcomes each have a stable id, save no Plan, and end your turn by telling the user ${goalAlignmentMessage}. The board never starts in that run: it starts only after the user had a turn to answer the Goal.
   When the user has answered, record the answer in the Goal with edit_goal: a confirmed assumption becomes a constraint or is removed, an answered question is removed, a correction changes the outcome it is about. If the answer changed what is wanted in a way the user has not seen written, show the changed parts and ask once more. When the user agrees and no blocking question is left, make the Goal active and save a ready Plan whose cards together serve every outcome.
   Give the Plan ordered steps with stable unique ids, dependencies (dependsOn names only other step ids in this Plan, without cycles), acceptance criteria, risks, applicable rule ids and the Goal outcome ids each step serves. A non-blocking open question does not by itself require a draft Plan: save a ready Plan when its steps can proceed, and leave the unresolved decision for the step it actually affects. Never assume an answer to a blocking question or mark a Plan ready if the unresolved decision prevents safe execution of its next step. Never present investigation as implementation.
   When that run ends, the project's permission mode decides who approves the Plan: in ask the user reads the Plan and approves it, in auto and full the owner approves it. The approved Plan runs on its kanban board, where card agents execute the cards and a verifier judges each outcome. Do not ask for the approval in your message and do not say the board started; say that the Plan is ready. Each card agent reads the Goal's statement, constraints, non-goals and assumptions with its card, so keep them true for every card. Do not implement the cards, verify outcomes or record progress yourself.
   ${plannerOwnWork}
   ${cardCapabilities}

   ${goal}

   ${plan}`;
   }),
   ```

   들여쓰기는 파일의 다른 분기와 맞춘다(템플릿 문자열 안의 줄은 왼쪽 끝에서 시작한다).

4. `running` 분기의 `Match.when("running", …)`과 `chat`, `completed` 분기는 고치지 않는다.
   `Match.exhaustive`가 `"chat" | "shaping" | "running" | "completed"`를 모두 받는지 typecheck가 본다.

**1-b. `packages/memory-agent/src/kanban/tools.ts:331`** — 한 문장을 바꾼다.

- 지금: `…before the loop assigns them: by the user, or by the project's permission mode when the owner
  approved the Plan in Goal mode. The cards already approved…`
- 바꾼 뒤: `…before the loop assigns them: the project's permission mode decides who approves them (the
  user in ask, a reviewer model in auto, nobody in full). The cards already approved…`

**1-c. `packages/memory-agent/src/agent/chat.ts`**

1. `goalModeReady`를 `planReady`로 이름을 바꾸고 `state.mode === "goal" &&` 줄을 지운다. 주석:

   ```ts
   /** A Plan saved ready for the current Goal, with no question that blocks the Goal left open. */
   ```

2. `automatic`의 블록을 이렇게 바꾼다(2991-3006행).

   ```ts
   const reconciled = yield * workflows.reconcile(sessionId);
   // The project's permission mode says who approves a ready Plan. In `ask` the user does, from
   // the page. In `auto` and `full` the owner does once the user answered the Goal: the run
   // that ended began with a user's turn and that Goal. The run that first saves a Goal never
   // starts its board (decisions.md "처음 Plan의 승인자는 프로젝트 권한 모드가 정한다").
   const answered = (yield * Ref.get(goalsUserAnswered))[sessionId];
   const ownerApproves = Option.exists(
     yield * Effect.option(projects.get(session.projectId)),
     (project) => project.permissionMode !== "ask",
   );
   const workflow =
     !restarted &&
     ownerApproves &&
     planReady(reconciled) &&
     answered !== undefined &&
     answered === yield * workflows.goalInstanceId(sessionId)
       ? yield *
         workflows.move(sessionId, "run").pipe(
           Effect.tap(() => events.publishSession(sessionId, "run-state")),
           Effect.catchTag("WorkflowTransitionRefused", () => Effect.succeed(reconciled)),
         )
       : reconciled;
   ```

   `Option`과 `Effect`는 이 파일이 이미 import한다. `session`은 같은 함수 위쪽의
   `const session = yield* sessions.get(sessionId);`다.

3. 725-729행 `goalsUserAnswered`의 주석에서 "Goal mode starts a board only for such a Goal"을 "The owner
   approves a ready Plan only for such a Goal"로 바꾼다. 2680행 주석 "as in Goal mode"는 "as when the owner
   approves it"로 바꾼다. `rg -n "Goal mode|Plan mode" packages/memory-agent/src/agent/chat.ts`가 아무것도
   찾지 못해야 한다.

**1-d. 테스트**

`packages/memory-agent/src/workflow/instructions.test.ts`:

- 28-37행의 테스트는 그대로 통과해야 한다(두 shaping 호출이 같은 지침을 받는다).
- 테스트 하나를 더한다: shaping 지침이 저장된 모드와 관계없이 같고, 정렬 질문과 승인자를 말한다.

  ```ts
  test("shapes a Goal the same way whatever mode the state was saved in", () => {
    const goalMode = workflowInstructions(state("shaping", "goal"), resolved("shaping"));
    expect(workflowInstructions(state("shaping", "plan"), resolved("shaping"))).toBe(goalMode);
    expect(goalMode).toContain("save no Plan");
    expect(goalMode).toContain("the project's permission mode decides who approves the Plan");
  });
  ```

`packages/memory-agent/tests/workflow/execution.test.ts`:

- 파일 위쪽 helper들 옆에 권한 모드를 테스트 하나 동안 바꾸는 helper를 더한다. `started`가
  `Effect.addFinalizer`를 쓰는 방식과 같다. 아래는 뼈대다. 타입이 맞지 않으면 `started`의 `env.use(…)`
  쓰임에 맞춰 고친다. import는 `import { Projects } from "../../src/projects/projects.ts";`다.

  ```ts
  /** For the rest of the test the owner approves a ready Plan; afterwards the user does again. */
  const ownerApproves = Effect.gen(function* () {
    const env = yield* TestEnv;
    const permit = (mode: "ask" | "full") =>
      env.use(
        Effect.flatMap(Projects, (projects) => projects.setPermissionMode(env.project.id, mode)),
      );
    yield* permit("full");
    yield* Effect.addFinalizer(() => Effect.orDie(permit("ask")));
  });
  ```

- 145, 167, 194, 269행의 네 테스트 첫머리(`const env = yield* TestEnv;` 다음 줄)에 `yield* ownerApproves;`를
  넣는다. 이름을 고친다.
  - 145행 → "the owner approves a ready Plan once the run ends when the permission mode asks nobody"
  - 167행 → "the owner starts no board in the run that first saves the Goal"
  - 194행 → "the owner starts no board while a question that blocks the Goal is open"
  - 269행 → "the owner's approval runs the Plan on the board that kept running"

  네 테스트 안의 `workflows.move(session.id, "goal")` 호출과 단언은 그대로 둔다. 290행 주석 "Back in Goal
  mode"는 "Back in shaping"으로 바꾼다.

- 테스트 둘을 더한다(167행 테스트 다음).

  ```ts
  it.effect("in ask a ready Plan waits for the user's approval", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const session = yield* planned([{ text: "The Plan is ready." }]);
      yield* env.use(Effect.flatMap(Workflows, (workflows) => workflows.move(session.id, "goal")));
      yield* runTurn(session.id, `${session.id}-turn`, "Yes, go on");
      yield* afterFollowup;
      const state = yield* env.use(
        Effect.flatMap(Workflows, (workflows) => workflows.get(session.id)),
      );
      expect([state.phase, state.plan?.status]).toEqual(["shaping", "ready"]);
      expect(yield* session.board).toBe(false);
      yield* env.use(
        Effect.flatMap(AgentChat, (chat) => chat.moveWorkflow(session.id, null, "run")),
      );
      yield* waitForBoard(session.board);
    }),
  );

  it.effect("a state saved in Plan mode follows the permission mode too", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      yield* ownerApproves;
      const session = yield* planned([{ text: "The Plan is ready." }]);
      yield* env.use(Effect.flatMap(Workflows, (workflows) => workflows.move(session.id, "plan")));
      yield* runTurn(session.id, `${session.id}-turn`, "Yes, go on");
      yield* waitForBoard(session.board);
    }),
  );
  ```

  계획 029가 먼저 들어가 `moveWorkflow`가 `holder` 인자를 받지 않으면 `null`을 뺀다(같은 파일의 다른
  `moveWorkflow` 호출을 따른다).

- 테스트 하나를 더 더한다(269행 테스트 다음). 269행 테스트와 같은 흐름인데 `ownerApproves`를 부르지 않는다.
  `ask`에서는 도는 보드의 고친 Plan도 사용자의 승인을 기다린다.

  ```ts
  it.effect("in ask a Plan revised on a running board waits for the user's approval", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const session = yield* planned([
        call("plan", "update_plan", plan),
        { text: "The Plan is ready." },
      ]);
      yield* env.use(
        Effect.flatMap(Workflows, (workflows) =>
          workflows.holdCard(
            session.id,
            { cardId: "p1", hold: true },
            BoardAuthor.cases.User.make({}),
          ),
        ),
      );
      yield* env.use(
        Effect.flatMap(AgentChat, (chat) => chat.moveWorkflow(session.id, null, "run")),
      );
      yield* waitForBoard(session.board);
      yield* env.use(Effect.flatMap(Workflows, (workflows) => workflows.move(session.id, "goal")));
      yield* runTurn(session.id, `${session.id}-turn`, "Plan the rest");
      yield* afterFollowup;
      const waiting = yield* env.use(
        Effect.flatMap(Workflows, (workflows) => workflows.get(session.id)),
      );
      expect([waiting.phase, waiting.plan?.status]).toEqual(["shaping", "ready"]);
      const approved = yield* env.use(
        Effect.flatMap(AgentChat, (chat) => chat.moveWorkflow(session.id, null, "run")),
      );
      expect([approved.phase, approved.plan?.status]).toEqual(["running", "executing"]);
      expect(yield* session.board).toBe(true);
    }),
  );
  ```

  이 테스트의 모델 스크립트가 모자라 "Unexpected model iteration"으로 실패하면(보드가 계획자를 다시 부르는
  경우) 269행 테스트가 쓰는 스크립트와 같은 길이로 맞춘다. 단언은 바꾸지 않는다.

**Verify**:

- `vp run memory-agent#typecheck` → exit 0
- `cd packages/memory-agent && vp test run --maxWorkers=4 <서버 묶음>` → 모두 통과
- `rg -n "goalModeReady|Goal mode|Plan mode" packages/memory-agent/src/agent/chat.ts packages/memory-agent/src/workflow/tools.ts packages/memory-agent/src/kanban/tools.ts` → 결과 없음
- 저장소 루트에서 `vp lint` → exit 0

서버 묶음에서 `execution.test.ts`와 `instructions.test.ts`가 아닌 파일의 테스트가 실패하면 STOP
conditions의 첫 항목을 본다.

commit: `feat(workflow): 처음 Plan의 승인자를 프로젝트 권한 모드가 정한다`

### Step 2: 화면 — 입력창의 Plan 모드와 `/plan`을 없애고, 승인 버튼을 모드와 관계없이 보인다

**2-a. `apps/agent/app/entry/chat/workflow-panel.tsx`**

1. `modeLabels`와 `composerModeOf`를 이렇게 바꾼다. `WorkflowMode` import가 더 쓰이지 않으면 지운다.

   ```ts
   /** What the composer offers: plain chat, or a Goal whose Plan runs on a board. */
   export const modeLabels = { chat: "Chat", goal: "Goal" } as const;

   /** What the composer shows: plain chat, or the Goal a workflow shapes and runs. */
   export const composerModeOf = (state: WorkflowState | null): keyof typeof modeLabels =>
     state === null || state.phase === "chat" ? "chat" : "goal";
   ```

2. `stageGuides`를 단계마다 하나로 한다.

   ```ts
   /** What happens next, in the words of each stage. */
   const stageGuides = {
     shaping: msg`달성할 결과를 입력하면 Plan 작성자가 이해한 내용을 먼저 확인합니다. 답하면 Plan을 만들고, 프로젝트 권한 모드가 '매번 묻기'이면 승인을 기다리며 그 밖에는 바로 보드에서 실행합니다.`,
     running: msg`보드가 카드를 실행하고 결과마다 확인합니다. Plan 작성자가 더한 카드는 프로젝트 권한 모드에 따라 승인됩니다.`,
   } satisfies Record<"shaping" | "running", MessageDescriptor>;
   ```

   414행은 `t(stageGuides[phase])`가 된다.

3. 286행에서 `mode`를 꺼내지 않는다. 297-299행:

   ```ts
   const reviewing = phase === "shaping" && isTruthy(plan);
   // A board that runs leaves the Plan to its loop, except a revised Plan waiting to be approved.
   const executable =
     !completed && isTruthy(plan) && (!kanbanRunning || (phase === "shaping" && !continuing));
   ```

   `&& !continuing`을 빼면 `workflow-panel.test.tsx:57-67`이 깨진다. `continuing`은 버튼 문구에서도 계속
   쓰인다.

   453-455행 "Plan 수정" 버튼의 `disabled`는 `actions?.moves.goal.allowed !== true || busy || disabled ||
   controlling`으로 바꾼다(`revisePlan`이 `"goal"`로 옮기는 것과 맞다).

4. 314행 제목: `{modeLabels.goal} · {t(stageLabels[phase])}`.
5. 331행 주석을 바꾼다:
   `{/* In ask the user approves the Plan here; in auto and full the owner does, and a Plan left without a board can still move onto one. */}`
6. `workflowModeLabel`은 그대로 둔다(`modeLabels[composerModeOf(state)]`가 "Chat"이나 "Goal"을 돌려준다).
   `completedModeLabel`의 comment "(Plan, Goal)"은 "(Goal)"로 바꾼다.

**2-b. `apps/agent/app/entry/chat/chat-composer.tsx`**

1. 35-42행:

   ```ts
   const workflowModes = ["chat", "goal"] as const satisfies readonly WorkflowMove[];

   /** What each mode button does, shown on hover. */
   const modeTitles = {
     goal: msg`결과를 맡기면 이해한 내용을 먼저 확인한 뒤 Plan의 카드를 보드에서 실행합니다`,
     chat: msg({ message: "일반 대화", comment: "Hover text of the Chat mode button: plain chat" }),
   } satisfies Record<(typeof workflowModes)[number], MessageDescriptor>;
   ```

2. placeholder(275-279행)의 두 shaping 가지를 하나로 한다.

   ```ts
   : run.workflow?.phase === "shaping"
     ? t`달성할 결과를 입력해 주십시오`
     : t`메시지를 입력해 주십시오. /로 명령을 부르고 이미지는 붙여넣거나 끌어다 놓습니다`
   ```

3. `ToggleGroup`의 `aria-label` comment를 "Accessible name of the Chat/Goal buttons in the composer"로
   바꾼다. 나머지는 그대로다.

**2-c. `apps/agent/app/entry/chat/slash-commands.ts`와 `prompts.ts`**

1. `workflow`의 `move` 타입을 `"goal" | "run"`으로 한다. 주석 "Selects Goal/Plan input or …"을 "Starts
   shaping a Goal or runs a ready Plan on its board."로 바꾼다.
2. 명령 목록에서 `name: "plan"` 줄을 지운다. `goal` 줄의 설명을 `` msg`달성할 결과 맡기기` ``로 바꾼다.
3. `case "plan":` 줄을 지운다(`case "goal":`은 남는다).
4. `prompts.ts`에서 `planDefault`와 그 주석을 지운다.

**2-d. `apps/agent/app/entry/chat/chat-panel.tsx`**

1. `leaving`의 `move` 타입을 `keyof typeof modeLabels`로 한다(`"chat" | "goal"`). `WorkflowMode` import가
   더 쓰이지 않으면 지운다.
2. `moveWorkflow`의 인자 타입을 `keyof typeof modeLabels | "run"`으로 한다. 본문은 그대로다. 55행쯤의
   `WorkflowMove` import가 더 쓰이지 않으면 지운다(`noUnusedLocals`가 켜져 있다).
3. `revisePlan`: `setLeaving({ move: "goal", revise: true })`.
4. 724행: `const leavingMode = modeLabels[leaving?.move ?? "goal"];`
5. 915-916행: `const request = command.request;`
6. 대화상자 설명(1263-1269행)을 두 가지로 한다.

   ```tsx
   {
     leaving?.move === "goal" ? (
       <Trans>
         Plan 작성자가 Plan을 다시 준비하면 프로젝트 권한 모드에 따라 승인을 기다리거나 바로 이어서
         실행합니다.
       </Trans>
     ) : (
       <Trans>Goal로 돌아와 Plan을 다시 승인하면 이어서 실행합니다.</Trans>
     );
   }
   ```

7. `onWorkflowMode`(1205-1209행)는 그대로다. `ChatComposer`의 prop 타입이 `"chat" | "goal"`로 좁아진다.

**2-e. 테스트**

`apps/agent/app/entry/chat/workflow-panel.test.tsx`:

- 33-38행: `expect(workflowModeLabel(workflowFixture)).toBe("Goal");`로 바꾼다(fixture는 `mode: "plan"`
  이다. 저장된 모드와 관계없이 "Goal"이다). 테스트 이름을 "labels a completed workflow as done and any
  other as a Goal"로 바꾼다.
- 39-58행: "Plan · Plan 작성 중" → "Goal · Plan 작성 중", "Plan · 완료" → "Goal · 완료". 이름을 "titles the
  panel with its stage"로 바꾼다.
- 87-93행 테스트를 바꾼다.

  ```tsx
  test("offers the Plan's approval whatever mode the state was saved in", () => {
    const html = render(
      <WorkflowArtifactPanel {...props} state={{ ...workflowFixture, mode: "goal" }} />,
    );
    expect(html).toContain("승인하고 실행");
    expect(html).toContain("Plan 수정");
  });
  ```

`apps/agent/app/entry/chat/slash-commands.test.ts:96-98`: `/plan` 단언을 이렇게 바꾼다. 목록에서 빠진
`/plan`은 다른 모르는 이름처럼 보통 메시지로 간다. 의도한 동작이다.

```ts
expect(parseSlash("/plan", context)).toEqual(SlashParse.not_command());
```

`apps/agent/app/entry/chat/workflow-panel.test.tsx`에 테스트 하나를 더한다(57-67행 테스트 다음).
`allowedWorkflowActions.moves.run`의 intent가 `start`가 아니면 그 테스트처럼 `actions`를 만들어 `intent:
"start"`로 넘긴다.

```tsx
test("offers approval of a Plan revised while its board runs", () => {
  const html = render(<WorkflowArtifactPanel {...props} kanbanRunning />);
  expect(html).toContain("승인하고 실행");
});
```

`apps/agent/app/entry/chat/chat-composer.test.tsx:69`: `toHaveLength(3)` → `toHaveLength(2)`.

`apps/agent/app/entry/chat/chat-panel.browser.tsx`: 317행 `"Plan · Plan 작성 중"` → `"Goal · Plan 작성 중"`,
343행 `/Plan · 실행 중/` → `/Goal · 실행 중/`. 다른 줄은 고치지 않는다.

**2-f. 메시지 목록**: 저장소 루트에서 `vp run agent#i18n:extract`. 바뀐 `.po`를 함께 commit한다.

**Verify**:

- `vp run agent#typecheck` → exit 0 (`3/3 successful`)
- `cd apps/agent && vp test run <화면 묶음>` → 모두 통과
- `rg -n --hidden -g '!node_modules' -g '!*.po' '"plan"' apps/agent/app/entry/chat/chat-composer.tsx apps/agent/app/entry/chat/workflow-panel.tsx apps/agent/app/entry/chat/chat-panel.tsx apps/agent/app/entry/chat/slash-commands.ts` → `workflow-panel.tsx`의 `WorkflowState["plan"]` 세 줄(89, 114, 203행쯤)만 남는다
- `rg -n --hidden -g '!node_modules' -g '!*.po' "planDefault|Plan 모드|\.mode\b" apps/agent/app/entry/chat --glob '!*.test.*' --glob '!*.browser.*' --glob '!README.md'` → `slash-commands.ts`의 `SlashCommand.mode`(권한 모드 명령)와 `board-panel.tsx`의 `loop.mode`만 남는다. `workflow?.mode`나 `state.mode`를 읽는 줄이 없다
- 저장소 루트에서 `vp lint` → exit 0
- `rg -n --hidden -g '!node_modules' 'Plan · ' apps/agent/app --glob '*.browser.*' --glob '*.test.*'` → 결과 없음
- 루트에서 `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/chat-panel.browser.tsx` → 모두 통과

commit: `feat(agent-app): 입력창의 Plan 모드를 없애고 Plan 승인 버튼을 언제나 보인다`

### Step 3: 문서와 결정 기록

1. `packages/memory-agent/src/workflow/README.md`
   - 12행 항목의 맨 끝(그 줄의 마지막 문장 뒤)에 한 문장을 더한다: "`mode`는 저장만 되고 동작을 가르지
     않는다(decisions.md "처음 Plan의 승인자는 프로젝트 권한 모드가 정한다")."
   - 69행 항목을 새 동작으로 다시 쓴다: 처음 Plan의 승인자는 프로젝트 권한 모드가 정한다. Goal을 처음
     저장한 run은 Plan을 만들지 않고 보드를 시작하지 않는다. `ask`에서는 사용자가 "승인하고 실행"을 눌러야
     시작한다. `auto`·`full`에서는 서버가 시작한다(`agent/chat.ts`의 `planReady`와 `goalsUserAnswered`):
     끝난 run이 사용자의 턴으로 시작했고 그때 이미 지금 Goal이 있었으며, Goal에 막는 질문이 없고, 지금
     Goal의 ready Plan이 있어야 한다. 서버를 재시작하면 답했다는 기록은 사라지고 사용자의 다음 턴이 다시
     만든다.
2. `apps/agent/app/entry/chat/README.md:30`: "모드·단계" → "단계", "Plan 모드의 승인하고 실행" → "승인하고
   실행". 다른 내용은 그대로다.
3. `docs/kanban-orchestration.md:41`: 첫 문장의 "Goal 모드의 Plan 작성자는" → "Plan 작성자는". "ready Plan을
   저장하면 owner가 Plan을 승인하고 보드를 시작한다" → "ready Plan을 저장하면 프로젝트 권한 모드가 승인자를
   정한다: `ask`는 사용자가 승인하고, `auto`·`full`은 owner가 승인하고 보드를 시작한다". 끝의 decisions.md
   인용에 `, "처음 Plan의 승인자는 프로젝트 권한 모드가 정한다"`를 더한다.
4. `docs/decisions.md` 끝에 항목을 더한다. 글은 아래 그대로다.

   ```markdown
   ## 처음 Plan의 승인자는 프로젝트 권한 모드가 정한다 (2026-11-22)

   - 결정: Plan을 누가 승인하는지는 프로젝트 권한 모드 하나가 정한다. 입력창의 Goal/Plan 모드를 없앤다.
     입력창에는 Chat과 Goal만 있다.
   - 정렬 질문은 모든 권한 모드에서 먼저 한다. Goal을 처음 저장하는 run은 Plan을 만들지 않고, 이해한
     내용·가정·뺀 것·질문을 사용자에게 말한다. 사용자가 답한 뒤의 run이 Plan을 만든다.
   - 그 Plan은 `ask`에서 사용자가 "승인하고 실행"을 눌러야 시작한다. `auto`와 `full`에서는 사용자가 정렬
     질문에 답한 run이 끝날 때 서버가 시작한다. `auto`의 검토 모델은 처음 Plan을 심사하지 않는다.
   - 계기: 승인자를 정하는 손잡이가 둘이었다. 도구 호출과 실행 중에 더해진 카드는 권한 모드가, 처음 Plan은
     입력창의 모드가 정했다. `ask` 프로젝트의 Goal 모드는 파일 쓰기 한 번은 묻고 카드 스무 장짜리 Plan은
     묻지 않고 시작했다. Plan 모드는 무엇을 원하는지 맞추지 않은 채 Plan을 만들었다.
   - 앞선 결정과의 관계: 2026-11-18 "Goal은 맞춘 뒤에 맡긴다"의 정렬 질문을 Plan 모드였던 경로까지
     넓혔다. 그 결정이 버린 안 "Goal 모드도 Plan 승인 버튼을 누르게 하기"는 `ask`에 한해 받아들인다.
     2026-11-09의 "새 Plan 승인은 프로젝트 권한 모드를 따른다"를 처음 Plan까지 넓힌 것이다.
   - 남긴 것: 저장된 값 `mode`와 `/execute`. `mode`는 읽지 않는다. 뒤따르는 작업이 지운다. `/plan`은
     없앴다.
   - 사용자: "프로젝트 권한모드 하나로 해야하는게 맞을듯.", "M1이 원래 의도였다."
   ```

**Verify**:

- `rg -n "Goal 모드|Plan 모드" packages/memory-agent/src/workflow/README.md apps/agent/app/entry/chat/README.md docs/kanban-orchestration.md` → 결과 없음
- `rg -n "처음 Plan의 승인자는 프로젝트 권한 모드가 정한다" docs/decisions.md` → 1줄 이상
- 저장소 루트에서 `vp lint` → exit 0

commit: `docs(workflow): 처음 Plan의 승인자를 권한 모드가 정한다는 결정을 적는다`

## Test plan

- 서버: `instructions.test.ts`에 테스트 하나(저장된 모드와 관계없이 같은 지침), `execution.test.ts`에
  테스트 둘(`ask`는 승인을 기다린다, Plan 모드로 저장된 상태도 권한 모드를 따른다)과 고친 넷.
- 화면: `workflow-panel.test.tsx`의 고친 셋, `slash-commands.test.ts`의 `/plan`.
- 모델이 새 지침을 실제로 따르는지는 scripted 테스트가 보지 못한다. 실행자는 실제 계정으로 모델을 부르지
  않는다. 검토자가 병합한 뒤 실제 대화로 한 번 본다(Maintenance notes).

## Done criteria

- [ ] `vp run memory-agent#typecheck`와 `vp run agent#typecheck`가 exit 0
- [ ] 저장소 루트의 `vp lint`가 exit 0
- [ ] 서버 묶음과 화면 묶음이 모두 통과(Step 0에서 이미 실패하던 것은 뺀다)
- [ ] `rg -n "goalModeReady" packages/memory-agent/src` → 결과 없음
- [ ] `rg -n 'state\.mode === "goal"|mode === "plan"' packages/memory-agent/src apps/agent/app --hidden -g '!node_modules'` → 결과 없음
- [ ] `git diff --stat <시작 commit>..HEAD`에 Scope의 "In scope" 밖 파일이 없다(`.po` 파일은 In scope다)
- [ ] commit 셋, 각각 두 typecheck 통과

## STOP conditions

- 서버 묶음에서 `execution.test.ts`와 `instructions.test.ts`가 아닌 파일의 테스트가 Step 1 뒤에 실패한다.
  그 테스트는 "Goal 모드면 답한 뒤 보드가 시작한다"에 기대고 있을 수 있다. 실패한 테스트의 이름과 단언을
  적어 보고한다. 권한 모드를 바꿔 통과시키지 않는다.
- `automatic` 블록에서 `projects`나 `session`이 범위에 없다.
- `tests/__golden__`이나 `tests/golden`의 파일이 shaping 지침의 글을 담고 있어 테스트가 실패한다. 어떤
  파일인지 보고한다.
- 화면에서 `WorkflowState.mode`를 읽는 곳이 "Current state"에 없는 파일에 있다.
- `/plan`이나 입력창의 Plan 버튼을 쓰는 테스트가 화면 묶음 밖에 있고, 고치는 방법이 분명하지 않다.

## Maintenance notes

- 뒤따르는 계획이 `WorkflowMode`, move `"plan"`, `WorkflowState.mode`, DB의 `mode` 열을 지운다. 그때
  `modeLabels`와 `composerModeOf`가 저장된 값을 읽지 않는다는 점을 그대로 쓴다.
- R2의 계획이 `ask`의 "처음 Plan 승인"을 판단 대기 함에 보인다. 이 계획 뒤에는 워크플로 바에만 보인다.
- "사용자가 답했다"는 기록(`goalsUserAnswered`)은 메모리에만 있다. `auto`·`full`에서 서버를 재시작하면
  사용자의 다음 턴까지 보드가 시작하지 않고, 그동안 워크플로 바의 "승인하고 실행"으로 시작할 수 있다.
- 병합한 뒤 검토자가 실제 모델로 한 번 본다: `ask` 프로젝트에서 Goal을 맡기면 (1) 첫 답이 Plan 없이
  이해한 내용을 말하고, (2) 답한 뒤 Plan이 생기고 "승인하고 실행"이 보이며, (3) 모델이 "보드를 시작했다"고
  말하지 않는다.
