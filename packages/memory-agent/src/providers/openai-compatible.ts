import { nativeFailure, nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { nativeStream } from "../runtime/native-stream.ts";
import { ProviderOperationFailed } from "./contracts.ts";
import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { oauthProtocolCrypto } from "../oauth/node-runtime.ts";
import {
  Cause,
  Config,
  Context,
  Data,
  Effect,
  Equal,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import {
  GlobalConfig,
  type GlobalConfigApi,
  type GlobalConfigFailed,
  type Settings,
} from "../config/global-config.ts";
import { requireRuntime } from "../runtime/resources.ts";
import {
  ModelUnavailable,
  type AgentModelRuntime,
  type ProviderConfiguration,
  type ProviderModel,
} from "./contracts.ts";
import {
  compatibleAccountsOf,
  compatibleEndpointModel,
  compatibleHostLabel,
  CompatibleConnectionInput,
  CompatibleModelInput,
  LEGACY_COMPATIBLE_CREDENTIAL_ENTRY,
  selectedCompatibleAccount,
  type CompatibleAccount,
  type CompatibleAccounts,
  type CompatibleAccountStatus,
  type CompatibleModel,
  type OpenAICompatibleConfiguration,
  type OpenAICompatibleStatus,
} from "./openai-compatible-config.ts";
import { subscriptionAgentLoop } from "./subscription-runtime.ts";
import { CompatibleModelPage, readCompatibleReasoning } from "./compatible-model-discovery.ts";

// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const stringifyJson = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

export class OpenAICompatibleFailed extends Data.TaggedError("OpenAICompatibleFailed")<{
  readonly operation: "validation" | "missing" | "keychain" | "partial" | "test" | "models";
}> {}
export class CompatibleCompletionRejected extends Data.TaggedError("CompatibleCompletionRejected")<{
  readonly status: number;
  readonly reason: "memory_capacity_exceeded" | "request_rejected";
}> {}
const decodeMemoryCapacity = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        estimated_bytes: Schema.Finite.check(Schema.isGreaterThan(0)),
        limit_bytes: Schema.Finite.check(Schema.isGreaterThan(0)),
      }),
    }),
  ),
);
export interface CompatibleKeyStore {
  get(): Promise<string | null>;
  set(value: string | null): Promise<void>;
}
/** One keychain entry per compatible account, named by the account's `credentialEntry`. */
export type CompatibleKeychain = (entry: string) => CompatibleKeyStore;
const keyEntry = (entry: string) =>
  new (requireRuntime("@napi-rs/keyring").AsyncEntry)(
    // Native host/SDK configuration boundary reads or forwards the host environment.
    Effect.runSync(
      Config.String("CONTEXT_AGENT_CREDENTIAL_NAMESPACE").pipe(
        Config.withDefault("context-generactive-agent"),
      ),
    ),
    entry,
  );
