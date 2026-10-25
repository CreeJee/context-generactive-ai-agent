import { nativePromise, runNativeEffect } from "../src/runtime/native-effect.ts";
import { Console, Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../src/truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { randomUUID } from "../src/runtime/synchronous-crypto.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { NodeServices } from "@effect/platform-node";
import { Context, FileSystem } from "effect";
import { runOAuthNodeEffect } from "../src/oauth/node-runtime.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path } from "../src/runtime/synchronous-path.ts";
const { join } = path;
import { DateTime, Clock, Effect, Layer, Schedule, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { maxIterations, normalizeSystemPrompts, type ModelMessage } from "@tanstack/ai";
import { AgentChat } from "../src/agent/chat.ts";
import { ApiUsage } from "../src/agent/api-usage.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { messageText } from "../src/messages/text.ts";
import { GlobalConfig } from "../src/config/global-config.ts";
import { defaultStorageRoot } from "../src/config/storage-root.ts";
import { optionalProperty } from "../src/optional-property.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { Projects } from "../src/projects/projects.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { AuthConnectionState, type ProviderId } from "../src/providers/contracts.ts";
import { SubscriptionProviderRegistry } from "../src/providers/subscriptions.ts";
import { storedOAuthProfiles } from "./stored-profiles.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";
import {
  createKeychainProfileCredentialStore,
  createSubscriptionOAuthClient,
} from "../src/oauth/validation-harness.ts";
import { createSubscriptionProvider } from "../src/providers/subscription-provider.ts";
import { createSubscriptionRuntime } from "../src/providers/subscription-runtime.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { Subagents } from "../src/subagents/subagents.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../src/testing/fake-morph.ts";
import { estimateRequestTokens, exceedsRequestTokenBudget } from "./request-token-budget.ts";
import { subscriptionRequest } from "../src/providers/subscription-adapter.ts";

// Explicit live pilot over synthetic files only. Never writes the user's config or project.
// This comparison changes parent guidance only; it is not a benchmark of old runtime behavior.
const stringifyJson = <A>(value: A, _replacer?: null, space?: number) =>
  Result.getOrThrow(
    Schema.encodeResult(Schema.fromJsonString(Schema.Unknown, { space: space ?? 0 }))(value),
  );

const Selection = Schema.Struct({
  provider: Schema.Literal("openai"),
  model: Schema.NonEmptyString,
  reasoningEffort: Schema.NonEmptyString,
});
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const selection = EffectFunction.flow(
  Schema.decodeResult(Schema.fromJsonString(Selection)),
  Result.getOrThrow,
)(
  await runOAuthNodeEffect(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.readFileString(join(defaultStorageRoot, "config.json")),
    ),
  ),
);
const selectedProfile = (await runOAuthNodeEffect(storedOAuthProfiles(selection.provider))).find(
  (profile) => profile.selected,
)?.id;
const client = createSubscriptionOAuthClient({
  protocol: providerProtocols.openai,
  ...optionalProperty(
    "store",
    isTruthy(selectedProfile) ? createKeychainProfileCredentialStore(selectedProfile) : undefined,
  ),
});
const baseline = `You can delegate with run_subagent, optionally to a named helper. A child sees only the task and uses the same workspace, model and permissions. Dispatch returns immediately. Retrieve its report with get_subagent_reports before relying on it. Before a final answer call adopt_subagent_reports with only the reports and evidence actually used.`;
const Busy = Schema.Struct({ busy: Schema.Finite });
/**
 * Until the session's children and the follow-ups they started are over: a child's report can
 * reach the parent only in its completion follow-up, after the first run ended. A follow-up takes
 * its notifications before its run is recorded, so each must have reached a run that ended.
 */
const settled = (sessionId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT
        (SELECT count(*) FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
         WHERE t.origin_session_id = ${sessionId}
           AND a.status IN ('queued', 'running', 'waiting', 'blocked'))
        + (SELECT count(*) FROM chat_runs WHERE thread_id = ${sessionId} AND status = 'running')
        + (SELECT count(*) FROM parent_notifications n
           WHERE n.origin_session_id = ${sessionId} AND NOT EXISTS (
             SELECT 1 FROM chat_runs r
             WHERE r.run_id = n.delivered_to_run_id AND r.status <> 'running')) AS busy`.pipe(
      Effect.flatMap((rows) => Schema.decodeUnknownEffect(Busy)(rows[0])),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), while: ({ busy }) => busy > 0 }),
    ),
  );
const frames = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    delta: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
  }),
);
let totalCalls = 0;
let estimatedInputTokens = 0;

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const arm = Effect.fn("eval.arm")(function* (variant: "baseline-guidance" | "optimized-guidance") {
  const platform = yield* Layer.build(NodeServices.layer);
  const fs = Context.get(platform, FileSystem.FileSystem);
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "delegation-live-eval-" });
  const projectRoot = join(base, "project");
  const home = join(base, "home");
  yield* fs.makeDirectory(projectRoot);
  yield* fs.makeDirectory(home);
  yield* fs.writeFileString(
    join(projectRoot, "main.ts"),
    "export const mainTotal = [2, 3, 5].reduce((sum, x) => sum + x, 0);\n",
  );
  yield* fs.writeFileString(
    join(projectRoot, "child.ts"),
    "export const childTotal = [7, 11].reduce((sum, x) => sum + x, 0);\n",
  );
  const observations: { at: number; child: boolean; toolCalls: readonly string[] }[] = [];
  const registry = Layer.effect(
    ProviderRegistry,
    Effect.gen(function* () {
      const effectClock = yield* Clock.Clock;

      const upstream = yield* ProviderRegistry;
      const { subscriptionDependencies: _nativeDependencies, ...fallback } = upstream;
      const config = yield* GlobalConfig;
      const openai = createSubscriptionProvider({
        protocol: providerProtocols.openai,
        config,
        client,
      });
      const openaiRuntime = createSubscriptionRuntime("openai", client, openai.contextWindow);
      return {
        ...fallback,
        get: (provider: ProviderId) =>
          provider === "openai" ? Effect.succeed(openai) : upstream.get(provider),
        runtime: (provider: ProviderId) =>
          Effect.map(
            provider === "openai" ? Effect.succeed(openaiRuntime) : upstream.runtime(provider),
            (service) => ({
              ...service,
              agentLoop: maxIterations(12),
              adapter: (selected: Parameters<typeof service.adapter>[0]) => {
                const adapter = service.adapter(selected);
                return new Proxy(adapter, {
                  get(target, key) {
                    if (key !== "chatStream") {
                      // SDK adapters have private fields; bind transparent forwarding to the original.
                      // oxlint-disable-next-line anti-slop/no-reflect-get
                      const value = Reflect.get(target, key, target);
                      // oxlint-disable-next-line anti-slop/no-runtime-typeof
                      return typeof value === "function" ? value.bind(target) : value;
                    }
                    return (options: Parameters<typeof adapter.chatStream>[0]) => {
                      if (selected.provider !== "openai") throw new Error("openai_pilot_only");
                      const estimate = estimateRequestTokens(
                        subscriptionRequest({
                          provider: selected.provider,
                          selection: selected,
                          options: options,
                        }),
                        selected.model,
                      );
                      if (
                        totalCalls >= 24 ||
                        estimatedInputTokens + estimate.estimatedTokens > 200_000 ||
                        exceedsRequestTokenBudget(estimate, 30_000)
                      )
                        throw new Error("delegation_pilot_budget_exceeded");
                      totalCalls++;
                      estimatedInputTokens += estimate.estimatedTokens;
                      const child = normalizeSystemPrompts(options.systemPrompts ?? []).some(
                        (prompt) => prompt.content.includes("You are a subagent"),
                      );
                      const calls = options.messages.flatMap((message) =>
                        message.role === "assistant"
                          ? (message.toolCalls ?? []).map((call) => call.function.name)
                          : [],
                      );
                      observations.push({
                        at: effectClock.currentTimeMillisUnsafe(),
                        child,
                        toolCalls: calls,
                      });
                      const prompts =
                        variant === "baseline-guidance" && !child
                          ? normalizeSystemPrompts(options.systemPrompts ?? []).map((prompt) =>
                              prompt.content.startsWith("You can delegate with run_subagent")
                                ? baseline
                                : prompt,
                            )
                          : (options.systemPrompts ?? []);
                      return target.chatStream({ ...options, systemPrompts: prompts });
                    };
                  },
                });
              },
            }),
          ),
      };
    }),
  ).pipe(Layer.provide(SubscriptionProviderRegistry));
  const servicesContext = yield* Layer.build(
    memoryAgentLayer(join(base, "storage"), {
      providerRegistry: registry,
      embedder: fakeEmbedderLayer,
      morphAnalyzer: fakeMorphLayer,
      interpretAutomatically: false,
      summarizeAutomatically: false,
      importsWatching: false,
      importsHome: home,
      skillsHome: home,
      skillsBuiltin: join(home, "builtin"),
      sweepSecrets: false,
    }),
  );
  const services = yield* Effect.provideContext(
    Effect.gen(function* () {
      yield* (yield* GlobalConfig).update(selection);
      const provider = yield* (yield* ProviderRegistry).get(selection.provider);
      if (!AuthConnectionState.$is("signed-in")(yield* provider.auth.status))
        throw new Error("pilot_not_signed_in");
      const projects = yield* Projects;
      const initial = yield* projects.add(projectRoot);
      const project = yield* projects.setPermissionMode(initial.id, "full");
      const session = yield* (yield* Sessions).create(project.id);
      return {
        agent: yield* AgentChat,
        state: yield* ChatState,
        children: yield* Subagents,
        usage: yield* ApiUsage,
        session,
      };
    }),
    servicesContext,
  );
  const started = DateTime.toEpochMillis(DateTime.nowUnsafe());
  const prompt = `Audit two independent files without modifying them. Delegate child.ts to one subagent; its task must first run the finite command node -e 'setTimeout(()=>Effect.runSync(Console.log("ready")),10000)' and then read child.ts and report childTotal. You personally read main.ts and calculate mainTotal while the child runs. Retrieve and review the child's report before giving both totals. Do not change the Goal or Plan. Do not create another delegation to poll.`;
  const response = yield* Effect.provideContext(
    services.agent.handle(
      new Request("http://local/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stringifyJson({
          threadId: services.session.id,
          runId: randomUUID(),
          messages: [{ id: randomUUID(), role: "user", content: prompt }],
          tools: [],
          context: [],
        }),
      }),
      services.session.id,
    ),
    servicesContext,
  );
  const sse = yield* nativePromise(() => response.text());
  if (!response.ok) throw new Error(`pilot_http_${response.status}: ${sse}`);
  const events = sse.split("\n").flatMap((line) =>
    // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
    line.startsWith("data: ")
      ? [EffectFunction.flow(Schema.decodeResult(frames), Result.getOrThrow)(line.slice(6))]
      : [],
  );
  const errors = events.filter((event) => event.type === "RUN_ERROR" || event.type === "error");
  if (errors.length > 0) throw new Error(`pilot_run_failed: ${stringifyJson(errors)}`);
  yield* Effect.provideContext(settled(services.session.id), servicesContext);
  const messages: ModelMessage[] = yield* nativePromise(() =>
    services.state.persistence.stores.messages.loadThread(services.session.id),
  );
  const last = messages.findLast((message) => message.role === "assistant");
  const answer = last === undefined ? "" : messageText(last);
  const calls = messages.flatMap((message) =>
    message.role === "assistant" ? (message.toolCalls ?? []) : [],
  );
  const children = yield* services.children.list(services.session.id);
  const independent = observations.some(
    (observation) =>
      !observation.child &&
      observation.toolCalls.includes("read_file") &&
      children.some(
        (child) => child.createdAt <= observation.at && child.updatedAt > observation.at,
      ),
  );
  return {
    variant,
    selection,
    durationMs: DateTime.toEpochMillis(DateTime.nowUnsafe()) - started,
    independentWorkBeforeChildCompletion: independent,
    reportCalls: calls.filter((call) => call.function.name === "get_subagent_reports").length,
    toolCalls: calls.map((call) => call.function.name),
    correctTotals: answer.includes("10") && answer.includes("18"),
    answer,
    usage: yield* services.usage.byRootSession(services.session.id),
  };
}, Effect.scoped);
const results = [
  await runNativeEffect(arm("baseline-guidance")),
  await runNativeEffect(arm("optimized-guidance")),
];
// Native stdout/stderr or SDK logging boundary preserves the existing output format.
Effect.runSync(
  Console.log(
    stringifyJson(
      {
        results,
        totalCalls,
        estimatedInputTokens,
        note: "A serial two-arm pilot, not statistically significant. The preflight estimate is not billed usage.",
      },
      null,
      2,
    ),
  ),
);
