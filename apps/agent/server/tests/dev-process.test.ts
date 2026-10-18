// Native socket integration fixtures exercise actual bind behavior.
import { NodeSocketServer } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Exit, Result, Schema, Scope } from "effect";
import { expect } from "vite-plus/test";
import { assertPortAvailable } from "../../scripts/dev-process.ts";

it.live("occupied frontend/backend ports fail without disturbing the existing listener", () =>
  Effect.gen(function* () {
    for (const host of ["127.0.0.1", "localhost"]) {
      const occupant = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(occupant, Exit.void));
      const server = yield* NodeSocketServer.make({ port: 0, host }).pipe(
        Effect.provideService(Scope.Scope, occupant),
      );
      const { port } = Result.getOrThrow(
        Schema.decodeUnknownResult(Schema.Struct({ port: Schema.Int }))(server.address),
      );
      const failure = yield* assertPortAvailable(port, host, "Fixture").pipe(Effect.flip);
      expect(failure.message).toContain(`port ${port}`);
      // The failed probe left the occupant bound.
      yield* assertPortAvailable(port, host, "Fixture").pipe(Effect.flip);
      yield* Scope.close(occupant, Exit.void);
      yield* assertPortAvailable(port, host, "Fixture");
    }
  }).pipe(Effect.scoped),
);
