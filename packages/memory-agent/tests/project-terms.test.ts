import { Array as Arr, Effect, FileSystem } from "effect";
import { expect } from "vite-plus/test";
import type { RunScope } from "../src/loop/run.ts";
import { maxProjectTerms, ProjectTerms } from "../src/projects/terms.ts";
import { Projects } from "../src/projects/projects.ts";
import { callTool, failureCode } from "./support/run-tools.ts";
import { TestEnv, testAgent } from "./support/test-env.ts";

const scope: RunScope = {
  threadId: "thread",
  runId: "run",
  emit: () => Effect.void,
  inBackground: Effect.ignore,
};

/** A project of its own, so the term list a test reads is the one it wrote. */
const freshProject = Effect.gen(function* () {
  const { base } = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectory({ directory: base, prefix: "terms-" });
  return yield* (yield* Projects).add(root);
});

const card = {
  term: "Card",
  meaning: "One step of a Plan, run by one agent in a folder of its own.",
  source: "code" as const,
  reference: "src/workflow/card.ts CardStatus",
};

testAgent()("project terms", (it) => {
  it.effect("a list is kept per project, and letter case does not make another term", () =>
    Effect.gen(function* () {
      const project = yield* freshProject;
      const other = yield* freshProject;
      const terms = yield* ProjectTerms;
      expect(yield* terms.list(project.id)).toEqual([]);
      yield* terms.change(project.id, {
        terms: [
          card,
          {
            term: "Goal",
            meaning: "What the user wants done.",
            source: "user",
            reference: '"Goal"',
          },
        ],
      });
      const corrected = { ...card, term: "card", meaning: "One unit of work on the board." };
      expect(
        yield* terms.change(project.id, { terms: [corrected], remove: ["GOAL", "Plan"] }),
      ).toEqual({ terms: [corrected], notListed: ["Plan"] });
      expect(yield* terms.list(other.id)).toEqual([]);
    }),
  );

  it.effect("a list that would be too long is refused and stays as it was", () =>
    Effect.gen(function* () {
      const project = yield* freshProject;
      const terms = yield* ProjectTerms;
      const tool = [terms.toolFor(project.id)];
      const numbered = (count: number, from = 0) =>
        Arr.makeBy(count, (index) => ({ ...card, term: `term ${from + index}` }));
      yield* callTool(tool, "save_project_terms", { terms: numbered(maxProjectTerms) });
      expect(
        yield* failureCode(
          callTool(tool, "save_project_terms", { terms: numbered(1, maxProjectTerms) }),
        ),
      ).toBe("too_many_terms");
      expect(yield* terms.list(project.id)).toHaveLength(maxProjectTerms);
    }),
  );

  it.effect("a guess is not a source", () =>
    Effect.gen(function* () {
      const project = yield* freshProject;
      const tool = [(yield* ProjectTerms).toolFor(project.id)];
      expect(
        yield* Effect.exit(
          callTool(tool, "save_project_terms", { terms: [{ ...card, source: "assumed" }] }),
        ),
      ).toMatchObject({ _tag: "Failure" });
    }),
  );

  it.effect("a run starts with the list it found, and a project without one gets no prompt", () =>
    Effect.gen(function* () {
      const project = yield* freshProject;
      const terms = yield* ProjectTerms;
      const system = (hook: Effect.Success<ReturnType<typeof terms.hookFor>>) =>
        Effect.map(
          hook.request!(scope, { system: ["BASE"], history: [], tools: [] }),
          (request) => request.system,
        );
      const empty = yield* terms.hookFor(project.id);
      expect(yield* system(empty)).toEqual(["BASE"]);
      yield* terms.change(project.id, { terms: [card] });
      const listed = yield* terms.hookFor(project.id);
      const [base, added] = yield* system(listed);
      expect(base).toBe("BASE");
      expect(added).toMatch(/^\[Project terms\]\n/);
      expect(added).toContain(
        "- Card: One step of a Plan, run by one agent in a folder of its own. (code: src/workflow/card.ts CardStatus)",
      );
      // What the run saves shows in the next run: this run's prompt stays as it started.
      yield* terms.change(project.id, { remove: ["Card"] });
      expect(yield* system(listed)).toEqual([base, added]);
    }),
  );
});
