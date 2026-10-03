import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { memoryAgentLayer } from "memory-agent";
import { expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { OwnerNativeBuild } from "../src/agent/owner-native-build.ts";
import { SecretStore } from "../src/config/secrets.ts";
import { Database } from "../src/db/database.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../src/testing/fake-morph.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const Registration = Schema.Array(
  Schema.Struct({
    goal_instance_id: Schema.String,
    artifact_url: Schema.String,
    artifact_hash: Schema.String,
    source_hash: Schema.String,
  }),
);

test("real native changed-source builds isolate simultaneous Goals and retain V1 after reopen", async () => {
  const previousNative = process.env.CONTEXT_AGENT_NATIVE_ARTIFACT;
  const previousWorker = process.env.CONTEXT_AGENT_GOAL_WORKER;
  process.env.CONTEXT_AGENT_NATIVE_ARTIFACT = "1";
  process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
  let releaseFirst = () => {};
  let startedFirst = () => {};
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const started = new Promise<void>((resolve) => {
    startedFirst = resolve;
  });
  let calls = 0;
  const context = await testRuntime({
    testProvider: {
      responder: async () => {
        if (calls++ === 0) {
          startedFirst();
          await held;
        }
        return { text: "actual native isolation answer" };
      },
    },
  });
  await context.runtime.dispose();
  const entry = join(context.base, "controlled-native-entry.ts");
  const observations = join(context.base, "native-observations.jsonl");
  writeFileSync(observations, "");
  const productionEntry = fileURLToPath(
    new URL("../src/agent/native-artifact-entry.ts", import.meta.url),
  );
  const source = (version: string) => `
import { appendFileSync } from "node:fs";
import { Effect } from "effect";
import { makeRecordingMiddleware as original } from ${JSON.stringify(productionEntry)};
export { makePermissionGateMiddleware, createMemoryTools, createSubscriptionRuntimeImplementation } from ${JSON.stringify(productionEntry)};
export const makeRecordingMiddleware = Effect.fnUntraced(function* (binding) {
  appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ run: binding.runId, version: ${JSON.stringify(version)} }) + "\\n");
  return yield* original(binding);
});
`;
  writeFileSync(entry, source("V1"));
  const open = () =>
    ManagedRuntime.make(
      memoryAgentLayer(context.storage, {
        embedder: fakeEmbedderLayer,
        morphAnalyzer: fakeMorphLayer,
        secrets: SecretStore.memory,
        providerRegistry: context.provider!.layer,
        interpretAutomatically: false,
        summarizeAutomatically: false,
        skillsHome: context.home,
        skillsBuiltin: join(context.base, "builtin-skills"),
        importsHome: context.home,
        importsWatching: false,
        sweepSecrets: false,
      }).pipe(Layer.provide(Layer.succeed(OwnerNativeBuild, { entry }))),
    );
  let runtime = open();
  try {
    await context.provider!.select(runtime);
    const owner = await runtime.runPromise(
      Effect.all({ db: Database, sessions: Sessions, workflows: Workflows }),
    );
    const second = await runtime.runPromise(owner.sessions.create(context.project.id));
    for (const session of [context.session.id, second.id])
      await runtime.runPromise(
        owner.workflows.updateGoal(session, {
          statement: "Native source isolation",
          outcomes: ["Pin native source per Goal"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          status: "active",
        }),
      );
    const send = async (session: string, run: string) => {
      const response = await runtime.runPromise(
        Effect.flatMap(AgentChat, (chat) =>
          chat.handle(
            new Request("http://localhost/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                threadId: session,
                runId: run,
                messages: [{ id: run, role: "user", content: "hello" }],
                tools: [],
                context: [],
              }),
            }),
            session,
          ),
        ),
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("RUN_ERROR");
      expect(text).toContain("actual native isolation answer");
    };
    const first = send(context.session.id, "isolation-v1-held");
    await started;
    writeFileSync(entry, source("V2"));
    await send(second.id, "isolation-v2");
    releaseFirst();
    await first;
    await send(context.session.id, "isolation-v1-followup");
    const registrations = (db: Database["Service"]) =>
      Schema.decodeUnknownSync(Registration)(
        db.sqlite
          .prepare(
            "SELECT goal_instance_id, artifact_url, artifact_hash, source_hash FROM workflow_goal_native_artifacts ORDER BY goal_instance_id",
          )
          .all(),
      );
    const before = registrations(owner.db);
    expect(before).toHaveLength(2);
    expect(before[0]!.artifact_hash).not.toBe(before[1]!.artifact_hash);
    expect(before[0]!.source_hash).not.toBe(before[1]!.source_hash);
    for (const registration of before)
      expect(
        createHash("sha256")
          .update(readFileSync(fileURLToPath(registration.artifact_url)))
          .digest("hex"),
      ).toBe(registration.artifact_hash);
    await runtime.dispose();
    runtime = open();
    await send(context.session.id, "isolation-v1-reopened");
    expect(registrations(await runtime.runPromise(Database))).toEqual(before);
    const seen = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ run: Schema.String, version: Schema.String })),
    )(
      readFileSync(observations, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
    expect(seen).toEqual([
      { run: "isolation-v1-held", version: "V1" },
      { run: "isolation-v2", version: "V2" },
      { run: "isolation-v1-followup", version: "V1" },
      { run: "isolation-v1-reopened", version: "V1" },
    ]);
    const links = await runtime.runPromise(
      Effect.map(Database, (db) =>
        db.sqlite
          .prepare(
            "SELECT run_id FROM workflow_run_bindings b JOIN workflow_goal_native_artifacts a USING(goal_instance_id) WHERE run_id LIKE 'isolation-%'",
          )
          .all(),
      ),
    );
    expect(links).toHaveLength(4);
  } finally {
    releaseFirst();
    await runtime.dispose();
    if (previousNative === undefined) delete process.env.CONTEXT_AGENT_NATIVE_ARTIFACT;
    else process.env.CONTEXT_AGENT_NATIVE_ARTIFACT = previousNative;
    if (previousWorker === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
    else process.env.CONTEXT_AGENT_GOAL_WORKER = previousWorker;
  }
}, 60000);
