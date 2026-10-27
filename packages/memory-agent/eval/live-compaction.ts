import { nativePromise, runNativeEffect } from "../src/runtime/native-effect.ts";
import { AuthConnectionState } from "../src/providers/contracts.ts";
import { Config, Console, Result, Function as EffectFunction, Stream } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { randomUUID } from "../src/runtime/synchronous-crypto.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { NodeServices } from "@effect/platform-node";
import { Context, FileSystem } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path } from "../src/runtime/synchronous-path.ts";
const { join } = path;
import { maxIterations } from "@tanstack/ai";
import { DateTime, Effect, Layer, Schema } from "effect";
import { AgentChat } from "../src/agent/chat.ts";
import { ApiUsage } from "../src/agent/api-usage.ts";
import { compactionState } from "../src/agent/compaction.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../src/testing/fake-morph.ts";
import { inProcessChatApi } from "../src/testing/chat-api.ts";
import { AgUiEvent } from "../src/loop/chunks.ts";
import { Projects } from "../src/projects/projects.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { subscriptionRequest } from "../src/providers/subscription-adapter.ts";
import { SubscriptionProviderRegistry } from "../src/providers/subscriptions.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { TurnSummaries } from "../src/agent/turn-summaries.ts";
import { estimateRequestTokens, exceedsRequestTokenBudget } from "./request-token-budget.ts";

// Explicit, paid, serial pilot only. The adapter guard stops before a provider request, including
// a summary request. It does not turn token estimates into reported usage.
const stringifyJson = <A>(value: A, _replacer?: null, space?: number) =>
  Result.getOrThrow(
    Schema.encodeResult(Schema.fromJsonString(Schema.Unknown, { space: space ?? 0 }))(value),
  );

const maxCalls = 20;
// Estimated BPE tokens, with an additional 25% margin in exceedsRequestTokenBudget.
// This is not a provider usage or cached-token limit.
const maxEstimatedInputTokens = 16_000;
const model = "gpt-5.6-sol";
const effort = "low";
const phrase = "violet-copper-maple-17";
let calls = 0;
const guardedRegistry = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const upstream = yield* ProviderRegistry;
    return {
      providers: upstream.providers,
      get: upstream.get,
      runtime: (provider: "openai" | "anthropic" | "openai-compatible") =>
        Effect.map(upstream.runtime(provider), (runtime) => ({
          ...runtime,
          agentLoop: maxIterations(2),
          adapter: (selection: Parameters<typeof runtime.adapter>[0]) => {
            const adapter = runtime.adapter(selection);
            return new Proxy(adapter, {
              get(target, key) {
                if (key !== "chatStream") {
                  // The installed SDK adapter is a class with private fields; transparent proxy
                  // forwarding must bind its dynamic methods to the original instance.
                  // oxlint-disable-next-line anti-slop/no-reflect-get
                  const value = Reflect.get(target, key, target);
                  // oxlint-disable-next-line anti-slop/no-runtime-typeof
                  return typeof value === "function" ? value.bind(target) : value;
                }
                return (options: Parameters<typeof adapter.chatStream>[0]) => {
                  // Estimate the entire serialized request including tool schemas. This local
                  // BPE count is only a preflight guard; billed/cached usage comes from provider.
                  if (selection.provider === "openai-compatible")
                    throw new Error("subscription_pilot_only");
                  const serialized = subscriptionRequest({
                    provider: selection.provider,
                    selection: selection,
                    options: options,
                  });
                  const estimated = estimateRequestTokens(serialized, selection.model);
                  if (
                    calls >= maxCalls ||
                    exceedsRequestTokenBudget(estimated, maxEstimatedInputTokens)
                  )
                    throw new Error("pilot_provider_budget_exceeded");
                  calls += 1;
                  return target.chatStream(options);
                };
              },
            });
          },
        })),
    };
  }),
).pipe(Layer.provide(SubscriptionProviderRegistry));

