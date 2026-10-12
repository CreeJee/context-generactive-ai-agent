import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { Effect } from "effect";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type AccountAction,
  type ProviderId,
  type SubscriptionAccountProvider,
} from "../../api";
import { globalQueries } from "../global";
import { appQueryKeys } from "../keys";

/** Each setting response is the complete new server snapshot for its query. */
export function useImageGenerationEnabledMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.setImageGenerationEnabled,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.imageSettings().queryKey }),
  });
}

export function useCrossProviderConsentMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.setCrossProviderMediaConsent,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.imageSettings().queryKey }),
  });
}

export function useKagiMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.kagiAction,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.kagi().queryKey }),
  });
}

export function useImportMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.importAction,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.imports().queryKey }),
  });
}

export function useEmbeddingMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.embeddingAction,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.embedding().queryKey }),
  });
}

export function useAuthActionMutation(provider: ProviderId) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (intent: "login" | "cancel" | "logout") => api.authAction(intent, provider),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    onSuccess: () =>
      runUiEffect(
        Effect.all(
          [
            uiPromise(() =>
              client.invalidateQueries({ queryKey: globalQueries.auth(provider).queryKey }),
            ),
            uiPromise(() =>
              client.invalidateQueries({ queryKey: appQueryKeys.global.models(provider) }),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.asVoid),
      ),
  });
}

/** A switched or removed account changes the provider's auth, models and quota rows. */
export function useAccountActionMutation(provider: SubscriptionAccountProvider) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: AccountAction) => api.accountAction(provider, action),
    onSuccess: (view) => {
      client.setQueryData(globalQueries.accounts(provider).queryKey, view);
      return runUiEffect(
        Effect.forEach(
          [
            globalQueries.accountQuota(provider).queryKey,
            globalQueries.auth(provider).queryKey,
            appQueryKeys.global.models(provider),
          ],
          (queryKey) => uiPromise(() => client.invalidateQueries({ queryKey })),
          { concurrency: "unbounded", discard: true },
        ),
      );
    },
  });
}

/** An account the sidebar switcher can move to; the compatible provider has a single configuration. */
export type AccountTarget =
  | { readonly provider: SubscriptionAccountProvider; readonly accountId: string }
  | { readonly provider: "openai-compatible" };

/**
 * Makes `target` the account in use. Moving to another provider also selects that provider's
 * default model, since a single model selection decides which account a chat runs on.
 */
export function useSwitchAccountMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ target, selectModel }: { target: AccountTarget; selectModel: boolean }) =>
      runUiEffect(
        Effect.gen(function* () {
          switch (target.provider) {
            case "openai":
            case "anthropic": {
              const { provider, accountId } = target;
              const view = yield* uiPromise(() =>
                api.accountAction(provider, { intent: "select", accountId }),
              );
              client.setQueryData(globalQueries.accounts(provider).queryKey, view);
              yield* Effect.forEach(
                [
                  globalQueries.accountQuota(provider).queryKey,
                  globalQueries.auth(provider).queryKey,
                ],
                (queryKey) => uiPromise(() => client.invalidateQueries({ queryKey })),
                { concurrency: "unbounded", discard: true },
              );
              break;
            }
            case "openai-compatible":
              break;
          }
          if (!selectModel) return null;
          const { models } = yield* uiPromise(() =>
            client.fetchQuery({ ...globalQueries.models(target.provider), staleTime: 0 }),
          );
          const model = models.find((item) => item.isDefault) ?? models[0];
          if (model === undefined) return null;
          return yield* uiPromise(() => api.selectModel(model.id, undefined, target.provider));
        }),
      ),
    onSettled: () => client.invalidateQueries({ queryKey: appQueryKeys.global.modelsRoot }),
  });
}

export function useAddProjectMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.addProject,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.projects().queryKey }),
  });
}

export function useSelectModelMutation(provider: ProviderId) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ model, effort }: { model: string; effort?: string }) =>
      api.selectModel(model, effort, provider),
    onSuccess: () => client.invalidateQueries({ queryKey: appQueryKeys.global.modelsRoot }),
  });
}
