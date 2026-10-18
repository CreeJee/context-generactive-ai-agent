import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, FileSystem, Option, Path } from "effect";
import { expect } from "vite-plus/test";
import { freshSession, TestEnv, testAgent } from "../../tests/support/test-env.ts";
import { sqlGet, sqlRun } from "../../tests/support/sql.ts";
import { Projects } from "../projects/projects.ts";
import { Sessions } from "../sessions/sessions.ts";
import { Boards } from "../workflow/board.ts";
import { Workflows } from "../workflow/workflow.ts";
import { HumanDecisions, type DecisionKind } from "./human-decision.ts";

const goal = {
  statement: "Run a Goal as a board",
  outcomes: ["Cards wait for people"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

const step = (id: string) => ({
  id,
  title: `Card ${id}`,
  description: id,
  dependsOn: [],
  acceptanceCriteria: [],
  ruleRefs: [],
});

const orchestrator = { _tag: "Orchestrator", runId: "run-1" } as const;
const uncertain: DecisionKind = {
  _tag: "UncertainSideEffect",
  runId: "card-run-1",
  toolNames: ["write_file"],
};

/** A session whose Goal has cards `a` and `b`, both ready. */
const boardSession = (sessionId?: string) =>
  Effect.gen(function* () {
    const id = sessionId ?? (yield* freshSession);
    const workflows = yield* Workflows;
    yield* workflows.updateGoal(id, goal);
    yield* workflows.updatePlan(
      id,
      {
        summary: "Board",
        steps: [step("a"), step("b")],
        risks: [],
        openQuestions: [],
        status: "ready",
      },
      orchestrator,
    );
    const goalInstanceId = yield* workflows.goalInstanceId(id);
    if (goalInstanceId === null) return yield* Effect.die("the Goal has no instance");
    return { sessionId: id, goalInstanceId };
  });

const cardStatus = (sessionId: string, cardId: string) =>
  Effect.map(
    Workflows.use((workflows) => workflows.get(sessionId)),
    (state) => state.plan?.steps.find((step) => step.id === cardId)?.status,
  );

const executionStatus = (requestId: string) =>
  sqlGet("SELECT status FROM owner_workflow_executions WHERE execution_id = ?", requestId);

testAgent()("human decisions", (it) => {
  it.effect("moves the card on request and on the answer, as the user", () =>
    Effect.gen(function* () {
      const decisions = yield* HumanDecisions;
      const { sessionId, goalInstanceId } = yield* boardSession();
      const request = yield* decisions.request({
        sessionId,
        goalInstanceId,
        cardId: "a",
        key: "attempt-1",
        kind: uncertain,
        author: orchestrator,
      });
      expect(request.state).toEqual({ _tag: "Pending" });
      expect(yield* cardStatus(sessionId, "a")).toBe("human_decision");
      // The same key is the same request; the card is not moved again.
      const again = yield* decisions.request({
        sessionId,
        goalInstanceId,
        cardId: "a",
        key: "attempt-1",
        kind: uncertain,
        author: orchestrator,
      });
      expect(again.requestId).toBe(request.requestId);
      expect((yield* decisions.pending(sessionId)).map((entry) => entry.requestId)).toEqual([
        request.requestId,
      ]);

      const answered = yield* decisions.answer({
        sessionId,
        goalInstanceId,
        cardId: "a",
        requestId: request.requestId,
        answer: { _tag: "UncertainSideEffect", choice: "stop" },
      });
      expect(answered.state).toEqual({
        _tag: "Answered",
        answer: { _tag: "UncertainSideEffect", choice: "stop" },
      });
      expect(yield* cardStatus(sessionId, "a")).toBe("blocked");
      const board = yield* (yield* Boards).view(sessionId);
      expect(board.cards.find(({ card }) => card.id === "a")?.lastChange?.author).toEqual({
        _tag: "User",
      });
      expect(yield* decisions.pending(sessionId)).toEqual([]);
      expect(yield* executionStatus(request.requestId)).toEqual({ status: "completed" });
    }),
  );

  it.effect("accepts the same answer again and refuses a different or misdirected one", () =>
    Effect.gen(function* () {
      const decisions = yield* HumanDecisions;
      const { sessionId, goalInstanceId } = yield* boardSession();
      const other = yield* boardSession();
      const request = yield* decisions.request({
        sessionId,
        goalInstanceId,
        cardId: "a",
        key: "k",
        kind: { _tag: "RetryExhausted", attempts: 3 },
        author: orchestrator,
      });
      const answer = (
        fields: Partial<Parameters<typeof decisions.answer>[0]>,
        choice: "requeue" | "stop" = "requeue",
      ) =>
        decisions.answer({
          sessionId,
          goalInstanceId,
          cardId: "a",
          requestId: request.requestId,
          answer: { _tag: "RetryExhausted", choice },
          ...fields,
        });

      const misdirected = yield* Effect.forEach(
        [
          answer({ sessionId: other.sessionId }),
          answer({ goalInstanceId: other.goalInstanceId }),
          answer({ cardId: "b" }),
          answer({ requestId: "missing" }),
          answer({ answer: { _tag: "UncertainSideEffect", choice: "continue" } }),
        ],
        Effect.flip,
      );
      expect(misdirected).toMatchObject(
        [
          "request_mismatch",
          "request_mismatch",
          "request_mismatch",
          "request_missing",
          "answer_invalid",
        ].map((reason) => ({ _tag: "HumanDecisionRefused", reason })),
      );
      expect(yield* cardStatus(sessionId, "a")).toBe("human_decision");

      // Two different answers race: the stored one wins and the other is a conflict.
      const raced = yield* Effect.all([answer({}, "requeue"), answer({}, "stop")], {
        concurrency: "unbounded",
        mode: "result",
      });
      const winner = raced.findIndex((result) => result._tag === "Success");
      expect(raced.filter((result) => result._tag === "Failure")).toMatchObject([
        { failure: { reason: "answer_conflict" } },
      ]);
      const choice = winner === 0 ? "requeue" : "stop";
      expect((yield* answer({}, choice)).state).toEqual({
        _tag: "Answered",
        answer: { _tag: "RetryExhausted", choice },
      });
      expect(yield* cardStatus(sessionId, "a")).toBe(choice === "requeue" ? "ready" : "blocked");
    }),
  );

  it.effect("closes waits by interrupting them, not by refusing the decision", () =>
    Effect.gen(function* () {
      const decisions = yield* HumanDecisions;
      const { sessionId, goalInstanceId } = yield* boardSession();
      const request = (cardId: string) =>
        decisions.request({
          sessionId,
          goalInstanceId,
          cardId,
          key: "k",
          kind: uncertain,
          author: orchestrator,
        });
      const stopped = yield* request("a");
      const cancelled = yield* request("b");

      expect(
        yield* decisions.close(
          { _tag: "Card", sessionId, goalInstanceId, cardId: "a" },
          "card_stopped",
        ),
      ).toBe(1);
      expect(
        yield* decisions.close(
          { _tag: "Goal", sessionId, goalInstanceId },
          "orchestrator_cancelled",
        ),
      ).toBe(1);
      expect(yield* decisions.pending(sessionId)).toEqual([]);
      expect(
        (yield* decisions.forCard(sessionId, goalInstanceId, "a")).map((entry) => entry.state),
      ).toEqual([{ _tag: "Closed", reason: "card_stopped" }]);
      expect(Option.map(yield* decisions.get(cancelled.requestId), (entry) => entry.state)).toEqual(
        Option.some({ _tag: "Closed", reason: "orchestrator_cancelled" }),
      );
      expect(yield* executionStatus(stopped.requestId)).toEqual({ status: "interrupted" });
      // The card keeps waiting for whoever stopped it; no answer moved it.
      expect(yield* cardStatus(sessionId, "a")).toBe("human_decision");
      const late = yield* Effect.flip(
        decisions.answer({
          sessionId,
          goalInstanceId,
          cardId: "a",
          requestId: stopped.requestId,
          answer: { _tag: "UncertainSideEffect", choice: "continue" },
        }),
      );
      expect(late).toMatchObject({ _tag: "HumanDecisionRefused", reason: "request_closed" });
    }),
  );

  it.effect("closes the wait of a replaced Goal when it is answered", () =>
    Effect.gen(function* () {
      const decisions = yield* HumanDecisions;
      const { sessionId, goalInstanceId } = yield* boardSession();
      const request = yield* decisions.request({
        sessionId,
        goalInstanceId,
        cardId: "a",
        key: "k",
        kind: { _tag: "ImpactUnclear", fromGoalVersion: 1, toGoalVersion: 2 },
        author: orchestrator,
      });
      yield* sqlRun(
        "INSERT INTO workflow_goal_instances VALUES ('next-goal', ?, 'now')",
        sessionId,
      );
      yield* sqlRun(
        "UPDATE workflow_goal_identities SET goal_instance_id = 'next-goal', created_at = 'now' WHERE session_id = ?",
        sessionId,
      );

      expect(yield* decisions.pending(sessionId)).toEqual([]);
      const refused = yield* Effect.flip(
        decisions.answer({
          sessionId,
          goalInstanceId,
          cardId: "a",
          requestId: request.requestId,
          answer: { _tag: "ImpactUnclear", choice: "continue" },
        }),
      );
      expect(refused).toMatchObject({ _tag: "HumanDecisionRefused", reason: "goal_superseded" });
      expect(Option.map(yield* decisions.get(request.requestId), (entry) => entry.state)).toEqual(
        Option.some({ _tag: "Closed", reason: "goal_replaced" }),
      );
    }),
  );

  it.effect("gathers the unanswered requests of every Goal in the project", () =>
    Effect.gen(function* () {
      const decisions = yield* HumanDecisions;
      const env = yield* TestEnv;
      const root = (yield* Path.Path).join(env.base, "inbox-project");
      yield* (yield* FileSystem.FileSystem).makeDirectory(root);
      const project = yield* (yield* Projects).add(root);
      const sessions = yield* Sessions;
      const sessionIn = Effect.map(sessions.create(project.id), (session) => session.id);
      const first = yield* boardSession(yield* sessionIn);
      const second = yield* boardSession(yield* sessionIn);
      const elsewhere = yield* boardSession();
      const ask = (target: typeof first, cardId: string, key = "k") =>
        decisions.request({ ...target, cardId, key, kind: uncertain, author: orchestrator });

      const waiting = yield* ask(first, "a");
      const answered = yield* ask(first, "b");
      const other = yield* ask(second, "a");
      yield* ask(elsewhere, "a");
      yield* decisions.answer({
        ...first,
        cardId: "b",
        requestId: answered.requestId,
        answer: { _tag: "UncertainSideEffect", choice: "retry" },
      });

      const inbox = yield* decisions.inbox(project.id);
      expect(inbox.map((item) => [item.requestId, item.cardTitle])).toEqual([
        [waiting.requestId, "Card a"],
        [other.requestId, "Card a"],
      ]);
      expect(new Set(inbox.map((item) => item.goalInstanceId))).toEqual(
        new Set([first.goalInstanceId, second.goalInstanceId]),
      );
    }).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])),
  );
});

testAgent()("human decisions across a restart", (it) => {
  it.effect("restores the wait and takes its answer after the agent reopens", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { sessionId, goalInstanceId } = yield* boardSession();
      const request = yield* (yield* HumanDecisions).request({
        sessionId,
        goalInstanceId,
        cardId: "a",
        key: "k",
        kind: { _tag: "IntegrationConflict", files: ["src/a.ts"] },
        author: orchestrator,
      });
      yield* env.reopen;

      const reopened = yield* env.use(
        Effect.gen(function* () {
          const decisions = yield* HumanDecisions;
          const pending = yield* decisions.pending(sessionId);
          const answered = yield* decisions.answer({
            sessionId,
            goalInstanceId,
            cardId: "a",
            requestId: request.requestId,
            answer: { _tag: "IntegrationConflict", choice: "resolved" },
          });
          return {
            pending: pending.map((entry) => entry.requestId),
            state: answered.state._tag,
            card: yield* cardStatus(sessionId, "a"),
            execution: yield* executionStatus(request.requestId),
          };
        }),
      );
      expect(reopened).toEqual({
        pending: [request.requestId],
        state: "Answered",
        card: "verify",
        execution: { status: "completed" },
      });
    }),
  );
});
