import { Cause, Context, Data, Effect, Layer } from "effect";
import {
  GlobalConfig,
  type CrossProviderMediaConsentMode,
  type CrossProviderMediaConsentSettings,
  type GlobalConfigApi,
} from "../config/global-config.ts";
import type { ProviderId } from "./contracts.ts";

export interface CrossProviderMediaConsentPair {
  readonly initiatorProvider: ProviderId;
  readonly executorProvider: ProviderId;
  readonly capability: string;
}

export interface CrossProviderMediaConsentDecision extends CrossProviderMediaConsentPair {
  readonly crossProvider: boolean;
  readonly mode: CrossProviderMediaConsentMode;
  readonly allowedWithoutPrompt: boolean;
  readonly requiresApproval: boolean;
  readonly reasons: readonly string[];
  readonly settingsVersion: 1 | null;
}

export class CrossProviderMediaConsentStoreFailed extends Data.TaggedError(
  "CrossProviderMediaConsentStoreFailed",
)<{ readonly operation: "read" | "write"; readonly cause: unknown }> {}

const emptySettings = (): CrossProviderMediaConsentSettings => ({ version: 1, pairs: {} });
export const crossProviderMediaConsentKey = (pair: CrossProviderMediaConsentPair) =>
  `${pair.initiatorProvider}->${pair.executorProvider}:${pair.capability}`;

export function decideCrossProviderMediaConsent(
  settings: CrossProviderMediaConsentSettings | undefined,
  pair: CrossProviderMediaConsentPair,
): CrossProviderMediaConsentDecision {
  if (pair.initiatorProvider === pair.executorProvider)
    return Object.freeze({
      ...pair,
      crossProvider: false,
      mode: "always" as const,
      allowedWithoutPrompt: true,
      requiresApproval: false,
      reasons: Object.freeze(["same_provider"]),
      settingsVersion: settings?.version ?? null,
    });
  const mode = settings?.pairs[crossProviderMediaConsentKey(pair)] ?? "disabled";
  return Object.freeze({
    ...pair,
    crossProvider: true,
    mode,
    allowedWithoutPrompt: mode === "always",
    requiresApproval: mode === "ask",
    reasons: Object.freeze(
      settings === undefined
        ? ["settings_missing"]
        : mode === "disabled"
          ? ["consent_disabled"]
          : mode === "ask"
            ? ["approval_required"]
            : [],
    ),
    settingsVersion: settings?.version ?? null,
  });
}

const storeFailure = (operation: "read" | "write") => (cause: Cause.Cause<never>) =>
  new CrossProviderMediaConsentStoreFailed({ operation, cause: Cause.squash(cause) });

export interface CrossProviderMediaConsentApi {
  readonly read: Effect.Effect<
    CrossProviderMediaConsentSettings,
    CrossProviderMediaConsentStoreFailed
  >;
  readonly decide: (
    pair: CrossProviderMediaConsentPair,
  ) => Effect.Effect<CrossProviderMediaConsentDecision, CrossProviderMediaConsentStoreFailed>;
  readonly set: (
    pair: CrossProviderMediaConsentPair,
    mode: CrossProviderMediaConsentMode,
  ) => Effect.Effect<CrossProviderMediaConsentSettings, CrossProviderMediaConsentStoreFailed>;
}

export function makeCrossProviderMediaConsent(
  config: GlobalConfigApi,
): CrossProviderMediaConsentApi {
  const read = config.read.pipe(
    Effect.map((settings) => settings.crossProviderMediaConsent ?? emptySettings()),
    Effect.catchCause((cause) => Effect.fail(storeFailure("read")(cause))),
  );
  return {
    read,
    decide: (pair) =>
      config.read.pipe(
        Effect.map((settings) =>
          decideCrossProviderMediaConsent(settings.crossProviderMediaConsent, pair),
        ),
        Effect.catchCause((cause) => Effect.fail(storeFailure("read")(cause))),
      ),
    set: (pair, mode) =>
      Effect.flatMap(read, (current) => {
        const next: CrossProviderMediaConsentSettings = {
          ...current,
          pairs: { ...current.pairs, [crossProviderMediaConsentKey(pair)]: mode },
        };
        return config.update({ crossProviderMediaConsent: next }).pipe(
          Effect.as(next),
          Effect.catchCause((cause) => Effect.fail(storeFailure("write")(cause))),
        );
      }),
  };
}

export class CrossProviderMediaConsent extends Context.Service<
  CrossProviderMediaConsent,
  CrossProviderMediaConsentApi
>()("memory-agent/CrossProviderMediaConsent") {
  static readonly layer = Layer.effect(
    CrossProviderMediaConsent,
    Effect.map(GlobalConfig, makeCrossProviderMediaConsent),
  );
  static readonly layerFrom = (api: CrossProviderMediaConsentApi) =>
    Layer.succeed(CrossProviderMediaConsent, api);
}
