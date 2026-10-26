import { Effect, Fiber, FileSystem, Match, Option, Path, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { Projects } from "../../src/projects/projects.ts";
import type { PermissionMode } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { chatClient, json, sdk } from "../support/chat-client.ts";
import { selectTestModel } from "../support/provider.ts";
import { sqlGet } from "../support/sql.ts";
import { TestEnv } from "../support/test-env.ts";
import { waitUntil } from "../support/wait-until.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { JsonValue } from "../../src/json.ts";
import { convertSchemaToJsonSchema, uiMessagesToWire } from "@tanstack/ai";
import { approvalToolDefinitions } from "../../src/tools/definitions.ts";
import { chatRoute } from "../support/chat-route.ts";
import { conversationRows, normalized } from "./rows.ts";

/**
 * How golden scenarios talk to the agent. Only this file knows the client; the migration replaces
 * the client here and keeps the scenarios and their stored rows.
 */

/** A database read, as conditions the scenarios wait for are. */
type Query = ReturnType<typeof sqlGet>;

const decodeRunState = Schema.decodeUnknownEffect(
  Schema.Struct({
    running: Schema.NullOr(Schema.Json),
    uncertainRuns: Schema.Array(Schema.Struct({ runId: Schema.String })),
  }),
);
const decodePending = Schema.decodeUnknownEffect(
  Schema.Struct({ run_id: Schema.String, interrupt_id: Schema.String }),
);
const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(JsonValue));
const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * A chat request written by hand, for what the page never sends. It is an empty turn of the
 * conversation with these fields on top.
 */
export interface HandWrittenTurn {
  readonly runId?: string;
  readonly parentRunId?: string;
  readonly resume?: ReadonlyArray<{
    readonly interruptId: string;
    readonly status: "resolved" | "cancelled";
    readonly payload?: JsonValue;
  }>;
  readonly messages?: ReadonlyArray<{
    readonly id: string;
    readonly role: "user";
    readonly content: string;
  }>;
}

/** What the agent answered: its status and body, or the events of an event stream. */
const answerOf = Effect.fnUntraced(function* (response: Response) {
  const text = yield* sdk(() => response.text());
  const parsed = (body: string): JsonValue => Option.getOrElse(decodeJsonText(body), () => body);
  const stream = response.headers.get("content-type")?.startsWith("text/event-stream") ?? false;
  const body = stream
    ? text.split("\n").flatMap((line) => (line.startsWith("data: ") ? [parsed(line.slice(6))] : []))
    : parsed(text);
  return { status: response.status, body };
});

