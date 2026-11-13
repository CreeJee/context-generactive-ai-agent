import { Array as Arr, Effect, FileSystem, Path, Result, Schema } from "effect";
import { expect } from "vite-plus/test";
import { CardVerifier } from "../../src/kanban/card-agent.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { projectWorkflowRulesPath } from "../../src/workflow/sources.ts";
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

  it.effect("a card's verifier reads the verifying rules its card refers to", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const project = yield* (yield* Projects).add(
        yield* fs.makeTempDirectory({ directory: env.base }),
      );
      yield* fs.makeDirectory(path.join(project.root, ".agents"));
      yield* fs.writeFileString(
        path.join(project.root, projectWorkflowRulesPath),
        `{"rules": [{
          "id": "project.release-check",
          "version": 1,
          "title": "Check the release notes",
          "phases": ["verify"],
          "priority": "recommended",
          "instruction": "Read the release notes entry for the change.",
          "requiredEvidence": ["The release notes entry"]
        }]}`,
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
          // A planning rule, a verifying one, the project's own and a skill rule of an older Plan.
          ruleRefs: [
            "workflow.plan.actionable@1",
            "workflow.plan.testing@1",
            "project.release-check@1",
            "skill.project.gone@1",
          ],
          outcomes: [],
          status: "verify",
          evidence: [],
        },
        worktree: { toolRoot: project.root, deniedRoots: [] },
        report: "Done.",
      });
      const sent = (
        env.provider!.invocations.findLast(({ run }) => run.threadId !== session)?.history ?? []
      )
        .map(({ content }) => (Schema.is(Schema.String)(content) ? content : ""))
        .join("\n");
      expect(sent).toContain("Workflow rules for this card");
      expect(sent).toContain("Plan verification with the change");
      expect(sent).toContain("Check the release notes");
      expect(sent).toContain("The release notes entry");
      expect(sent).not.toContain("Plans have executable steps");
      expect(sent).not.toContain("skill.project.gone");
    }),
  );
});
