import { Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";
import { CardAgent, CardVerdict, CardVerifier } from "../src/kanban/card-agent.ts";
import { VerdictFailure } from "../src/kanban/failures.ts";
import type { ScriptedInvocation, ScriptedTurn } from "../src/testing/scripted-model.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { defaultTestResponder, selectTestModel } from "./support/provider.ts";
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
  it.effect(
    "a card agent gets read_skill and the skill instructions even without project skills",
    () =>
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
        expect(child?.system.join("\n")).toContain("find them with find_skill");
        expect(child?.toolNames).toContain("read_skill");
        expect(child?.toolNames).toContain("find_skill");
      }),
  );

  it.effect("a card agent with skills gets no listed catalog, but read_skill", () =>
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
      // Skills are not listed any more: the model finds them with find_skill (decisions.md), so
      // the catalog line stays out either way.
      expect(child?.system.join("\n")).not.toContain("- review (project): Review the work.");
      expect(child?.toolNames).toContain("read_skill");
      expect(child?.toolNames).toContain("find_skill");
    }),
  );

  it.effect("a verifier gets the card agent's tools, find_skill and record_card_verdict", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const run = Effect.fnUntraced(function* (skill: "none" | "sh" | "plain") {
        const { project, skills } = yield* freshProject;
        if (skill === "sh") yield* writeSkill(skills);
        if (skill === "plain") yield* writeReadonlySkill(skills);
        yield* selectTestModel();
        const session = (yield* (yield* Sessions).create(project.id)).id;
        const worktree = { toolRoot: project.root, deniedRoots: [] };
        const beforeCard = env.provider?.invocations.length ?? 0;
        yield* (yield* CardAgent).run({
          sessionId: session,
          projectId: project.id,
          goalInstanceId: `goal-${skill}`,
          card,
          attemptNo: 1,
          worktree,
          continuation: false,
          notes: [],
          generation: 1,
          register: () => Effect.void,
        });
        const worker = yield* subagentSince(beforeCard);
        const beforeVerifier = env.provider?.invocations.length ?? 0;
        yield* (yield* CardVerifier).verify({
          sessionId: session,
          projectId: project.id,
          goalInstanceId: `goal-${skill}`,
          card,
          worktree,
          report: "Named every helper file.",
        });
        return { worker, verifier: yield* subagentSince(beforeVerifier) };
      });
      yield* Effect.forEach(["none", "plain", "sh"] as const, (skill) =>
        Effect.gen(function* () {
          const { worker, verifier } = yield* run(skill);
          const given = verifier?.toolNames ?? [];
          expect(worker?.toolNames.length).toBeGreaterThan(0);
          worker?.toolNames.forEach((tool) => expect(given).toContain(tool));
          // save_code_skill is lazy: the model sees it only after asking for it, so it is not listed.
          [
            "find_skill",
            "run_command",
            "save_project_commands",
            "write_file",
            "edit_file",
            "record_card_verdict",
          ].forEach((tool) => expect(given).toContain(tool));
          // Skills are not listed any more: the model finds them with find_skill (decisions.md).
          const system = verifier?.system.join("\n");
          expect(system).not.toContain("- review (project): Review the work.");
          expect(system).not.toContain("- glossary (project): Explain the project's words.");
        }),
      );
    }),
  );
});

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.string(ChildProcess.make("git", args, { cwd })),
  );

/** A verifier that changes `tracked.txt` as it passes the card, or only passes it. */
const verifierTurn =
  (edit: boolean) =>
  (invocation: ScriptedInvocation): ScriptedTurn => {
    if (!invocation.system.join("\n").includes("You verify one finished card"))
      return defaultTestResponder(invocation);
    const last = invocation.history.at(-1);
    if (last?.role !== "tool")
      return edit
        ? {
            toolCalls: [
              {
                id: "edit-1",
                name: "edit_file",
                arguments: JSON.stringify({
                  path: "tracked.txt",
                  oldText: "before",
                  newText: "after",
                }),
              },
            ],
          }
        : { toolCalls: [verdictCall] };
    return last.toolCallId === "edit-1" ? { toolCalls: [verdictCall] } : { text: "Verified." };
  };

const verdictCall = {
  id: "verdict-1",
  name: "record_card_verdict",
  arguments: JSON.stringify({ passed: true, evidence: ["Named every helper file."] }),
};

/** A committed repository with one tracked file, and a verifier of the card run in it. */
const verifiedInRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { project } = yield* freshProject;
  yield* fs.writeFileString(path.join(project.root, "tracked.txt"), "before\n");
  yield* git(project.root, "init", "-q");
  yield* git(project.root, "add", "tracked.txt");
  yield* git(
    project.root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "-m",
    "work",
  );
  yield* selectTestModel();
  const session = (yield* (yield* Sessions).create(project.id)).id;
  return yield* (yield* CardVerifier).verify({
    sessionId: session,
    projectId: project.id,
    goalInstanceId: "goal-changed",
    card,
    worktree: { toolRoot: project.root, deniedRoots: [] },
    report: "Named every helper file.",
  });
});

testAgent({ testProvider: { responder: verifierTurn(true) } })(
  "a verifier that changes the work it judges",
  (it) => {
    it.effect("does not pass it, and names the files it changed", () =>
      Effect.gen(function* () {
        const verdict = yield* verifiedInRepository;
        expect(
          CardVerdict.$match(verdict, {
            Passed: () => "passed",
            Failed: ({ failure }) =>
              VerdictFailure.guards.ChangedWork(failure) ? failure.files : "other",
          }),
        ).toEqual(["tracked.txt"]);
      }),
    );
  },
);

testAgent({ testProvider: { responder: verifierTurn(false) } })(
  "a verifier that leaves the work as it is",
  (it) => {
    it.effect("passes it as it recorded", () =>
      Effect.gen(function* () {
        const verdict = yield* verifiedInRepository;
        expect(
          CardVerdict.$match(verdict, { Passed: () => "passed", Failed: () => "failed" }),
        ).toBe("passed");
      }),
    );
  },
);
