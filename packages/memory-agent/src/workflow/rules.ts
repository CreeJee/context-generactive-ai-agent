import { isTruthy } from "../truthy.ts";
import {
  Array as EffectArray,
  HashSet,
  MutableHashMap,
  Option,
  Cache,
  Context,
  Effect,
  Exit,
  Layer,
  Result,
  Schema,
} from "effect";
import { Embedder, type EmbeddingError } from "../memory/embedding/embedder.ts";
import { WorkflowPhase } from "./workflow.ts";

const mcpRuleSourceFields = {
  serverId: Schema.String,
  name: Schema.String,
  contentHash: Schema.String,
};

export const RuleSource = Schema.TaggedUnion({
  builtin: { name: Schema.String },
  project: { path: Schema.String, contentHash: Schema.String },
  skill: {
    name: Schema.String,
    scope: Schema.Literals(["builtin", "global", "project"]),
    contentHash: Schema.String,
  },
  "mcp-resource": mcpRuleSourceFields,
  "mcp-prompt": mcpRuleSourceFields,
});
export type RuleSource = typeof RuleSource.Type;

export const WorkflowRule = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/))),
  version: Schema.Int,
  title: Schema.NonEmptyString,
  phases: Schema.Array(WorkflowPhase),
  priority: Schema.Literals(["required", "recommended"]),
  terms: Schema.Array(Schema.String),
  instruction: Schema.NonEmptyString,
  requiredEvidence: Schema.Array(Schema.String),
  source: RuleSource,
});
export type WorkflowRule = typeof WorkflowRule.Type;

export interface RuleQuery {
  readonly phase: WorkflowPhase;
  readonly text: string;
  /** Additional project, skill or MCP rules. Built-in ids cannot be overridden. */
  readonly rules?: readonly WorkflowRule[];
  readonly limit?: number;
}

export interface ResolvedRules {
  readonly rules: readonly WorkflowRule[];
  readonly degraded: readonly ("embedding" | "source")[];
}

const builtInRuleInputs: readonly Omit<WorkflowRule, "source">[] = [
  {
    id: "workflow.goal.definition",
    version: 1,
    title: "Define outcomes before implementation",
    phases: ["goal"],
    priority: "required",
    terms: ["goal", "outcome", "constraint", "non-goal", "assumption", "question"],
    instruction:
      "Record the problem, observable outcomes, constraints, non-goals, assumptions and blocking questions. Do not turn implementation guesses into requirements.",
    requiredEvidence: ["A saved Goal artifact with no unanswered blocking question before acting"],
  },
  {
    id: "workflow.plan.readonly",
    version: 1,
    title: "Planning is read-only",
    phases: ["plan"],
    priority: "required",
    terms: ["plan", "research", "investigate", "read-only"],
    instruction:
      "Investigate without changing project files, running shell commands, delegating, or using write-capable external tools.",
    requiredEvidence: ["No project mutation was performed during Plan"],
  },
  {
    id: "workflow.plan.actionable",
    version: 1,
    title: "Plans have executable steps",
    phases: ["plan"],
    priority: "required",
    terms: ["step", "dependency", "acceptance", "risk", "plan"],
    instruction:
      "Give steps stable ids, explicit dependencies and observable acceptance criteria. Attach the ids of applicable rules rather than copying their full text.",
    requiredEvidence: ["A saved Plan artifact tied to the current Goal version"],
  },
  {
    id: "workflow.plan.blockers",
    version: 1,
    title: "Defer questions until independent planning is exhausted",
    phases: ["plan"],
    priority: "required",
    terms: ["question", "contradiction", "blocker", "independent", "investigation"],
    instruction:
      "Record unresolved decisions and their dependencies, complete independent read-only investigation and planning first, then ask only about decisions that actually block further progress. Non-blocking questions alone do not prevent a ready Plan; never guess an answer needed for safe execution.",
    requiredEvidence: [
      "Independent investigation and steps were completed before a blocker was raised",
    ],
  },
  {
    id: "workflow.execute.approved",
    version: 1,
    title: "Execute only an approved current Plan",
    phases: ["execute"],
    priority: "required",
    terms: ["execute", "approved", "current plan"],
    instruction:
      "Execute only the approved Plan tied to the current Goal. Work one active step at a time and do not claim completion from intention.",
    requiredEvidence: ["The active step and its verification result"],
  },
  {
    id: "workflow.verify.evidence",
    version: 1,
    title: "Completion requires evidence",
    phases: ["verify"],
    priority: "required",
    terms: ["verify", "test", "evidence", "acceptance"],
    instruction:
      "Check every applicable acceptance criterion and rule. Report failures explicitly; do not silently repair or waive them.",
    requiredEvidence: ["Evidence or an explicit failure for every checked criterion"],
  },
  {
    id: "workflow.plan.migration",
    version: 1,
    title: "Plan reversible migrations",
    phases: ["plan", "execute", "verify"],
    priority: "recommended",
    terms: ["database", "schema", "migration", "backfill", "rollout"],
    instruction:
      "For schema or data changes, specify compatibility order, rollback behavior, backfill strategy and validation.",
    requiredEvidence: ["Migration compatibility and rollback were considered"],
  },
  {
    id: "workflow.plan.testing",
    version: 1,
    title: "Plan verification with the change",
    phases: ["plan", "execute", "verify"],
    priority: "recommended",
    terms: ["test", "typecheck", "lint", "build", "acceptance", "regression"],
    instruction:
      "Name the smallest checks that prove the step, then include broader regression checks appropriate to the affected area.",
    requiredEvidence: ["Commands or observations and their actual results"],
  },
  {
    id: "workflow.plan.documentation",
    version: 1,
    title: "Research authoritative interfaces",
    phases: ["plan"],
    priority: "recommended",
    terms: ["api", "library", "framework", "documentation", "docs", "version"],
    instruction:
      "When behavior depends on an external API or library version, research the authoritative documentation and record the relevant constraint in the Plan.",
    requiredEvidence: ["The authoritative source or installed implementation was checked"],
  },
];

