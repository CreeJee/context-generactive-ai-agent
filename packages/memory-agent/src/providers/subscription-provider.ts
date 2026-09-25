import { ANTHROPIC_MODELS } from "@tanstack/ai-anthropic";
import { Effect, Option, Schema } from "effect";
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
  type AuthConnectionState,
  type ModelSelection,
  type ProviderConfiguration,
  type ProviderId,
  type ProviderModel,
} from "./contracts.ts";

interface ProductOAuthClient {
  status(): Promise<OAuthConnectionStatus>;
  startLogin(): Promise<LoginAttempt>;
  disconnect(): Promise<OAuthConnectionStatus>;
  modelCatalog(): Promise<ReadonlyArray<unknown>>;
}

interface SettingsStore {
  readonly read: Effect.Effect<Settings>;
  readonly update: (patch: Partial<Settings>) => Effect.Effect<Settings>;
}

export interface SubscriptionProviderOptions {
  readonly protocol: ProviderProtocol;
  readonly config: SettingsStore;
  readonly client?: ProductOAuthClient;
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

const canonicalEffort = (value: string | undefined) => {
  if (value === undefined) return null;
  const effort = value.trim().toLowerCase();
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)
    ? effort
    : null;
};

const effortValues = (model: CatalogModel) => {
  const raw = model.supported_reasoning_levels ?? model.supported_reasoning_efforts ?? [];
  const efforts: string[] = [];
  for (const item of raw) {
    const effort = canonicalEffort(
      Schema.is(Schema.String)(item) ? item : (item.reasoning_effort ?? item.effort ?? item.value),
    );
    if (effort !== null && !efforts.includes(effort)) efforts.push(effort);
  }
  return efforts;
};

const pageModels = (page: typeof CatalogPage.Type): ReadonlyArray<CatalogModel> => {
  if (Schema.is(CatalogModels)(page)) return page;
  if ("models" in page) return page.models;
  return Schema.is(CatalogModels)(page.data) ? page.data : page.data.models;
};

const catalogEntries = (provider: ProviderId, pages: ReadonlyArray<unknown>) =>
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

  if (
    (family === "opus" && atLeast(4, 7)) ||
    (family === "sonnet" && atLeast(5, 0)) ||
    (family !== "opus" && family !== "sonnet" && atLeast(5, 0))
  )
    return ["low", "medium", "high", "xhigh", "max"];
  if (
    normalized.includes("mythos") ||
    (family === "opus" && version[0] === 4 && version[1] === 6) ||
    (family === "sonnet" && version[0] === 4 && version[1] === 6)
  )
    return ["low", "medium", "high", "max"];
  if (family === "opus" && version[0] === 4 && version[1] === 5) return ["low", "medium", "high"];
  if (family === "sonnet" && version[0] === 3 && version[1] === 7) return ["low", "medium", "high"];
  return ["none"];
};

export function parseSubscriptionCatalog(
  provider: ProviderId,
  pages: ReadonlyArray<unknown>,
): ReadonlyArray<ProviderModel> {
  const entries = catalogEntries(provider, pages);
  const preferred = provider === "openai" ? "gpt-6-astra" : "claude-opus-5";
  const seen = new Set<string>();
  return entries.flatMap(({ entry, id }, index) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const advertised = provider === "openai" ? effortValues(entry) : anthropicEfforts(id);
    const efforts = advertised.length > 0 ? advertised : ["none"];
    const requestedDefault = canonicalEffort(
      entry.default_reasoning_level ?? entry.default_reasoning_effort,
    );
    const defaultReasoningEffort =
      requestedDefault !== null && efforts.includes(requestedDefault)
        ? requestedDefault
        : efforts.includes("medium")
          ? "medium"
          : efforts[0]!;
    const image =
      entry.input_modalities?.some((modality) => modality === "image" || modality === "vision") ??
      false;
    const contextWindow = Option.getOrNull(
      Option.filter(
        Schema.decodeUnknownOption(Schema.Int)(entry.context_window),
        (limit) => Number.isSafeInteger(limit) && limit > 0,
      ),
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
    return [contextWindow === null ? model : { ...model, contextWindow }];
  });
}

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

const operationFailure = (provider: ProviderId, operation: "auth" | "catalog" | "model") =>
  new ProviderOperationFailed({ provider, operation });

const fromPromise = <A>(
  provider: ProviderId,
  operation: "auth" | "catalog" | "model",
  run: () => Promise<A>,
) =>
  Effect.tryPromise({
    try: run,
    catch: () => operationFailure(provider, operation),
  });

