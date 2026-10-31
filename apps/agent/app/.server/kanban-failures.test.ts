import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { CardWorktreeFailed, KanbanActionRefused } from "memory-agent";
import { kanbanRefusal } from "./kanban-failures";

describe("kanbanRefusal", () => {
  it.effect("refuses an intent with its reason", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          kanbanRefusal.KanbanActionRefused(
            KanbanActionRefused.make({ reason: "card_not_blocked" }),
          ),
        ),
      ).toEqual({ error: "card_not_blocked" });
    }),
  );

  it.effect("refuses a git failure with a fixed code and never its cause", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          kanbanRefusal.CardWorktreeFailed(
            CardWorktreeFailed.make({
              operation: "settle",
              reason: CardWorktreeFailed.fields.reason.cases.GitFailed.make({ exitCode: 128 }),
              cause: "fatal: /Users/someone/project is not clean",
            }),
          ),
        ),
      ).toEqual({ error: "worktree_failed" });
    }),
  );
});
