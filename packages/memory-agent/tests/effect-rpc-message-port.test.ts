import { Schema } from "effect";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { RpcClientError, type RpcMessage } from "effect/rpc";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { describe, expect } from "vite-plus/test";
import {
  makeMessagePortClientProtocol,
  makeMessagePortServerProtocol,
  MessagePortTransportError,
} from "../src/agent/effect-rpc-message-port.ts";

const nextMessage = <A>(port: MessagePort) =>
  Effect.callback<A>((resume) => {
    const listener = (message: A) => resume(Effect.succeed(message));
    port.once("message", listener);
    return Effect.sync(() => port.off("message", listener));
  });

const request = <A>(payload: A): RpcMessage.RequestEncoded => ({
  _tag: "Request",
  id: 1,
  tag: "echo",
  payload,
  headers: [],
});

const closeChannel = (channel: MessageChannel) =>
  Effect.sync(() => {
    channel.port1.close();
    channel.port2.close();
  });

describe("Effect RPC MessagePort protocol", () => {
  it.effect("bridges the client Protocol with structured clone and scoped cleanup", () =>
    Effect.gen(function* () {
      const channel = new MessageChannel();
      yield* Effect.addFinalizer(() => closeChannel(channel));
      const protocolScope = yield* Scope.make();
      const protocol = yield* makeMessagePortClientProtocol(channel.port1).pipe(
        Scope.provide(protocolScope),
      );
      const received = yield* Deferred.make<RpcMessage.FromServerEncoded>();
      yield* Effect.forkIn(
        protocol.run(17, (message) => Deferred.succeed(received, message)),
        protocolScope,
      );

      expect(protocol.supportsAck).toBe(true);
      expect(protocol.supportsTransferables).toBe(true);
      expect(channel.port1.listenerCount("message")).toBe(1);

      const transferred = new ArrayBuffer(8);
      const outbound = yield* Effect.forkChild(
        nextMessage<RpcMessage.RequestEncoded>(channel.port2),
      );
      yield* protocol.send(17, request(transferred), [transferred]);
      const posted = yield* Fiber.join(outbound);
      expect(posted._tag).toBe("Request");
      expect(posted.payload).toBeInstanceOf(ArrayBuffer);
      expect(transferred.byteLength).toBe(0);

      channel.port2.postMessage({ _tag: "Pong" } satisfies RpcMessage.FromServerEncoded);
      expect(yield* Deferred.await(received)).toEqual({ _tag: "Pong" });

      yield* Scope.close(protocolScope, Exit.void);
      expect(channel.port1.listenerCount("message")).toBe(0);
      expect(channel.port1.listenerCount("close")).toBe(0);
      expect(channel.port1.listenerCount("messageerror")).toBe(0);

      const closed = yield* Effect.exit(protocol.send(17, { _tag: "Ping" }));
      expect(Exit.isFailure(closed)).toBe(true);
      if (Exit.isFailure(closed)) {
        const error = Cause.squash(closed.cause);
        expect(error).toBeInstanceOf(RpcClientError.RpcClientError);
        if (Schema.is(RpcClientError.RpcClientError)(error)) {
          expect(error.reason._tag).toBe("RpcClientDefect");
          if (error.reason._tag === "RpcClientDefect") {
            expect(error.reason.cause).toBeInstanceOf(MessagePortTransportError);
          }
        }
      }
    }),
  );

  it.effect("bridges the server Protocol with one client id and scoped cleanup", () =>
    Effect.gen(function* () {
      const channel = new MessageChannel();
      yield* Effect.addFinalizer(() => closeChannel(channel));
      const protocolScope = yield* Scope.make();
      const protocol = yield* makeMessagePortServerProtocol(channel.port1).pipe(
        Scope.provide(protocolScope),
      );
      const received = yield* Deferred.make<readonly [number, RpcMessage.FromClientEncoded]>();
      yield* Effect.forkIn(
        protocol.run((id, message) => Deferred.succeed(received, [id, message])),
        protocolScope,
      );

      expect(protocol.supportsAck).toBe(true);
      expect(protocol.supportsTransferables).toBe(true);
      expect(yield* protocol.clientIds).toEqual(new Set([0]));

      channel.port2.postMessage(request({ value: "input" }));
      const [id, posted] = yield* Deferred.await(received);
      expect(id).toBe(0);
      expect(posted).toEqual(request({ value: "input" }));

      const transferred = new ArrayBuffer(8);
      const outbound = yield* Effect.forkChild(
        nextMessage<RpcMessage.FromServerEncoded>(channel.port2),
      );
      yield* protocol.send(0, { _tag: "Chunk", requestId: 1, values: [transferred] }, [
        transferred,
      ]);
      const response = yield* Fiber.join(outbound);
      expect(response._tag).toBe("Chunk");
      expect(transferred.byteLength).toBe(0);

      yield* Scope.close(protocolScope, Exit.void);
      expect(channel.port1.listenerCount("message")).toBe(0);
      expect(channel.port1.listenerCount("close")).toBe(0);
      expect(channel.port1.listenerCount("messageerror")).toBe(0);
      expect(yield* protocol.clientIds).toEqual(new Set());
    }),
  );
});
