import { Result, Function as EffectFunction } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { sha256 } from "../runtime/synchronous-crypto.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { Data, Effect, FileSystem, HashSet, Iterable, Path, Schema, Struct } from "effect";
import type { Project } from "../projects/projects.ts";
import {
  RuleSource,
  WorkflowRule,
  builtInWorkflowRules,
  type WorkflowRule as WorkflowRuleValue,
} from "./rules.ts";

export const projectWorkflowRulesPath = ".agents/workflow-rules.json";
const maxProjectRuleCharacters = 32_000;
/** Size past which the rule file cannot fit: UTF-8 spends at most 3 bytes per UTF-16 unit. */
const maxProjectRuleBytes = maxProjectRuleCharacters * 3;
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

export type StructuredRuleOrigin = Data.TaggedEnum<{
  project: { readonly path: string };
}>;
export const StructuredRuleOrigin = Data.taggedEnum<StructuredRuleOrigin>();

const digest = (text: string) => sha256(text);
const sourceName = StructuredRuleOrigin.$match({
  project: ({ path }) => path,
});
const ruleSource = (origin: StructuredRuleOrigin, contentHash: string): RuleSource =>
  StructuredRuleOrigin.$match(origin, {
    project: ({ path }) => RuleSource.cases.project.make({ path, contentHash }),
  });

/** Decode the structured rule resource format of project rule files. */
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
    const builtInIds = HashSet.fromIterable(Iterable.map(builtInWorkflowRules, (rule) => rule.id));
    if (
      HashSet.size(HashSet.fromIterable(ids)) !== ids.length ||
      ids.some((id) => HashSet.has(builtInIds, id))
    )
      return { rules: [], problems: [{ source: sourceName(origin), problem: "invalid" }] };
    const contentHash = digest(text);
    return {
      rules: decoded.rules.map((rule) => ({ ...rule, source: ruleSource(origin, contentHash) })),
      problems: [],
    };
  } catch {
    return { rules: [], problems: [{ source: sourceName(origin), problem: "invalid" }] };
  }
}

/**
 * Explicit project rules are data, not inferred prose. AGENTS.md remains human/model guidance;
 * machine-enforced workflow rules live in this bounded, schema-checked resource. Skills are not
 * rules: the model reads them from the skill list the run already shows.
 * TODO(organization-workflows): let admins opt into trusted MCP resources/prompts as centrally
 * managed recommended guidance. Keep discovery, trust review and source status out of the MVP.
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
    if (text.length > maxProjectRuleCharacters) return problem("too_large");
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
