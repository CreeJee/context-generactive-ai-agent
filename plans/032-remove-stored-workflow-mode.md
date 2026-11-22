# Plan 032: 저장된 Goal/Plan 모드 값을 지운다 (`WorkflowMode`, move `"plan"`, `WorkflowState.mode`, DB 열 `mode`)

> **Executor instructions**: 이 계획을 단계 순서대로 따른다. 단계마다 Verify 명령을 돌려 기대한 결과를
> 확인한 뒤 다음 단계로 간다. "STOP conditions"에 해당하면 멈추고 보고한다. 임의로 풀지 않는다. 끝나면
> `plans/README.md`의 이 계획 행을 고친다(검토자가 표를 관리한다고 했으면 고치지 않는다).
>
> **이 저장소에서 찾을 때는 언제나 `rg --hidden -g '!.git' -g '!node_modules'`를 쓴다.** route 핸들러 폴더
> `apps/agent/app/.server`는 이름이 점으로 시작해서 `rg`가 기본으로 건너뛴다. `packages/memory-agent/tests/fixtures`의
> `.sql` 파일은 한 줄이 아주 길다. 찾을 때 `-g '!**/fixtures/**'`를 붙인다.
>
> **Drift check (먼저 실행)**:
> `git diff --stat 836783bd..HEAD -- packages/memory-agent/src/workflow packages/memory-agent/src/db/migrations.ts packages/memory-agent/src/testing/kanban.ts packages/memory-agent/tests/workflow packages/memory-agent/tests/support/workflow-state.ts packages/memory-agent/tests/chat/run-and-queue.test.ts apps/agent/app/entry`
> 바뀐 파일이 있으면 "Current state"의 발췌와 실제 코드를 비교한다. 다르면 STOP이다. 발췌와 실제 코드의
> 공백·줄바꿈 차이, 줄 번호가 몇 줄 어긋나는 것은 다른 것으로 보지 않는다. 계획 028·029·030이 먼저
> 들어가 `holder` 인자나 `migrations` 배열의 끝이 달라진 것도 다른 것으로 보지 않는다(아래 "Maintenance
> notes" 참고).

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (DB 열을 지우는 migration이 하나 있다)
- **Depends on**: 031 (병합됨, `2a444e18`)
- **Category**: tech-debt
- **Planned at**: commit `836783bd`, 2026-11-22

## Why this matters

계획 031이 "누가 처음 Plan을 승인하는가"를 프로젝트 권한 모드 하나로 정했다. 입력창에는 Chat과 Goal만
남았다. 그런데 워크플로 상태에는 아직 `mode: "plan" | "goal"` 값이 저장되고, 화면에 실려 가고, 전이
코드가 들고 다닌다. 아무도 그 값으로 동작을 가르지 않는다.

읽는 사람이 없는 값이 남아 있으면 세 가지가 나쁘다.

- 새 코드가 그 값을 다시 읽어 동작을 가를 수 있다. 그러면 승인자가 다시 둘이 된다.
- 화면이 보낼 수 있는 이동이 넷(`chat`, `plan`, `goal`, `run`)인데 `plan`과 `goal`이 같은 일을 한다.
- 테스트와 fixture가 뜻 없는 `mode`를 채워야 한다.

사용자 결정(`plans/consistency-rules.md`의 R1, 2026-11-21): "승인자는 프로젝트 권한 모드 하나가 정한다.
입력창의 Goal/Plan 모드를 없앤다." 이 계획은 그 결정의 나머지 반, 저장된 값을 지운다. 동작은 바뀌지
않는다.

## Current state

저장소: TypeScript monorepo. `packages/memory-agent`가 서버 로직, `apps/agent`가 React 화면이다. Effect
v4를 쓴다. 명령은 `vp`(Vite+)로 돌린다. DB는 SQLite이고 schema 단계는
`packages/memory-agent/src/db/migrations.ts`의 `migrations` 배열에 차례로 쌓는다. 배열의 길이가 schema
버전이다(`PRAGMA user_version`).

낱말:

- **Goal**: 사용자가 맡긴 결과. **Plan**: 그 Goal을 이루는 카드 목록. **보드**: Plan의 카드를 실행하는
  칸반 보드.
- **phase**: 워크플로가 있는 곳. `chat`(그냥 대화), `shaping`(Goal과 Plan을 만드는 중), `running`(보드가
  Plan을 실행 중), `completed`.
- **move**: 화면이 서버에 청하는 이동. 지금은 `chat`, `plan`, `goal`, `run` 넷이다.
- **revision**: 워크플로 상태의 한 판. 표 `workflow_state_revisions`의 한 행이고 고치지 않는다.

### 값이 정의된 곳 — `packages/memory-agent/src/workflow/contracts.ts`

105-114행:

```ts
/** Who approves the Plan and the cards added to it: the user (Plan) or the owner (Goal). */
export const WorkflowMode = Schema.Literals(["plan", "goal"]);
export type WorkflowMode = typeof WorkflowMode.Type;

/** What the page asks of the workflow: a mode to work in, or running the approved Plan. */
export const WorkflowMove = Schema.Literals(["chat", "plan", "goal", "run"]);
export type WorkflowMove = typeof WorkflowMove.Type;

/** Phases saved before the mode was its own value; each names its mode or a running Plan. */
const LegacyWorkflowPhase = Schema.Literals(["goal", "plan", "execute", "verify"]);
```

310-346행:

```ts
/** Where a saved state is: an older one has a legacy phase and no mode. */
export const storedPlaceFields = {
  phase: Schema.Union([WorkflowPhase, LegacyWorkflowPhase]),
  mode: Schema.optionalKey(Schema.NullOr(WorkflowMode)),
};
const StoredWorkflowState = Schema.Struct({ ...workflowStateFields, ...storedPlaceFields });

/** A saved state's phase and mode; a legacy phase names its mode, and no mode was Plan mode. */
export const decodedPlace = ({
  phase,
  mode,
}: Schema.Struct.Type<typeof storedPlaceFields>): {
  readonly phase: WorkflowPhase;
  readonly mode: WorkflowMode;
} =>
  Match.value(phase).pipe(
    Match.whenOr("goal", "plan", (legacy) => ({ phase: "shaping" as const, mode: legacy })),
    Match.whenOr("execute", "verify", () => ({ phase: "running" as const, mode: mode ?? "plan" })),
    Match.whenOr("chat", "shaping", "running", "completed", (current) => ({
      phase: current,
      mode: mode ?? "plan",
    })),
    Match.exhaustive,
  );

export const WorkflowState = StoredWorkflowState.pipe(
  Schema.decodeTo(
    Schema.toType(
      Schema.Struct({ ...workflowStateFields, phase: WorkflowPhase, mode: WorkflowMode }),
    ),
    SchemaTransformation.transform({
      decode: (stored) => ({ ...stored, ...decodedPlace(stored) }),
      encode: (state) => state,
    }),
  ),
);
```

598행: `moves: Schema.Record(WorkflowMove, WorkflowActionDecision),` — `WorkflowMove`를 따라가므로 손대지
않아도 바뀐다.

옛 phase 값(`goal`, `plan`, `execute`, `verify`)은 예전 버전이 저장한 revision에 남아 있다. **이 값을 읽는
길은 남긴다.** `mode`만 지운다.

### 값을 저장하고 읽는 곳

**`packages/memory-agent/src/workflow/state-rows.ts`** (파일 전체 27행). revision 행을 상태 JSON으로 만드는
SQL이다:

```ts
 * `workflow_state_revisions` in the query: an internal constant, never request input. A revision
 * saved before modes has no `mode` key, as that version wrote it (a NULL in a merge patch drops it).
 */
export const revisionStateSql = (revision: string) => `json_patch(json_object(
  'phase', ${revision}.phase,
  'goal', json(${revision}.goal_json),
  'plan', json(${revision}.plan_json),
  'ledger', (SELECT json_group_array(json_object(
      'sequence', e.sequence, 'at', e.at, 'kind', e.kind, 'detail', e.detail) ORDER BY e.sequence)
    FROM workflow_ledger_events e
    WHERE e.session_id = ${revision}.session_id AND e.sequence <= ${revision}.ledger_length)),
  json_object('mode', ${revision}.mode))`;
```

**`packages/memory-agent/src/workflow/workflow.ts`**:

- 93행: `WorkflowMode,`를 다시 내보낸다. 59행: `decodedPlace,`를 가져온다.
- 240-246행:

  ```ts
  const emptyState = (): WorkflowState => ({
    phase: "chat",
    mode: "plan",
    goal: null,
    plan: null,
    ledger: [],
  });
  ```

- 253-269행:

  ```ts
  const PersistedWorkflowState = Schema.Struct({
    ...storedPlaceFields,
    goal: Schema.NullOr(GoalArtifact),
    plan: Schema.NullOr(PersistedPlanArtifact),
    ledger: Schema.Array(LedgerEvent),
  });
  ...
  export const decodeWorkflowState = (json: string) =>
    Schema.decodeEffect(Schema.fromJsonString(PersistedWorkflowState))(json).pipe(
      Effect.map((stored): WorkflowState => ({
        ...decodedPlace(stored),
        goal: stored.goal,
        plan: persistedPlan(stored.plan),
        ledger: stored.ledger,
      })),
    );
  ```

- 334-355행:

  ```ts
  const withStanding = (state: WorkflowState, standing: Standing, at: string): WorkflowState => ({
    ...state,
    phase: standing.phase,
    mode: standing.mode,
    goal: ...
  });
  const unchanged = (next: WorkflowState, current: WorkflowState) =>
    next.phase === current.phase &&
    next.mode === current.mode &&
    next.goal === current.goal &&
    next.plan === current.plan;

  /** A ledger's name for where a state is; shaping and running say whose approval they wait for. */
  const placeText = ({ phase, mode }: WorkflowState) =>
    phase === "shaping" || phase === "running" ? `${phase} (${mode})` : phase;
  ```

- 494-497행 (revision을 쓰는 SQL):

  ```ts
  yield* sql`INSERT INTO workflow_state_revisions
    (session_id, phase, mode, goal_json, plan_json, ledger_length, goal_version, plan_version,
     provenance, created_at, goal_instance_id, author_json)
    VALUES (${sessionId}, ${state.phase}, ${state.mode}, ${goalJson}, ${planJson},
  ```

- 737-739행: `yield* save(sessionId, { phase: standing.phase, mode: standing.mode, goal: {`
- 1008-1027행:

  ```ts
  /** Works in a mode the user chose, or runs the approved Plan (`run`). */
  move: (sessionId: string, move: WorkflowMove) =>
    transacted(
      Effect.gen(function* () {
        const current = yield* get(sessionId);
        const state = goalState(current);
        const outcome =
          move === "run"
            ? goalTransitions.ExecutionApproved(state, GoalEvent.ExecutionApproved())
            : goalTransitions.Navigated(state, GoalEvent.Navigated({ to: move }));
        ...
              event(current, "phase_changed", `${placeText(current)} -> ${placeText(next)}`, now),
  ```

**DB 열** — `packages/memory-agent/src/db/migrations.ts` 2945-2950행:

```ts
  `
  -- Who approves a revision's Plan and its new cards: the user (plan) or the owner (goal).
  -- Older revisions keep NULL; their phase names the mode, or they were Plan mode.
  ALTER TABLE workflow_state_revisions ADD COLUMN mode TEXT
    CHECK (mode IS NULL OR mode IN ('plan', 'goal'));
  `,
```

이 열을 가리키는 index, trigger, view는 없다. 표의 trigger `workflow_state_revisions_no_update`는 UPDATE만
막고 열 이름을 쓰지 않는다.

열을 지운 선례 — 같은 파일 3012-3017행:

```ts
  `
  -- The project's permission mode alone approves the cards the planner adds to a running board
  -- (decisions.md "새 카드 승인은 보드를 누가 시작했는지가 아니라 프로젝트 권한 모드가 정한다
  -- (2026-11-12)"), so a board no longer records who approves them.
  ALTER TABLE kanban_goals DROP COLUMN card_approval;
  `,
```

`migrations` 배열의 마지막 원소는 지금 `CREATE TABLE project_terms (...)` 문자열이다. 배열은 `];`로 끝나고
바로 뒤에 `export const goalHistoryMigration`이 온다.

### 값을 들고 다니는 전이 — `packages/memory-agent/src/workflow/goal-transitions.ts`

- 6행: `WorkflowMode,`를 가져온다.
- 35-41행:

  ```ts
  /** What decides a session's Goal transitions: its phase and mode, its Goal and its Plan. */
  export interface Standing {
    readonly phase: WorkflowPhase;
    readonly mode: WorkflowMode;
    readonly goal: GoalStanding | null;
    readonly plan: PlanStanding | null;
  }
  ```

- 51행(`standingOf`): `mode: state.mode,`
- 216-217행:

  ```ts
  /** The user works in plain chat, or shapes the Goal in a mode. Running is `ExecutionApproved`. */
  Navigated: { readonly to: "chat" | WorkflowMode };
  ```

- 304, 345, 355, 390, 440행: `Standing`을 새로 만드는 다섯 곳에 `mode: standing.mode,` 한 줄씩 있다.
- 453-459행:

  ```ts
  Navigated: (state, { to }) => {
    const navigate = ({ standing }: { readonly standing: Standing }) =>
      moved(
        to === "chat"
          ? { ...standing, phase: "chat" }
          : { ...standing, phase: "shaping", mode: to },
      );
  ```

### 이동 넷을 만드는 곳 — `packages/memory-agent/src/workflow/actions.ts` 99행

```ts
    moves: { chat: move("chat"), plan: move("plan"), goal: move("goal"), run: move("run") },
```

### 밖으로 내보내는 곳

- `packages/memory-agent/src/index.ts` 357행: `WorkflowMode,`
- `apps/agent/app/entry/api.ts` 86행과 240행: `WorkflowMode,` (가져와서 다시 내보낸다)

화면 코드에서 타입 `WorkflowMode`를 쓰는 곳은 없다. `chat-composer.tsx`의 prop 이름 `onWorkflowMode`,
`workflowModes`, `workflow-panel.tsx`의 `modeLabels`·`composerModeOf`·`workflowModeLabel`은 입력창의
Chat/Goal 고르기를 가리키는 이름이다. **이 이름들은 그대로 둔다.**

### `mode`나 move `"plan"`을 쓰는 테스트와 테스트 도우미

서버:

- `packages/memory-agent/src/testing/kanban.ts` 479행: `yield* workflows.move(sessionId, "plan");`
- `packages/memory-agent/src/kanban/orchestrator.test.ts` 524행: `yield* workflows.move(board.sessionId, "plan");`
- `packages/memory-agent/src/workflow/instructions.test.ts` 7-15행, 28-44행:

  ```ts
  import type { WorkflowMode, WorkflowPhase, WorkflowState } from "./workflow.ts";

  const state = (phase: WorkflowPhase, mode: WorkflowMode = "plan"): WorkflowState => ({
    phase,
    mode,
    goal: null,
    plan: null,
    ledger: [],
  });
  ...
    const planner = (phase: WorkflowPhase, mode: WorkflowMode) =>
      workflowInstructions(state(phase, mode), resolved(phase));
    for (const prompt of [
      planner("shaping", "goal"),
      planner("shaping", "plan"),
      planner("running", "plan"),
    ]) {
      expect(prompt).toContain(cardCapabilities);
    }
    expect(planner("completed", "plan")).not.toContain(cardCapabilities);
  });
  test("shapes a Goal the same way whatever mode the state was saved in", () => {
    const goalMode = workflowInstructions(state("shaping", "goal"), resolved("shaping"));
    expect(workflowInstructions(state("shaping", "plan"), resolved("shaping"))).toBe(goalMode);
    expect(goalMode).toContain("save no Plan");
    expect(goalMode).toContain("the project's permission mode decides who approves the Plan");
  });
  ```

- `packages/memory-agent/src/workflow/goal-transitions.test.ts`: 32행
  `...(["chat", "plan", "goal"] as const).map((to) => GoalEvent.Navigated({ to })),`. 53-56행 `keyOf`가
  `mode`를 키에 넣는다.
  120행 `const start: Standing = { phase: "chat", mode: "plan", goal: null, plan: null };`. 197행
  `return { phase: standing.phase, mode: standing.mode, goal, plan, ledger: [] };`. 267-276행에
  `mode: "plan"`이 셋 있다.
- `packages/memory-agent/tests/support/workflow-state.ts` 35-46행 (테스트가 상태를 직접 저장하는 도우미):

  ```ts
  yield* sqlRun(
    `INSERT INTO workflow_state_revisions
       (session_id, phase, mode, goal_json, plan_json, ledger_length, goal_version, plan_version,
        provenance, created_at, goal_instance_id)
     VALUES (?1, ?2 ->> 'phase', ?2 ->> 'mode', nullif(?2 -> '$.goal', 'null'),
       nullif(?2 -> '$.plan', 'null'),
  ```

- `packages/memory-agent/tests/workflow/state.test.ts`:
  - 600-616행:

    ```ts
    it.effect("reads a phase saved before modes as its mode and place", () =>
      Effect.gen(function* () {
        const id = yield* freshSession;
        const workflows = yield* Workflows;
        const current = yield* executing(id);
        const stored = (phase: string) =>
          stateJson({ ...Struct.omit(current, ["mode"]), phase }).pipe(
            Effect.andThen((json) => storeWorkflowState(id, json)),
            Effect.andThen(workflows.get(id)),
            Effect.map(({ phase, mode }) => ({ phase, mode })),
          );
        expect(yield* stored("goal")).toEqual({ phase: "shaping", mode: "goal" });
        expect(yield* stored("plan")).toEqual({ phase: "shaping", mode: "plan" });
        expect(yield* stored("execute")).toEqual({ phase: "running", mode: "plan" });
        expect(yield* stored("verify")).toEqual({ phase: "running", mode: "plan" });
      }),
    );
    ```

  - 722행: 상태 목록의 마지막 원소 `{ ...state, phase: "shaping", mode: "goal" },`
  - 748행: `["chat", "plan", "goal", "run"] as const,`
- `packages/memory-agent/tests/workflow/goal-transition.test.ts` 581행과 644행: `toMatchObject` 안의
  `mode: "goal",`
- `packages/memory-agent/tests/workflow/execution.test.ts` 231-240행:

  ```ts
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

- `packages/memory-agent/tests/chat/run-and-queue.test.ts` 140-158행:

  ```ts
  yield* agent.moveWorkflow(session.id, null, "plan");
  ...
  expect(running.actions.moves.plan).toEqual({ allowed: false, reason: "run_in_progress" });
  ...
  expect(stopped.actions.moves.plan).toEqual({ allowed: true });
  expect(yield* (yield* Workflows).get(session.id)).toMatchObject({
    phase: "shaping",
    mode: "plan",
  });
  ```

화면:

- `apps/agent/app/entry/session/workflow-test-fixtures.ts` 17행: `mode: "plan",`
- `apps/agent/app/entry/session/use-run-state.test.tsx` 46행 `mode: "plan",`, 134행
  `kind === "move" ? run.moveWorkflow("plan") : run.controlWorkflow("pause");`
- `apps/agent/app/entry/session/run-notice.test.ts` 27행,
  `apps/agent/app/entry/chat/chat-panel.browser.tsx` 68행:
  `workflow: { phase: "chat", mode: "plan", goal: null, plan: null, ledger: [] },`
- `apps/agent/app/entry/chat/workflow-panel.test.tsx` 35, 37, 45, 93, 134행: `mode: "goal"`

### 문서

`packages/memory-agent/src/workflow/README.md`:

- 12행: 타입 목록에 `WorkflowMode`가 있고 "(phase: chat|shaping|running|completed, mode: plan|goal). 모드가
  따로 저장되기 전의 phase(…"로 이어진다.
- 21행: "이동(chat·plan·goal 모드, `run`)·pause/resume/stop 허용 판정"
- 61행: "revision은 phase와 mode, Goal·Plan JSON, 자기가 가진 사건 수(`ledger_length`)를 갖고 고치지 않는다."
- 70행: "사용자는 chat이나 모드(plan·goal)로 옮기거나 Plan을 실행(`run`)한다. 모드로 옮기면 shaping이
  되고, 실행 중인 보드는 다시 승인할 때까지 카드를 배정하지 않는다."

`docs/decisions.md`의 마지막 항목은 `## 처음 Plan의 승인자는 프로젝트 권한 모드가 정한다 (2026-11-22)`이다.

### 지킬 규칙 (`AGENTS.md`, `CLAUDE.md`에서)

- `let`, `while`을 쓰지 않는다. lint를 끄는 주석을 쓰지 않는다. 타입 `unknown`을 쓰지 않는다.
- 줄바꿈만 바꾸는 편집을 하지 않는다. 포매터(`vp check --fix`, commit hook이 돌린다)가 줄을 정한다.
- 주석과 문서에는 쉬운 낱말을 쓴다. 새로 지어낸 용어를 쓰지 않는다.
- 진단하려고 추적 파일을 임시로 고치지 않는다.
- 커밋 메시지는 한국어 conventional commit이다(예: `refactor(workflow): …`). 커밋마다 typecheck가 통과해야
  한다.
- 고치지 않는 코드의 주석을 지우거나 줄이지 않는다.

## Commands you will need

저장소 루트(`vp lint`, typecheck)와 package 폴더(테스트)에서 돌린다.

| 목적            | 명령                                                                                                               | 기대             |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 서버 typecheck  | `vp run memory-agent#typecheck` (루트)                                                                             | exit 0           |
| 화면 typecheck  | `vp run agent#typecheck` (루트)                                                                                    | `3/3 successful` |
| lint            | `vp lint` (루트. package 폴더에서 돌리면 규칙 일부가 빠진다)                                                       | exit 0           |
| 서버 테스트     | `cd packages/memory-agent && vp test run --maxWorkers=4 <파일…>`                                                   | 모두 통과        |
| 화면 테스트     | `cd apps/agent && vp test run <파일…>`                                                                             | 모두 통과        |
| 브라우저 테스트 | `vp test --config apps/agent/vite.browser.config.ts --run apps/agent/app/entry/chat/chat-panel.browser.tsx` (루트) | 모두 통과        |

새 worktree에서는 먼저 한 번 `vp install`과 `vp run turbovec#build`를 돌린다. 안 돌리면 서버 테스트가
`NativeOwnerFailed: Native search owner failed: native-incompatible`로 실패한다. 이 둘은 추적 파일을
바꾸지 않는다.

브라우저 테스트가 첫 실행에서 "reload"로 실패하면 한 번 더 돌린다. 설정에 `optimizeDeps`를 더하지 않는다.

전체 테스트를 돌리지 않는다. 아래에 적힌 파일만 돌린다.

서버 테스트 묶음(아래에서 "서버 묶음"이라 부른다):

```
src/workflow/instructions.test.ts src/workflow/goal-transitions.test.ts
src/kanban/orchestrator.test.ts tests/workflow/state.test.ts
tests/workflow/goal-transition.test.ts tests/workflow/execution.test.ts
tests/workflow/board.test.ts tests/chat/run-and-queue.test.ts
tests/db-migrator-metadata.test.ts tests/upgrade-0.0.17.test.ts
```

화면 테스트 묶음("화면 묶음"):

```
app/entry/chat/workflow-panel.test.tsx app/entry/chat/chat-composer.test.tsx
app/entry/chat/slash-commands.test.ts app/entry/session/use-run-state.test.tsx
app/entry/session/run-notice.test.ts
```

## Scope

**고치는 파일**

- `packages/memory-agent/src/workflow/contracts.ts`
- `packages/memory-agent/src/workflow/workflow.ts`
- `packages/memory-agent/src/workflow/goal-transitions.ts`
- `packages/memory-agent/src/workflow/actions.ts`
- `packages/memory-agent/src/workflow/state-rows.ts`
- `packages/memory-agent/src/index.ts`
- `packages/memory-agent/src/db/migrations.ts` (배열 끝에 원소 하나를 더한다. 있는 원소는 고치지 않는다)
- `packages/memory-agent/src/testing/kanban.ts`
- 위 "테스트와 테스트 도우미"에 적은 서버 파일 9개
- `apps/agent/app/entry/api.ts`
- 위에 적은 화면 테스트·fixture 파일 5개
- `packages/memory-agent/src/workflow/README.md`, `docs/decisions.md`
- typecheck가 `mode`나 `"plan"` 때문에 실패한다고 가리키는 다른 테스트·fixture 파일(같은 식으로 고친다)

**고치지 않는 것**

- `packages/memory-agent/tests/fixtures/*.sql` — 예전 버전의 DB를 그대로 담은 파일이다.
- `migrations` 배열에 이미 있는 원소(2945-2950행의 `ADD COLUMN mode` 포함). 적용된 단계는 고치지 않는다.
- `docs/decisions.md`의 예전 항목. 그때의 결정을 그대로 둔다.
- 화면의 `modeLabels`, `composerModeOf`, `workflowModeLabel`, `workflowModes`, `onWorkflowMode`. 이름을 바꾸지
  않는다.
- 다른 `mode`들: `KanbanMode`(`worktree`/`sequential`), `permissionMode`, `kanban_goals.mode`. 이 계획과 상관없다.
- `WorkflowMove`의 `"goal"`이라는 이름. 그대로 둔다.
- `LegacyWorkflowPhase`와 `packages/memory-agent/src/workflow/rules.ts`의 `RulePhase`
  (`"goal" | "plan" | "execute" | "verify"`). 규칙이 읽히는 단계 이름이고 이 계획과 상관없다.
- 동작. 어떤 이동이 허용되는지, 언제 보드가 시작하는지는 바뀌지 않는다.

## Git workflow

- 지금 있는 worktree의 브랜치에서 일한다. push하지 않는다. merge하지 않는다.
- 단계 1, 2, 3이 끝날 때마다 커밋한다(커밋 3개). 자기가 고친 경로만 `git add`한다.
- 커밋 hook이 `vp check --fix`를 돌린다. hook이 고친 것이 있으면 다시 add해서 커밋한다. `--no-verify`를
  쓰지 않는다.

## Steps

### Step 0: 고치기 전에 테스트가 통과하는지 본다

`cd packages/memory-agent && vp test run --maxWorkers=4 <서버 묶음>` 과
`cd apps/agent && vp test run <화면 묶음>`을 돌린다.

**Verify**: 둘 다 모두 통과한다. 실패하면 STOP이다(이 계획이 만든 실패가 아니다).

### Step 1: 코드에서 `mode`와 move `"plan"`을 지운다 (DB 열은 그대로 둔다)

이 단계가 끝나면 서버는 열 `mode`에 아무것도 쓰지 않고 읽지 않는다. 열은 NULL을 받으므로 그대로 둬도
된다. 열은 Step 2가 지운다.

**1-a. `contracts.ts`**

105-114행을 이렇게 바꾼다(`WorkflowMode` 정의 세 줄을 지운다):

```ts
/** What the page asks of the workflow: plain chat, shaping a Goal, or running the approved Plan. */
export const WorkflowMove = Schema.Literals(["chat", "goal", "run"]);
export type WorkflowMove = typeof WorkflowMove.Type;

/** Phases an older version saved: "goal" and "plan" were shaping, "execute" and "verify" running. */
const LegacyWorkflowPhase = Schema.Literals(["goal", "plan", "execute", "verify"]);
```

310-346행을 이렇게 바꾼다:

```ts
/** The phase of a saved state; an older version saved a legacy one. */
export const StoredWorkflowPhase = Schema.Union([WorkflowPhase, LegacyWorkflowPhase]);
const StoredWorkflowState = Schema.Struct({ ...workflowStateFields, phase: StoredWorkflowPhase });

/** A saved phase as today's phase. */
export const decodedPhase = (phase: typeof StoredWorkflowPhase.Type): WorkflowPhase =>
  Match.value(phase).pipe(
    Match.whenOr("goal", "plan", () => "shaping" as const),
    Match.whenOr("execute", "verify", () => "running" as const),
    Match.whenOr("chat", "shaping", "running", "completed", (current) => current),
    Match.exhaustive,
  );

export const WorkflowState = StoredWorkflowState.pipe(
  Schema.decodeTo(
    Schema.toType(Schema.Struct({ ...workflowStateFields, phase: WorkflowPhase })),
    SchemaTransformation.transform({
      decode: (stored) => ({ ...stored, phase: decodedPhase(stored.phase) }),
      encode: (state) => state,
    }),
  ),
);
```

98-101행 `WorkflowPhase` 위의 주석은 그대로 둔다.

**1-b. `goal-transitions.ts`**

- 6행의 `WorkflowMode,` import를 `WorkflowMove,`로 바꾼다(`./workflow.ts`가 `WorkflowMove`를 내보낸다.
  `workflow.ts` 94행).
- `Standing`에서 `readonly mode: WorkflowMode;`를 지우고 주석을
  `/** What decides a session's Goal transitions: its phase, its Goal and its Plan. */`로 바꾼다.
- `standingOf`의 `mode: state.mode,`를 지운다.
- 304, 345, 355, 390, 440행의 `mode: standing.mode,` 다섯 줄을 지운다.
- 216-217행:

  ```ts
  /** The user works in plain chat, or shapes the Goal. Running is `ExecutionApproved`. */
  Navigated: { readonly to: Exclude<WorkflowMove, "run"> };
  ```

- 453-459행의 `navigate`:

  ```ts
  const navigate = ({ standing }: { readonly standing: Standing }) =>
    moved({ ...standing, phase: to === "chat" ? "chat" : "shaping" });
  ```

**1-c. `actions.ts`** 99행: `moves: { chat: move("chat"), goal: move("goal"), run: move("run") },`

**1-d. `state-rows.ts`**

`revisionStateSql`에서 `json_patch(`와 마지막 줄 `json_object('mode', ${revision}.mode))`를 없애
`json_object(…)` 하나만 남긴다:

```ts
export const revisionStateSql = (revision: string) => `json_object(
  'phase', ${revision}.phase,
  'goal', json(${revision}.goal_json),
  'plan', json(${revision}.plan_json),
  'ledger', (SELECT json_group_array(json_object(
      'sequence', e.sequence, 'at', e.at, 'kind', e.kind, 'detail', e.detail) ORDER BY e.sequence)
    FROM workflow_ledger_events e
    WHERE e.session_id = ${revision}.session_id AND e.sequence <= ${revision}.ledger_length))`;
```

그 위 주석의 마지막 문장("A revision saved before modes has no `mode` key, …")을 지운다. 파일 맨 위 주석의
"a revision holds its phase, Goal and Plan"은 맞는 말이므로 그대로 둔다.

**1-e. `workflow.ts`**

- 93행의 `WorkflowMode,` 재수출을 지운다. 59행 import의 `decodedPlace`를 `decodedPhase`로,
  `storedPlaceFields`를 `StoredWorkflowPhase`로 바꾼다.
- `emptyState`에서 `mode: "plan",`을 지운다.
- `PersistedWorkflowState`의 `...storedPlaceFields,`를 `phase: StoredWorkflowPhase,`로 바꾼다.
- `decodeWorkflowState`의 `...decodedPlace(stored),`를 `phase: decodedPhase(stored.phase),`로 바꾼다.
- `withStanding`에서 `mode: standing.mode,`를, `unchanged`에서 `next.mode === current.mode &&`를 지운다.
- `placeText`를 지운다. 1026행은 `` `${current.phase} -> ${next.phase}` ``로 바꾼다. `placeText`를 쓰는 곳이
  더 있으면 같은 식으로 바꾼다.
- 494-497행 INSERT에서 열 목록의 `mode, `와 값 목록의 `${state.mode}, `를 지운다.
- 737-739행 `save(sessionId, {` 안의 `mode: standing.mode,`를 지운다.
- 1008행 주석을 `/** Works in plain chat or shapes the Goal as the user chose, or runs the approved Plan (\`run\`). */`로 바꾼다.

**1-f. 내보내는 곳**: `packages/memory-agent/src/index.ts` 357행의 `WorkflowMode,`,
`apps/agent/app/entry/api.ts` 86행과 240행의 `WorkflowMode,`를 지운다.

**1-g. 서버 테스트와 도우미**

- `src/testing/kanban.ts` 479행, `src/kanban/orchestrator.test.ts` 524행: `"plan"`을 `"goal"`로 바꾼다.
  (둘 다 "실행을 멈추고 shaping으로 돌아간다"는 뜻으로 쓴다. `"goal"`이 같은 일을 한다.)
- `src/workflow/instructions.test.ts`: `state`에서 `mode` 인자와 필드를 지우고 import에서 `WorkflowMode`를
  뺀다. 첫 테스트는 이렇게 된다:

  ```ts
  const planner = (phase: WorkflowPhase) => workflowInstructions(state(phase), resolved(phase));
  for (const prompt of [planner("shaping"), planner("running")]) {
    expect(prompt).toContain(cardCapabilities);
  }
  expect(planner("completed")).not.toContain(cardCapabilities);
  ```

  둘째 테스트는 이렇게 바꾼다(두 모드를 비교하던 줄을 지우고 두 단언은 남긴다):

  ```ts
  test("shapes a Goal by aligning first and names who approves the Plan", () => {
    const shaping = workflowInstructions(state("shaping"), resolved("shaping"));
    expect(shaping).toContain("save no Plan");
    expect(shaping).toContain("the project's permission mode decides who approves the Plan");
  });
  ```

  파일의 다른 곳이 `state(phase, mode)`를 두 인자로 부르면 둘째 인자를 지운다.

- `src/workflow/goal-transitions.test.ts`: `keyOf`의 구조 분해와 배열에서 `mode`를 지운다. 120행은
  `{ phase: "chat", goal: null, plan: null }`. 197행에서 `mode: standing.mode,`를 지운다. 267-276행의
  `mode: "plan",` 셋을 지운다. 32행
  `...(["chat", "plan", "goal"] as const).map((to) => GoalEvent.Navigated({ to })),`의 배열을
  `["chat", "goal"]`로 바꾼다.
- `tests/workflow/state.test.ts`:
  - 600-616행 테스트:

    ```ts
    it.effect("reads a phase an older version saved as today's phase", () =>
      Effect.gen(function* () {
        const id = yield* freshSession;
        const workflows = yield* Workflows;
        const current = yield* executing(id);
        const stored = (phase: string) =>
          stateJson({ ...current, phase }).pipe(
            Effect.andThen((json) => storeWorkflowState(id, json)),
            Effect.andThen(workflows.get(id)),
            Effect.map((state) => state.phase),
          );
        expect(yield* stored("goal")).toBe("shaping");
        expect(yield* stored("plan")).toBe("shaping");
        expect(yield* stored("execute")).toBe("running");
        expect(yield* stored("verify")).toBe("running");
      }),
    );
    ```

    `Struct` import가 이 파일의 다른 곳에서 안 쓰이면 import에서 뺀다.

  - 722행의 `{ ...state, phase: "shaping", mode: "goal" },`를 지운다.
  - 748행: `["chat", "goal", "run"] as const,`
- `tests/workflow/goal-transition.test.ts` 581행과 644행의 `mode: "goal",`를 지운다.
- `tests/workflow/execution.test.ts` 231-240행의 테스트 "a state saved in Plan mode follows the permission
  mode too"를 통째로 지운다. 그런 상태가 이제 없다. 파일 맨 위 주석이나 다른 테스트는 건드리지 않는다.
- `tests/chat/run-and-queue.test.ts` 140-158행: `moveWorkflow(…, "plan")`을 `"goal"`로, `moves.plan` 둘을
  `moves.goal`로 바꾸고, 마지막 `toMatchObject`에서 `mode: "plan",`을 지운다. `moveWorkflow`의 다른 인자는
  실제 코드에 있는 그대로 둔다.
- `tests/support/workflow-state.ts`는 이 단계에서 고치지 않는다(Step 2에서 고친다).

**1-h. 화면 테스트와 fixture**

- `workflow-test-fixtures.ts` 17행, `use-run-state.test.tsx` 46행의 `mode: "plan",`을 지운다.
- `run-notice.test.ts` 27행, `chat-panel.browser.tsx` 68행:
  `workflow: { phase: "chat", goal: null, plan: null, ledger: [] },`
- `use-run-state.test.tsx` 134행: `run.moveWorkflow("goal")`
- `workflow-panel.test.tsx`:
  - 35행: `expect(workflowModeLabel({ ...workflowFixture, phase: "running" })).toBe("Goal");`
  - 37행: `expect(workflowModeLabel({ ...workflowFixture, phase: "chat" })).toBe("Chat");`
  - 45행: `state={{ ...workflowFixture, phase: "running" }}`
  - 93행과 134행: `state={{ ...workflowFixture, mode: "goal" }}`를 `state={workflowFixture}`로 바꾼다.

**1-i.** 두 typecheck를 돌려 남은 곳을 찾는다. `mode`가 없다거나 `"plan"`을 `WorkflowMove`에 줄 수 없다는
오류가 가리키는 곳을 같은 식으로 고친다(값 지우기, `"plan"`을 `"goal"`로). 그 밖의 오류가 나오면 STOP이다.

**Verify**:

- `vp run memory-agent#typecheck` → exit 0. `vp run agent#typecheck` → `3/3 successful`. `vp lint` → exit 0.
- `rg --hidden -g '!.git' -g '!node_modules' -g '!**/fixtures/**' -n "\bWorkflowMode\b|decodedPlace|storedPlaceFields|placeText" packages apps`
  → `packages/memory-agent/src/workflow/README.md`의 줄만 나온다(Step 3에서 고친다).
- `rg --hidden -g '!.git' -g '!node_modules' -n "moves\.plan|move\(\"plan\"\)|moveWorkflow\([^)]*\"plan\"" packages apps`
  → 출력 없음.
- 서버 묶음과 화면 묶음 → 모두 통과.
- 브라우저 테스트 → 모두 통과.

커밋: `refactor(workflow): 저장된 Goal/Plan 모드 값과 move "plan"을 지운다`

### Step 2: DB 열 `mode`를 지운다

**2-a.** `packages/memory-agent/src/db/migrations.ts`의 `migrations` 배열 **맨 끝**(지금은
`CREATE TABLE project_terms` 원소 뒤, `];` 앞)에 원소 하나를 더한다:

```ts
  `
  -- The project's permission mode alone decides who approves a Plan (decisions.md "처음 Plan의
  -- 승인자는 프로젝트 권한 모드가 정한다 (2026-11-22)"), so a revision no longer records a mode.
  ALTER TABLE workflow_state_revisions DROP COLUMN mode;
  `,
```

다른 계획이 먼저 들어가 배열 끝에 다른 원소가 있으면 그 뒤에 더한다. 있는 원소의 순서를 바꾸지 않는다.

**2-b.** `packages/memory-agent/tests/support/workflow-state.ts` 35-46행의 INSERT에서 열 목록의 `mode, `와
값 목록의 `?2 ->> 'mode', `를 지운다:

```ts
    `INSERT INTO workflow_state_revisions
       (session_id, phase, goal_json, plan_json, ledger_length, goal_version, plan_version,
        provenance, created_at, goal_instance_id)
     VALUES (?1, ?2 ->> 'phase', nullif(?2 -> '$.goal', 'null'),
       nullif(?2 -> '$.plan', 'null'),
```

**2-c.** 열을 이름으로 쓰는 SQL이 남았는지 본다:
`rg --hidden -g '!.git' -g '!node_modules' -g '!**/fixtures/**' -n "workflow_state_revisions" packages/memory-agent/src packages/memory-agent/tests -l`
로 나온 파일에서 `INSERT INTO workflow_state_revisions`나 `r.mode`·`revision.mode`가 `mode`를 쓰는지 확인한다.
`migrations.ts`의 예전 원소 말고 남은 곳이 있으면 같은 식으로 지운다.

**Verify**:

- `vp run memory-agent#typecheck` → exit 0. `vp lint` → exit 0.
- 서버 묶음 → 모두 통과. 그 가운데 `tests/upgrade-0.0.17.test.ts`(예전 DB를 지금 schema로 올린다)와
  `tests/db-migrator-metadata.test.ts`가 통과해야 한다.
- `cd packages/memory-agent && vp test run --maxWorkers=4 src/kanban/kanban-flow.test.ts src/workflow/durable-stream.test.ts`
  → 모두 통과(상태를 SQL로 읽는 다른 길).

커밋: `refactor(db): workflow revision의 mode 열을 지운다`

### Step 3: 문서와 결정 기록

**3-a. `packages/memory-agent/src/workflow/README.md`**

- 12행: 타입 목록에서 `` `WorkflowMode` / ``를 지운다. "(phase: chat|shaping|running|completed, mode:
  plan|goal)"에서 ", mode: plan|goal"을 지운다. 이어지는 "모드가 따로 저장되기 전의 phase(goal·plan은
  shaping과 그 모드, execute·verify는 running)도 읽는다."를 "예전 버전이 저장한 phase(goal·plan은 shaping,
  execute·verify는 running)도 읽는다."로 바꾼다. 그 뒤 문장 "`mode`는 저장만 되고 동작을 가르지
  않는다(decisions.md "처음 Plan의 승인자는 프로젝트 권한 모드가 정한다")."를 지운다.
- 21행: "이동(chat·plan·goal 모드, `run`)"을 "이동(`chat`·`goal`·`run`)"으로 바꾼다.
- 61행: "revision은 phase와 mode, Goal·Plan JSON"에서 "와 mode"를 지운다.
- 70행: "사용자는 chat이나 모드(plan·goal)로 옮기거나 Plan을 실행(`run`)한다. 모드로 옮기면 shaping이
  되고"를 "사용자는 chat이나 Goal 만들기(`goal`)로 옮기거나 Plan을 실행(`run`)한다. `goal`로 옮기면
  shaping이 되고"로 바꾼다. 문장의 나머지는 그대로 둔다.

**3-b. 다른 README**: 다음 명령에 나오는 줄이 지금 상태를 설명하면서 `WorkflowMode`나 move `plan`을
말하면 같은 식으로 고친다. 나오는 줄이 없으면 넘어간다.
`rg --hidden -g '!.git' -g '!node_modules' -g '*.md' -g '!docs/decisions.md' -g '!plans/**' -n "WorkflowMode|plan·goal|decodedPlace" .`

**3-c. `docs/decisions.md`** 맨 끝에 항목을 더한다:

```md
## 워크플로 상태는 Goal/Plan 모드를 저장하지 않는다 (2026-11-22)

"처음 Plan의 승인자는 프로젝트 권한 모드가 정한다 (2026-11-22)"로 입력창의 Plan 모드가 없어진 뒤에도
워크플로 상태에는 `mode: plan | goal`이 남아 있었다. 그 값을 읽어 동작을 가르는 코드는 없었다.

- 상태에서 `mode`를 지웠다. 타입 `WorkflowMode`, 이동 `plan`, 표 `workflow_state_revisions`의 열 `mode`도
  지웠다.
- 화면이 청하는 이동은 `chat`, `goal`, `run` 셋이다. `goal`은 shaping으로 옮긴다.
- 예전 버전이 저장한 phase(`goal`, `plan`, `execute`, `verify`)는 계속 읽는다. `goal`과 `plan`은 shaping,
  `execute`와 `verify`는 running이다.
- ledger의 `phase_changed` 사건은 이제 `shaping -> running`처럼 phase만 적는다. 예전 사건의
  `shaping (plan)` 같은 글자는 그대로 남는다.

구현: 계획 032.
```

**Verify**:

- `rg --hidden -g '!.git' -g '!node_modules' -g '!**/fixtures/**' -n "\bWorkflowMode\b|decodedPlace|storedPlaceFields" packages apps`
  → 출력 없음.
- `rg -n "워크플로 상태는 Goal/Plan 모드를 저장하지 않는다" docs/decisions.md` → 한 줄.
- `vp lint` → exit 0.

커밋: `docs(workflow): 상태가 Goal/Plan 모드를 저장하지 않는다는 결정을 적는다`

## Test plan

새 동작이 없으므로 새 테스트 파일은 만들지 않는다. 바뀌는 테스트:

- `state.test.ts`의 "reads a phase an older version saved as today's phase": 옛 phase 넷이 지금 phase로
  읽히는지 본다(옛 `mode` 단언을 대신한다).
- `state.test.ts`의 이동 대조 테스트: 이동 셋(`chat`, `goal`, `run`)에 대해 서버가 알린 허용 여부와 실제
  결과가 같은지 본다.
- `instructions.test.ts`의 "shapes a Goal by aligning first and names who approves the Plan".
- `upgrade-0.0.17.test.ts`와 `db-migrator-metadata.test.ts`가 새 migration을 거쳐 통과하는지 본다.

지우는 테스트는 하나다: `execution.test.ts`의 "a state saved in Plan mode follows the permission mode too".

## Done criteria

- [ ] `vp run memory-agent#typecheck` exit 0, `vp run agent#typecheck` `3/3 successful`, 루트 `vp lint` exit 0.
- [ ] 서버 묶음, 화면 묶음, 브라우저 테스트가 모두 통과한다.
- [ ] `rg --hidden -g '!.git' -g '!node_modules' -g '!**/fixtures/**' -n "\bWorkflowMode\b|decodedPlace|storedPlaceFields|placeText" packages apps` 출력 없음.
- [ ] `rg -n "DROP COLUMN mode" packages/memory-agent/src/db/migrations.ts` 한 줄.
- [ ] 커밋 3개, 각각 자기 단계의 파일만 담는다.
- [ ] `git status --short`가 비어 있다.

## STOP conditions

- Step 0에서 테스트가 실패한다.
- Drift check에서 발췌와 실제 코드가 다르다.
- `mode`(`"plan"`/`"goal"`)를 읽어 동작을 가르는 코드가 나온다(예: `state.mode === "goal"`). 이 계획은 그런
  코드가 없다고 본다. 지우지 말고 보고한다.
- `ALTER TABLE workflow_state_revisions DROP COLUMN mode`가 테스트에서 실패한다(SQLite가 열이 다른 곳에
  쓰였다고 거절하는 경우). 표를 새로 만들어 옮기는 식으로 돌아가지 말고 보고한다.
- 저장된 JSON에 `mode` 키가 남아 있어 decode가 실패한다는 테스트 오류가 나온다.
- 범위 밖 파일(fixture `.sql`, 예전 migration, 예전 결정 항목)을 고쳐야만 통과한다.
- 같은 Verify가 두 번 고쳐도 실패한다.

## Maintenance notes

- **migration 순서**: 계획 029(lease 열)와 030(inbox 표)도 `migrations` 배열 끝에 원소를 더한다. 나중에
  병합하는 쪽이 충돌을 풀 때 두 원소를 모두 남기고, 먼저 병합된 것을 앞에 둔다. 이미 `main`에 들어간
  원소의 순서는 바꾸지 않는다.
- **`holder` 인자**: 계획 029가 `moveWorkflow`의 `holder` 인자를 지운다. `run-and-queue.test.ts`의 같은
  줄을 두 계획이 고치므로 충돌하면 두 변경을 모두 살린다(`holder` 없음, move는 `"goal"`).
- **예전 화면**: 열려 있던 예전 탭이 `move: "plan"`을 보내면 서버가 요청 schema에서 거절한다. 새로 고치면
  된다. 따로 처리하지 않는다.
- **되돌리기**: 이 migration이 적용된 DB는 이전 빌드가 열지 않는다(schema 버전이 빌드보다 높다고
  거절한다). 다른 migration과 같다.
- 검토자가 볼 것: `mode`를 지우면서 `Standing`을 만드는 다섯 곳의 다른 필드가 바뀌지 않았는지,
  `revisionStateSql`의 괄호가 맞는지, `decodedPhase`의 `Match.exhaustive`가 남아 있는지.
