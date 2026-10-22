import { runUiEffect, uiPromise } from "../../shared/ui-effect";
import { Effect } from "effect";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type AccountAction,
  type ModelSelection,
  type ProviderId,
  type SubscriptionAccountProvider,
} from "../../api";
import {
  compatibleClient,
  type CompatibleAccountChange,
  type CompatibleAccountsView,
} from "../../navigation/compatible-client";
import { globalQueries } from "../global";
import { appQueryKeys } from "../keys";

/** A successful write owns selection; an older catalog response must not switch it back. */
const publishModelSelection = (client: QueryClient, selection: ModelSelection) =>
  client.cancelQueries({ queryKey: appQueryKeys.global.modelsRoot }).then(() => {
    for (const provider of ["openai", "anthropic", "openai-compatible"] as const) {
      client.setQueryData(globalQueries.models(provider).queryKey, (snapshot) =>
        snapshot === undefined
          ? snapshot
          : { ...snapshot, selected: provider === selection.provider ? selection : null },
      );
    }
  });

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

export function useConversationSettingsMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.setConversationSettings,
    onSuccess: (settings) => client.setQueryData(globalQueries.conversation().queryKey, settings),
  });
}

export function useKanbanSettingsMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.setKanbanConcurrency,
    onSuccess: (settings) => client.setQueryData(globalQueries.kanban().queryKey, settings),
  });
}

/** Moves a project in the scheduler's order of projects. */
export function useProjectOrderMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      before,
    }: {
      readonly projectId: string;
      readonly before: string | null;
    }) => api.moveProject(projectId, before),
    onSuccess: (settings) => client.setQueryData(globalQueries.kanban().queryKey, settings),
  });
}

export function useRecallSettingsMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.setRecallSettings,
    onSuccess: (settings) => client.setQueryData(globalQueries.recall().queryKey, settings),
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

/** A switched or removed account changes the provider's auth, models and quota rows. */
export function useAccountActionMutation(provider: SubscriptionAccountProvider) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: AccountAction) => api.accountAction(provider, action),
    onSuccess: (view) => {
      client.setQueryData(globalQueries.accounts(provider).queryKey, view);
      // React Query owns these refreshes and reports their errors on the corresponding queries.
      for (const queryKey of [
        globalQueries.accountQuota(provider).queryKey,
        globalQueries.auth(provider).queryKey,
        appQueryKeys.global.models(provider),
      ])
        void client.invalidateQueries({ queryKey });
    },
  });
}

/** A changed endpoint list can change compatible auth, the catalog and the model choice. */
const publishCompatibleAccounts = (client: QueryClient, view: CompatibleAccountsView) => {
  client.setQueryData(globalQueries.compatibleAccounts().queryKey, view);
  // React Query owns these refreshes and reports their errors on the corresponding queries.
  for (const queryKey of [
    globalQueries.auth("openai-compatible").queryKey,
    appQueryKeys.global.models("openai-compatible"),
  ])
    void client.invalidateQueries({ queryKey });
};

/** Adds, edits and removes compatible endpoints and their registered models. */
export function useCompatibleAccountMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (change: CompatibleAccountChange) => compatibleClient.change(change),
    onSuccess: (view) => publishCompatibleAccounts(client, view),
  });
}

/** An account the sidebar switcher can move to. */
export type AccountTarget =
  | { readonly provider: SubscriptionAccountProvider; readonly accountId: string }
  | { readonly provider: "openai-compatible"; readonly accountId: string };

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
              // Usage and auth refresh independently of selecting the account and its model.
              void client.invalidateQueries({
                queryKey: globalQueries.accountQuota(provider).queryKey,
              });
              void client.invalidateQueries({ queryKey: globalQueries.auth(provider).queryKey });
              // A catalog already in flight may belong to the previously selected account.
              yield* uiPromise(() =>
                client.cancelQueries({ queryKey: globalQueries.models(provider).queryKey }),
              );
              break;
            }
            case "openai-compatible": {
              const view = yield* uiPromise(() =>
                compatibleClient.change({ intent: "select", accountId: target.accountId }),
              );
              publishCompatibleAccounts(client, view);
              // A catalog already in flight may belong to the previously selected endpoint.
              yield* uiPromise(() =>
                client.cancelQueries({
                  queryKey: globalQueries.models("openai-compatible").queryKey,
                }),
              );
              break;
            }
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
    onSuccess: (selection) =>
      selection === null ? undefined : publishModelSelection(client, selection),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: appQueryKeys.global.modelsRoot });
    },
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
    onSuccess: (selection) => publishModelSelection(client, selection),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: appQueryKeys.global.modelsRoot });
    },
  });
}
