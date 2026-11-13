import { Array as Arr, Effect, FileSystem, Result } from "effect";
import { expect } from "vite-plus/test";
import { CardVerifier } from "../../src/kanban/card-agent.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

testAgent({ testProvider: {} })("card verifier conversation", (it) => {
  it.effect("each verification of a card starts a new conversation", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const fs = yield* FileSystem.FileSystem;
      const project = yield* (yield* Projects).add(
        yield* fs.makeTempDirectory({ directory: env.base }),
      );
      yield* selectTestModel();
      const session = (yield* (yield* Sessions).create(project.id)).id;
      const verify = (report: string) =>
        Effect.gen(function* () {
          return yield* (yield* CardVerifier).verify({
            sessionId: session,
            projectId: project.id,
            goalInstanceId: "goal",
            card: {
              id: "c1",
              title: "Check the source",
              description: "Read the message the card cites",
              dependsOn: [],
              acceptanceCriteria: ["The cited message is read"],
              ruleRefs: [],
              outcomes: [],
              status: "verify",
              evidence: [],
            },
            worktree: { toolRoot: project.root, deniedRoots: [] },
            report,
          });
        });
      yield* verify("First report.");
      yield* verify("Second report.");
      // A verifier that kept its conversation saw its earlier verdict and recorded none again.
      const threads = Arr.dedupe(
        Arr.filterMap(env.provider!.invocations, ({ run }) =>
          run.threadId === session ? Result.failVoid : Result.succeed(run.threadId),
        ),
      );
      expect(threads).toHaveLength(2);
    }),
  );
});
