import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { RpcClient, RpcServer } from "effect/rpc";
import { Worker, WorkerError, WorkerRunner } from "effect/workers";
import type { MessagePort, Transferable } from "node:worker_threads";

// A dedicated MessagePort carries Effect's worker protocol in both directions: the client side
// is a worker "spawned" from the port, the server side runs a WorkerRunner on the other end.
// RpcClient/RpcServer keep request IDs, acknowledgements and interruption; this module only
// adapts the port's listeners and lifetime.

const ready = [0] as const;
const close = [1] as const;

const receiveError = (message: string, cause?: Error) =>
  WorkerError.WorkerError.make({
    reason: WorkerError.WorkerReceiveError.make({ message, cause }),
  });

// SAFETY: Node validates Effect's platform-neutral transfer list when posting.
const nodeTransfers = (transfers: ReadonlyArray<unknown> = []) => transfers as Transferable[];

const layerPortPlatform = (port: MessagePort) =>
  Layer.effect(Worker.WorkerPlatform)(
    Effect.gen(function* () {
      // A closed port cannot be reopened; the worker protocol's reconnect attempts must fail
      // so requests queued after closure are failed instead of waiting for a handshake.
      const portClosed = yield* Deferred.make<void>();
      const onPortClose = () => Deferred.doneUnsafe(portClosed, Exit.void);
      yield* Effect.acquireRelease(
        Effect.sync(() => port.once("close", onPortClose)),
        () => Effect.sync(() => port.off("close", onPortClose)),
      );
      return Worker.makePlatform<MessagePort>()({
        setup: ({ worker, scope }) =>
          Deferred.isDone(portClosed).pipe(
            Effect.filterOrFail(
              (closed) => !closed,
              () =>
                WorkerError.WorkerError.make({
                  reason: WorkerError.WorkerSpawnError.make({ message: "MessagePort is closed" }),
                }),
            ),
            Effect.andThen(
              Scope.addFinalizer(
                scope,
                Effect.sync(() => {
                  worker.postMessage(close);
                  worker.close();
                }),
              ),
            ),
            Effect.as(worker),
          ),
        listen: ({ port, emit, deferred, scope }) => {
          const onMessageError = (cause: Error) =>
            Deferred.doneUnsafe(
              deferred,
              Effect.fail(receiveError("MessagePort messageerror", cause)),
            );
          const onClose = () =>
            Deferred.doneUnsafe(deferred, Effect.fail(receiveError("MessagePort closed")));
          return Effect.sync(() => {
            port.on("message", emit);
            port.on("messageerror", onMessageError);
            port.on("close", onClose);
          }).pipe(
            Effect.andThen(
              Scope.addFinalizer(
                scope,
                Effect.sync(() => {
                  port.off("message", emit);
                  port.off("messageerror", onMessageError);
                  port.off("close", onClose);
                }),
              ),
            ),
          );
        },
      });
    }),
  );

export const layerMessagePortRpcClient = (
  port: MessagePort,
): Layer.Layer<RpcClient.Protocol, WorkerError.WorkerError> =>
  RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
    Layer.provide(
      Layer.merge(
        Worker.layerSpawner(() => port),
        layerPortPlatform(port),
      ),
    ),
  );

const makePortRunner = <O, I>(port: MessagePort): WorkerRunner.WorkerRunner<O, I> => {
  const sendUnsafe = (_portId: number, message: O, transfers?: ReadonlyArray<unknown>) =>
    port.postMessage([1, message], nodeTransfers(transfers));
  return {
    sendUnsafe,
    send: (portId, message, transfers) => Effect.sync(() => sendUnsafe(portId, message, transfers)),
    run: <A, E, R>(handler: (portId: number, message: I) => Effect.Effect<A, E, R> | void) =>
      Effect.scopedWith(
        Effect.fnUntraced(function* (scope) {
          const closed = yield* Deferred.make<void, WorkerError.WorkerError>();
          const runFork = Effect.runForkWith(yield* Effect.context<R>());
          const track = Fiber.runIn(scope);
          const onMessage = (message: WorkerRunner.PlatformMessage<I>) => {
            switch (message[0]) {
              case 0: {
                const result = handler(0, message[1]);
                if (Effect.isEffect(result)) result.pipe(runFork, track);
                return;
              }
              case 1:
                Deferred.doneUnsafe(closed, Exit.void);
                return;
            }
          };
          const onMessageError = (cause: Error) =>
            Deferred.doneUnsafe(
              closed,
              Effect.fail(receiveError("MessagePort messageerror", cause)),
            );
          const onClose = () => Deferred.doneUnsafe(closed, Exit.void);
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              port.on("message", onMessage);
              port.on("messageerror", onMessageError);
              port.on("close", onClose);
              port.postMessage(ready);
            }),
            () =>
              Effect.sync(() => {
                port.off("message", onMessage);
                port.off("messageerror", onMessageError);
                port.off("close", onClose);
                port.close();
              }),
          ).pipe(Scope.provide(scope));
          return yield* Deferred.await(closed);
        }),
      ),
  };
};

/**
 * Serves RPCs from the client at the other end of `port`. When that client closes, Effect's
 * worker-runner protocol interrupts the fiber that built this layer, so build it in a fiber
 * owned by the port's Scope (for example `Effect.forkIn(Layer.launch(server), scope)`).
 */
export const layerMessagePortRpcServer = (
  port: MessagePort,
): Layer.Layer<RpcServer.Protocol, WorkerError.WorkerError> =>
  RpcServer.layerProtocolWorkerRunner.pipe(
    Layer.provide(
      Layer.succeed(WorkerRunner.WorkerRunnerPlatform)({
        start: () => Effect.succeed(makePortRunner(port)),
      }),
    ),
  );
