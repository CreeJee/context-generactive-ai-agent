import { NodeServices } from "@effect/platform-node";
import {
  Array as Arr,
  Cause,
  Console,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Record as EffectRecord,
  Ref,
  Schedule,
  Stream,
} from "effect";
import { LanguageModel, Prompt, type Response, type Tool } from "effect/ai";
import { GlobalConfig } from "../src/config/global-config.ts";
import { SecretStore } from "../src/config/secrets.ts";
import { defaultStorageRoot } from "../src/config/storage-root.ts";
import { Kagi } from "../src/kagi/kagi.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { globalMcpFile } from "../src/mcp/config.ts";
import { McpServers } from "../src/mcp/servers.ts";
import { optionsKey } from "../src/model/prompt.ts";
import { collectResponse } from "../src/model/response.ts";
import { shownReason } from "../src/model/shown-failure.ts";
import { subscriptionBody } from "../src/model/subscription.ts";
import { Projects, type Project } from "../src/projects/projects.ts";
import { AuthConnectionState, type ModelSelection } from "../src/providers/contracts.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { homeDirectory } from "../src/runtime/host-system.ts";
import { runNativeEffect } from "../src/runtime/native-effect.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path } from "../src/runtime/synchronous-path.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../src/testing/fake-morph.ts";
import { inProcessChatApi } from "../src/testing/chat-api.ts";
import { estimateRequestTokens } from "./request-token-budget.ts";
const { join, resolve } = path;

// Local, provider-free: one first turn that delegates once, the parent's first request and the
// child's split into system prompts, tools and messages, each counted in o200k_base BPE tokens.
// Without an argument the project is a throwaway one with only the built-in skills. With a project
// path it is that project as configured, its AGENTS.md, skills and MCP servers, plus the user's
// global skills and MCP servers, every server trusted and Kagi on: the worst case a user can reach.

const selection: ModelSelection = {
  provider: "openai",
  model: "gpt-6.1-sol",
  reasoningEffort: "low",
};

const configuredRoot = Option.map(Option.fromNullishOr(process.argv[2]), (root) => resolve(root));

/** Every step answers "ok" at once, except the parent's first, which delegates. */
const answer: ReadonlyArray<Response.StreamPartEncoded> = [
  { type: "response-metadata", modelId: selection.model },
  { type: "text-start", id: "text-0" },
  { type: "text-delta", id: "text-0", delta: "ok" },
  { type: "text-end", id: "text-0" },
  { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } },
];

const delegationId = "call-subagent";
const delegationArguments = '{"task":"Answer ok."}';
const delegation: ReadonlyArray<Response.StreamPartEncoded> = [
  { type: "response-metadata", modelId: selection.model },
  { type: "tool-params-start", id: delegationId, name: "run_subagent" },
  { type: "tool-params-delta", id: delegationId, delta: delegationArguments },
  { type: "tool-params-end", id: delegationId },
  {
    type: "tool-call",
    id: delegationId,
    name: "run_subagent",
    params: { task: "Answer ok." },
    metadata: { [optionsKey]: { arguments: delegationArguments } },
  },
  { type: "finish", reason: "tool-calls", usage: { inputTokens: {}, outputTokens: {} } },
];

/** A subagent's request: its system prompt tells it it is one. */
const isChild = (request: LanguageModel.ProviderOptions) =>
  request.prompt.content.some(
    (message) => message.role === "system" && message.content.includes("You are a subagent"),
  );

/** The parent's first step: it can delegate and no call has been answered yet. */
const delegates = (request: LanguageModel.ProviderOptions) =>
  request.tools.some((tool) => tool.name === "run_subagent") &&
  !request.prompt.content.some((message) => message.role === "tool");

