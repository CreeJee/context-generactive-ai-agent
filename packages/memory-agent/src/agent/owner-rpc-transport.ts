import type { MessagePort } from "node:worker_threads";
import { Context, Effect, Exit, Schema, Scope } from "effect";
import {
  // Pure protocol endpoint, not an Effect service constructor; owner supplies authority/ledger.
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports
  makeOwnerRpcEffect,
  type OwnerRpcEffectOptions,
  type OwnerRpcEffectHandlers,
  type OwnerRpcHandlers,
  type OwnerRpcCapability,
  type OwnerRpcLedger,
  type OwnerRpcOperations,
  type OwnerRpcRequest,
  type OwnerRpcReply,
} from "./owner-rpc.ts";

const id = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const capability = Schema.Struct({
  sessionId: Schema.String,
  runId: Schema.String,
  goalInstanceId: Schema.String,
  goalVersion: id,
  planVersion: Schema.NullOr(id),
  workflowRevisionId: id,
  generation: Schema.String,
  token: Schema.String,
});
const requestSchema = Schema.Struct({
  type: Schema.Literal("owner-rpc-request"),
  capability,
  operationId: id,
  operation: Schema.String,
  input: Schema.Json,
});
const replySchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("succeeded"), operationId: id, output: Schema.Json }),
  Schema.Struct({ type: Schema.Literal("pending"), operationId: id }),
  Schema.Struct({ type: Schema.Literal("uncertain"), operationId: id }),
  Schema.Struct({
    type: Schema.Literal("rejected"),
    operationId: id,
    reason: Schema.Literals([
      "unauthorized",
      "invalid_operation",
      "operation_conflict",
      "non_monotonic",
      "uncertain_run",
    ]),
  }),
]);
const requestFrame = Schema.Struct({
  type: Schema.Literal("request"),
  requestId: id,
  request: requestSchema,
});
const replyFrame = Schema.Struct({
  type: Schema.Literal("reply"),
  requestId: id,
  reply: replySchema,
});
const decodeRequest = Schema.decodeUnknownSync(requestFrame);
const decodeReply = Schema.decodeUnknownSync(replyFrame);

/** No frame contents or decoder errors are exposed: capabilities contain secrets. */
export class OwnerRpcTransportError extends Error {
  constructor(readonly reason: "closed" | "cancelled" | "protocol" | "send_failed") {
    super(`Owner RPC transport ${reason}; dispatched effects may be uncertain`);
    this.name = "OwnerRpcTransportError";
  }
}

/** A dedicated trusted owner port, not a UI channel. Never automatically retries. */
export function makeOwnerRpcPortClient<M extends OwnerRpcOperations>(port: MessagePort) {
  let closed = false;
  let nextId = 0;
  const pending = new Map<
    number,
    {
      operationId: number;
      resolve: (reply: OwnerRpcReply) => void;
      reject: (error: Error) => void;
      cleanup: () => void;
    }
  >();
  // Cancelled requests may still complete. Keep correlation, never reuse their IDs.
  const abandoned = new Map<number, number>();
  const close = (reason: OwnerRpcTransportError["reason"] = "closed") => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      entry.cleanup();
      entry.reject(new OwnerRpcTransportError(reason));
    }
    pending.clear();
    abandoned.clear();
    port.off("message", onMessage);
    port.off("close", onClose);
    port.off("messageerror", onError);
    port.close();
  };
  const onClose = () => close();
  const onError = () => close("protocol");
  // MessagePort is the untrusted I/O boundary; decode immediately, never expose raw data.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  const onMessage = (raw: unknown) => {
    try {
      const frame = decodeReply(raw);
      const entry = pending.get(frame.requestId);
      if (!entry) {
        if (abandoned.get(frame.requestId) !== frame.reply.operationId) return close("protocol");
        abandoned.delete(frame.requestId);
        return;
      }
      if (entry.operationId !== frame.reply.operationId) return close("protocol");
      pending.delete(frame.requestId);
      entry.cleanup();
      entry.resolve(frame.reply);
    } catch {
      close("protocol");
    }
  };
  port.on("message", onMessage);
  port.on("close", onClose);
  port.on("messageerror", onError);
  port.start();
  return {
    close,
    request(request: OwnerRpcRequest<M>, signal?: AbortSignal): Promise<OwnerRpcReply> {
      if (closed) return Promise.reject(new OwnerRpcTransportError("closed"));
      if (signal?.aborted) return Promise.reject(new OwnerRpcTransportError("cancelled"));
      if (nextId === Number.MAX_SAFE_INTEGER) {
        close("protocol");
        return Promise.reject(new OwnerRpcTransportError("protocol"));
      }
      const requestId = ++nextId;
      return new Promise((resolve, reject) => {
        let frame: ReturnType<typeof decodeRequest>;
        try {
          // Capture both wire data and correlation before retaining any callbacks.
          frame = decodeRequest(structuredClone({ type: "request", requestId, request }));
        } catch {
          close("send_failed");
          reject(new OwnerRpcTransportError("send_failed"));
          return;
        }
        const operationId = frame.request.operationId;
        const cancel = () => {
          pending.delete(requestId);
          abandoned.set(requestId, operationId);
          cleanup();
          reject(new OwnerRpcTransportError("cancelled"));
        };
        const cleanup = () => signal?.removeEventListener("abort", cancel);
        pending.set(requestId, { operationId, resolve, reject, cleanup });
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          port.postMessage(frame);
        } catch {
          close("send_failed");
        }
      });
    },
  };
}

