import { nativePromise } from "../runtime/native-effect.ts";
import { Cause, Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { ANTHROPIC_MODELS } from "./model-catalog.ts";
import {
  Array as Arr,
  Clock,
  Data,
  Deferred,
  Effect,
  Exit,
  Match,
  Option,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import type { Settings } from "../config/global-config.ts";
import { optionalProperty } from "../optional-property.ts";
import {
  createSubscriptionOAuthClient,
  OAuthHarnessError,
  type LoginAttempt,
  type OAuthConnectionStatus,
} from "../oauth/subscription-oauth.ts";
import type { ProviderProtocol } from "../oauth/protocol.ts";
import {
  ModelUnavailable,
  ProviderOperationFailed,
  AuthConnectionState,
  type ModelSelection,
  type ProviderConfiguration,
  type SubscriptionAccountProvider,
  type ProviderModel,
} from "./contracts.ts";

interface ProductOAuthClient {
  status(): Promise<OAuthConnectionStatus>;
  startLogin(): Promise<LoginAttempt>;
  disconnect(): Promise<OAuthConnectionStatus>;
  modelCatalog(signal?: AbortSignal): Promise<ReadonlyArray<unknown>>;
}

interface SettingsStore {
  readonly read: Effect.Effect<Settings, import("../config/global-config.ts").GlobalConfigFailed>;
  readonly update: (
    patch: Partial<Settings>,
  ) => Effect.Effect<Settings, import("../config/global-config.ts").GlobalConfigFailed>;
}

export interface SubscriptionProviderOptions {
  readonly protocol: ProviderProtocol;
  readonly config: SettingsStore;
  readonly client?: ProductOAuthClient;
  /** Prevent one local account's catalogue from being served after provider selection changes. */
  readonly catalogKey?: () => string;
}

const EffortObject = Schema.Struct({
  reasoning_effort: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
});
const EffortValue = Schema.Union([Schema.String, EffortObject]);
const CatalogModel = Schema.Struct({
  slug: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  display_name: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  default_reasoning_level: Schema.optional(Schema.String),
  default_reasoning_effort: Schema.optional(Schema.String),
  supported_reasoning_levels: Schema.optional(Schema.Array(EffortValue)),
  supported_reasoning_efforts: Schema.optional(Schema.Array(EffortValue)),
  input_modalities: Schema.optional(Schema.Array(Schema.String)),
  // Ignore malformed/unknown limits without discarding an otherwise usable model.
  context_window: Schema.optional(Schema.Unknown),
});
type CatalogModel = typeof CatalogModel.Type;
const CatalogModels = Schema.Array(CatalogModel);
const CatalogPage = Schema.Union([
  CatalogModels,
  Schema.Struct({ models: CatalogModels }),
  Schema.Struct({ data: CatalogModels }),
  Schema.Struct({ data: Schema.Struct({ models: CatalogModels }) }),
]);
const decodeCatalogPage = Schema.decodeUnknownOption(CatalogPage);

const canonicalEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const canonicalEffort = (value: string | undefined) =>
  Option.fromNullishOr(value).pipe(
    Option.map((raw) => raw.trim().toLowerCase()),
    Option.filter((effort) => canonicalEfforts.includes(effort)),
  );

const effortValues = (model: CatalogModel) =>
  Arr.dedupe(
    (model.supported_reasoning_levels ?? model.supported_reasoning_efforts ?? []).flatMap((item) =>
      Option.toArray(
        canonicalEffort(
          Match.value(item).pipe(
            Match.when(Match.string, (effort) => effort),
            Match.orElse((named) => named.reasoning_effort ?? named.effort ?? named.value),
          ),
        ),
      ),
    ),
  );

const isCatalogModels = Schema.is(CatalogModels);

const pageModels = (page: typeof CatalogPage.Type): ReadonlyArray<CatalogModel> =>
  Match.value(page).pipe(
    Match.when(isCatalogModels, (models) => models),
    Match.when({ models: isCatalogModels }, ({ models }) => models),
    Match.when({ data: isCatalogModels }, ({ data }) => data),
    Match.orElse(({ data }) => data.models),
  );

const catalogEntries = (provider: SubscriptionAccountProvider, pages: ReadonlyArray<unknown>) =>
  pages
    .flatMap((page) =>
      Option.match(decodeCatalogPage(page), {
        onNone: () => [],
        onSome: pageModels,
      }),
    )
    .flatMap((entry) => {
      const id = provider === "openai" ? (entry.slug ?? entry.id ?? entry.model) : entry.id;
      return id === undefined ? [] : [{ entry, id }];
    });

const anthropicEfforts = (model: string) => {
  const normalized = model
    .trim()
    .toLowerCase()
    .replaceAll(".", "-")
    .replace(/\[1m\]$/, "")
    .replace(/-\d{8}$/, "");
  const segments = normalized.split("-");
  const family = segments.find(
    (segment) =>
      segment !== "claude" &&
      segment !== "latest" &&
      !/^\d+$/.test(segment) &&
      /^[a-z]+$/.test(segment),
  );
  const numbers = segments.filter((segment) => /^\d+$/.test(segment)).map(Number);
  const version = [numbers[0] ?? 0, numbers[1] ?? 0] as const;
  const atLeast = (major: number, minor: number) =>
    version[0] > major || (version[0] === major && version[1] >= minor);
  // The first tier the model belongs to; newer tiers come first.
  const tiers: ReadonlyArray<readonly [applies: boolean, efforts: Array<string>]> = [
    [
      (family === "opus" && atLeast(4, 7)) ||
        (family === "sonnet" && atLeast(5, 0)) ||
        (family !== "opus" && family !== "sonnet" && atLeast(5, 0)),
      ["low", "medium", "high", "xhigh", "max"],
    ],
    [
      normalized.includes("mythos") ||
        (family === "opus" && version[0] === 4 && version[1] === 6) ||
        (family === "sonnet" && version[0] === 4 && version[1] === 6),
      ["low", "medium", "high", "max"],
    ],
    [family === "opus" && version[0] === 4 && version[1] === 5, ["low", "medium", "high"]],
    [family === "sonnet" && version[0] === 3 && version[1] === 7, ["low", "medium", "high"]],
  ];
  return Arr.findFirst(tiers, ([applies]) => applies).pipe(
    Option.map(([, efforts]) => efforts),
    Option.getOrElse(() => ["none"]),
  );
};

export const parseSubscriptionCatalog: {
  (
    pages: ReadonlyArray<unknown>,
  ): (provider: SubscriptionAccountProvider) => ReturnType<typeof parseSubscriptionCatalogBody>;
} & typeof parseSubscriptionCatalogBody = EffectFunction.dual(2, parseSubscriptionCatalogBody);
function parseSubscriptionCatalogBody(
  provider: SubscriptionAccountProvider,
  pages: ReadonlyArray<unknown>,
): ReadonlyArray<ProviderModel> {
  const entries = catalogEntries(provider, pages);
  const preferred = provider === "openai" ? "gpt-6-astra" : "claude-opus-5";
  // A model listed twice keeps its first entry, and the place of that entry.
  const firsts = Arr.dedupeWith(
    entries.map((listed, index) => ({ ...listed, index })),
    (left, right) => left.id === right.id,
  );
  return firsts.map(({ entry, id, index }) => {
    const advertised = provider === "openai" ? effortValues(entry) : anthropicEfforts(id);
    const efforts = advertised.length > 0 ? advertised : ["none"];
    const defaultReasoningEffort = Option.getOrElse(
      Option.filter(
        canonicalEffort(entry.default_reasoning_level ?? entry.default_reasoning_effort),
        (requested) => efforts.includes(requested),
      ),
      () => (efforts.includes("medium") ? "medium" : efforts[0]!),
    );
    const image =
      entry.input_modalities?.some((modality) => modality === "image" || modality === "vision") ??
      false;
    const contextWindow = Option.filter(
      Schema.decodeUnknownOption(Schema.Int)(entry.context_window),
      (limit) => Number.isSafeInteger(limit) && limit > 0,
    );
    const model: ProviderModel = {
      provider,
      id,
      displayName: entry.display_name ?? entry.name ?? id,
      isDefault:
        id === preferred || (index === 0 && !entries.some((item) => item.id === preferred)),
      defaultReasoningEffort,
      supportedReasoningEfforts: efforts,
      capabilities: {
        inputModalities: image || provider === "anthropic" ? ["text", "image"] : ["text"],
        toolCalling: true,
        reasoning: efforts.some((effort) => effort !== "none"),
      },
    };
    return Option.match(contextWindow, {
      onNone: () => model,
      onSome: (limit): ProviderModel => ({ ...model, contextWindow: limit }),
    });
  });
}

/** What a person reads for each way a login can fail. */
const loginFailureMessages = {
  cancelled: "Login was cancelled.",
  callback_invalid: "The browser returned an invalid login callback.",
  callback_state_mismatch: "Login verification failed. Please retry.",
  callback_timeout: "The browser did not return to this app in time.",
  credential_store_unavailable: "The system credential store is unavailable.",
  invalid_token_response: "The provider returned an invalid login response.",
  login_in_progress: "A login is already in progress.",
  not_connected: "The provider is not connected.",
  provider_rejected: "The provider rejected the login request.",
  transport_unavailable: "The login server or provider could not be reached.",
} satisfies Record<OAuthHarnessError["code"], string>;

const isHarnessError = Schema.is(OAuthHarnessError);

const anthropicInstalledCatalog = [
  {
    data: ANTHROPIC_MODELS.map((id) => ({
      id,
      display_name: id
        .split("-")
        .map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`)
        .join(" ")
        .replace(/(\d) (\d)/g, "$1.$2"),
    })),
  },
] as const;

const operationFailure = (
  provider: SubscriptionAccountProvider,
  operation: "auth" | "catalog" | "model",
) => ProviderOperationFailed.make({ provider, operation });

const fromPromise = <A>(
  provider: SubscriptionAccountProvider,
  operation: "auth" | "catalog" | "model",
  run: (signal: AbortSignal) => Promise<A>,
) =>
  Effect.tryPromise({
    try: run,
    catch: () => operationFailure(provider, operation),
  });

/** A catalog load in flight, or models served until `expiresAt`. */
type CatalogState = Data.TaggedEnum<{
  Loading: {};
  Cached: { readonly expiresAt: number };
}>;
const CatalogState = Data.taggedEnum<CatalogState>();
type CatalogEntry = {
  readonly key: string;
  readonly token: object;
  readonly completion: Deferred.Deferred<ReadonlyArray<ProviderModel>, ProviderOperationFailed>;
  readonly state: CatalogState;
};
/** The first caller owns the load; later callers wait on the owner's completion. */
type Admission = Data.TaggedEnum<{
  Waiter: { readonly entry: CatalogEntry };
  Owner: { readonly entry: CatalogEntry };
}>;
const Admission = Data.taggedEnum<Admission>();

export function createSubscriptionProvider(
  options: SubscriptionProviderOptions,
): ProviderConfiguration & { readonly contextWindow: (model: string) => number | null } {
  const provider = options.protocol.provider;
  const client = options.client ?? createSubscriptionOAuthClient({ protocol: options.protocol });
  let pending: LoginAttempt | null = null;
  let loginError: Data.TaggedEnum.Value<AuthConnectionState, "error"> | null = null;
  const failureState = (
    harnessError: Option.Option<OAuthHarnessError>,
  ): Data.TaggedEnum.Value<AuthConnectionState, "error"> =>
    Option.match(harnessError, {
      onNone: () => AuthConnectionState.error({ provider, message: "Login did not complete." }),
      onSome: (error) =>
        AuthConnectionState.error({
          provider,
          message: loginFailureMessages[error.code] ?? "Login did not complete.",
          code: error.code,
          ...optionalProperty("operation", error.operation ?? undefined),
          ...optionalProperty("httpStatus", error.status ?? undefined),
          ...optionalProperty("providerCode", error.providerCode ?? undefined),
          ...optionalProperty("credentialStage", error.credentialStage ?? undefined),
          ...optionalProperty("transportCode", error.transportCode ?? undefined),
          ...optionalProperty("proxyRoute", error.proxyRoute ?? undefined),
        }),
    });
  const connectionState = (connection: { readonly connected: boolean }): AuthConnectionState =>
    connection.connected
      ? AuthConnectionState["signed-in"]({ provider })
      : AuthConnectionState["signed-out"]({ provider });
  let catalogCache: {
    readonly key: string;
    readonly models: ReadonlyArray<ProviderModel>;
  } | null = null;

  const authState = Effect.fn("SubscriptionProvider.authState")(function* (): Effect.fn.Return<
    AuthConnectionState,
    Cause.UnknownError
  > {
    // A login in progress or one that failed is known here; otherwise the account is asked.
    const local = Option.orElse(
      Option.map(Option.fromNullishOr(pending), (attempt) =>
        AuthConnectionState.pending({ provider, authorizationUrl: attempt.authorizationUrl }),
      ),
      () => Option.fromNullishOr(loginError),
    );
    return yield* Option.match(local, {
      onSome: (state) => Effect.succeed<AuthConnectionState>(state),
      onNone: () =>
        nativePromise(() => client.status()).pipe(
          Effect.map(connectionState),
          Effect.catchIf(
            (failure): failure is Cause.UnknownError & { readonly cause: OAuthHarnessError } =>
              isHarnessError(failure.cause) &&
              failure.cause.code === "credential_store_unavailable",
            (failure) => Effect.succeed(failureState(Option.some(failure.cause))),
          ),
        ),
    });
  });
  const status = authState().pipe(Effect.mapError(() => operationFailure(provider, "auth")));
  const login = Effect.gen(function* () {
    loginError = null;
    const started = yield* Effect.result(nativePromise(() => client.startLogin()));
    return Result.match(started, {
      onFailure: (failure): AuthConnectionState => {
        loginError = failureState(Option.liftPredicate(failure.cause, isHarnessError));
        return loginError;
      },
      onSuccess: (attempt): AuthConnectionState => {
        pending = attempt;
        // Only the attempt still pending settles the login state.
        const current = () => pending === attempt;
        void attempt.completed.then(
          () => {
            pending = current() ? null : pending;
          },
          (error) => {
            loginError = current()
              ? failureState(Option.liftPredicate(error, isHarnessError))
              : loginError;
            pending = current() ? null : pending;
          },
        );
        return AuthConnectionState.pending({
          provider,
          authorizationUrl: attempt.authorizationUrl,
        });
      },
    });
  });
  const connect = authState().pipe(
    Effect.filterOrElse(
      (current) =>
        AuthConnectionState.$is("signed-in")(current) ||
        AuthConnectionState.$is("pending")(current),
      () => login,
    ),
    Effect.mapError(() => operationFailure(provider, "auth")),
  );
  const cancel = Effect.sync(() => {
    const attempt = pending;
    pending = null;
    loginError = null;
    attempt?.cancel();
  }).pipe(
    Effect.andThen(authState()),
    Effect.mapError(() => operationFailure(provider, "auth")),
  );
  const catalogEntry = Ref.makeUnsafe<CatalogEntry | null>(null);
  const catalogLock = Semaphore.makeUnsafe(1);
  const invalidateCatalog = catalogLock.withPermits(1)(
    Effect.gen(function* () {
      yield* Ref.set(catalogEntry, null);
      catalogCache = null;
    }),
  );
  const disconnect = Effect.gen(function* () {
    yield* invalidateCatalog;
    const attempt = pending;
    pending = null;
    loginError = null;
    attempt?.cancel();
    return yield* fromPromise(provider, "auth", () => client.disconnect()).pipe(
      Effect.map(connectionState),
    );
  }).pipe(Effect.ensuring(invalidateCatalog));

  // The first caller owns the load in its existing fiber/scope. Cancelling a
  // waiting caller only stops that wait; cancelling the owner interrupts all
  // current waiters, and failed/interrupted entries permit retry. The owner signal reaches the
  // native catalog fetch; a cancelled waiter cannot abort the owner's transport.
  // Publish the owner only after installing its interruption cleanup. Network and waiter
  // effects restore caller interruptibility; the short admission section stays atomic.
  const list = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const admission = yield* catalogLock.withPermits(1)(
        Effect.gen(function* () {
          const key = options.catalogKey?.() ?? "__default__";
          const current = Option.filter(
            Option.fromNullishOr(yield* Ref.get(catalogEntry)),
            (entry) => entry.key === key,
          );
          // A load in flight, or models still fresh, for the same key.
          const reusable = yield* Option.match(current, {
            onNone: () => Effect.succeedNone,
            onSome: (entry) =>
              Effect.map(
                CatalogState.$match(entry.state, {
                  Loading: () => Effect.succeed(true),
                  Cached: (state) =>
                    Effect.map(Clock.currentTimeMillis, (now) => now < state.expiresAt),
                }),
                (fresh) => Option.liftPredicate(entry, () => fresh),
              ),
          });
          const owned = Effect.gen(function* () {
            const next: CatalogEntry = {
              key,
              token: {},
              completion: yield* Deferred.make<
                ReadonlyArray<ProviderModel>,
                ProviderOperationFailed
              >(),
              state: CatalogState.Loading(),
            };
            yield* Ref.set(catalogEntry, next);
            return Admission.Owner({ entry: next });
          });
          return yield* Option.match(reusable, {
            onSome: (entry) => Effect.succeed(Admission.Waiter({ entry })),
            onNone: () => owned,
          });
        }),
      );
      return yield* Admission.$match(admission, {
        Waiter: ({ entry }) => restore(Deferred.await(entry.completion)),
        Owner: ({ entry }) =>
          restore(
            Effect.gen(function* () {
              const pages =
                provider === "anthropic"
                  ? anthropicInstalledCatalog
                  : yield* fromPromise(provider, "catalog", (signal) =>
                      client.modelCatalog(signal),
                    );
              const models = yield* Effect.succeed(parseSubscriptionCatalog(provider, pages)).pipe(
                Effect.filterOrFail(
                  (parsed) => parsed.length > 0,
                  () => operationFailure(provider, "catalog"),
                ),
              );
              // Kept for contextWindow while this load is still the current one.
              yield* Effect.when(
                Effect.sync(() => {
                  catalogCache = { key: entry.key, models };
                }),
                Effect.sync(
                  () =>
                    Ref.getUnsafe(catalogEntry)?.token === entry.token &&
                    (options.catalogKey?.() ?? "__default__") === entry.key,
                ),
              );
              return models;
            }).pipe(
              Effect.onExit((exit) =>
                catalogLock.withPermits(1)(
                  Effect.gen(function* () {
                    const settled = Exit.match(exit, {
                      onSuccess: () =>
                        Effect.map(Clock.currentTimeMillis, (now): CatalogEntry | null => ({
                          ...entry,
                          state: CatalogState.Cached({ expiresAt: now + 30_000 }),
                        })),
                      onFailure: () => Effect.succeed<CatalogEntry | null>(null),
                    });
                    yield* Effect.when(
                      Effect.flatMap(settled, (next) => Ref.set(catalogEntry, next)),
                      Effect.sync(() => Ref.getUnsafe(catalogEntry)?.token === entry.token),
                    );
                    yield* Deferred.done(entry.completion, exit);
                  }),
                ),
              ),
            ),
          ),
      });
    }),
  );
  const selected = Effect.map(options.config.read, (settings): ModelSelection | null =>
    settings.provider === provider && isTruthy(settings.model) && isTruthy(settings.reasoningEffort)
      ? {
          provider,
          model: settings.model,
          reasoningEffort: settings.reasoningEffort,
        }
      : null,
  );

  return {
    provider,
    contextWindow: (model) =>
      catalogCache?.key === (options.catalogKey?.() ?? "__default__")
        ? (catalogCache.models.find((candidate) => candidate.id === model)?.contextWindow ?? null)
        : null,
    auth: { provider, status, connect, cancel, disconnect },
    models: {
      provider,
      list,
      selected,
      acceptsImages: (model) =>
        Effect.map(list, (models) =>
          models.some(
            (candidate) =>
              candidate.id === model && candidate.capabilities.inputModalities.includes("image"),
          ),
        ),
      cheapestEffort: (selection) =>
        Effect.succeed({
          ...selection,
          reasoningEffort: selection.reasoningEffort === "none" ? "none" : "low",
        }),
      select: (model, reasoningEffort) =>
        Effect.gen(function* () {
          const models = yield* list;
          const found = yield* Effect.fromOption(
            Arr.findFirst(models, (candidate) => candidate.id === model),
            () => ModelUnavailable.make({ provider, model }),
          );
          const effort = yield* Effect.succeed(
            reasoningEffort ?? found.defaultReasoningEffort,
          ).pipe(
            Effect.filterOrFail(
              (requested) => found.supportedReasoningEfforts.includes(requested),
              (requested) => ModelUnavailable.make({ provider, model, reasoningEffort: requested }),
            ),
          );
          yield* options.config
            .update({
              provider,
              model,
              reasoningEffort: effort,
            })
            .pipe(Effect.mapError(() => operationFailure(provider, "model")));
          return { provider, model, reasoningEffort: effort };
        }),
    },
  };
}
