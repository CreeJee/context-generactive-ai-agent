import { Deferred, Effect, Fiber, Logger, Option, Schema } from "effect";
import { expect, it } from "vite-plus/test";
import { makePublication, PublicationFailed, PublicationState } from "./publication.ts";
import { ReadAdmission } from "./client.ts";

class SaveFailed extends Schema.TaggedError<SaveFailed, { readonly brand: unique symbol }>()(
  "SaveFailed",
  {},
) {}

it("maps only gate admission errors and preserves identically-tagged callback failures", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const publication = yield* makePublication("callback-owner");
      const callbackFailure = PublicationFailed.make({ reason: "owner-mismatch" });
      const mapped = SaveFailed.make();
      expect(
        yield* Effect.flip(publication.withMutation(Effect.fail(callbackFailure), () => mapped)),
      ).toBe(callbackFailure);
      expect(yield* Effect.flip(publication.withMutation(Effect.void, () => mapped))).toBe(mapped);
    }),
  ));

it("releases admission permit before full result and binds owner/generation", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const publication = yield* makePublication("one");
        const entered = yield* Deferred.make<void>();
        const pin = yield* Deferred.make<ReadAdmission>();
        const result = yield* Deferred.make<number>();
        const attempted = yield* Deferred.make<void>();
        const mutated = yield* Deferred.make<void>();
        const reading = yield* Effect.forkScoped(
          publication.read(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              return {
                epoch: "one",
                admission: Deferred.await(pin),
                result: Deferred.await(result),
              };
            }),
          ),
        );
        yield* Deferred.await(entered);
        const writing = yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* Deferred.succeed(attempted, undefined);
            yield* publication.withMutation(Deferred.succeed(mutated, undefined));
          }),
        );
        yield* Deferred.await(attempted);
        expect(Option.isNone(yield* Deferred.poll(mutated))).toBe(true);
        yield* Deferred.succeed(pin, ReadAdmission.pinned());
        yield* Deferred.await(mutated);
        expect(Option.isNone(yield* Deferred.poll(result))).toBe(true);
        yield* Fiber.join(writing);
        yield* Deferred.succeed(result, 42);
        expect(yield* Fiber.join(reading)).toEqual({
          publication: { epoch: "one", generation: 0 },
          admission: ReadAdmission.pinned(),
          result: 42,
        });
        expect(yield* publication.inspect).toEqual(PublicationState.ready({ generation: 1 }));
        expect(
          yield* Effect.flip(
            publication.read(() =>
              Effect.succeed({
                epoch: "other",
                admission: Effect.succeed(ReadAdmission.pinned()),
                result: Effect.succeed(0),
              }),
            ),
          ),
        ).toMatchObject({ reason: "owner-mismatch" });
      }),
    ).pipe(Effect.timeout("2 seconds")),
  ));

it("holds mutation until actual snapshot pin ack, advances generation and stops after a failed publication", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const publication = yield* makePublication("owner-one");
        const entered = yield* Deferred.make<{
          readonly epoch: string;
          readonly generation: number;
        }>();
        const acknowledge = yield* Deferred.make<void>();
        const mutated = yield* Deferred.make<void>();
        const attempted = yield* Deferred.make<void>();
        const read = yield* Effect.forkScoped(
          publication.admitSnapshot((state) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, state);
              yield* Deferred.await(acknowledge);
              return state;
            }),
          ),
        );
        expect(yield* Deferred.await(entered)).toEqual({ epoch: "owner-one", generation: 0 });
        const mutation = yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* Deferred.succeed(attempted, undefined);
            yield* publication.withMutation(Deferred.succeed(mutated, undefined));
          }),
        );
        yield* Deferred.await(attempted);
        expect(Option.isNone(yield* Deferred.poll(mutated))).toBe(true);
        yield* Deferred.succeed(acknowledge, undefined);
        expect(yield* Fiber.join(read)).toEqual({ epoch: "owner-one", generation: 0 });
        yield* Fiber.join(mutation);
        expect(yield* publication.admitSnapshot(Effect.succeed)).toEqual({
          epoch: "owner-one",
          generation: 1,
        });
        expect(
          yield* Effect.flip(publication.withMutation(Effect.fail(SaveFailed.make()))),
        ).toBeInstanceOf(SaveFailed);
        expect(yield* publication.inspect).toEqual(PublicationState.stopped({ generation: 1 }));
        expect(yield* Effect.flip(publication.admitSnapshot(Effect.succeed))).toMatchObject({
          reason: "stopped",
        });
        expect(yield* Effect.flip(publication.withMutation(Effect.void))).toMatchObject({
          reason: "stopped",
        });
        const recovered = yield* makePublication("owner-two");
        expect(yield* recovered.admitSnapshot(Effect.succeed)).toEqual({
          epoch: "owner-two",
          generation: 0,
        });
      }),
    ).pipe(Effect.timeout("2 seconds")),
  ));

class FlushFailed extends Schema.TaggedError<FlushFailed, { readonly brand: unique symbol }>()(
  "FlushFailed",
  { cause: Schema.optional(Schema.Defect()) },
) {}

it("logs the failure that stops the gate once, by its tag and cause chain", () => {
  const logs: Array<{ readonly level: string; readonly message: unknown }> = [];
  const capture = Logger.make((log) => {
    logs.push(Logger.formatStructured.log(log));
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      const publication = yield* makePublication("logged");
      yield* Effect.flip(
        publication.withMutation(Effect.fail(FlushFailed.make({ cause: SaveFailed.make() }))),
      );
      yield* Effect.flip(publication.withMutation(Effect.void));
      expect(logs).toEqual([
        {
          ...logs[0],
          level: "WARN",
          message: [
            "Vector index stopped after a failed update",
            { error: "FlushFailed", cause: "SaveFailed" },
          ],
        },
      ]);
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([capture]))),
  );
});