export const builtInWorkflowRules: readonly WorkflowRule[] = builtInRuleInputs.map((rule) => ({
  ...rule,
  source: RuleSource.cases.builtin.make({ name: rule.id }),
}));

const normalizedTerms = (text: string) =>
  HashSet.fromIterable(
    text
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}_./:-]+/u)
      .filter(Boolean),
  );

const lexicalScore = (query: HashSet.HashSet<string>, rule: WorkflowRule) =>
  HashSet.size(
    HashSet.intersection(
      query,
      normalizedTerms(`${rule.title} ${rule.terms.join(" ")} ${rule.instruction}`),
    ),
  );

const cosine = (left: Float32Array, right: Float32Array) =>
  left.reduce((score, value, index) => score + value * right[index]!, 0);

const make = Effect.gen(function* () {
  const embedder = yield* Embedder;
  const vectorSets = yield* Cache.makeWith<
    readonly WorkflowRule[],
    MutableHashMap.MutableHashMap<string, Float32Array>,
    EmbeddingError
  >(
    (rules) =>
      embedder
        .embed(rules.map((rule) => `${rule.title}\n${rule.terms.join(" ")}\n${rule.instruction}`))
        .pipe(
          Effect.map((embedded) =>
            MutableHashMap.fromIterable(
              rules.flatMap((rule, index) => {
                const vector = embedded[index];
                return isTruthy(vector) ? [[rule.id, vector] as const] : [];
              }),
            ),
          ),
        ),
    {
      capacity: 32,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? "1 hour" : 0),
    },
  );

  const vectors = (rules: readonly WorkflowRule[]) => Cache.get(vectorSets, rules);

  return {
    resolve: ({ phase, text, rules = [], limit = 3 }: RuleQuery): Effect.Effect<ResolvedRules> => {
      // A built-in rule keeps its id; a supplied rule with the same id is ignored.
      const candidates = EffectArray.dedupeWith(
        [...builtInWorkflowRules, ...rules],
        (left, right) => left.id === right.id,
      ).filter((rule) => rule.phases.includes(phase));
      const required = candidates.filter((rule) => rule.priority === "required");
      const optional = candidates.filter((rule) => rule.priority === "recommended");
      if (optional.length === 0) return Effect.succeed({ rules: required, degraded: [] as const });

      const queryTerms = normalizedTerms(text);
      const lexical = optional
        .map((rule) => ({ rule, score: lexicalScore(queryTerms, rule) }))
        .sort((left, right) => right.score - left.score);

      return Effect.gen(function* () {
        const semantic = yield* Effect.result(
          Effect.all([vectors(optional), embedder.embed([text])]).pipe(
            Effect.map(([byId, [queryVector]]) =>
              isTruthy(queryVector)
                ? optional
                    .map((rule) => ({
                      rule,
                      score: isTruthy(Option.getOrUndefined(MutableHashMap.get(byId, rule.id)))
                        ? cosine(
                            queryVector,
                            Option.getOrUndefined(MutableHashMap.get(byId, rule.id))!,
                          )
                        : -1,
                    }))
                    .sort((left, right) => right.score - left.score)
                : [],
            ),
          ),
        );
        const ranks = MutableHashMap.empty<string, number>();
        const addRanks = (ranked: readonly { readonly rule: WorkflowRule }[]) =>
          ranked.forEach(({ rule }, index) =>
            MutableHashMap.set(
              ranks,
              rule.id,
              (Option.getOrUndefined(MutableHashMap.get(ranks, rule.id)) ?? 0) +
                1 / (60 + index + 1),
            ),
          );
        addRanks(lexical);
        const degraded = Result.match(semantic, {
          onFailure: () => ["embedding"] as const,
          onSuccess: (ranked) => {
            addRanks(ranked);
            return [] as const;
          },
        });

        const selected = optional
          .filter(
            (rule) => lexicalScore(queryTerms, rule) > 0 || MutableHashMap.has(ranks, rule.id),
          )
          .sort(
            (left, right) =>
              (Option.getOrUndefined(MutableHashMap.get(ranks, right.id)) ?? 0) -
              (Option.getOrUndefined(MutableHashMap.get(ranks, left.id)) ?? 0),
          )
          .slice(0, limit);
        return {
          rules: [...required, ...selected],
          degraded,
        };
      });
    },
  };
});

/** Phase-filtered workflow rules with lexical + embedding ranking for optional rules. */
export class WorkflowRules extends Context.Service<WorkflowRules, Effect.Success<typeof make>>()(
  "memory-agent/workflow/rules/WorkflowRules",
) {
  static readonly layer = Layer.effect(WorkflowRules, make);
}
