import { ProviderOperationFailed } from "./contracts.ts";
import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import {
  Array as Arr,
  Config,
  Context,
  Crypto,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
} from "effect";
import {
  GlobalConfig,
  type GlobalConfigApi,
  type GlobalConfigFailed,
  type Settings,
} from "../config/global-config.ts";
import { type KeyringOpenFailure, openKeyringEntry } from "../runtime/keyring.ts";
import {
  AuthConnectionState,
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
  reservedOutput,
  selectedCompatibleAccount,
  type CompatibleAccount,
  type CompatibleAccounts,
  type CompatibleAccountStatus,
  type CompatibleModel,
  type OpenAICompatibleConfiguration,
  type OpenAICompatibleStatus,
} from "./openai-compatible-config.ts";
import { CompatibleModelPage, readCompatibleReasoning } from "./compatible-model-discovery.ts";
import {
  CompatibleRunRequestFailed,
  CompatibleRunRequestFailedReason,
  compatibleTarget,
  failingCompatibleModel,
  compatibleModel,
  shownCompatibleFailure,
} from "../model/compatible.ts";

// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const stringifyJson = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

export class OpenAICompatibleFailed extends Schema.TaggedError<OpenAICompatibleFailed>()(
  "OpenAICompatibleFailed",
  {
    operation: Schema.Literals([
      "validation",
      "missing",
      "keychain",
      "partial",
      "test",
      "models",
      /** Naming a new account failed. */
      "account_id",
    ]),
  },
) {}
export interface CompatibleKeyStore {
  readonly get: Effect.Effect<string | null, KeyringOpenFailure>;
  /** Null deletes the stored key. */
  readonly set: (value: string | null) => Effect.Effect<void, KeyringOpenFailure>;
}
/** One keychain entry per compatible account, named by the account's `credentialEntry`. */
export type CompatibleKeychain = (entry: string) => CompatibleKeyStore;
const keyEntry = (entry: string) =>
  // Native host/SDK configuration boundary reads or forwards the host environment.
  Config.String("CONTEXT_AGENT_CREDENTIAL_NAMESPACE").pipe(
    Config.withDefault("context-generactive-agent"),
    Effect.flatMap((namespace) => openKeyringEntry(namespace, entry)),
  );
/** The keychain, reading a file backend through the platform services it was built with. */
const keychain = Effect.map(
  Effect.context<FileSystem.FileSystem | Path.Path>(),
  (platform): CompatibleKeychain =>
    (entry) => {
      const opened = Effect.provideContext(keyEntry(entry), platform);
      return {
        get: Effect.flatMap(opened, (key) => key.getPassword),
        set: (value) =>
          Effect.flatMap(opened, (key) =>
            value === null ? Effect.asVoid(key.deletePassword) : key.setPassword(value),
          ),
      };
    },
);
export class CompatibleKeyring extends Context.Service<CompatibleKeyring, CompatibleKeychain>()(
  "memory-agent/providers/openai-compatible/CompatibleKeyring",
) {
  static readonly layer = Layer.effect(CompatibleKeyring, keychain);
}
export class CompatibleFetch extends Context.Service<CompatibleFetch, typeof fetch>()(
  "memory-agent/providers/openai-compatible/CompatibleFetch",
) {
  static readonly layer = Layer.succeed(CompatibleFetch, fetch);
}
const provider = "openai-compatible" as const;
const credentialPrefix = "context-generactive-agent/openai-compatible/v1:";
const decodeStoredCredential = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ baseUrl: Schema.String, key: Schema.String })),
);
const credentialFor = (stored: string | null, baseUrl: string): string | null =>
  Option.liftPredicate(stored, isTruthy).pipe(
    Option.flatMap((credential) =>
      // Legacy credentials predate endpoint binding. An endpoint change without an explicit
      // replacement or clear is rejected below; newly written credentials are always bound.
      credential.startsWith(credentialPrefix)
        ? // An unreadable bound credential counts as no credential for any endpoint.
          decodeStoredCredential(credential.slice(credentialPrefix.length)).pipe(
            Option.filter((value) => value.baseUrl === baseUrl),
            Option.map((value) => value.key),
          )
        : Option.some(credential),
    ),
    Option.getOrNull,
  );
