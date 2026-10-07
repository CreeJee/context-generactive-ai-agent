import { it } from "@effect/vitest";
const sdkCall = Effect.fn("workerCancellationTest.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
import { Cause, ConfigProvider, Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { expect, vi } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";
import { selectTestModel, turnGate } from "./support/provider.ts";

it.live(
  "cancelled pending worker pull cannot leave a stopped SDK run marked running or completed",
  () =>
    Effect.gen(function* () {
      const flagServices = yield* Layer.build(
        ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ CONTEXT_AGENT_GOAL_WORKER: "1" }), {
          asPrimary: true,
        }),
      );
      const runNative = Effect.runPromiseWith(yield* Effect.context());

      const gate = turnGate();
      const started = yield* Deferred.make<void>();
      try {
        const context = yield* sdkCall(() =>
          testRuntime({
            testProvider: {
              responder: () => {
                Deferred.doneUnsafe(started, Effect.void);
                // Deliberately hold the native SDK callback despite cancellation until the test releases it.
                return runNative(
                  gate.waitFor.pipe(
                    Effect.as({ text: "must not publish after cancellation" }),
                    Effect.uninterruptible,
                  ),
                );
              },
            },
          }),
        );
        // This fixture models a native SDK that keeps its pending pull after abort.
        // The regular scripted adapter now cooperates with cancellation and settles that pull.
        const adapter = context.provider!.adapter;
        const nativeStream = adapter.chatStream.bind(adapter);
        const streaming = vi.spyOn(adapter, "chatStream").mockImplementation((options) => {
          const nativeOptions = { ...options };
          delete nativeOptions.abortController;
          delete nativeOptions.request;
          const stream = nativeStream(nativeOptions);
          return {
            [Symbol.asyncIterator]() {
              const iterator = stream[Symbol.asyncIterator]();
              return {
                next: () => iterator.next(),
                return: () =>
                  runNative(
                    gate.waitFor.pipe(Effect.andThen(Effect.promise(() => iterator.return!()))),
                  ),
              };
            },
          };
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => streaming.mockRestore()));
        yield* Effect.provideContext(
          Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect),
          flagServices,
        );
        const { db, workflows, chat } = yield* Effect.provideContext(
          Effect.provideContext(
            Effect.all({ db: Database, workflows: Workflows, chat: AgentChat }),
            yield* context.runtime.contextEffect,
          ),
          flagServices,
        );
        yield* Effect.provideContext(
          Effect.provideContext(
            workflows.updateGoal(context.session.id, {
              statement: "Keep cancellation outcome and uncertain effects without replay",
              outcomes: ["No false completed or running state after worker termination"],
              constraints: [],
              nonGoals: [],
              assumptions: [],
              openQuestions: [],
              status: "active",
            }),
            yield* context.runtime.contextEffect,
          ),
          flagServices,
        );
        const runId = "cancelled-pending-worker";
        const request = Effect.fn("workerCancellationTest.request")(function* (id: string) {
          return new Request("http://localhost/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              threadId: context.session.id,
              runId: id,
              messages: [{ id: "user-1", role: "user", content: "wait until cancelled" }],
              tools: [],
              context: [],
            }),
          });
        });
        const response = yield* Effect.provideContext(
          Effect.provideContext(
            chat.handle(yield* request(runId), context.session.id),
            yield* context.runtime.contextEffect,
          ),
          flagServices,
        );
        expect(response.status).toBe(200);
        const delivered = yield* Effect.forkChild(sdkCall(() => response.text()));
        yield* Effect.provideContext(
          Effect.provideContext(Deferred.await(started), yield* context.runtime.contextEffect),
          flagServices,
        );
        const cancel = yield* Effect.provideContext(
          Effect.provideContext(
            chat.cancel(context.session.id, null),
            yield* context.runtime.contextEffect,
          ),
          flagServices,
        );
        expect(cancel.status).toBe(200);
        const result = yield* sdkCall(() => cancel.json());
        expect(result).toMatchObject({ runId, stopped: true, status: "failed" });
        const output = yield* Fiber.join(delivered);
        expect(output).not.toContain("must not publish after cancellation");
        expect((output.match(/"type":"RUN_ERROR"/g) ?? []).length).toBe(1);
        expect(output).toContain('"code":"worker_execution_failed"');
        expect(output).not.toContain("Worker cancellation outcome unacknowledged");
        const row = db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId);
        expect(row).toEqual({ status: "failed" });
        const receipts = db.sqlite
          .prepare(
            "SELECT operation_id, fingerprint, status FROM owner_rpc_operations WHERE run_id = ? ORDER BY operation_id",
          )
          .all(runId);
        expect(receipts.some((receipt) => receipt.status === "pending")).toBe(true);
        const offsets = [...output.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
        expect(offsets.length).toBeGreaterThan(1);
        expect(
          db.sqlite
            .prepare("SELECT count(*) AS n FROM nodes WHERE session_id = ? AND kind = 'user'")
            .get(context.session.id),
        ).toEqual({ n: 1 });
        const calls = context.provider!.adapter.invocations.length;
        const reopened = yield* sdkCall(() => context.reopen());
        const owner = yield* Effect.provideContext(
          Effect.provideContext(
            Effect.all({ db: Database, chat: AgentChat }),
            yield* reopened.contextEffect,
          ),
          flagServices,
        );
        expect(
          owner.db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId),
        ).toEqual(row);
        const replay = yield* Effect.provideContext(
          Effect.provideContext(
            owner.chat.hydrate(
              new Request(`http://localhost/api/chat?runId=${runId}`, {
                headers: { "Last-Event-ID": offsets[0]! },
              }),
              context.session.id,
            ),
            yield* reopened.contextEffect,
          ),
          flagServices,
        );
        expect(replay.status).toBe(200);
        expect(yield* sdkCall(() => replay.text())).toBe(output.slice(output.indexOf("\n\n") + 2));
        expect(
          owner.db.sqlite
            .prepare(
              "SELECT operation_id, fingerprint, status FROM owner_rpc_operations WHERE run_id = ? ORDER BY operation_id",
            )
            .all(runId),
        ).toEqual(receipts);
        for (const id of [runId, `${runId}-bypass`]) {
          const retry = yield* Effect.provideContext(
            Effect.provideContext(
              owner.chat.handle(yield* request(id), context.session.id),
              yield* reopened.contextEffect,
            ),
            flagServices,
          );
          expect(retry.status).toBe(409);
        }
        expect(context.provider!.adapter.invocations.length).toBe(calls);
      } finally {
        gate.release();
      }
    }),
  20000,
);
