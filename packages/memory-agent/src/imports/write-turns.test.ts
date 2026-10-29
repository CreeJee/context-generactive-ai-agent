import { Deferred, Effect, Fiber, Stream } from "effect";
import { expect } from "vite-plus/test";
import { layer } from "@effect/vitest";
import { WriteTurns } from "./write-turns.ts";

layer(WriteTurns.layer)((it) => {
  it.effect("writes a piece only in its turn, and holds the turn until it is written", () =>
    Effect.gen(function* () {
      const turns = yield* WriteTurns;
      const writing = yield* Deferred.make<void>();
      const written = yield* Deferred.make<void>();
      const piece = yield* Effect.forkChild(
        turns.writing(
          Effect.andThen(Deferred.succeed(writing, undefined), Deferred.await(written)),
        ),
      );
      yield* Stream.runDrain(Stream.take(turns.asked, 1));
      expect(yield* Deferred.isDone(writing)).toBe(false);

      const turn = yield* Effect.forkChild(turns.grant);
      yield* Deferred.await(writing);
      // The server keeps its connection held while the piece writes.
      expect(turn.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(written, undefined);
      yield* Fiber.join(turn);
      yield* Fiber.join(piece);
    }),
  );
});
