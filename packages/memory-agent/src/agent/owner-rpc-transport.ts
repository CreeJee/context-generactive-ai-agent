import type { MessagePort } from "node:worker_threads";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  HashMap,
  Option,
  Ref,
  Schema,
  Scope,
} from "effect";
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
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
// @effect-diagnostics-next-line schemaSync:off
const decodeRequest = Schema.decodeUnknownSync(requestFrame);
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
// @effect-diagnostics-next-line schemaSync:off
const decodeReply = Schema.decodeUnknownSync(replyFrame);

/** No frame contents or decoder errors are exposed: capabilities contain secrets. */
export class OwnerRpcTransportError extends Schema.TaggedError<OwnerRpcTransportError>()(
  "OwnerRpcTransportError",
  { reason: Schema.Literals(["closed", "cancelled", "protocol", "send_failed"]) },
) {
  override get message() {
    return `Owner RPC transport ${this.reason}; dispatched effects may be uncertain`;
  }
}

/** A dedicated trusted owner port, not a UI channel. Never automatically retries. */
export function makeOwnerRpcPortClient<M extends OwnerRpcOperations>(port: MessagePort) {
  let closed = false;
  let nextId = 0;
  type RequestState =
    | {
        readonly status: "pending";
        readonly operationId: number;
        readonly done: Deferred.Deferred<OwnerRpcReply, OwnerRpcTransportError>;
      }
    | { readonly status: "abandoned"; readonly operationId: number };
  const requests = Ref.makeUnsafe(HashMap.empty<number, RequestState>());
  const close = (reason: OwnerRpcTransportError["reason"] = "closed") => {
    if (closed) return;
    closed = true;
    const outstanding = Effect.runSync(Ref.getAndSet(requests, HashMap.empty()));
    for (const entry of HashMap.values(outstanding)) {
      switch (entry.status) {
        case "pending":
          Deferred.doneUnsafe(
            entry.done,
            Effect.fail(OwnerRpcTransportError.make({ reason: reason })),
          );
          break;
        case "abandoned":
          break;
      }
    }
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
      const entry = Effect.runSync(
        Ref.modify(requests, (entries) => {
          const found = Option.getOrUndefined(HashMap.get(entries, frame.requestId));
          return [
            found,
            found?.operationId === frame.reply.operationId
              ? HashMap.remove(entries, frame.requestId)
              : entries,
          ];
        }),
      );
      if (entry === undefined || entry.operationId !== frame.reply.operationId)
        return close("protocol");
      switch (entry.status) {
        case "pending":
          Deferred.doneUnsafe(entry.done, Effect.succeed(frame.reply));
          break;
        case "abandoned":
          break;
      }
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
      if (closed) return Promise.reject(OwnerRpcTransportError.make({ reason: "closed" }));
      if (signal?.aborted === true)
        return Promise.reject(OwnerRpcTransportError.make({ reason: "cancelled" }));
      if (nextId === Number.MAX_SAFE_INTEGER) {
        close("protocol");
        return Promise.reject(OwnerRpcTransportError.make({ reason: "protocol" }));
      }
      const requestId = ++nextId;
      const wait = Effect.gen(function* () {
        const frame = yield* Effect.try({
          try: () => decodeRequest(structuredClone({ type: "request", requestId, request })),
          catch: () => {
            close("send_failed");
            return OwnerRpcTransportError.make({ reason: "send_failed" });
          },
        });
        const operationId = frame.request.operationId;
        const done = yield* Deferred.make<OwnerRpcReply, OwnerRpcTransportError>();
        return yield* Effect.suspend(() =>
          closed
            ? Effect.fail(OwnerRpcTransportError.make({ reason: "closed" }))
            : Ref.update(requests, (entries) =>
                HashMap.set(entries, requestId, { status: "pending", operationId, done }),
              ).pipe(
                Effect.andThen(
                  Effect.try({
                    try: () => {
                      port.postMessage(frame);
                    },
                    catch: () => {
                      close("send_failed");
                      return OwnerRpcTransportError.make({ reason: "send_failed" });
                    },
                  }),
                ),
              ),
        ).pipe(
          Effect.andThen(Deferred.await(done)),
          // A cancelled request may still finish remotely. Retain only its wire correlation.
          Effect.onInterrupt(() =>
            Ref.update(requests, (entries) =>
              !closed && HashMap.has(entries, requestId)
                ? HashMap.set(entries, requestId, { status: "abandoned", operationId })
                : entries,
            ),
          ),
          Effect.ensuring(
            Ref.update(requests, (entries) =>
              Option.getOrUndefined(HashMap.get(entries, requestId))?.status === "pending"
                ? HashMap.remove(entries, requestId)
                : entries,
            ),
          ),
        );
      });
      return Effect.runPromiseExit(wait, signal === undefined ? undefined : { signal }).then(
        (exit) =>
          Exit.match(exit, {
            onSuccess: (reply) => reply,
            onFailure: (cause) => {
              throw Cause.hasInterrupts(cause)
                ? OwnerRpcTransportError.make({ reason: "cancelled" })
                : Cause.squash(cause);
            },
          }),
      );
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
      catch: () => OwnerRpcTransportError.make({ reason: "protocol" }),
    }).pipe(
      Effect.flatMap((frame) =>
        Effect.suspend(() => {
          if (closed) return Effect.void;
          // SAFETY: full JSON frame validated; owner validates operation-specific input.
          const execution = rpc(frame.request as OwnerRpcRequest<M>);
          // Legacy SDK work cannot be cancelled: retain its actual durable outcome.
          // Only native handlers allow interruption to leave an admitted pending receipt.
          return (legacyAwaitSettlement ? Effect.uninterruptible(execution) : execution).pipe(
            Effect.mapError(() => OwnerRpcTransportError.make({ reason: "protocol" })),
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
                catch: () => OwnerRpcTransportError.make({ reason: "send_failed" }),
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
      catch: () => OwnerRpcTransportError.make({ reason: "protocol" }),
    }).pipe(Effect.onError(() => close)),
    () => close,
  );
  return { close };
});

// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export const serveOwnerRpcPortEffect = <M extends OwnerRpcOperations, E = never, R = never>(
  port: MessagePort,
  options: OwnerRpcEffectOptions<M, E, R>,
) => acquireOwnerRpcPort(port, options, false);

/** Synchronous full-loop adapter; Promise handlers cannot reverse dispatched external work. */
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
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
    throw OwnerRpcTransportError.make({ reason: "protocol" });
  }
}
