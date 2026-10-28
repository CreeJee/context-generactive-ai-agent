import { Cause, Effect, FileSystem, Option, Result, Schedule, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import { Projects } from "../../src/projects/projects.ts";
import { SessionNotFound, Sessions } from "../../src/sessions/sessions.ts";
import { openPage } from "../support/chat-client.ts";
import { selectTestModel, turnGate } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

const Archived = Schema.Struct({ id: Schema.String, archivedAt: Schema.NullOr(Schema.String) });
const Running = Schema.Struct({ running: Schema.NullOr(Schema.Struct({ runId: Schema.String })) });

/** Poll an Effect until it holds, failing the test if it does not within six seconds. */
const until = Effect.fnUntraced(function* <E, R>(
  condition: Effect.Effect<boolean, E, R>,
  what: string,
) {
  const ready = yield* condition.pipe(
    Effect.repeat({ until: (value) => value, schedule: Schedule.spaced(20) }),
    Effect.timeoutOption(6_000),
  );
  expect(Option.isSome(ready), what).toBe(true);
});

const json = (response: Response) =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new Cause.UnknownError(cause),
  });

const archivedAt = (response: Response) =>
  Effect.map(
    Effect.flatMap(json(response), Schema.decodeUnknownEffect(Archived)),
    (body) => body.archivedAt,
  );

/** The session's model turns wait for a gate that never opens, so a run stays live until stopped. */
const gate = turnGate();

testAgent({ testProvider: { delayedTurnGate: gate.waitFor } })("archived conversations", (it) => {
  it.effect("leave the session list but stay in memory, and come back when restored", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const fs = yield* FileSystem.FileSystem;
      const sessions = yield* Sessions;
      // The session list is per project, so the test lists a project of its own.
      const project = yield* (yield* Projects).add(
        yield* fs.makeTempDirectory({ directory: env.base }),
      );
      const session = yield* sessions.create(project.id);
      const kept = yield* sessions.create(project.id, "kept");
      const node = yield* (yield* Nodes).append({
        projectId: project.id,
        sessionId: session.id,
        kind: "user",
        text: "배포는 화요일에만 하기로 했다",
      });
      yield* (yield* Indexer).indexAll();

      expect((yield* sessions.setArchived(session.id, true)).archivedAt).not.toBeNull();
      expect((yield* sessions.list(project.id)).map((item) => item.id)).toEqual([kept.id]);
      expect((yield* sessions.list(project.id, true)).map((item) => item.id)).toEqual([session.id]);
      const found = yield* (yield* MemorySearch).find({
        query: "배포 요일",
        projectId: project.id,
      });
      expect(found.matches.map((match) => match.id)).toContain(node.id);
      expect((yield* sessions.setArchived(session.id, false)).archivedAt).toBeNull();
      expect((yield* sessions.list(project.id)).map((item) => item.id).sort()).toEqual(
        [kept.id, session.id].sort(),
      );
      const missing = yield* Effect.result(sessions.setArchived("no-such-session", true));
      expect(Result.isFailure(missing) && missing.failure).toBeInstanceOf(SessionNotFound);
    }),
  );

  it.effect("respect another page's lease and safely stop a running answer before archive", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const session = (yield* (yield* Sessions).create(project.id)).id;
      yield* selectTestModel();
      const agent = yield* AgentChat;
      const archive = (holder: string | null, archived = true) =>
        agent.archive(session, holder, archived);

      yield* agent.lease(session, "tab-a", "claim");
      expect((yield* archive("tab-b")).status).toBe(423);

      // Tab A's page sends a turn in a fiber the test owns.
      const page = yield* openPage(session, "tab-a");
      yield* Effect.forkChild(page.send("please be slow"), { startImmediately: true });
      const running = Effect.flatMap(agent.status(session, "tab-a"), (response) =>
        Effect.map(
          Effect.flatMap(json(response), Schema.decodeUnknownEffect(Running)),
          (status) => status.running !== null,
        ),
      );
      yield* until(running, "the run to start");
      const done = yield* archive("tab-a");
      expect(done.status).toBe(200);
      yield* until(
        Effect.map(running, (value) => !value),
        "the run to stop",
      );
      expect(yield* archivedAt(done)).not.toBeNull();
      expect(yield* archivedAt(yield* archive("tab-a", false))).toBeNull();
    }),
  );
});