const keychain: CompatibleKeychain = (entry) => ({
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  get: () =>
    keyEntry(entry)
      .getPassword()
      .then((password) => password ?? null),
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  set: (value) =>
    value === null
      ? keyEntry(entry)
          .deletePassword()
          .then(() => undefined)
      : keyEntry(entry)
          .setPassword(value)
          .then(() => undefined),
});
export class CompatibleKeyring extends Context.Service<CompatibleKeyring, CompatibleKeychain>()(
  "memory-agent/providers/openai-compatible/CompatibleKeyring",
) {
  static readonly layer = Layer.succeed(CompatibleKeyring, keychain);
}
export class CompatibleFetch extends Context.Service<CompatibleFetch, typeof fetch>()(
  "memory-agent/providers/openai-compatible/CompatibleFetch",
) {
  static readonly layer = Layer.succeed(CompatibleFetch, fetch);
}
/** Node/undici transport codes (`ECONNRESET`, `ETIMEDOUT`, ...) surfaced from fetch failures. */
const TransportErrorCode = Schema.String.check(Schema.isPattern(/^[A-Z0-9_]+$/));
const isTransportErrorCode = Schema.is(TransportErrorCode);
const provider = "openai-compatible" as const;
const requestRoles = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.optional(Schema.Unknown) })),
);
const credentialPrefix = "context-generactive-agent/openai-compatible/v1:";
const StoredCredential = Schema.Struct({ baseUrl: Schema.String, key: Schema.String });
const credentialFor = (stored: string | null, baseUrl: string): string | null => {
  if (!isTruthy(stored)) return null;
  // Legacy credentials predate endpoint binding. An endpoint change without an explicit
  // replacement or clear is rejected below; newly written credentials are always bound.
  if (!stored.startsWith(credentialPrefix)) return stored;
  try {
    // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
    const value = EffectFunction.flow(
      Schema.decodeUnknownResult(StoredCredential),
      Result.getOrThrow,
    )(JSON.parse(stored.slice(credentialPrefix.length)));
    return value.baseUrl === baseUrl ? value.key : null;
  } catch {
    return null;
  }
};
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeConnection = EffectFunction.flow(
  Schema.decodeResult(CompatibleConnectionInput),
  Result.getOrThrow,
);
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeModel = EffectFunction.flow(
  Schema.decodeResult(CompatibleModelInput),
  Result.getOrThrow,
);
export function validateCompatibleConnection(
  input: CompatibleConnectionInput,
): CompatibleConnectionInput {
  const value = decodeConnection(input);
  const url = new URL(value.baseUrl.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  )
    throw new OpenAICompatibleFailed({ operation: "validation" });
  return { ...value, baseUrl: url.href.replace(/\/+$/, "") };
}
export function validateCompatibleModel(input: CompatibleModelInput): CompatibleModelInput {
  const value = decodeModel(input);
  if (
    value.contextWindow < 1024 ||
    value.contextWindow > 10_000_000 ||
    value.outputBudget < 1 ||
    value.outputBudget >= value.contextWindow ||
    !isTruthy(value.id.trim())
  )
    throw new OpenAICompatibleFailed({ operation: "validation" });
  return { ...value, id: value.id.trim() };
}
export function validateCompatibleLabel(label: string): string {
  const value = label.trim();
  if (value === "" || value.length > 80)
    throw new OpenAICompatibleFailed({ operation: "validation" });
  return value;
}
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
export function makeOpenAICompatibleSettings(options: {
  readonly config: GlobalConfigApi;
  readonly keys?: CompatibleKeychain | undefined;
  readonly fetcher?: typeof fetch | undefined;
}) {
  return makeOpenAICompatibleSettingsBody(options.config, options.keys, options.fetcher);
}
const replaceAccount = (
  all: CompatibleAccounts,
  account: CompatibleAccount,
): CompatibleAccounts => ({
  ...all,
  accounts: all.accounts.map((item) => (item.id === account.id ? account : item)),
});
const publishedReasoning = (settings: OpenAICompatibleConfiguration) =>
  settings.reasoning?.source === "models" && settings.reasoning.model === settings.model
    ? settings.reasoning.options
    : null;
