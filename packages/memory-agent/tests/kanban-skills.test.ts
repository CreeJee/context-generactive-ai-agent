import { Effect, FileSystem, Path } from "effect";
import { expect } from "vite-plus/test";
import { CardAgent, CardVerifier } from "../src/kanban/card-agent.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { selectTestModel } from "./support/provider.ts";
import { TestEnv, testAgent } from "./support/test-env.ts";

/** A project of its own, and the folder its skill catalog is read from. */
const freshProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Outside the repository: `git ls-tree HEAD -- .agents/skills/` must not answer for it, or the
  // catalog would hide every folder the test has not committed.
  const project = yield* (yield* Projects).add(yield* fs.makeTempDirectory({ directory: "/tmp" }));
  return { project, skills: path.join(project.root, ".agents", "skills") };
});

const writeSkill = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(root, "review");
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(
    path.join(directory, "SKILL.md"),
    "---\nname: review\ndescription: Review the work.\n---\nReview rules.",
  );
});

/** A skill whose description no project keeps yet: the built-in read-only tools only. */
const writeReadonlySkill = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(root, "glossary");
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(
    path.join(directory, "SKILL.md"),
    "---\nname: glossary\ndescription: Explain the project's words.\n---\nRead the glossary with read_file.",
  );
});

const card = {
  id: "c1",
  title: "List the helpers",
  description: "Name each helper file",
  dependsOn: [],
  acceptanceCriteria: ["Every helper file is named"],
  ruleRefs: [],
  outcomes: [],
  status: "in_progress",
  evidence: [],
} as const;

/**
 * The card agent's or verifier's own subagent run, made after `before`: its thread is a
 * `subagent-` one, unlike the session's own run or a detached skill review.
 */
const subagentSince = Effect.fnUntraced(function* (before: number) {
  const { provider } = yield* TestEnv;
  return (provider?.invocations ?? [])
    .slice(before)
    .find((invocation) => invocation.run.threadId.startsWith("subagent-"));
});

testAgent({ testProvider: {} })("kanban card agents read project skills", (it) => {
  it.effect("a card agent without skills gets neither skill instructions nor read_skill", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { project } = yield* freshProject;
      yield* selectTestModel();
      const session = (yield* (yield* Sessions).create(project.id)).id;
      const before = env.provider?.invocations.length ?? 0;
      yield* (yield* CardAgent).run({
        sessionId: session,
        projectId: project.id,
        goalInstanceId: "goal-without",
        card,
        attemptNo: 1,
        worktree: { toolRoot: project.root, deniedRoots: [] },
        continuation: false,
        notes: [],
        generation: 1,
        register: () => Effect.void,
      });
      const child = yield* subagentSince(before);
      expect(child?.system.join("\n")).not.toContain("Available skills:");
      expect(child?.toolNames).not.toContain("read_skill");
    }),
  );

  it.effect("a card agent with skills gets the catalog and read_skill", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { project, skills } = yield* freshProject;
      yield* writeSkill(skills);
      yield* selectTestModel();
      const session = (yield* (yield* Sessions).create(project.id)).id;
      const before = env.provider?.invocations.length ?? 0;
      yield* (yield* CardAgent).run({
        sessionId: session,
        projectId: project.id,
        goalInstanceId: "goal-with",
        card,
        attemptNo: 1,
        worktree: { toolRoot: project.root, deniedRoots: [] },
        continuation: false,
        notes: [],
        generation: 1,
        register: () => Effect.void,
      });
      const child = yield* subagentSince(before);
      expect(child?.system.join("\n")).toContain("- review (project): Review the work.");
      expect(child?.toolNames).toContain("read_skill");
    }),
  );

  it.effect("a verifier gets read_skill and still no write tools, with and without skills", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const noWrite = ["write_file", "edit_file", "delete_file", "save_code_skill"];
      const run = Effect.fnUntraced(function* (skill: "none" | "sh" | "plain") {
        const { project, skills } = yield* freshProject;
        if (skill === "sh") yield* writeSkill(skills);
        if (skill === "plain") yield* writeReadonlySkill(skills);
        yield* selectTestModel();
        const session = (yield* (yield* Sessions).create(project.id)).id;
        const before = env.provider?.invocations.length ?? 0;
        yield* (yield* CardVerifier).verify({
          sessionId: session,
          projectId: project.id,
          goalInstanceId: "goal",
          card,
          worktree: { toolRoot: project.root, deniedRoots: [] },
          report: "Named every helper file.",
        });
        return yield* subagentSince(before);
      });
      const without = yield* run("none");
      expect(without?.toolNames).not.toContain("read_skill");
      noWrite.forEach((tool) => expect(without?.toolNames).not.toContain(tool));
      const withSkill = yield* run("plain");
      expect(withSkill?.system.join("\n")).toContain(
        "- glossary (project): Explain the project's words.",
      );
      expect(withSkill?.toolNames).toContain("read_skill");
      noWrite.forEach((tool) => expect(withSkill?.toolNames).not.toContain(tool));
      const withShSkill = yield* run("sh");
      expect(withShSkill?.system.join("\n")).toContain("- review (project): Review the work.");
      expect(withShSkill?.toolNames).toContain("read_skill");
      noWrite.forEach((tool) => expect(withShSkill?.toolNames).not.toContain(tool));
    }),
  );
});
