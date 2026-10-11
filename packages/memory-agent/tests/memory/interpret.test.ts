import { Cause, Effect, FileSystem, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Database } from "../../src/db/database.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Interpretations } from "../../src/memory/interpretations.ts";
import { Interpreter } from "../../src/memory/interpret.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { MemoryTools } from "../../src/tools/memory.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

const EdgeRow = Schema.Struct({
  from_id: Schema.String,
  to_id: Schema.String,
  kind: Schema.String,
});
const JobRow = Schema.Struct({ status: Schema.String, attempts: Schema.Finite });

const Trace = Schema.Struct({
  challengedBy: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      relation: Schema.String,
      reason: Schema.NullOr(Schema.String),
    }),
  ),
  unconfirmed: Schema.Array(
    Schema.Struct({ id: Schema.String, possibleRelation: Schema.String, reason: Schema.String }),
  ),
});

const call = <A>(execute: () => A) =>
  Effect.tryPromise({
    try: () => Promise.resolve(execute()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

/**
 * A fresh project in the shared agent. Topics, search results and uninterpreted counts are
 * project-wide, so each test reads only its own.
 */
const freshProject = Effect.gen(function* () {
  const env = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const project = yield* (yield* Projects).add(
    yield* fs.makeTempDirectory({ directory: env.base }),
  );
  const session = yield* (yield* Sessions).create(project.id);
  const nodes = yield* Nodes;
  const { sqlite } = yield* Database;
  const say = (kind: "user" | "assistant", text: string) =>
    nodes.append({ projectId: project.id, sessionId: session.id, kind, text });
  const edges = (kind: string) =>
    Schema.decodeUnknownEffect(Schema.Array(EdgeRow))(
      sqlite
        .prepare(
          `SELECT e.from_id, e.to_id, e.kind FROM edges e JOIN nodes n ON n.id = e.from_id
           WHERE e.kind = ? AND e.origin = 'llm' AND n.project_id = ?`,
        )
        .all(kind, project.id),
    );
  const job = (nodeId: string) =>
    Schema.decodeUnknownEffect(JobRow)(
      sqlite.prepare("SELECT status, attempts FROM interpret_jobs WHERE node_id = ?").get(nodeId),
    );
  const find = (query: string) =>
    Effect.flatMap(MemorySearch, (search) => search.find({ query, projectId: project.id }));
  const trace = Effect.fnUntraced(function* (id: string) {
    const tools = (yield* MemoryTools).forProject(project.id);
    return yield* Schema.decodeUnknownEffect(Trace)(
      yield* call(() => tools.find((tool) => tool.name === "trace_evidence")!.execute!({ id })),
    );
  });
  return { project, sqlite, say, edges, job, find, trace };
});

const interpret = Effect.flatMap(Indexer, (indexer) => indexer.indexAll()).pipe(
  Effect.andThen(Effect.flatMap(Interpreter, (interpreter) => interpreter.runPending)),
);

testAgent({ testProvider: {} })("llm-interpret", (it) => {
  it.effect(
    "a clear correction links to the earlier decision and shows up in search and trace",
    () =>
      Effect.gen(function* () {
        yield* selectTestModel();
        const context = yield* freshProject;
        const decision = context.say("user", "DB는 SQLite로 간다 #database");
        context.say("assistant", "알겠습니다. SQLite로 진행할게요 #database");
        const change = context.say("user", "아니 Postgres로 바꾸자 [corrects:SQLite] #database");

        expect(yield* interpret).toBe(3);

        // One topic per label in the project, linked from every statement about it.
        const topics = context.sqlite
          .prepare(
            "SELECT id FROM nodes WHERE kind = 'topic' AND text = 'database' AND project_id = ?",
          )
          .all(context.project.id);
        expect(topics).toHaveLength(1);
        expect(yield* context.edges("about")).toHaveLength(3);
        expect(yield* context.edges("corrects")).toEqual([
          { from_id: change.id, to_id: decision.id, kind: "corrects" },
        ]);
        expect(yield* context.job(change.id)).toEqual({ status: "done", attempts: 1 });

        const found = yield* context.find("SQLite");
        const earlier = found.matches.find((match) => match.id === decision.id);
        expect(earlier?.supersededBy).toEqual([{ id: change.id, relation: "corrects" }]);
        expect(earlier?.projectName).toBe(context.project.name);
        expect(found.uninterpreted).toBe(0);

        const trace = yield* context.trace(decision.id);
        expect(trace.challengedBy).toEqual([
          { ...trace.challengedBy[0], id: change.id, relation: "corrects", reason: "SQLite 관련" },
        ]);
      }),
  );

  it.effect("an unclear correction is kept as a question, not an edge", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const context = yield* freshProject;
      const decision = context.say("user", "캐시는 Redis로 하자");
      const vague = context.say("user", "그거 그냥 빼자 [maybe-retracts:Redis]");
      yield* interpret;

      expect(yield* context.edges("retracts")).toEqual([]);
      const match = (yield* context.find("Redis")).matches.find(
        (entry) => entry.id === decision.id,
      );
      expect(match?.supersededBy).toEqual([]);
      expect(match?.unconfirmedChallenges).toBe(1);

      const trace = yield* context.trace(decision.id);
      expect(trace.unconfirmed).toEqual([
        { ...trace.unconfirmed[0], id: vague.id, possibleRelation: "retracts" },
      ]);
    }),
  );

  it.effect(
    "assistant words never correct anything, and only offered candidates can be linked",
    () =>
      Effect.gen(function* () {
        yield* selectTestModel();
        const context = yield* freshProject;
        context.say("user", "배포는 금요일에 한다");
        const claim = context.say("assistant", "사실 배포는 월요일이 맞습니다 [corrects:배포는]");
        const stray = context.say("user", "다른 이야기 [bad-target]");
        yield* interpret;

        expect(yield* context.edges("corrects")).toEqual([]);
        expect((yield* context.job(claim.id)).status).toBe("done");
        expect((yield* context.job(stray.id)).status).toBe("done");
      }),
  );

  it.effect("an unreadable answer is retried, then left failed without breaking search", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const context = yield* freshProject;
      const broken = context.say("user", "이상한 문장 [broken-interpret]");
      yield* Effect.repeat(interpret, { times: 2 });

      expect(yield* context.job(broken.id)).toEqual({ status: "failed", attempts: 3 });
      const found = yield* context.find("이상한 문장");
      expect(found.matches.map((match) => match.id)).toContain(broken.id);
      expect(found.uninterpreted).toBe(1);
    }),
  );
});

