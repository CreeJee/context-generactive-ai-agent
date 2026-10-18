import { Cause, Effect, MutableHashMap, Option, Schema } from "effect";
import { AgentChat } from "../../src/agent/chat.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import type { ScriptedResponder } from "../../src/testing/scripted-adapter.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv } from "../support/test-env.ts";
import { sqlAll } from "../support/sql.ts";

/** The shared model answers each session from that session's own responder. */
const responders = MutableHashMap.empty<string, ScriptedResponder>();

export const responder: ScriptedResponder = (invocation) =>
  Option.match(MutableHashMap.get(responders, invocation.threadId ?? ""), {
    onNone: () => ({ text: "Hello from fast-1" }),
    onSome: (respond) => respond(invocation),
  });

export const goal = (statement: string) => ({
  statement,
  outcomes: [`${statement} holds`],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
});

/**
 * A fresh session with the test model selected. Everything goes through `env.use`, so the helpers
 * keep working after `env.reopen`.
 */
export const freshSession = Effect.fnUntraced(function* (respond?: ScriptedResponder) {
  const env = yield* TestEnv;
  const { id } = yield* env.use(
    Effect.flatMap(Sessions, (sessions) => sessions.create(env.project.id)),
  );
  if (respond !== undefined) {
    MutableHashMap.set(responders, id, respond);
    yield* Effect.addFinalizer(() => Effect.sync(() => MutableHashMap.remove(responders, id)));
  }
  yield* env.use(selectTestModel());
  return id;
});

/** A fresh session with an active Goal, so its chat turns run in a Goal worker. */
export const goalSession = Effect.fnUntraced(function* (
  statement: string,
  respond?: ScriptedResponder,
) {
  const env = yield* TestEnv;
  const id = yield* freshSession(respond);
  yield* env.use(
    Effect.flatMap(Workflows, (workflows) => workflows.updateGoal(id, goal(statement))),
  );
  return id;
});

const JsonText = Schema.fromJsonString(Schema.Unknown);

export const chatRequest = Effect.fnUntraced(function* (
  sessionId: string,
  runId: string,
  content = "hello",
): Effect.fn.Return<Request, Schema.SchemaError> {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: yield* Schema.encodeEffect(JsonText)({
      threadId: sessionId,
      runId,
      messages: [{ id: `${runId}-user`, role: "user", content }],
      tools: [],
      context: [],
    }),
  });
});

export const send = Effect.fnUntraced(function* (
  sessionId: string,
  runId: string,
  content?: string,
) {
  const env = yield* TestEnv;
  return yield* env.use(
    Effect.flatMap(AgentChat, (chat) =>
      Effect.flatMap(chatRequest(sessionId, runId, content), (request) =>
        chat.handle(request, sessionId),
      ),
    ),
  );
});

export const replay = Effect.fnUntraced(function* (
  sessionId: string,
  runId: string,
  lastEventId: string,
) {
  const env = yield* TestEnv;
  return yield* env.use(
    Effect.flatMap(AgentChat, (chat) =>
      chat.hydrate(
        new Request(`http://localhost/api/chat?runId=${runId}`, {
          headers: { "Last-Event-ID": lastEventId },
        }),
        sessionId,
      ),
    ),
  );
});

export const responseText = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new Cause.UnknownError(cause),
  });

export const responseJson = (response: Response) =>
  Effect.flatMap(
    responseText(response),
    Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown)),
  );

/** Rows of the open agent's database, read through `env.use` so they follow a reopen. */
export const rows = Effect.fnUntraced(function* (sql: string, ...parameters: string[]) {
  const env = yield* TestEnv;
  return yield* env.use(sqlAll(sql, ...parameters));
});

const sessionRuns = "SELECT run_id FROM workflow_run_bindings WHERE session_id = ?";

/** Every admission, dispatch, event, receipt, run and node one session owns. */
export const sessionEvidence = Effect.fnUntraced(function* (sessionId: string) {
  return {
    bindings: yield* rows("SELECT * FROM workflow_run_bindings WHERE session_id = ?", sessionId),
    dispatches: yield* rows(
      `SELECT * FROM workflow_worker_dispatches WHERE run_id IN (${sessionRuns})`,
      sessionId,
    ),
    events: yield* rows(
      `SELECT * FROM workflow_run_events WHERE run_id IN (${sessionRuns})`,
      sessionId,
    ),
    operations: yield* rows(
      `SELECT * FROM owner_rpc_operations WHERE run_id IN (${sessionRuns})`,
      sessionId,
    ),
    chatRuns: yield* rows("SELECT * FROM chat_runs WHERE thread_id = ?", sessionId),
    nodes: yield* rows("SELECT * FROM nodes WHERE session_id = ?", sessionId),
  };
});

/** Model calls the shared test provider received for one session. */
export const invocations = Effect.fnUntraced(function* (sessionId: string) {
  const { provider } = yield* TestEnv;
  return (provider?.adapter.invocations ?? []).filter(
    (invocation) => invocation.threadId === sessionId,
  );
});
