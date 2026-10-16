import { NodeServices } from "@effect/platform-node";
import { DatabaseSync } from "node:sqlite";
import {
  Clock,
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Path,
  Schema,
  Stream,
} from "effect";
import { defaultStorageRoot } from "../src/config/storage-root.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { readStructuredEvidence } from "../src/memory/evidence.ts";
import { listOAuthProfiles } from "../src/oauth/accounts.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";
import {
  createKeychainProfileCredentialStore,
  createSubscriptionOAuthClient,
} from "../src/oauth/validation-harness.ts";
import { ModelSelection } from "../src/providers/contracts.ts";
import { subscriptionRequest } from "../src/providers/subscription-adapter.ts";
import { Projects } from "../src/projects/projects.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../src/testing/fake-morph.ts";
import { createMemoryTools } from "../src/tools/memory.ts";
import { seedEvidenceCases } from "./structured-memory-fixtures.ts";
import { evidenceNarrative } from "./evidence-narrative.ts";
import { estimateRequestTokens, exceedsRequestTokenBudget } from "./request-token-budget.ts";

class BenchmarkFailed extends Schema.TaggedError<BenchmarkFailed>()("BenchmarkFailed", {
  reason: Schema.Literals(["configuration", "profile", "fixture", "budget", "provider", "output"]),
}) {}

