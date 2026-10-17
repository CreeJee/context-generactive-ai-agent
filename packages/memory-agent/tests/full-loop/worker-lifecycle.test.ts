import { createHook } from "node:async_hooks";
import { MessagePort, type Worker } from "node:worker_threads";
import { layer } from "@effect/vitest";
import { toolDefinition } from "@tanstack/ai";
import { Deferred, Effect, Fiber, MutableHashSet, Result } from "effect";
import { expect, vi } from "vite-plus/test";
import {
  createFullLoopExecution,
  type FullLoopOwner,
} from "../../src/agent/full-loop-execution.ts";
import { ScriptedTextAdapter } from "../../src/testing/scripted-adapter.ts";
import {
  capabilities,
  collect,
  ownerFixture,
  ownerLayer,
  ownerTurn,
  sdkCall,
  sdkRunner,
} from "./owner.ts";

/** Owner lease hooks recording the worker's lifecycle; the worker is terminated with the test. */
const watched = Effect.fnUntraced(function* () {
  const lifecycle: string[] = [];
  let worker: Worker | undefined;
  yield* Effect.addFinalizer(() => sdkCall(() => worker?.terminate()).pipe(Effect.orDie));
  const hooks = {
    acquireWorkerLease: Effect.sync(() => {
      lifecycle.push("start");
    }),
    onWorker: (value: Worker) => {
      worker = value;
      value.once("exit", () => {
        lifecycle.push("exit");
      });
    },
    onWorkerStopped: () => {
      lifecycle.push("stop");
    },
  } satisfies Partial<FullLoopOwner>;
  return { lifecycle, worker: () => worker, hooks };
});

/** One pulled run of `owner`, before any chunk is consumed. */
const started = (owner: FullLoopOwner, text = "must not execute") => {
  const adapter = new ScriptedTextAdapter([{ text }]);
  const run = capabilities({ adapter });
  return {
    adapter,
    controller: run.stream.abortController,
    modelCall: vi.spyOn(adapter, "chatStream"),
    stream: createFullLoopExecution<ScriptedTextAdapter>(owner).execute(ownerTurn, run),
  };
};

const failedPull = (stream: AsyncGenerator<unknown>) =>
  Effect.flip(sdkCall(() => stream.next())).pipe(Effect.map((error) => error.cause));

