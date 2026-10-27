import { NodeServices } from "@effect/platform-node";
import {
  Array as Arr,
  Cause,
  Console,
  Context,
  Effect,
  FileSystem,
  Layer,
  Ref,
  Stream,
} from "effect";
import { LanguageModel, Prompt, type Response, type Tool } from "effect/ai";
import { GlobalConfig } from "../src/config/global-config.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { collectResponse } from "../src/model/response.ts";
import { shownReason } from "../src/model/shown-failure.ts";
import { subscriptionBody } from "../src/model/subscription.ts";
import { Projects } from "../src/projects/projects.ts";
import { AuthConnectionState, type ModelSelection } from "../src/providers/contracts.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { runNativeEffect } from "../src/runtime/native-effect.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { randomUUID } from "../src/runtime/synchronous-crypto.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path } from "../src/runtime/synchronous-path.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../src/testing/fake-morph.ts";
import { inProcessChatApi } from "../src/testing/chat-api.ts";
import { estimateRequestTokens } from "./request-token-budget.ts";
const { join } = path;

// Local, provider-free: one first turn in a throwaway project, the request the model would get
// split into system prompts, tools and messages, each counted in o200k_base BPE tokens.

const selection: ModelSelection = {
  provider: "openai",
  model: "gpt-6.1-sol",
  reasoningEffort: "low",
};

/** Every step answers "ok" at once. */
const answer: ReadonlyArray<Response.StreamPartEncoded> = [
  { type: "response-metadata", modelId: selection.model },
  { type: "text-start", id: "text-0" },
  { type: "text-delta", id: "text-0", delta: "ok" },
  { type: "text-end", id: "text-0" },
  { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } },
];

/** A model that keeps each request the loop sends it, as the provider would receive it. */
const capturingModel = (requests: Ref.Ref<ReadonlyArray<LanguageModel.ProviderOptions>>) => {
  const streamText = (request: LanguageModel.ProviderOptions) =>
    Stream.unwrap(
      Effect.as(Ref.update(requests, Arr.append(request)), Stream.fromIterable(answer)),
    );
  return LanguageModel.make({
    streamText,
    generateText: (request) => collectResponse(streamText(request)),
  });
};

const signedIn = Effect.succeed(AuthConnectionState["signed-in"]({ provider: "openai" }));
const registry = (model: LanguageModel.LanguageModel) =>
  Layer.effect(
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
            model: () =>
              Effect.succeed({
                model,
                source: { provider: "openai", api: "text", model: selection.model },
                shownFailure: shownReason,
              }),
            contextWindow: () => 400_000,
          }),
      }),
    ),
  );

/** The estimated tokens of the OpenAI subscription request body for this prompt and these tools. */
const tokens = (prompt: Prompt.Prompt, tools: ReadonlyArray<Tool.Any> = []) =>
  estimateRequestTokens(
    subscriptionBody({ provider: "openai", selection, prompt, tools, promptCache: undefined }),
    selection.model,
  ).estimatedTokens;

const firstRequest = Effect.fn("eval.promptOverhead")(function* () {
  const platform = yield* Layer.build(NodeServices.layer);
  const fs = Context.get(platform, FileSystem.FileSystem);
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-prompt-overhead-" });
  const projectRoot = join(base, "project");
  const home = join(base, "home");
  yield* fs.makeDirectory(projectRoot);
  yield* fs.makeDirectory(home);
  const requests = yield* Ref.make<ReadonlyArray<LanguageModel.ProviderOptions>>([]);
  // The built-in skills stay: every user has them. The user's own skills and imports stay out.
  const services = yield* Layer.build(
    memoryAgentLayer(join(base, "storage"), {
      providerRegistry: registry(yield* capturingModel(requests)),
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
  return yield* Effect.fromOption(Arr.head(yield* Ref.get(requests))).pipe(
    Effect.mapError(() => new Cause.NoSuchElementError("no_model_request")),
  );
}, Effect.scoped);

const request = await runNativeEffect(firstRequest());
const systemMessages = request.prompt.content.filter((message) => message.role === "system");
const otherMessages = request.prompt.content.filter((message) => message.role !== "system");
const base = tokens(Prompt.empty);
const report = {
  model: selection.model,
  total: tokens(request.prompt, request.tools),
  system: tokens(Prompt.fromMessages(systemMessages)) - base,
  tools: tokens(Prompt.empty, request.tools) - base,
  messages: tokens(Prompt.fromMessages(otherMessages)) - base,
  toolCount: request.tools.length,
  systemBlocks: systemMessages.map((message) => ({
    tokens: tokens(Prompt.fromMessages([message])) - base,
    head: message.content.slice(0, 70).replaceAll("\n", " "),
  })),
  perTool: request.tools
    .map((tool) => ({ name: tool.name, tokens: tokens(Prompt.empty, [tool]) - base }))
    .toSorted((left, right) => right.tokens - left.tokens),
};
// Native stdout/stderr or SDK logging boundary preserves the existing output format.
Effect.runSync(Console.log(JSON.stringify(report, null, 2)));
