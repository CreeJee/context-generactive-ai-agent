import { Data, Deferred, Effect, Fiber, HashSet, Match, Ref, type Scope } from "effect";
import type { JsonValue } from "../json.ts";
import { readOnlyToolNames } from "../tools/effects.ts";
import { failureResult, ToolFailed } from "../tools/failure.ts";

/**
 * Runs the tool calls of one model step (docs/effect-ai-migration.md "도구 실행 방식"). The calls of a
 * step have no order between them (decisions.md "도구 호출 사이에 순서를 두지 않는다 (2026-10-27)"):
 * a read starts as soon as the gates admit it, and a write once the step's response finished
 * completely, without waiting for any other call. A call already running is never cut because of
 * the response; only interrupting the step (the user's cancel) stops it.
 */

/** One tool call of a model step, as the model made it. */
export interface StepCall {
  readonly id: string;
  readonly name: string;
  /** The arguments the call runs with: as the model sent them, or as the user edited them. */
  readonly params: JsonValue;
}

/** What a call answers the model with, or the user's decision it waits for. */
export type CallOutcome<Request> = Data.TaggedEnum<{
  Returned: { readonly result: JsonValue };
  /**
   * The tool ran and failed. `result` is what the model reads; `error` is the stored tool message's
   * error, the code the result gives; `message` is the failure as recorded and shown.
   */
  Failed: { readonly result: JsonValue; readonly error: string; readonly message: string };
  /**
   * The call was refused before its tool ran, and is shown as failed like {@link Failed}. `error`
   * is the reason the result gives.
   */
  Refused: { readonly result: JsonValue; readonly error: string };
  Waiting: { readonly request: Request };
}>;
interface CallOutcomeDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: CallOutcome<this["A"]>;
}
export const CallOutcome = Data.taggedEnum<CallOutcomeDefinition>();

/** A call that got its answer, whether it ran or the gates answered for it. */
export type CallAnswer = Exclude<CallOutcome<never>, { readonly _tag: "Waiting" }>;

/** The gates let the call run. */
export interface Run {
  readonly _tag: "Run";
  readonly run: Effect.Effect<JsonValue, ToolFailed>;
}
export const Run = (run: Run["run"]): Run => ({ _tag: "Run", run });

/** What the gates decided for one call: run it, or its outcome without running it. */
export type Admission<Request> = Run | CallOutcome<Request>;

/** The answer to a write the step's incomplete response asked for: it never started. */
const responseIncomplete = ToolFailed.make({
  code: "response_incomplete",
  tag: "ResponseIncomplete",
  detail: "The response ended before it was complete, so this call did not run.",
});

const failedWith = (failure: ToolFailed): CallAnswer =>
  CallOutcome.Failed({
    result: failureResult(failure),
    error: failure.code,
    message: failure.message,
  });

const notStarted = CallOutcome.Refused({
  result: failureResult(responseIncomplete),
  error: responseIncomplete.code,
});

export interface StepScheduler<Request, E, R> {
  /**
   * Takes a call as the model makes it, with what the gates decide for it; the decision and the
   * run go on beside the response.
   */
  readonly offer: (
    call: StepCall,
    admission: Effect.Effect<Admission<Request>, E, R>,
  ) => Effect.Effect<void, never, R>;
  /**
   * The response ended, `complete` with a finish of `stop`, `tool-calls` or `pause`. Writes start,
   * or are answered as not run when it was not complete. Waits for every call and gives their
   * outcomes in call order; a failure of the gates or hooks fails it after all calls settled.
   */
  readonly settle: (complete: boolean) => Effect.Effect<ReadonlyArray<CallOutcome<Request>>, E>;
}

/** A scheduler for one step; its calls run in the scope, so closing it interrupts them. */
export const stepScheduler = Effect.fnUntraced(function* <Request, E, R>(options: {
  /** What follows an answered call, as soon as it has its answer. */
  readonly answered: (call: StepCall, answer: CallAnswer) => Effect.Effect<void, E, R>;
}): Effect.fn.Return<StepScheduler<Request, E, R>, never, Scope.Scope> {
  const scope = yield* Effect.scope;
  const finished = yield* Deferred.make<boolean>();
  const calls = yield* Ref.make<ReadonlyArray<Fiber.Fiber<CallOutcome<Request>, E>>>([]);

  const answerOf = (call: StepCall, run: Run["run"]) => {
    const ran = Effect.match(run, {
      onSuccess: (result): CallAnswer => CallOutcome.Returned({ result }),
      onFailure: failedWith,
    });
    return (
      HashSet.has(readOnlyToolNames, call.name)
        ? ran
        : Effect.flatMap(Deferred.await(finished), (complete) =>
            complete ? ran : Effect.succeed(notStarted),
          )
    ).pipe(Effect.tap((answer) => options.answered(call, answer)));
  };

  const outcomeOf = (call: StepCall) => (admission: Admission<Request>) =>
    Match.valueTags(admission, {
      Run: ({ run }) => answerOf(call, run),
      Returned: (answer) => Effect.as(options.answered(call, answer), answer),
      Failed: (answer) => Effect.as(options.answered(call, answer), answer),
      Refused: (answer) => Effect.as(options.answered(call, answer), answer),
      Waiting: Effect.succeed,
    });

  const offer = (call: StepCall, admission: Effect.Effect<Admission<Request>, E, R>) =>
    admission.pipe(
      Effect.flatMap(outcomeOf(call)),
      Effect.forkIn(scope),
      Effect.flatMap((fiber) => Ref.update(calls, (all) => [...all, fiber])),
    );

  const settle = (complete: boolean) =>
    Deferred.succeed(finished, complete).pipe(
      Effect.andThen(Ref.get(calls)),
      Effect.flatMap(Fiber.awaitAll),
      // Every call settled first; then the first failure in call order, if any, fails the step.
      Effect.flatMap(Effect.all),
    );

  return { offer, settle };
});
