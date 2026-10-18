import { webSearchTool } from "@tanstack/ai-openai/tools";
import { Clock, Deferred, Effect, Fiber, Ref, Schema } from "effect";
import { expect, vi } from "vite-plus/test";
import * as workerExecution from "../../src/agent/full-loop-execution.ts";
import { makeOwnerNativeArtifacts } from "../../src/agent/owner-native-artifacts.ts";
import { makeSqliteOwnerRpcLedger } from "../../src/agent/owner-rpc-ledger.ts";
import { AgentChat } from "../../src/agent/chat.ts";
import { Database } from "../../src/db/database.ts";
import type { ScriptedTurn } from "../../src/testing/scripted-adapter.ts";
import { workflowRunBindings } from "../../src/workflow/run-bindings.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import {
  goalSession,
  invocations,
  replay,
  responder,
  responseJson,
  responseText,
  rows,
  send,
  sessionEvidence,
} from "./goal-session.ts";

const noEvidence = {
  bindings: [],
  dispatches: [],
  events: [],
  operations: [],
  chatRuns: [],
  nodes: [],
};

type Inventory = "duplicate" | "client-only" | "provider-native";

/** One tool the owner cannot grant, appended after the server tools of a valid inventory. */
const unsupportedTool = <T extends { readonly name: string }>(inventory: Inventory, first: T) => {
  switch (inventory) {
    case "duplicate":
      return first;
    case "client-only":
      return { ...first, name: "test-client-only", execute: undefined };
    case "provider-native":
      return webSearchTool({ type: "web_search" });
  }
};

const LatestRevision = Schema.Struct({ id: Schema.Finite, goal_instance_id: Schema.String });

const runStatus = (runId: string) => rows("SELECT status FROM chat_runs WHERE run_id = ?", runId);
const userNodes = (sessionId: string) =>
  rows("SELECT count(*) AS n FROM nodes WHERE session_id = ? AND kind = 'user'", sessionId);