interface ReportedUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  cachedPromptTokens: number | null;
}

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const wire = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
const Answer = Schema.Struct({
  value: Schema.String,
  explanation: Schema.String,
  evidence: Schema.Array(Schema.Struct({ id: Schema.String, quote: Schema.NonEmptyString })),
});
const baselineVariants = ["legacy-read", "legacy-read-trace", "structured-read"] as const;
const ablationVariants = [
  "structured-read",
  "structured-at-time",
  "structured-followup",
  "narrative-followup",
] as const;
const repeats = 2;
const inputLimit = 6_000;
const outputLimit = 2_048;
const system =
  'Answer the question using only the supplied memory evidence. Distinguish user decisions from observations, applied changes from unconfirmed proposals, current scope from historical scope, and the target of each correction. An applied relation is a recorded interpretation, not independent proof. Do not guess missing values. Return only JSON: {"value":"literal configuration value or UNKNOWN","explanation":"brief reasoning","evidence":[{"id":"source node id","quote":"exact supporting text from the supplied evidence"}]}. Use UNKNOWN if the requested value is not established, has been withdrawn without replacement, or remains unresolved. Give no more than 3 short quotes. Do not call tools.';

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ablation = process.argv.includes("--ablation");
  const variants = ablation ? ablationVariants : baselineVariants;
  const output = yield* Config.String("MEMORY_EVIDENCE_OUTPUT").pipe(
    Config.withDefault(
      ablation ? "/tmp/structured-memory-ablation.json" : "/tmp/structured-memory-benchmark.json",
    ),
  );
  const live = process.argv.includes("--live");
  const selection = yield* fs
    .readFileString(path.join(defaultStorageRoot, "config.json"))
    .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ModelSelection))));
  // The installed subscription serializer's Anthropic max_tokens contract is known. Do not
  // invent an output-budget parameter for another provider or silently change the chosen model.
  if (selection.provider !== "anthropic")
    return yield* BenchmarkFailed.make({ reason: "configuration" });
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "memory-evidence-pilot-" });
  const projectRoot = path.join(base, "project");
  const home = path.join(base, "home");
  yield* fs.makeDirectory(projectRoot);
  yield* fs.makeDirectory(home);
  const services = yield* Layer.build(
    memoryAgentLayer(path.join(base, "storage"), {
      embedder: fakeEmbedderLayer,
      morphAnalyzer: fakeMorphLayer,
      interpretAutomatically: false,
      summarizeAutomatically: false,
      importsHome: home,
      importsWatching: false,
      sweepSecrets: false,
      skillsHome: home,
      skillsBuiltin: path.join(home, "builtin"),
    }),
  );
  const seeded = yield* Effect.provideContext(
    Effect.gen(function* () {
      const project = yield* (yield* Projects).add(projectRoot);
      return { ...(yield* seedEvidenceCases(project.id)), projectId: project.id };
    }),
    services,
  );
  const tools = createMemoryTools(seeded.env, seeded.projectId).tools;
  // Freeze the question time after all fixture events, before any model requests.
  const questionAt = seeded.cases
    .flatMap((fixture) => fixture.sources.map((source) => source.createdAt))
    .sort()
    .at(-1)!;
  const snapshots = yield* Effect.forEach(
    seeded.cases,
    Effect.fnUntraced(function* (fixture) {
      const structured = yield* Effect.provideContext(
        readStructuredEvidence(fixture.root.id, 0, seeded.projectId, false),
        services,
      );
      if (structured === null) return yield* BenchmarkFailed.make({ reason: "fixture" });
      // Exactly the pre-PR read_evidence result; same source page and metadata.
      const { evidenceContext: _context, ...legacy } = structured;
      const trace = yield* Effect.tryPromise({
        try: () => Promise.resolve(tools[2].execute!({ id: fixture.root.id })),
        catch: () => BenchmarkFailed.make({ reason: "fixture" }),
      });
      const followup = ablation
        ? yield* Effect.forEach(
            [...new Set(structured.evidenceContext.changes.map((change) => change.source.id))],
            Effect.fnUntraced(function* (id) {
              const page = yield* Effect.provideContext(
                readStructuredEvidence(id, 0, seeded.projectId, false),
                services,
              );
              if (page === null) return yield* BenchmarkFailed.make({ reason: "fixture" });
              return page;
            }),
            { concurrency: 1 },
          )
        : [];
      return yield* Effect.forEach(
        variants,
        Effect.fnUntraced(function* (variant) {
          const followsUp = variant === "structured-followup" || variant === "narrative-followup";
          const pages = followsUp ? [structured, ...followup] : [structured];
          const context =
            variant === "legacy-read-trace"
              ? [
                  { tool: "read_evidence", result: legacy },
                  { tool: "trace_evidence", result: trace },
                ]
              : variant === "legacy-read"
                ? [{ tool: "read_evidence", result: legacy }]
                : pages.map((result) => ({ tool: "read_evidence", result }));
          const contextText =
            variant === "narrative-followup"
              ? yield* evidenceNarrative(pages)
              : yield* encode(context);
          const questionTime =
            ablation && variant !== "structured-read" ? `Question asked at: ${questionAt}\n` : "";
          const content = `${questionTime}Question: ${fixture.question}\nMemory tool results:\n${contextText}`;
          const request = yield* Schema.decodeEffect(wire)(
            subscriptionRequest({
              provider: "anthropic",
              selection,
              options: { messages: [{ role: "user", content }], systemPrompts: [system] },
              requestOptions: { promptCache: "disabled" },
            }),
          );
          const body = yield* Schema.encodeEffect(wire)({ ...request, max_tokens: outputLimit });
          const estimate = estimateRequestTokens(body, selection.model);
          if (exceedsRequestTokenBudget(estimate, inputLimit))
            return yield* BenchmarkFailed.make({ reason: "budget" });
          const included = fixture.support.filter(({ quote }) =>
            contextText.includes(quote),
          ).length;
          return {
            fixture,
            variant,
            context,
            contextText,
            content,
            body,
            estimate,
            supportIncluded: included,
            supportTotal: fixture.support.length,
            fullSupport: included === fixture.support.length,
            toolCalls: variant === "legacy-read-trace" ? 2 : followsUp ? pages.length : 1,
          };
        }),
        { concurrency: 1 },
      );
    }),
    { concurrency: 1 },
  );
  const rows: Array<{
    case: string;
    variant: (typeof variants)[number];
    repeat: number;
    value: string;
    answer: typeof Answer.Type | null;
    rawAnswer: string;
    validOutput: boolean;
    correct: boolean;
    revokedValueUsed: boolean;
    supportIncluded: number;
    supportTotal: number;
    fullSupport: boolean;
    citedSupport: number;
    validCitations: number;
    citationCount: number;
    estimatedInputTokens: number;
    durationMs: number;
    usage: ReportedUsage;
  }> = [];
  const report = () => ({
    schemaVersion: 2,
    protocol: ablation ? "time-followup-presentation" : "baseline-comparison",
    system,
    questionAt: ablation ? questionAt : null,
    selection,
    live,
    repeats,
    maxRequests: seeded.cases.length * variants.length * repeats,
    inputTokenEstimateLimit: inputLimit,
    inputMargin: 1.25,
    maxOutputTokens: outputLimit,
    scope:
      "Synthetic fixed-candidate reading pilot; not retrieval or end-to-end agent accuracy. Follow-up reads, when enabled, are scripted, not chosen by the model.",
    snapshots: snapshots
      .flat()
      .map(
        ({
          fixture,
          variant,
          context,
          content,
          estimate,
          supportIncluded,
          supportTotal,
          fullSupport,
          toolCalls,
        }) => ({
          case: fixture.name,
          question: fixture.question,
          expected: fixture.expected,
          variant,
          context,
          content,
          estimate,
          support: fixture.support,
          sources: fixture.sources.map(({ id, kind, text }) => ({ id, kind, text })),
          supportIncluded,
          supportTotal,
          fullSupport,
          toolCalls,
        }),
      ),
    rows,
    summary: variants.map((variant) => {
      const selected = rows.filter((row) => row.variant === variant);
      return {
        variant,
        attempts: selected.length,
        correct: selected.filter((row) => row.correct).length,
        fullSupport: selected.filter((row) => row.fullSupport).length,
        supportIncluded: selected.reduce((sum, row) => sum + row.supportIncluded, 0),
        supportTotal: selected.reduce((sum, row) => sum + row.supportTotal, 0),
        citedSupport: selected.reduce((sum, row) => sum + row.citedSupport, 0),
        invalidOutputs: selected.filter((row) => !row.validOutput).length,
        revokedValueUsed: selected.filter((row) => row.revokedValueUsed).length,
      };
    }),
  });
  const save = Effect.fnUntraced(function* () {
    yield* fs.writeFileString(output, yield* encode(report()));
  });
  yield* save();
  if (!live)
    return yield* Console.log(
      `Prepared ${snapshots.flat().length} contexts; no model requests. ${output}`,
    );

  const profile = yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => new DatabaseSync(path.join(defaultStorageRoot, "agent.db"), { readOnly: true }),
      catch: () => BenchmarkFailed.make({ reason: "profile" }),
    }),
    (sqlite) =>
      Effect.try({
        try: () =>
          listOAuthProfiles({ sqlite, provider: "anthropic" }).find((entry) => entry.selected),
        catch: () => BenchmarkFailed.make({ reason: "profile" }),
      }),
    (sqlite) => Effect.sync(() => sqlite.close()),
  );
  if (profile === undefined) return yield* BenchmarkFailed.make({ reason: "profile" });
  const client = createSubscriptionOAuthClient({
    protocol: providerProtocols.anthropic,
    store: createKeychainProfileCredentialStore(profile.id),
  });
  // Serial execution, balanced arm order, a per-request timeout and a fixed request count.
  // Save every completed answer; transport errors stop the run and never become wrong answers.
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const [index, arms] of snapshots.entries()) {
      for (let position = 0; position < variants.length; position++) {
        const arm = arms[(index + repeat + position) % variants.length]!;
        const started = yield* Clock.currentTimeMillis;
        const completed = yield* Effect.scoped(
          Effect.gen(function* () {
            const signal = yield* Effect.abortSignal;
            let rawAnswer = "";
            const usage: ReportedUsage = {
              promptTokens: null,
              completionTokens: null,
              cachedPromptTokens: null,
            };
            yield* Stream.fromAsyncIterable(client.stream(arm.body, signal), () =>
              BenchmarkFailed.make({ reason: "provider" }),
            ).pipe(
              Stream.runForEach((event) => {
                switch (event.type) {
                  case "text":
                    rawAnswer += event.text;
                    return Effect.void;
                  case "usage":
                    usage.promptTokens = event.promptTokens ?? usage.promptTokens;
                    usage.completionTokens = event.completionTokens ?? usage.completionTokens;
                    usage.cachedPromptTokens = event.cachedPromptTokens ?? usage.cachedPromptTokens;
                    return Effect.void;
                  case "error":
                    return Effect.fail(BenchmarkFailed.make({ reason: "provider" }));
                  default:
                    return Effect.void;
                }
              }),
            );
            return { rawAnswer, usage };
          }),
        ).pipe(Effect.timeout("90 seconds"));
        const answer = yield* Schema.decodeEffect(Schema.fromJsonString(Answer))(
          completed.rawAnswer.trim(),
        ).pipe(Effect.catchTag("SchemaError", () => Effect.succeed(null)));
        const value = answer?.value.trim().toUpperCase() ?? "";
        const valid = (answer?.evidence ?? []).filter(
          (citation) =>
            arm.fixture.sources.some(
              (source) => source.id === citation.id && source.text.includes(citation.quote),
            ) && arm.contextText.includes(citation.quote),
        );
        const citedSupport = arm.fixture.support.filter((required) =>
          valid.some(
            (citation) => citation.id === required.id && citation.quote.includes(required.quote),
          ),
        ).length;
        rows.push({
          case: arm.fixture.name,
          variant: arm.variant,
          repeat,
          value,
          answer,
          ...completed,
          validOutput: answer !== null,
          correct: value === arm.fixture.expected,
          revokedValueUsed: arm.fixture.revoked.includes(value),
          supportIncluded: arm.supportIncluded,
          supportTotal: arm.supportTotal,
          fullSupport: arm.fullSupport,
          citedSupport,
          validCitations: valid.length,
          citationCount: answer?.evidence.length ?? 0,
          estimatedInputTokens: arm.estimate.estimatedTokens,
          durationMs: (yield* Clock.currentTimeMillis) - started,
        });
        yield* save();
        yield* Console.log(
          `${rows.length}/${seeded.cases.length * variants.length * repeats} ${arm.fixture.name} ${arm.variant}: ${value === arm.fixture.expected ? "correct" : "incorrect"}`,
        );
      }
    }
  }
  yield* Console.log(yield* encode(report().summary));
});

const runtime = ManagedRuntime.make(NodeServices.layer);
await runtime.runPromise(Effect.scoped(program)).finally(() => runtime.dispose());
