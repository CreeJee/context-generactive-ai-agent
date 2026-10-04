import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { maxIterations, normalizeSystemPrompts, type ModelMessage } from "@tanstack/ai";
import { AgentChat } from "../src/agent/chat.ts";
import { ApiUsage } from "../src/agent/api-usage.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { GlobalConfig } from "../src/config/global-config.ts";
import { defaultStorageRoot } from "../src/config/storage-root.ts";
import { optionalProperty } from "../src/optional-property.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { Projects } from "../src/projects/projects.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import type { ProviderId } from "../src/providers/contracts.ts";
import { SubscriptionProviderRegistry } from "../src/providers/subscriptions.ts";
import { listOAuthProfiles } from "../src/oauth/accounts.ts";
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
const Selection = Schema.Struct({
  provider: Schema.Literal("openai"),
  model: Schema.NonEmptyString,
  reasoningEffort: Schema.NonEmptyString,
});
const selection = Schema.decodeUnknownSync(Schema.fromJsonString(Selection))(
  readFileSync(join(defaultStorageRoot, "config.json"), "utf8"),
);
const accountDatabase = new DatabaseSync(join(defaultStorageRoot, "agent.db"), { readOnly: true });
const selectedProfile = listOAuthProfiles(accountDatabase, selection.provider).find(
  (profile) => profile.selected,
)?.id;
accountDatabase.close();
const client = createSubscriptionOAuthClient({
  protocol: providerProtocols.openai,
  ...optionalProperty(
    "store",
    selectedProfile ? createKeychainProfileCredentialStore(selectedProfile) : undefined,
  ),
});
const baseline = `You can delegate with run_subagent and message_subagent. A child sees only the task and uses the same workspace, model and permissions. Dispatch returns immediately. Use wait_subagents when needed and retrieve its report with get_subagent_report before relying on it. Before a final answer call adopt_subagent_reports with only the reports and evidence actually used.`;
const frames = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    delta: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
  }),
);
let totalCalls = 0;
let estimatedInputTokens = 0;

async function arm(variant: "baseline-guidance" | "optimized-guidance") {
  const base = mkdtempSync(join(tmpdir(), "delegation-live-eval-"));
  const projectRoot = join(base, "project");
  const home = join(base, "home");
  mkdirSync(projectRoot);
  mkdirSync(home);
  writeFileSync(
    join(projectRoot, "main.ts"),
    "export const mainTotal = [2, 3, 5].reduce((sum, x) => sum + x, 0);\n",
  );
  writeFileSync(
    join(projectRoot, "child.ts"),
    "export const childTotal = [7, 11].reduce((sum, x) => sum + x, 0);\n",
  );
  const observations: { at: number; child: boolean; toolCalls: readonly string[] }[] = [];
  const registry = Layer.effect(
    ProviderRegistry,
    Effect.gen(function* () {
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
                        subscriptionRequest(selected.provider, selected, options),
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
                      observations.push({ at: Date.now(), child, toolCalls: calls });
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
  const runtime = ManagedRuntime.make(
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
  try {
    const services = await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* GlobalConfig).update(selection);
        const provider = yield* (yield* ProviderRegistry).get(selection.provider);
        if ((yield* provider.auth.status).status !== "signed-in")
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
    );
    const started = Date.now();
    const prompt = `Audit two independent files without modifying them. Delegate child.ts to one subagent; its task must first run the finite command node -e 'setTimeout(()=>console.log("ready"),10000)' and then read child.ts and report childTotal. You personally read main.ts and calculate mainTotal while the child runs. Retrieve and review the child's report before giving both totals. Do not change the Goal or Plan. Do not create another delegation to poll.`;
    const response = await runtime.runPromise(
      services.agent.handle(
        new Request("http://local/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: services.session.id,
            runId: randomUUID(),
            messages: [{ id: randomUUID(), role: "user", content: prompt }],
            tools: [],
            context: [],
          }),
        }),
        services.session.id,
      ),
    );
    const sse = await response.text();
    if (!response.ok) throw new Error(`pilot_http_${response.status}: ${sse}`);
    const events = sse
      .split("\n")
      .flatMap((line) =>
        line.startsWith("data: ") ? [Schema.decodeSync(frames)(line.slice(6))] : [],
      );
    const errors = events.filter((event) => event.type === "RUN_ERROR" || event.type === "error");
    if (errors.length > 0) throw new Error(`pilot_run_failed: ${JSON.stringify(errors)}`);
    const answer = sse
      .split("\n")
      .flatMap((line) =>
        line.startsWith("data: ") ? [Schema.decodeSync(frames)(line.slice(6))] : [],
      )
      .flatMap((chunk) =>
        chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta ? [chunk.delta] : [],
      )
      .join("");
    const messages: ModelMessage[] = await services.state.persistence.stores.messages.loadThread(
      services.session.id,
    );
    const calls = messages.flatMap((message) =>
      message.role === "assistant" ? (message.toolCalls ?? []) : [],
    );
    const independent = observations.some(
      (observation) =>
        !observation.child &&
        observation.toolCalls.includes("read_file") &&
        services.children
          .list(services.session.id)
          .some((child) => child.createdAt <= observation.at && child.updatedAt > observation.at),
    );
    return {
      variant,
      selection,
      durationMs: Date.now() - started,
      independentWorkBeforeChildCompletion: independent,
      pollingCalls: calls.filter((call) => call.function.name === "wait_subagents").length,
      waitArguments: calls
        .filter((call) => call.function.name === "wait_subagents")
        .map((call) => call.function.arguments),
      reportCalls: calls.filter((call) =>
        ["get_subagent_report", "get_subagent_reports"].includes(call.function.name),
      ).length,
      toolCalls: calls.map((call) => call.function.name),
      correctTotals: answer.includes("10") && answer.includes("18"),
      answer,
      usage: services.usage.byRootSession(services.session.id),
    };
  } finally {
    await runtime.dispose();
    rmSync(base, { recursive: true, force: true });
  }
}
const results = [await arm("baseline-guidance"), await arm("optimized-guidance")];
console.log(
  JSON.stringify(
    {
      results,
      totalCalls,
      estimatedInputTokens,
      note: "A serial two-arm pilot, not statistically significant. The preflight estimate is not billed usage.",
    },
    null,
    2,
  ),
);