export function createSubscriptionProvider(
  options: SubscriptionProviderOptions,
): ProviderConfiguration & { readonly contextWindow: (model: string) => number | null } {
  const provider = options.protocol.provider;
  const client = options.client ?? createSubscriptionOAuthClient({ protocol: options.protocol });
  let pending: LoginAttempt | null = null;
  let loginError: Extract<AuthConnectionState, { status: "error" }> | null = null;
  const failureState = (
    error: OAuthHarnessError | null,
  ): Extract<AuthConnectionState, { status: "error" }> => {
    if (error === null) return { provider, status: "error", message: "Login did not complete." };
    const message = {
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
    return {
      provider,
      status: "error",
      message: message[error.code] ?? "Login did not complete.",
      code: error.code,
      ...optionalProperty("operation", error.operation ?? undefined),
      ...optionalProperty("httpStatus", error.status ?? undefined),
      ...optionalProperty("providerCode", error.providerCode ?? undefined),
      ...optionalProperty("credentialStage", error.credentialStage ?? undefined),
      ...optionalProperty("transportCode", error.transportCode ?? undefined),
      ...optionalProperty("proxyRoute", error.proxyRoute ?? undefined),
    };
  };
  let catalogCache: {
    readonly loadedAt: number;
    readonly models: ReadonlyArray<ProviderModel>;
  } | null = null;

  const authState = async (): Promise<AuthConnectionState> => {
    if (pending) return { provider, status: "pending", authorizationUrl: pending.authorizationUrl };
    if (loginError) return loginError;
    try {
      const connection = await client.status();
      if (connection.connected) return { provider, status: "signed-in" };
    } catch (error) {
      if (error instanceof OAuthHarnessError && error.code === "credential_store_unavailable")
        return failureState(error);
      throw error;
    }
    return { provider, status: "signed-out" };
  };

  const status = fromPromise(provider, "auth", authState);
  const connect = fromPromise(provider, "auth", async () => {
    const current = await authState();
    if (current.status === "signed-in" || current.status === "pending") return current;
    loginError = null;
    let attempt: LoginAttempt;
    try {
      attempt = await client.startLogin();
    } catch (error) {
      loginError = failureState(error instanceof OAuthHarnessError ? error : null);
      return loginError;
    }
    pending = attempt;
    void attempt.completed.then(
      () => {
        if (pending === attempt) pending = null;
      },
      (error) => {
        if (pending !== attempt) return;
        pending = null;
        loginError = failureState(error instanceof OAuthHarnessError ? error : null);
      },
    );
    return {
      provider,
      status: "pending",
      authorizationUrl: attempt.authorizationUrl,
    } satisfies AuthConnectionState;
  });
  const cancel = fromPromise(provider, "auth", async () => {
    const attempt = pending;
    pending = null;
    loginError = null;
    attempt?.cancel();
    return authState();
  });
  const disconnect = fromPromise(provider, "auth", async () => {
    const attempt = pending;
    pending = null;
    loginError = null;
    attempt?.cancel();
    await client.disconnect();
    catalogCache = null;
    return { provider, status: "signed-out" } satisfies AuthConnectionState;
  });

  const load = async () => {
    if (catalogCache && Date.now() - catalogCache.loadedAt < 30_000) return catalogCache.models;
    const pages =
      provider === "anthropic" ? anthropicInstalledCatalog : await client.modelCatalog();
    const models = parseSubscriptionCatalog(provider, pages);
    if (models.length === 0) throw new Error("empty_model_catalog");
    catalogCache = { loadedAt: Date.now(), models };
    return models;
  };

  const list = fromPromise(provider, "catalog", load);
  const selected = Effect.map(options.config.read, (settings): ModelSelection | null =>
    settings.provider === provider && settings.model && settings.reasoningEffort
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
      catalogCache?.models.find((candidate) => candidate.id === model)?.contextWindow ?? null,
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
          const found = models.find((candidate) => candidate.id === model);
          if (!found) return yield* new ModelUnavailable({ provider, model });
          const effort = reasoningEffort ?? found.defaultReasoningEffort;
          if (!found.supportedReasoningEfforts.includes(effort))
            return yield* new ModelUnavailable({
              provider,
              model,
              reasoningEffort: effort,
            });
          yield* options.config.update({
            provider,
            model,
            reasoningEffort: effort,
          });
          return { provider, model, reasoningEffort: effort };
        }),
    },
  };
}
