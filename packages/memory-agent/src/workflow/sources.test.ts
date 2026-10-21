import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Path } from "effect";
import { layer } from "@effect/vitest";
import { describe, expect, test } from "vite-plus/test";
import type { Project } from "../projects/projects.ts";
import type { Skill } from "../skills/skills.ts";
import { RuleSource } from "./rules.ts";
import {
  projectWorkflowRules,
  projectWorkflowRulesPath,
  skillWorkflowRules,
  StructuredRuleOrigin,
  structuredWorkflowRules,
} from "./sources.ts";

const project = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "workflow-rules-" });

  return {
    id: "project",
    root,
    name: "project",
    crossRecallExcluded: false,
    permissionMode: "ask",
    createdAt: "2026-01-01T00:00:00.000Z",
    hiddenAt: null,
  } satisfies Project;
});

const ruleFile = (instruction: string) =>
  JSON.stringify({
    rules: [
      {
        id: "project.release-check",
        version: 2,
        title: "Check release compatibility",
        phases: ["plan", "verify"],
        priority: "required",
        terms: ["release", "compatibility"],
        instruction,
        requiredEvidence: ["Compatibility matrix checked"],
      },
    ],
  });

const fileSystem = Layer.merge(NodeFileSystem.layer, NodePath.layer);

describe("workflow rule sources", () => {
  layer(fileSystem, { excludeTestServices: true })("project rule files", (it) => {
    it.effect("loads explicit project rules with a content-addressed source", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const current = yield* project();
        const file = path.join(current.root, projectWorkflowRulesPath);
        yield* fs.makeDirectory(path.join(current.root, ".agents"));
        yield* fs.writeFileString(file, ruleFile("Check supported versions"));
        const first = yield* projectWorkflowRules(current);
        expect(first.problems).toEqual([]);
        expect(RuleSource.guards.project(first.rules[0]?.source)).toBe(true);
        expect(first.rules[0]).toMatchObject({
          id: "project.release-check",
          priority: "required",
          source: { path: projectWorkflowRulesPath },
        });
        yield* fs.writeFileString(file, ruleFile("Check supported versions and rollback"));
        const second = yield* projectWorkflowRules(current);
        expect(second.rules[0]?.source).not.toEqual(first.rules[0]?.source);
      }),
    );

    it.effect("rejects malformed project rule resources without inferring prose", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const current = yield* project();
        yield* fs.makeDirectory(path.join(current.root, ".agents"));
        yield* fs.writeFileString(
          path.join(current.root, projectWorkflowRulesPath),
          '{"rules":[{"id":1}]}',
        );
        expect(yield* projectWorkflowRules(current)).toMatchObject({
          rules: [],
          problems: [{ problem: "invalid" }],
        });
      }),
    );
  });

  test("decodes the same resource format from an MCP source without elevating trust", () => {
    const loaded = structuredWorkflowRules(
      ruleFile("Review the remote compatibility matrix"),
      StructuredRuleOrigin["mcp-resource"]({ serverId: "docs", name: "workflow://release" }),
    );

    expect(RuleSource.guards["mcp-resource"](loaded.rules[0]?.source)).toBe(true);
    expect(loaded.rules[0]).toMatchObject({
      id: "project.release-check",
      priority: "recommended",
      source: { serverId: "docs", name: "workflow://release" },
    });
  });

  test("does not let external resources override built-in rule ids", () => {
    const resource = ruleFile("Override").replace(
      "project.release-check",
      "workflow.plan.readonly",
    );

    expect(
      structuredWorkflowRules(
        resource,
        StructuredRuleOrigin["mcp-prompt"]({ serverId: "remote", name: "rules" }),
      ),
    ).toMatchObject({ rules: [], problems: [{ problem: "invalid" }] });
  });

  test("turns skill metadata into recommended read_skill rules", () => {
    const skill: Skill = {
      name: "repair-pr",
      scope: "project",
      description: "Repair CI and review feedback on a pull request.",
      directory: "/project/.agents/skills/repair-pr",
      contentHash: "abc123",
    };

    expect(skillWorkflowRules([skill])).toEqual([
      expect.objectContaining({
        id: "skill.project.repair-pr",
        priority: "recommended",
        terms: [skill.name, skill.description],
        source: RuleSource.cases.skill.make({
          name: skill.name,
          scope: skill.scope,
          contentHash: skill.contentHash,
        }),
      }),
    ]);
  });
});
