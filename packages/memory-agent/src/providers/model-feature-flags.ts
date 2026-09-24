import { Cause, Context, Data, Effect, Layer } from "effect";
import {
  GlobalConfig,
  type GlobalConfigApi,
  type ModelFeatureFlagSettings,
} from "../config/global-config.ts";
import type { ProviderId } from "./contracts.ts";

export type ModelFeatureFlagScope =
  | { readonly type: "global" }
  | { readonly type: "provider"; readonly provider: ProviderId }
  | { readonly type: "capability"; readonly capability: string }
  | {
      readonly type: "model";
      readonly provider: ProviderId;
      readonly model: string;
      readonly capability: string;
    }
  | { readonly type: "route"; readonly route: string };
export interface ModelFeatureFlagQuery {
  readonly provider: ProviderId;
  readonly capability: string;
  readonly model?: string;
  readonly route?: string;
}
export interface ModelFeatureFlagDecision {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
  readonly settingsVersion: 1 | null;
}
export class UnknownModelFeatureCapability extends Data.TaggedError(
  "UnknownModelFeatureCapability",
)<{ readonly capability: string }> {}
export class ModelFeatureFlagStoreFailed extends Data.TaggedError("ModelFeatureFlagStoreFailed")<{
  readonly operation: "read" | "write";
  readonly cause: unknown;
}> {}

const emptySettings = (): ModelFeatureFlagSettings => ({
  version: 1,
  global: false,
  providers: {},
  capabilities: {},
  models: {},
  routes: {},
});
const modelKey = (provider: ProviderId, model: string) => `${provider}:${model}`;

export function decideModelFeatureFlag(
  settings: ModelFeatureFlagSettings | undefined,
  query: ModelFeatureFlagQuery,
  known: ReadonlySet<string>,
): ModelFeatureFlagDecision {
  const reasons: string[] = [];
  if (!known.has(query.capability)) reasons.push("unknown_capability");
  if (settings === undefined) reasons.push("settings_missing");
  else {
    if (!settings.global) reasons.push("global_disabled");
    if (settings.providers[query.provider] !== true) reasons.push("provider_disabled");
    if (settings.capabilities[query.capability] !== true) reasons.push("capability_disabled");
    if (
      query.model !== undefined &&
      settings.models[modelKey(query.provider, query.model)]?.[query.capability] === false
    )
      reasons.push("model_disabled");
    if (query.route !== undefined && settings.routes[query.route] === false)
      reasons.push("route_disabled");
  }
  return Object.freeze({
    allowed: reasons.length === 0,
    reasons: Object.freeze(reasons),
    settingsVersion: settings?.version ?? null,
  });
}

const storeFailure = (operation: "read" | "write") => (cause: Cause.Cause<never>) =>
  new ModelFeatureFlagStoreFailed({ operation, cause: Cause.squash(cause) });
export interface ModelFeatureFlagsApi {
  readonly read: Effect.Effect<ModelFeatureFlagSettings, ModelFeatureFlagStoreFailed>;
  readonly decide: (
    query: ModelFeatureFlagQuery,
  ) => Effect.Effect<
    ModelFeatureFlagDecision,
    UnknownModelFeatureCapability | ModelFeatureFlagStoreFailed
  >;
  readonly set: (
    scope: ModelFeatureFlagScope,
    enabled: boolean,
  ) => Effect.Effect<ModelFeatureFlagSettings, ModelFeatureFlagStoreFailed>;
}
export function makeModelFeatureFlags(
  config: GlobalConfigApi,
  capabilities: Iterable<string>,
): ModelFeatureFlagsApi {
  const known = new Set(capabilities);
  const read = config.read.pipe(
    Effect.map((settings) => settings.modelFeatureFlags ?? emptySettings()),
    Effect.catchCause((cause) => Effect.fail(storeFailure("read")(cause))),
  );
  return {
    read,
    decide: (query) =>
      known.has(query.capability)
        ? Effect.map(read, (settings) => decideModelFeatureFlag(settings, query, known))
        : Effect.fail(new UnknownModelFeatureCapability({ capability: query.capability })),
    set: (scope, enabled) =>
      Effect.flatMap(read, (current) => {
        const next: ModelFeatureFlagSettings = (() => {
          switch (scope.type) {
            case "global":
              return { ...current, global: enabled };
            case "provider":
              return { ...current, providers: { ...current.providers, [scope.provider]: enabled } };
            case "capability":
              return {
                ...current,
                capabilities: { ...current.capabilities, [scope.capability]: enabled },
              };
            case "model": {
              const key = modelKey(scope.provider, scope.model);
              return {
                ...current,
                models: {
                  ...current.models,
                  [key]: { ...current.models[key], [scope.capability]: enabled },
                },
              };
            }
            case "route":
              return { ...current, routes: { ...current.routes, [scope.route]: enabled } };
          }
        })();
        return config.update({ modelFeatureFlags: next }).pipe(
          Effect.as(next),
          Effect.catchCause((cause) => Effect.fail(storeFailure("write")(cause))),
        );
      }),
  };
}
export class ModelFeatureFlags extends Context.Service<ModelFeatureFlags, ModelFeatureFlagsApi>()(
  "memory-agent/ModelFeatureFlags",
) {
  static readonly layer = (capabilities: Iterable<string>) =>
    Layer.effect(
      ModelFeatureFlags,
      Effect.map(GlobalConfig, (config) => makeModelFeatureFlags(config, capabilities)),
    );
  static readonly layerFrom = (api: ModelFeatureFlagsApi) => Layer.succeed(ModelFeatureFlags, api);
}
