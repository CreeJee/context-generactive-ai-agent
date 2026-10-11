// Native child-process and socket callbacks stay at this interoperability boundary.
import { createServer } from "node:net";
import { Data, Effect, Function as EffectFunction } from "effect";

class DevelopmentProcessError extends Data.TaggedError("DevelopmentProcessError")<{
  readonly message: string;
}> {}

export const assertPortAvailable: {
  (host: string, label: string): (port: number) => Promise<void>;
} & typeof assertPortAvailableBody = EffectFunction.dual(3, assertPortAvailableBody);
function assertPortAvailableBody(port: number, host: string, label: string) {
  return Effect.runPromise(
    Effect.callback<void, DevelopmentProcessError>((resume) => {
      const probe = createServer();
      const onError = (error: Error) =>
        resume(
          Effect.fail(
            new DevelopmentProcessError({
              message: `${label} port ${port} (${host}) is unavailable: ${error.message}. Stop the existing dev server or choose another port.`,
            }),
          ),
        );
      probe.once("error", onError);
      probe.listen(port, host, () =>
        probe.close((error) =>
          resume(
            error !== undefined
              ? Effect.fail(new DevelopmentProcessError({ message: error.message }))
              : Effect.void,
          ),
        ),
      );
      return Effect.sync(() => {
        probe.off("error", onError);
        if (probe.listening) probe.close();
      });
    }),
  );
}
