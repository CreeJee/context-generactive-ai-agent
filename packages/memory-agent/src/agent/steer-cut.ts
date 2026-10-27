import { Deferred, Effect, Exit, HashSet, Match, MutableRef, Option, Stream } from "effect";
import { type LanguageModel, Response } from "effect/ai";

export interface SteerCut {
  /**
   * Ends the response streaming now as if the model had stopped there. False when no response is
   * streaming, or it has begun a tool call: that call must run, and the message joins the request
   * after it.
   */
  readonly cut: () => boolean;
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
export const steerCuttableModel = (model: LanguageModel.LanguageModel) => {
  const current = MutableRef.make(Option.none<MutableRef.MutableRef<Opened>>());
  const cuttable = <E, R>(parts: Stream.Stream<Response.AnyPart, E, R>) =>
    Stream.suspend(() => {
      const opened = MutableRef.make<Opened>({
        cut: Deferred.makeUnsafe<void>(),
        text: HashSet.empty(),
        reasoning: HashSet.empty(),
        toolCall: false,
        finished: false,
      });
      const { cut } = MutableRef.get(opened);
      return parts.pipe(
        Stream.interruptWhen(Deferred.await(cut)),
        // Tracked once received, so a cut closes exactly what the run has.
        Stream.tap((part) =>
          Effect.sync(() => MutableRef.update(opened, (was) => openedBy(was, part))),
        ),
        Stream.concat(
          Stream.suspend(() =>
            Deferred.isDoneUnsafe(cut) && !MutableRef.get(opened).finished
              ? Stream.fromIterable(closing(MutableRef.get(opened)))
              : Stream.empty,
          ),
        ),
        Stream.onStart(Effect.sync(() => MutableRef.set(current, Option.some(opened)))),
        Stream.ensuring(
          Effect.sync(() =>
            MutableRef.update(
              current,
              Option.filter((streaming) => streaming !== opened),
            ),
          ),
        ),
      );
    });
  const steer: SteerCut = {
    cut: () =>
      Option.exists(MutableRef.get(current), (streaming) => {
        const { cut, toolCall, finished } = MutableRef.get(streaming);
        return !toolCall && !finished && Deferred.doneUnsafe(cut, Exit.void);
      }),
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
};
