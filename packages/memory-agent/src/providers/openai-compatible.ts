import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { Context, Data, Effect, Layer, Schema, Semaphore } from "effect";
import { GlobalConfig, type GlobalConfigApi } from "../config/global-config.ts";
import { requireRuntime } from "../runtime/resources.ts";
import { ModelUnavailable, type ProviderServices, type ProviderModel } from "./contracts.ts";
import {
  OpenAICompatibleUpdate,
  type OpenAICompatibleConfiguration,
  type OpenAICompatibleStatus,
} from "./openai-compatible-config.ts";
import { subscriptionAgentLoop } from "./subscription-runtime.ts";
import { CompatibleModelPage, discoverCompatibleReasoning } from "./compatible-model-discovery.ts";

export class OpenAICompatibleFailed extends Data.TaggedError("OpenAICompatibleFailed")<{
  readonly operation: "validation" | "keychain" | "partial" | "test" | "models";
}> {}
export interface CompatibleKeyStore {
  get(): Promise<string | null>;
  set(value: string | null): Promise<void>;
}
const keyEntry = () =>
  new (requireRuntime("@napi-rs/keyring").AsyncEntry)(
    "context-generactive-agent",
    "openai-compatible-api-key",
  );
const keychain: CompatibleKeyStore = {
  get: async () => (await keyEntry().getPassword()) ?? null,
  set: async (value) => {
    if (value === null) await keyEntry().deletePassword();
    else await keyEntry().setPassword(value);
  },
};
export class CompatibleKeyring extends Context.Service<CompatibleKeyring, CompatibleKeyStore>()(
  "memory-agent/CompatibleKeyring",
) {
  static readonly layer = Layer.succeed(CompatibleKeyring, keychain);
}
export class CompatibleFetch extends Context.Service<CompatibleFetch, typeof fetch>()(
  "memory-agent/CompatibleFetch",
) {
  static readonly layer = Layer.succeed(CompatibleFetch, fetch);
}
/** Node/undici transport codes (`ECONNRESET`, `ETIMEDOUT`, ...) surfaced from fetch failures. */
const TransportErrorCode = Schema.String.check(Schema.isPattern(/^[A-Z0-9_]+$/));
const isTransportErrorCode = Schema.is(TransportErrorCode);
const provider = "openai-compatible" as const;
const credentialPrefix = "context-generactive-agent/openai-compatible/v1:";
const StoredCredential = Schema.Struct({ baseUrl: Schema.String, key: Schema.String });
const credentialFor = (stored: string | null, baseUrl: string): string | null => {
  if (!stored) return null;
  // Legacy credentials predate endpoint binding. An endpoint change without an explicit
  // replacement or clear is rejected below; newly written credentials are always bound.
  if (!stored.startsWith(credentialPrefix)) return stored;
  try {
    const value = Schema.decodeUnknownSync(StoredCredential)(
      JSON.parse(stored.slice(credentialPrefix.length)),
    );
    return value.baseUrl === baseUrl ? value.key : null;
  } catch {
    return null;
  }
};
export function validateCompatibleConfiguration(
  input: OpenAICompatibleUpdate,
): OpenAICompatibleUpdate {
  const value = Schema.decodeUnknownSync(OpenAICompatibleUpdate)(input);
  const url = new URL(value.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.contextWindow < 1024 ||
    value.contextWindow > 10_000_000 ||
    value.outputBudget < 1 ||
    value.outputBudget >= value.contextWindow ||
    !value.model.trim()
  )
    throw new OpenAICompatibleFailed({ operation: "validation" });
  return { ...value, baseUrl: url.href.replace(/\/+$/, ""), model: value.model.trim() };
}
export function makeOpenAICompatibleSettings(
  config: GlobalConfigApi,
  keys: CompatibleKeyStore = keychain,
  fetcher: typeof fetch = fetch,
) {
  const updates = Semaphore.makeUnsafe(1);
  // Keyring calls cannot be cancelled once started. Never retry an uncertain write automatically.
  const attempt = <A>(operation: OpenAICompatibleFailed["operation"], run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: () => new OpenAICompatibleFailed({ operation }) });
  const read = Effect.map(config.read, (settings) => settings.openaiCompatible ?? null);
  // Read settings and key under the same permit as updates. Never pair a key written
  // during an update with the previous endpoint, including in test and model discovery.
  const snapshot = Effect.gen(function* () {
    const configuration = yield* read;
    const stored = yield* attempt("keychain", () => keys.get());
    return {
      configuration,
      key: configuration ? credentialFor(stored, configuration.baseUrl) : null,
      hasStoredKey: stored !== null,
    };
  });
  const statusOf = Effect.map(
    snapshot,
    ({ configuration, hasStoredKey }) =>
      ({
        configuration,
        configured: configuration !== null,
        hasApiKey: hasStoredKey,
      }) satisfies OpenAICompatibleStatus,
  );
  const status = updates.withPermit(statusOf);
  const update = (input: OpenAICompatibleUpdate) =>
    updates.withPermit(
      Effect.gen(function* () {
        const decoded = yield* Effect.try({
          try: () => validateCompatibleConfiguration(input),
          catch: () => new OpenAICompatibleFailed({ operation: "validation" }),
        });
        const { apiKey, ...configuration } = decoded;
        const prior = yield* config.read;
        const sameModel =
          prior.openaiCompatible?.baseUrl === configuration.baseUrl &&
          prior.openaiCompatible.model === configuration.model;
        const existing = yield* attempt("keychain", () => keys.get());
        // Never carry an old endpoint's credential to a different server implicitly.
        if (
          prior.openaiCompatible?.baseUrl !== configuration.baseUrl &&
          apiKey === undefined &&
          existing !== null
        )
          return yield* new OpenAICompatibleFailed({ operation: "validation" });
        // The keyring and config file are separate stores. Finish an initiated write before
        // interruption, and report a partial result if either store may have changed.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (apiKey !== undefined)
              yield* attempt("partial", () =>
                keys.set(
                  apiKey === null || apiKey === ""
                    ? null
                    : credentialPrefix +
                        JSON.stringify({ baseUrl: configuration.baseUrl, key: apiKey }),
                ),
              );
            let patch: Parameters<GlobalConfigApi["update"]>[0] = {
              openaiCompatible: {
                ...configuration,
                reasoning: sameModel ? prior.openaiCompatible?.reasoning : undefined,
              },
            };
            if (prior.provider === provider && prior.model)
              patch = { ...patch, model: configuration.model };
            if (prior.provider === provider && !sameModel)
              patch = { ...patch, reasoningEffort: "default" };
            yield* config
              .update(patch)
              .pipe(
                Effect.catchCause(() =>
                  Effect.fail(new OpenAICompatibleFailed({ operation: "partial" })),
                ),
              );
          }),
        );
        return yield* statusOf;
      }),
    );
  const requestOperation = Effect.fnUntraced(function* (operation: "test" | "models") {
    const { configuration: settings, key } = yield* updates.withPermit(snapshot);
    if (!settings) return yield* new OpenAICompatibleFailed({ operation });
    const headers = new Headers({ "Content-Type": "application/json" });
    if (key) headers.set("Authorization", `Bearer ${key}`);
    const init: RequestInit = {
      method: operation === "models" ? "GET" : "POST",
      redirect: "error",
      headers,
    };
    if (operation === "test")
      init.body = JSON.stringify({
        model: settings.model,
        messages: [{ role: "user", content: "Reply OK" }],
        max_tokens: Math.min(16, settings.outputBudget),
        stream: false,
      });
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetcher(
          `${settings.baseUrl}/${operation === "models" ? "models" : "chat/completions"}`,
          { ...init, signal },
        );
        if (!response.ok) throw new Error("request_failed");
        const page: unknown = await response.json();
        return { page, configuration: settings };
      },
      catch: () => new OpenAICompatibleFailed({ operation }),
    });
  });
  const request = (operation: "test" | "models") =>
    requestOperation(operation).pipe(
      Effect.timeout(15_000),
      Effect.mapError(() => new OpenAICompatibleFailed({ operation })),
    );
  const listModels = Effect.flatMap(
    request("models"),
    ({ page: rawPage, configuration: requested }) =>
      Effect.flatMap(
        Effect.try({
          try: () => Schema.decodeUnknownSync(CompatibleModelPage)(rawPage),
          catch: () => new OpenAICompatibleFailed({ operation: "models" }),
        }),
        (page) =>
          updates.withPermit(
            Effect.gen(function* () {
              const ids = page.data.map((entry) => entry.id);
              const { configuration, key } = yield* snapshot;
              if (!configuration) return ids;
              if (
                configuration.baseUrl !== requested.baseUrl ||
                configuration.model !== requested.model
              )
                return yield* new OpenAICompatibleFailed({ operation: "models" });
              const discovery = yield* discoverCompatibleReasoning(
                configuration.baseUrl,
                configuration.model,
                page,
                key,
                fetcher,
              );
              switch (discovery._tag) {
                case "Unavailable":
                  return ids;
                case "Available": {
                  const { reasoning } = discovery;
                  if (JSON.stringify(reasoning) !== JSON.stringify(configuration.reasoning)) {
                    const stored = yield* config.read;
                    // Before capability discovery, none meant to omit the wire parameter.
                    const legacyDefault =
                      configuration.reasoning === undefined &&
                      stored.provider === provider &&
                      stored.reasoningEffort === "none";
                    let patch: Parameters<GlobalConfigApi["update"]>[0] = {
                      openaiCompatible: { ...configuration, reasoning },
                    };
                    if (legacyDefault) patch = { ...patch, reasoningEffort: "default" };
                    yield* config.update(patch);
                  }
                  return ids;
                }
              }
            }),
          ),
      ),
  );
  const test = Effect.flatMap(request("test"), ({ page }) =>
    Effect.try({
      try: () => {
        const completion = Schema.decodeUnknownSync(
          Schema.Struct({
            choices: Schema.Array(
              Schema.Struct({ message: Schema.Struct({ content: Schema.NullOr(Schema.String) }) }),
            ),
          }),
        )(page);
        if (completion.choices.length === 0) throw new Error("Empty completion");
        return { ok: true as const };
      },
      catch: () => new OpenAICompatibleFailed({ operation: "test" }),
    }),
  );
  const model = (settings: OpenAICompatibleConfiguration): ProviderModel => ({
    provider,
    id: settings.model,
    displayName: settings.model,
    isDefault: true,
    defaultReasoningEffort: "default",
    supportedReasoningEfforts: [
      "default",
      ...(settings.reasoning?.model === settings.model ? settings.reasoning.options : []),
    ],
    contextWindow: settings.contextWindow,
    capabilities: {
      inputModalities: ["text"],
      toolCalling: settings.toolCalling,
      reasoning: settings.reasoning?.model === settings.model,
    },
  });
  const services: ProviderServices = {
    provider,
    auth: {
      provider,
      status: Effect.map(read, (settings) => ({
        provider,
        status: settings ? ("signed-in" as const) : ("signed-out" as const),
      })),
      connect: Effect.succeed({ provider, status: "signed-out" }),
      cancel: Effect.succeed({ provider, status: "signed-out" }),
      disconnect: Effect.succeed({ provider, status: "signed-out" }),
    },
    models: {
      provider,
      list: Effect.gen(function* () {
        yield* listModels.pipe(Effect.option);
        const settings = yield* read;
        return settings ? [model(settings)] : [];
      }),
      selected: Effect.map(config.read, (settings) =>
        settings.provider === provider && settings.model
          ? {
              provider,
              model: settings.model,
              reasoningEffort:
                settings.openaiCompatible &&
                model(settings.openaiCompatible).supportedReasoningEfforts.includes(
                  settings.reasoningEffort ?? "default",
                )
                  ? (settings.reasoningEffort ?? "default")
                  : "default",
            }
          : null,
      ),
      acceptsImages: () => Effect.succeed(false),
      cheapestEffort: (selection) => Effect.succeed({ ...selection, reasoningEffort: "default" }),
      select: (id: string, effort = "default") =>
        updates.withPermit(
          Effect.gen(function* () {
            const settings = yield* read;
            if (
              !settings ||
              id !== settings.model ||
              !model(settings).supportedReasoningEfforts.includes(effort)
            )
              return yield* new ModelUnavailable({ provider, model: id, reasoningEffort: effort });
            const selection = { provider, model: id, reasoningEffort: effort };
            yield* config.update(selection);
            return selection;
          }),
        ),
    },
    runtime: {
      provider,
      adapter: (selection) => {
        const settings = Effect.runSync(read);
        if (
          !settings ||
          selection.model !== settings.model ||
          selection.provider !== provider ||
          !model(settings).supportedReasoningEfforts.includes(selection.reasoningEffort)
        )
          throw new Error("Compatible model unavailable");
        // One adapter is one run. Release from the central stream's finally aborts any
        // outstanding SDK request; no separate long-lived compatible client is retained.
        const runAbort = new AbortController();
        const pinnedKey = Effect.runPromise(updates.withPermit(snapshot), {
          signal: runAbort.signal,
        }).then(
          ({ configuration, key }) => ({
            value: key,
            failed:
              !configuration ||
              configuration.baseUrl !== settings.baseUrl ||
              configuration.model !== settings.model ||
              configuration.contextWindow !== settings.contextWindow ||
              configuration.outputBudget !== settings.outputBudget ||
              configuration.toolCalling !== settings.toolCalling ||
              JSON.stringify(configuration.reasoning) !== JSON.stringify(settings.reasoning),
          }),
          () => ({ value: null, failed: true }),
        );
        const adapter = openaiCompatibleText(selection.model, {
          baseURL: settings.baseUrl,
          apiKey: "unused",
          api: "chat-completions",
          maxRetries: 0,
          fetch: async (url, init) => {
            const credential = await pinnedKey;
            if (runAbort.signal.aborted) throw new Error("Compatible run cancelled");
            if (credential.failed) throw new Error("Compatible keychain unavailable");
            const key = credential.value;
            const headers = new Headers(init?.headers);
            headers.delete("authorization");
            if (key) headers.set("authorization", `Bearer ${key}`);
            const rawBody = Schema.decodeUnknownSync(Schema.String)(init?.body ?? "{}");
            const payload = {
              ...Schema.decodeUnknownSync(
                Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
              )(rawBody),
            };
            payload.max_tokens = settings.outputBudget;
            if (selection.reasoningEffort === "default") delete payload.reasoning_effort;
            else payload.reasoning_effort = selection.reasoningEffort;
            if (!settings.toolCalling) {
              delete payload.tools;
              delete payload.tool_choice;
            }
            const body = JSON.stringify(payload);
            // Conservative local guard also covers auxiliary structured-output calls and tool schemas.
            let estimatedInput = 0;
            for (const character of body)
              estimatedInput += character.charCodeAt(0) < 128 ? 0.25 : 1;
            if (Math.ceil(estimatedInput) + settings.outputBudget > settings.contextWindow)
              throw new Error("Compatible context limit exceeded");
            try {
              return await fetcher(url, {
                ...init,
                body,
                headers,
                redirect: "error",
                signal: init?.signal
                  ? AbortSignal.any([init.signal, runAbort.signal])
                  : runAbort.signal,
              });
            } catch (cause) {
              // Do not log URLs, headers or payloads. Surface transport codes even
              // when the provider SDK reduces this exception to "Connection error".
              const codes: string[] = [];
              let current: unknown = cause;
              const seen = new Set<unknown>();
              while (current instanceof Error && !seen.has(current) && seen.size < 8) {
                seen.add(current);
                if ("code" in current && isTransportErrorCode(current.code))
                  codes.push(current.code);
                current = current.cause;
              }
              const diagnostic = codes.length ? codes.join(" <- ") : "transport failure";
              const error = new Error(`Compatible API request failed: ${diagnostic}`, { cause });
              console.error(error.message);
              throw error;
            }
          },
        });
        const original = adapter.chatStream.bind(adapter);
        adapter.chatStream = async function* (options) {
          const request = {
            ...options,
            modelOptions: { ...options.modelOptions, max_tokens: settings.outputBudget },
          };
          if (!settings.toolCalling) request.tools = [];
          for await (const chunk of original(request)) {
            if (!settings.toolCalling && String(chunk.type).startsWith("TOOL_CALL"))
              throw new Error("Compatible tool calling is disabled");
            yield chunk;
          }
        };
        return Object.assign(adapter, { releaseRun: () => runAbort.abort() });
      },
      contextWindow: () => {
        const settings = Effect.runSync(read);
        return settings ? settings.contextWindow - settings.outputBudget : 0;
      },
      contextWindowKnown: () => true,
      agentLoop: subscriptionAgentLoop,
      runMiddleware: () => ({ name: "memory-agent/openai-compatible" }),
      steer: async () => "no_turn",
    },
  };
  return { status, update, test, listModels, services };
}
export type OpenAICompatibleSettingsApi = ReturnType<typeof makeOpenAICompatibleSettings>;
export class OpenAICompatibleSettings extends Context.Service<
  OpenAICompatibleSettings,
  OpenAICompatibleSettingsApi
>()("memory-agent/OpenAICompatibleSettings") {
  static readonly layer = Layer.effect(
    OpenAICompatibleSettings,
    Effect.gen(function* () {
      const config = yield* GlobalConfig;
      const keys = yield* CompatibleKeyring;
      const fetcher = yield* CompatibleFetch;
      return makeOpenAICompatibleSettings(config, keys, fetcher);
    }),
  ).pipe(Layer.provide(Layer.merge(CompatibleKeyring.layer, CompatibleFetch.layer)));
}
