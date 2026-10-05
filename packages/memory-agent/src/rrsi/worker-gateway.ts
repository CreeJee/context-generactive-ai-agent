import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { Context, Deferred, Effect, Layer, Schema, Stream } from "effect";
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
  const pending = new Map<string, Deferred.Deferred<string, GatewayClosed>>();
  let closed = false;
  const lines = yield* Effect.acquireRelease(
    Effect.sync(() => createInterface({ input })),
    (reader) => Effect.sync(() => reader.close()),
  );
  const close = Effect.gen(function* () {
    closed = true;
    yield* Deferred.fail(initialized, new GatewayClosed());
    yield* Effect.forEach(pending.values(), (reply) => Deferred.fail(reply, new GatewayClosed()));
    pending.clear();
  });
  yield* Stream.fromAsyncIterable(lines, () => new GatewayClosed()).pipe(
    Stream.runForEach(
      Effect.fnUntraced(function* (line) {
        const frame = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Incoming))(line);
        switch (frame.kind) {
          case "initialize":
            yield* Deferred.succeed(initialized, frame);
            break;
          case "response": {
            const reply = pending.get(frame.id);
            if (reply) {
              if (frame.ok) yield* Deferred.succeed(reply, frame.body);
              else yield* Deferred.fail(reply, new GatewayClosed());
            }
            break;
          }
        }
      }),
    ),
    Effect.onExit(() => close),
    Effect.catch(() => Effect.void),
    Effect.forkScoped({ uninterruptible: false, startImmediately: true }),
  );
  const request = Effect.fn("Rrsi.workerRequest")(function* (
    kind: GatewayRequest["kind"],
    body: string,
  ) {
    const id = randomUUID();
    const reply = yield* Deferred.make<string, GatewayClosed>();
    return yield* Effect.gen(function* () {
      yield* Effect.suspend(() =>
        closed
          ? Effect.fail(new GatewayClosed())
          : Effect.try({
              try: () => {
                pending.set(id, reply);
                send({ kind, id, body });
              },
              catch: () => new GatewayClosed(),
            }),
      );
      return yield* Deferred.await(reply);
    }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
  });
  return { input: Deferred.await(initialized), request };
});
export class WorkerGateway extends Context.Service<
  WorkerGateway,
  Effect.Success<ReturnType<typeof makeWorkerGateway>>
>()("memory-agent/rrsi/WorkerGateway") {
  static layer(input: Readable, send: (request: GatewayRequest) => void) {
    return Layer.effect(WorkerGateway, makeWorkerGateway(input, send));
  }
}
