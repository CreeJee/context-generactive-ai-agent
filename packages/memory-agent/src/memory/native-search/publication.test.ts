import { Deferred, Effect, Fiber, Option, Schema } from "effect";
import { expect, it } from "vite-plus/test";
import { makePublication, PublicationFailed, PublicationState } from "./publication.ts";

class SaveFailed extends Schema.TaggedError<SaveFailed, { readonly brand: unique symbol }>()(
  "SaveFailed",
  {},
) {}

it("maps only gate admission errors and preserves identically-tagged callback failures", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const publication = yield* makePublication("callback-owner");
      const callbackFailure = PublicationFailed.make({ reason: "stopped" });
      const mapped = SaveFailed.make();
      expect(
        yield* Effect.flip(publication.withMutation(Effect.fail(callbackFailure), () => mapped)),
      ).toBe(callbackFailure);
      expect(yield* Effect.flip(publication.withMutation(Effect.void, () => mapped))).toBe(mapped);
    }),
  ));

it("reads beside an update in progress, and runs updates one at a time", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const publication = yield* makePublication("one");
        const updating = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const first = yield* Effect.forkScoped(
          publication.withMutation(
            Deferred.succeed(updating, undefined).pipe(Effect.andThen(Deferred.await(finish))),
          ),
        );
        yield* Deferred.await(updating);
        // The update has not finished: a read still runs, with the generation published so far.
        expect(yield* publication.read(Effect.succeed(42))).toEqual({
          publication: { epoch: "one", generation: 0 },
          result: 42,
        });
        const second = yield* Deferred.make<void>();
        const next = yield* Effect.forkScoped(
          publication.withMutation(Deferred.succeed(second, undefined)),
        );
        yield* Effect.yieldNow;
        expect(Option.isNone(yield* Deferred.poll(second))).toBe(true);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(next);
        expect(yield* publication.read(Effect.succeed(0))).toMatchObject({
          publication: { generation: 2 },
        });
      }),
    ).pipe(Effect.timeout("2 seconds")),
  ));

it("stops reads and updates after a failed update until a new owner", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const publication = yield* makePublication("owner-one");
      expect(
        yield* Effect.flip(publication.withMutation(Effect.fail(SaveFailed.make()))),
      ).toBeInstanceOf(SaveFailed);
      expect(yield* publication.inspect).toEqual(PublicationState.stopped({ generation: 0 }));
      expect(yield* Effect.flip(publication.read(Effect.succeed(0)))).toMatchObject({
        reason: "stopped",
      });
      expect(yield* Effect.flip(publication.withMutation(Effect.void))).toMatchObject({
        reason: "stopped",
      });
      const recovered = yield* makePublication("owner-two");
      expect(yield* recovered.read(Effect.succeed(0))).toMatchObject({
        publication: { epoch: "owner-two", generation: 0 },
      });
    }),
  ));