const invalidSettings = () => OpenAICompatibleFailed.make({ operation: "validation" });
/** An http(s) URL without credentials, query or fragment. */
const isEndpointUrl = (url: URL) =>
  ["http:", "https:"].includes(url.protocol) &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  url.search.length === 0 &&
  url.hash.length === 0;
export const validateCompatibleConnection = Effect.fnUntraced(function* (
  input: CompatibleConnectionInput,
): Effect.fn.Return<CompatibleConnectionInput, OpenAICompatibleFailed> {
  const value = yield* Schema.decodeEffect(CompatibleConnectionInput)(input).pipe(
    Effect.mapError(invalidSettings),
  );
  const url = yield* Effect.try({
    try: () => new URL(value.baseUrl.trim()),
    catch: invalidSettings,
  }).pipe(Effect.filterOrFail(isEndpointUrl, invalidSettings));
  return { ...value, baseUrl: url.href.replace(/\/+$/, "") };
});
/** A model whose window or output budget is out of range, or that has no id. */
const isUnusableModel = (value: CompatibleModelInput) =>
  value.contextWindow < 1024 ||
  value.contextWindow > 10_000_000 ||
  (value.outputBudget !== null &&
    (value.outputBudget < 1 || value.outputBudget >= value.contextWindow)) ||
  !isTruthy(value.id.trim());
