import { NodeServices } from "@effect/platform-node";
import type { TextOptions, Tool } from "@tanstack/ai";
import { Console, Context, Effect, FileSystem, Layer, Schema, Stream } from "effect";
import { GlobalConfig } from "../src/config/global-config.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { Projects } from "../src/projects/projects.ts";
import { AuthConnectionState, type ModelSelection } from "../src/providers/contracts.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { subscriptionRequest } from "../src/providers/subscription-adapter.ts";
import { subscriptionAgentLoop } from "../src/providers/subscription-runtime.ts";
import { runNativeEffect } from "../src/runtime/native-effect.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { randomUUID } from "../src/runtime/synchronous-crypto.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path } from "../src/runtime/synchronous-path.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../src/testing/fake-morph.ts";
import { inProcessChatApi } from "../src/testing/chat-api.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { estimateRequestTokens } from "./request-token-budget.ts";
const { join } = path;

// Local, provider-free: one first turn in a throwaway project, the request the model would get
// split into system prompts, tools and messages, each counted in o200k_base BPE tokens.

const selection: ModelSelection = {
  provider: "openai",
  model: "gpt-6.1-sol",
  reasoningEffort: "low",
};

type Request = Pick<TextOptions<Record<string, never>>, "messages" | "systemPrompts" | "tools">;

/** The first request of the run, as the engine handed it to the adapter. */
class CapturingAdapter extends ScriptedTextAdapter {
  readonly requests: Request[] = [];
  override chatStream(options: TextOptions<Record<string, never>>) {
    this.requests.push({
      messages: structuredClone(options.messages),
      systemPrompts: options.systemPrompts ?? [],
      tools: options.tools ?? [],
    });
    return super.chatStream(options);
  }
}

const adapter = new CapturingAdapter(() => ({ text: "ok" }));
const signedIn = Effect.succeed(AuthConnectionState["signed-in"]({ provider: "openai" }));
const registry = Layer.effect(
  ProviderRegistry,
  Effect.map(GlobalConfig, (config) =>
    ProviderRegistry.of({
      providers: ["openai"],
      get: () =>
        Effect.succeed({
          provider: "openai",
          auth: {
            provider: "openai",
            status: signedIn,
            connect: signedIn,
            cancel: signedIn,
            disconnect: signedIn,
          },
          models: {
            provider: "openai",
            list: Effect.succeed([
              {
                provider: "openai",
                id: selection.model,
                displayName: selection.model,
                isDefault: true,
                defaultReasoningEffort: selection.reasoningEffort,
                supportedReasoningEfforts: [selection.reasoningEffort],
                capabilities: {
                  inputModalities: ["text", "image"],
                  toolCalling: true,
                  reasoning: true,
                },
              },
            ]),
            selected: Effect.succeed(selection),
            acceptsImages: () => Effect.succeed(true),
            cheapestEffort: Effect.succeed,
            select: () => Effect.as(config.update(selection).pipe(Effect.orDie), selection),
          },
        }),
      runtime: () =>
        Effect.succeed({
          provider: "openai",
          adapter: () => adapter,
          // The eval measures the TanStack request until the loop moves to Effect AI.
          model: () => Effect.die(new Error("not used")),
          contextWindow: () => 400_000,
          agentLoop: subscriptionAgentLoop,
          runMiddleware: () => ({ name: "memory-agent/eval-prompt-overhead" }),
        }),
    }),
  ),
);

const tokens = (request: Request) =>
  estimateRequestTokens(
    subscriptionRequest({ provider: "openai", selection, options: request }),
    selection.model,
  ).estimatedTokens;

const promptText = (prompt: NonNullable<Request["systemPrompts"]>[number]) =>
  Schema.is(Schema.String)(prompt) ? prompt : prompt.content;

const firstRequest = Effect.fn("eval.promptOverhead")(function* () {
  const platform = yield* Layer.build(NodeServices.layer);
  const fs = Context.get(platform, FileSystem.FileSystem);
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-prompt-overhead-" });
  const projectRoot = join(base, "project");
  const home = join(base, "home");
  yield* fs.makeDirectory(projectRoot);
  yield* fs.makeDirectory(home);
  // The built-in skills stay: every user has them. The user's own skills and imports stay out.
  const services = yield* Layer.build(
    memoryAgentLayer(join(base, "storage"), {
      providerRegistry: registry,
      embedder: fakeEmbedderLayer,
      morphAnalyzer: fakeMorphLayer,
      interpretAutomatically: false,
      summarizeAutomatically: false,
      importsHome: home,
      importsWatching: false,
      sweepSecrets: false,
      skillsHome: home,
    }),
  );
  yield* Effect.provideContext(
    Effect.gen(function* () {
      yield* (yield* GlobalConfig).update(selection);
      const project = yield* (yield* Projects).add(projectRoot);
      const session = yield* (yield* Sessions).create(project.id);
      const chat = yield* inProcessChatApi;
      yield* Stream.runDrain(
        yield* chat.run({
          params: { session: session.id },
          headers: {},
          payload: {
            runId: randomUUID(),
            messages: [{ id: randomUUID(), role: "user", content: "hi" }],
          },
        }),
      );
    }),
    services,
  );
  const request = adapter.requests[0];
  if (request === undefined) throw new Error("no_model_request");
  return request;
}, Effect.scoped);

const request = await runNativeEffect(firstRequest());
const empty: Request = { messages: [], systemPrompts: [], tools: [] };
const base = tokens(empty);
const systemPrompts = request.systemPrompts ?? [];
const tools: readonly Tool[] = request.tools ?? [];
const report = {
  model: selection.model,
  total: tokens(request),
  system: tokens({ ...empty, systemPrompts }) - base,
  tools: tokens({ ...empty, tools: [...tools] }) - base,
  messages: tokens({ ...empty, messages: request.messages }) - base,
  toolCount: tools.length,
  systemBlocks: systemPrompts
    .map((prompt) => promptText(prompt))
    .map((text) => ({
      tokens: tokens({ ...empty, systemPrompts: [text] }) - base,
      head: text.slice(0, 70).replaceAll("\n", " "),
    })),
  perTool: tools
    .map((tool) => ({ name: tool.name, tokens: tokens({ ...empty, tools: [tool] }) - base }))
    .toSorted((left, right) => right.tokens - left.tokens),
};
// Native stdout/stderr or SDK logging boundary preserves the existing output format.
Effect.runSync(Console.log(JSON.stringify(report, null, 2)));