/** A fresh conversation in the shared project, which is set to `mode` first. */
export const conversation = Effect.fnUntraced(function* (mode: PermissionMode = "ask") {
  const { project, provider } = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(path.join(project.root, "notes.txt"), "first line\nsecond line\n");
  yield* (yield* Projects).setPermissionMode(project.id, mode);
  yield* selectTestModel();
  const sessionId = (yield* (yield* Sessions).create(project.id)).id;
  // Like the page: the server owns the transcript and a turn sends only what it has not stored.
  // A restart replaces the agent, and the page reconnects with a new client.
  const page = { tab: yield* chatClient(sessionId, "page") };
  let handWrittenTurns = 0;
  /**
   * Send once the page has finished its last answer. A page that is still busy queues the message
   * instead of sending it, and the user would see it waiting.
   */
  const deliver = Effect.fnUntraced(function* (text: string) {
    yield* page.tab.until(() => !page.tab.client.getIsLoading(), "the page to be idle");
    yield* page.tab.send(text);
  });
  /** The agent's own view: it holds no live run or background turn for the conversation. */
  const idle = Effect.flatMap(TestEnv, (env) =>
    env.use(
      Effect.gen(function* () {
        const response = yield* (yield* AgentChat).status(sessionId, null);
        return (yield* decodeRunState(yield* json(response))).running === null;
      }),
    ),
  );
  /**
   * No run of the conversation or of its subagents is going, no child attempt is going, every
   * child's notification reached a run that ended, no steered message waits for the server to send
   * it, and the agent agrees.
   */
  const settled = waitUntil(
    Effect.zipWith(
      sqlGet(
        `SELECT
           (SELECT count(*) FROM chat_runs WHERE status = 'running' AND (thread_id = ?
              OR thread_id IN (SELECT 'subagent-' || id FROM subagents WHERE session_id = ?)))
           + (SELECT count(*) FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
              WHERE t.origin_session_id = ? AND a.status IN ('queued', 'running', 'waiting', 'blocked'))
           + (SELECT count(*) FROM parent_notifications n
              WHERE n.origin_session_id = ? AND NOT EXISTS (
                SELECT 1 FROM chat_runs r
                WHERE r.run_id = n.delivered_to_run_id AND r.status <> 'running'))
           + (SELECT count(*) FROM queued_messages
              WHERE session_id = ? AND state = 'waiting' AND steered = 1) AS busy`,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
      ),
      idle,
      (row, agentIdle) => Number(row?.["busy"] ?? 0) === 0 && agentIdle,
    ),
    "the conversation to settle",
    6_000,
  );
  /** Send a user message, run `meanwhile` once the model is answering it, then wait to settle. */
  const sendAnd = <E, R>(text: string, meanwhile: Effect.Effect<void, E, R>) =>
    Effect.gen(function* () {
      const sending = yield* Effect.forkChild(deliver(text));
      yield* waitUntil(
        Effect.sync(
          () => provider?.adapter.invocations.some((call) => call.threadId === sessionId) ?? false,
        ),
        "the model to be asked",
        6_000,
      );
      yield* meanwhile;
      yield* Fiber.join(sending).pipe(Effect.ignore);
      yield* settled;
    });
  /** Queue or steer a message as the page's composer does while a run is going. */
  const enqueue = (text: string, mode: "queue" | "steer") =>
    Effect.gen(function* () {
      const response = yield* (yield* AgentChat).enqueue(sessionId, null, {
        text,
        attachmentIds: [],
        mode,
      });
      yield* Effect.sync(() => expect(response.status).toBe(201));
    });
  return {
    sessionId,
    settled,
    /** The run and id of the conversation's one pending interrupt. */
    pendingInterrupt: Effect.flatMap(
      sqlGet(
        "SELECT run_id, interrupt_id FROM chat_interrupts WHERE thread_id = ? AND status = 'pending'",
        sessionId,
      ),
      decodePending,
    ),
    /** Post a chat request the page never sends; the run id is fresh unless `turn` names one. */
    handWritten: Effect.fnUntraced(function* (turn: HandWrittenTurn) {
      const agent = yield* AgentChat;
      // As the page's client builds it: the messages it holds and the tools it can approve.
      const body = yield* encodeJsonText({
        threadId: sessionId,
        runId: `${sessionId}:hand-written-${(handWrittenTurns += 1)}`,
        state: {},
        messages: uiMessagesToWire(page.tab.client.getMessages()),
        tools: approvalToolDefinitions.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: convertSchemaToJsonSchema(tool.inputSchema) ?? { type: "object" },
        })),
        context: [],
        forwardedProps: {},
        ...turn,
      });
      const request = new Request(`http://127.0.0.1/api/chat?session=${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return yield* answerOf(yield* chatRoute(agent, request, sessionId));
    }),
    /** Reconnect to a run's stream as a reloaded page does, with `query` and `headers`. */
    reconnect: Effect.fnUntraced(function* (
      query: string,
      headers: { readonly "X-Run-Id"?: string; readonly "Last-Event-ID"?: string } = {},
    ) {
      const agent = yield* AgentChat;
      const request = new Request(`http://127.0.0.1/api/chat?session=${sessionId}&${query}`, {
        headers,
      });
      return yield* answerOf(yield* chatRoute(agent, request, sessionId));
    }),
    /** Send a user message and wait for its run alone, leaving the children it started going. */
    post: Effect.fnUntraced(function* (text: string) {
      yield* deliver(text);
      yield* waitUntil(
        Effect.map(
          sqlGet(
            "SELECT count(*) AS runs FROM chat_runs WHERE thread_id = ? AND status = 'running'",
            sessionId,
          ),
          (row) => Number(row?.["runs"] ?? 0) === 0,
        ),
        "the run to end",
        6_000,
      );
    }),
    /** Send a user message and wait until the run it starts has ended or asks for approval. */
    send: Effect.fnUntraced(function* (text: string) {
      yield* deliver(text);
      yield* settled;
    }),
    /** Give the conversation an active Goal, so its runs are Goal runs. */
    goal: Effect.asVoid(
      Effect.flatMap(Workflows, (workflows) =>
        workflows.updateGoal(sessionId, {
          statement: "Keep the golden notes",
          outcomes: ["The notes are read and written"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          status: "active",
        }),
      ),
    ),
    /** Compact the conversation as the page's `/compact` does. */
    compact: Effect.gen(function* () {
      const response = yield* (yield* AgentChat).compact(sessionId, null);
      yield* Effect.sync(() => expect(response.status).toBe(200));
    }),
    /** Send a user message, then cancel the run once the model is answering it. */
    sendAndCancel: (text: string) =>
      sendAnd(
        text,
        Effect.asVoid(Effect.flatMap(AgentChat, (chat) => chat.cancel(sessionId, null))),
      ),
    /**
     * Send a user message and, once the model is answering it, queue `messages` behind it in order.
     * `answer` then lets the model go on.
     */
    sendAndQueue: (
      text: string,
      messages: ReadonlyArray<readonly [text: string, mode: "queue" | "steer"]>,
      answer: () => void,
    ) =>
      sendAnd(
        text,
        Effect.andThen(
          Effect.forEach(messages, ([queued, mode]) => enqueue(queued, mode), { discard: true }),
          Effect.sync(answer),
        ),
      ),
    /**
     * Send a user message and restart the agent once `running` holds. The page then reconnects to
     * the new agent.
     */
    restartDuring: Effect.fnUntraced(function* (
      text: string,
      running: Effect.Effect<boolean, Effect.Error<Query>, Effect.Services<Query>>,
      what: string,
    ) {
      const env = yield* TestEnv;
      const sending = yield* Effect.forkChild(deliver(text));
      yield* waitUntil(running, what, 6_000);
      yield* env.reopen;
      yield* Fiber.interrupt(sending);
      page.tab = yield* env.use(chatClient(sessionId, "page"));
    }),
    /** Continue past the runs whose outcome is unknown, as the page's notice lets the user do. */
    continuePastUncertain: Effect.gen(function* () {
      const env = yield* TestEnv;
      yield* env.use(
        Effect.gen(function* () {
          const chat = yield* AgentChat;
          const state = yield* decodeRunState(yield* json(yield* chat.status(sessionId, null)));
          const response = yield* chat.continuePastUncertain(sessionId, null, {
            runIds: state.uncertainRuns.map((run) => run.runId),
          });
          yield* Effect.sync(() => expect(response.status).toBe(200));
        }),
      );
    }),
    /** Answer every pending approval and permission review, then wait for the resumed run. */
    approve: Effect.fnUntraced(function* (approved: boolean) {
      yield* page.tab.pendingInterrupt;
      page.tab.client.resolveInterrupts((item) => {
        Match.value(item).pipe(
          Match.discriminatorsExhaustive("kind")({
            generic: (review) => review.resolveInterrupt({ approved }),
            "tool-approval": (tool) => tool.resolveInterrupt(approved),
          }),
        );
      });
      yield* page.tab.until(() => !page.tab.client.getIsLoading(), "the resumed run to end");
      yield* settled;
    }),
  };
});

/**
 * Compare `value` with the stored golden file `name`. `names` are the run's own values in it, such
 * as session ids, and the names they get there.
 */
export const matchGolden = Effect.fnUntraced(function* (
  name: string,
  value: JsonValue,
  names: ReadonlyArray<readonly [string, string]>,
) {
  const { base, project } = yield* TestEnv;
  const golden = normalized(value, [[base, "<base>"], ...names, [project.id, "<project>"]]);
  yield* sdk(() =>
    expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(`./__golden__/${name}.json`),
  );
});

/** Compare the conversation's rows with the stored golden file `name`. */
export const expectGolden = Effect.fnUntraced(function* (sessionId: string, name: string) {
  yield* matchGolden(name, yield* conversationRows(sessionId), [[sessionId, "<session>"]]);
});
