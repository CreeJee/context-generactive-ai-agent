import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chat } from "@tanstack/ai";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import type * as NativeArtifact from "../../src/agent/native-artifact-entry.ts";
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

const [base, a, b] = Schema.decodeUnknownSync(
  Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString, Schema.NonEmptyString]),
)(process.argv.slice(2));
assert.equal(existsSync(join(base, "src")), false);
assert.equal(existsSync(join(base, "storage", "agent.db")), false);
const home = join(base, "home");
const projectRoot = join(base, "project");
mkdirSync(home);
mkdirSync(projectRoot);
const counts = { acquired: 0, released: 0 };
// Fresh child services over a new test DB, NOT reopening/adopting a prior central owner.
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
let sqlite: Database["Service"]["sqlite"] | undefined;
try {
  const services = await runtime.runPromise(
    Effect.gen(function* () {
      const project = yield* (yield* Projects).add(projectRoot);
      const session = yield* (yield* Sessions).create(project.id);
      return { project, session, nodes: yield* Nodes, db: yield* Database };
    }),
  );
  sqlite = services.db.sqlite;
  for (const [runId, path, prefix] of [
    ["a-first", a, ""],
    ["b", b, "copied-B:"],
    ["a-next", a, ""],
  ] as const) {
    const artifact: typeof NativeArtifact = await import(pathToFileURL(path).href);
    assert.deepEqual(
      Object.keys(artifact).sort(),
      [
        "createMemoryTools",
        "createSubscriptionRuntimeImplementation",
        "makePermissionGateMiddleware",
        "makeRecordingMiddleware",
      ].sort(),
    );
    const user = services.nodes.append({
      projectId: services.project.id,
      sessionId: services.session.id,
      kind: "user",
      text: runId,
    });
    const recording = await runtime.runPromise(
      artifact.makeRecordingMiddleware({
        projectId: services.project.id,
        sessionId: services.session.id,
        runId,
        userNodeId: user.id,
      }),
    );
    await chat({
      adapter: new ScriptedTextAdapter([{ text: runId }]),
      messages: [{ role: "user", content: runId }],
      runId,
      middleware: [recording],
      stream: false,
    });
    const rows = services.nodes
      .session(services.session.id)
      .filter((node) => node.kind === "assistant" && node.runId === runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.text, `${prefix}${runId}`);
    assert.equal(counts.acquired, 1);
    assert.equal(counts.released, 0);
  }
} finally {
  await runtime.dispose();
}
assert.deepEqual(counts, { acquired: 1, released: 1 });
assert.ok(sqlite);
assert.throws(() => sqlite.prepare("SELECT 1"));
writeFileSync(
  join(base, "result.json"),
  JSON.stringify({ ...counts, sqliteClosed: true, pid: process.pid }),
);