const sseOffsets = (output: string) =>
  [...output.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
const runErrors = (output: string) => (output.match(/"type":"RUN_ERROR"/g) ?? []).length;

testAgent({ testProvider: { responder } })("Goal worker admission", (it) => {
  // AgentChat uses the complete inventory preflight, not only its shared portability subset.
  it.effect.each(["duplicate", "client-only", "provider-native"] as const)(
    "rejects %s inventory before any execution evidence",
    (inventory) =>
      Effect.gen(function* () {
        const id = yield* goalSession("Reject unsupported inventory before admission");
        const validate = workerExecution.preflightFullLoopExecution;
        const preflight = vi
          .spyOn(workerExecution, "preflightFullLoopExecution")
          .mockImplementation((turn, capabilities) => {
            const invalid = { ...capabilities };
            // Deliberately cross the runtime admission boundary the types would refuse.
            expect(
              Reflect.set(invalid, "tools", [
                ...capabilities.tools,
                unsupportedTool(inventory, capabilities.tools[0]!),
              ]),
            ).toBe(true);
            validate(turn, invalid);
          });
        yield* Effect.addFinalizer(() => Effect.sync(() => preflight.mockRestore()));
        const response = yield* send(id, `${id}-unsupported`);
        expect(response.status).toBe(409);
        expect(yield* responseJson(response)).toMatchObject({
          error: "unsupported_worker_capabilities",
          detail: expect.stringMatching(/^Unsupported owner tool grant capability: /),
        });
        expect(preflight).toHaveBeenCalledTimes(1);
        expect(yield* sessionEvidence(id)).toEqual(noEvidence);
        expect(yield* invocations(id)).toHaveLength(0);
      }),
  );

  it.effect.each([
    { status: "pending", runStatus: "completed" },
    { status: "uncertain", runStatus: "completed" },
    { status: "succeeded", runStatus: "failed" },
  ] as const)(
    "a $runStatus run with a $status side effect fences the next admission",
    ({ status, runStatus: previous }) =>
      Effect.gen(function* () {
        const { id, key, ledger } = yield* previousRun(previous);
        switch (status) {
          case "pending":
            break;
          case "uncertain":
            yield* ledger.settle(key, 1, { type: "uncertain", operationId: 1 });
            break;
          case "succeeded":
            yield* ledger.settle(key, 1, { type: "succeeded", operationId: 1, output: null });
            break;
        }
        const before = yield* sessionEvidence(id);
        const response = yield* send(id, `${id}-new`);
        expect(response.status).toBe(409);
        // Consume the body so a wrongly admitted model call would be observable.
        yield* responseText(response);
        expect(yield* invocations(id)).toHaveLength(0);
        expect(yield* sessionEvidence(id)).toEqual(before);
      }),
  );

  it.effect("a completed run with a succeeded side effect admits the next run", () =>
    Effect.gen(function* () {
      const { id, key, ledger } = yield* previousRun("completed");
      yield* ledger.settle(key, 1, { type: "succeeded", operationId: 1, output: null });
      const receipts = () =>
        rows("SELECT * FROM owner_rpc_operations WHERE run_id = ?", `${id}-old`);
      const before = yield* receipts();
      const response = yield* send(id, `${id}-new`);
      const body = yield* responseText(response);
      expect(response.status, body).toBe(200);
      expect((yield* invocations(id)).length).toBeGreaterThan(0);
      expect((yield* sessionEvidence(id)).bindings).toHaveLength(2);
      expect(yield* receipts()).toEqual(before);
    }),
  );
});

/**
 * A Goal session whose earlier run, with genuine native provenance, reserved one side effect in
 * the owner ledger and then ended with `status`.
 */
const previousRun = Effect.fnUntraced(function* (status: "completed" | "failed") {
  const env = yield* TestEnv;
  const db = yield* Database;
  const id = yield* goalSession("Never replay an uncertain effect");
  const revision = yield* Schema.decodeUnknownEffect(LatestRevision)(
    db.sqlite
      .prepare(
        "SELECT id, goal_instance_id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(id),
  );
  yield* Effect.scoped(
    makeOwnerNativeArtifacts({
      ...db,
      directory: `${env.storage}/native-artifacts`,
    }).acquire(revision.goal_instance_id),
  );
  const admission = yield* (yield* workflowRunBindings).bind(id, `${id}-old`, revision.id);
  expect(admission.status).toBe("bound");
  if (admission.status !== "bound") return yield* Effect.die("the earlier run was not bound");
  db.sqlite
    .prepare("INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, ?, ?)")
    .run(`${id}-old`, id, status, yield* Clock.currentTimeMillis);
  const ledger = yield* makeSqliteOwnerRpcLedger;
  const key = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(admission.binding);
  expect(yield* ledger.reserve(key, 1, "old-effect", true)).toEqual({ type: "reserved" });
  return { id, key, ledger };
});

// Reopening replaces the agent behind every service, so these tests read through `env.use` only.
testAgent({ testProvider: { responder } })("Goal worker failure and cancellation", (it) => {
  it.effect.each([
    { toolFirst: false, label: "" },
    { toolFirst: true, label: " after a tool" },
  ])(
    "a midstream failure$label keeps durable output and denies replay",
    ({ toolFirst }) =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const gate = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        const started = yield* Deferred.make<void>();
        const partial = "Committed partial output before deterministic failure";
        const failing: ScriptedTurn = {
          text: partial,
          failAfterText: "deterministic-provider-midstream-failure",
        };
        const turns: readonly ScriptedTurn[] = toolFirst
          ? [
              {
                waitFor: Deferred.await(gate),
                toolCalls: [
                  {
                    id: "read-before-failure",
                    name: "find_memory",
                    arguments: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                      query: "absent deterministic memory",
                    }),
                  },
                ],
              },
              failing,
            ]
          : [{ ...failing, waitFor: Deferred.await(gate) }];
        const turn = yield* Ref.make(0);
        const id = yield* goalSession("Keep failed worker output without replay", () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Ref.getAndUpdate(turn, (index) => index + 1)),
            Effect.map((index) => turns[index]!),
          ),
        );
        const runId = `${id}-failed`;
        const response = yield* send(id, runId, "stream then fail");
        expect(response.status).toBe(200);
        const delivering = yield* Effect.forkChild(responseText(response));
        yield* Deferred.await(started);
        expect(yield* userNodes(id)).toEqual([{ n: 1 }]);
        for (const duplicate of [runId, `${runId}-bypass`]) {
          expect((yield* send(id, duplicate, "stream then fail")).status).toBe(409);
          expect(yield* userNodes(id)).toEqual([{ n: 1 }]);
        }
        yield* Deferred.succeed(gate, undefined);
        const delivered = yield* Fiber.join(delivering);
        expect.soft(delivered).toContain(partial);
        expect(runErrors(delivered)).toBe(1);
        expect(delivered).toContain('"code":"worker_execution_failed"');
        expect(delivered).not.toContain("deterministic-provider-midstream-failure");
        expect(delivered).not.toContain("Inactive owner chunk capability");
        expect(yield* runStatus(runId)).toEqual([{ status: "failed" }]);
        const offsets = sseOffsets(delivered);
        expect(offsets.length).toBeGreaterThan(1);
        expect(offsets.every((offset) => offset.startsWith("sdk-stream:v1:"))).toBe(true);
        const toolEffects = () =>
          rows(
            "SELECT operation_id, fingerprint, status FROM owner_rpc_operations WHERE run_id = ? AND json_extract(fingerprint, '$.operation') = 'tool' ORDER BY operation_id",
            runId,
          );
        const effects = yield* toolEffects();
        expect(effects.map((effect) => effect.status)).toEqual(toolFirst ? ["succeeded"] : []);
        const calls = (yield* invocations(id)).length;

        yield* env.reopen;
        expect(yield* runStatus(runId)).toEqual([{ status: "failed" }]);
        const replayed = yield* replay(id, runId, offsets[0]!);
        expect(replayed.status).toBe(200);
        expect
          .soft(yield* responseText(replayed))
          .toBe(delivered.slice(delivered.indexOf("\n\n") + 2));
        expect((yield* send(id, runId, "stream then fail")).status).toBe(409);
        expect(yield* invocations(id)).toHaveLength(calls);
        expect(yield* userNodes(id)).toEqual([{ n: 1 }]);
        expect(yield* toolEffects()).toEqual(effects);
        expect(
          yield* rows("SELECT count(*) AS n FROM workflow_run_bindings WHERE session_id = ?", id),
        ).toEqual([{ n: 1 }]);
      }),
    20_000,
  );

  it.effect(
    "a cancelled pending worker pull leaves the stopped run failed, never running",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const started = yield* Deferred.make<void>();
        // A native SDK callback that ignores cancellation: the model and its iterator stay held
        // until the test ends.
        const release = yield* Deferred.make<void>();
        const held = Effect.runPromiseWith(yield* Effect.context())(Deferred.await(release));
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        const adapter = env.provider!.adapter;
        const nativeStream = adapter.chatStream.bind(adapter);
        const streaming = vi.spyOn(adapter, "chatStream").mockImplementation((options) => {
          const {
            abortController: _abortController,
            request: _request,
            ...ignoringAbort
          } = options;
          const iterator = nativeStream(ignoringAbort)[Symbol.asyncIterator]();
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => iterator.next(),
              return: () => held.then(() => iterator.return!()),
            }),
          };
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => streaming.mockRestore()));
        const id = yield* goalSession(
          "Keep cancellation outcome and uncertain effects without replay",
          () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.as({
                waitFor: Deferred.await(release),
                text: "must not publish after cancellation",
              }),
            ),
        );
        const runId = `${id}-cancelled`;
        const response = yield* send(id, runId, "wait until cancelled");
        expect(response.status).toBe(200);
        const delivering = yield* Effect.forkChild(responseText(response));
        yield* Deferred.await(started);
        const cancel = yield* env.use(Effect.flatMap(AgentChat, (chat) => chat.cancel(id, null)));
        expect(cancel.status).toBe(200);
        expect(yield* responseJson(cancel)).toMatchObject({
          runId,
          stopped: true,
          status: "failed",
        });
        const output = yield* Fiber.join(delivering);
        expect(output).not.toContain("must not publish after cancellation");
        expect(runErrors(output)).toBe(1);
        expect(output).toContain('"code":"worker_execution_failed"');
        expect(output).not.toContain("Worker cancellation outcome unacknowledged");
        expect(yield* runStatus(runId)).toEqual([{ status: "failed" }]);
        const receipts = () =>
          rows(
            "SELECT operation_id, fingerprint, status FROM owner_rpc_operations WHERE run_id = ? ORDER BY operation_id",
            runId,
          );
        const pending = yield* receipts();
        expect(pending.some((receipt) => receipt.status === "pending")).toBe(true);
        const offsets = sseOffsets(output);
        expect(offsets.length).toBeGreaterThan(1);
        expect(yield* userNodes(id)).toEqual([{ n: 1 }]);
        const calls = (yield* invocations(id)).length;

        yield* env.reopen;
        expect(yield* runStatus(runId)).toEqual([{ status: "failed" }]);
        const replayed = yield* replay(id, runId, offsets[0]!);
        expect(replayed.status).toBe(200);
        expect(yield* responseText(replayed)).toBe(output.slice(output.indexOf("\n\n") + 2));
        expect(yield* receipts()).toEqual(pending);
        expect((yield* send(id, runId, "wait until cancelled")).status).toBe(409);
        expect(yield* invocations(id)).toHaveLength(calls);
      }),
    20_000,
  );
});
