import { Data, Effect, Function as EffectFunction } from "effect";
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const copyReportText: {
  (write: (text: string) => Promise<void>): (text: string) => ReturnType<typeof copyReportTextBody>;
} & typeof copyReportTextBody = EffectFunction.dual(2, copyReportTextBody);
class ClipboardWriteFailed extends Data.TaggedError("ClipboardWriteFailed")<{
  readonly cause: unknown;
}> {}
function copyReportTextBody(
  text: string,
  write: (text: string) => Promise<void>,
): Promise<boolean> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => write(text),
      catch: (cause) => new ClipboardWriteFailed({ cause }),
    }).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false })),
  );
}
