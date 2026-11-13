import { msg } from "@lingui/core/runtime-macro";
import { isTruthy } from "../truthy.ts";
import { i18n } from "../i18n.ts";
import { Array as Arr, Context, Effect, Layer, Predicate } from "effect";
import { GlobalConfig, type Settings } from "../config/global-config.ts";
import {
  type AgentRole,
  AuthConnectionState,
  type ModelRole,
  ModelUnavailable,
  type ModelSelection,
  type ProviderId,
  type ProviderServices,
} from "./contracts.ts";
import { ProviderRegistry } from "./registry.ts";

/** Where each role's own model is kept in the global settings. */
const roleModelKeys = {
  planner: "plannerModel",
  executor: "executorModel",
  verifier: "verifierModel",
  skillRouter: "skillRouterModel",
} as const satisfies Record<ModelRole, keyof Settings>;

export interface ResolvedProvider {
  readonly selection: ModelSelection;
  readonly services: ProviderServices;
}

/** An unreachable provider, shown as its login state. */
const authUnavailable = msg`공급자 로그인 상태를 확인하지 못했습니다.`;

const make = Effect.gen(function* () {
  const config = yield* GlobalConfig;
  const registry = yield* ProviderRegistry;

  const provider = Effect.map(config.read, (settings): ProviderId => settings.provider ?? "openai");
  const selected = Effect.flatMap(config.read, (settings) =>
    isTruthy(settings.provider)
      ? Effect.flatMap(registry.get(settings.provider), ({ models }) => models.selected)
      : Effect.succeed(null),
  );

  /** A role's own model, or null when the user chose none. */
  const chosenFor = (role: ModelRole) =>
    Effect.map(config.read, (settings) => settings[roleModelKeys[role]] ?? null);
  /** The model a role runs on: its own when the user chose one, else the selected model. */
  const selectedFor = (role: AgentRole) =>
    Effect.filterOrElse(chosenFor(role), Predicate.isNotNull, () => selected);
  /**
   * Saves a role's model after checking the provider lists it with that effort. null clears it: a
   * Goal's role goes back to the selected model and the skill router is off. The global selection
   * is not touched.
   */
  const chooseFor = Effect.fn("ActiveProvider.chooseFor")(function* (
    role: ModelRole,
    selection: ModelSelection | null,
  ) {
    if (selection !== null) {
      const { models } = yield* registry.get(selection.provider);
      yield* Effect.fromOption(
        Arr.findFirst(
          yield* models.list,
          (model) =>
            model.id === selection.model &&
            model.supportedReasoningEfforts.includes(selection.reasoningEffort),
        ),
        () => ModelUnavailable.make(selection),
      );
    }
    yield* config.update({ [roleModelKeys[role]]: selection ?? undefined });
    return selection;
  });

  const resolve = (selection: ModelSelection) =>
    Effect.gen(function* () {
      const configuration = yield* registry.get(selection.provider);
      const runtime = yield* registry.runtime(selection.provider);
      return {
        selection,
        services: { ...configuration, runtime },
      } satisfies ResolvedProvider;
    });

  const authFor = (provider: ProviderId) =>
    Effect.flatMap(registry.get(provider), ({ auth }) => auth.status).pipe(
      // An unreachable provider is reported as its auth state; chat callers branch on the status.
      Effect.catchTag(["ProviderUnavailable", "ProviderOperationFailed"], () =>
        Effect.succeed(
          AuthConnectionState.error({
            provider,
            message: i18n._(authUnavailable),
          }),
        ),
      ),
    );

  return {
    provider,
    selected,
    chosenFor,
    selectedFor,
    chooseFor,
    resolve,
    models: (selection: ModelSelection) =>
      Effect.map(resolve(selection), ({ services }) => services.models),
    runtime: (selection: ModelSelection) =>
      Effect.map(resolve(selection), ({ services }) => services.runtime),
    authFor,
    auth: (selection: ModelSelection) => authFor(selection.provider),
  };
});

/** Resolves the saved provider/model pair without silently falling back to another provider. */
export class ActiveProvider extends Context.Service<ActiveProvider, Effect.Success<typeof make>>()(
  "memory-agent/providers/active-provider/ActiveProvider",
) {
  static readonly layer = Layer.effect(ActiveProvider, make);
}