/** Native scoped endpoint. Closing interrupts admitted fibers, never rolls back receipts. */
const acquireOwnerRpcPort = Effect.fn("OwnerRpcPort.acquire")(function* <
  M extends OwnerRpcOperations,
  E = never,
  R = never,
>(port: MessagePort, options: OwnerRpcEffectOptions<M, E, R>, legacyAwaitSettlement: boolean) {
  const context = yield* Effect.context<R>();
  const tasks = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const run = Effect.runForkWith(context);
  const rpc = makeOwnerRpcEffect(options);
  let closed = false;
  const detach = () => {
    if (closed) return;
    closed = true;
    port.off("message", onMessage);
    port.off("close", onClose);
    port.off("messageerror", onError);
    port.close();
  };
  const close = Effect.sync(detach).pipe(Effect.andThen(Scope.close(tasks, Exit.void)));
  const onClose = () => {
    run(close);
  };
  const onError = () => {
    run(close);
  };
  // Node callback boundary only; execution fibers belong to the endpoint scope.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  const onMessage = (raw: unknown) => {
    const dispatch = Effect.try({
      try: () => decodeRequest(raw),
      catch: () => new OwnerRpcTransportError("protocol"),
    }).pipe(
      Effect.flatMap((frame) =>
        Effect.suspend(() => {
          if (closed) return Effect.void;
          // SAFETY: full JSON frame validated; owner validates operation-specific input.
          const execution = rpc(frame.request as OwnerRpcRequest<M>);
          // Legacy SDK work cannot be cancelled: retain its actual durable outcome.
          // Only native handlers allow interruption to leave an admitted pending receipt.
          return (legacyAwaitSettlement ? Effect.uninterruptible(execution) : execution).pipe(
            Effect.mapError(() => new OwnerRpcTransportError("protocol")),
            Effect.flatMap((reply) =>
              Effect.try({
                try: () => {
                  if (!closed)
                    port.postMessage(
                      decodeReply({
                        type: "reply",
                        requestId: frame.requestId,
                        reply,
                      }),
                    );
                },
                catch: () => new OwnerRpcTransportError("send_failed"),
              }),
            ),
          );
        }),
      ),
      // Never expose raw infrastructure causes (including capabilities) to the port.
      Effect.catchCause(() =>
        Effect.sync(() => {
          detach();
          run(Scope.close(tasks, Exit.void));
        }),
      ),
    );
    run(Effect.forkIn(dispatch, tasks));
  };
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        port.on("message", onMessage);
        port.on("close", onClose);
        port.on("messageerror", onError);
        port.start();
      },
      catch: () => new OwnerRpcTransportError("protocol"),
    }).pipe(Effect.onError(() => close)),
    () => close,
  );
  return { close };
});

export const serveOwnerRpcPortEffect = <M extends OwnerRpcOperations, E = never, R = never>(
  port: MessagePort,
  options: OwnerRpcEffectOptions<M, E, R>,
) => acquireOwnerRpcPort(port, options, false);

/** Synchronous full-loop adapter; Promise handlers cannot reverse dispatched external work. */
export function serveOwnerRpcPort<M extends OwnerRpcOperations>(
  port: MessagePort,
  options: {
    readonly permits: (capability: OwnerRpcCapability) => boolean;
    readonly permitsFinalization?: (capability: OwnerRpcCapability) => boolean;
    readonly ledger: OwnerRpcLedger;
    readonly handlers: OwnerRpcHandlers<M>;
  },
) {
  // SAFETY: operation input/output pairing is unchanged at this legacy SDK boundary.
  const handlers = Object.fromEntries(
    Object.entries(options.handlers).map(([key, handler]) => [
      key,
      {
        ...handler,
        execute: (input: M[keyof M]["input"], claim: OwnerRpcCapability) =>
          Effect.tryPromise(() => handler.execute(input, claim)),
      },
    ]),
  ) as OwnerRpcEffectHandlers<M, unknown>;
  const scope = Scope.makeUnsafe();
  const context = Context.make(Scope.Scope, scope);
  try {
    const endpoint = Effect.runSync(
      Effect.provide(
        acquireOwnerRpcPort(
          port,
          {
            ...options,
            handlers,
          },
          true,
        ),
        context,
      ),
    );
    return {
      close: () => {
        // Callback runtime starts detach immediately. Closure joins native fibers or
        // waits for already-dispatched legacy Promises to persist their real outcome.
        Effect.runFork(endpoint.close.pipe(Effect.andThen(Scope.close(scope, Exit.void))));
      },
    };
  } catch {
    Effect.runFork(Scope.close(scope, Exit.void));
    throw new OwnerRpcTransportError("protocol");
  }
}