/** A model that keeps each request the loop sends it, as the provider would receive it. */
const capturingModel = (requests: Ref.Ref<ReadonlyArray<LanguageModel.ProviderOptions>>) => {
  const streamText = (request: LanguageModel.ProviderOptions) =>
    Stream.unwrap(
      Effect.as(
        Ref.update(requests, Arr.append(request)),
        Stream.fromIterable(delegates(request) ? delegation : answer),
      ),
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

/** Kagi on with a placeholder key, and every configured MCP server trusted. */
const enableEverything = Effect.fnUntraced(function* (project: Project) {
  const kagi = yield* Kagi;
  yield* kagi.registerKey("prompt-overhead-placeholder");
  yield* kagi.setEnabled(true);
  const mcp = yield* McpServers;
  const { servers } = yield* mcp.overview(project);
  yield* Effect.forEach(
    servers.filter((server) => !server.shadowed),
    (server) => mcp.setTrusted(project, server.scope, server.name, true),
    { discard: true },
  );
});

const firstRequests = Effect.fn("eval.promptOverhead")(function* () {
  const platform = yield* Layer.build(NodeServices.layer);
  const fs = Context.get(platform, FileSystem.FileSystem);
  const crypto = Context.get(platform, Crypto.Crypto);
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-prompt-overhead-" });
  const storage = join(base, "storage");
  const home = join(base, "home");
  yield* fs.makeDirectory(home);
  const projectRoot = yield* Option.match(configuredRoot, {
    onNone: () => Effect.as(fs.makeDirectory(join(base, "project")), join(base, "project")),
    onSome: Effect.succeed,
  });
  // The user's global MCP servers, read from their storage root; nothing is written there.
  const userMcp = globalMcpFile(yield* defaultStorageRoot);
  yield* Effect.when(
    Effect.andThen(
      fs.makeDirectory(storage, { recursive: true }),
      fs.copyFile(userMcp, globalMcpFile(storage)),
    ),
    Effect.map(fs.exists(userMcp), (exists) => exists && Option.isSome(configuredRoot)),
  );
  const requests = yield* Ref.make<ReadonlyArray<LanguageModel.ProviderOptions>>([]);
  // The built-in skills stay: every user has them. The user's own skills and imports stay out
  // unless a project is measured as configured.
  const services = yield* Layer.build(
    memoryAgentLayer(storage, {
      providerRegistry: registry(yield* capturingModel(requests)),
      embedder: fakeEmbedderLayer,
      morphAnalyzer: fakeMorphLayer,
      interpretAutomatically: false,
      summarizeAutomatically: false,
      importsHome: home,
      importsWatching: false,
      sweepSecrets: false,
      secrets: SecretStore.memory,
      skillsHome: Option.isSome(configuredRoot) ? yield* homeDirectory : home,
    }),
  );
  return yield* Effect.provideContext(
    Effect.gen(function* () {
      yield* (yield* GlobalConfig).update(selection);
      const project = yield* (yield* Projects).add(projectRoot);
      yield* Effect.when(enableEverything(project), Effect.succeed(Option.isSome(configuredRoot)));
      const session = yield* (yield* Sessions).create(project.id);
      const chat = yield* inProcessChatApi;
      yield* Stream.runDrain(
        yield* chat.run({
          params: { session: session.id },
          headers: {},
          payload: {
            runId: yield* crypto.randomUUIDv4(),
            messages: [{ id: yield* crypto.randomUUIDv4(), role: "user", content: "hi" }],
          },
        }),
      );
      // The child runs in the background and may ask after the parent's run is over.
      yield* Ref.get(requests).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("200 millis"),
          while: (sent) => !sent.some(isChild),
        }),
        Effect.timeout("60 seconds"),
      );
      const recorded = yield* Ref.get(requests);
      const { servers } = yield* (yield* McpServers).overview(project);
      return {
        main: yield* requestOf(
          Arr.findFirst(recorded, (request) => !isChild(request)),
          "main",
        ),
        child: yield* requestOf(Arr.findFirst(recorded, isChild), "child"),
        servers: servers.map((server) => ({
          scope: server.scope,
          name: server.name,
          state: server.state._tag,
        })),
      };
    }),
    services,
  );
}, Effect.scoped);

const requestOf = (found: Option.Option<LanguageModel.ProviderOptions>, role: "main" | "child") =>
  Effect.fromOption(found).pipe(
    Effect.mapError(() => new Cause.NoSuchElementError(`no_${role}_request`)),
  );

/** The MCP server a tool comes from, or `builtin`. */
const sourceOf = (name: string) =>
  Option.match(Option.fromNullishOr(/^mcp_(.+?)__/.exec(name)?.[1]), {
    onNone: () => "builtin",
    onSome: (server) => `mcp:${server}`,
  });

const reportOf = (request: LanguageModel.ProviderOptions) => {
  const systemMessages = request.prompt.content.filter((message) => message.role === "system");
  const otherMessages = request.prompt.content.filter((message) => message.role !== "system");
  const base = tokens(Prompt.empty);
  return {
    total: tokens(request.prompt, request.tools),
    system: tokens(Prompt.fromMessages(systemMessages)) - base,
    tools: tokens(Prompt.empty, request.tools) - base,
    messages: tokens(Prompt.fromMessages(otherMessages)) - base,
    toolCount: request.tools.length,
    toolSources: EffectRecord.map(
      Arr.groupBy(request.tools, (tool) => sourceOf(tool.name)),
      (tools) => ({ count: tools.length, tokens: tokens(Prompt.empty, tools) - base }),
    ),
    systemBlocks: systemMessages.map((message) => ({
      tokens: tokens(Prompt.fromMessages([message])) - base,
      head: message.content.slice(0, 70).replaceAll("\n", " "),
    })),
    perTool: request.tools
      .map((tool) => ({ name: tool.name, tokens: tokens(Prompt.empty, [tool]) - base }))
      .toSorted((left, right) => right.tokens - left.tokens),
  };
};
// Native stdout/stderr or SDK logging boundary preserves the existing output format.
await runNativeEffect(
  Effect.flatMap(firstRequests(), ({ main, child, servers }) =>
    Console.log(
      JSON.stringify(
        {
          model: selection.model,
          project: Option.getOrElse(configuredRoot, () => "throwaway"),
          servers,
          main: reportOf(main),
          child: reportOf(child),
        },
        null,
        2,
      ),
    ),
  ),
);
