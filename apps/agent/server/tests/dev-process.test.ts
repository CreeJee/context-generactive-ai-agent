// Native process/socket integration fixtures exercise actual exit and bind behavior.
import { createServer } from "node:net";
import { it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { expect } from "vite-plus/test";
import { assertPortAvailable } from "../../scripts/dev-process.ts";

it.live("occupied frontend/backend ports fail without disturbing the existing listener", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const host of ["127.0.0.1", "localhost"]) {
        const server = createServer();
        yield* Effect.addFinalizer(() =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          }),
        );
        yield* Effect.callback<void, Error>((resume) => {
          server.once("error", (error) => resume(Effect.fail(error)));
          server.listen(0, host, () => resume(Effect.void));
        });
        const { port } = Result.getOrThrow(
          Schema.decodeUnknownResult(Schema.Struct({ port: Schema.Int }))(server.address()),
        );
        const failure = yield* Effect.tryPromise(() =>
          assertPortAvailable(port, host, "Fixture"),
        ).pipe(Effect.flip);
        expect(String(failure.cause)).toContain(`port ${port}`);
        expect(server.listening).toBe(true);
        yield* Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
        });
        yield* Effect.tryPromise(() => assertPortAvailable(port, host, "Fixture"));
      }
    }),
  ),
);
