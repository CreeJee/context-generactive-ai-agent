const sdkCall = Effect.fn("sourceGeneration.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
import {
  Cause,
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Schema,
} from "effect";
import { it } from "@effect/vitest";
import { withTestPlatform } from "./support/platform.ts";
import { Sessions } from "memory-agent";
import { expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { selectTestModel, turnGate } from "./support/provider.ts";
import { testRuntime } from "./support/runtime.ts";

const goal = {
  statement: "Keep execution code pinned independently of revisions",
  outcomes: ["Separate real SDK loops retain their source generations"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};
const Pin = Schema.Struct({
  goal_instance_id: Schema.String,
  source_generation: Schema.String,
  manifest_hash: Schema.String,
  worker_url: Schema.String,
});
const plan = {
  summary: "Preserve execution assets while revising the method",
  steps: [
    {
      id: "pin",
      title: "Pin",
      description: "Keep source identity",
      dependsOn: [],
      acceptanceCriteria: ["Old code remains available"],
      ruleRefs: [],
    },
  ],
  risks: [],
  openQuestions: [],
  status: "ready" as const,
};
const Binding = Schema.Struct({
  goal_instance_id: Schema.String,
  goal_version: Schema.Finite,
  plan_version: Schema.NullOr(Schema.Finite),
});
const Dispatch = Schema.Struct({ generation: Schema.String });
const request = Effect.fn("sourceGeneration.request")(function* (sessionId: string, runId: string) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      threadId: sessionId,
      runId,
      messages: [{ id: `user-${runId}`, role: "user", content: `hello ${runId}` }],
      tools: [],
      context: [],
    }),
  });
});

