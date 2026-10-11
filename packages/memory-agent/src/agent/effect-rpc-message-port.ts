import { Cause, Effect, Layer, Queue, Schema, Scope } from "effect";
import { RpcClient, RpcClientError, RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import type { MessagePort, Transferable } from "node:worker_threads";

const clientId = 0;
const inboundCapacity = 64;
const structuredCloneCodec: RpcSerialization.CodecFor = Schema.toCodecJson;

type TransportReason =
  | "buffer_overflow"
  | "closed"
  | "message_error"
  | "send_failed"
  | "setup_failed";

export class MessagePortTransportError extends Schema.TaggedError<MessagePortTransportError>()(
  "MessagePortTransportError",
  {
    reason: Schema.Literals([
      "buffer_overflow",
      "closed",
      "message_error",
      "send_failed",
      "setup_failed",
    ]),
  },
) {
  override get message() {
    return `Effect RPC MessagePort transport ${this.reason}`;
  }
}

const transportError = (reason: TransportReason) => MessagePortTransportError.make({ reason });

const rpcClientError = (error: MessagePortTransportError) =>
  RpcClientError.RpcClientError.make({
    reason: RpcClientError.RpcClientDefect.make({
      message: error.message,
      cause: error,
    }),
  });

interface PortBridge<A> {
  readonly inbound: Queue.Queue<A, MessagePortTransportError>;
  readonly isClosed: () => boolean;
  readonly send: <A>(
    value: A,
    transferables?: Parameters<RpcClient.Protocol["Service"]["send"]>[2],
  ) => Effect.Effect<void, MessagePortTransportError>;
  readonly close: Effect.Effect<void>;
}

const makePortBridge = <A>(
  port: MessagePort,
  onClose?: () => void,
): Effect.Effect<PortBridge<A>, MessagePortTransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const inbound = yield* Queue.bounded<A, MessagePortTransportError>(inboundCapacity);
    let closed = false;

    const finish = (reason: TransportReason) => {
      if (closed) return;
      closed = true;
      port.off("message", onMessage);
      port.off("close", handleClose);
      port.off("messageerror", handleMessageError);
      Queue.failCauseUnsafe(inbound, Cause.fail(transportError(reason)));
      onClose?.();
      port.close();
    };
    const onMessage = (message: A) => {
      if (!Queue.offerUnsafe(inbound, message)) finish("buffer_overflow");
    };
    const handleClose = () => finish("closed");
    const handleMessageError = () => finish("message_error");

    yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          port.on("message", onMessage);
          port.on("close", handleClose);
          port.on("messageerror", handleMessageError);
          port.start();
        },
        catch: () => {
          finish("setup_failed");
          return transportError("setup_failed");
        },
      }),
      () => Effect.sync(() => finish("closed")),
    );

    return {
      inbound,
      isClosed: () => closed,
      send: (value, transferables) =>
        Effect.try({
          try: () => {
            if (closed) throw transportError("closed");
            if (transferables === undefined) port.postMessage(value);
            else {
              // SAFETY: Node validates this Effect transfer list; unsupported entries become send_failed.
              port.postMessage(value, [...transferables] as Transferable[]);
            }
          },
          catch: (cause) =>
            Schema.is(MessagePortTransportError)(cause) ? cause : transportError("send_failed"),
        }),
      close: Effect.sync(() => finish("closed")),
    };
  });

export const makeMessagePortClientProtocol = (
  port: MessagePort,
): Effect.Effect<RpcClient.Protocol["Service"], MessagePortTransportError, Scope.Scope> =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse, clientIds) {
      const bridge = yield* makePortBridge<RpcMessage.FromServerEncoded>(port);

      yield* Queue.take(bridge.inbound).pipe(
        Effect.flatMap((message) =>
          Effect.forEach(clientIds, (activeClientId) => writeResponse(activeClientId, message), {
            discard: true,
          }),
        ),
        Effect.forever,
        Effect.catch((error) =>
          Effect.forEach(
            clientIds,
            (activeClientId) =>
              writeResponse(activeClientId, {
                _tag: "ClientProtocolError",
                error: rpcClientError(error),
              }),
            { discard: true },
          ),
        ),
        Effect.forkScoped,
      );

      return {
        send: (_activeClientId, request, transferables) =>
          bridge.send(request, transferables).pipe(Effect.mapError(rpcClientError)),
        supportsAck: true,
        supportsTransferables: true,
        codecFor: structuredCloneCodec,
      };
    }),
  );

export const layerMessagePortRpcClient = (
  port: MessagePort,
): Layer.Layer<RpcClient.Protocol, MessagePortTransportError> =>
  Layer.effect(RpcClient.Protocol)(makeMessagePortClientProtocol(port));

export const makeMessagePortServerProtocol = (
  port: MessagePort,
): Effect.Effect<RpcServer.Protocol["Service"], MessagePortTransportError, Scope.Scope> =>
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const disconnects = yield* Queue.make<number>();
      const bridge = yield* makePortBridge<RpcMessage.FromClientEncoded>(port, () => {
        Queue.offerUnsafe(disconnects, clientId);
      });

      yield* Queue.take(bridge.inbound).pipe(
        Effect.flatMap((message) => writeRequest(clientId, message)),
        Effect.forever,
        Effect.ignore,
        Effect.forkScoped,
      );

      return {
        disconnects,
        send: (_clientId, response, transferables) =>
          bridge.send(response, transferables).pipe(Effect.orDie),
        end: () => bridge.close,
        clientIds: Effect.sync(() => (bridge.isClosed() ? new Set<number>() : new Set([clientId]))),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: true,
        supportsSpanPropagation: true,
        supportsNotifications: true,
        codecFor: structuredCloneCodec,
      };
    }),
  );

export const layerMessagePortRpcServer = (
  port: MessagePort,
): Layer.Layer<RpcServer.Protocol, MessagePortTransportError> =>
  Layer.effect(RpcServer.Protocol)(makeMessagePortServerProtocol(port));
