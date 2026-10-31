import { Effect, Match, Option, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  AgentChat,
  AppEvents,
  BoardAuthor,
  BoardEdit,
  type BoardIntent,
  Boards,
  DecisionCloseScope,
  ExternalAgents,
  HumanDecisions,
  KanbanBoardActions,
  KanbanOrchestrator,
  Projects,
  SessionLeases,
  Sessions,
  Workflows,
} from "memory-agent";
import { AppApi } from "memory-agent/app-api";
import { kanbanRefusal } from "../kanban-failures.ts";

/** A person changed the board from the page. */
const user = BoardAuthor.cases.User.make({});

/**
 * `AgentChat` refuses with what the page reads: a code, or a blocked lifecycle change. Its other
 * failures are errors; they become defects, which the server reports and answers 500.
 */
const refusalsOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (failure): failure is Extract<E, Error> => Predicate.isError(failure),
    (failure) => Effect.die(failure),
  );

/** The sessions group of `AppApi` (`/api/sessions/*`). */
export const SessionsApiHandlers = HttpApiBuilder.group(
  AppApi,
  "sessions",
  Effect.fn(function* (handlers) {
    const sessions = yield* Sessions;
    const projects = yield* Projects;
    const agents = yield* ExternalAgents;
    const events = yield* AppEvents;
    const decisions = yield* HumanDecisions;
    const orchestrator = yield* KanbanOrchestrator;
    const leases = yield* SessionLeases;
    const boards = yield* Boards;
    const workflows = yield* Workflows;
    const actions = yield* KanbanBoardActions;
    const chat = yield* AgentChat;

    /** Refuses a change while another page holds the session. */
    const checkHolder = (sessionId: string, holder: string | undefined) =>
      Effect.when(
        Effect.fail({ error: "session_in_use" } as const),
        Effect.map(leases.permits(sessionId, holder ?? null), (permitted) => !permitted),
      );

    /** Refuses an external agent the project has not configured, trusted and started. */
    const checkAgent = (projectId: string, external: string) =>
      projects.get(projectId).pipe(
        Effect.flatMap(agents.available),
        Effect.filterOrFail(
          (available) => available.includes(external),
          () => ({ error: "external_agent_unavailable" }) as const,
        ),
      );

    /** Closes a stopped card's decision, or wakes the loop of a closed Plan's board. */
    const followEdit = (session: string, edit: BoardEdit) =>
      Effect.gen(function* () {
        const goalInstanceId = yield* workflows.goalInstanceId(session);
        if (goalInstanceId === null) return;
        // A stopped card's decision is closed, not answered: nobody refused it.
        if (BoardEdit.guards.CancelCard(edit))
          yield* decisions.close(
            DecisionCloseScope.Card({ sessionId: session, goalInstanceId, cardId: edit.cardId }),
            "card_stopped",
          );
        // A closed Plan's board loop stops its cards and itself on its next look; wake it now.
        if (BoardEdit.guards.ClosePlan(edit)) yield* orchestrator.poke(goalInstanceId);
      });

    /** Carries out what a person meant by dragging a card; the board is told it changed. */
    const applyIntent = (session: string, intent: BoardIntent) =>
      actions
        .applyIntent(session, intent, user)
        .pipe(Effect.tap(() => events.publishSession(session, "run-state")));

    return handlers.handleAll({
      list: ({ query: { project, archived } }) =>
        Effect.orDie(sessions.list(project, archived === "1")),
      create: ({ payload: { projectId, title, agent } }) =>
        Effect.gen(function* () {
          yield* Option.match(Option.fromNullishOr(agent), {
            onNone: () => Effect.void,
            onSome: (external) => checkAgent(projectId, external),
          });
          const created = yield* sessions.create(projectId, title ?? null, agent ?? null);
          yield* events.publishProject(projectId, "sessions");
          return created;
        }).pipe(
          Effect.catchTag(
            "ProjectNotFound",
            () => Effect.fail({ error: "project_not_found" } as const),
            (failure) => Effect.die(failure),
          ),
        ),
      decisions: ({ params: { session } }) =>
        sessions.get(session).pipe(
          Effect.andThen(decisions.pending(session)),
          Effect.catchTags({
            SessionNotFound: kanbanRefusal.SessionNotFound,
            KanbanStorageFailed: kanbanRefusal.KanbanStorageFailed,
            WorkflowStorageError: kanbanRefusal.WorkflowStorageError,
            SqlError: kanbanRefusal.SqlError,
            SchemaError: kanbanRefusal.SchemaError,
          }),
        ),
      answerDecision: ({ params: { session, decision }, headers, payload }) =>
        checkHolder(session, headers["x-session-holder"]).pipe(
          Effect.andThen(decisions.answer({ ...payload, sessionId: session, requestId: decision })),
          // The answer moved the card; the board's loop takes it up now instead of at its next look.
          Effect.tap((answered) => orchestrator.poke(answered.goalInstanceId)),
          Effect.catchTags({
            HumanDecisionRefused: kanbanRefusal.HumanDecisionRefused,
            KanbanStorageFailed: kanbanRefusal.KanbanStorageFailed,
            WorkflowStorageError: kanbanRefusal.WorkflowStorageError,
          }),
        ),
      board: ({ params: { session } }) =>
        sessions.get(session).pipe(
          Effect.andThen(boards.view(session)),
          Effect.catchTags({
            SessionNotFound: kanbanRefusal.SessionNotFound,
            WorkflowStorageError: kanbanRefusal.WorkflowStorageError,
            SqlError: kanbanRefusal.SqlError,
            SchemaError: kanbanRefusal.SchemaError,
          }),
        ),
      editBoard: ({ params: { session }, headers, payload }) =>
        Effect.gen(function* () {
          yield* checkHolder(session, headers["x-session-holder"]);
          yield* sessions.get(session);
          const result = yield* workflows.editBoard(session, payload, user);
          yield* Effect.when(
            followEdit(session, payload),
            Effect.succeed(Predicate.isTagged(result, "Applied")),
          );
          yield* events.publishSession(session, "run-state");
          return result;
        }).pipe(
          Effect.catchTags({
            SessionNotFound: kanbanRefusal.SessionNotFound,
            BoardEditRefused: kanbanRefusal.BoardEditRefused,
            PlanDependenciesRejected: kanbanRefusal.PlanDependenciesRejected,
            KanbanStorageFailed: kanbanRefusal.KanbanStorageFailed,
            WorkflowStorageError: kanbanRefusal.WorkflowStorageError,
            PlatformError: kanbanRefusal.PlatformError,
            SqlError: kanbanRefusal.SqlError,
            SchemaError: kanbanRefusal.SchemaError,
          }),
        ),
      kanban: ({ params: { session } }) =>
        sessions.get(session).pipe(
          Effect.andThen(actions.view(session)),
          Effect.map(
            Option.match({
              onNone: () => ({ active: false }) as const,
              onSome: (board) => ({ active: true, ...board }) as const,
            }),
          ),
          Effect.catchTags({
            SessionNotFound: kanbanRefusal.SessionNotFound,
            KanbanStorageFailed: kanbanRefusal.KanbanStorageFailed,
            WorkflowStorageError: kanbanRefusal.WorkflowStorageError,
            GoalScheduleStorageFailed: kanbanRefusal.GoalScheduleStorageFailed,
            SqlError: kanbanRefusal.SqlError,
            SchemaError: kanbanRefusal.SchemaError,
          }),
        ),
      kanbanAction: ({ params: { session }, headers, payload }) =>
        checkHolder(session, headers["x-session-holder"]).pipe(
          Effect.andThen(sessions.get(session)),
          Effect.andThen(
            Match.valueTags(payload, {
              Start: () =>
                orchestrator
                  .start(session)
                  .pipe(Effect.tap(() => events.publishSession(session, "run-state"))),
              RestartLoop: () =>
                Effect.as(actions.restartLoop(session), { restarted: true } as const),
              SetDependencies: ({ dependsOn }) =>
                actions.setDependencies(session, dependsOn).pipe(
                  Effect.tap(() => events.publishSession(session, "run-state")),
                  Effect.map((dependsOn) => ({ dependsOn })),
                ),
              Reorder: (intent) => applyIntent(session, intent),
              Requeue: (intent) => applyIntent(session, intent),
              Hold: (intent) => applyIntent(session, intent),
              Release: (intent) => applyIntent(session, intent),
              ChangeRequest: (intent) => applyIntent(session, intent),
              Cancel: (intent) => applyIntent(session, intent),
              // The card lands on another conversation's board, so that board is told too.
              Transfer: (intent) =>
                applyIntent(session, intent).pipe(
                  Effect.tap(() => events.publishSession(intent.toSessionId, "run-state")),
                ),
            }),
          ),
          Effect.catchTags({
            ProjectNotFound: kanbanRefusal.ProjectNotFound,
            SessionNotFound: kanbanRefusal.SessionNotFound,
            BoardEditRefused: kanbanRefusal.BoardEditRefused,
            PlanDependenciesRejected: kanbanRefusal.PlanDependenciesRejected,
            KanbanActionRefused: kanbanRefusal.KanbanActionRefused,
            KanbanStartRefused: kanbanRefusal.KanbanStartRefused,
            GoalScheduleRefused: kanbanRefusal.GoalScheduleRefused,
            PersistedQueueItemsFailed: kanbanRefusal.PersistedQueueItemsFailed,
            CardWorktreeFailed: kanbanRefusal.CardWorktreeFailed,
            KanbanStorageFailed: kanbanRefusal.KanbanStorageFailed,
            WorkflowStorageError: kanbanRefusal.WorkflowStorageError,
            GoalScheduleStorageFailed: kanbanRefusal.GoalScheduleStorageFailed,
            PlatformError: kanbanRefusal.PlatformError,
            SqlError: kanbanRefusal.SqlError,
            SchemaError: kanbanRefusal.SchemaError,
          }),
        ),
      queue: ({ params: { session } }) => refusalsOnly(chat.queued(session)),
      enqueue: ({ params: { session }, headers, payload }) =>
        refusalsOnly(chat.enqueue(session, headers["x-session-holder"] ?? null, payload)).pipe(
          Effect.tap(() => events.publishSession(session, "queue")),
        ),
      editQueued: ({ params: { session, message }, headers, payload }) =>
        refusalsOnly(
          chat.editQueued(session, headers["x-session-holder"] ?? null, message, payload),
        ).pipe(Effect.tap(() => events.publishSession(session, "queue"))),
      subagents: ({ params: { session } }) => refusalsOnly(chat.subagents(session)),
      subagentTranscript: ({ params: { session, subagent } }) =>
        refusalsOnly(chat.subagentTranscript(session, subagent)),
      approvals: ({ params: { session } }) => refusalsOnly(chat.approvals(session)),
      answerApproval: ({ params: { session, approval }, headers, payload: { approved } }) =>
        refusalsOnly(
          chat.answerApproval(session, headers["x-session-holder"] ?? null, approval, approved),
        ).pipe(Effect.tap(() => events.publishSession(session, "relayed-approvals"))),
      status: ({ params: { session }, query: { holder } }) =>
        refusalsOnly(chat.status(session, holder ?? null)),
      change: ({ params: { session }, headers, payload }) =>
        Effect.gen(function* () {
          const holder = headers["x-session-holder"] ?? null;
          const { projectId } = yield* sessions.get(session);
          return yield* Match.valueTags(payload, {
            Archive: ({ archived, idempotencyKey }) =>
              chat
                .archive(session, holder, archived, idempotencyKey)
                .pipe(Effect.tap(() => events.publishProject(projectId, "sessions"))),
            Delete: ({ idempotencyKey }) =>
              chat
                .deleteSession(session, holder, idempotencyKey)
                .pipe(Effect.tap(() => events.publishProject(projectId, "sessions"))),
            Phase: ({ phase }) =>
              chat
                .setWorkflowPhase(session, holder, phase)
                .pipe(Effect.tap(() => events.publishSession(session, "run-state"))),
            Control: ({ workflowAction }) =>
              chat
                .controlWorkflow(session, holder, workflowAction)
                .pipe(Effect.tap(() => events.publishSession(session, "run-state"))),
          });
        }).pipe(
          Effect.catchTag("SessionNotFound", () =>
            Effect.fail({ error: "session_not_found" } as const),
          ),
          refusalsOnly,
        ),
      cancel: ({ params: { session }, headers }) =>
        refusalsOnly(chat.cancel(session, headers["x-session-holder"] ?? null)).pipe(
          Effect.tap(() => events.publishSession(session, "run-state")),
        ),
      compact: ({ params: { session }, headers }) =>
        refusalsOnly(chat.compact(session, headers["x-session-holder"] ?? null)),
      discardInterrupts: ({ params: { session }, headers }) =>
        refusalsOnly(chat.discardInterrupts(session, headers["x-session-holder"] ?? null)),
      continuePastUncertain: ({ params: { session }, headers, payload }) =>
        refusalsOnly(
          chat.continuePastUncertain(session, headers["x-session-holder"] ?? null, payload),
        ),
      lease: ({ params: { session }, payload: { holder, action } }) =>
        refusalsOnly(chat.lease(session, holder, action)).pipe(
          Effect.tap(() => events.publishSession(session, "run-state")),
        ),
    });
  }),
);
