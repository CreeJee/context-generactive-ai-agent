import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";
import { Rpc, RpcClient, RpcClientError, RpcGroup, RpcServer } from "effect/rpc";
import { MessageChannel } from "node:worker_threads";
import { describe, expect } from "vite-plus/test";
import {
  layerMessagePortRpcClient,
  layerMessagePortRpcServer,
} from "../src/agent/effect-rpc-message-port.ts";

const Probe = RpcGroup.make(
  Rpc.make("Echo", { payload: { value: Schema.String }, success: Schema.String }),
  Rpc.make("Wait"),
);

/** One RPC client and server across a fresh channel, each in its own closable Scope. */
const connect = Effect.fnUntraced(function* () {
  const channel = new MessageChannel();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      channel.port1.close();
      channel.port2.close();
    }),
  );
  const entered = yield* Deferred.make<void>();
  const interrupted = yield* Deferred.make<void>();
  const handlers = Probe.toLayer({
    Echo: ({ value }) => Effect.succeed(value),
    Wait: () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      ),
  });
  const serverScope = yield* Scope.fork(yield* Effect.scope);
  const server = yield* Effect.forkIn(
    Layer.launch(
      RpcServer.layer(Probe).pipe(
        Layer.provide(handlers),
        Layer.provide(layerMessagePortRpcServer(channel.port1)),
      ),
    ),
    serverScope,
  );
  const clientScope = yield* Scope.fork(yield* Effect.scope);
  const protocol = yield* Layer.buildWithScope(
    layerMessagePortRpcClient(channel.port2),
    clientScope,
  );
  const client = yield* RpcClient.make(Probe).pipe(
    Effect.provide(protocol),
    Effect.provideService(Scope.Scope, clientScope),
  );
  return { channel, client, clientScope, entered, interrupted, server };
});

describe("Effect RPC over a dedicated MessagePort", () => {
  it.live("forwards client interruption and ends the server when the client closes", () =>
    Effect.gen(function* () {
      const { channel, client, clientScope, entered, interrupted, server } = yield* connect();
      expect(yield* client.Echo({ value: "ping" })).toBe("ping");

      const waiting = yield* Effect.forkChild(client.Wait());
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(waiting);
      yield* Deferred.await(interrupted);

      yield* Scope.close(clientScope, Exit.void);
      yield* Fiber.await(server);
      for (const port of [channel.port1, channel.port2])
        for (const event of ["message", "messageerror", "close"])
          expect(port.listenerCount(event)).toBe(0);
    }),
  );

  it.live("fails pending and later client calls once the server port closes", () =>
    Effect.gen(function* () {
      const { channel, client, entered } = yield* connect();
      const waiting = yield* Effect.forkChild(Effect.flip(client.Wait()));
      yield* Deferred.await(entered);
      channel.port1.close();

      expect(yield* Fiber.join(waiting)).toBeInstanceOf(RpcClientError.RpcClientError);
      expect(yield* Effect.flip(client.Echo({ value: "late" }))).toBeInstanceOf(
        RpcClientError.RpcClientError,
      );
    }),
  );
});