for (const damage of ["missing", "tampered"] as const) {
  it.live(
    `real SDK Goal code pins survive source edits/reopen and reject ${damage} snapshots before admission`,
    () =>
      Effect.gen(function* () {
        let workerEnabled = true;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const withWorkerFlag = Effect.fn("sourceGeneration.withWorkerFlag")(function* <A, E, R>(
          program: Effect.Effect<A, E, R>,
        ) {
          const services = yield* Layer.build(
            ConfigProvider.layerAdd(
              ConfigProvider.fromUnknown({ CONTEXT_AGENT_GOAL_WORKER: workerEnabled ? "1" : "0" }),
              { asPrimary: true },
            ),
          );
          return yield* Effect.provideContext(program, services);
        });
        const directory = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "agent-chat-source-test-" }),
        );
        const sourceDirectory = new URL("../src/agent/", import.meta.url);
        for (const name of ["full-loop-worker.ts", "full-loop-codec.ts", "full-loop-rpc-client.ts"])
          yield* fs.copyFile(
            yield* path.fromFileUrl(new URL(name, sourceDirectory)),
            path.join(directory, name),
          );
        const workerFile = path.join(directory, "full-loop-worker.ts");
        const original = yield* fs.readFileString(workerFile);
        const emission = 'parent.postMessage({ type: "chunk", chunk });';
        expect(original.split(emission)).toHaveLength(2);
        // Only the owned source fixture changes. The marker is attached at the actual SDK
        // loop emission, not fabricated by the scripted provider or owner adapter.
        const version = Effect.fn("sourceGeneration.version")(function* (marker: string) {
          return yield* fs.writeFileString(
            workerFile,
            original.replace(
              emission,
              `if (chunk.type === "TEXT_MESSAGE_CONTENT") chunk.delta = "[${marker}]" + chunk.delta;\n    ${emission}`,
            ),
          );
        });
        yield* version("loop-v1");
        const gate = turnGate();
        const modelStarted = yield* Deferred.make<void>();
        let calls = 0;
        const context = yield* sdkCall(() =>
          testRuntime({
            goalWorker: { assets: { sourceDirectory: directory, temporaryDirectory: directory } },
            testProvider: {
              responder: () => {
                calls++;
                if (calls === 1) {
                  Deferred.doneUnsafe(modelStarted, Effect.void);
                  return { text: "answer", waitFor: gate.waitFor };
                }
                return { text: "answer" };
              },
            },
          }),
        );
        let currentRuntime = context.runtime;
        try {
          yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
          const owner = yield* Effect.provideContext(
            Effect.all({ db: Database, chat: AgentChat, workflows: Workflows, sessions: Sessions }),
            yield* context.runtime.contextEffect,
          ).pipe(withWorkerFlag);
          const sessionA = context.session.id;
          const sessionB = (yield* Effect.provideContext(
            owner.sessions.create(context.project.id),
            yield* context.runtime.contextEffect,
          ).pipe(withWorkerFlag)).id;
          yield* Effect.provideContext(
            owner.workflows.updateGoal(sessionA, goal),
            yield* context.runtime.contextEffect,
          ).pipe(withWorkerFlag);
          yield* Effect.provideContext(
            owner.workflows.updateGoal(sessionB, goal),
            yield* context.runtime.contextEffect,
          ).pipe(withWorkerFlag);
          yield* Effect.provideContext(
            owner.workflows.updatePlan(sessionA, plan),
            yield* context.runtime.contextEffect,
          ).pipe(withWorkerFlag);
          const send = Effect.fn("sourceGeneration.send")(function* (session: string, run: string) {
            const response = yield* Effect.provideContext(
              Effect.flatMap(
                AgentChat,
                Effect.fnUntraced(function* (chat) {
                  return yield* chat.handle(yield* request(session, run), session);
                }),
              ),
              yield* currentRuntime.contextEffect,
            ).pipe(withWorkerFlag);
            expect(response.status).toBe(200);
            const stream = yield* sdkCall(() => response.text());
            expect(stream).not.toContain("RUN_ERROR");
            return stream;
          });
          const pendingA = yield* Effect.forkChild(send(sessionA, "source-a1"));

          yield* Deferred.await(modelStarted);
          yield* version("loop-v2");
          const streamB = yield* send(sessionB, "source-b1");
          expect(streamB).toContain("[loop-v2]");
          expect(streamB).not.toContain("[loop-v1]");
          gate.release();
          const streamA = yield* Fiber.join(pendingA);
          expect(streamA).toContain("[loop-v1]");
          expect(streamA).not.toContain("[loop-v2]");
          const binding = Effect.fn("sourceGeneration.binding")(function* (
            db: Database["Service"],
            run: string,
          ) {
            return yield* Schema.decodeUnknownEffect(Binding)(
              db.sqlite
                .prepare(
                  "SELECT goal_instance_id, goal_version, plan_version FROM workflow_run_bindings WHERE run_id = ?",
                )
                .get(run),
            );
          });
          const pin = Effect.fn("sourceGeneration.pin")(function* (
            db: Database["Service"],
            id: string,
          ) {
            return yield* Schema.decodeUnknownEffect(Pin)(
              db.sqlite
                .prepare(
                  "SELECT goal_instance_id, source_generation, manifest_hash, worker_url FROM workflow_goal_worker_generations WHERE goal_instance_id = ?",
                )
                .get(id),
            );
          });
          const dispatch = Effect.fn("sourceGeneration.dispatch")(function* (
            db: Database["Service"],
            run: string,
          ) {
            return yield* Schema.decodeUnknownEffect(Dispatch)(
              db.sqlite
                .prepare("SELECT generation FROM workflow_worker_dispatches WHERE run_id = ?")
                .get(run),
            );
          });
          const a = yield* binding(owner.db, "source-a1");
          const b = yield* binding(owner.db, "source-b1");
          expect(a).toMatchObject({ goal_version: 1, plan_version: 1 });
          expect(b).toMatchObject({ goal_version: 1, plan_version: null });
          expect(a.goal_instance_id).not.toBe(b.goal_instance_id);
          const pinA = yield* pin(owner.db, a.goal_instance_id);
          const pinB = yield* pin(owner.db, b.goal_instance_id);
          expect(pinA.source_generation).not.toBe(pinB.source_generation);
          expect(pinA.source_generation).not.toBe(
            (yield* dispatch(owner.db, "source-a1")).generation,
          );
          // A first method-only Plan must not retroactively invent a Plan for the old run.
          yield* Effect.provideContext(
            owner.workflows.updatePlan(sessionB, plan),
            yield* context.runtime.contextEffect,
          ).pipe(withWorkerFlag);
          const methodOnly = yield* send(sessionB, "source-b2");
          expect(methodOnly).toContain("[loop-v2]");
          expect(methodOnly).not.toContain("[loop-v1]");
          expect(yield* binding(owner.db, "source-b2")).toEqual({ ...b, plan_version: 1 });
          expect(yield* binding(owner.db, "source-b1")).toEqual(b);
          expect(yield* pin(owner.db, b.goal_instance_id)).toEqual(pinB);
          const oldDispatch = yield* dispatch(owner.db, "source-a1");
          const oldEvidence = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            owner.db.sqlite
              .prepare("SELECT * FROM workflow_run_events WHERE run_id = ? ORDER BY cursor")
              .all("source-a1"),
          );
          yield* Effect.provideContext(
            owner.workflows.updateGoal(sessionA, {
              ...goal,
              statement: "Amended Goal with preserved old execution code",
            }),
            yield* context.runtime.contextEffect,
          ).pipe(withWorkerFlag);
          yield* Effect.provideContext(
            owner.workflows.updatePlan(sessionA, {
              ...plan,
              summary: "Amended method retaining the same source assets",
            }),
            yield* context.runtime.contextEffect,
          ).pipe(withWorkerFlag);
          const amended = yield* send(sessionA, "source-a2");
          expect(amended).toContain("[loop-v1]");
          expect(yield* binding(owner.db, "source-a2")).toEqual({
            ...a,
            goal_version: 2,
            plan_version: 2,
          });
          expect(yield* binding(owner.db, "source-a1")).toEqual(a);
          expect(yield* pin(owner.db, a.goal_instance_id)).toEqual(pinA);
          workerEnabled = false;
          const legacy = yield* send(sessionA, "source-legacy");
          expect(legacy).not.toContain("[loop-v1]");
          expect(yield* pin(owner.db, a.goal_instance_id)).toEqual(pinA);
          workerEnabled = true;
          currentRuntime = yield* sdkCall(() => context.reopen());
          const reopened = yield* Effect.provideContext(
            Effect.all({ db: Database, chat: AgentChat }),
            yield* currentRuntime.contextEffect,
          ).pipe(withWorkerFlag);
          const revived = yield* send(sessionA, "source-a3");
          expect(revived).toContain("[loop-v1]");
          expect(revived).not.toContain("[loop-v2]");
          expect(yield* pin(reopened.db, a.goal_instance_id)).toEqual(pinA);
          expect((yield* dispatch(reopened.db, "source-a3")).generation).not.toBe(
            oldDispatch.generation,
          );
          expect(yield* dispatch(reopened.db, "source-a1")).toEqual(oldDispatch);
          expect(
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
              reopened.db.sqlite
                .prepare("SELECT * FROM workflow_run_events WHERE run_id = ? ORDER BY cursor")
                .all("source-a1"),
            ),
          ).toBe(oldEvidence);
          const offset = [...streamA.matchAll(/^id: (.+)$/gm)][0]![1]!;
          const replay = yield* Effect.provideContext(
            reopened.chat.hydrate(
              new Request("http://localhost/api/chat?runId=source-a1", {
                headers: { "Last-Event-ID": offset },
              }),
              sessionA,
            ),
            yield* currentRuntime.contextEffect,
          ).pipe(withWorkerFlag);
          expect(replay.status).toBe(200);
          expect(yield* sdkCall(() => replay.text())).toBe(
            streamA.slice(streamA.indexOf("\n\n") + 2),
          );
          const before = Effect.fn("sourceGeneration.before")(function* () {
            return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              nodes: reopened.db.sqlite
                .prepare("SELECT * FROM nodes WHERE session_id = ? ORDER BY seq")
                .all(sessionA),
              bindings: reopened.db.sqlite
                .prepare("SELECT * FROM workflow_run_bindings WHERE session_id = ? ORDER BY run_id")
                .all(sessionA),
              runs: reopened.db.sqlite
                .prepare("SELECT * FROM chat_runs WHERE thread_id = ? ORDER BY run_id")
                .all(sessionA),
            });
          });
          const admissionBefore = yield* before();
          const callsBefore = calls;
          const snapshotWorker = yield* path.fromFileUrl(new URL(pinA.worker_url));
          expect(snapshotWorker.startsWith(directory + "/")).toBe(true);
          if (damage === "missing") yield* fs.remove(snapshotWorker);
          else {
            yield* fs.chmod(snapshotWorker, 0o600);
            yield* fs.writeFileString(snapshotWorker, "// damaged owned snapshot\n");
          }
          const rejected = yield* Effect.provideContext(
            reopened.chat.handle(yield* request(sessionA, "source-damaged"), sessionA),
            yield* currentRuntime.contextEffect,
          ).pipe(withWorkerFlag);
          expect(rejected.status).toBe(409);
          expect(calls).toBe(callsBefore);
          expect(yield* before()).toBe(admissionBefore);
          expect(yield* pin(reopened.db, a.goal_instance_id)).toEqual(pinA);
        } finally {
          gate.release();
        }
      }).pipe(withTestPlatform),
    30000,
  );
}
