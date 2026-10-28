import { Effect, Function as EffectFunction, Schema } from "effect";
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const copyReportText: {
  (write: (text: string) => Promise<void>): (text: string) => ReturnType<typeof copyReportTextBody>;
} & typeof copyReportTextBody = EffectFunction.dual(2, copyReportTextBody);
/** The clipboard refused the text; the page only says the copy did not happen. */
class ClipboardWriteFailed extends Schema.TaggedError<
  ClipboardWriteFailed,
  { readonly brand: unique symbol }
>()("ClipboardWriteFailed", {}) {}
function copyReportTextBody(
  text: string,
  write: (text: string) => Promise<void>,
): Promise<boolean> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => write(text),
      catch: () => ClipboardWriteFailed.make({}),
    }).pipe(
      Effect.as(true),
      Effect.catchTag("ClipboardWriteFailed", () => Effect.succeed(false)),
    ),
  );
}
