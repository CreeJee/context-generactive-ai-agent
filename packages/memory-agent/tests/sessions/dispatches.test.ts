import { Effect, FileSystem, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Projects, SessionDispatch, SessionDispatches, Sessions } from "memory-agent";
import { callTool, failureCode } from "../support/run-tools.ts";
import { sqlGet, sqlRun } from "../support/sql.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

const decodeDispatch = Schema.decodeUnknownSync(SessionDispatch);
/** The `notify_session` tool of one run, bound like chat.ts binds it. */
const notifyToolFor = (projectId: string, sessionId: string) =>
  Effect.map(SessionDispatches, (dispatches) =>
    dispatches.notifyToolFor(projectId, sessionId, "run-1"),
  );

const rowsFor = (toSessionId: string) =>
  sqlGet("SELECT count(*) AS rows FROM session_dispatches WHERE to_session_id = ?", toSessionId);

testAgent()(function (it) {
  it.effect("a call stores a waiting dispatch for a chat conversation of the project", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { project, session } = env;
      const other = yield* env.use(
        Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)),
      );
      const tools = yield* env.use(notifyToolFor(project.id, session.id));
      expect(
        yield* callTool([tools], "notify_session", { toSession: other.id, body: "hello" }),
      ).toEqual(
        expect.objectContaining({
          toSessionId: other.id,
          fromSessionId: session.id,
          fromRunId: "run-1",
          body: "hello",
          state: "waiting",
        }),
      );
      expect(
        yield* sqlGet(
          "SELECT body, state, project_id, from_session_id, from_run_id, to_session_id, delivered_run_id, delivered_at FROM session_dispatches WHERE to_session_id = ?",
          other.id,
        ),
      ).toEqual({
        body: "hello",
        state: "waiting",
        project_id: project.id,
        from_session_id: session.id,
        from_run_id: "run-1",
        to_session_id: other.id,
        delivered_run_id: null,
        delivered_at: null,
      });
    }),
  );

  it.effect("the model's call is validated by the tool's schema", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { project, session } = env;
      const other = yield* env.use(
        Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)),
      );
      const tools = yield* env.use(notifyToolFor(project.id, session.id));
      // An overlong body fails the schema and writes nothing.
      const tooLong = yield* Effect.flip(
        callTool([tools], "notify_session", { toSession: other.id, body: "x".repeat(8_001) }),
      );
      expect(tooLong).toBeInstanceOf(Schema.SchemaError);
      expect(yield* rowsFor(other.id)).toEqual({ rows: 0 });
    }),
  );

  it.effect("a call to itself is refused", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { project, session } = env;
      const tools = yield* env.use(notifyToolFor(project.id, session.id));
      expect(
        yield* failureCode(
          callTool([tools], "notify_session", { toSession: session.id, body: "hi" }),
        ),
      ).toBe("notify_self_target");
      expect(yield* rowsFor(session.id)).toEqual({ rows: 0 });
    }),
  );

  it.effect("a conversation of another project is refused", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { session } = env;
      const foreign = yield* env.use(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${env.base}/foreign`, { recursive: true });
          const other = yield* Effect.flatMap(Projects, (projects) =>
            projects.add(`${env.base}/foreign`),
          );
          return yield* Effect.flatMap(Sessions, (sessions) => sessions.create(other.id));
        }),
      );
      const tools = yield* env.use(notifyToolFor(env.project.id, session.id));
      expect(
        yield* failureCode(
          callTool([tools], "notify_session", { toSession: foreign.id, body: "hi" }),
        ),
      ).toBe("notify_other_project");
      expect(yield* rowsFor(foreign.id)).toEqual({ rows: 0 });
    }),
  );

  it.effect("a session id nothing has is refused", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { project, session } = env;
      const tools = yield* env.use(notifyToolFor(project.id, session.id));
      expect(
        yield* failureCode(
          callTool([tools], "notify_session", { toSession: "no-such-session", body: "hi" }),
        ),
      ).toBe("notify_unknown_target");
      expect(yield* rowsFor("no-such-session")).toEqual({ rows: 0 });
    }),
  );

  it.effect("a report conversation is refused", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { project, session } = env;
      const report = yield* env.use(
        Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)),
      );
      yield* sqlRun(
        "INSERT INTO report_sessions (report_session_id, source_session_id, project_id, created_at) VALUES (?, ?, ?, '2026-01-01')",
        report.id,
        session.id,
        project.id,
      );
      const tools = yield* env.use(notifyToolFor(project.id, session.id));
      expect(
        yield* failureCode(
          callTool([tools], "notify_session", { toSession: report.id, body: "hi" }),
        ),
      ).toBe("notify_report_target");
      expect(yield* rowsFor(report.id)).toEqual({ rows: 0 });
    }),
  );

  it.effect("a BTW thread id is refused like any unknown target", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { project, session } = env;
      const tools = yield* env.use(notifyToolFor(project.id, session.id));
      expect(
        yield* failureCode(
          callTool([tools], "notify_session", { toSession: "btw-not-a-session", body: "hi" }),
        ),
      ).toBe("notify_unknown_target");
      expect(yield* rowsFor("btw-not-a-session")).toEqual({ rows: 0 });
    }),
  );

  it.effect("a stored dispatch survives the agent closing and opening again", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { project, session } = env;
      const other = yield* env.use(
        Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)),
      );
      const before = decodeDispatch(
        yield* env.use(
          Effect.flatMap(notifyToolFor(project.id, session.id), (tools) =>
            callTool([tools], "notify_session", { toSession: other.id, body: "persist" }),
          ),
        ),
      );
      yield* env.reopen;
      expect(
        yield* sqlGet(
          "SELECT id, state, body FROM session_dispatches WHERE to_session_id = ?",
          other.id,
        ),
      ).toEqual({ id: before.id, state: "waiting", body: "persist" });
      // The reopened agent's own service reads the same row.
      expect(
        yield* env.use(
          Effect.map(
            Effect.flatMap(SessionDispatches, (dispatches) => dispatches.pending(other.id)),
            (found) => found.map(({ id, body, state }) => ({ id, body, state })),
          ),
        ),
      ).toEqual([{ id: before.id, body: "persist", state: "waiting" }]);
    }),
  );

  it.effect("deliver marks a waiting dispatch with the run that delivered it", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { project, session } = env;
      const other = yield* env.use(
        Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)),
      );
      const stored = decodeDispatch(
        yield* env.use(
          Effect.flatMap(notifyToolFor(project.id, session.id), (tools) =>
            callTool([tools], "notify_session", { toSession: other.id, body: "later" }),
          ),
        ),
      );
      yield* env.use(
        Effect.flatMap(SessionDispatches, (dispatches) =>
          dispatches.deliver(other.id, "run-2", [stored.id]),
        ),
      );
      expect(
        yield* sqlGet(
          "SELECT state, delivered_run_id FROM session_dispatches WHERE id = ?",
          stored.id,
        ),
      ).toEqual({ state: "delivered", delivered_run_id: "run-2" });
      expect(
        yield* env.use(
          Effect.map(
            Effect.flatMap(SessionDispatches, (dispatches) => dispatches.pending(other.id)),
            (found) => found.length,
          ),
        ),
      ).toBe(0);
    }),
  );
});
