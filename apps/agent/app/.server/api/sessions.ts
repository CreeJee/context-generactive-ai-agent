import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  AppEvents,
  ExternalAgents,
  HumanDecisions,
  KanbanOrchestrator,
  Projects,
  SessionLeases,
  Sessions,
} from "memory-agent";
import { AppApi } from "memory-agent/app-api";
import { kanbanRefusal } from "../kanban-failures.ts";

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
          Effect.catchTag("ProjectNotFound", kanbanRefusal.ProjectNotFound, (failure) =>
            Effect.die(failure),
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
    });
  }),
);
