import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Scope } from "effect";
import { expect, vi } from "vite-plus/test";
import { acquireFullLoopChannel } from "../src/agent/full-loop-resources.ts";

it.live("channel finalization closes the second native port even if the first close throws", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Effect.scope);
    const channel = yield* acquireFullLoopChannel().pipe(Effect.provideService(Scope.Scope, scope));
    const secondClosed = yield* Deferred.make<void>();
    const run = Effect.runPromiseWith(yield* Effect.context());
    channel.port2.once("close", () => {
      void run(Deferred.succeed(secondClosed, undefined));
    });
    const firstClose = vi.spyOn(channel.port1, "close").mockImplementation(() => {
      throw new Error("first native port close failed");
    });
    try {
      expect(Exit.isFailure(yield* Effect.exit(Scope.close(scope, Exit.void)))).toBe(true);
      yield* Deferred.await(secondClosed);
      expect(firstClose).toHaveBeenCalledTimes(1);
    } finally {
      firstClose.mockRestore();
      channel.port1.close();
      channel.port2.close();
    }
  }),
);
