import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chat } from "@tanstack/ai";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import type * as NativeArtifact from "../../src/agent/native-artifact-entry.ts";
import { ChatState } from "../../src/chat-state/chat-state.ts";
import { SecretStore } from "../../src/config/secrets.ts";
import { Database } from "../../src/db/database.ts";
import { memoryAgentLayer } from "../../src/layers.ts";
import { Embedder } from "../../src/memory/embedding/embedder.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { fakeVector } from "../../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../../src/testing/fake-morph.ts";
import { ScriptedTextAdapter } from "../../src/testing/scripted-adapter.ts";

const [base, artifactPath, phase] = Schema.decodeUnknownSync(
  Schema.Tuple([
    Schema.NonEmptyString,
    Schema.NonEmptyString,
    Schema.Literals(["first", "second"]),
  ]),
)(process.argv.slice(2));
assert.equal(existsSync(join(base, "src")), false);
assert.equal(existsSync(join(base, "storage", "agent.db")), phase === "second");
const home = join(base, "home");
const projectRoot = join(base, "project");
mkdirSync(home, { recursive: true });
mkdirSync(projectRoot, { recursive: true });
assert.equal(process.env.HOME, home);
const counts = { acquired: 0, released: 0 };
const runtime = ManagedRuntime.make(
  memoryAgentLayer(join(base, "storage"), {
    embedder: Layer.effect(
      Embedder,
      Effect.acquireRelease(
        Effect.sync(() => {
          counts.acquired++;
          return {
            identity: "fake-trigram-64",
            dimensions: 64,
            embed: (texts: readonly string[]) => Effect.succeed(texts.map(fakeVector)),
            runtime: () => ({ kind: "other" as const }),
          };
        }),
        () =>
          Effect.sync(() => {
            counts.released++;
          }),
      ),
    ),
    morphAnalyzer: fakeMorphLayer,
    secrets: SecretStore.memory,
    interpretAutomatically: false,
    summarizeAutomatically: false,
    importsWatching: false,
    sweepSecrets: false,
    skillsHome: home,
    skillsBuiltin: join(base, "builtin-skills"),
    importsHome: home,
  }),
);
const Snapshot = Schema.Struct({
  projectId: Schema.String,
  sessionId: Schema.String,
  nodes: Schema.String,
  run: Schema.String,
  thread: Schema.String,
  pid: Schema.Finite,
});
let sqlite: Database["Service"]["sqlite"] | undefined;
let verifiedOld = false;
try {
  const services = await runtime.runPromise(
    Effect.gen(function* () {
      return { nodes: yield* Nodes, db: yield* Database, state: yield* ChatState };
    }),
  );
  sqlite = services.db.sqlite;
  const previous =
    phase === "second"
      ? Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))(
          readFileSync(join(base, "snapshot.json"), "utf8"),
        )
      : undefined;
  const binding =
    previous ??
    (await runtime.runPromise(
      Effect.gen(function* () {
        const project = yield* (yield* Projects).add(projectRoot);
        const session = yield* (yield* Sessions).create(project.id);
        return { projectId: project.id, sessionId: session.id };
      }),
    ));
  const oldNodes = () =>
    JSON.stringify(
      services.nodes
        .session(binding.sessionId)
        .filter((node) => node.runId === "first" || node.text === "first"),
    );
  const oldRun = async () =>
    JSON.stringify(await services.state.persistence.stores.runs.get("first"));
  if (previous) {
    assert.notEqual(previous.pid, process.pid);
    assert.equal(oldNodes(), previous.nodes);
    assert.equal(await oldRun(), previous.run);
    assert.equal(
      JSON.stringify(
        await services.state.persistence.stores.messages.loadThread(binding.sessionId),
      ),
      previous.thread,
    );
    verifiedOld = true;
  }
  // Explicit NEW SDK turn, never replay/resume the first run or claim Goal admission.
  const artifact: typeof NativeArtifact = await import(pathToFileURL(artifactPath).href);
  const user = services.nodes.append({ ...binding, kind: "user", text: phase });
  const recording = await runtime.runPromise(
    artifact.makeRecordingMiddleware({ ...binding, runId: phase, userNodeId: user.id }),
  );
  const middleware: [...ReturnType<typeof services.state.middleware>, typeof recording] = [
    ...services.state.middleware(),
    recording,
  ];
  await chat({
    adapter: new ScriptedTextAdapter([{ text: phase }]),
    messages: [{ role: "user", content: phase }],
    threadId: binding.sessionId,
    runId: phase,
    middleware,
    stream: false,
  });
  const rows = services.nodes
    .session(binding.sessionId)
    .filter((node) => node.kind === "assistant" && node.runId === phase);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.text, phase);
  const current = await services.state.persistence.stores.runs.get(phase);
  assert.equal(current?.status, "completed");
  assert.equal(current?.threadId, binding.sessionId);
  if (previous) {
    assert.equal(oldNodes(), previous.nodes);
    assert.equal(await oldRun(), previous.run);
  } else {
    writeFileSync(
      join(base, "snapshot.json"),
      JSON.stringify({
        ...binding,
        nodes: oldNodes(),
        run: await oldRun(),
        thread: JSON.stringify(
          await services.state.persistence.stores.messages.loadThread(binding.sessionId),
        ),
        pid: process.pid,
      }),
    );
  }
  assert.deepEqual(counts, { acquired: 1, released: 0 });
} finally {
  await runtime.dispose();
}
assert.deepEqual(counts, { acquired: 1, released: 1 });
assert.ok(sqlite);
assert.throws(() => sqlite.prepare("SELECT 1"));
writeFileSync(
  join(base, `${phase}.json`),
  JSON.stringify({ ...counts, sqliteClosed: true, pid: process.pid, verifiedOld }),
);
