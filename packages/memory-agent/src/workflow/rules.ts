import { Context, Effect, Layer, Schema } from "effect";
import { keyedSerialLimit } from "../concurrency/keyed-limit.ts";
import { Embedder } from "../memory/embedding/embedder.ts";
import { WorkflowPhase } from "./workflow.ts";

export const RuleSource = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("builtin"), name: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("project"),
    path: Schema.String,
    contentHash: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("skill"),
    name: Schema.String,
    scope: Schema.Literal("builtin", "global", "project"),
    contentHash: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("mcp-resource", "mcp-prompt"),
    serverId: Schema.String,
    name: Schema.String,
    contentHash: Schema.String,
  }),
);
export type RuleSource = typeof RuleSource.Type;

export const WorkflowRule = Schema.Struct({
  id: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
  version: Schema.Int,
  title: Schema.NonEmptyString,
  phases: Schema.Array(WorkflowPhase),
  priority: Schema.Literal("required", "recommended"),
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
  source: { kind: "builtin", name: rule.id },
}));

const normalizedTerms = (text: string) =>
  new Set(
    text
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}_./:-]+/u)
      .filter(Boolean),
  );

const lexicalScore = (query: ReadonlySet<string>, rule: WorkflowRule) => {
  const searchable = normalizedTerms(`${rule.title} ${rule.terms.join(" ")} ${rule.instruction}`);
  let overlap = 0;
  for (const term of query) if (searchable.has(term)) overlap += 1;
  return overlap;
};

const cosine = (left: Float32Array, right: Float32Array) => {
  let score = 0;
  for (let index = 0; index < left.length; index++) score += left[index]! * right[index]!;
  return score;
};

const make = Effect.gen(function* () {
  const embedder = yield* Embedder;
  const embeddingLimit = keyedSerialLimit();
  const vectorSets = new Map<string, ReadonlyMap<string, Float32Array>>();

  const vectors = (rules: readonly WorkflowRule[]) => {
    const key = rules
      .map((rule) => `${rule.id}@${rule.version}:${JSON.stringify(rule.source)}`)
      .sort()
      .join("|");
    return embeddingLimit(
      key,
      Effect.suspend(() => {
        const cached = vectorSets.get(key);
        if (cached) return Effect.succeed(cached);
        return embedder
          .embed(rules.map((rule) => `${rule.title}\n${rule.terms.join(" ")}\n${rule.instruction}`))
          .pipe(
            Effect.map((embedded) => {
              const byId = new Map(
                rules.flatMap((rule, index) => {
                  const vector = embedded[index];
                  return vector ? [[rule.id, vector] as const] : [];
                }),
              );
              // Bound stale entries when a project's rule resource changes repeatedly.
              if (vectorSets.size >= 32) vectorSets.delete(vectorSets.keys().next().value ?? "");
              vectorSets.set(key, byId);
              return byId;
            }),
          );
      }),
    );
  };

  return {
    resolve: ({ phase, text, rules = [], limit = 3 }: RuleQuery): Effect.Effect<ResolvedRules> => {
      const byId = new Map(builtInWorkflowRules.map((rule) => [rule.id, rule] as const));
      for (const rule of rules) if (!byId.has(rule.id)) byId.set(rule.id, rule);
      const candidates = [...byId.values()].filter((rule) => rule.phases.includes(phase));
      const required = candidates.filter((rule) => rule.priority === "required");
      const optional = candidates.filter((rule) => rule.priority === "recommended");
      if (optional.length === 0) return Effect.succeed({ rules: required, degraded: [] as const });

      const queryTerms = normalizedTerms(text);
      const lexical = optional
        .map((rule) => ({ rule, score: lexicalScore(queryTerms, rule) }))
        .sort((left, right) => right.score - left.score);

      return Effect.gen(function* () {
        const semantic = yield* Effect.either(
          Effect.all([vectors(optional), embedder.embed([text])]).pipe(
            Effect.map(([byId, [queryVector]]) =>
              queryVector
                ? optional
                    .map((rule) => ({
                      rule,
                      score: byId.get(rule.id) ? cosine(queryVector, byId.get(rule.id)!) : -1,
                    }))
                    .sort((left, right) => right.score - left.score)
                : [],
            ),
          ),
        );
        const ranks = new Map<string, number>();
        const addRanks = (ranked: readonly { readonly rule: WorkflowRule }[]) =>
          ranked.forEach(({ rule }, index) =>
            ranks.set(rule.id, (ranks.get(rule.id) ?? 0) + 1 / (60 + index + 1)),
          );
        addRanks(lexical);
        if (semantic._tag === "Right") addRanks(semantic.right);

        const selected = optional
          .filter((rule) => lexicalScore(queryTerms, rule) > 0 || ranks.has(rule.id))
          .sort((left, right) => (ranks.get(right.id) ?? 0) - (ranks.get(left.id) ?? 0))
          .slice(0, limit);
        return {
          rules: [...required, ...selected],
          degraded: semantic._tag === "Left" ? (["embedding"] as const) : [],
        };
      });
    },
  };
});

/** Phase-filtered workflow rules with lexical + embedding ranking for optional rules. */
export class WorkflowRules extends Context.Tag("memory-agent/WorkflowRules")<
  WorkflowRules,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(WorkflowRules, make);
}
