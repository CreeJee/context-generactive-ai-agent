import { Context, Data, Effect, Exit, Layer, Ref, Schema, Scope, Semaphore } from "effect";
import { NativeOwner, type ReadAdmission } from "./client.ts";

export class PublicationFailed extends Schema.TaggedError<
  PublicationFailed,
  { readonly brand: unique symbol }
>()("PublicationFailed", {
  reason: Schema.Literals(["stopped", "owner-mismatch"]),
}) {}

/**
 * `stopped`: a mutation failed, so the index may no longer match the database. Reads and
 * mutations are refused until the owner is opened again, which reconciles the two.
 */
export type PublicationState = Data.TaggedEnum<{
  ready: { readonly generation: number };
  stopped: { readonly generation: number };
}>;
export const PublicationState = Data.taggedEnum<PublicationState>();

/**
 * One ephemeral gate per actual index owner; no additional writer or durable format.
 * Model/embedding work MUST run outside withMutation. A failed publication cannot
 * be read until explicit owner recovery creates a new gate/epoch. The gate does not log the
 * failure: the mutation's owner names it, since only it knows its errors.
 *
 * admitSnapshot holds the gate only for an actual native BEGIN/read-snapshot pin
 * acknowledgement, NOT queue enqueue or the complete search. The opt-in backend
 * binds read to NativeOwner.startRead; public MemorySearch integration is separate.
 */
export const makePublication = Effect.fn("NativePublication.make")(function* (epoch: string) {
  const gate = yield* Semaphore.make(1);
  const state = yield* Ref.make<PublicationState>(PublicationState.ready({ generation: 0 }));

  const current = Effect.flatMap(
    Ref.get(state),
    PublicationState.$match({
      ready: ({ generation }) => Effect.succeed({ epoch, generation }),
      stopped: () => Effect.fail(PublicationFailed.make({ reason: "stopped" })),
    }),
  );

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
          return yield* Exit.match(result, {
            onFailure: (cause) =>
              Ref.set<PublicationState>(
                state,
                PublicationState.stopped({ generation: before.generation }),
              ).pipe(Effect.andThen(Effect.failCause(cause))),
            onSuccess: (value) =>
              Ref.set<PublicationState>(
                state,
                PublicationState.ready({ generation: before.generation + 1 }),
              ).pipe(Effect.as(value)),
          });
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
            const handle = yield* start(publication).pipe(
              Effect.filterOrFail(
                (handle) => handle.epoch === publication.epoch,
                () => PublicationFailed.make({ reason: "owner-mismatch" }),
              ),
            );
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

/** The gate of the native owner in context: made with that owner, for its epoch only. */
export class NativePublication extends Context.Service<
  NativePublication,
  Effect.Success<ReturnType<typeof makePublication>>
>()("memory-agent/memory/native-search/publication/NativePublication") {
  static readonly layer = Layer.effect(
    NativePublication,
    Effect.flatMap(NativeOwner, (owner) => makePublication(owner.epoch)),
  );
}
