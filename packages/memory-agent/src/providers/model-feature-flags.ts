import { Function as EffectFunction } from "effect";
import { Context, Data, Effect, HashSet, Layer, Schema } from "effect";
import {
  GlobalConfig,
  GlobalConfigFailed,
  type GlobalConfigApi,
  type ModelFeatureFlagSettings,
} from "../config/global-config.ts";
import type { ProviderId } from "./contracts.ts";

export type ModelFeatureFlagScope = Data.TaggedEnum<{
  global: {};
  provider: { readonly provider: ProviderId };
  capability: { readonly capability: string };
  model: {
    readonly provider: ProviderId;
    readonly model: string;
    readonly capability: string;
  };
  route: { readonly route: string };
}>;
export const ModelFeatureFlagScope = Data.taggedEnum<ModelFeatureFlagScope>();
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
const UnknownCapability = Schema.TaggedStruct("UnknownCapability", {});
export class UnknownModelFeatureCapability extends Schema.TaggedError<UnknownModelFeatureCapability>()(
  "UnknownModelFeatureCapability",
  {
    capability: Schema.String,
    reason: UnknownCapability,
  },
) {}
const SettingsFailed = Schema.TaggedStruct("SettingsFailed", {});
export class ModelFeatureFlagStoreFailed extends Schema.TaggedError<ModelFeatureFlagStoreFailed>()(
  "ModelFeatureFlagStoreFailed",
  {
    operation: Schema.Literals(["read", "write"]),
    reason: SettingsFailed,
    cause: GlobalConfigFailed,
  },
) {}

const emptySettings = (): ModelFeatureFlagSettings => ({
  version: 1,
  global: false,
  providers: {},
  capabilities: {},
  models: {},
  routes: {},
});
const modelKey = (provider: ProviderId, model: string) => `${provider}:${model}`;

export const decideModelFeatureFlag: {
  (
    query: ModelFeatureFlagQuery,
    known: HashSet.HashSet<string>,
  ): (
    settings: ModelFeatureFlagSettings | undefined,
  ) => ReturnType<typeof decideModelFeatureFlagBody>;
} & typeof decideModelFeatureFlagBody = EffectFunction.dual(3, decideModelFeatureFlagBody);
function decideModelFeatureFlagBody(
  settings: ModelFeatureFlagSettings | undefined,
  query: ModelFeatureFlagQuery,
  known: HashSet.HashSet<string>,
): ModelFeatureFlagDecision {
  const reasons: string[] = [];
  if (!HashSet.has(known, query.capability)) reasons.push("unknown_capability");
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

const storeFailure = (operation: "read" | "write") => (cause: GlobalConfigFailed) =>
  ModelFeatureFlagStoreFailed.make({ operation, reason: SettingsFailed.make({}), cause });
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
export const makeModelFeatureFlags: {
  (
    capabilities: Iterable<string>,
  ): (config: GlobalConfigApi) => ReturnType<typeof makeModelFeatureFlagsBody>;
} & typeof makeModelFeatureFlagsBody = EffectFunction.dual(2, makeModelFeatureFlagsBody);
function makeModelFeatureFlagsBody(
  config: GlobalConfigApi,
  capabilities: Iterable<string>,
): ModelFeatureFlagsApi {
  const known = HashSet.fromIterable(capabilities);
  const read = config.read.pipe(
    Effect.map((settings) => settings.modelFeatureFlags ?? emptySettings()),
    Effect.mapError(storeFailure("read")),
  );
  return {
    read,
    decide: (query) =>
      HashSet.has(known, query.capability)
        ? Effect.map(read, (settings) => decideModelFeatureFlag(settings, query, known))
        : Effect.fail(
            UnknownModelFeatureCapability.make({
              capability: query.capability,
              reason: UnknownCapability.make({}),
            }),
          ),
    set: (scope, enabled) =>
      Effect.flatMap(read, (current) => {
        const next = ModelFeatureFlagScope.$match(scope, {
          global: (): ModelFeatureFlagSettings => ({ ...current, global: enabled }),
          provider: (scope): ModelFeatureFlagSettings => ({
            ...current,
            providers: { ...current.providers, [scope.provider]: enabled },
          }),
          capability: (scope): ModelFeatureFlagSettings => ({
            ...current,
            capabilities: { ...current.capabilities, [scope.capability]: enabled },
          }),
          model: (scope): ModelFeatureFlagSettings => {
            const key = modelKey(scope.provider, scope.model);
            return {
              ...current,
              models: {
                ...current.models,
                [key]: { ...current.models[key], [scope.capability]: enabled },
              },
            };
          },
          route: (scope): ModelFeatureFlagSettings => ({
            ...current,
            routes: { ...current.routes, [scope.route]: enabled },
          }),
        });
        return config
          .update({ modelFeatureFlags: next })
          .pipe(Effect.as(next), Effect.mapError(storeFailure("write")));
      }),
  };
}
export class ModelFeatureFlags extends Context.Service<ModelFeatureFlags, ModelFeatureFlagsApi>()(
  "memory-agent/providers/model-feature-flags/ModelFeatureFlags",
) {
  static readonly layer = (capabilities: Iterable<string>) =>
    Layer.effect(
      ModelFeatureFlags,
      Effect.map(GlobalConfig, (config) => makeModelFeatureFlags(config, capabilities)),
    );
  static readonly layerFrom = (api: ModelFeatureFlagsApi) => Layer.succeed(ModelFeatureFlags, api);
}
