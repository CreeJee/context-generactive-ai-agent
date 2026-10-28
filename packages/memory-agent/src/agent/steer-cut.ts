import {
  Deferred,
  Effect,
  Exit,
  HashSet,
  Match,
  Option,
  Ref,
  Stream,
  SynchronizedRef,
} from "effect";
import { type LanguageModel, Response } from "effect/ai";

export interface SteerCut {
  /**
   * Ends the response streaming now as if the model had stopped there. False when no response is
   * streaming, or it has begun a tool call: that call must run, and the message joins the request
   * after it.
   */
  readonly cut: Effect.Effect<boolean>;
}

/** What the response being streamed has opened, as far as the run has received it. */
interface Opened {
  readonly cut: Deferred.Deferred<void>;
  readonly text: HashSet.HashSet<string>;
  readonly reasoning: HashSet.HashSet<string>;
  /** The response began a tool call, which must run. */
  readonly toolCall: boolean;
  readonly finished: boolean;
}

const openedBy = (opened: Opened, part: Response.AnyPart): Opened =>
  Match.value(part).pipe(
    Match.discriminators("type")({
      "text-start": ({ id }) => ({ ...opened, text: HashSet.add(opened.text, id) }),
      "text-end": ({ id }) => ({ ...opened, text: HashSet.remove(opened.text, id) }),
      "reasoning-start": ({ id }) => ({ ...opened, reasoning: HashSet.add(opened.reasoning, id) }),
      "reasoning-end": ({ id }) => ({
        ...opened,
        reasoning: HashSet.remove(opened.reasoning, id),
      }),
      "tool-params-start": () => ({ ...opened, toolCall: true }),
      "tool-call": () => ({ ...opened, toolCall: true }),
      finish: () => ({ ...opened, finished: true }),
    }),
    Match.orElse(() => opened),
  );

/** The parts that end a cut response: what it opened, closed, and a stop that reports no usage. */
const closing = (opened: Opened): ReadonlyArray<Response.AnyPart> => [
  ...[...opened.reasoning].map((id) => Response.makePart("reasoning-end", { id })),
  ...[...opened.text].map((id) => Response.makePart("text-end", { id })),
  Response.makePart("finish", {
    reason: "stop",
    usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }),
  }),
];

/**
 * Lets a steered message interrupt the answer: the run's model can stop its current response where
 * it is, closing what it opened, so the run completes and the steered message follows at once as
 * the next turn.
 */
export const steerCuttableModel = Effect.fnUntraced(function* (model: LanguageModel.LanguageModel) {
  const current = yield* Ref.make(Option.none<SynchronizedRef.SynchronizedRef<Opened>>());
  const cuttable = <E, R>(parts: Stream.Stream<Response.AnyPart, E, R>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cut = yield* Deferred.make<void>();
        const opened = yield* SynchronizedRef.make<Opened>({
          cut,
          text: HashSet.empty(),
          reasoning: HashSet.empty(),
          toolCall: false,
          finished: false,
        });
        return parts.pipe(
          Stream.interruptWhen(Deferred.await(cut)),
          // Tracked once received, so a cut closes exactly what the run has.
          Stream.tap((part) => SynchronizedRef.update(opened, (was) => openedBy(was, part))),
          Stream.concat(
            Stream.unwrap(
              Effect.zipWith(Deferred.isDone(cut), SynchronizedRef.get(opened), (wasCut, was) =>
                wasCut && !was.finished ? Stream.fromIterable(closing(was)) : Stream.empty,
              ),
            ),
          ),
          Stream.onStart(Ref.set(current, Option.some(opened))),
          Stream.ensuring(
            Ref.update(
              current,
              Option.filter((streaming) => streaming !== opened),
            ),
          ),
        );
      }),
    );
  const steer: SteerCut = {
    cut: Effect.flatMap(
      Ref.get(current),
      Option.match({
        onNone: () => Effect.succeed(false),
        // Decided under the response's lock, so no tool call starts between the check and the cut.
        onSome: (streaming) =>
          SynchronizedRef.modifyEffect(streaming, (was) =>
            !was.toolCall && !was.finished
              ? Effect.map(Deferred.done(was.cut, Exit.void), (cut) => [cut, was] as const)
              : Effect.succeed([false, was] as const),
          ),
      }),
    ),
  };
  return {
    // SAFETY: the parts pass through unchanged; a cut adds only ends of what the response opened
    // and a finish, which every request's part type has.
    model: {
      ...model,
      streamText: ((options: Parameters<LanguageModel.LanguageModel["streamText"]>[0]) =>
        cuttable(model.streamText(options))) as LanguageModel.LanguageModel["streamText"],
    },
    steer,
  };
});
