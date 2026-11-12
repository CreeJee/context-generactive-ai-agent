import { Effect, FileSystem } from "effect";
import { expect } from "vite-plus/test";
import { CardVerifier } from "../../src/kanban/card-agent.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

testAgent({ testProvider: {} })("card evidence tools", (it) => {
  it.effect("a card verifier reads memory records by node id, and only that", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const fs = yield* FileSystem.FileSystem;
      const project = yield* (yield* Projects).add(
        yield* fs.makeTempDirectory({ directory: env.base }),
      );
      yield* selectTestModel();
      const session = (yield* (yield* Sessions).create(project.id)).id;
      yield* (yield* CardVerifier).verify({
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
        report: "Read it.",
      });
      const verifier = env.provider!.invocations.find(
        (invocation) => invocation.run.threadId !== session,
      );
      expect(verifier?.toolNames).toContain("read_evidence");
      expect(verifier?.toolNames).not.toContain("find_memory");
      expect(verifier?.toolNames).not.toContain("read_tool_result");
    }),
  );
});
