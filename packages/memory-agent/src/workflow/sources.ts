import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import type { Project } from "../projects/projects.ts";
import type { Skill } from "../skills/skills.ts";
import {
  WorkflowRule,
  builtInWorkflowRules,
  type WorkflowRule as WorkflowRuleValue,
} from "./rules.ts";

export const projectWorkflowRulesPath = ".agents/workflow-rules.json";
const maxProjectRuleBytes = 256 * 1024;
const ProjectRuleFile = Schema.Struct({ rules: Schema.Array(WorkflowRule.omit("source")) });
const decodeProjectRules = Schema.decodeUnknownSync(Schema.parseJson(ProjectRuleFile));

export interface RuleSourceProblem {
  readonly source: string;
  readonly problem: "too_large" | "unreadable" | "invalid";
}

export interface LoadedRuleSources {
  readonly rules: readonly WorkflowRuleValue[];
  readonly problems: readonly RuleSourceProblem[];
}

export type StructuredRuleOrigin =
  | { readonly kind: "project"; readonly path: string }
  | {
      readonly kind: "mcp-resource" | "mcp-prompt";
      readonly serverId: string;
      readonly name: string;
    };

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const ruleName = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, "-");
const sourceName = (origin: StructuredRuleOrigin) =>
  origin.kind === "project" ? origin.path : `${origin.serverId}/${origin.name}`;

/** Decode the structured rule resource format shared by project files and selected MCP content. */
export function structuredWorkflowRules(
  text: string,
  origin: StructuredRuleOrigin,
): LoadedRuleSources {
  try {
    const decoded = decodeProjectRules(text);
    const ids = decoded.rules.map((rule) => rule.id);
    const builtInIds = new Set(builtInWorkflowRules.map((rule) => rule.id));
    if (new Set(ids).size !== ids.length || ids.some((id) => builtInIds.has(id)))
      return { rules: [], problems: [{ source: sourceName(origin), problem: "invalid" }] };
    const contentHash = digest(text);
    return {
      rules: decoded.rules.map((rule) => ({
        ...rule,
        // Remote content can guide retrieval but cannot declare itself mandatory.
        priority: origin.kind === "project" ? rule.priority : ("recommended" as const),
        source: { ...origin, contentHash },
      })),
      problems: [],
    };
  } catch {
    return { rules: [], problems: [{ source: sourceName(origin), problem: "invalid" }] };
  }
}

/**
 * Explicit project rules are data, not inferred prose. AGENTS.md remains human/model guidance;
 * machine-enforced workflow rules live in this bounded, schema-checked resource.
 */
export function projectWorkflowRules(project: Project): LoadedRuleSources {
  const absolute = join(project.root, projectWorkflowRulesPath);
  if (!existsSync(absolute)) return { rules: [], problems: [] };
  let text: string;
  try {
    const stats = lstatSync(absolute);
    if (!stats.isFile())
      return { rules: [], problems: [{ source: absolute, problem: "unreadable" }] };
    if (stats.size > maxProjectRuleBytes)
      return { rules: [], problems: [{ source: absolute, problem: "too_large" }] };
    text = readFileSync(absolute, "utf8");
  } catch {
    return { rules: [], problems: [{ source: absolute, problem: "unreadable" }] };
  }
  const loaded = structuredWorkflowRules(text, {
    kind: "project",
    path: projectWorkflowRulesPath,
  });
  return loaded.problems.length === 0
    ? loaded
    : { rules: [], problems: [{ source: absolute, problem: "invalid" }] };
}

/**
 * A skill description becomes a searchable recommendation to read that skill, not an eagerly
 * injected copy of SKILL.md and never a permission or required policy.
 */
export function skillWorkflowRules(skills: readonly Skill[]): readonly WorkflowRuleValue[] {
  return skills.map((skill) => ({
    id: `skill.${skill.scope}.${ruleName(skill.name)}`,
    version: 1,
    title: `Use the ${skill.name} skill when applicable`,
    phases: ["goal", "plan", "execute", "verify"],
    priority: "recommended",
    terms: [skill.name, skill.description],
    instruction: `If this task matches the skill description, call read_skill with name ${JSON.stringify(skill.name)} before following its guidance. Skill description: ${skill.description}`,
    requiredEvidence: [`The ${skill.name} skill was read before its guidance was applied`],
    source: {
      kind: "skill",
      name: skill.name,
      scope: skill.scope,
      contentHash: skill.contentHash,
    },
  }));
}

/**
 * Local structured resources for one run.
 * TODO(organization-workflows): let admins opt into trusted MCP resources/prompts as centrally
 * managed recommended guidance. Keep discovery, trust review and source status out of the MVP.
 */
export function localWorkflowRules(project: Project, skills: readonly Skill[]): LoadedRuleSources {
  const projectRules = projectWorkflowRules(project);
  return {
    rules: [...projectRules.rules, ...skillWorkflowRules(skills)],
    problems: projectRules.problems,
  };
}