export const validateCompatibleModel = Effect.fnUntraced(function* (
  input: CompatibleModelInput,
): Effect.fn.Return<CompatibleModelInput, OpenAICompatibleFailed> {
  const value = yield* Schema.decodeEffect(CompatibleModelInput)(input).pipe(
    Effect.mapError(invalidSettings),
    Effect.filterOrFail((decoded) => !isUnusableModel(decoded), invalidSettings),
  );
  return { ...value, id: value.id.trim() };
});
export const validateCompatibleLabel = (
  label: string,
): Effect.Effect<string, OpenAICompatibleFailed> =>
  Effect.sync(() => label.trim()).pipe(
    Effect.filterOrFail((value) => value !== "" && value.length <= 80, invalidSettings),
  );
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
export function makeOpenAICompatibleSettings(options: {
  readonly config: GlobalConfigApi;
  readonly keys: CompatibleKeychain;
  readonly crypto: Crypto.Crypto;
  readonly fetcher?: typeof fetch | undefined;
}) {
  return makeOpenAICompatibleSettingsBody(
    options.config,
    options.keys,
    options.crypto,
    options.fetcher,
  );
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
  keys: CompatibleKeychain,
  crypto: Crypto.Crypto,
  fetcher: typeof fetch = fetch,
) {
  const updates = Semaphore.makeUnsafe(1);
  // Keyring calls cannot be cancelled once started. Never retry an uncertain write automatically.
  const attempt = <A>(operation: OpenAICompatibleFailed["operation"], run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: () => OpenAICompatibleFailed.make({ operation }) });
  const accountsOf = Effect.map(config.read, compatibleAccountsOf);
  /** The selected endpoint, which compatible runs, catalogs and model selection use. */
  const read = Effect.map(accountsOf, selectedCompatibleAccount);
  const findAccount = (all: CompatibleAccounts, id: string) =>
    Effect.fromNullishOr(all.accounts.find((account) => account.id === id)).pipe(
      Effect.mapError(() => OpenAICompatibleFailed.make({ operation: "missing" })),
    );
  const storedKey = (account: CompatibleAccount) =>
    keys(account.credentialEntry).get.pipe(
      Effect.mapError(() => OpenAICompatibleFailed.make({ operation: "keychain" })),
    );
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
        yield* keyWrite ?? Effect.void;
        yield* configWrite.pipe(
          Effect.mapError(() => OpenAICompatibleFailed.make({ operation: "partial" })),
        );
      }),
    );
  const setKey = (account: CompatibleAccount, value: string | null) =>
    keys(account.credentialEntry)
      .set(value)
      .pipe(Effect.mapError(() => OpenAICompatibleFailed.make({ operation: "partial" })));
  const boundKey = (baseUrl: string, apiKey: string | null) =>
    apiKey === null || apiKey === ""
      ? null
      : credentialPrefix + JSON.stringify({ baseUrl, key: apiKey });
  /**
   * The model choice that goes with a newly selected endpoint: the same model when that endpoint
   * registered it too, else its first model. Only an active compatible choice moves.
   */
  const followSelection = (prior: Settings, account: CompatibleAccount | undefined) =>
    Option.fromUndefinedOr(account).pipe(
      Option.filter(
        (next) =>
          prior.provider === provider &&
          isTruthy(prior.model) &&
          !next.models.some((model) => model.id === prior.model),
      ),
      Option.flatMap((next) => Arr.head(next.models)),
      Option.match({
        onNone: () => ({}),
        onSome: (first) => ({ model: first.id, reasoningEffort: "default" }),
      }),
    );
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
        const { baseUrl, apiKey } = yield* validateCompatibleConnection(input);
        const label = isTruthy(input.label)
          ? yield* validateCompatibleLabel(input.label ?? "")
          : compatibleHostLabel(baseUrl);
        const id = yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError(() => OpenAICompatibleFailed.make({ operation: "account_id" })));
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
        const value = yield* validateCompatibleLabel(label);
        yield* writeAccounts(replaceAccount(all, { ...account, label: value }));
      }),
    );
  const connect = (id: string, input: CompatibleConnectionInput) =>
    change(id, ({ all, account }) =>
      Effect.gen(function* () {
        const { baseUrl, apiKey } = yield* validateCompatibleConnection(input);
        const existing = yield* storedKey(account);
        const moved = account.baseUrl !== baseUrl;
        // Never carry an old endpoint's credential to a different server implicitly.
        if (moved && apiKey === undefined && existing !== null) {
          return yield* OpenAICompatibleFailed.make({ operation: "validation" });
        }
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
        const value = yield* validateCompatibleModel(input);
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

  const authorized = (key: string | null) =>
    new Headers({
      "Content-Type": "application/json",
      ...Option.match(Option.liftPredicate(key, isTruthy), {
        onNone: () => ({}),
        onSome: (value) => ({ Authorization: `Bearer ${value}` }),
      }),
    });
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
        Schema.is(OpenAICompatibleFailed)(failure) && failure.operation === "missing"
          ? failure
          : OpenAICompatibleFailed.make({ operation }),
      ),
    );
  const fetchJson = <A, I>(
    operation: "test" | "models",
    schema: Schema.Codec<A, I>,
    url: string,
    init: RequestInit,
  ) =>
    attempt(operation, () => fetcher(url, { ...init, redirect: "error" })).pipe(
      Effect.filterOrFail(
        (response) => response.ok,
        () => OpenAICompatibleFailed.make({ operation }),
      ),
      Effect.flatMap((response) => attempt(operation, () => response.json())),
      Effect.flatMap((body) =>
        Schema.decodeUnknownEffect(schema)(body).pipe(
          Effect.mapError(() => OpenAICompatibleFailed.make({ operation })),
        ),
      ),
    );
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
            yield* Option.match(
              Arr.findFirst(all.accounts, (item) => item.id === id),
              {
                onNone: () => Effect.void,
                onSome: (account) =>
                  Effect.when(
                    Effect.fail(OpenAICompatibleFailed.make({ operation: "models" })),
                    Effect.succeed(account.baseUrl !== requested),
                  ).pipe(
                    Effect.andThen(() => {
                      const models = account.models.map(({ reasoning: _previous, ...model }) =>
                        Option.match(
                          Option.fromUndefinedOr(readCompatibleReasoning(model.id, page)),
                          {
                            onNone: () => model,
                            onSome: (reasoning) => ({ ...model, reasoning }),
                          },
                        ),
                      );
                      // Before capability discovery, none meant to omit the wire parameter.
                      const legacyDefault =
                        all.selected === id &&
                        stored.provider === provider &&
                        stored.reasoningEffort === "none" &&
                        account.models.find((model) => model.id === stored.model)?.reasoning ===
                          undefined;
                      return Effect.when(
                        writeAccounts(
                          replaceAccount(all, { ...account, models }),
                          legacyDefault ? { reasoningEffort: "default" } : {},
                        ),
                        Effect.succeed(!Equal.equals(models, account.models)),
                      );
                    }),
                  ),
              },
            );
            return ids;
          }),
        ),
    );
  const test = (id: string, modelId: string) =>
    request("test", id, ({ account, headers, signal }) =>
      Effect.fromNullishOr(compatibleEndpointModel(account, modelId)).pipe(
        Effect.mapError(() => OpenAICompatibleFailed.make({ operation: "missing" })),
        Effect.flatMap((settings) =>
          fetchJson(
            "test",
            Schema.Struct({
              choices: Schema.Array(
                Schema.Struct({
                  message: Schema.Struct({ content: Schema.NullOr(Schema.String) }),
                }),
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
                max_tokens: Math.min(16, settings.outputBudget ?? 16),
                stream: false,
              }),
            },
          ),
        ),
        Effect.filterOrFail(
          (completion) => completion.choices.length > 0,
          () => OpenAICompatibleFailed.make({ operation: "test" }),
        ),
        Effect.as({ ok: true as const }),
      ),
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
  /** The selected endpoint with the model a compatible choice names, or with its first model. */
  const selectedEndpoint = (settings: Settings) =>
    Option.fromNullishOr(selectedCompatibleAccount(compatibleAccountsOf(settings))).pipe(
      Option.flatMap((account) =>
        Option.liftPredicate(settings.model, isTruthy).pipe(
          Option.filter(() => settings.provider === provider),
          Option.flatMapNullishOr((chosen) => compatibleEndpointModel(account, chosen)),
          Option.orElse(() =>
            Option.flatMapNullishOr(Arr.head(account.models), (first) =>
              compatibleEndpointModel(account, first.id),
            ),
          ),
        ),
      ),
    );
  const services: ProviderConfiguration = {
    provider,
    auth: {
      provider,
      status: Effect.map(read, (account) =>
        isTruthy(account)
          ? AuthConnectionState["signed-in"]({ provider })
          : AuthConnectionState["signed-out"]({ provider }),
      ).pipe(Effect.mapError(() => ProviderOperationFailed.make({ provider, operation: "auth" }))),
      connect: Effect.succeed(AuthConnectionState["signed-out"]({ provider })),
      cancel: Effect.succeed(AuthConnectionState["signed-out"]({ provider })),
      disconnect: Effect.succeed(AuthConnectionState["signed-out"]({ provider })),
    },
    models: {
      provider,
      list: Effect.gen(function* () {
        const selected = yield* read;
        // Discovery only refreshes published reasoning; the registered models list without it.
        yield* Option.match(Option.liftPredicate(selected, isTruthy), {
          onNone: () => Effect.void,
          onSome: (account) =>
            discover(account.id).pipe(
              Effect.catchTag(["OpenAICompatibleFailed", "GlobalConfigFailed"], () => Effect.void),
            ),
        });
        const account = yield* read;
        return Option.match(Option.liftPredicate(account, isTruthy), {
          onNone: () => [],
          onSome: (refreshed) =>
            refreshed.models.flatMap((entry, index) =>
              Option.toArray(
                Option.map(
                  Option.fromNullishOr(compatibleEndpointModel(refreshed, entry.id)),
                  (settings) => model(settings, index === 0),
                ),
              ),
            ),
        });
      }).pipe(
        Effect.mapError(() => ProviderOperationFailed.make({ provider, operation: "catalog" })),
      ),
      selected: Effect.map(config.read, (settings) =>
        Option.liftPredicate(settings.model, isTruthy).pipe(
          Option.filter(() => settings.provider === provider),
          Option.map((chosen) => ({
            provider,
            model: chosen,
            reasoningEffort: Option.exists(
              selectedEndpoint(settings),
              (endpoint) =>
                endpoint.model === chosen &&
                model(endpoint, false).supportedReasoningEfforts.includes(
                  settings.reasoningEffort ?? "default",
                ),
            )
              ? (settings.reasoningEffort ?? "default")
              : "default",
          })),
          Option.getOrNull,
        ),
      ),
      acceptsImages: () => Effect.succeed(false),
      cheapestEffort: (selection) => Effect.succeed({ ...selection, reasoningEffort: "default" }),
      select: (id: string, effort = "default") =>
        updates.withPermit(
          Effect.gen(function* () {
            const account = yield* read.pipe(
              Effect.mapError(() => ProviderOperationFailed.make({ provider, operation: "model" })),
            );
            const selection = yield* Effect.fromOption(
              Option.liftPredicate(account, isTruthy).pipe(
                Option.flatMapNullishOr((found) => compatibleEndpointModel(found, id)),
                Option.filter((settings) =>
                  model(settings, false).supportedReasoningEfforts.includes(effort),
                ),
                Option.as({ provider, model: id, reasoningEffort: effort }),
              ),
              () => ModelUnavailable.make({ provider, model: id, reasoningEffort: effort }),
            );
            yield* config
              .update(selection)
              .pipe(
                Effect.mapError(() =>
                  ProviderOperationFailed.make({ provider, operation: "model" }),
                ),
              );
            return selection;
          }),
        ),
    },
  };
  /**
   * The runtime reads its window synchronously, so it is pinned to settings read beforehand; the
   * config file read is asynchronous and cannot run inside that call.
   */
  const runtimeFor = (account: Effect.Success<typeof read>): AgentModelRuntime => ({
    provider,
    model: (selection) =>
      Effect.gen(function* () {
        const unavailable = () => ModelUnavailable.make(selection);
        const pinned = yield* Effect.fromNullishOr(account).pipe(Effect.mapError(unavailable));
        const settings = yield* Effect.fromNullishOr(
          compatibleEndpointModel(pinned, selection.model),
        ).pipe(
          Effect.filterOrFail(
            (found) =>
              selection.provider === provider &&
              model(found, false).supportedReasoningEfforts.includes(selection.reasoningEffort),
            unavailable,
          ),
          Effect.mapError(unavailable),
        );
        // Read once for the run, so switching accounts mid-run never swaps its key.
        const key = yield* updates.withPermit(accountSnapshot(pinned.id)).pipe(
          Effect.map(({ account: current, key }) =>
            Option.liftPredicate(key, () =>
              Equal.equals(compatibleEndpointModel(current, selection.model), settings),
            ),
          ),
          Effect.orElseSucceed(Option.none),
        );
        const historyKey = Buffer.from(
          yield* crypto
            .digest("SHA-256", new TextEncoder().encode(settings.baseUrl))
            .pipe(Effect.orDie),
        ).toString("hex");
        return {
          model: yield* Option.match(key, {
            onSome: (found) =>
              compatibleModel({
                endpoint: settings,
                reasoningEffort: selection.reasoningEffort,
                key: found,
                fetcher,
              }),
            onNone: () =>
              failingCompatibleModel(
                CompatibleRunRequestFailed.make({
                  reason: CompatibleRunRequestFailedReason.cases.KeychainUnavailable.make({}),
                }),
              ),
          }),
          source: compatibleTarget(settings.model).source,
          shownFailure: shownCompatibleFailure,
          historyKey,
        };
      }),
    contextWindow: (modelId) => {
      const settings = isTruthy(account) ? compatibleEndpointModel(account, modelId) : null;
      return isTruthy(settings)
        ? settings.contextWindow - reservedOutput(settings.outputBudget)
        : 0;
    },
    contextWindowKnown: () => true,
  });
  /** A runtime pinned to the settings saved now; resolve again to see later changes. */
  const runtime = Effect.map(read, runtimeFor);
  return {
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
          crypto: yield* Crypto.Crypto,
          fetcher: yield* CompatibleFetch,
        });
      }),
    ).pipe(Layer.provide(Layer.merge(keys, fetcher)));
  static readonly layer = Layer.effect(
    OpenAICompatibleSettings,
    Effect.gen(function* () {
      return makeOpenAICompatibleSettings({
        config: yield* GlobalConfig,
        keys: yield* keychain,
        crypto: yield* Crypto.Crypto,
        fetcher: fetch,
      });
    }),
  );
}
