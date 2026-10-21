import { Result, Function as EffectFunction } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { sha256 } from "../runtime/synchronous-crypto.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { Data, Effect, FileSystem, HashSet, Path, Schema, Struct } from "effect";
import type { Project } from "../projects/projects.ts";
import type { Skill } from "../skills/skills.ts";
import {
  RuleSource,
  WorkflowRule,
  builtInWorkflowRules,
  type WorkflowRule as WorkflowRuleValue,
} from "./rules.ts";

export const projectWorkflowRulesPath = ".agents/workflow-rules.json";
const maxProjectRuleBytes = 256 * 1024;
const ProjectRuleFile = Schema.Struct({
  rules: Schema.Array(WorkflowRule.mapFields(Struct.omit(["source"]))),
});
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeProjectRules = EffectFunction.flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(ProjectRuleFile)),
  Result.getOrThrow,
);

export interface RuleSourceProblem {
  readonly source: string;
  readonly problem: "too_large" | "unreadable" | "invalid";
}

export interface LoadedRuleSources {
  readonly rules: readonly WorkflowRuleValue[];
  readonly problems: readonly RuleSourceProblem[];
}

type McpRuleOrigin = { readonly serverId: string; readonly name: string };

export type StructuredRuleOrigin = Data.TaggedEnum<{
  project: { readonly path: string };
  "mcp-resource": McpRuleOrigin;
  "mcp-prompt": McpRuleOrigin;
}>;
export const StructuredRuleOrigin = Data.taggedEnum<StructuredRuleOrigin>();

const digest = (text: string) => sha256(text);
const ruleName = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, "-");
const mcpSourceName = ({ serverId, name }: McpRuleOrigin) => `${serverId}/${name}`;
const sourceName = StructuredRuleOrigin.$match({
  project: ({ path }) => path,
  "mcp-resource": mcpSourceName,
  "mcp-prompt": mcpSourceName,
});
const ruleSource = (origin: StructuredRuleOrigin, contentHash: string): RuleSource =>
  StructuredRuleOrigin.$match(origin, {
    project: ({ path }) => RuleSource.cases.project.make({ path, contentHash }),
    "mcp-resource": ({ serverId, name }) =>
      RuleSource.cases["mcp-resource"].make({ serverId, name, contentHash }),
    "mcp-prompt": ({ serverId, name }) =>
      RuleSource.cases["mcp-prompt"].make({ serverId, name, contentHash }),
  });

/** Decode the structured rule resource format shared by project files and selected MCP content. */
export const structuredWorkflowRules: {
  (origin: StructuredRuleOrigin): (text: string) => ReturnType<typeof structuredWorkflowRulesBody>;
} & typeof structuredWorkflowRulesBody = EffectFunction.dual(2, structuredWorkflowRulesBody);
function structuredWorkflowRulesBody(
  text: string,
  origin: StructuredRuleOrigin,
): LoadedRuleSources {
  try {
    const decoded = decodeProjectRules(text);
    const ids = decoded.rules.map((rule) => rule.id);
    const builtInIds = HashSet.fromIterable(builtInWorkflowRules.map((rule) => rule.id));
    if (
      HashSet.size(HashSet.fromIterable(ids)) !== ids.length ||
      ids.some((id) => HashSet.has(builtInIds, id))
    )
      return { rules: [], problems: [{ source: sourceName(origin), problem: "invalid" }] };
    const contentHash = digest(text);
    return {
      rules: decoded.rules.map((rule) => ({
        ...rule,
        // Remote content can guide retrieval but cannot declare itself mandatory.
        priority: StructuredRuleOrigin.$is("project")(origin)
          ? rule.priority
          : ("recommended" as const),
        source: ruleSource(origin, contentHash),
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
export const projectWorkflowRules = Effect.fn("projectWorkflowRules")(function* (project: Project) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const absolute = paths.join(project.root, projectWorkflowRulesPath);
  const problem = (kind: RuleSourceProblem["problem"]): LoadedRuleSources => ({
    rules: [],
    problems: [{ source: absolute, problem: kind }],
  });
  const read = Effect.gen(function* (): Effect.fn.Return<
    LoadedRuleSources,
    import("effect/PlatformError").PlatformError
  > {
    if (!(yield* fs.exists(absolute))) return { rules: [], problems: [] };
    const stats = yield* fs.lstat(absolute);
    if (stats.type !== "File") return problem("unreadable");
    if (stats.size > BigInt(maxProjectRuleBytes)) return problem("too_large");
    const text = yield* fs.readFileString(absolute);
    const loaded = structuredWorkflowRules(
      text,
      StructuredRuleOrigin.project({ path: projectWorkflowRulesPath }),
    );
    return loaded.problems.length === 0 ? loaded : problem("invalid");
  });
  return yield* read.pipe(
    Effect.catchTag("PlatformError", () => Effect.succeed(problem("unreadable"))),
  );
});

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
    source: RuleSource.cases.skill.make({
      name: skill.name,
      scope: skill.scope,
      contentHash: skill.contentHash,
    }),
  }));
}

/**
 * Local structured resources for one run.
 * TODO(organization-workflows): let admins opt into trusted MCP resources/prompts as centrally
 * managed recommended guidance. Keep discovery, trust review and source status out of the MVP.
 */
export const localWorkflowRules: {
  (skills: readonly Skill[]): (project: Project) => ReturnType<typeof localWorkflowRulesBody>;
} & typeof localWorkflowRulesBody = EffectFunction.dual(2, localWorkflowRulesBody);
function localWorkflowRulesBody(project: Project, skills: readonly Skill[]) {
  return projectWorkflowRules(project).pipe(
    Effect.map((projectRules): LoadedRuleSources => ({
      rules: [...projectRules.rules, ...skillWorkflowRules(skills)],
      problems: projectRules.problems,
    })),
  );
}
