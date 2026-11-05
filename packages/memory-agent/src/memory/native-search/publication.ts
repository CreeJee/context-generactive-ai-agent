import {
  Array as EffectArray,
  Cause,
  Data,
  Effect,
  Exit,
  Option,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { failureAnnotations, failureTags } from "../../runtime/logged-failures.ts";
import type { ReadAdmission } from "./client.ts";

const isTagged = Schema.is(Schema.Struct({ _tag: Schema.String }));

/**
 * The failure that poisoned a gate, by tag and cause chain only: causes can hold SQL or paths.
 * A failure without a tag (a defect, an interruption) is named by the cause's tags.
 */
const poisonAnnotations = (cause: Cause.Cause<unknown>) =>
  EffectArray.findFirst(cause.reasons, Cause.isFailReason).pipe(
    Option.map((reason) => reason.error),
    Option.filter(isTagged),
    Option.match({
      onSome: failureAnnotations,
      onNone: () => ({ error: failureTags(cause) }),
    }),
  );

export class PublicationFailed extends Schema.TaggedError<
  PublicationFailed,
  { readonly brand: unique symbol }
>()("PublicationFailed", {
  reason: Schema.Literals(["poisoned", "owner-mismatch"]),
}) {}

export type PublicationState = Data.TaggedEnum<{
  ready: { readonly generation: number };
  poisoned: { readonly generation: number };
}>;
export const PublicationState = Data.taggedEnum<PublicationState>();

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
  const state = yield* Ref.make<PublicationState>(PublicationState.ready({ generation: 0 }));

  const current = Effect.flatMap(
    Ref.get(state),
    PublicationState.$match({
      ready: ({ generation }) => Effect.succeed({ epoch, generation }),
      poisoned: () => Effect.fail(PublicationFailed.make({ reason: "poisoned" })),
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
                PublicationState.poisoned({ generation: before.generation }),
              ).pipe(
                // Every later read and mutation fails with `poisoned` until the owner is opened
                // again, so the failure that started it is logged here, once.
                Effect.andThen(
                  Effect.logWarning("Vector index publication poisoned", poisonAnnotations(cause)),
                ),
                Effect.andThen(Effect.failCause(cause)),
              ),
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
