import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import type { Readable } from "node:stream";
import { HashMap, Ref, Option, Context, Deferred, Effect, Layer, Schema, Stream } from "effect";
import { HarnessProfile } from "./contracts.ts";
import { ProviderId } from "../providers/contracts.ts";

export const WorkerInput = Schema.Struct({
  kind: Schema.Literal("initialize"),
  profile: HarnessProfile,
  model: Schema.String,
  provider: ProviderId,
  reasoningEffort: Schema.String,
  split: Schema.Literals(["evolve", "validation", "sealed", "smoke"]),
});
const Reply = Schema.Struct({
  kind: Schema.Literal("response"),
  id: Schema.String,
  body: Schema.String,
  ok: Schema.Boolean,
});
const Incoming = Schema.Union([WorkerInput, Reply]);
export class GatewayClosed extends Schema.TaggedError<GatewayClosed>()("GatewayClosed", {}) {}
export type GatewayRequest = { kind: "request" | "subscription-request"; id: string; body: string };

export const makeWorkerGateway = Effect.fn("Rrsi.makeWorkerGateway")(function* (
  input: Readable,
  send: (request: GatewayRequest) => void,
) {
  const initialized = yield* Deferred.make<typeof WorkerInput.Type, GatewayClosed>();
  const pending = yield* Ref.make(
    HashMap.empty<string, Deferred.Deferred<string, GatewayClosed>>(),
  );
  let closed = false;
  const lines = yield* Effect.acquireRelease(
    Effect.sync(() => createInterface({ input })),
    (reader) => Effect.sync(() => reader.close()),
  );
  const close = Effect.gen(function* () {
    closed = true;
    yield* Deferred.fail(initialized, GatewayClosed.make());
    const replies = yield* Ref.getAndSet(pending, HashMap.empty());
    yield* Effect.forEach(HashMap.values(replies), (reply) =>
      Deferred.fail(reply, GatewayClosed.make()),
    );
  });
  yield* Stream.fromAsyncIterable(lines, () => GatewayClosed.make()).pipe(
    Stream.runForEach(
      Effect.fnUntraced(function* (line) {
        const frame = yield* Schema.decodeEffect(Schema.fromJsonString(Incoming))(line);
        switch (frame.kind) {
          case "initialize":
            yield* Deferred.succeed(initialized, frame);
            break;
          case "response": {
            const reply = Option.getOrUndefined(HashMap.get(yield* Ref.get(pending), frame.id));
            if (isTruthy(reply)) {
              if (frame.ok) yield* Deferred.succeed(reply, frame.body);
              else yield* Deferred.fail(reply, GatewayClosed.make());
            }
            break;
          }
        }
      }),
    ),
    Effect.onExit(() => close),
    Effect.ignore,
    Effect.forkScoped({ uninterruptible: false, startImmediately: true }),
  );
  const request = Effect.fn("Rrsi.workerRequest")(function* (
    kind: GatewayRequest["kind"],
    body: string,
  ) {
    const id = randomUUID();
    const reply = yield* Deferred.make<string, GatewayClosed>();
    return yield* Effect.gen(function* () {
      yield* Ref.update(pending, (requests) => HashMap.set(requests, id, reply));
      yield* Effect.suspend(() =>
        closed
          ? Effect.fail(GatewayClosed.make())
          : Effect.try({
              try: () => {
                send({ kind, id, body });
              },
              catch: () => GatewayClosed.make(),
            }),
      );
      return yield* Deferred.await(reply);
    }).pipe(Effect.ensuring(Ref.update(pending, (requests) => HashMap.remove(requests, id))));
  });
  return { input: Deferred.await(initialized), request };
});
export class WorkerGateway extends Context.Service<
  WorkerGateway,
  Effect.Success<ReturnType<typeof makeWorkerGateway>>
>()("memory-agent/rrsi/worker-gateway/WorkerGateway") {
  static layer(input: Readable, send: (request: GatewayRequest) => void) {
    return Layer.effect(WorkerGateway, makeWorkerGateway(input, send));
  }
}