const prompts = [
  "Read src/checksum.ts with read_file. Give only the exported function name.",
  `Remember this exact user decision: ${phrase}. Acknowledge in one line.`,
  "Compute checksum([2,3]) from that file. Reply with just the number.",
  "Compute checksum([1,1,1]) from that file. Reply with just the number.",
  "Which expression in that file weights values by position? Reply briefly.",
  "Compute checksum([]) from that file. Reply with just the number.",
  "Final audit: give the exact decision phrase I supplied earlier and checksum([2,3]). Verify earlier evidence if it was summarized. Reply briefly.",
];
const fixture =
  "export function checksum(values: readonly number[]) { return values.reduce((sum, value, index) => sum + value * (index + 1), 0); }\n";

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const runArm = Effect.fn("eval.runArm")(function* (variant: "auto" | "auto-plus-manual") {
  const platform = yield* Layer.build(NodeServices.layer);
  const fs = Context.get(platform, FileSystem.FileSystem);
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-paid-ab-" });
  const projectRoot = join(base, "project");
  const home = join(base, "home");
  yield* fs.makeDirectory(join(projectRoot, "src"), { recursive: true });
  yield* fs.makeDirectory(home);
  yield* fs.writeFileString(join(projectRoot, "src/checksum.ts"), fixture);
  const servicesContext = yield* Layer.build(
    memoryAgentLayer(join(base, "storage"), {
      providerRegistry: guardedRegistry,
      embedder: fakeEmbedderLayer,
      morphAnalyzer: fakeMorphLayer,
      interpretAutomatically: false,
      summarizeAutomatically: true,
      importsHome: home,
      importsWatching: false,
      sweepSecrets: false,
      skillsHome: home,
      skillsBuiltin: join(home, "builtin-skills"),
    }),
  );
  const services = yield* Effect.provideContext(
    Effect.gen(function* () {
      const provider = yield* (yield* ProviderRegistry).get("openai");
      const auth = yield* provider.auth.status;
      if (!AuthConnectionState.$is("signed-in")(auth)) throw new Error("openai_not_signed_in");
      yield* provider.models.select(model, effort);
      const project = yield* (yield* Projects).add(projectRoot);
      const session = yield* (yield* Sessions).create(project.id);
      return {
        agent: yield* AgentChat,
        chat: yield* inProcessChatApi,
        usage: yield* ApiUsage,
        summaries: yield* TurnSummaries,
        metadata: (yield* ChatState).persistence.stores.metadata,
        sessionId: session.id,
      };
    }),
    servicesContext,
  );
  const started = DateTime.toEpochMillis(DateTime.nowUnsafe());
  const answers: string[] = [];
  let manual: {
    cleared: number;
    summarizedTurns: number;
    summaryFailed: boolean;
    tokensBefore: number;
    tokensAfter: number;
  } | null = null;
  for (const [index, text] of prompts.entries()) {
    if (index === 6) {
      // Wait for equal automatic summary state; do not create a manual-only comparison.
      yield* Effect.provideContext(
        services.summaries.catchUp(services.sessionId, true),
        servicesContext,
      );
      if (variant === "auto-plus-manual") {
        const response = yield* Effect.provideContext(
          services.agent.compact(services.sessionId, null),
          servicesContext,
        );
        if (response.status !== 200) throw new Error(`manual_compact_status_${response.status}`);
        // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
        manual = EffectFunction.flow(
          Schema.decodeUnknownResult(
            Schema.Struct({
              cleared: Schema.Finite,
              summarizedTurns: Schema.Finite,
              summaryFailed: Schema.Boolean,
              tokensBefore: Schema.Finite,
              tokensAfter: Schema.Finite,
            }),
          ),
          Result.getOrThrow,
        )(yield* nativePromise(() => response.json()));
        if (manual.cleared === 0 && manual.summarizedTurns === 0)
          throw new Error("pilot_manual_compact_changed_nothing");
      }
    }
    const events = yield* Effect.provideContext(
      services.chat
        .run({
          params: { session: services.sessionId },
          headers: {},
          payload: {
            runId: randomUUID(),
            messages: [{ id: randomUUID(), role: "user", content: text }],
          },
        })
        .pipe(Effect.flatMap(Stream.runCollect), Effect.timeout("45 seconds")),
      servicesContext,
    );
    answers.push(
      events
        .flatMap(({ data }) => (AgUiEvent.guards.TEXT_MESSAGE_CONTENT(data) ? [data.delta] : []))
        .join(""),
    );
    const statusResponse = yield* Effect.provideContext(
      services.agent.status(services.sessionId, null),
      servicesContext,
    );
    // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
    const status = EffectFunction.flow(
      Schema.decodeUnknownResult(
        Schema.Struct({
          lastRun: Schema.NullOr(Schema.Struct({ status: Schema.String })),
        }),
      ),
      Result.getOrThrow,
    )(yield* nativePromise(() => statusResponse.json()));
    if (status.lastRun?.status !== "completed")
      throw new Error(`pilot_run_${status.lastRun?.status ?? "missing"}`);
    if (calls >= maxCalls && index < prompts.length - 1)
      throw new Error("pilot_provider_budget_exceeded");
  }
  const blocks = (yield* nativePromise(() =>
    compactionState(services.metadata, services.sessionId),
  )).blocks.length;
  const final = answers.at(-1) ?? "";
  return {
    variant,
    model,
    effort,
    turns: answers.length,
    summaryBlocks: blocks,
    manual,
    usage: yield* services.usage.byRootSession(services.sessionId),
    evidenceCorrect: final.includes(phrase),
    computationCorrect: /\b8\b/.test(final),
    elapsedMs: DateTime.toEpochMillis(DateTime.nowUnsafe()) - started,
    providerCallsSoFar: calls,
  };
}, Effect.scoped);

// This historical A/B is invalid if automatic catch-up has already done manual /compact's work.
// Do not accidentally repeat it. A redesigned comparator needs a fresh explicit paid opt-in.
// Native host/SDK configuration boundary reads or forwards the host environment.
if (
  Effect.runSync(
    Config.String("MEMORY_AGENT_ENABLE_PAID_COMPACTION_PILOT").pipe(Config.withDefault("")),
  ) !== "1"
) {
  // Native stdout/stderr or SDK logging boundary preserves the existing output format.
  Effect.runSync(
    Console.log(stringifyJson({ stopped: true, reason: "paid_pilot_disabled_until_redesign" })),
  );
} else {
  try {
    for (const variant of ["auto", "auto-plus-manual"] as const) {
      const outcome = await runNativeEffect(runArm(variant));
      // Native stdout/stderr or SDK logging boundary preserves the existing output format.
      Effect.runSync(Console.log(stringifyJson(outcome)));
      // A comparison of failed coding/evidence tasks is not worth another paid arm.
      if (!outcome.evidenceCorrect || !outcome.computationCorrect)
        throw new Error("pilot_baseline_quality_failed");
    }
  } catch (error) {
    // Native stdout/stderr or SDK logging boundary preserves the existing output format.
    Effect.runSync(
      Console.log(
        stringifyJson({
          stopped: true,
          reason: error instanceof Error ? error.message : "unknown",
          providerCallsSoFar: calls,
        }),
      ),
    );
    process.exitCode = 1;
  }
}
