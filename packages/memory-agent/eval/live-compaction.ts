import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxIterations } from "@tanstack/ai";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { AgentChat } from "../src/agent/chat.ts";
import { ApiUsage } from "../src/agent/api-usage.ts";
import { compactionState } from "../src/agent/compaction.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../src/testing/fake-morph.ts";
import { Projects } from "../src/projects/projects.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { subscriptionRequest } from "../src/providers/subscription-adapter.ts";
import { SubscriptionProviderRegistry } from "../src/providers/subscriptions.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { TurnSummaries } from "../src/agent/turn-summaries.ts";
import { estimateRequestTokens, exceedsRequestTokenBudget } from "./request-token-budget.ts";

// Explicit, paid, serial pilot only. The adapter guard stops before a provider request, including
// a summary request. It does not turn token estimates into reported usage.
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
      runtime: (provider: "openai" | "anthropic") =>
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
                  const serialized = subscriptionRequest(selection.provider, selection, options);
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

const Delta = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, delta: Schema.optional(Schema.String) }),
);
function answerFromSse(sse: string) {
  return sse
    .split("\n")
    .flatMap((line) => {
      if (!line.startsWith("data: ")) return [];
      try {
        const chunk = Schema.decodeSync(Delta)(line.slice(6));
        return chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta ? [chunk.delta] : [];
      } catch {
        return [];
      }
    })
    .join("");
}

async function runArm(variant: "auto" | "auto-plus-manual") {
  const base = mkdtempSync(join(tmpdir(), "memory-agent-paid-ab-"));
  const projectRoot = join(base, "project");
  const home = join(base, "home");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(projectRoot, "src/checksum.ts"), fixture);
  const runtime = ManagedRuntime.make(
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
  try {
    const services = await runtime.runPromise(
      Effect.gen(function* () {
        const provider = yield* (yield* ProviderRegistry).get("openai");
        const auth = yield* provider.auth.status;
        if (auth.status !== "signed-in") throw new Error("openai_not_signed_in");
        yield* provider.models.select(model, effort);
        const project = yield* (yield* Projects).add(projectRoot);
        const session = yield* (yield* Sessions).create(project.id);
        return {
          agent: yield* AgentChat,
          usage: yield* ApiUsage,
          summaries: yield* TurnSummaries,
          metadata: (yield* ChatState).persistence.stores.metadata,
          sessionId: session.id,
        };
      }),
    );
    const started = Date.now();
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
        await runtime.runPromise(services.summaries.catchUp(services.sessionId, true));
        if (variant === "auto-plus-manual") {
          const response = await runtime.runPromise(
            services.agent.compact(services.sessionId, null),
          );
          if (response.status !== 200) throw new Error(`manual_compact_status_${response.status}`);
          manual = Schema.decodeUnknownSync(
            Schema.Struct({
              cleared: Schema.Number,
              summarizedTurns: Schema.Number,
              summaryFailed: Schema.Boolean,
              tokensBefore: Schema.Number,
              tokensAfter: Schema.Number,
            }),
          )(await response.json());
          if (manual.cleared === 0 && manual.summarizedTurns === 0)
            throw new Error("pilot_manual_compact_changed_nothing");
        }
      }
      const response = await runtime.runPromise(
        services.agent.handle(
          new Request("http://localhost/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(45_000),
            body: JSON.stringify({
              threadId: services.sessionId,
              runId: randomUUID(),
              messages: [{ id: randomUUID(), role: "user", content: text }],
              tools: [],
              context: [],
            }),
          }),
          services.sessionId,
        ),
      );
      if (response.status !== 200) throw new Error(`chat_status_${response.status}`);
      answers.push(answerFromSse(await response.text()));
      const statusResponse = await runtime.runPromise(
        services.agent.status(services.sessionId, null),
      );
      const status = Schema.decodeUnknownSync(
        Schema.Struct({
          lastRun: Schema.NullOr(Schema.Struct({ status: Schema.String })),
        }),
      )(await statusResponse.json());
      if (status.lastRun?.status !== "completed")
        throw new Error(`pilot_run_${status.lastRun?.status ?? "missing"}`);
      if (calls >= maxCalls && index < prompts.length - 1)
        throw new Error("pilot_provider_budget_exceeded");
    }
    const blocks = (await compactionState(services.metadata, services.sessionId)).blocks.length;
    const final = answers.at(-1) ?? "";
    return {
      variant,
      model,
      effort,
      turns: answers.length,
      summaryBlocks: blocks,
      manual,
      usage: services.usage.byRootSession(services.sessionId),
      evidenceCorrect: final.includes(phrase),
      computationCorrect: /\b8\b/.test(final),
      elapsedMs: Date.now() - started,
      providerCallsSoFar: calls,
    };
  } finally {
    await runtime.dispose();
    rmSync(base, { recursive: true, force: true });
  }
}

// This historical A/B is invalid if automatic catch-up has already done manual /compact's work.
// Do not accidentally repeat it. A redesigned comparator needs a fresh explicit paid opt-in.
if (process.env.MEMORY_AGENT_ENABLE_PAID_COMPACTION_PILOT !== "1") {
  console.log(JSON.stringify({ stopped: true, reason: "paid_pilot_disabled_until_redesign" }));
} else {
  try {
    for (const variant of ["auto", "auto-plus-manual"] as const) {
      const outcome = await runArm(variant);
      console.log(JSON.stringify(outcome));
      // A comparison of failed coding/evidence tasks is not worth another paid arm.
      if (!outcome.evidenceCorrect || !outcome.computationCorrect)
        throw new Error("pilot_baseline_quality_failed");
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        stopped: true,
        reason: error instanceof Error ? error.message : "unknown",
        providerCallsSoFar: calls,
      }),
    );
    process.exitCode = 1;
  }
}
