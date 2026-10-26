import { Effect, Fiber, FileSystem, Match, Path } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { Projects } from "../../src/projects/projects.ts";
import type { PermissionMode } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { chatClient, sdk } from "../support/chat-client.ts";
import { selectTestModel } from "../support/provider.ts";
import { sqlGet } from "../support/sql.ts";
import { TestEnv } from "../support/test-env.ts";
import { waitUntil } from "../support/wait-until.ts";
import { goldenRows } from "./rows.ts";

/**
 * How golden scenarios talk to the agent. Only this file knows the client; the migration replaces
 * the client here and keeps the scenarios and their stored rows.
 */

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
  const tab = yield* chatClient(sessionId, "page");
  /**
   * No run of the conversation or of its subagents is going, no child attempt is going, and every
   * child's notification reached a run that ended.
   */
  const settled = waitUntil(
    Effect.map(
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
      (row) => Number(row?.["busy"] ?? 0) === 0,
    ),
    "the conversation to settle",
    6_000,
  );
  return {
    sessionId,
    tab,
    settled,
    /** Send a user message and wait for its run alone, leaving the children it started going. */
    post: Effect.fnUntraced(function* (text: string) {
      yield* tab.send(text);
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
      yield* tab.send(text);
      yield* settled;
    }),
    /** Compact the conversation as the page's `/compact` does. */
    compact: Effect.gen(function* () {
      const response = yield* (yield* AgentChat).compact(sessionId, null);
      yield* Effect.sync(() => expect(response.status).toBe(200));
    }),
    /** Send a user message, then cancel the run once the model is answering it. */
    sendAndCancel: Effect.fnUntraced(function* (text: string) {
      const sending = yield* Effect.forkChild(tab.send(text));
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
    /** Answer every pending approval and permission review, then wait for the resumed run. */
    approve: Effect.fnUntraced(function* (approved: boolean) {
      yield* tab.pendingInterrupt;
      tab.client.resolveInterrupts((item) => {
        Match.value(item).pipe(
          Match.discriminatorsExhaustive("kind")({
            generic: (review) => review.resolveInterrupt({ approved }),
            "tool-approval": (tool) => tool.resolveInterrupt(approved),
          }),
        );
      });
      yield* tab.until(() => !tab.client.getIsLoading(), "the resumed run to end");
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