function makeOpenAICompatibleSettingsBody(
  config: GlobalConfigApi,
  keys: CompatibleKeychain = keychain,
  fetcher: typeof fetch = fetch,
) {
  const updates = Semaphore.makeUnsafe(1);
  // Keyring calls cannot be cancelled once started. Never retry an uncertain write automatically.
  const attempt = <A>(operation: OpenAICompatibleFailed["operation"], run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: () => new OpenAICompatibleFailed({ operation }) });
  const validated = <A>(run: () => A) =>
    Effect.try({ try: run, catch: () => new OpenAICompatibleFailed({ operation: "validation" }) });
  const accountsOf = Effect.map(config.read, compatibleAccountsOf);
  /** The selected endpoint, which compatible runs, catalogs and model selection use. */
  const read = Effect.map(accountsOf, selectedCompatibleAccount);
  const findAccount = (all: CompatibleAccounts, id: string) =>
    Effect.fromNullishOr(all.accounts.find((account) => account.id === id)).pipe(
      Effect.mapError(() => new OpenAICompatibleFailed({ operation: "missing" })),
    );
  const storedKey = (account: CompatibleAccount) =>
    attempt("keychain", () => keys(account.credentialEntry).get());
  /** Writing accounts replaces the pre-account single endpoint for good. */
  const writeAccounts = (accounts: CompatibleAccounts, patch: Partial<Settings> = {}) =>
    config.update({ ...patch, compatibleAccounts: accounts, openaiCompatible: undefined });
  /**
   * The keyring and config file are separate stores. Finish an initiated write before
   * interruption, and report a partial result if either store may have changed.
   */
  const writeBoth = (
    keyWrite: Effect.Effect<void, OpenAICompatibleFailed> | null,
    configWrite: Effect.Effect<unknown, GlobalConfigFailed>,
  ) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (keyWrite !== null) yield* keyWrite;
        yield* configWrite.pipe(
          Effect.mapError(() => new OpenAICompatibleFailed({ operation: "partial" })),
        );
      }),
    );
  const setKey = (account: CompatibleAccount, value: string | null) =>
    attempt("partial", () => keys(account.credentialEntry).set(value));
  const boundKey = (baseUrl: string, apiKey: string | null) =>
    apiKey === null || apiKey === ""
      ? null
      : credentialPrefix + JSON.stringify({ baseUrl, key: apiKey });
  /**
   * The model choice that goes with a newly selected endpoint: the same model when that endpoint
   * registered it too, else its first model. Only an active compatible choice moves.
   */
  const followSelection = (prior: Settings, account: CompatibleAccount | undefined) => {
    if (prior.provider !== provider || !isTruthy(prior.model) || account === undefined) return {};
    if (account.models.some((model) => model.id === prior.model)) return {};
    const first = account.models[0];
    return first === undefined ? {} : { model: first.id, reasoningEffort: "default" };
  };
  // Read settings and key under the same permit as updates. Never pair a key written
  // during an update with the previous endpoint, including in test and model discovery.
  const accountSnapshot = (id: string) =>
    Effect.gen(function* () {
      const account = yield* findAccount(yield* accountsOf, id);
      const stored = yield* storedKey(account);
      return { account, key: credentialFor(stored, account.baseUrl) };
    });
  const statusOf = Effect.flatMap(accountsOf, (all) =>
    Effect.map(
      Effect.forEach(
        all.accounts,
        (account) =>
          Effect.map(
            storedKey(account),
            (stored) =>
              ({
                id: account.id,
                label: account.label,
                baseUrl: account.baseUrl,
                models: account.models,
                hasApiKey: stored !== null,
                selected: account.id === all.selected,
              }) satisfies CompatibleAccountStatus,
          ),
        { concurrency: 4 },
      ),
      (accounts) => ({ accounts }) satisfies OpenAICompatibleStatus,
    ),
  );
  const status = updates.withPermit(statusOf);
  /** Runs one account change under the update permit and answers with every account. */
  const change = <E>(
    id: string,
    run: (context: {
      readonly prior: Settings;
      readonly all: CompatibleAccounts;
      readonly account: CompatibleAccount;
    }) => Effect.Effect<void, E>,
  ) =>
    updates.withPermit(
      Effect.gen(function* () {
        const prior = yield* config.read;
        const all = compatibleAccountsOf(prior);
        yield* run({ prior, all, account: yield* findAccount(all, id) });
        return yield* statusOf;
      }),
    );

  const create = (input: { readonly label?: string | undefined } & CompatibleConnectionInput) =>
    updates.withPermit(
      Effect.gen(function* () {
        const { baseUrl, apiKey } = yield* validated(() => validateCompatibleConnection(input));
        const label = isTruthy(input.label)
          ? yield* validated(() => validateCompatibleLabel(input.label ?? ""))
          : compatibleHostLabel(baseUrl);
        const id = yield* oauthProtocolCrypto.randomUUIDv4().pipe(Effect.orDie);
        const account: CompatibleAccount = {
          id,
          label,
          baseUrl,
          credentialEntry: `${LEGACY_COMPATIBLE_CREDENTIAL_ENTRY}:${id}`,
          models: [],
        };
        const all = compatibleAccountsOf(yield* config.read);
        const key = boundKey(baseUrl, apiKey ?? null);
        yield* writeBoth(
          key === null ? null : setKey(account, key),
          writeAccounts({
            selected: selectedCompatibleAccount(all)?.id ?? id,
            accounts: [...all.accounts, account],
          }),
        );
        return yield* statusOf;
      }),
    );
  const rename = (id: string, label: string) =>
    change(id, ({ all, account }) =>
      Effect.gen(function* () {
        const value = yield* validated(() => validateCompatibleLabel(label));
        yield* writeAccounts(replaceAccount(all, { ...account, label: value }));
      }),
    );
  const connect = (id: string, input: CompatibleConnectionInput) =>
    change(id, ({ all, account }) =>
      Effect.gen(function* () {
        const { baseUrl, apiKey } = yield* validated(() => validateCompatibleConnection(input));
        const existing = yield* storedKey(account);
        const moved = account.baseUrl !== baseUrl;
        // Never carry an old endpoint's credential to a different server implicitly.
        if (moved && apiKey === undefined && existing !== null)
          return yield* new OpenAICompatibleFailed({ operation: "validation" });
        yield* writeBoth(
          apiKey === undefined || (apiKey === null && existing === null)
            ? null
            : setKey(account, boundKey(baseUrl, apiKey)),
          writeAccounts(
            replaceAccount(all, {
              ...account,
              baseUrl,
              // Published reasoning belongs to the server that published it.
              models: moved
                ? account.models.map(({ reasoning: _reasoning, ...model }) => model)
                : account.models,
            }),
          ),
        );
      }),
    );
  const saveModel = (id: string, input: CompatibleModelInput) =>
    change(id, ({ prior, all, account }) =>
      Effect.gen(function* () {
        const value = yield* validated(() => validateCompatibleModel(input));
        const existing = account.models.find((model) => model.id === value.id);
        const saved: CompatibleModel = { ...value, reasoning: existing?.reasoning };
        const isFirst = account.models.length === 0;
        yield* writeAccounts(
          replaceAccount(all, {
            ...account,
            models: isTruthy(existing)
              ? account.models.map((model) => (model.id === value.id ? saved : model))
              : [...account.models, saved],
          }),
          // A first model makes an active compatible choice runnable on the selected endpoint.
          isFirst && all.selected === id && prior.provider === provider
            ? { model: value.id, reasoningEffort: "default" }
            : {},
        );
      }),
    );
  const removeModel = (id: string, modelId: string) =>
    change(id, ({ prior, all, account }) =>
      Effect.gen(function* () {
        const models = account.models.filter((model) => model.id !== modelId);
        const next = models[0];
        yield* writeAccounts(
          replaceAccount(all, { ...account, models }),
          all.selected === id &&
            prior.provider === provider &&
            prior.model === modelId &&
            isTruthy(next)
            ? { model: next.id, reasoningEffort: "default" }
            : {},
        );
      }),
    );
  const remove = (id: string) =>
    change(id, ({ prior, all, account }) =>
      Effect.gen(function* () {
        const existing = yield* storedKey(account);
        const accounts = all.accounts.filter((item) => item.id !== id);
        const next =
          all.selected === id ? accounts[0] : (selectedCompatibleAccount(all) ?? undefined);
        // Remove the secret first: a failed config write then leaves an endpoint without a key,
        // never a key nothing refers to.
        yield* writeBoth(
          existing === null ? null : setKey(account, null),
          writeAccounts(
            next === undefined ? { accounts } : { selected: next.id, accounts },
            all.selected === id ? followSelection(prior, next) : {},
          ),
        );
      }),
    );
  const select = (id: string) =>
    change(id, ({ prior, all, account }) =>
      all.selected === id
        ? Effect.void
        : Effect.asVoid(writeAccounts({ ...all, selected: id }, followSelection(prior, account))),
    );

  const authorized = (key: string | null) => {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (isTruthy(key)) headers.set("Authorization", `Bearer ${key}`);
    return headers;
  };
  const request = <A>(
    operation: "test" | "models",
    id: string,
    send: (pinned: {
      readonly account: CompatibleAccount;
      readonly headers: Headers;
      readonly signal: AbortSignal;
    }) => Effect.Effect<A, OpenAICompatibleFailed>,
  ) =>
    Effect.gen(function* () {
      const { account, key } = yield* updates.withPermit(accountSnapshot(id));
      return yield* send({ account, headers: authorized(key), signal: yield* Effect.abortSignal });
    }).pipe(
      Effect.scoped,
      Effect.timeout(15_000),
      Effect.mapError((failure) =>
        failure instanceof OpenAICompatibleFailed && failure.operation === "missing"
          ? failure
          : new OpenAICompatibleFailed({ operation }),
      ),
    );
  const fetchJson = <A, I>(
    operation: "test" | "models",
    schema: Schema.Codec<A, I>,
    url: string,
    init: RequestInit,
  ) =>
    Effect.gen(function* () {
      const response = yield* attempt(operation, () =>
        fetcher(url, { ...init, redirect: "error" }),
      );
      if (!response.ok) return yield* new OpenAICompatibleFailed({ operation });
      return yield* Schema.decodeUnknownEffect(schema)(
        yield* attempt(operation, () => response.json()),
      ).pipe(Effect.mapError(() => new OpenAICompatibleFailed({ operation })));
    });
  /**
   * The endpoint's model list, for suggestions when registering a model. Reasoning efforts it
   * publishes for registered models are saved with them.
   */
  const discover = (id: string) =>
    Effect.flatMap(
      request("models", id, ({ account, headers, signal }) =>
        Effect.map(
          fetchJson("models", CompatibleModelPage, `${account.baseUrl}/models`, {
            method: "GET",
            headers,
            signal,
          }),
          (page) => ({ page, requested: account.baseUrl }),
        ),
      ),
      ({ page, requested }) =>
        updates.withPermit(
          Effect.gen(function* () {
            const ids = page.data.map((entry) => entry.id);
            const stored = yield* config.read;
            const all = compatibleAccountsOf(stored);
            const account = all.accounts.find((item) => item.id === id);
            if (account === undefined) return ids;
            if (account.baseUrl !== requested)
              return yield* new OpenAICompatibleFailed({ operation: "models" });
            const models = account.models.map(({ reasoning: _previous, ...model }) => {
              const reasoning = readCompatibleReasoning(model.id, page);
              return reasoning === undefined ? model : { ...model, reasoning };
            });
            if (!Equal.equals(models, account.models)) {
              // Before capability discovery, none meant to omit the wire parameter.
              const legacyDefault =
                all.selected === id &&
                stored.provider === provider &&
                stored.reasoningEffort === "none" &&
                account.models.find((model) => model.id === stored.model)?.reasoning === undefined;
              yield* writeAccounts(
                replaceAccount(all, { ...account, models }),
                legacyDefault ? { reasoningEffort: "default" } : {},
              );
            }
            return ids;
          }),
        ),
    );
  const test = (id: string, modelId: string) =>
    request("test", id, ({ account, headers, signal }) =>
      Effect.gen(function* () {
        const settings = compatibleEndpointModel(account, modelId);
        if (settings === null) return yield* new OpenAICompatibleFailed({ operation: "missing" });
        const completion = yield* fetchJson(
          "test",
          Schema.Struct({
            choices: Schema.Array(
              Schema.Struct({ message: Schema.Struct({ content: Schema.NullOr(Schema.String) }) }),
            ),
          }),
          `${account.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers,
            signal,
            body: stringifyJson({
              model: settings.model,
              messages: [{ role: "user", content: "Reply OK" }],
              max_tokens: Math.min(16, settings.outputBudget),
              stream: false,
            }),
          },
        );
        if (completion.choices.length === 0)
          return yield* new OpenAICompatibleFailed({ operation: "test" });
        return { ok: true as const };
      }),
    );
  const model = (settings: OpenAICompatibleConfiguration, isDefault: boolean): ProviderModel => ({
    provider,
    id: settings.model,
    displayName: settings.model,
    isDefault,
    defaultReasoningEffort: "default",
    supportedReasoningEfforts: ["default", ...(publishedReasoning(settings) ?? [])],
    contextWindow: settings.contextWindow,
    capabilities: {
      inputModalities: ["text"],
      toolCalling: settings.toolCalling,
      reasoning: publishedReasoning(settings) !== null,
    },
  });
  /** The selected endpoint joined with the model a compatible choice names, or its first model. */
  const selectedEndpoint = (settings: Settings) => {
    const account = selectedCompatibleAccount(compatibleAccountsOf(settings));
    if (account === null) return null;
    const chosen =
      settings.provider === provider && isTruthy(settings.model)
        ? compatibleEndpointModel(account, settings.model)
        : null;
    const first = account.models[0];
    return {
      account,
      endpoint: chosen ?? (first === undefined ? null : compatibleEndpointModel(account, first.id)),
    };
  };
  const pinRrsiClient = Effect.gen(function* () {
    const pinned = yield* updates.withPermit(
      Effect.gen(function* () {
        const selected = selectedEndpoint(yield* config.read);
        if (selected === null || selected.endpoint === null)
          return yield* new OpenAICompatibleFailed({ operation: "validation" });
        const { key } = yield* accountSnapshot(selected.account.id);
        return { configuration: selected.endpoint, key };
      }),
    );
    const { configuration, key } = pinned;
    const context = yield* Effect.context<never>();
    const complete = (body: string) =>
      Effect.gen(function* () {
        const payload = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )(body);
        const signal = yield* Effect.abortSignal;
        const response = yield* attempt("test", () =>
          fetcher(`${configuration.baseUrl}/chat/completions`, {
            method: "POST",
            headers: authorized(key),
            redirect: "error",
            signal,
            body: stringifyJson({
              ...payload,
              model: configuration.model,
              max_tokens: configuration.outputBudget,
              stream: false,
            }),
          }),
        );
        const text = yield* attempt("test", () => response.text());
        if (!response.ok) {
          const capacity = Option.getOrUndefined(decodeMemoryCapacity(text));
          return yield* new CompatibleCompletionRejected({
            status: response.status,
            reason:
              capacity !== undefined && capacity.error.estimated_bytes > capacity.error.limit_bytes
                ? "memory_capacity_exceeded"
                : "request_rejected",
          });
        }
        return text;
      }).pipe(Effect.scoped);
    return {
      configuration,
      complete: (body: string, signal: AbortSignal) =>
        Effect.runPromiseWith(context)(complete(body), { signal }),
    };
  });
  const services: ProviderConfiguration = {
    provider,
    auth: {
      provider,
      status: Effect.map(read, (account) => ({
        provider,
        status: isTruthy(account) ? ("signed-in" as const) : ("signed-out" as const),
      })).pipe(Effect.mapError(() => new ProviderOperationFailed({ provider, operation: "auth" }))),
      connect: Effect.succeed({ provider, status: "signed-out" }),
      cancel: Effect.succeed({ provider, status: "signed-out" }),
      disconnect: Effect.succeed({ provider, status: "signed-out" }),
    },
    models: {
      provider,
      list: Effect.gen(function* () {
        const selected = yield* read;
        if (isTruthy(selected)) yield* discover(selected.id).pipe(Effect.option);
        const account = yield* read;
        if (!isTruthy(account)) return [];
        return account.models.flatMap((entry, index) => {
          const settings = compatibleEndpointModel(account, entry.id);
          return settings === null ? [] : [model(settings, index === 0)];
        });
      }).pipe(
        Effect.mapError(() => new ProviderOperationFailed({ provider, operation: "catalog" })),
      ),
      selected: Effect.map(config.read, (settings) => {
        const endpoint = selectedEndpoint(settings)?.endpoint ?? null;
        if (settings.provider !== provider || !isTruthy(settings.model)) return null;
        return {
          provider,
          model: settings.model,
          reasoningEffort:
            isTruthy(endpoint) &&
            endpoint.model === settings.model &&
            model(endpoint, false).supportedReasoningEfforts.includes(
              settings.reasoningEffort ?? "default",
            )
              ? (settings.reasoningEffort ?? "default")
              : "default",
        };
      }),
      acceptsImages: () => Effect.succeed(false),
      cheapestEffort: (selection) => Effect.succeed({ ...selection, reasoningEffort: "default" }),
      select: (id: string, effort = "default") =>
        updates.withPermit(
          Effect.gen(function* () {
            const account = yield* read.pipe(
              Effect.mapError(() => new ProviderOperationFailed({ provider, operation: "model" })),
            );
            const settings = isTruthy(account) ? compatibleEndpointModel(account, id) : null;
            if (
              !isTruthy(settings) ||
              !model(settings, false).supportedReasoningEfforts.includes(effort)
            )
              return yield* new ModelUnavailable({ provider, model: id, reasoningEffort: effort });
            const selection = { provider, model: id, reasoningEffort: effort };
            yield* config
              .update(selection)
              .pipe(
                Effect.mapError(
                  () => new ProviderOperationFailed({ provider, operation: "model" }),
                ),
              );
            return selection;
          }),
        ),
    },
  };
  /**
   * The SDK runtime reads its window and builds adapters synchronously, so it is pinned to settings
   * read beforehand; the config file read is asynchronous and cannot run inside those calls.
   */
  const runtimeFor = (account: Effect.Success<typeof read>): AgentModelRuntime => ({
    provider,
    adapter: (selection) => {
      const settings = isTruthy(account) ? compatibleEndpointModel(account, selection.model) : null;
      if (
        !isTruthy(account) ||
        !isTruthy(settings) ||
        selection.provider !== provider ||
        !model(settings, false).supportedReasoningEfforts.includes(selection.reasoningEffort)
      )
        throw new Error("Compatible model unavailable");
      // One adapter is one run. Release from the central stream's finally aborts any
      // outstanding SDK request; no separate long-lived compatible client is retained.
      const runAbort = new AbortController();
      // Pinned to this run's endpoint, so switching accounts mid-run never swaps its key.
      const pinnedKey = Effect.runPromise(updates.withPermit(accountSnapshot(account.id)), {
        signal: runAbort.signal,
      }).then(
        ({ account: current, key }) => ({
          value: key,
          failed: !Equal.equals(compatibleEndpointModel(current, selection.model), settings),
        }),
        () => ({ value: null, failed: true }),
      );
      let promptDiagnostic = "Compatible request message roles unavailable";
      const adapter = openaiCompatibleText(selection.model, {
        baseURL: settings.baseUrl,
        apiKey: "unused",
        api: "chat-completions",
        maxRetries: 0,
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        fetch: (url, init) =>
          runNativeEffect(
            Effect.gen(function* () {
              const credential = yield* nativePromise(() => pinnedKey);
              if (runAbort.signal.aborted)
                return yield* new Cause.UnknownError(new Error("Compatible run cancelled"));
              if (credential.failed)
                return yield* new Cause.UnknownError(new Error("Compatible keychain unavailable"));
              const key = credential.value;
              const headers = new Headers(init?.headers);
              headers.delete("authorization");
              if (isTruthy(key)) headers.set("authorization", `Bearer ${key}`);
              // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
              const rawBody = EffectFunction.flow(
                Schema.decodeUnknownResult(Schema.String),
                Result.getOrThrow,
              )(init?.body ?? "{}");
              const payload = {
                // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
                ...EffectFunction.flow(
                  Schema.decodeResult(
                    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
                  ),
                  Result.getOrThrow,
                )(rawBody),
              };
              payload.max_tokens = settings.outputBudget;
              if (selection.reasoningEffort === "default") delete payload.reasoning_effort;
              else payload.reasoning_effort = selection.reasoningEffort;
              if (!settings.toolCalling) {
                delete payload.tools;
                delete payload.tool_choice;
              }
              const body = stringifyJson(payload);
              const messages = Option.getOrElse(requestRoles(payload.messages), () => []);
              const userContent = messages
                .filter((message) => message.role === "user")
                .map((message) => {
                  const content = message.content;
                  if (Schema.is(Schema.String)(content)) {
                    const text = content.trim();
                    const wrapped =
                      text.startsWith("<tool_response>") && text.endsWith("</tool_response>");
                    return `text:${content.length}:${wrapped ? "tool-response" : "plain"}`;
                  }
                  if (Array.isArray(content)) return `parts:${content.length}`;
                  return content === null || content === undefined ? "empty" : "other";
                });
              promptDiagnostic = `Compatible request messages: total=${messages.length}, user=${messages.filter((message) => message.role === "user").length}, assistant=${messages.filter((message) => message.role === "assistant").length}, tool=${messages.filter((message) => message.role === "tool").length}, first=${messages[0]?.role ?? "none"}, last=${messages.at(-1)?.role ?? "none"}`;
              promptDiagnostic += `, model=${selection.model}, toolDefinitions=${Array.isArray(payload.tools) ? payload.tools.length : 0}, userContent=[${userContent.join(",")}]`;
              // Conservative local guard also covers auxiliary structured-output calls and tool schemas.
              let estimatedInput = 0;
              for (const character of body)
                estimatedInput += character.charCodeAt(0) < 128 ? 0.25 : 1;
              if (Math.ceil(estimatedInput) + settings.outputBudget > settings.contextWindow)
                return yield* new Cause.UnknownError(
                  new Error("Compatible context limit exceeded"),
                );
              return yield* Effect.gen(function* () {
                const signal = isTruthy(init?.signal)
                  ? AbortSignal.any([init.signal, runAbort.signal])
                  : runAbort.signal;
                return yield* nativePromise(() =>
                  fetcher(url, {
                    ...init,
                    body,
                    headers,
                    redirect: "error",
                    signal,
                  }),
                );
              }).pipe(
                Effect.catchCause((failure) =>
                  Effect.gen(function* () {
                    const cause = nativeFailure(failure).cause;
                    // Do not log URLs, headers or payloads. Surface transport codes even
                    // when the provider SDK reduces this exception to "Connection error".
                    const codes: string[] = [];
                    let current: unknown = cause;
                    const seen: unknown[] = [];
                    while (current instanceof Error && !seen.includes(current) && seen.length < 8) {
                      seen.push(current);
                      if ("code" in current && isTransportErrorCode(current.code))
                        codes.push(current.code);
                      current = current.cause;
                    }
                    const diagnostic = isTruthy(codes.length)
                      ? codes.join(" <- ")
                      : "transport failure";
                    const error = new Error(`Compatible API request failed: ${diagnostic}`, {
                      cause,
                    });
                    // Native stdout/stderr or SDK logging boundary preserves the existing output format.
                    yield* Effect.logError(error.message);
                    return yield* new Cause.UnknownError(error);
                  }),
                ),
              );
            }),
          ),
      });
      const original = adapter.chatStream.bind(adapter);
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      adapter.chatStream = (options) =>
        nativeStream(
          Stream.fromPull(
            Effect.gen(function* () {
              const request = {
                ...options,
                modelOptions: { ...options.modelOptions, max_tokens: settings.outputBudget },
              };
              if (!settings.toolCalling) request.tools = [];
              const source = original(request)[Symbol.asyncIterator]();
              yield* Effect.addFinalizer(() =>
                nativePromise(
                  () => source.return?.().then(() => undefined) ?? Promise.resolve(),
                ).pipe(Effect.orDie),
              );
              return {
                pull: Effect.gen(function* () {
                  const next = yield* nativePromise(() => source.next());
                  if (next.done === true) return yield* Cause.done();
                  const chunk = next.value;
                  if (!settings.toolCalling && String(chunk.type).startsWith("TOOL_CALL"))
                    return yield* new Cause.UnknownError(
                      new Error("Compatible tool calling is disabled"),
                    );
                  const output: typeof chunk =
                    chunk.type === "RUN_ERROR" &&
                    chunk.message.includes("No user query found in messages")
                      ? { ...chunk, message: `${chunk.message}\n${promptDiagnostic}` }
                      : chunk;
                  return [output] as const;
                }).pipe(
                  Effect.catchIf(
                    (error) => error instanceof Cause.UnknownError,
                    (error) => {
                      const cause = error.cause;
                      return Effect.fail(
                        cause instanceof Error &&
                          cause.message.includes("No user query found in messages")
                          ? new Cause.UnknownError(
                              new Error(`${cause.message}\n${promptDiagnostic}`, { cause }),
                            )
                          : error,
                      );
                    },
                  ),
                ),
              };
            }).pipe(Effect.map(({ pull }) => pull)),
          ).pipe(Stream.scoped),
        );
      return Object.assign(adapter, {
        releaseRun: () => runAbort.abort(),
        historyKey: Buffer.from(
          Effect.runSync(
            oauthProtocolCrypto.digest("SHA-256", new TextEncoder().encode(settings.baseUrl)),
          ),
        ).toString("hex"),
      });
    },
    contextWindow: (modelId) => {
      const settings = isTruthy(account) ? compatibleEndpointModel(account, modelId) : null;
      return isTruthy(settings) ? settings.contextWindow - settings.outputBudget : 0;
    },
    contextWindowKnown: () => true,
    agentLoop: subscriptionAgentLoop,
    runMiddleware: () => ({ name: "memory-agent/openai-compatible" }),
  });
  /** A runtime pinned to the settings saved now; resolve again to see later changes. */
  const runtime = Effect.map(read, runtimeFor);
  return {
    pinRrsiClient,
    status,
    create,
    rename,
    connect,
    saveModel,
    removeModel,
    remove,
    select,
    test,
    discover,
    services,
    runtime,
  };
}
export type OpenAICompatibleSettingsApi = ReturnType<typeof makeOpenAICompatibleSettings>;
export class OpenAICompatibleSettings extends Context.Service<
  OpenAICompatibleSettings,
  OpenAICompatibleSettingsApi
>()("memory-agent/providers/openai-compatible/OpenAICompatibleSettings") {
  static readonly layerWith = (
    keys: Layer.Layer<CompatibleKeyring>,
    fetcher: Layer.Layer<CompatibleFetch>,
  ) =>
    Layer.effect(
      OpenAICompatibleSettings,
      Effect.gen(function* () {
        const config = yield* GlobalConfig;
        return makeOpenAICompatibleSettings({
          config: config,
          keys: yield* CompatibleKeyring,
          fetcher: yield* CompatibleFetch,
        });
      }),
    ).pipe(Layer.provide(Layer.merge(keys, fetcher)));
  static readonly layer = Layer.effect(
    OpenAICompatibleSettings,
    Effect.gen(function* () {
      return makeOpenAICompatibleSettings({
        config: yield* GlobalConfig,
        keys: keychain,
        fetcher: fetch,
      });
    }),
  );
}
