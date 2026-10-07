import { Cause, Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import { selectTestModel } from "./support/provider.ts";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { Interpreter } from "../src/memory/interpret.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MemorySearch } from "../src/memory/search.ts";
import { MemoryTools } from "../src/tools/memory.ts";
import { testRuntime } from "./support/runtime.ts";

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

const run = Effect.fn("interpret.run")(function* <I, O>(
  tool: { execute?: ((args: I) => O) | undefined },
  input: I,
) {
  const execute = tool.execute;
  if (execute === undefined)
    return yield* new Cause.UnknownError(new Error("tool has no server implementation"));
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(execute(input)),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});

const setup = Effect.fnUntraced(function* () {
  const context = yield* Effect.tryPromise({
    try: () => testRuntime({ testProvider: {} }),
    catch: (cause) => new Cause.UnknownError(cause),
  });
  yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
  const nodes = yield* Effect.provideContext(Nodes, yield* context.runtime.contextEffect);
  const { sqlite } = yield* Effect.provideContext(Database, yield* context.runtime.contextEffect);
  const say = (kind: "user" | "assistant", text: string) =>
    nodes.append({
      projectId: context.project.id,
      sessionId: context.session.id,
      kind,
      text,
    });
  const ownerContext = yield* context.runtime.contextEffect;
  const interpret = () =>
    Effect.flatMap(Indexer, (indexer) => indexer.indexAll()).pipe(
      Effect.andThen(Effect.flatMap(Interpreter, (interpreter) => interpreter.runPending)),
      Effect.provideContext(ownerContext),
    );
  const edges = (kind: string) =>
    Schema.decodeUnknownEffect(Schema.Array(EdgeRow))(
      sqlite
        .prepare("SELECT from_id, to_id, kind FROM edges WHERE kind = ? AND origin = 'llm'")
        .all(kind),
    );
  const job = (nodeId: string) =>
    Schema.decodeUnknownEffect(JobRow)(
      sqlite.prepare("SELECT status, attempts FROM interpret_jobs WHERE node_id = ?").get(nodeId),
    );
  return { ...context, nodes, sqlite, say, interpret, edges, job };
});

describe("llm-interpret", () => {
  it.live("a clear correction links to the earlier decision and shows up in search and trace", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      const decision = context.say("user", "DB는 SQLite로 간다 #database");
      context.say("assistant", "알겠습니다. SQLite로 진행할게요 #database");
      const change = context.say("user", "아니 Postgres로 바꾸자 [corrects:SQLite] #database");

      expect(yield* context.interpret()).toBe(3);

      // One topic per label in the project, linked from every statement about it.
      const topics = context.sqlite
        .prepare("SELECT id FROM nodes WHERE kind = 'topic' AND text = 'database'")
        .all();
      expect(topics).toHaveLength(1);
      expect(yield* context.edges("about")).toHaveLength(3);
      expect(yield* context.edges("corrects")).toEqual([
        { from_id: change.id, to_id: decision.id, kind: "corrects" },
      ]);
      expect(yield* context.job(change.id)).toEqual({ status: "done", attempts: 1 });

      const found = yield* Effect.provideContext(
        Effect.flatMap(MemorySearch, (search) =>
          search.find({ query: "SQLite", projectId: context.project.id }),
        ),
        yield* context.runtime.contextEffect,
      );
      const earlier = found.matches.find((match) => match.id === decision.id);
      expect(earlier?.supersededBy).toEqual([{ id: change.id, relation: "corrects" }]);
      expect(earlier?.projectName).toBe(context.project.name);
      expect(found.uninterpreted).toBe(0);

      const tools = (yield* Effect.provideContext(
        MemoryTools,
        yield* context.runtime.contextEffect,
      )).forProject(context.project.id);
      const trace = yield* Schema.decodeUnknownEffect(Trace)(
        yield* run(
          tools.find((tool) => tool.name === "trace_evidence")!,
          { id: decision.id },
        ),
      );
      expect(trace.challengedBy).toEqual([
        { ...trace.challengedBy[0], id: change.id, relation: "corrects", reason: "SQLite 관련" },
      ]);
    }),
  );

  it.live("an unclear correction is kept as a question, not an edge", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      const decision = context.say("user", "캐시는 Redis로 하자");
      const vague = context.say("user", "그거 그냥 빼자 [maybe-retracts:Redis]");
      yield* context.interpret();

      expect(yield* context.edges("retracts")).toEqual([]);
      const found = yield* Effect.provideContext(
        Effect.flatMap(MemorySearch, (search) =>
          search.find({ query: "Redis", projectId: context.project.id }),
        ),
        yield* context.runtime.contextEffect,
      );
      const match = found.matches.find((entry) => entry.id === decision.id);
      expect(match?.supersededBy).toEqual([]);
      expect(match?.unconfirmedChallenges).toBe(1);

      const tools = (yield* Effect.provideContext(
        MemoryTools,
        yield* context.runtime.contextEffect,
      )).forProject(context.project.id);
      const trace = yield* Schema.decodeUnknownEffect(Trace)(
        yield* run(
          tools.find((tool) => tool.name === "trace_evidence")!,
          { id: decision.id },
        ),
      );
      expect(trace.unconfirmed).toEqual([
        { ...trace.unconfirmed[0], id: vague.id, possibleRelation: "retracts" },
      ]);
    }),
  );

  it.live("assistant words never correct anything, and only offered candidates can be linked", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      context.say("user", "배포는 금요일에 한다");
      const claim = context.say("assistant", "사실 배포는 월요일이 맞습니다 [corrects:배포는]");
      const stray = context.say("user", "다른 이야기 [bad-target]");
      yield* context.interpret();

      expect(yield* context.edges("corrects")).toEqual([]);
      expect((yield* context.job(claim.id)).status).toBe("done");
      expect((yield* context.job(stray.id)).status).toBe("done");
    }),
  );

  it.live("an unreadable answer is retried, then left failed without breaking search", () =>
    Effect.gen(function* () {
      const context = yield* setup();
      const broken = context.say("user", "이상한 문장 [broken-interpret]");
      for (let attempt = 0; attempt < 3; attempt++) yield* context.interpret();

      expect(yield* context.job(broken.id)).toEqual({ status: "failed", attempts: 3 });
      const found = yield* Effect.provideContext(
        Effect.flatMap(MemorySearch, (search) =>
          search.find({ query: "이상한 문장", projectId: context.project.id }),
        ),
        yield* context.runtime.contextEffect,
      );
      expect(found.matches.map((match) => match.id)).toContain(broken.id);
      expect(found.uninterpreted).toBe(1);
    }),
  );

  it.live("without a selected model nothing is interpreted and the jobs wait", () =>
    Effect.gen(function* () {
      const context = yield* Effect.tryPromise({
        try: () => testRuntime({ testProvider: {} }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const nodes = yield* Effect.provideContext(Nodes, yield* context.runtime.contextEffect);
      nodes.append({
        projectId: context.project.id,
        sessionId: context.session.id,
        kind: "user",
        text: "모델 없이",
      });
      expect(
        yield* Effect.provideContext(
          Effect.flatMap(Interpreter, (i) => i.runPending),
          yield* context.runtime.contextEffect,
        ),
      ).toBe(0);
    }),
  );
});
