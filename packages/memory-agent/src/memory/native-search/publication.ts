import { Effect, Ref, Schema, Scope, Semaphore } from "effect";
import type { ReadAdmission } from "./client.ts";

export class PublicationFailed extends Schema.TaggedError<PublicationFailed>()(
  "PublicationFailed",
  {
    reason: Schema.Literals(["poisoned", "owner-mismatch"]),
  },
) {}

type PublicationState =
  | { readonly kind: "ready"; readonly generation: number }
  | { readonly kind: "poisoned"; readonly generation: number };

/**
 * One ephemeral gate per actual index owner; no additional writer or durable format.
 * Model/embedding work MUST run outside withMutation. A failed publication cannot
 * be read until explicit owner recovery creates a new gate/epoch.
 *
 * admitSnapshot holds the gate only for an actual native BEGIN/read-snapshot pin
 * acknowledgement, NOT queue enqueue or the complete search. The opt-in backend
 * binds read to NativeOwner.startRead; public MemorySearch integration is separate.
 */
export const makePublication = Effect.fn("NativePublication.make")(function* (epoch: string) {
  const gate = yield* Semaphore.make(1);
  const state = yield* Ref.make<PublicationState>({ kind: "ready", generation: 0 });

  const current = Effect.gen(function* () {
    const value = yield* Ref.get(state);
    switch (value.kind) {
      case "ready":
        return { epoch, generation: value.generation };
      case "poisoned":
        return yield* PublicationFailed.make({ reason: "poisoned" });
    }
  });

  function withMutation<A, E, R>(
    mutation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | PublicationFailed, R>;
  function withMutation<A, E, R, F>(
    mutation: Effect.Effect<A, E, R>,
    mapAdmissionError: (error: PublicationFailed) => F,
  ): Effect.Effect<A, E | F, R>;
  function withMutation<A, E, R, F>(
    mutation: Effect.Effect<A, E, R>,
    mapAdmissionError?: (error: PublicationFailed) => F,
  ) {
    return gate.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          // Map only this gate's admission error, never an identically-tagged callback error.
          const before = yield* current.pipe(
            Effect.mapError((error) =>
              mapAdmissionError === undefined ? error : mapAdmissionError(error),
            ),
          );
          const result = yield* Effect.exit(mutation);
          switch (result._tag) {
            case "Failure":
              yield* Ref.set<PublicationState>(state, {
                kind: "poisoned",
                generation: before.generation,
              });
              return yield* Effect.failCause(result.cause);
            case "Success":
              yield* Ref.set<PublicationState>(state, {
                kind: "ready",
                generation: before.generation + 1,
              });
              return result.value;
          }
        }),
      ),
    );
  }

  const admitSnapshot = <A, E, R>(
    pin: (publication: {
      readonly epoch: string;
      readonly generation: number;
    }) => Effect.Effect<A, E, R>,
  ) =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const publication = yield* current;
        return yield* pin(publication);
      }),
    );

  const read = <A, E, R>(
    start: (publication: { readonly epoch: string; readonly generation: number }) => Effect.Effect<
      {
        readonly epoch: string;
        readonly admission: Effect.Effect<ReadAdmission, E, R>;
        readonly result: Effect.Effect<A, E, R>;
      },
      E,
      R | Scope.Scope
    >,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const admitted = yield* admitSnapshot((publication) =>
          Effect.gen(function* () {
            const handle = yield* start(publication);
            if (handle.epoch !== publication.epoch)
              return yield* PublicationFailed.make({ reason: "owner-mismatch" });
            const admission = yield* handle.admission;
            return { publication, handle, admission };
          }),
        );
        // The permit has been released, but the actual read remains owned by this Scope.
        const result = yield* admitted.handle.result;
        return { publication: admitted.publication, admission: admitted.admission, result };
      }),
    );

  return { withMutation, admitSnapshot, read, inspect: Ref.get(state) };
});
