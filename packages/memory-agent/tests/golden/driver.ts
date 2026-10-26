import { Effect, Fiber, FileSystem, Match, Path, Schema } from "effect";
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
import { goldenRows } from "./rows.ts";

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
   * child's notification reached a run that ended, and the agent agrees.
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
                WHERE r.run_id = n.delivered_to_run_id AND r.status <> 'running')) AS busy`,
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
  return {
    sessionId,
    settled,
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
    sendAndCancel: Effect.fnUntraced(function* (text: string) {
      const sending = yield* Effect.forkChild(deliver(text));
      yield* waitUntil(
        Effect.sync(
          () => provider?.adapter.invocations.some((call) => call.threadId === sessionId) ?? false,
        ),
        "the model to be asked",
        6_000,
      );
      yield* (yield* AgentChat).cancel(sessionId, null);
      yield* Fiber.join(sending).pipe(Effect.ignore);
      yield* settled;
    }),
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

/** Compare the conversation's rows with the stored golden file `name`. */
export const expectGolden = Effect.fnUntraced(function* (sessionId: string, name: string) {
  const { base } = yield* TestEnv;
  const rows = yield* goldenRows(sessionId, [[base, "<base>"]]);
  yield* sdk(() =>
    expect(`${JSON.stringify(rows, null, 2)}\n`).toMatchFileSnapshot(`./__golden__/${name}.json`),
  );
});