layer(ownerLayer, { excludeTestServices: true })("full-loop worker lifecycle", (it) => {
  it.effect(
    "scoped worker lease terminates even when admission observer and revoke throw",
    () =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        const { lifecycle, worker, hooks } = yield* watched();
        const { stream } = started(
          {
            ...f.owner,
            ...hooks,
            onWorker: (value) => {
              hooks.onWorker(value);
              throw new Error("observer failed");
            },
            revoke: () => {
              throw new Error("revoke failed");
            },
          },
          "unused",
        );
        expect(String(yield* failedPull(stream))).toContain("revoke failed");
        expect(worker()?.threadId).toBe(-1);
        expect(lifecycle).toEqual(["start", "stop", "exit"]);
      }),
    20000,
  );

  it.effect(
    "consumer cancellation awaits actual worker exit before releasing its lease",
    () =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        const { lifecycle, worker, hooks } = yield* watched();
        const { stream, controller } = started({ ...f.owner, ...hooks }, "answer");
        expect((yield* sdkCall(() => stream.next())).done).toBe(false);
        yield* sdkCall(() => stream.return(undefined));
        expect(worker()?.threadId).toBe(-1);
        expect(lifecycle).toEqual(["start", "stop", "exit"]);
        for (const event of ["message", "error", "exit"])
          expect(worker()?.listenerCount(event)).toBe(0);
        expect(controller.signal.aborted).toBe(true);
      }),
    20000,
  );

  it.effect(
    "endpoint preparation failure rolls back both acquired ports before any worker starts",
    () =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        const { lifecycle, hooks } = yield* watched();
        const ports: MessagePort[] = [];
        const closed = MutableHashSet.empty<number>();
        const hook = createHook({
          init(_id, type, _trigger, resource) {
            if (type === "MESSAGEPORT" && resource instanceof MessagePort) ports.push(resource);
          },
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            hook.disable();
            for (const port of ports) port.close();
          }),
        );
        const revoke = vi.fn();
        const { stream, controller, modelCall } = started({
          ...f.owner,
          ...hooks,
          get ledger(): never {
            // Node initializes the ports after async_hooks.init; observe close only
            // after construction so initialization cannot overwrite these listeners.
            for (const [index, port] of ports.entries())
              port.once("close", () => MutableHashSet.add(closed, index));
            throw new Error("endpoint preparation failed");
          },
          revoke,
        });
        hook.enable();
        expect(String(yield* failedPull(stream))).toContain("endpoint preparation failed");
        hook.disable();
        expect(ports).toHaveLength(2);
        yield* sdkCall(() => vi.waitFor(() => expect(MutableHashSet.size(closed)).toBe(2)));
        expect(lifecycle).toEqual([]);
        expect(modelCall).not.toHaveBeenCalled();
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(controller.signal.aborted).toBe(true);
        expect(f.operations()).toBe(0);
      }),
  );

  it.effect(
    "worker constructor failure releases the acquired lease without dispatching owner effects",
    () =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        const { lifecycle, worker, hooks } = yield* watched();
        const revoke = vi.fn();
        const { stream, controller, modelCall } = started({
          ...f.owner,
          ...hooks,
          workerUrl: new URL("https://invalid.example/worker.mjs"),
          revoke,
        });
        expect(yield* failedPull(stream)).toBeInstanceOf(Error);
        expect(lifecycle).toEqual(["start", "stop"]);
        expect(worker()).toBeUndefined();
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(controller.signal.aborted).toBe(true);
        expect(modelCall).not.toHaveBeenCalled();
        expect(f.operations()).toBe(0);
      }),
  );

  it.effect(
    "abort while waiting for a worker event settles the pull without a model or RPC replay",
    () =>
      Effect.gen(function* () {
        const f = yield* ownerFixture();
        const { lifecycle, worker, hooks } = yield* watched();
        const waitingWorker = new URL(
          `data:text/javascript;base64,${Buffer.from(`
      import { workerData, parentPort } from 'node:worker_threads';
      parentPort.on('message', frame => {
        if (frame.type !== 'abort') return;
        parentPort.postMessage({ type: 'done' });
        workerData.port.close();
        parentPort.close();
      });
    `).toString("base64")}`,
        );
        const { stream, controller, modelCall } = started({
          ...f.owner,
          ...hooks,
          workerUrl: waitingWorker,
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => controller.abort()).pipe(
            Effect.andThen(sdkCall(() => stream.return(undefined))),
            Effect.orDie,
          ),
        );
        const pull = stream.next();
        yield* sdkCall(() => vi.waitFor(() => expect(worker()).toBeDefined()));
        controller.abort();
        expect((yield* Effect.flip(sdkCall(() => pull))).cause).toMatchObject({
          _tag: "WorkerLifecycleError",
          operation: "cancel",
        });
        expect(lifecycle.filter((event) => event === "stop")).toHaveLength(1);
        expect(worker()?.threadId).toBe(-1);
        expect(modelCall).not.toHaveBeenCalled();
        expect(f.operations()).toBe(0);
      }),
    20000,
  );

  it.effect(
    "worker death during owner effect rejects stream, retains uncertainty and never replays tool",
    () =>
      Effect.gen(function* () {
        const runSdk = yield* sdkRunner();
        const f = yield* ownerFixture();
        const { worker, hooks } = yield* watched();
        const gate = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        const entered = yield* Deferred.make<void>();
        let calls = 0;
        const tool = toolDefinition({ name: "effect", description: "effect" }).server(() =>
          runSdk(
            Effect.gen(function* () {
              calls++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(gate);
              return "done";
            }),
          ),
        );
        const adapter = new ScriptedTextAdapter([
          { toolCalls: [{ id: "c", name: "effect", arguments: "{}" }] },
        ]);
        const consume = yield* Effect.forkChild(
          Effect.result(
            collect({ ...f.owner, ...hooks }, capabilities({ adapter }, { tools: [tool] })),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(entered);
        const sideEffects = () =>
          f.sqlite
            .prepare(
              `SELECT status FROM owner_rpc_operations WHERE side_effect = 1 AND fingerprint LIKE '%"operation":"tool"%'`,
            )
            .all();
        expect(sideEffects()).toMatchObject([{ status: "pending" }]);
        yield* sdkCall(() => worker()!.terminate());
        const failure = yield* Fiber.join(consume);
        expect(Result.isFailure(failure)).toBe(true);
        if (Result.isFailure(failure)) expect(String(failure.failure.cause)).toContain("no replay");
        yield* Deferred.succeed(gate, undefined);
        yield* Effect.yieldNow;
        expect(sideEffects()).toMatchObject([{ status: "pending" }]);
        expect(calls).toBe(1);
      }),
    20000,
  );
});
