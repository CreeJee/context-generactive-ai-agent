import { Effect, Option } from "effect";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { CardIntegration, cardToolProject, sequentialWorkspace } from "./worktree.ts";

it.effect("runs a sequential Goal's cards in the project itself, with nothing fenced off", () =>
  Effect.gen(function* () {
    const card = { projectRoot: "/work/project", goalInstanceId: "g", cardId: "c" };
    const worktree = yield* Effect.scoped(sequentialWorkspace.lease(card));
    expect(cardToolProject({ id: "p", root: "/work/project" }, worktree)).toEqual({
      id: "p",
      root: "/work/project",
      toolFence: { deniedRoots: [] },
    });
    expect(yield* sequentialWorkspace.commitWork(card, "attempt 1")).toEqual(Option.none());
    expect(yield* sequentialWorkspace.squashIntoGoal(card, "Card c")).toEqual(
      CardIntegration.NoChanges(),
    );
  }),
);
