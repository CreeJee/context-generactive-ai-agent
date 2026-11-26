import { Context, Data, Effect, Exit, Layer, Ref, Schema, Semaphore } from "effect";
import { NativeOwner } from "./client.ts";

export class PublicationFailed extends Schema.TaggedError<
  PublicationFailed,
  { readonly brand: unique symbol }
>()("PublicationFailed", {
  reason: Schema.Literals(["stopped"]),
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
 * Only updates take the gate, so they run one at a time. A read takes no permit: it checks every
 * hit against its own SQLite snapshot, so a vector added before its rows are committed is dropped
 * there, and a read never waits for an update (docs/vector-index-design.md, 6).
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

  /** Runs `run` unless the gate stopped, with the generation published when it started. */
  const read = <A, E, R>(run: Effect.Effect<A, E, R>) =>
    Effect.zipWith(current, run, (publication, result) => ({ publication, result }));

  return { withMutation, read, inspect: Ref.get(state) };
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
