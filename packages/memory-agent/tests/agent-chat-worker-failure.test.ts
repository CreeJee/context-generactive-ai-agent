const sdkCall = Effect.fn("workerFailure.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
import { Cause, ConfigProvider, Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { optionalProperty } from "../src/optional-property.ts";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";
import { selectTestModel, turnGate } from "./support/provider.ts";

const goal = {
  statement: "Keep failed worker output without replay",
  outcomes: ["One admission and preserved committed evidence"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

const request = Effect.fn("workerFailure.request")(function* (sessionId: string, runId: string) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      threadId: sessionId,
      runId,
      messages: [{ id: "user-1", role: "user", content: "stream then fail" }],
      tools: [],
      context: [],
    }),
  });
});

for (const toolFirst of [false, true]) {
  it.live(
    `real worker midstream failure preserves durable output and denies replay${toolFirst ? " after a tool" : ""}`,
    () =>
      Effect.gen(function* () {
        const flagServices = yield* Layer.build(
          ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ CONTEXT_AGENT_GOAL_WORKER: "1" }), {
            asPrimary: true,
          }),
        );
        const gate = turnGate();
        const modelStarted = yield* Deferred.make<void>();
        const lookupArguments = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Struct({ query: Schema.String })),
        )({ query: "absent deterministic memory" });
        const partial = "Committed partial output before deterministic failure";
        try {
          let turn = 0;
          const context = yield* sdkCall(() =>
            testRuntime({
              testProvider: {
                responder: () => {
                  Deferred.doneUnsafe(modelStarted, Effect.void);
                  const index = turn++;
                  if (toolFirst && index === 0)
                    return {
                      waitFor: gate.waitFor,
                      toolCalls: [
                        {
                          id: "read-before-failure",
                          name: "find_memory",
                          arguments: lookupArguments,
                        },
                      ],
                    };
                  return {
                    text: partial,
                    failAfterText: "deterministic-provider-midstream-failure",
                    ...optionalProperty("waitFor", toolFirst ? undefined : gate.waitFor),
                  };
                },
              },
            }),
          );
          yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
          const { db, workflows, chat } = yield* Effect.provideContext(
            Effect.all({ db: Database, workflows: Workflows, chat: AgentChat }),
            yield* context.runtime.contextEffect,
          ).pipe(Effect.provideContext(flagServices));
          yield* Effect.provideContext(
            workflows.updateGoal(context.session.id, goal),
            yield* context.runtime.contextEffect,
          ).pipe(Effect.provideContext(flagServices));
          const runId = toolFirst ? "failed-worker-with-tool" : "failed-worker";
          const response = yield* Effect.provideContext(
            chat.handle(yield* request(context.session.id, runId), context.session.id),
            yield* context.runtime.contextEffect,
          ).pipe(Effect.provideContext(flagServices));
          expect(response.status).toBe(200);
          const deliveredFiber = yield* Effect.forkChild(sdkCall(() => response.text()));
          yield* Deferred.await(modelStarted);
          const userCount = () =>
            db.sqlite
              .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ? AND kind = 'user'")
              .get(context.session.id);
          expect(userCount()).toEqual({ n: 1 });
          for (const duplicateId of [runId, `${runId}-bypass`]) {
            const duplicate = yield* Effect.provideContext(
              chat.handle(yield* request(context.session.id, duplicateId), context.session.id),
              yield* context.runtime.contextEffect,
            ).pipe(Effect.provideContext(flagServices));
            expect(duplicate.status).toBe(409);
            expect(userCount()).toEqual({ n: 1 });
          }
          gate.release();
          const delivered = yield* Fiber.join(deliveredFiber);
          expect.soft(delivered).toContain(partial);
          expect.soft(delivered).toContain("RUN_ERROR");
          expect((delivered.match(/"type":"RUN_ERROR"/g) ?? []).length).toBe(1);
          expect(delivered).toContain('"code":"worker_execution_failed"');
          expect(delivered).not.toContain("deterministic-provider-midstream-failure");
          expect(delivered).not.toContain("Inactive owner chunk capability");
          expect(
            db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId),
          ).toEqual({ status: "failed" });
          const offsets = [...delivered.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
          expect(offsets.length).toBeGreaterThan(1);
          expect(offsets.every((offset) => offset.startsWith("sdk-stream:v1:"))).toBe(true);
          const callsBeforeRestart = context.provider!.adapter.invocations.length;
          const effects = db.sqlite
            .prepare(
              "SELECT operation_id, fingerprint, status FROM owner_rpc_operations WHERE run_id = ? AND json_extract(fingerprint, '$.operation') = 'tool' ORDER BY operation_id",
            )
            .all(runId);
          expect(effects.length).toBe(toolFirst ? 1 : 0);
          if (toolFirst) expect(effects[0]!.status).toBe("succeeded");
          const reopened = yield* sdkCall(() => context.reopen());
          const owner = yield* Effect.provideContext(
            Effect.all({ db: Database, chat: AgentChat }),
            yield* reopened.contextEffect,
          ).pipe(Effect.provideContext(flagServices));
          expect(
            owner.db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId),
          ).toEqual({ status: "failed" });
          const replay = yield* Effect.provideContext(
            owner.chat.hydrate(
              new Request(`http://localhost/api/chat?runId=${runId}`, {
                headers: { "Last-Event-ID": offsets[0]! },
              }),
              context.session.id,
            ),
            yield* reopened.contextEffect,
          ).pipe(Effect.provideContext(flagServices));
          expect(replay.status).toBe(200);
          expect
            .soft(yield* sdkCall(() => replay.text()))
            .toBe(delivered.slice(delivered.indexOf("\n\n") + 2));
          for (const retryId of [runId, `${runId}-after-reopen`]) {
            const retry = yield* Effect.provideContext(
              owner.chat.handle(yield* request(context.session.id, retryId), context.session.id),
              yield* reopened.contextEffect,
            ).pipe(Effect.provideContext(flagServices));
            expect(retry.status).toBe(409);
          }
          expect(context.provider!.adapter.invocations.length).toBe(callsBeforeRestart);
          expect(
            owner.db.sqlite
              .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ? AND kind = 'user'")
              .get(context.session.id),
          ).toEqual({ n: 1 });
          expect(
            owner.db.sqlite
              .prepare(
                "SELECT operation_id, fingerprint, status FROM owner_rpc_operations WHERE run_id = ? AND json_extract(fingerprint, '$.operation') = 'tool' ORDER BY operation_id",
              )
              .all(runId),
          ).toEqual(effects);
          expect(
            owner.db.sqlite
              .prepare("SELECT count(*) AS n FROM workflow_run_bindings WHERE session_id = ?")
              .get(context.session.id),
          ).toEqual({ n: 1 });
        } finally {
          gate.release();
        }
      }),
  );
}
