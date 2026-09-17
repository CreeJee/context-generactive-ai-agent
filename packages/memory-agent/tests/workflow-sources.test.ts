import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { Project } from "../src/projects/projects.ts";
import type { Skill } from "../src/skills/skills.ts";
import {
  projectWorkflowRules,
  projectWorkflowRulesPath,
  skillWorkflowRules,
  structuredWorkflowRules,
} from "../src/workflow/sources.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project() {
  const root = mkdtempSync(join(tmpdir(), "workflow-rules-"));
  roots.push(root);
  return {
    id: "project",
    root,
    name: "project",
    crossRecallExcluded: false,
    permissionMode: "ask",
    createdAt: "2026-01-01T00:00:00.000Z",
    hiddenAt: null,
  } satisfies Project;
}

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

describe("workflow rule sources", () => {
  test("loads explicit project rules with a content-addressed source", () => {
    const current = project();
    const file = join(current.root, projectWorkflowRulesPath);
    mkdirSync(join(current.root, ".agents"));
    writeFileSync(file, ruleFile("Check supported versions"));

    const first = projectWorkflowRules(current);
    expect(first.problems).toEqual([]);
    expect(first.rules[0]).toMatchObject({
      id: "project.release-check",
      priority: "required",
      source: { kind: "project", path: projectWorkflowRulesPath },
    });

    writeFileSync(file, ruleFile("Check supported versions and rollback"));
    const second = projectWorkflowRules(current);
    expect(second.rules[0]?.source).not.toEqual(first.rules[0]?.source);
  });

  test("rejects malformed project rule resources without inferring prose", () => {
    const current = project();
    mkdirSync(join(current.root, ".agents"));
    writeFileSync(join(current.root, projectWorkflowRulesPath), '{"rules":[{"id":1}]}');

    expect(projectWorkflowRules(current)).toMatchObject({
      rules: [],
      problems: [{ problem: "invalid" }],
    });
  });

  test("decodes the same resource format from an MCP source without elevating trust", () => {
    const loaded = structuredWorkflowRules(ruleFile("Review the remote compatibility matrix"), {
      kind: "mcp-resource",
      serverId: "docs",
      name: "workflow://release",
    });

    expect(loaded.rules[0]).toMatchObject({
      id: "project.release-check",
      priority: "recommended",
      source: {
        kind: "mcp-resource",
        serverId: "docs",
        name: "workflow://release",
      },
    });
  });

  test("does not let external resources override built-in rule ids", () => {
    const resource = ruleFile("Override").replace(
      "project.release-check",
      "workflow.plan.readonly",
    );

    expect(
      structuredWorkflowRules(resource, {
        kind: "mcp-prompt",
        serverId: "remote",
        name: "rules",
      }),
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
        source: {
          kind: "skill",
          name: skill.name,
          scope: skill.scope,
          contentHash: skill.contentHash,
        },
      }),
    ]);
  });
});
