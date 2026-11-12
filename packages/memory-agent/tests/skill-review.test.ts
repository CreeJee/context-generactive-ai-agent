import { Effect, FileSystem, Path } from "effect";
import { SqlClient } from "effect/sql";
import { expect, test } from "vite-plus/test";
import type { StoredMessage } from "../src/chat-store/schema.ts";
import { AgentSkills } from "../src/skills/agent-skills.ts";
import { SkillReviews, skillRunsIn } from "../src/skills/skill-review.ts";
import { ApprovedTools } from "../src/tools/approved.ts";
import { selectTestModel } from "./support/provider.ts";
import { callTool } from "./support/run-tools.ts";
import { TestEnv, freshSession, testAgent } from "./support/test-env.ts";

/** An assistant message calling `tool` for the skill `skill`. */
const call = (id: string, tool: string, skill: string): StoredMessage => ({
  role: "assistant",
  toolCalls: [
    { id, type: "function", function: { name: tool, arguments: JSON.stringify({ name: skill }) } },
  ],
});
const answer = (toolCallId: string, content: string): StoredMessage => ({
  role: "tool",
  toolCallId,
  content,
});
const failure = (toolCallId: string, error: string): StoredMessage => ({
  role: "tool",
  toolCallId,
  content: "",
  error,
});

test("a run counts for the content its skill has at the end, and only once it has an answer", () => {
  const runs = skillRunsIn([
    call("a", "run_skill", "lint"),
    answer("a", "old version"),
    call("b", "save_code_skill", "lint"),
    answer("b", "saved"),
    call("c", "run_skill", "lint"),
    failure("c", "exit 1"),
    call("d", "run_skill", "build"),
    answer("d", "built"),
    call("e", "run_skill", "build"),
  ]);
  expect(runs).toEqual([
    { name: "lint", toolCallId: "c", failed: true, result: "exit 1" },
    { name: "build", toolCallId: "d", failed: false, result: "built" },
  ]);
});

testAgent({ testProvider: {} })("skill review", (it) => {
  it.effect(
    "a promoted candidate reaches every conversation and the user's skill folder; a kept one stays",
    () =>
      Effect.gen(function* () {
        const { project } = yield* TestEnv;
        const sessionId = yield* freshSession;
        yield* selectTestModel();
        const tools = (yield* ApprovedTools).toolsFor(
          { ...project, permissionMode: "full" },
          sessionId,
          "gate",
        );
        yield* callTool(tools, "save_code_skill", {
          name: "promote-me",
          description: "Print the project's name",
          program: { runtime: "sh", script: "printf promote" },
        });
        yield* callTool(tools, "save_code_skill", {
          name: "one-off",
          description: "Print one value",
          program: { runtime: "sh", script: "printf once" },
        });
        const reviews = yield* SkillReviews;
        yield* reviews.afterRun(project, sessionId, [
          call("r1", "run_skill", "promote-me"),
          answer("r1", "promote"),
        ]);

        const agentSkills = yield* AgentSkills;
        const other = yield* agentSkills.visible(project.id, yield* freshSession);
        expect(other.map((skill) => [skill._tag, skill.name])).toEqual([
          ["promoted", "promote-me"],
        ]);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const copy = path.join(project.root, ".agents/skills/promote-me");
        expect(yield* fs.readFileString(path.join(copy, "scripts/run.sh"))).toBe(
          "printf promote\n",
        );

        const sql = yield* SqlClient.SqlClient;
        const kept = yield* sql<{ kept_reason: string; reviewed_runs: number }>`
          SELECT kept_reason, reviewed_runs FROM skill_candidates
          WHERE session_id = ${sessionId} AND name = 'one-off'`;
        expect(kept).toEqual([{ kept_reason: "검토 결과: keep", reviewed_runs: 0 }]);
        const [reviewedAt] = yield* sql<{ reviewed_at: string }>`
          SELECT reviewed_at FROM skill_candidates WHERE session_id = ${sessionId}`;

        // Nothing changed and nothing ran again: no second review.
        yield* reviews.afterRun(project, sessionId, []);
        expect(
          yield* sql<{ reviewed_at: string }>`
            SELECT reviewed_at FROM skill_candidates WHERE session_id = ${sessionId}`,
        ).toEqual([reviewedAt]);
      }),
  );

  it.effect("a folder the user changed stays as it is when its skill is promoted again", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      yield* selectTestModel();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = path.join(project.root, ".agents/skills/promote-me-mine");
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(path.join(folder, "SKILL.md"), "mine\n");

      const sessionId = yield* freshSession;
      const tools = (yield* ApprovedTools).toolsFor(
        { ...project, permissionMode: "full" },
        sessionId,
        "gate",
      );
      yield* callTool(tools, "save_code_skill", {
        name: "promote-me-mine",
        description: "Print",
        program: { runtime: "sh", script: "printf app" },
      });
      yield* (yield* SkillReviews).afterRun(project, sessionId, []);

      expect(yield* fs.readDirectory(folder)).toEqual(["SKILL.md"]);
      const sql = yield* SqlClient.SqlClient;
      expect(
        yield* sql<{ copy_sha256: string | null }>`
          SELECT copy_sha256 FROM promoted_skills WHERE name = 'promote-me-mine'`,
      ).toEqual([{ copy_sha256: null }]);
    }),
  );
});
