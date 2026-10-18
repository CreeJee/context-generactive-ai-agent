import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { KanbanStorageFailed } from "./card-attempts.ts";
import { stopLogged } from "./background.ts";

describe("stopLogged", () => {
  it.effect("ends a step on its typed failure but keeps a defect in the exit", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.fail(
        KanbanStorageFailed.make({ operation: "card", reason: { _tag: "Missing" } }),
      ).pipe(stopLogged("step stopped", {}), Effect.exit);
      expect(failed).toEqual(Exit.succeed(undefined));

      const defect = yield* Effect.die("bug").pipe(stopLogged("step stopped", {}), Effect.exit);
      expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true);
    }),
  );
});
