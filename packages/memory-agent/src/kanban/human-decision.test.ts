import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, FileSystem, Option, Path, Result, Schema } from "effect";
import { expect } from "vite-plus/test";
import { freshSession, TestEnv, testAgent } from "../../tests/support/test-env.ts";
import { sqlAll, sqlGet, sqlRun } from "../../tests/support/sql.ts";
import { Projects } from "../projects/projects.ts";
import { Sessions } from "../sessions/sessions.ts";
import { Boards } from "../workflow/board.ts";
import { BoardAuthor } from "../workflow/card.ts";
import { Workflows } from "../workflow/workflow.ts";
import {
  type DecisionAsked,
  DecisionAnswer,
  DecisionCloseScope,
  DecisionKind,
  DecisionOccasion,
  DecisionState,
  goalDecisionCardId,
  HumanDecisionRefused,
  HumanDecisions,
} from "./human-decision.ts";

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

const orchestrator = BoardAuthor.cases.Orchestrator.make({ runId: "run-1" });
const uncertain: DecisionAsked = {
  occasion: DecisionOccasion.UncertainSideEffect({ runId: "card-run-1", attemptNo: 1 }),
  kind: DecisionKind.cases.UncertainSideEffect.make({
    runId: "card-run-1",
    toolNames: ["write_file"],
  }),
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
        ...uncertain,
        author: orchestrator,
      });
      expect(request.state).toEqual(DecisionState.Pending());
      expect(yield* cardStatus(sessionId, "a")).toBe("human_decision");
      // The same occasion is the same request; the card is not moved again.
      const again = yield* decisions.request({
        sessionId,
        goalInstanceId,
        cardId: "a",
        ...uncertain,
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
        factsSeq: request.factsSeq,
        answer: DecisionAnswer.cases.UncertainSideEffect.make({ choice: "stop" }),
      });
      expect(answered.state).toEqual(
        DecisionState.Answered({
          answer: DecisionAnswer.cases.UncertainSideEffect.make({ choice: "stop" }),
        }),
      );
      expect(yield* cardStatus(sessionId, "a")).toBe("blocked");
      const board = yield* (yield* Boards).view(sessionId);
      expect(board.cards.find(({ card }) => card.id === "a")?.lastChange?.author).toEqual(
        BoardAuthor.cases.User.make({}),
      );
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
        occasion: DecisionOccasion.RetryExhausted({ attemptNo: 3 }),
        kind: DecisionKind.cases.RetryExhausted.make({ attempts: 3 }),
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
          factsSeq: request.factsSeq,
          answer: DecisionAnswer.cases.RetryExhausted.make({ choice }),
          ...fields,
        });

      const misdirected = yield* Effect.forEach(
        [
          answer({ sessionId: other.sessionId }),
          answer({ goalInstanceId: other.goalInstanceId }),
          answer({ cardId: "b" }),
          answer({ requestId: "missing" }),
          answer({ answer: DecisionAnswer.cases.UncertainSideEffect.make({ choice: "continue" }) }),
        ],
        Effect.flip,
      );
      expect(
        misdirected.map((error) => (Schema.is(HumanDecisionRefused)(error) ? error.reason : error)),
      ).toEqual([
        "request_mismatch",
        "request_mismatch",
        "request_mismatch",
        "request_missing",
        "answer_invalid",
      ]);
      expect(yield* cardStatus(sessionId, "a")).toBe("human_decision");

      // Two different answers race: the stored one wins and the other is a conflict.
      const raced = yield* Effect.all([answer({}, "requeue"), answer({}, "stop")], {
        concurrency: "unbounded",
        mode: "result",
      });
      const winner = raced.findIndex(Result.isSuccess);
      expect(raced.filter(Result.isFailure)).toMatchObject([
        { failure: { reason: "answer_conflict" } },
      ]);
      const choice = winner === 0 ? "requeue" : "stop";
      expect((yield* answer({}, choice)).state).toEqual(
        DecisionState.Answered({ answer: DecisionAnswer.cases.RetryExhausted.make({ choice }) }),
      );
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
          ...uncertain,
          author: orchestrator,
        });
      const stopped = yield* request("a");
      const cancelled = yield* request("b");

      expect(
        yield* decisions.close(
          DecisionCloseScope.Card({ sessionId, goalInstanceId, cardId: "a" }),
          "card_stopped",
        ),
      ).toBe(1);
      expect(
        yield* decisions.close(
          DecisionCloseScope.Goal({ sessionId, goalInstanceId }),
          "orchestrator_cancelled",
        ),
      ).toBe(1);
      expect(yield* decisions.pending(sessionId)).toEqual([]);
      expect(
        (yield* decisions.forCard(sessionId, goalInstanceId, "a")).map((entry) => entry.state),
      ).toEqual([DecisionState.Closed({ reason: "card_stopped" })]);
      expect(Option.map(yield* decisions.get(cancelled.requestId), (entry) => entry.state)).toEqual(
        Option.some(DecisionState.Closed({ reason: "orchestrator_cancelled" })),
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
          factsSeq: stopped.factsSeq,
          answer: DecisionAnswer.cases.UncertainSideEffect.make({ choice: "continue" }),
        }),
      );
      expect(late).toBeInstanceOf(HumanDecisionRefused);
      expect(late).toMatchObject({ reason: "request_closed" });
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
        occasion: DecisionOccasion.ImpactUnclear({ fromVersion: 1, toVersion: 2 }),
        kind: DecisionKind.cases.ImpactUnclear.make({ fromGoalVersion: 1, toGoalVersion: 2 }),
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
          factsSeq: request.factsSeq,
          answer: DecisionAnswer.cases.ImpactUnclear.make({ choice: "continue" }),
        }),
      );
      expect(refused).toBeInstanceOf(HumanDecisionRefused);
      expect(refused).toMatchObject({ reason: "goal_superseded" });
      expect(Option.map(yield* decisions.get(request.requestId), (entry) => entry.state)).toEqual(
        Option.some(DecisionState.Closed({ reason: "goal_replaced" })),
      );
    }),
  );

  it.effect("keeps one request per occasion and adds the facts that changed while it waits", () =>
    Effect.gen(function* () {
      const decisions = yield* HumanDecisions;
      const { sessionId, goalInstanceId } = yield* boardSession();
      const ask = (prAvailable: boolean) =>
        decisions.request({
          sessionId,
          goalInstanceId,
          cardId: goalDecisionCardId,
          occasion: DecisionOccasion.ProtectedBranchMerge({ head: "abc" }),
          kind: DecisionKind.cases.ProtectedBranchMerge.make({ targetBranch: "main", prAvailable }),
          author: orchestrator,
        });
      const facts = (requestId: string) =>
        sqlAll(
          "SELECT seq FROM human_decision_facts WHERE execution_id = ? ORDER BY seq",
          requestId,
        );
      const [first, raced] = yield* Effect.all([ask(false), ask(false)], {
        concurrency: "unbounded",
      });
      expect(raced.requestId).toBe(first.requestId);
      expect(yield* ask(false)).toMatchObject({ factsSeq: 1, factsChanged: false });
      expect(yield* facts(first.requestId)).toEqual([{ seq: 1 }]);

      expect(yield* ask(true)).toMatchObject({
        requestId: first.requestId,
        factsSeq: 2,
        factsChanged: true,
        kind: { prAvailable: true },
      });
      const answer = (factsSeq: number) =>
        decisions.answer({
          sessionId,
          goalInstanceId,
          cardId: goalDecisionCardId,
          requestId: first.requestId,
          factsSeq,
          answer: DecisionAnswer.cases.ProtectedBranchMerge.make({ choice: "create_pr" }),
        });
      expect(yield* Effect.flip(answer(1))).toMatchObject({ reason: "facts_changed" });
      yield* answer(2);
      // The answer was for this occasion, so facts seen after it are not added.
      expect(yield* ask(false)).toMatchObject({ factsSeq: 2 });
      expect(yield* facts(first.requestId)).toEqual([{ seq: 1 }, { seq: 2 }]);
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
      const ask = (target: typeof first, cardId: string) =>
        decisions.request({ ...target, cardId, ...uncertain, author: orchestrator });

      const waiting = yield* ask(first, "a");
      const answered = yield* ask(first, "b");
      const other = yield* ask(second, "a");
      yield* ask(elsewhere, "a");
      yield* decisions.answer({
        ...first,
        cardId: "b",
        requestId: answered.requestId,
        factsSeq: answered.factsSeq,
        answer: DecisionAnswer.cases.UncertainSideEffect.make({ choice: "retry" }),
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
        occasion: DecisionOccasion.IntegrationConflict({ attemptNo: 1, answered: 0 }),
        kind: DecisionKind.cases.IntegrationConflict.make({ files: ["src/a.ts"] }),
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
            factsSeq: request.factsSeq,
            answer: DecisionAnswer.cases.IntegrationConflict.make({ choice: "resolved" }),
          });
          return {
            pending: pending.map((entry) => entry.requestId),
            answered: DecisionState.$is("Answered")(answered.state),
            card: yield* cardStatus(sessionId, "a"),
            execution: yield* executionStatus(request.requestId),
          };
        }),
      );
      expect(reopened).toEqual({
        pending: [request.requestId],
        answered: true,
        card: "verify",
        execution: { status: "completed" },
      });
    }),
  );
});
