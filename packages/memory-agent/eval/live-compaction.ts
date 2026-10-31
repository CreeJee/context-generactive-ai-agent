import { nativePromise, runNativeEffect } from "../src/runtime/native-effect.ts";
import {
  AuthConnectionState,
  type ModelRun,
  type ModelSelection,
} from "../src/providers/contracts.ts";
import { Cause, Config, Console, Result, Function as EffectFunction, Stream } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { NodeServices } from "@effect/platform-node";
import { Context, Crypto, FileSystem } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path } from "../src/runtime/synchronous-path.ts";
const { join } = path;
import { Array as Arr, DateTime, Effect, Layer, MutableRef, Option, Schema } from "effect";
import { AgentChat } from "../src/agent/chat.ts";
import { ApiUsage } from "../src/agent/api-usage.ts";
import { compactionStateEffect } from "../src/agent/compaction.ts";
import { RunStore } from "../src/loop/store.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../src/testing/fake-morph.ts";
import { inProcessChatApi } from "../src/testing/chat-api.ts";
import { AgUiEvent } from "../src/loop/chunks.ts";
import { Projects } from "../src/projects/projects.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { SubscriptionProviderRegistry } from "../src/providers/subscriptions.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { TurnSummaries } from "../src/agent/turn-summaries.ts";
import { pilotGuarded, pilotStopped, type PilotRequest } from "./pilot-guard.ts";
import { exceedsRequestTokenBudget } from "./request-token-budget.ts";

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
const calls = MutableRef.make(0);
const withinBudget = ({ prompt, estimate }: PilotRequest) =>
  Effect.gen(function* () {
    if (
      MutableRef.get(calls) >= maxCalls ||
      exceedsRequestTokenBudget(estimate, maxEstimatedInputTokens)
    )
      return yield* pilotStopped("pilot_provider_budget_exceeded");
    MutableRef.increment(calls);
    return prompt;
  });
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
          model: (selection: ModelSelection, run: ModelRun) =>
            Effect.map(
              runtime.model(selection, run),
              pilotGuarded({ selection, check: withinBudget }),
            ),
        })),
    };
  }),
).pipe(Layer.provide(SubscriptionProviderRegistry));

const prompts: Arr.NonEmptyReadonlyArray<string> = [
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
  const crypto = Context.get(platform, Crypto.Crypto);
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
        metadata: (yield* RunStore).chatMetadata,
        sessionId: session.id,
      };
    }),
    servicesContext,
  );
  const started = DateTime.toEpochMillis(DateTime.nowUnsafe());
  /** The manual /compact this arm runs before the final audit; it must change something. */
  const compactManually = Effect.gen(function* () {
    const manual = yield* Effect.provideContext(
      services.agent.compact(services.sessionId, null),
      servicesContext,
    );
    if (manual.cleared === 0 && manual.summarizedTurns === 0)
      throw new Error("pilot_manual_compact_changed_nothing");
    return manual;
  });
  /** One user turn, which must complete; only the last turn may use the final provider call. */
  const turn = Effect.fnUntraced(function* (text: string, last: boolean) {
    const events = yield* Effect.provideContext(
      services.chat
        .run({
          params: { session: services.sessionId },
          headers: {},
          payload: {
            runId: yield* crypto.randomUUIDv4(),
            messages: [{ id: yield* crypto.randomUUIDv4(), role: "user", content: text }],
          },
        })
        .pipe(Effect.flatMap(Stream.runCollect), Effect.timeout("45 seconds")),
      servicesContext,
    );
    const answer = events
      .flatMap(({ data }) => (AgUiEvent.guards.TEXT_MESSAGE_CONTENT(data) ? [data.delta] : []))
      .join("");
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
    if (MutableRef.get(calls) >= maxCalls && !last)
      throw new Error("pilot_provider_budget_exceeded");
    return answer;
  });
  const opening = yield* Effect.forEach(Arr.initNonEmpty(prompts), (text) => turn(text, false));
  // Wait for equal automatic summary state; do not create a manual-only comparison.
  yield* Effect.provideContext(
    services.summaries.catchUp(services.sessionId, true),
    servicesContext,
  );
  const manual = Option.getOrNull(
    yield* Effect.when(compactManually, Effect.succeed(variant === "auto-plus-manual")),
  );
  const answers = [...opening, yield* turn(Arr.lastNonEmpty(prompts), true)];
  const blocks = (yield* compactionStateEffect({
    metadata: services.metadata,
    threadId: services.sessionId,
  })).blocks.length;
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
    providerCallsSoFar: MutableRef.get(calls),
  };
}, Effect.scoped);

// This historical A/B is invalid if automatic catch-up has already done manual /compact's work.
// Do not accidentally repeat it. A redesigned comparator needs a fresh explicit paid opt-in.
// Native host/SDK configuration boundary reads or forwards the host environment.
const pilotEnabled = Effect.map(
  Config.String("MEMORY_AGENT_ENABLE_PAID_COMPACTION_PILOT").pipe(Config.withDefault("")),
  (value) => value === "1",
);

/** Both arms in order, then whether the pilot stopped on a failure. */
const runArms = Effect.forEach(
  ["auto", "auto-plus-manual"] as const,
  (variant) =>
    Effect.flatMap(runArm(variant), (outcome) =>
      Effect.andThen(
        // Native stdout/stderr or SDK logging boundary preserves the existing output format.
        Console.log(stringifyJson(outcome)),
        // A comparison of failed coding/evidence tasks is not worth another paid arm.
        Effect.when(
          Effect.die(new Error("pilot_baseline_quality_failed")),
          Effect.succeed(!outcome.evidenceCorrect || !outcome.computationCorrect),
        ),
      ),
    ),
  { discard: true },
).pipe(
  Effect.as(false),
  Effect.catchCause((cause) => {
    const error = Cause.squash(cause);
    // Native stdout/stderr or SDK logging boundary preserves the existing output format.
    return Console.log(
      stringifyJson({
        stopped: true,
        reason: error instanceof Error ? error.message : "unknown",
        providerCallsSoFar: MutableRef.get(calls),
      }),
    ).pipe(Effect.as(true));
  }),
);

const failed = await runNativeEffect(
  Effect.flatMap(pilotEnabled, (enabled) =>
    enabled
      ? runArms
      : // Native stdout/stderr or SDK logging boundary preserves the existing output format.
        Console.log(
          stringifyJson({ stopped: true, reason: "paid_pilot_disabled_until_redesign" }),
        ).pipe(Effect.as(false)),
  ),
);
if (failed) process.exitCode = 1;