// Selecting a model is global configuration, so the unselected agent is its own.
testAgent({ testProvider: {} })("interpretation without a model", (it) => {
  it.effect("without a selected model nothing is interpreted and the jobs wait", () =>
    Effect.gen(function* () {
      const { project, session } = yield* TestEnv;
      (yield* Nodes).append({
        projectId: project.id,
        sessionId: session.id,
        kind: "user",
        text: "모델 없이",
      });
      expect(yield* (yield* Interpreter).runPending).toBe(0);
    }),
  );

  it.effect("new empty nodes create no interpretation jobs or semantic edges", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const session = yield* (yield* Sessions).create(project.id);
      const nodes = yield* Nodes;
      const indexer = yield* Indexer;
      const { sqlite } = yield* Database;
      // Earlier tests' nodes are indexed first, so the count below is only this test's.
      yield* indexer.indexAll();
      const meaningful = nodes.append({
        projectId: project.id,
        sessionId: session.id,
        kind: "user",
        text: "SQLite",
      });
      const empty = nodes.append({
        projectId: project.id,
        sessionId: session.id,
        kind: "assistant",
        text: " \n",
      });
      (yield* Interpretations).record({
        nodeId: empty.id,
        targetId: meaningful.id,
        kind: "related",
        status: "applied",
        reason: "invalid",
        model: "test",
      });
      expect(
        sqlite.prepare("SELECT * FROM interpret_jobs WHERE node_id = ?").get(empty.id),
      ).toBeUndefined();
      expect(
        sqlite.prepare("SELECT * FROM interpretations WHERE node_id = ?").all(empty.id),
      ).toEqual([]);
      expect(yield* indexer.indexAll()).toBe(1);
    }),
  );
});
