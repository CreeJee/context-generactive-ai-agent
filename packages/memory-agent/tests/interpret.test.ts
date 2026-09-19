import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
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
const JobRow = Schema.Struct({ status: Schema.String, attempts: Schema.Number });

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

async function run<I, O>(tool: { execute?: (args: I) => O }, input: I) {
  if (!tool.execute) throw new Error("tool has no server implementation");
  return tool.execute(input);
}

async function setup() {
  const context = await testRuntime({ testProvider: {} });
  await context.provider!.select(context.runtime);
  const nodes = await context.runtime.runPromise(Nodes);
  const { sqlite } = await context.runtime.runPromise(Database);
  const say = (kind: "user" | "assistant", text: string) =>
    nodes.append({
      projectId: context.project.id,
      sessionId: context.session.id,
      kind,
      text,
    });
  const interpret = () =>
    context.runtime.runPromise(
      Effect.flatMap(Indexer, (indexer) => indexer.indexAll()).pipe(
        Effect.zipRight(Effect.flatMap(Interpreter, (interpreter) => interpreter.runPending)),
      ),
    );
  const edges = (kind: string) =>
    sqlite
      .prepare("SELECT from_id, to_id, kind FROM edges WHERE kind = ? AND origin = 'llm'")
      .all(kind)
      .map((row) => Schema.decodeUnknownSync(EdgeRow)(row));
  const job = (nodeId: string) =>
    Schema.decodeUnknownSync(JobRow)(
      sqlite.prepare("SELECT status, attempts FROM interpret_jobs WHERE node_id = ?").get(nodeId),
    );
  return { ...context, nodes, sqlite, say, interpret, edges, job };
}

describe("llm-interpret", () => {
  test("a clear correction links to the earlier decision and shows up in search and trace", async () => {
    const context = await setup();
    const decision = context.say("user", "DB는 SQLite로 간다 #database");
    context.say("assistant", "알겠습니다. SQLite로 진행할게요 #database");
    const change = context.say("user", "아니 Postgres로 바꾸자 [corrects:SQLite] #database");

    expect(await context.interpret()).toBe(3);

    // One topic per label in the project, linked from every statement about it.
    const topics = context.sqlite
      .prepare("SELECT id FROM nodes WHERE kind = 'topic' AND text = 'database'")
      .all();
    expect(topics).toHaveLength(1);
    expect(context.edges("about")).toHaveLength(3);
    expect(context.edges("corrects")).toEqual([
      { from_id: change.id, to_id: decision.id, kind: "corrects" },
    ]);
    expect(context.job(change.id)).toEqual({ status: "done", attempts: 1 });

    const found = await context.runtime.runPromise(
      Effect.flatMap(MemorySearch, (search) =>
        search.find({ query: "SQLite", projectId: context.project.id }),
      ),
    );
    const earlier = found.matches.find((match) => match.id === decision.id);
    expect(earlier?.supersededBy).toEqual([{ id: change.id, relation: "corrects" }]);
    expect(earlier?.projectName).toBe(context.project.name);
    expect(found.uninterpreted).toBe(0);

    const tools = (await context.runtime.runPromise(MemoryTools)).forProject(context.project.id);
    const trace = Schema.decodeUnknownSync(Trace)(
      await run(
        tools.find((tool) => tool.name === "trace_evidence")!,
        { id: decision.id },
      ),
    );
    expect(trace.challengedBy).toEqual([
      { ...trace.challengedBy[0], id: change.id, relation: "corrects", reason: "SQLite 관련" },
    ]);
  });

  test("an unclear correction is kept as a question, not an edge", async () => {
    const context = await setup();
    const decision = context.say("user", "캐시는 Redis로 하자");
    const vague = context.say("user", "그거 그냥 빼자 [maybe-retracts:Redis]");
    await context.interpret();

    expect(context.edges("retracts")).toEqual([]);
    const found = await context.runtime.runPromise(
      Effect.flatMap(MemorySearch, (search) =>
        search.find({ query: "Redis", projectId: context.project.id }),
      ),
    );
    const match = found.matches.find((entry) => entry.id === decision.id);
    expect(match?.supersededBy).toEqual([]);
    expect(match?.unconfirmedChallenges).toBe(1);

    const tools = (await context.runtime.runPromise(MemoryTools)).forProject(context.project.id);
    const trace = Schema.decodeUnknownSync(Trace)(
      await run(
        tools.find((tool) => tool.name === "trace_evidence")!,
        { id: decision.id },
      ),
    );
    expect(trace.unconfirmed).toEqual([
      { ...trace.unconfirmed[0], id: vague.id, possibleRelation: "retracts" },
    ]);
  });

  test("assistant words never correct anything, and only offered candidates can be linked", async () => {
    const context = await setup();
    context.say("user", "배포는 금요일에 한다");
    const claim = context.say("assistant", "사실 배포는 월요일이 맞습니다 [corrects:배포는]");
    const stray = context.say("user", "다른 이야기 [bad-target]");
    await context.interpret();

    expect(context.edges("corrects")).toEqual([]);
    expect(context.job(claim.id).status).toBe("done");
    expect(context.job(stray.id).status).toBe("done");
  });

  test("an unreadable answer is retried, then left failed without breaking search", async () => {
    const context = await setup();
    const broken = context.say("user", "이상한 문장 [broken-interpret]");
    for (let attempt = 0; attempt < 3; attempt++) await context.interpret();

    expect(context.job(broken.id)).toEqual({ status: "failed", attempts: 3 });
    const found = await context.runtime.runPromise(
      Effect.flatMap(MemorySearch, (search) =>
        search.find({ query: "이상한 문장", projectId: context.project.id }),
      ),
    );
    expect(found.matches.map((match) => match.id)).toContain(broken.id);
    expect(found.uninterpreted).toBe(1);
  });

  test("without a selected model nothing is interpreted and the jobs wait", async () => {
    const context = await testRuntime({ testProvider: {} });
    const nodes = await context.runtime.runPromise(Nodes);
    nodes.append({
      projectId: context.project.id,
      sessionId: context.session.id,
      kind: "user",
      text: "모델 없이",
    });
    expect(await context.runtime.runPromise(Effect.flatMap(Interpreter, (i) => i.runPending))).toBe(
      0,
    );
  });
});
