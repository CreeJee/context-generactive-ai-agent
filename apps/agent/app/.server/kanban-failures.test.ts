import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { CardWorktreeFailed, KanbanActionRefused, KanbanStorageFailed } from "memory-agent";
import { kanbanFailureResponse, type KanbanRouteFailure } from "./kanban-failures";

const answered = (failure: KanbanRouteFailure) => {
  const response = kanbanFailureResponse(failure);
  return Effect.map(
    Effect.promise(() => response.text()),
    (body) => ({ status: response.status, body }),
  );
};

describe("kanbanFailureResponse", () => {
  it.effect("answers a refused intent with 409 and its reason", () =>
    Effect.gen(function* () {
      expect(yield* answered(KanbanActionRefused.make({ reason: "card_not_blocked" }))).toEqual({
        status: 409,
        body: '{"error":"card_not_blocked"}',
      });
    }),
  );

  it.effect("answers storage and git failures with a fixed code and never their cause", () =>
    Effect.gen(function* () {
      expect(
        yield* answered(
          KanbanStorageFailed.make({
            operation: "decision",
            reason: { _tag: "Storage" },
            cause: new Error("SQLITE_BUSY: /Users/someone/.context-generactive-agent/agent.db"),
          }),
        ),
      ).toEqual({ status: 500, body: '{"error":"kanban_storage_failed"}' });
      expect(
        yield* answered(
          CardWorktreeFailed.make({
            operation: "settle",
            reason: { _tag: "GitFailed", exitCode: 128 },
            cause: "fatal: /Users/someone/project is not clean",
          }),
        ),
      ).toEqual({ status: 500, body: '{"error":"worktree_failed"}' });
    }),
  );
});
